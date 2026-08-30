import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';


test('credential and visual settings controls use distinct semantic icons', async () => {
  const source = await readFile(
    new URL('../src/player/PlayerUI.js', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /data-action="cookie" data-icon="credentials" title="QQ 音乐登录凭据" aria-label="QQ 音乐登录凭据"/,
  );
  assert.match(
    source,
    /data-action="vis-settings" data-icon="visual-tuning" title="视觉设置" aria-label="视觉设置"/,
  );
  assert.match(source, /data-icon="credentials"[\s\S]*?<circle cx="7\.5" cy="15\.5"/);
  assert.match(source, /data-icon="visual-tuning"[\s\S]*?<circle cx="10" cy="6"/);
});
