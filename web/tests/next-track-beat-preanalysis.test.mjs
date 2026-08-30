import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NextTrackBeatPreAnalyzer,
  selectNextQueueSong,
  songAnalysisKey,
} from '../src/core/NextTrackBeatPreAnalyzer.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeCache(calls, { hitTitles = [] } = {}) {
  return {
    keyFor(song) { return `local:${song.track_id || song.id || song.title}`; },
    async get(song) {
      calls.push(['get', song.title]);
      return hitTitles.includes(song.title) ? { beats: [{}] } : null;
    },
    async set(song, result) { calls.push(['set', song.title, result]); return true; },
  };
}

test('selects the item after the current queue id, or the first remaining item', () => {
  const queue = [
    { id: 10, track_id: 'qqmusic:a', title: 'A' },
    { id: 11, track_id: 'qqmusic:b', title: 'B' },
  ];
  assert.equal(selectNextQueueSong({ track_id: 10 }, queue), queue[1]);
  assert.equal(selectNextQueueSong({ track_id: 9 }, queue), queue[0]);
  assert.equal(selectNextQueueSong({ track_id: 11 }, queue), null);
  assert.equal(songAnalysisKey(queue[1]), '11');
});

test('default pre-analysis cadence leaves bandwidth headroom between songs', () => {
  const delays = [];
  const pre = new NextTrackBeatPreAnalyzer({
    analyzer: {},
    cache: makeCache([]),
    setTimer: (_callback, delay) => { delays.push(delay); return 1; },
    clearTimer() {},
  });
  pre.schedule(
    { track_id: 1 },
    [{ id: 1, title: 'A' }, { id: 2, title: 'B', source_url: '/b.mp3' }],
    true,
  );
  assert.deepEqual(delays, [8000]);
});

test('checks this browser local cache first and skips analysis on a hit', async () => {
  const calls = [];
  const ready = [];
  const statuses = [];
  const pre = new NextTrackBeatPreAnalyzer({
    cache: makeCache(calls, { hitTitles: ['B'] }),
    analyzer: { analyze: async () => calls.push(['analyze']) },
    delayMs: 0,
    logger: { log() {}, warn() {} },
    onReady: detail => ready.push(detail),
    onStatus: detail => statuses.push(detail.status),
  });
  pre.schedule({ track_id: 1 }, [{ id: 1, title: 'A' }, { id: 2, title: 'B', source_url: '/b.mp3' }], true);
  await tick();
  await tick();
  assert.deepEqual(calls, [['get', 'B']]);
  assert.deepEqual(ready, [{ key: '2', name: 'B', source: 'local-cache' }]);
  assert.deepEqual(statuses, ['analyzing', 'ready']);
});

test('analyzes and writes one local cache miss, retaining the queue id for reuse', async () => {
  const calls = [];
  const ready = [];
  const statuses = [];
  const result = { beats: [{ time: 0.5 }], gridStep: 0.5 };
  const pre = new NextTrackBeatPreAnalyzer({
    cache: makeCache(calls),
    analyzer: {
      analyze: async (key, url) => { calls.push(['analyze', key, url]); return result; },
    },
    delayMs: 0,
    logger: { log() {}, warn() {} },
    onReady: detail => ready.push(detail),
    onStatus: detail => statuses.push(detail.status),
  });
  const queue = [{ id: 1, title: 'A' }, { id: 22, title: 'B', source_url: '/b.mp3' }];
  pre.schedule({ track_id: 1 }, queue, true);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(calls, [
    ['get', 'B'],
    ['analyze', '22', '/b.mp3'],
    ['set', 'B', result],
  ]);
  assert.deepEqual(ready, [{ key: '22', name: 'B', source: 'local-analysis' }]);
  assert.deepEqual(statuses, ['analyzing', 'ready']);
});

test('a changed next item cannot begin analysis after its stale local cache lookup', async () => {
  let releaseLookup;
  const firstLookup = new Promise(resolve => { releaseLookup = resolve; });
  const analyzed = [];
  const cache = {
    keyFor(song) { return `local:${song.title}`; },
    get(song) { return song.title === 'B' ? firstLookup : Promise.resolve({ beats: [{}] }); },
    set: async () => true,
  };
  const pre = new NextTrackBeatPreAnalyzer({
    cache,
    analyzer: { analyze: async key => { analyzed.push(key); return { beats: [{}] }; } },
    delayMs: 0,
    logger: { log() {}, warn() {} },
  });
  pre.schedule({ track_id: 1 }, [{ id: 1, title: 'A' }, { id: 2, title: 'B', source_url: '/b.mp3' }], true);
  await tick();
  pre.schedule({ track_id: 1 }, [{ id: 1, title: 'A' }, { id: 3, title: 'C', source_url: '/c.mp3' }], true);
  releaseLookup(null);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(analyzed, []);
});

test('continues through every later queue item using only local cache storage', async () => {
  const calls = [];
  const pre = new NextTrackBeatPreAnalyzer({
    cache: makeCache(calls, { hitTitles: ['B'] }),
    analyzer: {
      analyze: async key => { calls.push(['analyze', key]); return { beats: [{}], gridStep: 0.5 }; },
    },
    delayMs: 0,
    logger: { log() {}, warn() {} },
  });
  pre.schedule({ track_id: 1 }, [
    { id: 1, title: 'A' },
    { id: 2, title: 'B', source_url: '/b.mp3' },
    { id: 3, title: 'C', source_url: '/c.mp3' },
    { id: 4, title: 'D', source_url: '/d.mp3' },
  ], true);
  for (let i = 0; i < 10; i++) await tick();
  assert.deepEqual(calls, [
    ['get', 'B'],
    ['get', 'C'], ['analyze', '3'], ['set', 'C', { beats: [{}], gridStep: 0.5 }],
    ['get', 'D'], ['analyze', '4'], ['set', 'D', { beats: [{}], gridStep: 0.5 }],
  ]);
});

test('an unavailable song does not block later pre-analysis', async () => {
  const analyzed = [];
  const pre = new NextTrackBeatPreAnalyzer({
    cache: makeCache([]),
    analyzer: {
      analyze: async key => { analyzed.push(key); return { beats: [{}] }; },
    },
    delayMs: 0,
    logger: { log() {}, warn() {} },
  });
  pre.schedule({ track_id: 1 }, [
    { id: 1, title: 'A' },
    { id: 2, title: 'No source' },
    { id: 3, title: 'Playable', source_url: '/playable.mp3' },
  ], true);
  for (let i = 0; i < 8; i++) await tick();
  assert.deepEqual(analyzed, ['3']);
});
