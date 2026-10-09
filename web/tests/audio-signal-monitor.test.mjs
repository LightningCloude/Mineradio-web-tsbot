import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioSignalMonitor, describeAudioSignal } from '../src/core/AudioSignalMonitor.js';

test('diagnostics are rate limited and warn only after sustained silence', () => {
  const events = [];
  const monitor = new AudioSignalMonitor({ emit: (_, value) => events.push(value) });
  const input = { captureActive: true, input: { rms: 0, running: true, live: true } };
  for (let i = 0; i < 300; i++) monitor.tick(1 / 60, input);
  assert.ok(events.length <= 20);
  for (let i = 0; i < 16; i++) monitor.tick(1 / 60, input);
  assert.equal(events.at(-1).silent, true);
  assert.match(describeAudioSignal(events.at(-1)), /扬声器/);
  monitor.tick(0.25, { ...input, input: { rms: 0.08, running: true, live: true } });
  assert.equal(events.at(-1).silent, false);
  assert.equal(events.at(-1).audible, true);
});

test('disconnected/suspended/stale inputs cannot be presented as audible', () => {
  const monitor = new AudioSignalMonitor({ emit() {} });
  const result = monitor.tick(0.25, { captureActive: true, input: { rms: 0.8, live: true, running: false } });
  assert.equal(result.audible, false);
  assert.match(describeAudioSignal(result), /暂停/);
  assert.match(describeAudioSignal({ source: 'synthetic' }), /非实时/);
  assert.match(describeAudioSignal({ source: 'analyzed' }), /本地节拍缓存/);
  assert.match(describeAudioSignal({ source: 'idle' }), /空闲/);
});
