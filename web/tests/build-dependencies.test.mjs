import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('source-map-js stays above the indexed source-map DoS vulnerable range', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const sourceMap = lock.packages['node_modules/source-map-js'];
  const [major, minor, patch] = sourceMap.version.split('.').map(Number);
  // GHSA-68fv-2mgg-jv7q: versions >=1.0.0 and <1.2.2 are affected.
  assert.ok(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 2))));
  assert.equal(sourceMap.dev, true, 'source-map-js must remain a build-only dependency');
});
