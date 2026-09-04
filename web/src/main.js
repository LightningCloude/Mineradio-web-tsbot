import { state } from './shared/StateManager.js';
import { eventBus } from './shared/EventBus.js';
import { wsClient } from './core/WsClient.js';
import { api } from './core/ApiClient.js';
import { beatEngine } from './core/BeatEngine.js';
import { beatScheduler } from './core/BeatScheduler.js';
import { audioAnalyzer } from './core/AudioAnalyzer.js';
import { VisualAudioFrameAdapter } from './core/VisualAudioFrame.js';
import { localBeatAnalysisCache } from './core/LocalBeatAnalysisCache.js';
import { localAudioCapture } from './core/LocalAudioCapture.js';

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

let _preparedTrackId = null;
let _analysisReadyTrackId = null;
const visualAudioAdapter = new VisualAudioFrameAdapter(audioAnalyzer, eventBus);

function _emitBeatAnalysisStatus(song, trackId, status, source = '') {
  eventBus.emit('beat-analysis:status', {
    key: String(trackId || ''),
    name: String(song?.title || song?.name || '').trim(),
    status,
    source,
  });
}

function _activateBeatAnalysis(trackId, result, sourceLabel) {
  if (localAudioCapture.active || _preparedTrackId !== trackId
      || !result || !Array.isArray(result.beats)
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
  return true;
}

async function _tryLoadCachedBeatAnalysis(song, trackId) {
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

  // Network analysis has intentionally been retired. A cache miss stays on
  // the low-tide synthetic fallback until the user enables local audio capture.
  if (!analysisReady) _emitBeatAnalysisStatus(song, trackId, 'idle');
  return false;
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
    try {
      audioAnalyzer.tick(dt);
    } catch (error) {
      // A capture/analyser failure must never terminate the shared render loop.
      console.error('[LocalAudioCapture] Frame analysis failed:', error);
      if (localAudioCapture.active) {
        localAudioCapture.stop('本地音频分析异常，已自动关闭');
        eventBus.emit('toast', {
          message: '本地音频分析异常，已自动关闭',
          level: 'error',
        });
      }
    }
    const beatActive = state.playback.status === 'playing'
      || state.playback.status === 'started';
    const position = state.getInterpolatedPosition();
    // The pre-analysis substitute lives only in VisualAudioFrameAdapter. Do
    // not let the regular 120 BPM grid emit full-strength visual beat events
    // during this window; real FFT beats remain authoritative when available.
    if (!localAudioCapture.active
        && (!visualAudioAdapter.isAnalysisPending() || beatEngine.isRealtimeActive())) {
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

  new VisualSettings(visSettingsContainer, particleStage, localAudioCapture);

  particleStage.start();

  wsClient.connect();
  wsClient.startHeartbeat();

  // ── Song/playback changes → use local capture or an existing local grid ──
  eventBus.on('playback:changed', (playback) => {
    const song = playback.song;
    const trackId = song && (song.track_id || song.song_mid || song.mid);
    if (trackId && trackId !== _preparedTrackId) {
      _preparedTrackId = trackId;
      _analysisReadyTrackId = null;
      beatEngine.resetRealtime();
      beatEngine.clearBeatGrid();
      audioAnalyzer.reset();
      // Arm the low-tide substitute synchronously while the local cache lookup
      // runs. Network audio is never fetched for browser-side analysis.
      visualAudioAdapter.setAnalysisPending(!localAudioCapture.active);
      if (!localAudioCapture.active) _tryLoadCachedBeatAnalysis(song, trackId);
    }
    const active = playback.status === 'playing' || playback.status === 'started';
    if (active && trackId) {
      if (!localAudioCapture.active
          && _analysisReadyTrackId !== trackId && !beatEngine.isRealtimeActive()) {
        visualAudioAdapter.setAnalysisPending(true);
      }
    }
  });

  eventBus.on('playback:finished', () => {
    beatEngine.resetRealtime();
    audioAnalyzer.reset();
    _preparedTrackId = null;
    _analysisReadyTrackId = null;
  });

  eventBus.on('local-audio:capture-changed', ({ active }) => {
    beatEngine.resetRealtime();
    beatEngine.clearBeatGrid();
    audioAnalyzer.reset();
    _analysisReadyTrackId = null;
    visualAudioAdapter.setAnalysisPending(!active);
    if (!active && _preparedTrackId && state.playback.song) {
      _tryLoadCachedBeatAnalysis(state.playback.song, _preparedTrackId);
    }
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
