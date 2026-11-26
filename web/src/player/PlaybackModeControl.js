import { api } from '../core/ApiClient.js';
import { eventBus } from '../shared/EventBus.js';

export const PLAYBACK_MODES = {
  order: ['顺序播放', '按列表顺序播放，播完停止', '<path d="M4 6h12M4 12h12M4 18h12m3-3 3 3-3 3"/>'],
  repeat_one: ['单曲循环', '当前歌曲播完后从头再播', '<path d="m17 2 4 4-4 4m4-4H7a4 4 0 0 0-4 4m4 12-4-4 4-4m-4 4h14a4 4 0 0 0 4-4m-10-3 2-1v5"/>'],
  shuffle: ['随机播放', '随机播放剩余歌曲，播完停止', '<path d="M3 6h2c6 0 8 12 14 12h2m-4-4 4 4-4 4M3 18h2c2 0 4-2 5-4m4-4c1-2 3-4 5-4h2m-4-4 4 4-4 4"/>'],
  repeat_all: ['列表循环', '保留列表，最后一首播完后回到第一首', '<path d="m17 2 4 4-4 4m4-4H7a4 4 0 0 0-4 4m4 12-4-4 4-4m-4 4h14a4 4 0 0 0 4-4"/>'],
};

const icon = (mode, css = '') => `<svg class="${css}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PLAYBACK_MODES[mode][2]}</svg>`;
export const orderModeIcon = icon('order', 'svg-icon');

export class PlaybackModeControl {
  constructor(trigger, { apiClient = api, bus = eventBus } = {}) {
    this.trigger = trigger;
    this.api = apiClient;
    this.bus = bus;
    this.current = 'order';
    this.pending = false;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.id = 'playback-mode-dialog';
    dialog.className = 'playback-mode-dialog';
    dialog.setAttribute('aria-labelledby', 'playback-mode-title');
    dialog.innerHTML = `<header><h2 id="playback-mode-title">播放模式</h2><button type="button" class="playlist-icon-btn" data-mode-close aria-label="关闭播放模式">✕</button></header>
      <p class="playback-mode-note">应用于共享播放队列，不会打断当前歌曲。</p>
      <div role="group" aria-label="选择播放模式">${Object.entries(PLAYBACK_MODES).map(([mode, [label, description]]) => `
        <button type="button" class="playback-mode-option" data-mode="${mode}" aria-pressed="false">${icon(mode)}
          <span><strong>${label}</strong><small>${description}</small></span><span aria-hidden="true" class="playback-mode-check">✓</span>
        </button>`).join('')}</div>
      <p class="playback-mode-feedback" role="status"></p>`;
    document.body.appendChild(dialog);
    this.message = dialog.querySelector('.playback-mode-feedback');
    this.options = [...dialog.querySelectorAll('[data-mode]')];
    this.apply('order');
    trigger.addEventListener('click', () => this.open());
    trigger.addEventListener('keydown', event => {
      if (event.code === 'Space' || event.key === ' ') event.stopPropagation();
    });
    dialog.addEventListener('click', event => {
      if (event.target === dialog || event.target.closest('[data-mode-close]')) dialog.close();
      else {
        const button = event.target.closest('[data-mode]');
        if (button) void this.choose(button.dataset.mode);
      }
    });
    dialog.addEventListener('keydown', event => event.stopPropagation());
    dialog.addEventListener('close', () => { trigger.setAttribute('aria-expanded', 'false'); trigger.focus({ preventScroll: true }); });
    bus.on('playback:mode', mode => this.apply(mode));
  }

  open() {
    if (this.dialog.open) return;
    if (!this.pending) this.message.textContent = '';
    this.dialog.showModal();
    this.trigger.setAttribute('aria-expanded', 'true');
    this.options.find(button => button.dataset.mode === this.current)?.focus();
  }

  apply(mode) {
    if (!Object.hasOwn(PLAYBACK_MODES, mode)) return false;
    for (const button of this.options) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    const label = `播放模式：${PLAYBACK_MODES[mode][0]}`;
    if (this.trigger.dataset.mode !== mode) this.trigger.innerHTML = icon(mode, 'svg-icon');
    this.trigger.dataset.mode = mode;
    this.trigger.title = label;
    this.trigger.setAttribute('aria-label', label);
    this.current = mode;
    return true;
  }

  async choose(mode) {
    if (this.pending || !Object.hasOwn(PLAYBACK_MODES, mode)) return;
    // Always send an explicit selection: the local default may precede server status.
    this.pending = true;
    this.options.forEach(button => { button.disabled = true; });
    this.message.textContent = '正在切换…';
    try {
      const result = await this.api.setPlaybackMode(mode, { silent: true });
      if (!result?.ok || !this.apply(result.playback_mode)) throw new Error('invalid mode response');
      this.bus.emit('toast', { message: `已切换为${PLAYBACK_MODES[this.current][0]}`, level: 'success' });
      if (this.dialog.open) this.dialog.close();
    } catch {
      this.message.textContent = '未能确认切换结果，请重试。';
      if (!this.dialog.open) this.bus.emit('toast', { message: this.message.textContent, level: 'warn' });
    } finally {
      this.pending = false;
      this.options.forEach(button => { button.disabled = false; });
      if (this.dialog.open) this.options.find(button => button.dataset.mode === mode)?.focus();
    }
  }
}
