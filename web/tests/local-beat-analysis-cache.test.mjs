import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalBeatAnalysisCache,
  songBeatCacheKey,
} from '../src/core/LocalBeatAnalysisCache.js';

test('stable local beat cache keys do not use queue position', () => {
  const first = {
    id: 1,
    queue_id: 1,
    source: 'qqmusic',
    song_mid: 'TRACK-01',
    title: ' Example Song ',
    artist: 'Artist',
  };
  const replay = { ...first, id: 99, queue_id: 99 };
  assert.equal(songBeatCacheKey(first), songBeatCacheKey(replay));
  assert.match(songBeatCacheKey(first), /^v1:qqmusic:track-01$/);
});

test('memory fallback keeps a beat grid local when IndexedDB is unavailable', async () => {
  const cache = new LocalBeatAnalysisCache({ indexedDBFactory: null });
  const song = { track_id: 'qqmusic:local', title: 'Local Song', artist: 'Tester' };
  const result = { beats: [{ time: 0, type: 'downbeat' }], gridStep: 0.5 };
  assert.equal(await cache.get(song), null);
  assert.equal(await cache.set(song, result), true);
  assert.deepEqual(await cache.get(song), result);
});

test('expired local cache entries are not used', async () => {
  let current = 100;
  const cache = new LocalBeatAnalysisCache({ indexedDBFactory: null, now: () => current, maxAgeMs: 10 });
  const song = { track_id: 'qqmusic:expiry', title: 'Expiry Song' };
  await cache.set(song, { beats: [{ time: 0 }], gridStep: 0.5 });
  current += 11;
  assert.equal(await cache.get(song), null);
});
