import test from 'node:test';
import assert from 'node:assert/strict';
globalThis.document = { addEventListener() {} };
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'unit-test' }, configurable: true });
const originalInterval = globalThis.setInterval; globalThis.setInterval = () => 0;
const { QQLibraryManager, QQ_LIBRARY_KEY } = await import('../src/shared/QQLibraryManager.js');
const { PlaylistManager } = await import('../src/shared/PlaylistManager.js');
const { createApiClient } = await import('../src/core/ApiClient.js');
const { SharedLibraryView } = await import('../src/player/SharedLibraryView.js');
globalThis.setInterval = originalInterval;

const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const ready = (version = 'A', id = 'accountA') => ({ status: 'ready', account_id: id, account_version: version, complete: true,
  items: [{ id: '99', kind: 'liked', name: '我喜欢 &amp; 音乐', cover: 'javascript:alert(1)', songCount: 2 }] });
const detail = (version = 'A', id = 'accountA') => ({ status: 'ready', account_id: id, account_version: version,
  playlist: { id: '99' }, data: { code: 0, cdlist: [{ dissid: '99', dissname: '我喜欢', total_song_num: 2,
    songlist: [{ songmid: 'EXACT_1', songname: '同名歌曲', interval: 123 }, { songmid: 'EXACT_2', songname: '同名歌曲', interval: 125 }] }] } });
function setup({ api = {}, storage, now = () => 1000 } = {}) {
  const memory = new Map();
  storage ||= { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  const listeners = new Map(); const events = [];
  const bus = { on: (key, cb) => { listeners.set(key, cb); return () => listeners.delete(key); }, emit: (key, data) => { events.push([key, data]); listeners.get(key)?.(data); } };
  const counts = { directory: 0, detail: 0 };
  const client = { getQQLibrary: async () => { counts.directory++; return ready(); },
    getQQLibraryPlaylist: async () => { counts.detail++; return detail(); }, ...api };
  const manager = new QQLibraryManager({ apiClient: client, bus, storage, now });
  return { manager, counts, client, storage, bus, events };
}

test('sync reads only directory, safely adapts fields, persists separately from local favorites', async () => {
  const { manager, counts, storage, bus } = setup();
  const local = new PlaylistManager({ storage, bus }); local.create('本地收藏', 'existing');
  const before = storage.getItem('minerats-playlists-v2');
  assert.equal(await manager.refresh(), true);
  assert.deepEqual(counts, { directory: 1, detail: 0 });
  assert.equal(manager.state.items[0].name, '我喜欢 & 音乐'); assert.equal(manager.state.items[0].cover, '');
  assert.ok(storage.getItem(QQ_LIBRARY_KEY)); assert.equal(storage.getItem('minerats-playlists-v2'), before);
  local.addSongToDefault('new favorite'); assert.equal(local.getSongs(local.playlists[0].id).length, 2);
});
test('overlapping syncs merge and opening panel within five minutes does not refetch', async () => {
  const wait = deferred(); let reads = 0;
  const { manager } = setup({ api: { getQQLibrary: () => { reads++; return wait.promise; } } });
  const one = manager.refresh(); const two = manager.refresh(); wait.resolve(ready()); await Promise.all([one, two]);
  await manager.refresh(); assert.equal(reads, 1);
});
test('detail loads lazily and caches exact song IDs and duration for five minutes', async () => {
  let clock = 1000; const { manager, counts } = setup({ now: () => clock }); await manager.refresh();
  const value = await manager.getDetail('99'); await manager.getDetail('99');
  assert.equal(counts.detail, 1); assert.equal(value.songs[0].duration_ms, 123000);
  assert.deepEqual(value.songs.map(song => song.song_mid), ['EXACT_1', 'EXACT_2']);
  clock += 300001; await manager.getDetail('99'); assert.equal(counts.detail, 2);
});
test('clearing credentials cancels reads and ignores late directory responses', async () => {
  const wait = deferred(); const { manager, bus } = setup({ api: { getQQLibrary: () => wait.promise } });
  manager.start(); bus.emit('qq:credentials-changed', { cleared: true }); wait.resolve(ready()); await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.state.status, 'unconfigured'); assert.equal(manager.state.items.length, 0);
});
test('account switch invalidates detail cache and late detail never enters new account', async () => {
  const wait = deferred(); const { manager, client } = setup(); await manager.refresh();
  client.getQQLibraryPlaylist = () => wait.promise; const reading = manager.getDetail('99');
  client.getQQLibrary = async () => ready('B', 'accountB'); await manager.refresh({ force: true });
  wait.resolve(detail()); await assert.rejects(reading, /账号已变更/); assert.equal(manager.cache.items.size, 0);
});
test('prepare rechecks current account before import even if detail was cached', async () => {
  const { manager, client } = setup(); await manager.refresh(); await manager.getDetail('99');
  client.getQQLibrary = async () => ready('B', 'accountB');
  await assert.rejects(manager.prepare('99', 'A'), /账号已变更/);
});
test('failures retain verified session data with error, never turn into empty success', async () => {
  const { manager, client } = setup(); await manager.refresh();
  client.getQQLibrary = async () => ({ status: 'unavailable' });
  assert.equal(await manager.refresh({ force: true }), false); assert.equal(manager.state.items.length, 1); assert.ok(manager.state.error);
  client.getQQLibrary = async () => ({ status: 'expired' }); await manager.refresh({ force: true });
  assert.equal(manager.state.status, 'expired'); assert.equal(manager.state.items.length, 0);
});
test('persisted data is hidden until current server identity matches; stale is not successful login', async () => {
  const cache = { ...ready(), updatedAt: 50 };
  const storage = { getItem: () => JSON.stringify(cache), setItem() {}, removeItem() {} };
  const { manager, client } = setup({ storage, api: { getQQLibrary: async () => ({ status: 'unavailable' }) } });
  assert.equal(manager.state.items.length, 0); await manager.refresh(); assert.equal(manager.state.items.length, 0);
  client.getQQLibrary = async () => ({ status: 'unavailable', account_id: 'accountA', account_version: 'A' });
  await manager.refresh({ force: true }); assert.equal(manager.state.status, 'stale'); assert.equal(manager.state.items.length, 1);
});
test('storage failure is explicit but does not block directory or mutate local data', async () => {
  const { manager } = setup({ storage: { getItem() { throw Error('denied'); }, setItem() { throw Error('full'); } } });
  assert.equal(await manager.refresh(), true); assert.ok(manager.state.storageError); assert.equal(manager.state.items.length, 1);
});
test('API uses metadata-only library endpoints and passes account version, never auth status Cookie', async () => {
  const urls = []; const client = createApiClient({ storage: { getItem() {} }, stateManager: { updateConnection() {} }, bus: { emit() {} },
    fetchImpl: async url => { urls.push(url); return { ok: true, status: 200, json: async () => ({}) }; } });
  await client.getQQLibrary({ refresh: true }); await client.getQQLibraryPlaylist('99', 'version');
  assert.deepEqual(urls, ['/api/qqmusic/library?refresh=true', '/api/qqmusic/library/playlists/99?account_version=version']);
  await assert.rejects(client.getQQLibraryPlaylist('../bad', 'v'));
});

