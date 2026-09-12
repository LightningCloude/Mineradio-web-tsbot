import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('volume slider stays at 0-100 while output is capped at 25', async () => {
  const source = await readFile(new URL('../src/player/PlayerUI.js', import.meta.url), 'utf8');
  assert.match(source, /const VOLUME_SLIDER_MAX = 100/);
  assert.match(source, /const VOLUME_OUTPUT_MAX = 25/);
  assert.match(source, /max="\$\{VOLUME_SLIDER_MAX\}"/);
  assert.match(source, /api\.setVolume\(sliderToOutputVolume\(sliderValue\)\)/);
  assert.match(source, /const value = outputToSliderVolume\(volume\)/);
  assert.doesNotMatch(source, /max="200"|WEB_VOLUME_MAX/);
});
