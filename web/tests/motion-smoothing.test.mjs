import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CameraDirector } from '../src/visual/CameraDirector.js';


function makeCamera() {
  return {
    position: { x: 0, y: 0, z: 0 },
    fov: 45,
    lookAt() {},
    updateProjectionMatrix() {},
  };
}


test('camera beat depth motion eases in instead of jumping on the event frame', () => {
  const director = new CameraDirector(makeCamera());

  director._onBeat({
    type: 'accent',
    index: 8,
    strength: 1,
    snap: 1,
    mass: 1,
  });

  assert.equal(director.beatCam.punch, 0);
  const queuedKick = director._beatTarget.punch;
  assert.ok(queuedKick > 0);

  director.tick(1 / 60);
  assert.ok(director.beatCam.punch > 0);
  assert.ok(director.beatCam.punch < queuedKick);
});


test('camera beat motion is deterministic and settles back to baseline', () => {
  const first = new CameraDirector(makeCamera());
  const second = new CameraDirector(makeCamera());
  const beat = { type: 'downbeat', index: 3, strength: 0.9 };

  first._onBeat(beat);
  second._onBeat(beat);
  assert.deepEqual(first._beatTarget, second._beatTarget);

  for (let frame = 0; frame < 360; frame += 1) {
    first.tick(1 / 60);
  }

  assert.ok(Math.abs(first.beatCam.thetaKick) < 0.0001);
  assert.ok(Math.abs(first.beatCam.phiKick) < 0.0001);
  assert.ok(Math.abs(first.beatCam.radiusKick) < 0.0001);
  assert.ok(Math.abs(first.beatCam.fovOffset) < 0.0001);
});


test('camera beat response has no angular sway and keeps lyric styling intact', async () => {
  const cameraSource = await readFile(
    new URL('../src/visual/CameraDirector.js', import.meta.url),
    'utf8',
  );
  const lyricSource = await readFile(
    new URL('../src/visual/LyricStage.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(cameraSource, /Math\.random\s*\(/);
  assert.match(cameraSource, /BEAT_ATTACK_RATE/);
  const onBeatSource = cameraSource.slice(
    cameraSource.indexOf('  _onBeat(beat) {'),
    cameraSource.indexOf('  _queueBeatMotion(values) {'),
  );
  assert.doesNotMatch(onBeatSource, /thetaKick|phiKick/);
  assert.match(lyricSource, /eventBus\.on\(['"]visual:beat/);
  assert.match(lyricSource, /bloomTarget\s*=\s*0\.48\s*\+\s*this\._beatGlow\s*\*\s*3\.0/);
  assert.match(lyricSource, /glowTarget\s*=\s*0\.22\s*\+\s*this\._beatGlow\s*\*\s*1\.6/);
  assert.match(lyricSource, /Math\.min\(1,\s*this\._beatGlow\)\s*\*\s*0\.065/);
});
