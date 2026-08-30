import { state } from './shared/StateManager.js';
import { eventBus } from './shared/EventBus.js';
import { wsClient } from './core/WsClient.js';
import { api } from './core/ApiClient.js';
import { beatEngine } from './core/BeatEngine.js';
import { beatScheduler } from './core/BeatScheduler.js';
import { audioAnalyzer } from './core/AudioAnalyzer.js';
import { VisualAudioFrameAdapter } from './core/VisualAudioFrame.js';
import { offlineBeatAnalyzer } from './core/OfflineBeatAnalyzer.js';
import { localBeatAnalysisCache } from './core/LocalBeatAnalysisCache.js';
import { resolveSongAnalysisSource } from './core/SongAudioSource.js';
import { NextTrackBeatPreAnalyzer } from './core/NextTrackBeatPreAnalyzer.js';

import { ParticleStage } from './visual/ParticleStage.js';
import { CameraDirector } from './visual/CameraDirector.js';
import { LyricStage } from './visual/LyricStage.js';
import { Shelf3D } from './visual/Shelf3D.js';

import { PlayerUI } from './player/PlayerUI.js';
import { SearchPanel } from './player/SearchPanel.js';
import { QueuePanel } from './player/QueuePanel.js';
import { LoginView } from './player/LoginView.js';
import { CookieView } from './player/CookieView.js';
import { VisualSettings } from './player/VisualSettings.js';

import { Toast } from './shared/Toast.js';
import { ConnectionBar } from './shared/ConnectionBar.js';
import { initGlassFilter } from './shared/GlassFilter.js';
import { getLyricTimelinePosition } from './shared/LyricTiming.js';

// ── Audio element for real-time beat analysis ──
// Hidden, muted — mirrors server playback to feed AudioAnalyzer.
let _analysisAudio = null;
let _lastTrackId = null;
let _preparedTrackId = null;
let _analysisReadyTrackId = null;
const visualAudioAdapter = new VisualAudioFrameAdapter(audioAnalyzer, eventBus);
const nextTrackBeatPreAnalyzer = new NextTrackBeatPreAnalyzer({
  analyzer: offlineBeatAnalyzer,
  cache: localBeatAnalysisCache,
  resolveSource: song => resolveSongAnalysisSource(song) || _buildQQMusicAudioUrl(song),
  onReady: detail => eventBus.emit('beat-analysis:ready', detail),
  onStatus: detail => eventBus.emit('beat-analysis:status', detail),
});

function _emitBeatAnalysisStatus(song, trackId, status, source = '') {
  eventBus.emit('beat-analysis:status', {
    key: String(trackId || ''),
    name: String(song?.title || song?.name || '').trim(),
    status,
    source,
  });
}

function _ensureAnalysisAudio() {
  if (_analysisAudio) return _analysisAudio;
  _analysisAudio = new Audio();
  _analysisAudio.crossOrigin = 'anonymous';
  _analysisAudio.volume = 0;   // muted — won't double with TS audio
  _analysisAudio.preload = 'auto';
  // Connect to AudioAnalyzer on first user gesture
  const _connect = () => {
    if (audioAnalyzer._connected) return;
    try {
      audioAnalyzer.connect(_analysisAudio);
      console.log('[MineraTS] AudioAnalyzer connected to analysis audio element');
    } catch (e) {
      console.warn('[MineraTS] AudioAnalyzer connect failed:', e);
    }
    document.removeEventListener('click', _connect);
    document.removeEventListener('keydown', _connect);
  };
  document.addEventListener('click', _connect);
  document.addEventListener('keydown', _connect);
  return _analysisAudio;
}

// ── Try to get audio URL for a song (for offline beat analysis) ──
// QQ Music audio URLs are constructed from song metadata.
// This is a best-effort — falls back gracefully when unavailable.
function _buildQQMusicAudioUrl(song) {
  // song_mid is the primary identifier for QQ Music tracks
  const mid = song.song_mid || song.mid || song.track_id || '';
  if (!mid) return null;

  // QQ Music song URL patterns — try common formats
  // The actual URL requires a vkey from QQ Music API, so we can't easily
  // construct one without backend support. This is a placeholder for
  // future backend integration.
  return null;
}

function _activateBeatAnalysis(trackId, result, sourceLabel) {
  if (_preparedTrackId !== trackId || !result || !Array.isArray(result.beats)
      || result.beats.length === 0) {
    return false;
  }
  beatEngine.loadBeatGrid(result.beats);
  if (result.gridStep > 0) beatEngine.setBPM(60 / result.gridStep);
  _analysisReadyTrackId = trackId;
  visualAudioAdapter.setAnalysisPending(false);
  console.log(`[MineraTS] ${sourceLabel} beat grid loaded:`,
    result.beats.length, 'beats,',
    result.gridStep > 0 ? `${(60 / result.gridStep).toFixed(1)} BPM` : 'unknown BPM');
  nextTrackBeatPreAnalyzer.schedule(state.playback.song, state.queue, true);
  return true;
}

