import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSong, playlistPage, playlistDetail, safeCover, decodeText, PlaylistDetailCache } from '../src/core/QQMusicData.js';

test('QQ playlist legacy songs normalize IDs, singer arrays, album covers and seconds', () => {
  const song = normalizeSong({ songmid: 'validMID', songname: 'A &amp; B', singer: [{ name: '甲' }, { name: '乙' }], interval: 123, albummid: 'albumMID', albumname: '专辑' });
  assert.equal(song.song_mid, 'validMID'); assert.equal(song.duration_ms, 123000);
  assert.equal(song.title, 'A & B'); assert.equal(song.artist, '甲 / 乙'); assert.match(song.cover, /albumMID\.jpg$/);
  assert.equal(normalizeSong({ song_mid: 'new', duration_ms: 5000 }).duration_ms, 5000);
  assert.equal(normalizeSong({ songmid: '" onclick=x', interval: -5 }).song_mid, '');
});
test('cover URLs reject executable schemes and unsafe relative paths', () => {
  for (const value of ['javascript:alert(1)', 'data:image/svg+xml,bad', '/\\evil.test/a', '/a\nb', 'https://user:pass@bad.test/a']) assert.equal(safeCover(value), '');
  assert.equal(safeCover('/fixture.svg'), '/fixture.svg'); assert.equal(safeCover('//example.test/cover'), 'https://example.test/cover');
});
test('text entity decoding remains text even for HTML-shaped names', () => {
  assert.equal(decodeText('&#128214; &lt;img onerror=x&gt;'), '📖 <img onerror=x>');
  assert.equal(decodeText('&#x110000;'), '');
});
test('playlist search honors upstream business errors and pagination', () => {
  const data = { code: 0, req: { code: 0, data: { code: 0, meta: { sum: 21 }, body: { songlist: { list: [{ dissid: '123', dissname: '歌单', creator: { name: '作者' }, song_count: 61 }] } } } } };
  const page = playlistPage(data); assert.equal(page.hasMore, true); assert.equal(page.items[0].creator, '作者');
  data.req.code = 100; assert.throws(() => playlistPage(data), /QQ/);
});
test('playlist detail reports actual and advertised counts, missing IDs, unavailable lists', () => {
  const detail = playlistDetail({ code: 0, cdlist: [{ dissid: '123', dissname: '歌单', total_song_num: 9, songlist: [{ songmid: 'one', interval: 10 }, { songname: '不可用' }] }] });
  assert.equal(detail.songCount, 9); assert.equal(detail.songs.length, 2); assert.equal(detail.songs[1].song_mid, '');
  assert.throws(() => playlistDetail({ code: 0, cdlist: [] }), /无法访问/);
});
test('detail cache expires at five minutes and evicts least recently used past ten', () => {
  let now = 0; const cache = new PlaylistDetailCache({ now: () => now });
  for (let i = 0; i < 10; i++) cache.set(String(i), i);
  assert.equal(cache.get('0'), 0); cache.set('10', 10); assert.equal(cache.get('1'), null); assert.equal(cache.items.size, 10);
  now = 300000; assert.equal(cache.get('0'), null);
});
