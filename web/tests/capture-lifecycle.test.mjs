import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAudioCapture } from '../src/core/LocalAudioCapture.js';

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function stream() {
  const tracks = ['audio', 'video'].map(kind => ({ kind, enabled: true, stopped: false,
    stop() { this.stopped = true; }, addEventListener() {} }));
  return { getTracks: () => tracks, getAudioTracks: () => [tracks[0]], getVideoTracks: () => [tracks[1]] };
}

test('stopping while the share chooser is pending releases late streams and never activates capture', async () => {
  const chooser = deferred();
  const share = stream();
  let connected = false;
  const capture = new LocalAudioCapture({ secureContext: true, storage: null, bus: { emit() {} },
    mediaDevices: { getDisplayMedia: () => chooser.promise }, analyzer: {
      async prepare() {}, connectStream() { connected = true; return true; },
      async resume() { return true; }, disconnect() {},
    } });
  const pending = capture.start();
  await Promise.resolve();
  capture.stop();
  chooser.resolve(share);
  await pending;
  assert.equal(capture.active, false);
  assert.equal(connected, false);
  assert.equal(share.getTracks().every(track => track.stopped), true);
});

test('stopping during AudioContext resume disconnects the input and rejects late activation', async () => {
  const resume = deferred();
  const enteredResume = deferred();
  const share = stream();
  let disconnected = 0;
  const capture = new LocalAudioCapture({ secureContext: true, storage: null, bus: { emit() {} },
    mediaDevices: { getDisplayMedia: async () => share }, analyzer: {
      async prepare() {}, connectStream() { return true; },
      resume() { enteredResume.resolve(); return resume.promise; },
      disconnect() { disconnected += 1; },
    } });
  const pending = capture.start();
  await enteredResume.promise;
  capture.stop();
  resume.resolve(true);
  await pending;
  assert.equal(capture.active, false);
  assert.equal(capture.stream, null);
  assert.equal(disconnected, 1);
  assert.equal(share.getTracks().every(track => track.stopped), true);
});

test('a rejected AudioContext resume cleans up both the stream and analyser', async () => {
  const share = stream();
  let disconnected = false;
  const capture = new LocalAudioCapture({ secureContext: true, storage: null, bus: { emit() {} },
    mediaDevices: { getDisplayMedia: async () => share }, analyzer: {
      async prepare() {}, connectStream() { return true; },
      async resume() { throw new Error('resume failed'); },
      disconnect() { disconnected = true; },
    } });
  await assert.rejects(capture.start(), /resume failed/);
  assert.equal(capture.active, false);
  assert.equal(capture.stream, null);
  assert.equal(disconnected, true);
  assert.equal(share.getTracks().every(track => track.stopped), true);
});
