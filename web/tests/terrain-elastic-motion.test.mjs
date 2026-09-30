import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainElasticMotion } from '../src/visual/TerrainElasticMotion.js';
import { SonicTopographyStage } from '../src/visual/SonicTopographyStage.js';
import { BeatScheduler } from '../src/core/BeatScheduler.js';
import { BeatEngine } from '../src/core/BeatEngine.js';
import { Group, Object3D, PerspectiveCamera, Vector3 } from 'three';

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
  assert.deepEqual([...motion.offset], [0, 0, 0]);
});

test('each beat causes a small 3D displacement and damped recoil without a position jump', () => {
  const motion = new TerrainElasticMotion();
  motion.trigger(0.35, 0.1);
  assert.deepEqual([...motion.offset], [0, 0, 0]);
  const firstCycle = [];
  for (let n = 0; n < 55; n++) {
    motion.update(null, 1 / 60);
    firstCycle.push([...motion.offset]);
  }
  for (let axis = 0; axis < 3; axis++) {
    const values = firstCycle.map(v => v[axis]);
    assert.ok(Math.max(...values) > 0.02 && Math.min(...values) < -0.02);
  }
  assert.ok(Math.max(...firstCycle.map(v => Math.hypot(...v))) > 0.55);
  motion.trigger(0.35, 0.1);
  const secondCycle = [];
  for (let n = 0; n < 55; n++) {
    motion.update(null, 1 / 60);
    secondCycle.push([...motion.offset]);
  }
  assert.ok(Math.max(...secondCycle.map(v => Math.hypot(...v))) > 0.55);
  assert.ok(Math.hypot(...secondCycle.at(-1)) < 0.005);
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
      assert.ok(Math.abs(normal.offset[0]) <= 1.551 && Math.abs(normal.offset[1]) <= 1.051
        && Math.abs(normal.offset[2]) <= 1.451);
      assert.ok(Math.hypot(...normal.offset) < 2.37);
    }
  }
  assert.ok([...normal.values].every(Number.isFinite));
  assert.ok(Math.hypot(...reduced.offset) < Math.hypot(...normal.offset));
});

test('an ordinary beat visibly moves the distant terrain without shaking its camera', () => {
  const motion = new TerrainElasticMotion();
  const camera = new PerspectiveCamera(48, 1440 / 900, 0.1, 500);
  camera.position.set(0, 54, 112);
  camera.lookAt(0, -8, -18);
  camera.updateMatrixWorld(true);
  const origin = new Vector3(0, -6.2, -18);
  const rest = origin.clone().project(camera);
  motion.trigger(0.65, 0.8);
  let peakPixels = 0;
  for (let frame = 0; frame < 60; frame++) {
    motion.update(null, 1 / 60);
    const displaced = origin.clone().add(new Vector3(...motion.offset)).project(camera);
    peakPixels = Math.max(peakPixels, Math.hypot(
      (displaced.x - rest.x) * 720, (displaced.y - rest.y) * 450));
  }
  assert.ok(peakPixels > 5 && peakPixels < 12, `excursion: ${peakPixels}px`);
  assert.deepEqual(camera.position.toArray(), [0, 54, 112]);
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
    motion.update(loud, 1 / 60);
    if (received.length) {
      const index = received.at(-1);
      peaks[index] = Math.max(peaks[index], Math.hypot(...motion.offset));
    }
  }
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peaks.every(peak => peak > 0.65));
  scheduler.tick(10, false);
  assert.equal(received.length, 8);
});

test('the per-beat oscillator has the same excursion at 30, 60 and 144 Hz', () => {
  const results = [30, 60, 144].map(hz => {
    const motion = new TerrainElasticMotion();
    motion.trigger(0.6, 0.8);
    advance(motion, loud, 0.5, hz);
    return [...motion.offset];
  });
  for (const values of results) for (let axis = 0; axis < 3; axis++) {
    assert.ok(Math.abs(values[axis] - results[0][axis]) < 1e-6);
  }
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
    motion.trigger(0.8, 0.8);
    advance(motion, loud, 0.1);
    assert.ok(Math.hypot(...motion.offset) > 0.05);
    const first = [...motion.update(frame, 1 / 60)];
    assert.ok(first.slice(0, 3).every(v => v > 0.9)); // no snap to zero
    assert.ok(advance(motion, frame, 3).every(v => Math.abs(v) < 1e-5));
    assert.ok(Math.hypot(...motion.offset) < 1e-5);
  }
});

