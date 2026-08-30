import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { BeatScheduler } from '../src/core/BeatScheduler.js';
import { BeatEngine } from '../src/core/BeatEngine.js';


test('queries the beat engine once and broadcasts one immutable beat', () => {
  let queryCount = 0;
  const emitted = [];
  const sourceBeat = { index: 4, type: 'drop', intensity: 0.85 };
  const scheduler = new BeatScheduler(
    {
      getBeatAtWithGrid(position) {
        queryCount += 1;
        assert.equal(position, 12.5);
        return sourceBeat;
      },
    },
    {
      emit(event, payload) {
        emitted.push({ event, payload });
      },
    },
  );

  const result = scheduler.tick(12.5, true);

  assert.equal(queryCount, 1);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'visual:beat');
  assert.equal(emitted[0].payload, result);
  assert.equal(result.position, 12.5);
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(sourceBeat, { index: 4, type: 'drop', intensity: 0.85 });
});


test('does not advance the beat engine while playback is inactive', () => {
  const scheduler = new BeatScheduler(
    {
      getBeatAtWithGrid() {
        assert.fail('inactive scheduler must not query the engine');
      },
    },
    { emit() {} },
  );

  assert.equal(scheduler.tick(12.5, false), null);
});

test('custom offline beats preserve spectral and section energy fields', () => {
  const engine = new BeatEngine();
  engine.loadBeatGrid([{
    time: 1,
    type: 'drop',
    intensity: 0.72,
    strength: 0.72,
    low: 0.81,
    body: 0.64,
    snap: 0.22,
    sectionEnergy: 0.93,
  }]);
  const beat = engine.getBeatAtWithGrid(1.1);
  assert.equal(beat.low, 0.81);
  assert.equal(beat.body, 0.64);
  assert.equal(beat.sectionEnergy, 0.93);
  assert.equal(beat.offline, true);
  assert.equal(engine.getSectionEnergyAt(1.2), 0.93);
  engine.clearBeatGrid();
  assert.equal(engine.getSectionEnergyAt(1.2), 0);
});

test('offline grid exposes a continuous analyzed visual frame', () => {
  const engine = new BeatEngine();
  engine.loadBeatGrid([
    { time: 0, strength: 0.8, low: 0.9, body: 0.5, snap: 0.2, impact: 0.85, sectionEnergy: 0.7 },
    { time: 0.5, strength: 0.5, low: 0.5, body: 0.6, snap: 0.3, impact: 0.5, sectionEnergy: 0.6 },
  ]);
  const frame = engine.getAnalyzedFrameAt(0.08);
  assert.equal(frame.source, 'analyzed');
  assert.ok(frame.subBass > frame.air);
  assert.ok(frame.energy >= frame.sectionEnergy * 0.7);
  assert.equal(engine.hasAnalyzedGrid(), true);
});


test('visual consumers no longer query the stateful BeatEngine directly', async () => {
  const files = [
    '../src/visual/ParticleStage.js',
    '../src/visual/CameraDirector.js',
    '../src/visual/LyricStage.js',
  ];

  for (const relativePath of files) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /getBeatAt(?:WithGrid)?\s*\(/);
    assert.match(source, /visual:beat/);
  }
});


test('loading the player does not overwrite server volume', async () => {
  const source = await readFile(
    new URL('../src/player/PlayerUI.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /api\.setVolume\(\s*10\s*\)/);
  assert.match(source, /volume:changed/);
});
