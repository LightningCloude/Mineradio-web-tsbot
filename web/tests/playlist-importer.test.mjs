import assert from 'node:assert/strict';
import test from 'node:test';
Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'unit' }, configurable: true });
globalThis.document = { addEventListener() {} }; globalThis.localStorage = { getItem: () => null };
const oldInterval = globalThis.setInterval; globalThis.setInterval = () => 0;
const { PlaylistImporter } = await import('../src/player/PlaylistImporter.js');
globalThis.setInterval = oldInterval;
const direct = (mid = 'a') => ({ kind: 'song', song_mid: mid, title: mid, line: mid });
function harness(overrides = {}) {
  let clock = 0; const writes = []; const searches = [];
  const apiClient = { search: async line => { searches.push(line); return { items: [{ song_mid: line, title: line }] }; },
    addToQueue: async (mid, meta) => { writes.push({ mid, meta, at: clock }); }, ...overrides };
  const importer = new PlaylistImporter({ apiClient, bus: { emit() {} }, interval: 300, now: () => clock, sleep: async ms => { clock += ms; } });
  return { importer, writes, searches };
}
test('direct IDs never re-search and all append writes are sequential at least 300ms apart', async () => {
  const { importer, searches, writes } = harness();
  await importer.start({ name: 'test', entries: [direct('a'), direct('b'), direct('c')] });
  assert.deepEqual(searches, []); assert.deepEqual(writes.map(write => write.at), [0, 300, 600]);
  assert.ok(writes.every(write => write.meta.playNow === false)); assert.equal(importer.task.ok, 3);
});
test('play-all starts exactly the first successful available song', async () => {
  const calls = []; const { importer } = harness({ addToQueue: async (mid, meta) => {
    calls.push([mid, meta.playNow]); if (mid === 'failed') throw Object.assign(new Error(), { status: 403 });
  } });
  await importer.start({ entries: [direct(''), direct('failed'), direct('good'), direct('next')], playNow: true });
  assert.deepEqual(calls, [['failed', true], ['good', true], ['next', false]]); assert.equal(importer.task.ok, 2);
});
test('a second panel cannot start a batch while another has a pending read', async () => {
  let resolve; const { importer } = harness({ search: () => new Promise(done => { resolve = done; }) });
  const batch = importer.start({ entries: [{ kind: 'text', line: 'one' }] });
  assert.equal(await importer.start({ entries: [direct('b')] }), null);
  resolve({ items: [{ song_mid: 'one', title: 'one' }] }); await batch; assert.equal(importer.task.ok, 1);
});
test('stop finishes the current write but never sends the next one', async () => {
  let done; const calls = []; const { importer } = harness({ addToQueue: mid => { calls.push(mid); return new Promise(resolve => { done = resolve; }); } });
  const batch = importer.start({ entries: [direct('a'), direct('b')] });
  importer.stop(); done(); await batch;
  assert.deepEqual(calls, ['a']); assert.equal(importer.task.stopped, true); assert.equal(importer.task.ok, 1);
});
test('uncertain writes stop without retry or falsely counting a known failure', async () => {
  let calls = 0; const { importer } = harness({ addToQueue: async () => { calls++; throw new DOMException('timeout', 'TimeoutError'); } });
  await importer.start({ entries: [direct('a'), direct('b')] });
  assert.equal(calls, 1); assert.equal(importer.running, false); assert.equal(importer.task.uncertain, true);
  assert.equal(importer.task.ok + importer.task.fail, 0);
});
test('legacy text import searches names and keeps first-index playback behavior', async () => {
  const { importer, searches, writes } = harness();
  await importer.start({ entries: [{ kind: 'text', line: 'a' }, { kind: 'text', line: 'b' }], playNow: true, playFirstSuccess: false });
  assert.deepEqual(searches, ['a', 'b']); assert.deepEqual(writes.map(write => write.meta.playNow), [true, false]);
});
