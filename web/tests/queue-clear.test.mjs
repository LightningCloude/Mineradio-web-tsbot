import assert from 'node:assert/strict';
import test from 'node:test';
import { QueueMutationGate } from '../src/core/QueueMutationGate.js';

Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
globalThis.document = { addEventListener() {} }; globalThis.localStorage = { getItem: () => null };
const interval = globalThis.setInterval; globalThis.setInterval = () => 0;
const { QueueClearController } = await import('../src/player/QueueClearController.js');
const { PlaylistImporter } = await import('../src/player/PlaylistImporter.js');
const { createApiClient } = await import('../src/core/ApiClient.js');
globalThis.setInterval = interval;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function harness(extra = {}) {
  const gate = new QueueMutationGate(); const calls = [];
  const state = { queue: [{ id: 1 }], queueRevision: 0, playback: { status: 'paused', position: 42 }, lyrics: ['unchanged'],
    updateQueue(items, options = {}) { if (options.expectedRevision != null && this.queueRevision !== options.expectedRevision) return false; this.queue = items; this.queueRevision++; return true; } };
  const api = { clearQueue: async () => { calls.push('clear'); return { ok: true, removed_count: 300 }; },
    getQueue: async () => { calls.push('read'); return { items: [] }; }, ...extra };
  const importer = { stopAndWait: async () => calls.push('stop') };
  return { gate, calls, state, api, importer, controller: new QueueClearController({ apiClient: api, stateManager: state, importer, gate }) };
}

test('clear is one write and reconciles the actual queue without changing playback or lyrics', async () => {
  const h = harness({ getQueue: async () => ({ items: [{ id: 301, title: 'Other user just added' }] }) });
  const beforePlayback = h.state.playback; const beforeLyrics = h.state.lyrics;
  const result = await h.controller.clear();
  assert.equal(result.removedCount, 300); assert.deepEqual(h.calls, ['stop', 'clear']);
  assert.equal(h.state.queue[0].id, 301); assert.equal(h.state.playback, beforePlayback); assert.equal(h.state.lyrics, beforeLyrics);
  assert.equal(h.gate.clearing, false);
});

test('clear locks immediately, waits for pending writes and rejects new writes or duplicate clears', async () => {
  const h = harness(); const pending = deferred();
  const write = h.gate.write(() => pending.promise); await flush();
  const clearing = h.controller.clear(); await flush();
  assert.deepEqual(h.calls, ['stop']); assert.equal(h.gate.clearing, true);
  await assert.rejects(h.gate.write(() => assert.fail('must not write')), { status: 409 });
  assert.deepEqual(await h.controller.clear(), { busy: true });
  pending.resolve(); await write; await clearing;
  assert.deepEqual(h.calls, ['stop', 'clear', 'read']);
});

test('timeout or disconnect reconciles once but never retries a destructive request', async () => {
  for (const error of [new DOMException('late', 'TimeoutError'), new TypeError('offline')]) {
    let writes = 0; const h = harness({ clearQueue: async () => { writes++; throw error; } });
    const result = await h.controller.clear();
    assert.equal(result.uncertain, true); assert.match(result.message, /未自动重试/); assert.equal(writes, 1);
    assert.deepEqual(h.calls, ['stop', 'read']); assert.equal(h.gate.clearing, false);
  }
});

test('explicit failure remains an error; sync failure never pretends the queue is empty', async () => {
  const h = harness({ clearQueue: async () => { throw Object.assign(new Error('database busy'), { status: 503 }); },
    getQueue: async () => { throw new Error('offline'); } });
  const result = await h.controller.clear();
  assert.equal(result.uncertain, false); assert.match(result.message, /database busy/); assert.equal(h.state.queue.length, 1);
  assert.equal(h.gate.clearing, false);
});

test('pre-clear reads cannot reintroduce deleted items and concurrent new authoritative updates win', async () => {
  const pending = deferred(); const h = harness({ getQueue: () => pending.promise });
  const oldRevision = h.state.queueRevision;
  const clearing = h.controller.clear(); await flush();
  assert.equal(h.state.updateQueue([{ id: 1 }], { expectedRevision: oldRevision }), false);
  h.state.updateQueue([{ id: 999 }]); pending.resolve({ items: [] }); await clearing;
  assert.equal(h.state.queue[0].id, 999);
});

test('one pending importer request settles before clear and no further batch starts', async () => {
  const h = harness(); const pending = deferred(); const writes = [];
  h.api.addToQueue = mid => h.gate.write(async () => { writes.push(mid); await pending.promise; });
  const importer = new PlaylistImporter({ apiClient: h.api, bus: { emit() {} }, queueGate: h.gate });
  const batch = importer.start({ entries: [{ kind: 'song', song_mid: 'a' }, { kind: 'song', song_mid: 'b' }] });
  await flush();
  const controller = new QueueClearController({ apiClient: h.api, stateManager: h.state, importer, gate: h.gate });
  const clearing = controller.clear(); await flush();
  assert.equal(importer.task.stopRequested, true); assert.equal(await importer.start({ entries: [{ song_mid: 'c' }] }), null);
  assert.equal(h.calls.includes('clear'), false);
  pending.resolve(); await batch; await clearing;
  assert.deepEqual(writes, ['a']); assert.equal(importer.task.stopped, true); assert.equal(h.calls.filter(call => call === 'clear').length, 1);
});

test('API preserves single-delete operations but uses one dedicated keep-playing bulk endpoint', async () => {
  const calls = []; const gate = new QueueMutationGate();
  const api = createApiClient({ queueGate: gate, storage: null, stateManager: { updateConnection() {} }, bus: { emit() {} },
    fetchImpl: async (url, options) => { calls.push([url, options.method]); return { ok: true, status: 200, json: async () => ({ ok: true, removed_count: 1 }) }; } });
  await api.clearQueue(); await api.removeFromQueue(9); await api.addToQueue('mid');
  assert.deepEqual(calls, [['/api/external/queue?stop_playback=false', 'DELETE'], ['/api/external/queue/9', 'DELETE'], ['/api/external/queue', 'POST']]);
});

test('an uncertain in-flight add pauses clearing instead of racing a late server write', async () => {
  const h = harness(); const pending = deferred();
  const write = h.gate.write(() => pending.promise).catch(() => {}); await flush();
  const clearing = h.controller.clear(); await flush();
  pending.reject(new DOMException('timeout', 'TimeoutError')); await write;
  const result = await clearing;
  assert.equal(result.uncertain, true); assert.match(result.message, /已暂停清空/);
  assert.equal(h.calls.includes('clear'), false); assert.equal(h.gate.clearing, false);
});
