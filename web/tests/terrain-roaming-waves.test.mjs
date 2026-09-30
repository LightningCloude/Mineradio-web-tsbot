import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleRoamingWave } from '../src/visual/TerrainRoamingWaves.js';

test('travelling patches emerge and disappear throughout the terrain, not only at the centre', () => {
  for (const [x, z] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60],
    [42, 42], [-42, 42], [42, -42], [-42, -42]]) {
    const samples = Array.from({ length: 241 }, (_, i) => sampleRoamingWave(x, z, i / 4));
    assert.ok(Math.max(...samples) > 0.5, `never emerges at ${x}, ${z}`);
    assert.ok(Math.min(...samples) < 0.01, `never fades at ${x}, ${z}`);
    assert.ok(samples.every(value => value >= 0 && value <= 1));
  }
});

test('patches remain spatially coherent and fade smoothly rather than jumping cells', () => {
  for (let time = 0; time <= 12; time += 0.1) {
    for (let x = -60; x <= 60; x += 7) {
      const value = sampleRoamingWave(x, 17, time);
      assert.ok(Math.abs(value - sampleRoamingWave(x + 0.37, 17, time)) < 0.06);
      assert.ok(Math.abs(value - sampleRoamingWave(x, 17.37, time)) < 0.06);
      assert.ok(Math.abs(value - sampleRoamingWave(x, 17, time + 1 / 30)) < 0.04);
    }
  }
});

test('absolute-time waves remain deterministic across frame rates and slower reduced motion', () => {
  for (const hz of [30, 60, 144]) {
    assert.equal(sampleRoamingWave(13, -21, hz * 3 / hz), sampleRoamingWave(13, -21, 3));
  }
  assert.equal(sampleRoamingWave(13, -21, 10 * 0.45), sampleRoamingWave(13, -21, 4.5));
  for (const invalid of [NaN, Infinity, -Infinity, undefined]) {
    assert.equal(sampleRoamingWave(invalid, 0, 0), 0);
    assert.equal(sampleRoamingWave(0, invalid, 0), 0);
    assert.equal(sampleRoamingWave(0, 0, invalid), 0);
  }
});
