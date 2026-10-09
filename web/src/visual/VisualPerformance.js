export const PERFORMANCE_MODES = Object.freeze(['high', 'auto', 'saving']);
export const PERFORMANCE_STORAGE_KEY = 'minerats-visual-performance';

/** Hysteretic rolling-frame policy. Changes resolution, never terrain density. */
export class VisualPerformance {
  constructor({ storage = globalThis.localStorage, deviceRatio = 1 } = {}) {
    this.storage = storage;
    this.baseRatio = Math.max(0.5, Math.min(2, Number(deviceRatio) || 1));
    let saved;
    try { saved = storage?.getItem(PERFORMANCE_STORAGE_KEY); } catch (_) { /* private mode */ }
    this.mode = PERFORMANCE_MODES.includes(saved) ? saved : 'high';
    this.factor = 1;
    this.idle = false;
    this.reset();
  }

  reset() { this._frames = 0; this._seconds = 0; this._slow = 0; this._fast = 0; }
  setMode(value) {
    this.mode = PERFORMANCE_MODES.includes(value) ? value : 'high';
    this.factor = 1;
    this.reset();
    try { this.storage?.setItem(PERFORMANCE_STORAGE_KEY, this.mode); } catch (_) { /* optional */ }
  }

  get pixelRatio() {
    const ratio = this.mode === 'saving' ? Math.min(1, this.baseRatio * 0.7)
      : this.baseRatio * (this.mode === 'auto' ? this.factor : 1);
    return this.idle ? Math.min(ratio, this.baseRatio * 0.5, 1) : ratio;
  }

  observe(dt) {
    if (!(dt > 0) || dt > 0.2) return null;
    this._frames++;
    this._seconds += dt;
    if (this._seconds < 1) return null;
    const fps = this._frames / this._seconds;
    this._slow = fps < 45 ? this._slow + this._seconds : 0;
    this._fast = fps > 57 ? this._fast + this._seconds : 0;
    if (this.mode === 'auto') {
      if (this._slow >= 3) { this.factor = Math.max(0.55, this.factor - 0.15); this._slow = 0; }
      else if (this._fast >= 10) { this.factor = Math.min(1, this.factor + 0.1); this._fast = 0; }
    }
    this._frames = 0;
    this._seconds = 0;
    return { fps: Math.round(fps), pixelRatio: this.pixelRatio, mode: this.mode };
  }
}