test('quiet passages remain alive; synthetic startup and reduced motion stay restrained', () => {
  const quiet = advance(new TerrainElasticMotion(), { ...loud,
    energy: 0.01, kickEnvelope: 0.01, subBass: 0.01, bass: 0.01,
    lowMid: 0.01, mid: 0.01, highMid: 0.01 }, 1);
  assert.ok(quiet.slice(0, 3).every(v => v > 0 && v < 0.02));
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
    root: new Group(), _rotationScale: 0,
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
  assert.deepEqual([...motion.offset], [0, 0, 0]);
  assert.equal(stage._uniforms.uBeatPulse.value, 0);
  const previous = [...motion.values];
  stage.root.visible = false;
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 1, null);
  assert.deepEqual([...motion.values], previous); // hidden preset does no work
  stage._drops = [];
  SonicTopographyStage.prototype.setVisible.call(stage, false);
  assert.deepEqual([...motion.values], [0, 0, 0]);
  assert.deepEqual(stage.root.position.toArray(), [0, -6.2, -18]);
  stage.root.visible = true;
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 2, loud);
  assert.ok(motion.values[0] > 0 && motion.values[0] < 0.04); // soft re-entry
});

test('terrain update displaces centre and edge equally and leaves camera, scale and heights alone', () => {
  const motion = new TerrainElasticMotion();
  const root = new Group();
  root.position.set(0, -6.2, -18);
  const centre = new Object3D();
  const edge = new Object3D();
  edge.position.set(65, 20, -40);
  root.add(centre, edge);
  const camera = new PerspectiveCamera();
  camera.position.set(0, 54, 112);
  const stage = {
    root, camera, _rotationScale: 0, _elasticMotion: motion, _reducedMotion: false,
    _uniforms: Object.fromEntries(['uTime', 'uClimax', 'uBeatPulse', 'uBeatLight']
      .map(key => [key, { value: 0 }])),
    _mistUniforms: { uTime: { value: 0 }, uEnergy: { value: 0 } },
    _beatPulse: 0, _beatVisual: 0, _beatLight: 0, _responseLevel: 0.8, _lowPresence: 0,
    _beatSequence: 0, _spawnRipple() {},
    _bands: Array(8).fill(0), _ripples: [], _previousSyntheticKick: 0,
    _lastSyntheticDropAt: -Infinity, _lastAnalyzedBeatAt: -Infinity,
    _nextDropAt: Infinity, _updateFloatingBlocks() {}, _updateFallingDrops() {},
  };
  root.updateMatrixWorld(true);
  const beforeCentre = centre.getWorldPosition(centre.position.clone());
  const beforeEdge = edge.getWorldPosition(edge.position.clone());
  SonicTopographyStage.prototype.onBeat.call(stage, { strength: 0.8, low: 0.9 });
  assert.deepEqual(root.position.toArray(), [0, -6.2, -18]); // trigger never snaps
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 1 / 60, loud);
  root.updateMatrixWorld(true);
  const centreDelta = centre.getWorldPosition(centre.position.clone()).sub(beforeCentre);
  const edgeDelta = edge.getWorldPosition(edge.position.clone()).sub(beforeEdge);
  assert.ok(centreDelta.length() > 0.1 && centreDelta.length() < 1);
  assert.ok(centreDelta.distanceTo(edgeDelta) < 1e-12);
  assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
  assert.deepEqual(edge.position.toArray(), [65, 20, -40]);
  assert.deepEqual(camera.position.toArray(), [0, 54, 112]);
  advance(motion, null, 3);
  SonicTopographyStage.prototype.update.call(stage, 1 / 60, 3, null);
  assert.ok(root.position.distanceTo(beforeCentre) < 1e-5);
});
