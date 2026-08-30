import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLyricLineProgress,
  getLyricTimelinePosition,
  LYRIC_SYNC_LEAD_SECONDS,
} from '../src/shared/LyricTiming.js';

test('karaoke progress uses the same lead time as lyric switching', () => {
  const nextLineStart = 8;
  const switchPlaybackPosition = nextLineStart - LYRIC_SYNC_LEAD_SECONDS;

  assert.equal(getLyricTimelinePosition(switchPlaybackPosition), nextLineStart);
  assert.equal(getLyricLineProgress(switchPlaybackPosition, 0, nextLineStart), 1);
  assert.equal(getLyricLineProgress(switchPlaybackPosition, nextLineStart, 12), 0);
});

test('karaoke progress remains clamped around a lyric line', () => {
  assert.equal(getLyricLineProgress(-2, 4, 8), 0);
  assert.equal(getLyricLineProgress(20, 4, 8), 1);
});
