import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { lyricColorManager, LYRIC_COLOR_PRESETS } from '../shared/LyricColorManager.js';
import {
  LYRIC_DISPLAY_MODES,
  lyricTranslationManager,
} from '../shared/LyricTranslationManager.js';
import {
  clearLocalWallpaper,
  formatWallpaperSize,
  loadLocalWallpaper,
  requestPersistentStorage,
  saveLocalWallpaper,
} from '../core/LocalWallpaperStore.js';
import {
  loadVisualPreset,
  normalizeVisualPreset,
  saveVisualPreset,
} from './VisualPresetStore.js';

/** Visual tweaks panel — particle intensity, rotation, lyric color, etc. */
export class VisualSettings {
  constructor(container, particleStage, localAudioCapture = null) {
    this.container = container;
    this._stage = particleStage;
    this._localAudioCapture = localAudioCapture;
    this._bgBlobUrl = null;
    this._bgHasVideo = false;
    this._releaseBgBlobUrl = this._releaseBgBlobUrl.bind(this);
    this._buildDOM();
    window.addEventListener('beforeunload', this._releaseBgBlobUrl, { once: true });
    eventBus.on('ui:changed', (ui) => {
      this.container.style.display = ui.visualSettingsOpen ? 'flex' : 'none';
    });
    eventBus.on('lyric:colorChanged', () => this._refreshColorGrid());
    eventBus.on('lyric:translationChanged', () => this._refreshTranslationMode());
    eventBus.on('local-audio:capture-changed', (snapshot) => {
      this._refreshLocalAudioCapture(snapshot);
    });
    this._restorePreset();
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="vis-settings-backdrop"></div>
      <div class="vis-settings-panel">
        <div class="vis-settings-header">
          <span class="vis-settings-title">视觉设置</span>
          <button class="vis-settings-close">✕</button>
        </div>
        <div class="vis-settings-body">
          <div class="vis-slider-group">
            <label class="vis-slider-label">粒子律动幅度 <span class="vis-slider-val" data-key="intensity">1.2</span></label>
            <input type="range" class="vis-slider" data-key="intensity" min="0.2" max="3.0" step="0.05" value="1.2" />
          </div>
          <div class="vis-slider-group">
            <label class="vis-slider-label">粒子亮度 <span class="vis-slider-val" data-key="brightness">1.0</span></label>
            <input type="range" class="vis-slider" data-key="brightness" min="0.3" max="2.5" step="0.05" value="1.0" />
          </div>
          <div class="vis-slider-group">
            <label class="vis-slider-label">粒子大小 <span class="vis-slider-val" data-key="pointScale">2.2</span></label>
            <input type="range" class="vis-slider" data-key="pointScale" min="0.5" max="5.0" step="0.05" value="2.2" />
          </div>
          <div class="vis-slider-group">
            <label class="vis-slider-label">Bloom 发光 <span class="vis-slider-val" data-key="bloom">0.55</span></label>
            <input type="range" class="vis-slider" data-key="bloom" min="0" max="1.5" step="0.01" value="0.55" />
          </div>
          <div class="vis-slider-group">
            <label class="vis-slider-label">旋转幅度 <span class="vis-slider-val" data-key="rotation">1.0</span></label>
            <input type="range" class="vis-slider" data-key="rotation" min="0" max="3.0" step="0.05" value="1.0" />
          </div>

          <!-- ── Local system audio ── -->
          <div class="vis-section-label">音频响应</div>
          <div class="vis-local-audio-row">
            <button type="button" class="vis-bg-btn" id="local-audio-capture-btn">
              启用本地音频
            </button>
            <span class="vis-local-audio-indicator" id="local-audio-indicator"></span>
          </div>
          <div class="vis-local-audio-status" id="local-audio-capture-status" aria-live="polite"></div>
          <div class="vis-local-audio-help">
            选择整个屏幕并勾选“共享系统音频”。启用后直接分析本机听到的 TeamSpeak 音频，不再下载歌曲进行分析。
          </div>

          <!-- ── Background ── -->
          <div class="vis-section-label">背景</div>
          <div class="vis-bg-row">
            <input type="file" id="bg-video-file" accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov" hidden />
            <button type="button" class="vis-bg-btn" id="bg-video-pick">选择本地视频</button>
            <label class="vis-bg-toggle">
              <input type="checkbox" id="bg-video-toggle" disabled />
              <span class="vis-bg-label">启用动态壁纸</span>
            </label>
            <button type="button" class="vis-bg-btn vis-bg-remove" id="bg-video-remove" disabled>移除</button>
          </div>
          <div class="vis-bg-name" id="bg-video-name" aria-live="polite">正在读取本地壁纸…</div>

          <!-- ── Visual presets ── -->
          <div class="vis-section-label">视觉预设</div>
          <div class="preset-selector" id="preset-selector">
            <button type="button" class="preset-btn active" data-preset="0">粒子墙</button>
            <button type="button" class="preset-btn" data-preset="1">星河</button>
            <button type="button" class="preset-btn" data-preset="2">音域回响</button>
          </div>

          <!-- ── Lyric color presets ── -->
          <div class="vis-section-label">歌词颜色</div>
          <div class="lyric-color-grid" id="lyric-color-grid"></div>

          <div class="vis-section-label">歌词翻译</div>
          <div class="lyric-mode-selector" id="lyric-mode-selector"
            role="radiogroup" aria-label="歌词显示方式">
            <button type="button" class="lyric-mode-btn" role="radio"
              data-lyric-mode="${LYRIC_DISPLAY_MODES.ORIGINAL}">仅原文</button>
            <button type="button" class="lyric-mode-btn" role="radio"
              data-lyric-mode="${LYRIC_DISPLAY_MODES.TRANSLATION}">仅译文</button>
            <button type="button" class="lyric-mode-btn" role="radio"
              data-lyric-mode="${LYRIC_DISPLAY_MODES.BOTH}">原文 + 译文</button>
          </div>
        </div>
      </div>
    `;
    // ── backdrop + close ──
    this.container.querySelector('.vis-settings-backdrop').addEventListener('click', () => state.toggleUI('visualSettingsOpen'));
    this.container.querySelector('.vis-settings-close').addEventListener('click', () => state.toggleUI('visualSettingsOpen'));

    const localAudioBtn = this.container.querySelector('#local-audio-capture-btn');
    localAudioBtn.addEventListener('click', async () => {
      const capture = this._localAudioCapture;
      if (!capture || capture.status === 'requesting') return;
      if (capture.active) {
        capture.stop('本地音频捕获已关闭', { forget: true });
        eventBus.emit('toast', { message: '已关闭本地音频响应', level: 'info' });
        return;
      }
      try {
        await capture.start();
        eventBus.emit('toast', { message: '已启用本地系统音频响应', level: 'success' });
      } catch (error) {
        eventBus.emit('toast', {
          message: error?.message || '本地音频捕获失败',
          level: 'error',
        });
      }
    });
    this._refreshLocalAudioCapture();

    // ── sliders → ParticleStage ──
    this.container.querySelectorAll('.vis-slider').forEach(slider => {
      slider.addEventListener('input', () => {
        const key = slider.dataset.key;
        const value = parseFloat(slider.value);
        const label = this.container.querySelector(`.vis-slider-val[data-key="${key}"]`);
        if (label) label.textContent = value;
        this._apply(key, value);
      });
    });

    // ── Background video — local file + IndexedDB persistence ──
    const bgToggle = this.container.querySelector('#bg-video-toggle');
    const bgFileInput = this.container.querySelector('#bg-video-file');
    const bgPickBtn = this.container.querySelector('#bg-video-pick');
    const bgRemoveBtn = this.container.querySelector('#bg-video-remove');
    const bgNameEl = this.container.querySelector('#bg-video-name');

    // The retired server-backed toggle must never reactivate a missing video.
    localStorage.removeItem('minerats-bg-video');
    this._restoreLocalWallpaper({ bgToggle, bgRemoveBtn, bgNameEl });

    bgPickBtn.addEventListener('click', () => bgFileInput.click());
    bgFileInput.addEventListener('change', async () => {
      const file = bgFileInput.files?.[0];
      bgFileInput.value = '';
      if (!file) return;

      const previousLabel = bgNameEl.textContent;
      bgPickBtn.disabled = true;
      bgNameEl.textContent = '正在验证并保存本地视频…';
      try {
        await this._validateVideoFile(file);
        await saveLocalWallpaper(file);
        this._applyBgBlob(file);
        this._bgHasVideo = true;
        bgToggle.disabled = false;
        bgToggle.checked = true;
        bgRemoveBtn.disabled = false;
        bgNameEl.textContent = `${file.name} (${formatWallpaperSize(file.size)})`;
        localStorage.setItem('minerats-bg-video-on', '1');
        this._setBgVideo(true);
        requestPersistentStorage();
        eventBus.emit('toast', { message: '本地动态壁纸已保存', level: 'success' });
      } catch (error) {
        bgNameEl.textContent = this._bgHasVideo ? previousLabel : '未选择本地视频';
        eventBus.emit('toast', {
          message: error?.message || '本地动态壁纸保存失败',
          level: 'error',
        });
      } finally {
        bgPickBtn.disabled = false;
      }
    });

    bgToggle.addEventListener('change', () => {
      const on = bgToggle.checked && this._bgHasVideo;
      if (!this._bgHasVideo) bgToggle.checked = false;
      localStorage.setItem('minerats-bg-video-on', on ? '1' : '0');
      this._setBgVideo(on);
    });

    bgRemoveBtn.addEventListener('click', async () => {
      bgRemoveBtn.disabled = true;
      try {
        await clearLocalWallpaper();
        this._clearBgVideo();
        bgToggle.checked = false;
        bgToggle.disabled = true;
        bgNameEl.textContent = '未选择本地视频';
        localStorage.removeItem('minerats-bg-video-on');
        eventBus.emit('toast', { message: '本地动态壁纸已移除', level: 'info' });
      } catch (error) {
        bgRemoveBtn.disabled = false;
        eventBus.emit('toast', {
          message: error?.message || '移除本地动态壁纸失败',
          level: 'error',
        });
      }
    });

    // ── Lyric color grid ──
    this._buildColorGrid();

    this.container.querySelectorAll('.lyric-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        lyricTranslationManager.setMode(btn.dataset.lyricMode);
      });
    });
    this._refreshTranslationMode();

    // ── Preset selector ──
    this.container.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this._applyPreset(btn.dataset.preset, true);
      });
    });
  }

  _apply(key, value) {
    switch (key) {
      case 'intensity':
        this._stage.setUniform('uIntensity', value);
        break;
      case 'brightness':
        this._stage.setBrightness(value);
        break;
      case 'pointScale':
        this._stage.setUniform('uPointScale', value);
        break;
      case 'bloom':
        this._stage.setUniform('uBloomStrength', value);
        break;
      case 'rotation':
        this._stage.setRotationScale(value);
        break;
    }
  }

  _restorePreset() {
    this._applyPreset(loadVisualPreset(), false);
  }

  _applyPreset(value, persist) {
    const idx = normalizeVisualPreset(value);
    this._stage.setPreset(idx);
    this._refreshPresetButtons(idx);
    if (persist) saveVisualPreset(idx);
    // Keep the slider synchronized with each particle preset's original default.
    if (idx === 0 || idx === 1) {
      const pointScale = idx === 0 ? 2.2 : 1.2;
      const s = this.container.querySelector('.vis-slider[data-key="pointScale"]');
      const l = this.container.querySelector('.vis-slider-val[data-key="pointScale"]');
      if (s) s.value = pointScale;
      if (l) l.textContent = String(pointScale);
    }
  }

  async _restoreLocalWallpaper({ bgToggle, bgRemoveBtn, bgNameEl }) {
    try {
      const record = await loadLocalWallpaper();
      if (!record) {
        bgNameEl.textContent = '未选择本地视频';
        return;
      }

      this._applyBgBlob(record.blob);
      this._bgHasVideo = true;
      bgToggle.disabled = false;
      bgRemoveBtn.disabled = false;
      bgNameEl.textContent =
        `${record.name || '本地视频'} (${formatWallpaperSize(record.blob.size)})`;

      const on = localStorage.getItem('minerats-bg-video-on') === '1';
      bgToggle.checked = on;
      this._setBgVideo(on);
    } catch (error) {
      bgNameEl.textContent = '本地壁纸读取失败，请重新选择';
      eventBus.emit('toast', {
        message: error?.message || '本地动态壁纸读取失败',
        level: 'warn',
      });
    }
  }

  _applyBgBlob(blob) {
    this._releaseBgBlobUrl();
    this._bgBlobUrl = URL.createObjectURL(blob);
    const video = document.getElementById('bg-video');
    if (video) {
      video.src = this._bgBlobUrl;
      video.load();
    }
  }

  _releaseBgBlobUrl() {
    if (!this._bgBlobUrl) return;
    URL.revokeObjectURL(this._bgBlobUrl);
    this._bgBlobUrl = null;
  }

  _clearBgVideo() {
    this._setBgVideo(false);
    this._bgHasVideo = false;
    const video = document.getElementById('bg-video');
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
    this._releaseBgBlobUrl();
  }

  _validateVideoFile(file) {
    return new Promise((resolve, reject) => {
      const probe = document.createElement('video');
      const probeUrl = URL.createObjectURL(file);
      let settled = false;

      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        probe.removeAttribute('src');
        probe.load();
        URL.revokeObjectURL(probeUrl);
        if (error) reject(error);
        else resolve();
      };

      const timeoutId = setTimeout(
        () => finish(new Error('无法读取该视频，请选择浏览器支持的 MP4 或 WebM 文件')),
        10000,
      );
      probe.preload = 'metadata';
      probe.muted = true;
      probe.onloadedmetadata = () => finish();
      probe.onerror = () => finish(new Error('视频格式不受支持，请选择 MP4 或 WebM 文件'));
      probe.src = probeUrl;
    });
  }

  _setBgVideo(on) {
    const video = document.getElementById('bg-video');
    const shouldEnable = Boolean(on && this._bgHasVideo && video?.src);
    if (video) {
      if (shouldEnable) { video.play().catch(() => {}); }
      else { video.pause(); }
    }
    document.documentElement.classList.toggle('bg-video-on', shouldEnable);
    if (this._stage) this._stage.setBgVideo(shouldEnable);
  }

  // ── Lyric color grid ──

  _buildColorGrid() {
    const grid = this.container.querySelector('#lyric-color-grid');
    if (!grid) return;
    const activeIdx = lyricColorManager.activeIndex;
    grid.innerHTML = LYRIC_COLOR_PRESETS.map((p, i) => `
      <button type="button"
        class="lyric-color-chip ${i === activeIdx ? 'active' : ''}"
        title="${p.name}"
        style="--lc:${p.color}"
        data-idx="${i}">
        <span class="lc-dot" style="background:${p.color}"></span>
        <span class="lc-name">${p.name}</span>
      </button>
    `).join('');

    grid.querySelectorAll('.lyric-color-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.idx, 10);
        lyricColorManager.setColor(idx);
      });
    });
  }

  _refreshColorGrid() {
    const grid = this.container.querySelector('#lyric-color-grid');
    if (!grid) return;
    const activeIdx = lyricColorManager.activeIndex;
    grid.querySelectorAll('.lyric-color-chip').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.idx, 10) === activeIdx);
    });
  }

  _refreshTranslationMode() {
    this.container.querySelectorAll('.lyric-mode-btn').forEach(btn => {
      const active = btn.dataset.lyricMode === lyricTranslationManager.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  _refreshLocalAudioCapture(snapshot = this._localAudioCapture?.snapshot?.()) {
    const btn = this.container.querySelector('#local-audio-capture-btn');
    const status = this.container.querySelector('#local-audio-capture-status');
    const indicator = this.container.querySelector('#local-audio-indicator');
    if (!btn || !status || !indicator) return;

    const info = snapshot || {
      active: false,
      supported: false,
      secureContext: false,
      status: 'idle',
      message: '本地音频捕获不可用',
    };
    const requesting = info.status === 'requesting';
    btn.disabled = requesting || (!info.active && !info.supported);
    btn.textContent = requesting
      ? '等待授权…'
      : (info.active ? '停止本地音频' : '启用本地音频');
    indicator.classList.toggle('active', Boolean(info.active));
    indicator.classList.toggle('requesting', requesting);

    if (info.active) status.textContent = '已连接：正在分析本机系统音频';
    else if (!info.secureContext) status.textContent = '需要使用 HTTPS 打开网页后才能授权系统音频';
    else if (!info.supported) status.textContent = '当前浏览器不支持，请使用最新版 Chrome 或 Edge';
    else if (info.preferred && !info.message) status.textContent = '上次已启用，请点击按钮重新授权';
    else status.textContent = info.message || '未启用；当前使用本地缓存或低潮模拟节拍';
  }

  _refreshPresetButtons(activeIdx) {
    this.container.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.preset, 10) === activeIdx);
    });
  }
}
