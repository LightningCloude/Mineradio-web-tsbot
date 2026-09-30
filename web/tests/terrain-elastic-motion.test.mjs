import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainElasticMotion } from '../src/visual/TerrainElasticMotion.js';
import { SonicTopographyStage } from '../src/visual/SonicTopographyStage.js';
import { BeatScheduler } from '../src/core/BeatScheduler.js';
import { BeatEngine } from '../src/core/BeatEngine.js';

const loud = Object.freeze({ active: true, source: 'realtime', energy: 1,
  subBass: 1, bass: 1, lowMid: 1, mid: 1, highMid: 1, kickEnvelope: 1 });

function advance(motion, frame, seconds, hz = 60, reduced = false) {
  for (let n = 0; n < Math.round(seconds * hz); n++) motion.update(frame, 1 / hz, reduced);
  return [...motion.values];
}

test('continuous audio alone excites delayed elastic modes with a bounded rebound', () => {
  const motion = new TerrainElasticMotion();
  const history = [];
  for (let n = 0; n < 90; n++) history.push([...motion.update(loud, 1 / 60)]);
  assert.ok(history[5][0] > history[5][1] && history[5][1] > history[5][2]);
  assert.ok(Math.max(...history.map(values => values[0])) > 1.02); // soft overshoot
  assert.ok(history.every(values => values.slice(0, 3)
    .every(v => v >= -0.12 && v <= 1.121)));
  assert.ok(history[89].slice(0, 3).every(v => Math.abs(v - 1) < 0.001));
  assert.equal(history[89][3], 0);
});

test('every trigger creates a whole-terrain compression, rise and recoil cycle', () => {
  const motion = new TerrainElasticMotion();
  motion.trigger(0.35, 0.1);
  assert.ok(motion._beatPosition < 0);
  const firstCycle = [];
  for (let n = 0; n < 55; n++) firstCycle.push(motion.update(null, 1 / 60)[3]);
  assert.ok(Math.max(...firstCycle) > 0.28);
  assert.ok(Math.min(...firstCycle) < -0.02);
  motion.trigger(0.35, 0.1);
  const secondCycle = [];
  for (let n = 0; n < 55; n++) secondCycle.push(motion.update(null, 1 / 60)[3]);
  assert.ok(Math.max(...secondCycle) > 0.28); // next beat remains visible
  assert.ok(Math.abs(secondCycle.at(-1)) < 0.025);
});

test('rapid strong beats stack safely while reduced motion remains restrained', () => {
  const normal = new TerrainElasticMotion();
  const reduced = new TerrainElasticMotion();
  for (let beat = 0; beat < 12; beat++) {
    normal.trigger(1, 1);
    reduced.trigger(1, 1, true);
    for (let frame = 0; frame < 5; frame++) {
      normal.update(loud, 1 / 60);
      reduced.update(loud, 1 / 60, true);
    }
  }
  assert.ok([...normal.values].every(Number.isFinite));
  assert.ok(normal.values[3] >= -0.42 && normal.values[3] <= 0.92);
  assert.ok(Math.abs(reduced.values[3]) < Math.abs(normal.values[3]));
});

test('the real scheduler delivers each analyzed beat once to the terrain spring', () => {
  const engine = new BeatEngine();
  const motion = new TerrainElasticMotion();
  const stage = {
    root: { visible: true }, _uniforms: { uTime: { value: 0 } },
    _responseLevel: 0.8, _reducedMotion: false, _beatPulse: 0,
    _elasticMotion: motion, _beatSequence: 0, _spawnRipple() {},
  };
  engine.loadBeatGrid(Array.from({ length: 8 }, (_, i) => ({
    time: 0.1 + i * 0.5, type: 'pulse', strength: 0.5,
    low: 0.6, sectionEnergy: 0.8,
  })));
  const received = [];
  const scheduler = new BeatScheduler(engine, {
    emit(event, beat) {
      assert.equal(event, 'visual:beat');
      received.push(beat.index);
      SonicTopographyStage.prototype.onBeat.call(stage, beat);
    },
  });
  const peaks = Array(8).fill(0);
  for (let frame = 0; frame < 246; frame++) {
    const time = frame / 60;
    stage._uniforms.uTime.value = time;
    scheduler.tick(time, true);
    const values = motion.update(loud, 1 / 60);
    if (received.length) {
      const index = received.at(-1);
      peaks[index] = Math.max(peaks[index], values[3]);
    }
  }
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peaks.every(peak => peak > 0.35));
  scheduler.tick(10, false);
  assert.equal(received.length, 8);
});

test('the per-beat oscillator has the same excursion at 30, 60 and 144 Hz', () => {
  const results = [30, 60, 144].map(hz => {
    const motion = new TerrainElasticMotion();
    motion.trigger(0.6, 0.8);
    return advance(motion, loud, 0.5, hz)[3];
  });
  for (const value of results) assert.ok(Math.abs(value - results[0]) < 1e-6);
});