async function _tryAnalyzeSongOffline(song, trackId) {
  if (!trackId) return false;

  let analysisReady = false;
  _emitBeatAnalysisStatus(song, trackId, 'analyzing');
  try {
    const cached = await localBeatAnalysisCache.get(song);
    if (cached?.beats?.length) {
      analysisReady = true;
      _emitBeatAnalysisStatus(song, trackId, 'ready', 'local-cache');
      if (_activateBeatAnalysis(trackId, cached, 'Local cached')) return true;
    }
    if (_preparedTrackId !== trackId) {
      if (!analysisReady) _emitBeatAnalysisStatus(song, trackId, 'idle');
      return false;
    }
  } catch (error) {
    // Local storage failure must never block analysis or playback visuals.
    console.warn('[MineraTS] Local beat cache lookup failed:', error?.message || error);
  }

  // Try to get audio URL
  const audioUrl = resolveSongAnalysisSource(song)
    || _buildQQMusicAudioUrl(song);

  if (!audioUrl) {
    // Keep the low-tide visual substitute active: without an analyzable
    // source there is no real offline grid that can safely replace it.
    if (!analysisReady) _emitBeatAnalysisStatus(song, trackId, 'idle');
    return false;
  }

  console.log('[MineraTS] Starting offline beat analysis:', trackId);
  try {
    const result = await offlineBeatAnalyzer.analyze(
      trackId, audioUrl, song.duration
    );
    if (result?.beats?.length) {
      analysisReady = true;
      _emitBeatAnalysisStatus(song, trackId, 'ready', 'local-analysis');
      try {
        await localBeatAnalysisCache.set(song, result);
      } catch (error) {
        console.warn('[MineraTS] Local beat cache write failed:', error?.message || error);
      }
    }
    const loaded = _activateBeatAnalysis(trackId, result, 'Local offline');
    if (!analysisReady) _emitBeatAnalysisStatus(song, trackId, 'idle');
    return loaded;
  } catch (error) {
    console.warn('[MineraTS] Offline beat analysis failed:', error?.message || error);
    if (!analysisReady) _emitBeatAnalysisStatus(song, trackId, 'idle');
    return false;
  }
}

// ── Try to mirror server playback in local audio element ──
async function _tryMirrorPlayback(song, trackId, position) {
  const audio = _ensureAnalysisAudio();
  const audioUrl = resolveSongAnalysisSource(song)
    || _buildQQMusicAudioUrl(song);

  if (!audioUrl) {
    // No audio URL available — beat detection falls back to grid
    return;
  }

  // Only restart if track changed
  if (trackId === _lastTrackId && !audio.paused) return;
  _lastTrackId = trackId;

  try {
    audio.src = audioUrl;
    audio.currentTime = position || 0;
    await audio.play();
    console.log('[MineraTS] Mirroring playback locally for beat analysis');
  } catch (e) {
    // Autoplay may be blocked — AudioAnalyzer will connect on next gesture
    console.warn('[MineraTS] Cannot mirror playback (autoplay?):', e.message);
  }
}

