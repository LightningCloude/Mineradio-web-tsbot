export const VISUAL_PRESET_STORAGE_KEY = 'minerats-visual-preset';
const VISUAL_PRESET_MIN = 0;
const VISUAL_PRESET_MAX = 2;

export function normalizeVisualPreset(value, fallback = VISUAL_PRESET_MIN) {
  const preset = Number(value);
  return Number.isInteger(preset) && preset >= VISUAL_PRESET_MIN && preset <= VISUAL_PRESET_MAX
    ? preset
    : fallback;
}

export function loadVisualPreset(storage = globalThis.localStorage) {
  try {
    return normalizeVisualPreset(storage?.getItem(VISUAL_PRESET_STORAGE_KEY));
  } catch (_) {
    return VISUAL_PRESET_MIN;
  }
}

export function saveVisualPreset(preset, storage = globalThis.localStorage) {
  const value = normalizeVisualPreset(preset);
  try {
    storage?.setItem(VISUAL_PRESET_STORAGE_KEY, String(value));
  } catch (_) {
    // Private browsing or quota failures must not prevent changing visuals.
  }
  return value;
}
