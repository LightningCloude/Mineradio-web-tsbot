import assert from 'node:assert/strict';
import test from 'node:test';

import { VisualAudioFrameAdapter } from '../src/core/VisualAudioFrame.js';

const REALTIME_FRAME = Object.freeze({
  source: 'realtime',
  subBass: 0.9,
  bass: 0.8,
  lowMid: 0.7,
  mid: 0.6,
  highMid: 0.5,
  presence: 0.4,
  brilliance: 0.3,
  air: 0.2,
  kickEnvelope: 0.85,
  energy: 0.65,
  sharpness: 0.45,
});

test('prefers a recent real FFT frame and exposes an immutable result', () => {
  const adapter = new VisualAudioFrameAdapter({ getVisualFrame: () => REALTIME_FRAME });
  let frame;
  for (let i = 0; i < 90; i++) frame = adapter.tick(1 / 60, true);

  assert.equal(frame.source, 'realtime');
  assert.equal(frame.active, true);
  assert.ok(frame.subBass > 0.88);
  assert.ok(frame.air > 0.19);
  assert.ok(Object.isFrozen(frame));
});

test('synthetic fallback is deterministic and remains inside normalized bounds', () => {
  const first = new VisualAudioFrameAdapter();
  const second = new VisualAudioFrameAdapter();
  const beat = { type: 'downbeat', strength: 0.92, low: 0.88, body: 0.54, snap: 0.36 };
  first.acceptBeat(beat);
  second.acceptBeat(beat);

  let a, b;
  for (let i = 0; i < 120; i++) {
    a = first.tick(1 / 60, true);
    b = second.tick(1 / 60, true);
  }
  assert.deepEqual(a, b);
  assert.equal(a.source, 'synthetic');
  for (const value of Object.values(a).filter(value => typeof value === 'number')) {
    assert.ok(value >= 0 && value <= 1);
  }
});

test('offline section energy sustains a stronger mid-range chorus response', () => {
  const quiet = new VisualAudioFrameAdapter();
  const chorus = new VisualAudioFrameAdapter();
  const beat = { type: 'push', strength: 0.3, low: 0.35, body: 0.2, snap: 0.08 };
  quiet.acceptBeat({ ...beat, sectionEnergy: 0.05 });
  chorus.acceptBeat({ ...beat, sectionEnergy: 0.9 });

  let quietFrame, chorusFrame;
  for (let i = 0; i < 12; i++) {
    quietFrame = quiet.tick(1 / 60, true);
    chorusFrame = chorus.tick(1 / 60, true);
  }
  assert.ok(chorusFrame.mid > quietFrame.mid + 0.30);
  assert.ok(chorusFrame.energy > quietFrame.energy + 0.30);
});

test('pre-analysis substitute remains a deterministic low-tide-only pulse', () => {
  const first = new VisualAudioFrameAdapter();
  const second = new VisualAudioFrameAdapter();
  first.setAnalysisPending(true);
  second.setAnalysisPending(true);

  let a, b;
  let peakLow = 0;
  let peakMid = 0;
  let peakEnergy = 0;
  for (let i = 0; i < 240; i++) {
    a = first.tick(1 / 60, true);
    b = second.tick(1 / 60, true);
    peakLow = Math.max(peakLow, a.subBass, a.bass);
    peakMid = Math.max(peakMid, a.mid, a.highMid);
    peakEnergy = Math.max(peakEnergy, a.energy);
  }

  assert.deepEqual(a, b);
  assert.equal(a.source, 'synthetic');
  assert.equal(a.sectionEnergy, 0);
  assert.ok(peakLow > 0.035 && peakLow < 0.08);
  assert.ok(peakMid < 0.005);
  assert.ok(peakEnergy < 0.09);
  assert.equal(a.sharpness, 0);
});

test('real FFT bypasses the pending-analysis substitute and reset clears it', () => {
  const adapter = new VisualAudioFrameAdapter({ getVisualFrame: () => REALTIME_FRAME });
  adapter.setAnalysisPending(true);
  const realtime = adapter.tick(1 / 60, true);
  assert.equal(realtime.source, 'realtime');
  adapter.reset();
  assert.equal(adapter.isAnalysisPending(), false);
});

test('analyzed frame replaces synthetic drift after the offline grid is ready', () => {
  const adapter = new VisualAudioFrameAdapter(null, null);
  adapter.setAnalysisPending(false);
  adapter.setAnalyzedFrame({
    source: 'analyzed', subBass: 0.31, bass: 0.28, lowMid: 0.24, mid: 0.42,
    highMid: 0.18, presence: 0.12, brilliance: 0.09, air: 0.05,
    kickEnvelope: 0.36, energy: 0.48, sharpness: 0.11, sectionEnergy: 0.40,
  });
  const frame = adapter.tick(0.1, true);
  assert.equal(frame.source, 'analyzed');
  assert.ok(frame.mid > frame.presence);
  assert.ok(frame.energy > 0.1);
});

test('inactive playback decays smoothly to idle instead of snapping to zero', () => {
  const adapter = new VisualAudioFrameAdapter();
  adapter.acceptBeat({ type: 'drop', strength: 1, low: 1, body: 0.7, snap: 0.4 });
  const active = adapter.tick(1 / 60, true);
  const firstIdle = adapter.tick(1 / 60, false);
  assert.equal(firstIdle.source, 'idle');
  assert.equal(firstIdle.active, false);
  assert.ok(firstIdle.subBass > 0);
  assert.ok(firstIdle.subBass < active.subBass);

  let settled = firstIdle;
  for (let i = 0; i < 420; i++) settled = adapter.tick(1 / 60, false);
  assert.ok(settled.subBass < 0.0001);
  assert.ok(settled.kickEnvelope < 0.0001);
});

test('malformed realtime values are clamped before reaching shaders', () => {
  const adapter = new VisualAudioFrameAdapter({
    getVisualFrame: () => ({ ...REALTIME_FRAME, subBass: 8, bass: -2, energy: Infinity }),
  });
  let frame;
  for (let i = 0; i < 180; i++) frame = adapter.tick(1 / 60, true);
  assert.ok(frame.subBass <= 1);
  assert.ok(frame.bass >= 0);
  assert.ok(frame.energy >= 0 && frame.energy <= 1);
});
