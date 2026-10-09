/** Low-rate diagnostics, not a second analyser or an animation loop. */
export class AudioSignalMonitor {
  constructor(bus, { interval = 0.25, silenceAfter = 5 } = {}) {
    this.bus = bus;
    this.interval = interval;
    this.silenceAfter = silenceAfter;
    this._elapsed = 0;
    this._silentFor = 0;
  }

  tick(dt, { captureActive, input, frame, playing }) {
    const delta = Math.max(0, Math.min(0.25, Number(dt) || 0));
    const level = input?.running && input?.live && captureActive
      ? Math.max(0, Math.min(1, Number(input?.rms) || 0)) : 0;
    const audible = level > 0.003;
    this._silentFor = captureActive && !audible ? this._silentFor + delta : 0;
    this._elapsed += delta;
    if (this._elapsed < this.interval) return null;
    this._elapsed = 0;
    const source = captureActive ? 'realtime' : (frame?.source || 'idle');
    const snapshot = Object.freeze({
      source, level, playing: Boolean(playing), captureActive: Boolean(captureActive),
      audible, silent: captureActive && this._silentFor >= this.silenceAfter,
      running: Boolean(input?.running), live: Boolean(input?.live),
    });
    this.bus.emit('audio:diagnostics', snapshot);
    return snapshot;
  }
}

export function describeAudioSignal(info) {
  if (!info) return '音频响应：等待输入';
  if (info.captureActive) {
    if (!info.running) return '系统音频已连接，但浏览器音频处理已暂停；请重新授权';
    if (info.silent) return '系统音频已连接，但未检测到声音；请检查共享音频及 TeamSpeak 输出扬声器';
    return info.audible ? '实时系统音频：已检测到声音' : '系统音频已连接，等待声音输入';
  }
  if (info.source === 'analyzed') return '音频响应：浏览器本地节拍缓存';
  if (info.source === 'synthetic') return '音频响应：低潮模拟（非实时频谱）';
  return '音频响应：空闲';
}
