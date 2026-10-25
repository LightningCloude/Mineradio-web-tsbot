/** A passive reminder. Only an explicit button click requests browser capture. */
export class AudioPermissionReminderState {
  constructor(snapshot = {}) {
    this.capture = snapshot;
    this.preset = null;
    this.dismissed = false;
  }

  get visible() { return !this.capture.active && !this.dismissed; }

  selectPreset(preset, userInitiated = false) {
    if (userInitiated && this.preset !== preset) this.dismissed = false;
    this.preset = preset;
  }

  updateCapture(snapshot) {
    if (this.capture.active && !snapshot.active) this.dismissed = false;
    this.capture = snapshot;
  }

  dismiss() { this.dismissed = true; }
}

export class AudioPermissionReminder {
  constructor({ capture, bus, document = globalThis.document }) {
    this.capture = capture;
    this.bus = bus;
    this.document = document;
    this.model = new AudioPermissionReminderState(capture.snapshot());
    this.element = document.createElement('aside');
    this.element.id = 'audio-permission-reminder';
    this.element.setAttribute('aria-labelledby', 'audio-permission-title');
    this.element.innerHTML = `
      <strong id="audio-permission-title">授权系统音频，启用真实节拍响应</strong>
      <p>未共享系统音频时，视觉效果仅使用本地缓存或低潮模拟。点击授权，选择整个屏幕并勾选“共享系统音频”；请确认 TeamSpeak 使用被共享的输出设备。</p>
      <p class="audio-permission-status" role="status" aria-live="polite"></p>
      <div class="audio-permission-actions">
        <button type="button" class="vis-bg-btn" data-audio-permission="authorize">授权系统音频</button>
        <button type="button" class="vis-bg-btn" data-audio-permission="dismiss">稍后</button>
      </div>`;
    this.authorizeButton = this.element.querySelector('[data-audio-permission="authorize"]');
    this.status = this.element.querySelector('.audio-permission-status');
    this.authorizeButton.addEventListener('click', () => this.authorize());
    this.element.querySelector('[data-audio-permission="dismiss"]')
      .addEventListener('click', () => this.dismiss());
    // Reading/scrolling the notice must not start the scene's drag rotation.
    for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
      this.element.addEventListener(type, (event) => event.stopPropagation());
    }
    this.element.addEventListener('keydown', (event) => {
      // Keep button keyboard activation from also toggling playback globally.
      if (event.key === ' ' || event.code === 'Space') event.stopPropagation();
      if (event.key === 'Escape') {
        event.stopPropagation();
        this.dismiss();
      }
    });
    document.getElementById('app').appendChild(this.element);
    this.unsubscribers = [
      bus.on('visual:preset-changed', ({ preset, userInitiated }) => {
        this.model.selectPreset(preset, userInitiated);
        this.render();
      }),
      bus.on('playback:changed', () => this.render()),
      bus.on('local-audio:capture-changed', (snapshot) => {
        this.model.updateCapture(snapshot);
        this.render();
      }),
    ];
    this.render();
  }

  render(error = '') {
    const info = this.model.capture;
    this.element.hidden = !this.model.visible;
    const requesting = info.status === 'requesting';
    this.authorizeButton.disabled = requesting || !info.supported;
    this.authorizeButton.textContent = requesting ? '等待授权…' : '授权系统音频';
    this.status.textContent = error || (!info.secureContext
      ? '当前为 HTTP 页面，请使用 HTTPS 地址打开后授权系统音频。'
      : (!info.supported ? '此浏览器不支持系统音频共享，请使用桌面版 Chrome 或 Edge。'
        : (info.message || '系统音频仅在你点击授权后获取，不会上传或下载歌曲用于分析。')));
  }

  async authorize() {
    if (this.capture.active || this.capture.status === 'requesting'
        || !this.capture.supported) return;
    try {
      // Call immediately in the click handler; never request on preset change.
      await this.capture.start();
    } catch (error) {
      this.model.updateCapture(this.capture.snapshot());
      this.render(error?.message || '未能获取系统音频，请重新授权。');
    }
  }

  dismiss() {
    const restoreFocus = this.element.contains(this.document.activeElement);
    this.model.dismiss();
    this.render();
    if (restoreFocus) this.document.querySelector('[data-action="vis-settings"]')?.focus();
  }

  destroy() {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.element.remove();
  }
}
