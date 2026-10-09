import assert from 'node:assert/strict';
import test from 'node:test';

const nativeSetInterval = globalThis.setInterval;
const storageValues = new Map();
globalThis.localStorage = {
  getItem: key => storageValues.get(key) ?? null,
  setItem: (key, value) => storageValues.set(key, String(value)),
};
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
globalThis.document = {
  addEventListener() {},
  createElement() { return { textContent: '', get innerHTML() { return this.textContent; } }; },
};
globalThis.location = { protocol: 'https:', host: 'test.invalid' };
globalThis.setInterval = () => 0; // Importing state must not leave the application idle timer running in Node.
const { StateManager } = await import('../src/shared/StateManager.js');
const { createApiClient } = await import('../src/core/ApiClient.js');
const { WsClient } = await import('../src/core/WsClient.js');
const { SearchPanel } = await import('../src/player/SearchPanel.js');
const { ConnectionBar } = await import('../src/shared/ConnectionBar.js');
const { eventBus } = await import('../src/shared/EventBus.js');
const { bootstrapPlayback } = await import('../src/core/PlaybackBootstrap.js');
globalThis.setInterval = nativeSetInterval;

function makeState() {
  const old = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try { return new StateManager(); } finally { globalThis.setInterval = old; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = data => ({ status: 200, ok: true, json: async () => data });
const noBus = { emit() {} };

test('HTTP deadline covers a stalled response body and never retries playback actions', async () => {
  const appState = makeState();
  let calls = 0;
  let signal;
  const api = createApiClient({
    timeoutMs: 15, stateManager: appState, bus: noBus,
    fetchImpl: async (_url, options) => {
      calls += 1;
      signal = options.signal;
      return { status: 200, ok: true, json: () => new Promise(() => {}) };
    },
  });
  await assert.rejects(api.playerAction('next'), { name: 'TimeoutError' });
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(appState.connection.apiReachable, false);
});

test('cancelling a superseded HTTP read is silent and does not mark the API offline', async () => {
  const appState = makeState();
  const events = [];
  const api = createApiClient({
    stateManager: appState, bus: { emit: (...args) => events.push(args) },
    fetchImpl: () => new Promise(() => {}),
  });
  const controller = new AbortController();
  const pending = api.getLyrics(1, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(appState.connection.apiReachable, true);
  assert.deepEqual(events, []);
});

test('already-aborted reads do not issue a network request', async () => {
  let calls = 0;
  const api = createApiClient({ bus: noBus, fetchImpl: async () => { calls += 1; return response({}); } });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(api.getQueue({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 0);
});

test('API authentication headers remain compatible and 204 responses are supported', async () => {
  const storage = { getItem: key => key === 'tsbot_api_token' ? 'api-token' : 'admin-token' };
  let captured;
  const api = createApiClient({ storage, bus: noBus, fetchImpl: async (_url, options) => {
    captured = options;
    return { status: 204, ok: true, json() { throw new Error('empty body'); } };
  } });
  assert.equal(await api.getQQCookieStatus(), null);
  assert.equal(captured.headers.Authorization, 'Bearer api-token');
  assert.equal(captured.headers['x-admin-token'], 'admin-token');
});

test('late lyrics from a previous track cannot replace the current track, even if abort is ignored', async () => {
  const appState = makeState();
  const pending = new Map();
  const api = { getLyrics(id, options) { const entry = deferred(); pending.set(id, { ...entry, options }); return entry.promise; } };
  const client = new WsClient({ stateManager: appState, apiClient: api, bus: noBus });
  await client._handleMessage({ type: 'started', song: { track_id: 1, cover: 'one.jpg' } });
  await client._handleMessage({ type: 'started', song: { track_id: 2, cover: 'two.jpg' } });
  assert.equal(pending.get(1).options.signal.aborted, true);
  pending.get(2).resolve({ lyrics: [{ time: 0, text: 'second' }] });
  await flush();
  pending.get(1).resolve({ lyrics: [{ time: 0, text: 'first' }] });
  await flush();
  assert.equal(appState.lyrics.lines[0].text, 'second');
  client.disconnect();
});

test('finishing a song invalidates pending lyrics and cover data', async () => {
  const appState = makeState();
  const lyrics = deferred();
  const cover = deferred();
  const covers = [];
  const client = new WsClient({ stateManager: appState, apiClient: {
    getLyrics: () => lyrics.promise, getStatus: () => cover.promise, getQueue: async () => [],
  }, bus: { emit: (type, url) => { if (type === 'cover:load') covers.push(url); } } });
  await client._handleMessage({ type: 'started', song: { track_id: 1 } });
  await client._handleMessage({ type: 'finished' });
  lyrics.resolve({ lyrics: [{ time: 0, text: 'obsolete' }] });
  cover.resolve({ track_id: 1, artwork_url: 'obsolete.jpg' });
  await flush();
  assert.deepEqual(appState.lyrics.lines, []);
  assert.deepEqual(covers, []);
  client.disconnect();
});

test('sparse progress preserves only the matching cover and stale cover requests stay ignored', async () => {
  const appState = makeState();
  const covers = [];
  const pending = [];
  const client = new WsClient({ stateManager: appState, bus: { emit: (type, url) => {
    if (type === 'cover:load') covers.push(url);
  } }, apiClient: {
    getLyrics: async () => ({ lyrics: [] }),
    getStatus() { const entry = deferred(); pending.push(entry); return entry.promise; },
  } });
  await client._handleMessage({ type: 'started', song: { track_id: 1 } });
  await client._handleMessage({ type: 'progress', song: { track_id: 1 } });
  assert.equal(pending.length, 1, 'one pending cover request per track');
  await client._handleMessage({ type: 'started', song: { track_id: 2 } });
  pending[1].resolve({ queue_preview: [{ id: '2', artwork: 'current.jpg' }] });
  await flush();
  pending[0].resolve({ queue_preview: [{ id: 1, artwork: 'obsolete.jpg' }] });
  await flush();
  await client._handleMessage({ type: 'progress', song: { track_id: '2' } });
  assert.equal(appState.playback.song.cover, 'current.jpg');
  assert.deepEqual(covers, ['current.jpg']);
  await client._handleMessage({ type: 'started', song: { track_id: 3 } });
  assert.equal(appState.playback.song.cover, undefined, 'a new song never inherits another cover');
  client.disconnect();
});

test('a pushed queue cannot be overwritten by an older HTTP refresh', async () => {
  const appState = makeState();
  const entry = deferred();
  const client = new WsClient({ stateManager: appState, bus: noBus, apiClient: { getQueue: () => entry.promise } });
  const pending = client._refreshQueue();
  await client._handleMessage({ type: 'queue_update', queue: [{ id: 2, title: 'current' }] });
  entry.resolve({ items: [{ id: 1, title: 'obsolete' }] });
  await pending;
  assert.equal(appState.queue[0].id, 2);
  client.disconnect();
});

test('queue revision guards reject an external stale refresh without emitting a change', () => {
  const appState = makeState();
  const revision = appState.queueRevision;
  appState.updateQueue([{ id: 2 }]);
  assert.equal(appState.updateQueue([{ id: 1 }], { expectedRevision: revision }), false);
  assert.equal(appState.queue[0].id, 2);
});

test('initial HTTP status and queue snapshots cannot replace newer live state', async () => {
  const appState = makeState();
  const status = deferred();
  const queue = deferred();
  const events = [];
  const pending = bootstrapPlayback({ stateManager: appState, bus: { emit: (...args) => events.push(args) },
    apiClient: { getStatus: () => status.promise, getQueue: () => queue.promise } });
  appState.updatePlayback({ song: { track_id: 2 }, status: 'playing', position: 7 });
  appState.updateQueue([{ id: 2 }]);
  status.resolve({ track_id: 1, now_playing_title: 'obsolete', volume_percent: 0 });
  queue.resolve({ items: [{ id: 1 }] });
  await pending;
  assert.equal(appState.playback.song.track_id, 2);
  assert.equal(appState.playback.position, 7);
  assert.equal(appState.queue[0].id, 2);
  assert.deepEqual(events, []);
});

test('initial snapshots still populate playback, volume and queue when no live update supersedes them', async () => {
  const appState = makeState();
  const events = [];
  await bootstrapPlayback({ stateManager: appState, bus: { emit: (...args) => events.push(args) }, apiClient: {
    getStatus: async () => ({ track_id: 1, now_playing_title: 'current', state: 'playing',
      current_time: 2, volume_percent: 25, now_playing_source_url: 'https://audio.test/current.mp3' }),
    getQueue: async () => ({ items: [{ id: 1 }] }),
  } });
  assert.equal(appState.playback.song.track_id, 1);
  assert.equal(appState.playback.song.source_url, 'https://audio.test/current.mp3');
  assert.equal(appState.playback.position, 2);
  assert.equal(appState.queue[0].id, 1);
  assert.deepEqual(events, [['volume:changed', 25]]);
});

test('initial snapshot request failure remains contained and does not prevent the other snapshot', async () => {
  const appState = makeState();
  const result = await bootstrapPlayback({ stateManager: appState, bus: noBus, apiClient: {
    getStatus: async () => { throw new Error('offline'); }, getQueue: async () => [{ id: 1 }],
  } });
  assert.equal(result[0].status, 'rejected');
  assert.equal(result[1].status, 'fulfilled');
  assert.equal(appState.queue[0].id, 1);
});

test('connecting twice creates one socket and callbacks from replaced sockets cannot corrupt connection state', () => {
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.readyState = 0; Socket.instances.push(this); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  Socket.instances = [];
  const appState = makeState();
  const client = new WsClient({ stateManager: appState, bus: noBus, socketClass: Socket });
  client.connect();
  client.connect();
  assert.equal(Socket.instances.length, 1);
  const old = client.ws;
  client.disconnect();
  client.connect();
  const current = client.ws;
  current.readyState = Socket.OPEN;
  current.onopen();
  old.onclose();
  assert.equal(appState.connection.wsConnected, true);
  assert.equal(client._reconnectTimer, null);
  client.disconnect();
});

function searchContainer() {
  const results = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const input = { value: '', focus() {}, events: {}, addEventListener(type, fn) { this.events[type] = fn; } };
  const button = { addEventListener() {} };
  return {
    style: {}, innerHTML: '', results, input,
    querySelector(selector) {
      if (selector === '.search-results') return results;
      if (selector === '.search-input') return input;
      return button;
    },
  };
}

test('search renders the latest result rather than the last network response', async () => {
  const requests = new Map();
  const container = searchContainer();
  const panel = new SearchPanel(container, { apiClient: {
    search(keyword, options) { const entry = deferred(); requests.set(keyword, { ...entry, options }); return entry.promise; },
  } });
  const first = panel._doSearch('first');
  const second = panel._doSearch('second');
  assert.equal(requests.get('first').options.signal.aborted, true);
  requests.get('second').resolve({ songs: [{ title: 'current', song_mid: 'b' }] });
  await second;
  requests.get('first').resolve({ songs: [{ title: 'obsolete', song_mid: 'a' }] });
  await first;
  assert.match(container.results.innerHTML, /current/);
  assert.doesNotMatch(container.results.innerHTML, /obsolete/);
  panel.dispose();
});

test('typing immediately invalidates an old response during the debounce window', async () => {
  const entry = deferred();
  const container = searchContainer();
  const panel = new SearchPanel(container, { apiClient: { search: () => entry.promise } });
  const pending = panel._doSearch('previous');
  container.input.value = 'next';
  container.input.events.input();
  entry.resolve({ songs: [{ title: 'obsolete' }] });
  await pending;
  assert.doesNotMatch(container.results.innerHTML, /obsolete/);
  panel.dispose();
});

test('stale cookie checks cannot replace newer search results', async () => {
  const cookie = deferred();
  const container = searchContainer();
  const panel = new SearchPanel(container, { apiClient: {
    search: async keyword => keyword === 'first' ? { songs: [] } : { songs: [{ title: 'current' }] },
    getQQCookieStatus: () => cookie.promise,
  } });
  const old = panel._doSearch('first');
  await flush();
  await panel._doSearch('second');
  cookie.resolve({ cookie_set: false });
  await old;
  assert.match(container.results.innerHTML, /current/);
  assert.doesNotMatch(container.results.innerHTML, /登录已过期/);
  panel.dispose();
});

test('connection UI distinguishes healthy progress from a failed control API', () => {
  const appState = makeState();
  const container = { style: {}, innerHTML: '' };
  const bar = new ConnectionBar(container);
  appState.updateConnection({ wsConnected: true });
  assert.equal(container.style.display, 'none');
  appState.updateConnection({ apiReachable: false });
  assert.equal(container.style.display, 'block');
  assert.match(container.innerHTML, /控制接口/);
  appState.updateConnection({ apiReachable: true });
  assert.equal(container.style.display, 'none');
  bar.dispose();
});
