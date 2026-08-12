export const LYRIC_SYNC_LEAD_SECONDS = 0.5;

export function getLyricTimelinePosition(playbackPosition) {
  const position = Number.isFinite(playbackPosition) ? playbackPosition : 0;
  return Math.max(0, position + LYRIC_SYNC_LEAD_SECONDS);
}

export function getLyricLineProgress(playbackPosition, lineStart, lineEnd) {
  const start = Number.isFinite(lineStart) ? lineStart : 0;
  const end = Number.isFinite(lineEnd) ? lineEnd : start + 4;
  const duration = Math.max(0.5, end - start);
  const elapsed = getLyricTimelinePosition(playbackPosition) - start;
  return Math.max(0, Math.min(1, elapsed / duration));
}
