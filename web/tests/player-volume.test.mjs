import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('web volume control is capped at one quarter of its former range', async () => {
  const source = await readFile(new URL('../src/player/PlayerUI.js', import.meta.url), 'utf8');
  assert.match(source, /const WEB_VOLUME_MAX = 50/);
  assert.match(source, /max="\$\{WEB_VOLUME_MAX\}"/);
  assert.match(source, /Math\.min\(WEB_VOLUME_MAX, Number\(volume\)/);
  assert.doesNotMatch(source, /max="200"|Math\.min\(200, Number\(volume\)/);
});
