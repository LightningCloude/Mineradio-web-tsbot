import assert from 'node:assert/strict';
import test from 'node:test';

Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'unit-test' }, configurable: true });
globalThis.document = { addEventListener() {} };
globalThis.localStorage = { getItem() { return null; }, setItem() {} };
const originalInterval = globalThis.setInterval;
globalThis.setInterval = () => 0;
const { QueuePanel } = await import('../src/player/QueuePanel.js');
const { PlaylistImporter } = await import('../src/player/PlaylistImporter.js');
globalThis.setInterval = originalInterval;

const song = name => ({ song_mid: name, title: name, artist: 'Artist', duration_ms: 120000, cover: '/fixture-cover.svg' });

function makePanel(songs = { first: ['one', 'two'], second: ['three'] }, apiClient = {}) {
  const nodes = new Map();
  const getNode = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { hidden: false, textContent: '', value: '', replaceChildren() {} });
    return nodes.get(selector);
  };
  const panel = Object.create(QueuePanel.prototype);
  panel.container = { querySelector: getNode };
  panel._view = 'list';
  panel._importing = false;
  panel._importResult = null;
  panel.events = [];
  panel.writes = [];
  panel.rows = [];
  panel._bus = { emit: (...args) => panel.events.push(args) };
  panel._state = { toggleUI() { throw new Error('Import must not toggle panel visibility'); } };
  panel._playlists = {
    playlists: Object.entries(songs).map(([id, list]) => ({ id, name: id, songs: list.join('\n') })),
    get(id) { return this.playlists.find(item => item.id === id); },
    getSongs(id) { return songs[id] || []; },
    getEntries(id) { return (songs[id] || []).map(line => ({ kind: 'text', line })); },
    setCover() {},
    create(name, lines) { const item = { id: 'new', name, songs: lines }; this.playlists.push(item); return item; },
  };
  panel._api = {
    async search(name) { return { items: [song(name)] }; },
    async addToQueue(mid, meta) { panel.writes.push({ mid, ...meta }); },
    ...apiClient,
  };
  panel._importer = new PlaylistImporter({ apiClient: panel._api, bus: panel._bus, interval: 0 });
  panel._importer.subscribe(() => panel._syncImport());
  panel._render = () => { panel._updateHeading(); panel._renderImportProgress(); };
  panel._appendImportRow = (line) => {
    const status = {};
    const row = { line, status, querySelector: () => status };
    panel.rows.push(row);
    return row;
  };
  return { panel, getNode };
}

test('completed imports allow back navigation and another import without closing the panel', async () => {
  const { panel, getNode } = makePanel();
  await panel._startBatchImport('first');
  assert.equal(panel._importing, false);
  assert.equal(panel._view, 'import');
  assert.equal(panel._importResult.ok, 2);
  assert.match(getNode('.playlist-import-status').textContent, /导入完成/);
  panel._showView('list');
  assert.equal(getNode('.playlist-import-view').hidden, true);
  assert.equal(getNode('.playlist-library').hidden, false);
  await panel._startBatchImport('second');
  assert.equal(panel._importResult.ok, 1);
  assert.equal(panel._importResult.total, 1);
  assert.deepEqual(panel.writes.map(item => [item.mid, item.playNow]), [['one', true], ['two', false], ['three', true]]);
});

test('returning during an import preserves a new draft and prevents concurrent queue writes', async () => {
  let resolveSearch;
  let searches = 0;
  const { panel, getNode } = makePanel({ first: ['one'], second: ['two'] }, {
    search() { searches++; return new Promise(resolve => { resolveSearch = resolve; }); },
  });
  const pending = panel._startBatchImport('first');
  panel._showView('list');
  await panel._startBatchImport('second');
  assert.equal(searches, 1);
  panel._showView('create');
  getNode('.playlist-paste-name').value = 'keep this draft';
  getNode('.playlist-paste-input').value = 'another song';
  resolveSearch({ items: [song('one')] });
  await pending;
  assert.equal(panel._view, 'create');
  assert.equal(getNode('.playlist-paste-name').value, 'keep this draft');
  assert.equal(getNode('.playlist-paste-input').value, 'another song');
  assert.equal(panel._importing, false);
  assert.equal(panel.writes.length, 1);
});

