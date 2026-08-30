import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  formatWallpaperSize,
  normalizeWallpaperRecord,
} from '../src/core/LocalWallpaperStore.js';


test('normalizes both legacy blobs and structured local wallpaper records', () => {
  const blob = new Blob(['video-bytes'], { type: 'video/mp4' });

  const legacy = normalizeWallpaperRecord(blob);
  assert.equal(legacy.blob, blob);
  assert.equal(legacy.name, '本地视频');

  const structured = normalizeWallpaperRecord({
    blob,
    name: 'wallpaper.mp4',
    updatedAt: 42,
  });
  assert.deepEqual(structured, {
    blob,
    name: 'wallpaper.mp4',
    updatedAt: 42,
  });
  assert.equal(normalizeWallpaperRecord({ blob: 'not-a-blob' }), null);
});


test('formats local wallpaper sizes for the settings UI', () => {
  assert.equal(formatWallpaperSize(512 * 1024), '512.0 KB');
  assert.equal(formatWallpaperSize(2.5 * 1024 * 1024), '2.5 MB');
});


test('the player never requests a server-provided wallpaper', async () => {
  const mainSource = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  const settingsSource = await readFile(
    new URL('../src/player/VisualSettings.js', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(mainSource, /Horizon\.mp4|_cacheVideo|Background video cached locally/);
  assert.doesNotMatch(settingsSource, /Horizon\.mp4/);
  assert.match(settingsSource, /type="file"/);
  assert.match(settingsSource, /saveLocalWallpaper/);
  assert.match(settingsSource, /URL\.revokeObjectURL/);
  assert.match(settingsSource, /clearLocalWallpaper/);
});
