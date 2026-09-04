import { audioAnalyzer } from './AudioAnalyzer.js';
import { eventBus } from '../shared/EventBus.js';

export const LOCAL_AUDIO_CAPTURE_PREFERENCE = 'minerats-local-audio-capture';

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() || []) {
    try { track.stop(); } catch (_) { /* ignore */ }
  }
}

export class LocalAudioCapture {
  constructor({
    analyzer = audioAnalyzer,
    bus = eventBus,
    mediaDevices = globalThis.navigator?.mediaDevices,
    storage = globalThis.localStorage,
    secureContext = Boolean(globalThis.isSecureContext),
  } = {}) {
    this.analyzer = analyzer;
    this.bus = bus;
    this.mediaDevices = mediaDevices;
    this.storage = storage;
    this.secureContext = secureContext;
    this.stream = null;
    this.status = 'idle';
    this.message = '';
  }

  get active() {
    return this.status === 'active' && Boolean(this.stream);
  }

  get supported() {
    return this.secureContext
      && typeof this.mediaDevices?.getDisplayMedia === 'function';
  }

  get preferred() {
    try { return this.storage?.getItem(LOCAL_AUDIO_CAPTURE_PREFERENCE) === '1'; }
    catch (_) { return false; }
  }

  snapshot() {
    return {
      active: this.active,
      preferred: this.preferred,
      supported: this.supported,
      secureContext: this.secureContext,
      status: this.status,
      message: this.message,
    };
  }

  async start() {
    if (this.active) return this.snapshot();
    if (!this.secureContext) {
      throw new Error('本地音频捕获需要通过 HTTPS 打开网页');
    }
    if (typeof this.mediaDevices?.getDisplayMedia !== 'function') {
      throw new Error('当前浏览器不支持系统音频捕获，请使用最新版 Chrome 或 Edge');
    }

    this._setStatus('requesting', '请选择屏幕并勾选“共享系统音频”');
    let stream;
    try {
      stream = await this.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 1, max: 2 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          suppressLocalAudioPlayback: false,
        },
        preferCurrentTab: false,
        selfBrowserSurface: 'exclude',
        systemAudio: 'include',
      });
    } catch (error) {
      const denied = error?.name === 'NotAllowedError' || error?.name === 'AbortError';
      this._setStatus('idle', denied ? '未授权系统音频' : '无法启动本地音频捕获');
      throw new Error(denied ? '未授权系统音频捕获' : (error?.message || '无法启动本地音频捕获'));
    }

    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) {
      stopTracks(stream);
      this._setStatus('idle', '共享内容未包含系统音频');
      throw new Error('没有检测到系统音频，请重新选择并勾选“共享系统音频”');
    }

    // Keep the mandatory display track alive but disabled. Some Chromium
    // versions end the accompanying audio track if the video track is stopped.
    for (const track of stream.getVideoTracks()) track.enabled = false;

    if (!this.analyzer.connectStream(stream)) {
      stopTracks(stream);
      this._setStatus('idle', '音频分析器连接失败');
      throw new Error('无法连接本地音频分析器');
    }
    await this.analyzer.resume();

    this.stream = stream;
    try { this.storage?.setItem(LOCAL_AUDIO_CAPTURE_PREFERENCE, '1'); } catch (_) { /* ignore */ }
    for (const track of stream.getTracks()) {
      track.addEventListener?.('ended', () => {
        if (this.stream === stream) this.stop('系统音频共享已结束');
      }, { once: true });
    }
    this._setStatus('active', '正在使用本地系统音频进行节拍响应');
    return this.snapshot();
  }

  stop(message = '本地音频捕获已关闭', { forget = false } = {}) {
    const stream = this.stream;
    this.stream = null;
    if (stream) stopTracks(stream);
    this.analyzer.disconnect();
    if (forget) {
      try { this.storage?.removeItem(LOCAL_AUDIO_CAPTURE_PREFERENCE); } catch (_) { /* ignore */ }
    }
    this._setStatus('idle', message);
    return this.snapshot();
  }

  _setStatus(status, message) {
    this.status = status;
    this.message = message;
    this.bus.emit('local-audio:capture-changed', this.snapshot());
  }
}

export const localAudioCapture = new LocalAudioCapture();
