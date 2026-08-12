import { eventBus } from './EventBus.js';

/**
 * LyricColorManager — 18 preset lyric colors from Mineradio.
 *
 * Manages the active lyric tint color and provides:
 *   - 18 named presets (雾蓝, 银蓝, ..., 墨黑)
 *   - Active color persistence via localStorage
 *   - Derived color values (glow, highlight, shadow) for LyricStage
 *   - Events: 'lyric:colorChanged' when user selects a new color
 */

// ── 18 Preset lyric colors (from Mineradio) ──
export const LYRIC_COLOR_PRESETS = [
  { name: '雾蓝', color: '#a9b8c8' },
  { name: '银蓝', color: '#9db8cf' },
  { name: '冰川', color: '#7ec8d8' },
  { name: '青绿', color: '#66d2b5' },
  { name: '松针', color: '#7fa894' },
  { name: '月白', color: '#d7d2c4' },
  { name: '岩金', color: '#c3ae7c' },
  { name: '琥珀', color: '#d9a45f' },
  { name: '暮粉', color: '#c78aa4' },
  { name: '玫红', color: '#d76a8d' },
  { name: '烟紫', color: '#9b83d3' },
  { name: '电紫', color: '#8d70ff' },
  { name: '靛蓝', color: '#5e78d8' },
  { name: '海蓝', color: '#3c9fe0' },
  { name: '霓青', color: '#28c5c3' },
  { name: '夜绿', color: '#245c49' },
  { name: '酒红', color: '#6d1f35' },
  { name: '墨黑', color: '#111318' },
];

const STORAGE_KEY = 'minerats-lyric-color';

/**
 * Derive a lighter highlight variant of a hex color.
 * Used for active lyric text gradient top.
 */
function lighten(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const lr = Math.min(255, r + Math.round((255 - r) * amount));
  const lg = Math.min(255, g + Math.round((255 - g) * amount));
  const lb = Math.min(255, b + Math.round((255 - b) * amount));
  return '#' + [lr, lg, lb].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive a darker/deeper variant for glow shadow.
 */
function deepen(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const dr = Math.max(0, Math.round(r * (1 - amount)));
  const dg = Math.max(0, Math.round(g * (1 - amount)));
  const db = Math.max(0, Math.round(b * (1 - amount)));
  return '#' + [dr, dg, db].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert hex to rgba string with given alpha.
 */
function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

class LyricColorManager {
  constructor() {
    this._presets = LYRIC_COLOR_PRESETS;
    this._activeIdx = 1; // default: 银蓝 #9db8cf

    // Load saved preference
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved != null) {
        const idx = parseInt(saved, 10);
        if (idx >= 0 && idx < this._presets.length) this._activeIdx = idx;
      }
    } catch (e) { /* ignore */ }

    this._active = this._presets[this._activeIdx];
  }

  /** Get all 18 presets. */
  get presets() { return this._presets; }

  /** Get active preset index. */
  get activeIndex() { return this._activeIdx; }

  /** Get active preset { name, color }. */
  get active() { return this._active; }

  /** Get active hex color. */
  get color() { return this._active.color; }

  /**
   * Derived color palette for LyricStage rendering.
   * Returns an object with all color variants needed by the lyric shader/text:
   *   - textGradTop:     bright highlight (gradient top)
   *   - textGradBottom:  accent tint (gradient bottom)
   *   - glow:            halo glow color (for additive blend)
   *   - glowShadow:      secondary glow shadow
   *   - spark:           spark particle color
   *   - sunBloom:        sun bloom radial gradient center
   *   - base:            the raw preset color
   */
  get palette() {
    const c = this._active.color;
    return {
      base: c,
      textGradTop: lighten(c, 0.55),
      textGradBottom: c,
      glow: hexToRgba(c, 0.45),
      glowShadow: hexToRgba(deepen(c, 0.35), 0.30),
      spark: lighten(c, 0.65),
      sunBloom: hexToRgba(c, 0.55),
    };
  }

  /**
   * Set the active color by preset index.
   * @param {number} idx - 0-17 preset index
   */
  setColor(idx) {
    idx = Math.max(0, Math.min(this._presets.length - 1, idx | 0));
    if (idx === this._activeIdx) return;
    this._activeIdx = idx;
    this._active = this._presets[idx];
    try { localStorage.setItem(STORAGE_KEY, String(idx)); } catch (e) { /* ignore */ }
    eventBus.emit('lyric:colorChanged', {
      index: idx,
      preset: this._active,
      palette: this.palette,
    });
  }

  /** Get a single preset by index. */
  getPreset(idx) {
    return this._presets[idx] || this._presets[0];
  }
}

export const lyricColorManager = new LyricColorManager();