test('not-found, search errors and queue errors finish with correct totals and release the import lock', async () => {
  const { panel, getNode } = makePanel({ first: ['missing', 'search-error', 'queue-error', 'good'], second: ['good'] }, {
    async search(name) {
      if (name === 'search-error') throw new Error('offline');
      return { items: name === 'missing' ? [] : [song(name)] };
    },
    async addToQueue(mid) { if (mid === 'queue-error') throw Object.assign(new Error('queue failed'), { status: 500 }); },
  });
  await panel._startBatchImport('first');
  assert.equal(panel._importResult.ok, 1);
  assert.equal(panel._importResult.fail, 3);
  assert.equal(getNode('.playlist-import-progress').value, 4);
  assert.equal(getNode('.playlist-import-progress').max, 4);
  assert.deepEqual(panel.rows.map(row => row.status.textContent), ['未找到', '检索失败', '加入失败', '已加入']);
  panel._showView('list');
  await panel._startBatchImport('second');
  assert.equal(panel._importResult.ok, 1);
  assert.equal(panel._importResult.fail, 0);
});

test('missing and empty playlists never enter a stuck import view', async () => {
  const { panel } = makePanel({ empty: [] });
  await panel._startBatchImport('missing');
  await panel._startBatchImport('empty');
  assert.equal(panel._importing, false);
  assert.equal(panel._view, 'list');
  assert.equal(panel._importResult, null);
});

test('uncertain queue writes release the lock, stop further songs and warn before repeating', async () => {
  const { panel } = makePanel();
  panel._api.addToQueue = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await panel._startBatchImport('first');
  assert.equal(panel._importing, false);
  assert.equal(panel._importResult.interrupted, true);
  assert.equal(panel._importResult.uncertain, true);
  panel._showView('list');
  assert.equal(panel._view, 'list');
});

test('list, editor and import views are mutually exclusive and include a return path', () => {
  const { panel, getNode } = makePanel();
  for (const view of ['create', 'import', 'list']) {
    panel._showView(view);
    assert.equal(getNode('.playlist-library').hidden, view !== 'list');
    assert.equal(getNode('.playlist-paste-area').hidden, view !== 'create');
    assert.equal(getNode('.playlist-import-view').hidden, view !== 'import');
    assert.equal(getNode('.mini-queue-back').hidden, view === 'list');
  }
});

test('creating another playlist returns to the library and resets only the saved draft', () => {
  const { panel, getNode } = makePanel();
  panel._showView('create');
  getNode('.playlist-paste-name').value = 'new list';
  getNode('.playlist-paste-input').value = '  song A\nsong B  ';
  panel._createPlaylist();
  assert.equal(panel._view, 'list');
  assert.equal(panel._playlists.get('new').songs, 'song A\nsong B');
  assert.equal(getNode('.playlist-paste-input').value, '');
  assert.equal(getNode('.playlist-paste-confirm').disabled, true);
});

test('user-provided names and attributes are escaped without evaluating HTML', () => {
  const { panel } = makePanel();
  assert.equal(panel._esc('<img src=x onerror="x">&'), '&lt;img src=x onerror=&quot;x&quot;&gt;&amp;');
  assert.equal(panel._escAttr('" onmouseover="x'), '&quot; onmouseover=&quot;x');
});

test('mobile placement sits above the whole multi-row player bar, not the lower queue button', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.window = { innerWidth: 390, innerHeight: 844 };
  globalThis.document = {
    querySelector(selector) {
      return { getBoundingClientRect: () => selector === '.player-bar'
        ? { top: 708 } : { left: 90, top: 790, width: 34 } };
    },
  };
  try {
    const { panel } = makePanel();
    panel.container.style = {};
    panel._positionPanel();
    assert.equal(panel.container.style.bottom, '150px');
    assert.equal(panel.container.style.left, '195px');
    assert.equal(panel.container.style.maxHeight, '678px');
  } finally {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  }
});