test('rebound is frame-rate independent at 30, 60 and 144 Hz', () => {
  const results = [30, 60, 144].map(hz => {
    const motion = new TerrainElasticMotion();
    advance(motion, loud, 1 / 6, hz);
    return advance(motion, { ...loud, energy: 0.1, kickEnvelope: 0, bass: 0.1,
      subBass: 0.1, mid: 0.1, lowMid: 0.1, highMid: 0.1 }, 1 / 3, hz);
  });
  for (const values of results) for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(values[i] - results[0][i]) < 1e-6);
  }
});

test('paused, silent and absent audio settle smoothly even with stale section energy', () => {
  for (const frame of [null, { ...loud, active: false }, { ...loud, source: 'idle' },
    { active: true, source: 'analyzed', sectionEnergy: 1 }]) {
    const motion = new TerrainElasticMotion();
    advance(motion, loud, 1);
    const first = [...motion.update(frame, 1 / 60)];
    assert.ok(first.slice(0, 3).every(v => v > 0.9)); // no snap to zero
    assert.ok(advance(motion, frame, 3).every(v => Math.abs(v) < 1e-5));
  }
});

test('quiet passages remain alive; synthetic startup and reduced motion stay restrained', () => {
  const quiet = advance(new TerrainElasticMotion(), { ...loud,
    energy: 0.01, kickEnvelope: 0.01, subBass: 0.01, bass: 0.01,
    lowMid: 0.01, mid: 0.01, highMid: 0.01 }, 1);
  assert.ok(quiet.slice(0, 3).every(v => v > 0 && v < 0.02));
  assert.equal(quiet[3], 0);
  const fake = new TerrainElasticMotion();
  for (let n = 0; n < 180; n++) assert.ok(
    [...fake.update({ ...loud, source: 'synthetic' }, 1 / 60)].every(v => v < 0.20));
  const full = advance(new TerrainElasticMotion(), loud, 1);
  const reduced = advance(new TerrainElasticMotion(), loud, 1, 60, true);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(reduced[i] - full[i] * 0.28) < 1e-7);
});

test('elastic state is reused and remains finite through extreme input and tab gaps', () => {
  const motion = new TerrainElasticMotion();
  const buffer = motion.values;
  for (let n = 0; n < 500; n++) {
    const values = motion.update({ ...loud, kickEnvelope: n % 2 ? Infinity : NaN,
      energy: 100, bass: -20 }, [1 / 144, 0, 30, NaN, -1][n % 5]);
    assert.equal(values, buffer);
    assert.ok([...values].every(v => Number.isFinite(v) && v >= -0.121 && v <= 1.121));
  }
});

test('the real terrain update drives the shared shader buffer without discrete beat events', () => {
  const motion = new TerrainElasticMotion();
  const stage = {
    root: { visible: true, rotation: { y: 0 } }, _rotationScale: 0,
    _elasticMotion: motion, _reducedMotion: false,
    _uniforms: Object.fromEntries(['uTime', 'uClimax', 'uBeatPulse', 'uBeatLight']
      .map(key => [key, { value: 0 }])),
    _mistUniforms: { uTime: { value: 0 }, uEnergy: { value: 0 } },
    _beatPulse: 0, _beatVisual: 0, _beatLight: 0, _responseLevel: 0, _lowPresence: 0,
    _bands: Array(8).fill(0), _ripples: [], _previousSyntheticKick: 0,
    _lastSyntheticDropAt: -Infinity, _lastAnalyzedBeatAt: -Infinity,
    _nextDropAt: Infinity, _updateFloatingBlocks() {}, _updateFallingDrops() {},
  };
  stage._uniforms.uElastic = { value: motion.values };
  for (let n = 0; n < 30; n++) SonicTopographyStage.prototype.update.call(stage, 1 / 60, n / 60, loud);
  assert.equal(stage._uniforms.uElastic.value, motion.values);
  assert.ok([...stage._uniforms.uElastic.value].slice(0, 3).every(v => v > 0.95));
  assert.equal(stage._uniforms.uElastic.value[3], 0);
  assert.equal(stage._uniforms.uBeatPulse.value, 0);
  const previous = [...motion.values];
  stage.root.visible = false;
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 1, null);
  assert.deepEqual([...motion.values], previous); // hidden preset does no work
  stage._drops = [];
  SonicTopographyStage.prototype.setVisible.call(stage, false);
  assert.deepEqual([...motion.values], [0, 0, 0, 0]);
  stage.root.visible = true;
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 2, loud);
  assert.ok(motion.values[0] > 0 && motion.values[0] < 0.04); // soft re-entry
});
