import { eventBus } from './EventBus.js';

const STORAGE_KEY = 'minerats-lyric-display-mode';
const LEGACY_STORAGE_KEY = 'minerats-lyric-translation';

export const LYRIC_DISPLAY_MODES = Object.freeze({
  ORIGINAL: 'original',
  TRANSLATION: 'translation',
  BOTH: 'both',
});

const VALID_MODES = new Set(Object.values(LYRIC_DISPLAY_MODES));

class LyricTranslationManager {
  constructor() {
    this._mode = LYRIC_DISPLAY_MODES.BOTH;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (VALID_MODES.has(saved)) {
        this._mode = saved;
      } else {
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacy === '0') this._mode = LYRIC_DISPLAY_MODES.ORIGINAL;
      }
    } catch (e) { /* storage may be unavailable in private contexts */ }
  }

  get mode() { return this._mode; }
  get enabled() { return this._mode !== LYRIC_DISPLAY_MODES.ORIGINAL; }

  setMode(mode) {
    if (!VALID_MODES.has(mode) || mode === this._mode) return;
    this._mode = mode;
    try { localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* ignore */ }
    eventBus.emit('lyric:translationChanged', {
      mode,
      enabled: mode !== LYRIC_DISPLAY_MODES.ORIGINAL,
    });
  }

  setEnabled(enabled) {
    this.setMode(enabled ? LYRIC_DISPLAY_MODES.BOTH : LYRIC_DISPLAY_MODES.ORIGINAL);
  }
}

export const lyricTranslationManager = new LyricTranslationManager();
