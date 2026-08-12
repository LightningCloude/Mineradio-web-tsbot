import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  clampRippleOrigin,
  selectRippleSlots,
} from '../src/visual/ParticleWallDynamics.js';

test('active ripple slots are compacted before texture upload', () => {
  const slots = selectRippleSlots([
    { id: 'dead', age: -10, str: 0 },
    { id: 'older', age: 1.4, str: 0.8 },
    { id: 'young', age: 0.2, str: 1 },
    { id: 'expired', age: 2.1, str: 1 },
  ], 2);
  assert.deepEqual(slots.map(slot => slot.id), ['young', 'older']);
});

test('ripple origins are clamped to the visible particle plane', () => {
  assert.deepEqual(clampRippleOrigin(99, -99, 28), { x: 11.76, y: -11.76 });
});

test('particle wall retains the exact pre-remediation visual baseline', async () => {
  const source = await readFile(new URL('../src/visual/ParticleStage.js', import.meta.url), 'utf8');
  assert.match(source, /const GRID\s*= 240;\s*\/\/ 57,600 particles/);
  assert.match(source, /float drive = uMid \+ uBass \* 0\.5 \+ uBeat \* 0\.3 \+ uEnergy \* 0\.2/);
  assert.match(source, /float wave1 = snoise\(vec3\(pos\.x \* 0\.65/);
  assert.match(source, /float wave4 = sin\(pos\.x \* 2\.5/);
  assert.match(source, /vBright = \(0\.82 \+ uBass \* 0\.10 \+ uEnergy \* 0\.05\) \* uBrightMul/);
  assert.match(source, /float sz = clamp\(depthSize, 1\.05, 6\.5\)/);
  assert.match(source, /uPointScale:\s*\{ value: 2\.2 \}/);
  assert.match(source, /uBloomStrength:\s*\{ value: 0\.55 \}/);
  assert.match(source, /gl_PointSize = sz \* uPixel \* uPointScale \* 1\.2/);
  assert.match(source, /this\._dotTex\.minFilter = THREE\.NearestFilter/);
});

test('Silk morphology, adaptive density and enhanced cover material are absent', async () => {
  const source = await readFile(new URL('../src/visual/ParticleStage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /silkPos|midMask|trebleJ|bassBreath|uWallScale/);
  assert.doesNotMatch(source, /selectParticleGridSize|uPrevCoverTex|uEdgeTex|uHasDepth|uBloomSize/);
  assert.doesNotMatch(source, /bloomKeep|readableRim|_buildEdgeAndDepth/);
});

test('bug fixes preserve compact ripples, cover cancellation, pixel sync and cleanup', async () => {
  const source = await readFile(new URL('../src/visual/ParticleStage.js', import.meta.url), 'utf8');
  assert.match(source, /selectRippleSlots\(this\._ripples, this\._RIPPLE_MAX\)/);
  assert.match(source, /token !== this\._coverLoadToken \|\| url !== this\._coverUrl/);
  assert.match(source, /if \(this\._coverFadeId != null\) cancelAnimationFrame/);
  assert.match(source, /this\._uniforms\.uPixel\.value = this\.renderer\.getPixelRatio\(\)/);
  assert.match(source, /this\._disposers\.splice\(0\)\.forEach\(dispose => dispose\(\)\)/);
});

test('lyrics remain in the original rotating particle parent', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /new LyricStage\(particleStage\.particleGroup, particleStage\.camera\)/);
});
