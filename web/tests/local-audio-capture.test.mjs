import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { LocalAudioCapture } from '../src/core/LocalAudioCapture.js';

function track(kind) {
  return {
    kind,
    enabled: true,
    readyState: 'live',
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener() {},
  };
}

function streamWith({ audio = 1, video = 1 } = {}) {
  const audioTracks = Array.from({ length: audio }, () => track('audio'));
  const videoTracks = Array.from({ length: video }, () => track('video'));
  return {
    audioTracks,
    videoTracks,
    getAudioTracks: () => audioTracks,
    getVideoTracks: () => videoTracks,
    getTracks: () => [...audioTracks, ...videoTracks],
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test('system audio capture connects the stream and stops every track cleanly', async () => {
  const stream = streamWith();
  const calls = [];
  const capture = new LocalAudioCapture({
    analyzer: {
      connectStream(value) { calls.push(['connect', value]); return true; },
      async resume() { calls.push(['resume']); },
      disconnect() { calls.push(['disconnect']); },
    },
    bus: { emit(type, value) { calls.push([type, value.status]); } },
    mediaDevices: { async getDisplayMedia() { return stream; } },
    storage: memoryStorage(),
    secureContext: true,
  });

  await capture.start();
  assert.equal(capture.active, true);
  assert.equal(capture.preferred, true);
  assert.equal(stream.videoTracks[0].enabled, false);
  assert.equal(calls.some(call => call[0] === 'connect' && call[1] === stream), true);

  capture.stop('closed', { forget: true });
  assert.equal(capture.active, false);
  assert.equal(capture.preferred, false);
  assert.equal(stream.getTracks().every(item => item.stopped), true);
  assert.equal(calls.some(call => call[0] === 'disconnect'), true);
});

test('capture rejects insecure pages and shares without an audio track', async () => {
  const insecure = new LocalAudioCapture({ secureContext: false });
  await assert.rejects(() => insecure.start(), /HTTPS/);

  const silentStream = streamWith({ audio: 0 });
  const noAudio = new LocalAudioCapture({
    analyzer: { connectStream() { return true; }, disconnect() {} },
    bus: { emit() {} },
    mediaDevices: { async getDisplayMedia() { return silentStream; } },
    storage: memoryStorage(),
    secureContext: true,
  });
  await assert.rejects(() => noAudio.start(), /没有检测到系统音频/);
  assert.equal(silentStream.getTracks().every(item => item.stopped), true);
});

test('the analyzer accepts live MediaStreams without replaying captured audio', async () => {
  const analyzer = await readFile(new URL('../src/core/AudioAnalyzer.js', import.meta.url), 'utf8');
  const settings = await readFile(new URL('../src/player/VisualSettings.js', import.meta.url), 'utf8');
  assert.match(analyzer, /createMediaStreamSource\(stream\)/);
  assert.match(analyzer, /this\._silentGain\.gain\.value = 0/);
  assert.match(analyzer, /this\._hasLiveInput\(\)/);
  assert.match(settings, /启用本地音频/);
  assert.match(settings, /共享系统音频/);
  assert.match(settings, /需要使用 HTTPS/);
});