function init() {
  const particleCanvas = document.getElementById('particle-canvas');
  const playerContainer = document.getElementById('player-bar');
  const searchContainer = document.getElementById('search-overlay');
  const queueContainer = document.getElementById('queue-panel');
  const shelfContainer = document.getElementById('shelf-3d');
  const toastContainer = document.getElementById('toast-container');
  const connContainer = document.getElementById('connection-bar');
  const visSettingsContainer = document.getElementById('visual-settings-panel');

  new Toast(toastContainer);
  new ConnectionBar(connContainer);

  // SVG glass filter (RGB chromatic displacement, falls back to CSS blur)
  initGlassFilter();

  const particleStage = new ParticleStage(particleCanvas);
  const cameraDirector = new CameraDirector(particleStage.camera);

  // LyricStage inside particleGroup — rotates with the wall
  const lyricStage = new LyricStage(particleStage.particleGroup, particleStage.camera);

  const shelf3D = new Shelf3D(shelfContainer, particleStage);

  // ── Render loop — includes AudioAnalyzer tick ──
  particleStage.onFrame((dt) => {
    // Analyze first so a real-time beat can be distributed in the same frame.
    audioAnalyzer.tick(dt);
    const beatActive = state.playback.status === 'playing'
      || state.playback.status === 'started';
    const position = state.getInterpolatedPosition();
    // The pre-analysis substitute lives only in VisualAudioFrameAdapter. Do
    // not let the regular 120 BPM grid emit full-strength visual beat events
    // during this window; real FFT beats remain authoritative when available.
    if (!visualAudioAdapter.isAnalysisPending() || beatEngine.isRealtimeActive()) {
      beatScheduler.tick(position, beatActive);
    }
    visualAudioAdapter.setSectionEnergy(beatEngine.getSectionEnergyAt(position));
    visualAudioAdapter.setAnalyzedFrame(beatEngine.getAnalyzedFrameAt(position));
    particleStage.setVisualAudioFrame(visualAudioAdapter.tick(dt, beatActive));
    if (beatActive) state.syncLyrics(getLyricTimelinePosition(position));

    if (!particleStage._shelfActive) cameraDirector.tick(dt);
    lyricStage.tick(dt);
    shelf3D.tick();
  });

  const playerUI = new PlayerUI(playerContainer);
  const searchPanel = new SearchPanel(searchContainer);
  const queuePanel = new QueuePanel(queueContainer);

  const loginContainer = document.createElement('div');
  loginContainer.id = 'login-overlay-container';
  document.getElementById('app').appendChild(loginContainer);
  const loginView = new LoginView(loginContainer);
  loginView.hide();

  const cookieContainer = document.createElement('div');
  cookieContainer.id = 'cookie-overlay';
  document.getElementById('app').appendChild(cookieContainer);
  const cookieView = new CookieView(cookieContainer);

  new VisualSettings(visSettingsContainer, particleStage);

  particleStage.start();

  wsClient.connect();
  wsClient.startHeartbeat();

  // ── Song/playback changes → prepare the dynamic grid and mirror audio ──
  eventBus.on('playback:changed', (playback) => {
    const song = playback.song;
    const trackId = song && (song.track_id || song.song_mid || song.mid);
    if (trackId && trackId !== _preparedTrackId) {
      nextTrackBeatPreAnalyzer.schedule(song, state.queue, false);
      _preparedTrackId = trackId;
      _analysisReadyTrackId = null;
      beatEngine.resetRealtime();
      beatEngine.clearBeatGrid();
      audioAnalyzer.reset();
      // Arm the substitute synchronously, before the async analyzer performs
      // any fetch/decode work. It will therefore be present on the first
      // rendered frame after playback starts.
      visualAudioAdapter.setAnalysisPending(true);
      _lastTrackId = null;
      _tryAnalyzeSongOffline(song, trackId);
    }
    const active = playback.status === 'playing' || playback.status === 'started';
    if (active && trackId) {
      if (_analysisReadyTrackId !== trackId && !beatEngine.isRealtimeActive()) {
        visualAudioAdapter.setAnalysisPending(true);
      }
      _tryMirrorPlayback(song, trackId, playback.position);
    }
  });

  // ── Paused/stopped → stop local audio mirror ──
  eventBus.on('playback:paused', () => {
    if (_analysisAudio && !_analysisAudio.paused) {
      _analysisAudio.pause();
    }
  });

  eventBus.on('playback:finished', () => {
    nextTrackBeatPreAnalyzer.dispose();
    if (_analysisAudio) {
      _analysisAudio.pause();
      _analysisAudio.src = '';
    }
    beatEngine.resetRealtime();
    audioAnalyzer.reset();
    _lastTrackId = null;
    _preparedTrackId = null;
    _analysisReadyTrackId = null;
  });

  eventBus.on('queue:changed', (queue) => {
    nextTrackBeatPreAnalyzer.schedule(
      state.playback.song,
      queue,
      Boolean(_preparedTrackId && _analysisReadyTrackId === _preparedTrackId),
    );
  });

  // ── Init: fetch current status ──
  api.getStatus().then(status => {
    if (Number.isFinite(Number(status && status.volume_percent))) {
      eventBus.emit('volume:changed', Number(status.volume_percent));
    }
    if (status && status.now_playing_title) {
      state.updatePlayback({
        status: status.state === 'playing' ? 'playing' : 'paused',
        position: status.current_time || 0,
        song: {
          track_id: status.track_id,
          queue_id: status.track_id,
          title: status.now_playing_title,
          artist: status.now_playing_artist,
          album: status.now_playing_album,
          cover: status.artwork_url,
          source_url: status.now_playing_source_url,
          duration: status.duration,
          bpm: 120,
        },
        bpm: 120,
      });
    }
  }).catch(() => {});

  api.getQueue().then(data => {
    state.updateQueue(data.items || data.queue || data || []);
  }).catch(() => {});

  // ── Keyboard shortcuts ──
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      document.querySelector('[data-action="play"]')?.click();
    }
    if (e.key === 'Escape') {
      if (state.ui.searchOpen) state.toggleUI('searchOpen');
      if (state.ui.queueOpen) state.toggleUI('queueOpen');
      if (state.ui.shelfOpen) state.toggleUI('shelfOpen');
      if (state.ui.cookieOpen) state.toggleUI('cookieOpen');
      if (state.ui.visualSettingsOpen) state.toggleUI('visualSettingsOpen');
    }
  });

  eventBus.on('auth:qq_login_requested', () => loginView.show());

  console.log('[MineraTS] All modules initialized.');
  console.log('[MineraTS] Audio analysis:', audioAnalyzer._connected
    ? 'real-time (live audio)'
    : 'grid fallback (no local audio — server-side playback)');
  console.log('[MineraTS] ParticleStage camera:', particleStage.camera.position);
  console.log('[MineraTS] ShaderMaterial active, GLSL compiled');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
