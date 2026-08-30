import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';

/**
 * Bottom playback control bar: play/pause, skip, progress bar, song info.
 * Fixed position at bottom of viewport.
 */
export class PlayerUI {
  constructor(container) {
    this.container = container;
    this._buildDOM();
    eventBus.on('playback:changed', (pb) => this._onPlaybackChanged(pb));
    eventBus.on('volume:changed', (volume) => this._setVolumeDisplay(volume));
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="player-bar">
        <div class="player-info">
          <img class="player-cover" src="" alt="" />
          <div class="player-meta">
            <div class="player-title">等待播放...</div>
            <div class="player-artist"></div>
          </div>
        </div>
        <div class="player-controls">
          <button class="ctrl-btn" data-action="prev">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="17" y="4" width="4" height="16" rx="1"/><path d="M15 5v14l-11-7z"/></svg>
          </button>
          <button class="ctrl-btn ctrl-play" data-action="play">
            <svg class="svg-icon-play svg-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            <svg class="svg-icon-play svg-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>
          </button>
          <button class="ctrl-btn" data-action="skip">
            <svg class="svg-icon" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="4" height="16" rx="1"/><path d="M9 5v14l11-7z"/></svg>
          </button>
        </div>
        <div class="player-progress-wrap">
          <span class="player-time current">00:00</span>
          <div class="player-progress-bar">
            <div class="player-progress-fill"></div>
          </div>
          <span class="player-time total">00:00</span>
        </div>
        <div class="right-tools">
          <button class="ctrl-btn" data-action="search"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg></button>
          <button class="ctrl-btn" data-action="queue"><svg class="svg-icon" viewBox="0 0 24 24" fill="currentColor" opacity="0.8"><rect x="3" y="4" width="18" height="2" rx="1"/><rect x="3" y="11" width="18" height="2" rx="1"/><rect x="3" y="18" width="18" height="2" rx="1"/></svg></button>
          <button class="ctrl-btn" data-action="cookie" data-icon="credentials" title="QQ 音乐登录凭据" aria-label="QQ 音乐登录凭据"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 8-8 2 2-2 2 1.5 1.5-2 2L16 10l-4 4"/></svg></button>
          <button class="ctrl-btn" data-action="vis-settings" data-icon="visual-tuning" title="视觉设置" aria-label="视觉设置"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h4m4 0h8M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg></button>
          <button class="ctrl-btn" data-action="shelf"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M9 21V9"/></svg></button>
          <button class="ctrl-btn" data-action="immersive" title="沉浸模式"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg></button>
        <button class="ctrl-btn" data-action="clear-queue" title="清除播放队列"><svg class="svg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
        <div class="player-volume">
          <svg class="svg-icon-small" viewBox="0 0 24 24" fill="currentColor" opacity="0.7"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
          <input type="range" class="volume-slider" min="0" max="200" value="10" data-action="volume" />
          <span class="volume-label">10</span>
        </div>
      </div>
    `;

    this.container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'play') this._togglePlay();
      if (action === 'skip') api.skip().catch(() => {});
      if (action === 'prev') { /* not implemented */ }
      if (action === 'search') state.toggleUI('searchOpen');
      if (action === 'queue') state.toggleUI('queueOpen');
      if (action === 'cookie') state.toggleUI('cookieOpen');
      if (action === 'vis-settings') state.toggleUI('visualSettingsOpen');
      if (action === 'shelf') state.toggleUI('shelfOpen');
      if (action === 'immersive') this._toggleImmersive();
      if (action === 'clear-queue') this._clearQueue();
    });

    // Volume slider
    const volSlider = this.container.querySelector('.volume-slider');
    const volLabel = this.container.querySelector('.volume-label');
    let volTimer;
    volSlider.addEventListener('input', () => {
      const v = parseInt(volSlider.value);
      volLabel.textContent = v;
      clearTimeout(volTimer);
      volTimer = setTimeout(() => api.setVolume(v).catch(() => {}), 200);
    });

    // ── Fullscreen exit via Esc → exit immersive mode ──
    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement) {
        document.documentElement.classList.remove('immersive-mode');
      }
    });
  }

  _setVolumeDisplay(volume) {
    const value = Math.max(0, Math.min(200, Number(volume) || 0));
    const slider = this.container.querySelector('.volume-slider');
    const label = this.container.querySelector('.volume-label');
    if (slider) slider.value = String(value);
    if (label) label.textContent = String(value);
  }

  _onPlaybackChanged(pb) {
    this._lastStatus = pb.status;
    const title = this.container.querySelector('.player-title');
    const artist = this.container.querySelector('.player-artist');
    const cover = this.container.querySelector('.player-cover');
    const playBtn = this.container.querySelector('[data-action="play"]');
    const progress = this.container.querySelector('.player-progress-fill');
    const currentTime = this.container.querySelector('.player-time.current');
    const totalTime = this.container.querySelector('.player-time.total');

    if (pb.song) {
      title.textContent = pb.song.title || '未知歌曲';
      artist.textContent = pb.song.artist || '';
      if (pb.song.cover && cover.dataset.source !== pb.song.cover) {
        cover.dataset.source = pb.song.cover;
        cover.src = resolveCoverUrl(pb.song.cover);
      }
      totalTime.textContent = this._fmt(pb.song.duration || 0);
    }

    const isPlaying = pb.status === 'playing' || pb.status === 'started';
    const playSvg = this.container.querySelector('.svg-play');
    const pauseSvg = this.container.querySelector('.svg-pause');
    if (playSvg) playSvg.style.display = isPlaying ? 'none' : 'block';
    if (pauseSvg) pauseSvg.style.display = isPlaying ? 'block' : 'none';

    if (pb.position !== undefined && pb.song && pb.song.duration) {
      const pct = Math.min((pb.position / pb.song.duration) * 100, 100);
      progress.style.width = `${pct}%`;
      currentTime.textContent = this._fmt(pb.position);
    }
  }

  _togglePlay() {
    const playing = this._lastStatus === 'playing' || this._lastStatus === 'started';
    const action = playing ? 'pause' : 'play';
    api.playerAction(action).then(() => {
      if (playing) state.updatePlayback({ status: 'paused' });
    }).catch(() => {});
  }

  async _clearQueue() {
    const queue = state.queue;
    if (!queue || !queue.length) return;
    if (!confirm(`Clear all ${queue.length} songs from the queue?`)) return;
    try {
      // Remove each item by its database ID (reverse order to avoid index shifts)
      for (let i = queue.length - 1; i >= 0; i--) {
        const itemId = queue[i].id;
        if (itemId != null) await api.removeFromQueue(itemId);
      }
      state.updateQueue([]);
      eventBus.emit('toast', { message: 'Queue cleared', level: 'success' });
    } catch (e) {
      eventBus.emit('toast', { message: 'Failed to clear queue', level: 'error' });
    }
  }

  _toggleImmersive() {
    const html = document.documentElement;
    if (html.classList.contains('immersive-mode')) {
      html.classList.remove('immersive-mode');
      if (document.fullscreenElement) document.exitFullscreen();
    } else {
      html.classList.add('immersive-mode');
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }

  _fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
}