function viewHarness(prepare) {
  const view = Object.create(SharedLibraryView.prototype); const writes = []; const saved = [];
  view.detail = { id: '99', account_id: 'accountA', account_version: 'A', songCount: 2,
    songs: [{ song_mid: 'exact_1', title: 'Same name' }, { song_mid: 'exact_2', title: 'Same name' }] };
  Object.assign(view, { _token: 1, _clearRevision: 0, preparing: false, _partialAccepted: false, render() {},
    library: { prepare: prepare || (async () => view.detail) }, importer: { running: false, start: value => { writes.push(value); return Promise.resolve(); } },
    gate: { clearing: false }, playlists: { createFromQQ: value => { saved.push(value); return { exists: false }; } },
    bus: { emit() {} }, onImport() {} });
  return { view, writes, saved };
}
test('shared view imports exact frozen entries, append never plays and play-all uses first-success policy', async () => {
  const { view, writes } = viewHarness(); await view.act('append'); await view.act('play');
  assert.equal(writes[0].playNow, false); assert.equal(writes[1].playNow, true); assert.equal(writes[1].playFirstSuccess, true);
  assert.deepEqual(writes[0].entries.map(song => song.song_mid), ['exact_1', 'exact_2']);
});
test('clear during metadata preparation cancels import even when clear finishes before the read', async () => {
  const pending = deferred(); const { view, writes } = viewHarness(() => pending.promise);
  const action = view.act('append'); view._clearRevision++; pending.resolve(view.detail); await action;
  assert.equal(writes.length, 0); assert.match(view.error, /已清空/); assert.equal(view.preparing, false);
});
test('duplicate clicks and another active import cannot start a second task', async () => {
  const pending = deferred(); const { view, writes } = viewHarness(() => pending.promise);
  const action = view.act('append'); await view.act('play'); assert.equal(writes.length, 0);
  view.importer.running = true; pending.resolve(view.detail); await action; assert.equal(writes.length, 0);
});
test('partial results need explicit consent and changed partial count requires renewed consent', async () => {
  const { view, writes } = viewHarness(); view.detail.songCount = 5;
  await view.act('append'); assert.equal(writes.length, 0);
  view._partialAccepted = true;
  view.library.prepare = async () => ({ ...view.detail, songCount: 8 });
  await view.act('append'); assert.equal(writes.length, 0); assert.equal(view._partialAccepted, false);
  assert.match(view.error, /重新确认/);
});
test('local save failure remains visible instead of announcing success', async () => {
  const { view } = viewHarness(); view.playlists = { createFromQQ: () => null, lastError: 'storage full' };
  await view.act('save'); assert.equal(view.error, 'storage full'); assert.equal(view.preparing, false);
});

test('startup is idempotent; saved credentials trigger sync and clearing preserves unrelated local data', async () => {
  const { manager, counts, bus, storage } = setup();
  storage.setItem('minerats-playlists-v2', 'unchanged');
  manager.start(); manager.start(); await manager._request;
  assert.equal(counts.directory, 1);
  bus.emit('qq:credentials-changed', { cleared: false }); await manager._request;
  assert.equal(counts.directory, 2);
  bus.emit('qq:credentials-changed', { cleared: true });
  assert.equal(manager.state.items.length, 0); assert.equal(storage.getItem(QQ_LIBRARY_KEY), undefined);
  assert.equal(storage.getItem('minerats-playlists-v2'), 'unchanged');
});
