import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Vite stays on the patched 8.2 line and matches the lockfile requirement', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const vite = lock.packages['node_modules/vite'];
  const [major, minor, patch] = vite.version.split('.').map(Number);
  // October 2026 Vite advisories include 8.2.0–8.2.3; 8.2.4 is patched.
  assert.equal(manifest.devDependencies.vite, '~8.2.4');
  assert.equal(lock.packages[''].devDependencies.vite, manifest.devDependencies.vite);
  assert.ok(major === 8 && minor === 2 && patch >= 4);
  assert.equal(vite.dev, true, 'Vite must remain a build-only dependency');
  assert.ok(vite.resolved.startsWith('https://registry.npmjs.org/vite/'));
  assert.ok(vite.integrity.startsWith('sha512-'));
});

test('source-map-js stays above the indexed source-map DoS vulnerable range', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const sourceMap = lock.packages['node_modules/source-map-js'];
  const [major, minor, patch] = sourceMap.version.split('.').map(Number);
  // GHSA-68fv-2mgg-jv7q: versions >=1.0.0 and <1.2.2 are affected.
  assert.ok(major > 1 || (major === 1 && (minor > 2 || (minor === 2 && patch >= 2))));
  assert.equal(sourceMap.dev, true, 'source-map-js must remain a build-only dependency');
});
