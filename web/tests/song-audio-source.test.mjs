import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  inheritSongAudioSource,
  resolveSongAnalysisSource,
  resolveSongAudioSource,
} from '../src/core/SongAudioSource.js';

test('audio sources remain direct and are never rewritten through the server', () => {
  assert.equal(resolveSongAudioSource({ source_url: 'https://audio.test/track.mp3' }), 'https://audio.test/track.mp3');
  assert.equal(resolveSongAudioSource({ audio_url: 'https://audio.test/legacy.mp3' }), 'https://audio.test/legacy.mp3');
  assert.equal(
    resolveSongAnalysisSource({ source_url: 'http://aqqmusic.tc.qq.com/M800abc.mp3?vkey=one' }),
    'http://aqqmusic.tc.qq.com/M800abc.mp3?vkey=one',
  );
  assert.equal(
    resolveSongAnalysisSource({ source_url: 'https://audio.test/direct.mp3' }),
    'https://audio.test/direct.mp3',
  );
});

test('sparse WebSocket songs inherit the matching stream URL only', () => {
  const previous = { track_id: 2, source_url: 'https://audio.test/current.mp3' };
  assert.equal(inheritSongAudioSource({ track_id: 2 }, previous).source_url, previous.source_url);
  assert.equal(inheritSongAudioSource({ track_id: 3 }, previous).source_url, undefined);

  const queue = [{ id: 3, track_id: 'qqmusic:abc', source_url: 'https://audio.test/queue.mp3' }];
  assert.equal(inheritSongAudioSource({ track_id: 3 }, previous, queue).source_url, queue[0].source_url);
});

test('playback uses local capture or cached analysis without full-track proxy downloads', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /source_url: status\.now_playing_source_url/);
  assert.match(main, /await localBeatAnalysisCache\.get\(song\)/);
  assert.match(main, /localAudioCapture\.active/);
  assert.match(main, /local-audio:capture-changed/);
  assert.doesNotMatch(main, /offlineBeatAnalyzer|OfflineBeatAnalyzer|resolveSongAnalysisSource/);
  assert.doesNotMatch(main, /new Audio\(|_tryMirrorPlayback|\/audio\/qq/);
  assert.match(main, /_preparedTrackId !== trackId/);
  assert.match(main, /const active = playback\.status === 'playing' \|\| playback\.status === 'started'/);
  assert.match(main, /setSectionEnergy\(beatEngine\.getSectionEnergyAt\(position\)\)/);
  assert.match(main, /visualAudioAdapter\.setAnalysisPending\(true\)/);
  assert.match(main, /visualAudioAdapter\.setAnalysisPending\(false\)/);
  assert.match(main, /_analysisReadyTrackId !== trackId && !beatEngine\.isRealtimeActive\(\)/);
  assert.match(main, /_analysisReadyTrackId = trackId;[\s\S]*setAnalysisPending\(false\)/);
  assert.match(main, /!visualAudioAdapter\.isAnalysisPending\(\) \|\| beatEngine\.isRealtimeActive\(\)/);
  assert.match(main, /beatEngine\.clearBeatGrid\(\)/);
  const nginx = await readFile(new URL('../../docker/nginx-web.conf', import.meta.url), 'utf8');
  assert.doesNotMatch(nginx, /location \/audio\/qq|aqqmusic\.tc\.qq\.com|analysis_audio_cache/);
  assert.doesNotMatch(nginx, /visual\/beat-cache/);
});
