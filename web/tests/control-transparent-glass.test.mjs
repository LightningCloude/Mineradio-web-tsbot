import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';


test('status-bar controls reveal the parent SVG glass without a nested backdrop', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const glassSource = await readFile(
    new URL('../src/shared/GlassFilter.js', import.meta.url),
    'utf8',
  );

  const controlRule = css.match(
    /html\.glass-svg-ok \.player-bar \.ctrl-btn\s*\{([^}]*)\}/,
  );
  assert.ok(controlRule, 'control glass rule should exist');
  assert.match(controlRule[1], /background:\s*transparent/);
  assert.match(controlRule[1], /backdrop-filter:\s*none/);
  assert.doesNotMatch(html, /minerats-control-glass|control-glass-map/);
  assert.doesNotMatch(glassSource, /control-glass-map|controlKey/);
});


test('hover and play controls remain transparent', async () => {
  const css = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');

  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-btn:hover\s*\{[^}]*background:\s*transparent/,
  );
  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-btn:hover\s*\{[^}]*transform:\s*translateY\(-2px\)\s*scale\(1\.06\)/,
  );
  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-btn:hover\s*\{[^}]*border-color:\s*rgba\(255,255,255,0\.52\)/,
  );
  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-play:hover\s*\{[^}]*background:\s*transparent/,
  );
  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-play:hover\s*\{[^}]*transform:\s*translateY\(-2px\)\s*scale\(1\.06\)/,
  );
  assert.match(
    css,
    /html\.glass-svg-ok \.player-bar \.ctrl-play:hover\s*\{[^}]*border-color:\s*rgba\(255,255,255,0\.52\)/,
  );
});
