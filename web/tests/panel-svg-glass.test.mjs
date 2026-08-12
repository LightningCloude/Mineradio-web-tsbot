import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('search, queue and both settings panels have dedicated SVG glass filters', async () => {
  const html = await read('../index.html');

  for (const name of ['search', 'queue', 'cookie', 'visual']) {
    assert.match(html, new RegExp(`id="minerats-${name}-glass"`));
    assert.match(html, new RegExp(`id="${name}-glass-map"`));
  }
});

test('panel glass surfaces use a dark glass tint and their matching filters', async () => {
  const css = await read('../src/style.css');
  const expected = [
    ['#search-overlay \\.search-panel', 'search'],
    ['#queue-panel', 'queue'],
    ['#cookie-overlay \\.search-panel', 'cookie'],
    ['\\.vis-settings-panel', 'visual'],
  ];

  for (const [selector, name] of expected) {
    assert.match(
      css,
      new RegExp(`html\\.glass-svg-ok ${selector} \\{[\\s\\S]*?background: linear-gradient\\(145deg, rgba\\(12,13,18,\\.92\\), rgba\\(2,3,7,\\.88\\)\\);[\\s\\S]*?url\\(#minerats-${name}-glass\\)`),
    );
  }
  assert.doesNotMatch(css, /html\\.glass-svg-ok (?:#search-overlay|#queue-panel|#cookie-overlay|\\.vis-settings-panel)[\\s\\S]*?background: transparent;/);
});

test('glass maps refresh when hidden panels open and queue is portalled outside the player glass', async () => {
  const glass = await read('../src/shared/GlassFilter.js');
  const queue = await read('../src/player/QueuePanel.js');

  for (const name of ['search', 'queue', 'cookie', 'visual']) {
    assert.match(glass, new RegExp(`'${name}-glass-map'`));
  }
  assert.match(glass, /eventBus\.on\('ui:changed'/);
  assert.match(queue, /document\.body\.appendChild\(this\.container\)/);
  assert.match(queue, /_positionPanel\(\)/);
  assert.doesNotMatch(queue, /btn\.appendChild\(this\.container\)/);
});
