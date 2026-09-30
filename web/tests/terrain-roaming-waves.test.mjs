import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleRoamingWave, sampleRoamingRegion } from '../src/visual/TerrainRoamingWaves.js';

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
      // Fine islands have shorter wavelengths; check continuity at the real
      // balanced-tier pillar spacing, independently of temporal smoothness.
      assert.ok(Math.abs(value - sampleRoamingWave(x + 0.37, 17, time)) < 0.13);
      assert.ok(Math.abs(value - sampleRoamingWave(x, 17.37, time)) < 0.11);
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

test('visible regions have filled coherent bodies and fade across the entire terrain', () => {
  for (const [x, z] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60],
    [42, 42], [-42, 42], [42, -42], [-42, -42]]) {
    const samples = Array.from({ length: 241 }, (_, i) => sampleRoamingRegion(x, z, i / 4));
    assert.ok(Math.max(...samples) > 0.95);
    assert.ok(Math.min(...samples) === 0);
  }
  let filled = 0, absent = 0, softEdges = 0;
  for (let z = -60; z <= 60; z += 2) for (let x = -60; x <= 60; x += 2) {
    const region = sampleRoamingRegion(x, z, 4);
    if (region > 0.8) filled++;
    else if (region === 0) absent++;
    else softEdges++;
    // Compact islands have steeper spatial edges, but still span several cells.
    assert.ok(Math.abs(region - sampleRoamingRegion(x + 0.37, z, 4)) < 0.40);
    assert.ok(Math.abs(region - sampleRoamingRegion(x, z, 4 + 1 / 60)) < 0.06);
  }
  assert.ok(filled > 100 && absent > 100 && softEdges > 100);
});

test('compact patches are smaller, more numerous and denser without becoming isolated dots', () => {
  const smooth = (low, high, value) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  // Previous large-patch field, kept as a fixed comparison fixture.
  const previousRegion = (x, z, time) => smooth(0.12, 0.56,
    smooth(0.15, 0.92, Math.sin(x * 0.085 + z * 0.035 - time * 0.82) * 0.5 + 0.5)
    * smooth(0.10, 0.88, Math.sin(z * 0.078 - x * 0.026 + time * 0.61) * 0.5 + 0.5)
    * (0.25 + (Math.sin(x * 0.032 - z * 0.060 + time * 0.39) * 0.5 + 0.5) * 0.75));
  const measure = field => {
    const width = 129;
    let area = 0, groups = 0;
    for (const time of [0, 2, 4, 6, 8, 10]) {
      const cells = new Set();
      for (let row = 0; row < width; row++) for (let col = 0; col < width; col++) {
        const x = col - 64, z = row - 64;
        if (Math.hypot(x, z) <= 64 && field(x, z, time) > 0.8) cells.add(row * width + col);
      }
      while (cells.size) {
        const first = cells.values().next().value, stack = [first];
        cells.delete(first);
        let size = 0;
        while (stack.length) {
          const cell = stack.pop();
          size++;
          for (const next of [cell - 1, cell + 1, cell - width, cell + width]) {
            if (Math.abs(next - cell) === 1
              && Math.floor(next / width) !== Math.floor(cell / width)) continue;
            if (cells.delete(next)) stack.push(next);
          }
        }
        if (size > 10) { area += size; groups++; }
      }
    }
    return { area, groups, meanArea: area / groups };
  };
  const previous = measure(previousRegion), compact = measure(sampleRoamingRegion);
  assert.ok(compact.meanArea / previous.meanArea > 0.09);
  assert.ok(compact.meanArea / previous.meanArea < 0.12);
  assert.ok(compact.groups / previous.groups > 9);
  assert.ok(compact.groups / previous.groups < 11);
  assert.ok(compact.area > previous.area && compact.area < previous.area * 1.2);
  assert.ok(compact.meanArea > 45, 'patch bodies must remain coherent, not isolated pillars');
});
