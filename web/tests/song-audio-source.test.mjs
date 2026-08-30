import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  inheritSongAudioSource,
  resolveSongAnalysisSource,
  resolveSongAudioSource,
} from '../src/core/SongAudioSource.js';

test('QQ source_url is accepted as the primary browser analysis stream', () => {
  assert.equal(resolveSongAudioSource({ source_url: 'https://audio.test/track.mp3' }), 'https://audio.test/track.mp3');
  assert.equal(resolveSongAudioSource({ audio_url: 'https://audio.test/legacy.mp3' }), 'https://audio.test/legacy.mp3');
  assert.equal(
    resolveSongAnalysisSource({ source_url: 'http://aqqmusic.tc.qq.com/M800abc.mp3?vkey=one' }),
    '/audio/qq/M800abc.mp3?vkey=one',
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

test('initial status and playback lifecycle activate real song analysis safely', async () => {
  const main = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const analyzer = await readFile(new URL('../src/core/OfflineBeatAnalyzer.js', import.meta.url), 'utf8');
  assert.match(main, /source_url: status\.now_playing_source_url/);
  assert.match(main, /resolveSongAnalysisSource\(song\)/);
  assert.match(main, /await localBeatAnalysisCache\.get\(song\)/);
  assert.match(main, /await localBeatAnalysisCache\.set\(song, result\)/);
  assert.ok(
    main.indexOf('await localBeatAnalysisCache.get(song)')
      < main.indexOf('offlineBeatAnalyzer.analyze('),
  );
  assert.doesNotMatch(main, /api\.getBeatAnalysis|api\.storeBeatAnalysis|shared-cache/);
  assert.match(main, /_preparedTrackId !== trackId/);
  assert.match(main, /const active = playback\.status === 'playing' \|\| playback\.status === 'started'/);
  assert.ok(
    main.indexOf('_tryAnalyzeSongOffline(song, trackId);')
      < main.indexOf("const active = playback.status === 'playing' || playback.status === 'started'"),
    'offline analysis must start before the playing-only audio mirror guard',
  );
  assert.match(main, /eventBus\.on\('playback:paused',[\s\S]*?_analysisAudio\.pause\(\);[\s\S]*?\}\);/);
  assert.match(main, /setSectionEnergy\(beatEngine\.getSectionEnergyAt\(position\)\)/);
  assert.match(main, /visualAudioAdapter\.setAnalysisPending\(true\)/);
  assert.match(main, /visualAudioAdapter\.setAnalysisPending\(false\)/);
  assert.match(main, /_analysisReadyTrackId !== trackId && !beatEngine\.isRealtimeActive\(\)/);
  assert.match(main, /_analysisReadyTrackId = trackId;[\s\S]*setAnalysisPending\(false\)/);
  assert.match(main, /!visualAudioAdapter\.isAnalysisPending\(\) \|\| beatEngine\.isRealtimeActive\(\)/);
  assert.match(main, /beatEngine\.clearBeatGrid\(\)/);
  assert.doesNotMatch(analyzer, /beatEngine\.loadBeatGrid\(map\.beats\)/);
  assert.match(analyzer, /sectionEnergy: sectionRel/);
  assert.match(analyzer, /bodySum \+= x \* x/);
  const nginx = await readFile(new URL('../../docker/nginx-web.conf', import.meta.url), 'utf8');
  assert.match(nginx, /location \/audio\/qq\//);
  assert.match(nginx, /proxy_pass http:\/\/aqqmusic\.tc\.qq\.com/);
  assert.doesNotMatch(nginx, /proxy_pass \$|proxy_pass.*\$arg/);
  assert.doesNotMatch(nginx, /visual\/beat-cache/);
});
