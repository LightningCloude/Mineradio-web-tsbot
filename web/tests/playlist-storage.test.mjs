import assert from 'node:assert/strict';
import test from 'node:test';
const { PlaylistManager } = await import('../src/shared/PlaylistManager.js');
const make = initial => {
  let value = JSON.stringify(initial || []); let fail = false; const messages = [];
  const storage = { getItem: () => value, setItem: (_key, text) => { if (fail) throw new Error('quota'); value = text; } };
  const bus = { emit: (...args) => messages.push(args) };
  return { manager: new PlaylistManager({ storage, bus }), storage, bus, messages, fail: () => { fail = true; }, saved: () => JSON.parse(value) };
};
const song = (mid, title = '同名歌曲') => ({ song_mid: mid, title, artist: '歌手', duration_ms: 1000 });

test('legacy text playlists keep their storage key/data and name-search fallback', () => {
  const { manager, saved } = make([{ id: 'old', name: '旧歌单', songs: 'one\ntwo', cover: '' }]);
  assert.deepEqual(manager.getSongs('old'), ['one', 'two']);
  assert.deepEqual(manager.getEntries('old'), [{ kind: 'text', line: 'one' }, { kind: 'text', line: 'two' }]);
  assert.equal(manager.addSong('old', 'three'), true); assert.equal(saved()[0].songs, 'one\ntwo\nthree');
});
test('online snapshots survive reload and repeat saving never overwrites modifications', () => {
  const context = make(); const { manager } = context;
  const result = manager.createFromQQ({ id: '123', name: '网上歌单', songs: [song('a'), song('b')] });
  assert.equal(result.exists, false); const id = result.playlist.id;
  manager.addSong(id, '追加的文本歌曲');
  const second = manager.createFromQQ({ id: '123', name: '网上歌单', songs: [song('c')] });
  assert.equal(second.exists, true); assert.equal(manager.playlists.length, 1);
  const reload = new PlaylistManager(context);
  assert.deepEqual(reload.getEntries(id).map(entry => entry.song_mid || entry.line), ['a', 'b', '追加的文本歌曲']);
});
test('same-name different-version songs stay separate by MID and exact favorites deduplicate', () => {
  const { manager } = make();
  assert.equal(manager.addTrackToDefault(song('a')), true);
  assert.equal(manager.addTrackToDefault(song('b')), true);
  assert.equal(manager.addTrackToDefault(song('a')), false);
  assert.equal(manager.getEntries(manager.playlists[0].id).length, 2);
});
test('text favorites upgrade to a chosen MID; later text additions keep structured entries aligned', () => {
  const { manager } = make(); const playlist = manager.create('test', '歌手 - 同名歌曲');
  manager.addTrackToDefault(song('a')); manager.addSong(playlist.id, 'text');
  assert.deepEqual(manager.getEntries(playlist.id).map(entry => entry.kind), ['song', 'text']);
  manager.get(playlist.id).songs = 'external replacement';
  assert.deepEqual(manager.getEntries(playlist.id), [{ kind: 'text', line: 'external replacement' }]);
});
test('quota errors do not mutate memory or existing storage and produce no successful change event', () => {
  const context = make(); const before = context.saved(); context.fail();
  assert.equal(context.manager.create('lost', 'song'), null);
  assert.equal(context.manager.addTrackToDefault(song('a')), false);
  assert.deepEqual(context.saved(), before); assert.deepEqual(context.manager.playlists, before);
  assert.match(context.manager.lastError, /无法保存/);
  assert.equal(context.messages.filter(([name]) => name === 'playlist:changed').length, 0);
});
