import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCoverUrl } from '../src/shared/CoverUrl.js';


test('routes QQ cover CDN URLs through the same-origin proxy', () => {
  assert.equal(
    resolveCoverUrl(
      'https://y.gtimg.cn/music/photo_new/T002R300x300M000003c3hnQ2Jmdt0.jpg',
    ),
    '/cover/T002R300x300M000003c3hnQ2Jmdt0.jpg',
  );
  assert.equal(
    resolveCoverUrl(
      '//y.gtimg.cn/music/photo_new/T002R300x300M000album.jpg?max_age=2592000',
    ),
    '/cover/T002R300x300M000album.jpg?max_age=2592000',
  );
});


test('leaves same-origin and unrelated cover URLs unchanged', () => {
  assert.equal(resolveCoverUrl('/cover/existing.jpg'), '/cover/existing.jpg');
  assert.equal(
    resolveCoverUrl('https://example.com/music/photo_new/cover.jpg'),
    'https://example.com/music/photo_new/cover.jpg',
  );
  assert.equal(resolveCoverUrl(''), '');
});
