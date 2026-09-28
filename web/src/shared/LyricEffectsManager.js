import { eventBus } from './EventBus.js';

const GHOST_STORAGE_KEY = 'minerats-lyric-ghost';

/** Browser-local lyric effects shared by the controls and 3D renderer. */
export class LyricEffectsManager {
  constructor(storage, bus = eventBus) {
    this._bus = bus;
    this._ghostEnabled = true;
    try {
      this._storage = storage ?? globalThis.localStorage;
      this._ghostEnabled = this._storage?.getItem(GHOST_STORAGE_KEY) !== '0';
    } catch (_) { /* Keep the existing appearance if storage is unavailable. */ }
  }

  get ghostEnabled() { return this._ghostEnabled; }

  setGhostEnabled(enabled) {
    const value = Boolean(enabled);
    if (value === this._ghostEnabled) return;
    this._ghostEnabled = value;
    try { this._storage?.setItem(GHOST_STORAGE_KEY, value ? '1' : '0'); }
    catch (_) { /* The live switch still works when persistence is blocked. */ }
    this._bus.emit('lyric:ghostChanged', { enabled: value });
  }
}

export const lyricEffectsManager = new LyricEffectsManager();
