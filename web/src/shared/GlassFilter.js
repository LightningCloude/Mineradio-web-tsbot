/**
 * GlassFilter — SVG glass displacement filter manager.
 *
 * Generates dynamic displacement maps matching element dimensions and border-radius,
 * then injects them as data URIs into SVG <feImage> nodes. Mineradio-style RGB
 * chromatic displacement with screen blending.
 *
 * Applied via CSS class `glass-svg-ok` on <html> when supported.
 * Falls back to CSS backdrop-filter blur on unsupported browsers (Safari, Firefox).
 */

import { eventBus } from './EventBus.js';

// ── Feature detection ──
function supportsControlGlassSvgFilter() {
  try {
    const ua = navigator.userAgent || '';
    // Safari and Firefox don't support backdrop-filter: url(...)
    if ((/Safari/.test(ua) && !/Chrome/.test(ua)) || /Firefox/.test(ua)) return false;
    const div = document.createElement('div');
    div.style.backdropFilter = 'url(#minerats-player-glass)';
    return div.style.backdropFilter !== '';
  } catch (e) {
    return false;
  }
}

// ── Displacement map SVG generator ──
// Creates a red→transparent horizontal gradient and blue→transparent vertical gradient
// with a blurred center rectangle, composited as a data URI.
function generateDisplacementMap(width, height, radius) {
  width = Math.max(240, Math.round(width || 400));
  height = Math.max(48, Math.round(height || 92));
  radius = Math.max(12, Math.round(radius || 50));

  const borderWidth = 0.07;
  const edge = Math.min(width, height) * (borderWidth * 0.5);
  const innerW = Math.max(1, width - edge * 2);
  const innerH = Math.max(1, height - edge * 2);

  const svg = `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<linearGradient id="gred" x1="100%" y1="0%" x2="0%" y2="0%">` +
    `<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="red"/></linearGradient>` +
    `<linearGradient id="gblue" x1="0%" y1="0%" x2="0%" y2="100%">` +
    `<stop offset="0%" stop-color="#0000"/><stop offset="100%" stop-color="blue"/></linearGradient>` +
    `</defs>` +
    `<rect x="0" y="0" width="${width}" height="${height}" fill="black"/>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="url(#gred)"/>` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" fill="url(#gblue)" style="mix-blend-mode:difference"/>` +
    `<rect x="${edge.toFixed(2)}" y="${edge.toFixed(2)}" width="${innerW.toFixed(2)}" ` +
    `height="${innerH.toFixed(2)}" rx="${radius}" fill="hsl(0 0% 50% / 1)" style="filter:blur(11px)"/>` +
    `</svg>`;

  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// ── Per-element displacement map cache ──
const _stateCache = {};

function updateGlassDisplacementMap(el, imgId, stateKey) {
  const img = document.getElementById(imgId);
  if (!el || !img) return;

  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;

  const radius = parseFloat(getComputedStyle(el).borderRadius) || 24;
  const key = `${Math.round(rect.width)}x${Math.round(rect.height)}:${Math.round(radius)}`;
  if (key === _stateCache[stateKey]) return;
  _stateCache[stateKey] = key;

  const href = generateDisplacementMap(rect.width, rect.height, radius);
  img.setAttribute('href', href);
  try { img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href); } catch (e) {}
}

/**
 * Update all glass displacement maps. Call on resize and on first load.
 */
function updateAllMaps() {
  // Player bar (.player-bar is the inner div; #player-bar is the container)
  updateGlassDisplacementMap(
    document.querySelector('.player-bar'),
    'player-glass-map',
    'playerKey'
  );
  // Search panel (CookieView also uses .search-panel, so keep this selector scoped.)
  updateGlassDisplacementMap(
    document.querySelector('#search-overlay .search-panel'),
    'search-glass-map',
    'searchKey'
  );
  updateGlassDisplacementMap(
    document.querySelector('#queue-panel'),
    'queue-glass-map',
    'queueKey'
  );
  updateGlassDisplacementMap(
    document.querySelector('#cookie-overlay .search-panel'),
    'cookie-glass-map',
    'cookieKey'
  );
  updateGlassDisplacementMap(
    document.querySelector('.vis-settings-panel'),
    'visual-glass-map',
    'visualKey'
  );
}

function scheduleMapRefresh() {
  requestAnimationFrame(updateAllMaps);
  // WebGL startup can occasionally occupy the first animation frame. A short
  // follow-up guarantees newly opened overlays still receive their map.
  setTimeout(updateAllMaps, 180);
}

/**
 * Initialize glass filter support.
 * Adds `glass-svg-ok` class to <html> when SVG backdrop-filter is supported.
 */
export function initGlassFilter() {
  if (supportsControlGlassSvgFilter()) {
    document.documentElement.classList.add('glass-svg-ok');
    console.log('[GlassFilter] SVG glass filter enabled');
  } else {
    console.log('[GlassFilter] SVG glass filter not supported — using CSS blur fallback');
  }

  // Generate initial maps
  scheduleMapRefresh();

  // Overlays are zero-sized while hidden. Refresh after their UI state has
  // changed so every panel receives a map matching its visible dimensions.
  eventBus.on('ui:changed', () => {
    scheduleMapRefresh();
  });

  // Update on resize (debounced)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateAllMaps, 200);
    // Also update after any CSS transition/animation completes
    setTimeout(updateAllMaps, 600);
  });
}
