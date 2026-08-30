function valuesFor(song) {
  if (!song) return [];
  return [song.track_id, song.queue_id, song.song_mid, song.mid, song.id]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(String);
}

export function resolveSongAudioSource(song) {
  if (!song) return null;
  return song.source_url || song.audio_url || song.url || null;
}

/** Route QQ audio through the fixed same-origin proxy used for browser analysis. */
export function resolveSongAnalysisSource(song) {
  const source = resolveSongAudioSource(song);
  if (!source) return null;
  try {
    const parsed = new URL(source, globalThis.location?.href || 'http://localhost/');
    if (parsed.hostname.toLowerCase() === 'aqqmusic.tc.qq.com') {
      return `/audio/qq${parsed.pathname}${parsed.search}`;
    }
  } catch (_) {
    return source;
  }
  return source;
}

/** Preserve the direct stream URL when sparse WebSocket song payloads arrive. */
export function inheritSongAudioSource(song, previousSong = null, queue = []) {
  const next = { ...(song || {}) };
  const ownUrl = resolveSongAudioSource(next);
  if (ownUrl) {
    next.source_url = ownUrl;
    return next;
  }

  const ids = new Set(valuesFor(next));
  const previousMatches = valuesFor(previousSong).some(id => ids.has(id));
  const previousUrl = previousMatches ? resolveSongAudioSource(previousSong) : null;
  if (previousUrl) {
    next.source_url = previousUrl;
    return next;
  }

  const queueItem = Array.isArray(queue)
    ? queue.find(item => valuesFor(item).some(id => ids.has(id)))
    : null;
  const queueUrl = resolveSongAudioSource(queueItem);
  if (queueUrl) next.source_url = queueUrl;
  return next;
}
