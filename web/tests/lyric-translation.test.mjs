import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};

const { eventBus } = await import('../src/shared/EventBus.js');
const {
  LYRIC_DISPLAY_MODES,
  lyricTranslationManager,
} = await import('../src/shared/LyricTranslationManager.js');

test('three-way lyric display preference persists and emits only on changes', () => {
  const changes = [];
  const unsubscribe = eventBus.on('lyric:translationChanged', event => changes.push(event));

  assert.equal(lyricTranslationManager.mode, LYRIC_DISPLAY_MODES.BOTH);
  assert.equal(lyricTranslationManager.enabled, true);
  lyricTranslationManager.setMode(LYRIC_DISPLAY_MODES.TRANSLATION);
  lyricTranslationManager.setMode(LYRIC_DISPLAY_MODES.TRANSLATION);

  assert.equal(values.get('minerats-lyric-display-mode'), 'translation');
  assert.deepEqual(changes, [{ mode: 'translation', enabled: true }]);

  lyricTranslationManager.setEnabled(false);
  assert.equal(lyricTranslationManager.mode, LYRIC_DISPLAY_MODES.ORIGINAL);
  assert.equal(values.get('minerats-lyric-display-mode'), 'original');
  unsubscribe();
});

test('visual settings exposes all three persistent lyric display modes', async () => {
  const source = await readFile(
    new URL('../src/player/VisualSettings.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /role="radiogroup"/);
  assert.match(source, /LYRIC_DISPLAY_MODES\.ORIGINAL/);
  assert.match(source, /LYRIC_DISPLAY_MODES\.TRANSLATION/);
  assert.match(source, /LYRIC_DISPLAY_MODES\.BOTH/);
  assert.match(source, /lyricTranslationManager\.setMode\(btn\.dataset\.lyricMode\)/);
  assert.match(source, /aria-checked/);
});

test('lyric stage gives translation-only the full primary lyric effects', async () => {
  const source = await readFile(
    new URL('../src/visual/LyricStage.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /mode === LYRIC_DISPLAY_MODES\.TRANSLATION/);
  assert.match(source, /primaryText = translated \|\| original/);
  assert.match(source, /_buildGroup\(primaryText, secondaryText, true\)/);
});

test('bilingual translation matches the primary material except for size and position', async () => {
  const source = await readFile(
    new URL('../src/visual/LyricStage.js', import.meta.url),
    'utf8',
  );

  assert.match(source, /mode === LYRIC_DISPLAY_MODES\.BOTH/);
  assert.match(source, /secondaryText = translated/);
  assert.match(source, /_buildTranslationTex/);
  assert.match(source, /ctx\.font = `bold \$\{fs\}px/);
  assert.match(source, /grad\.addColorStop\(0, pal\.textGradTop\)/);
  assert.match(source, /grad\.addColorStop\(0\.5, pal\.textGradBottom\)/);
  assert.match(source, /ctx\.shadowColor = pal\.glowShadow/);
  assert.match(source, /translatedM = new THREE\.ShaderMaterial/);
  assert.match(source, /translatedText = new THREE\.Mesh/);
  assert.match(source, /_translationKaraokeMat\.uniforms\.uProgress\.value/);
  assert.match(source, /translatedGlowTarget/);
  assert.match(source, /translatedGlowTarget = 0\.22 \+ this\._beatGlow \* 1\.6/);
  assert.match(source, /translatedText\.scale\.set\(newS, newS, 1\)/);
  assert.match(source, /lyric:translationChanged/);
});
