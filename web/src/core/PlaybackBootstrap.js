/** Initial HTTP snapshots may arrive after live WebSocket state; never replace newer state. */
export function bootstrapPlayback({ apiClient, stateManager, bus }) {
  const playback = stateManager.playback;
  const queueRevision = stateManager.queueRevision;

  const statusTask = apiClient.getStatus({ silent: true }).then(status => {
    if (stateManager.playback !== playback || !status) return false;
    if (status.volume_percent != null && Number.isFinite(Number(status.volume_percent))) {
      bus.emit('volume:changed', Number(status.volume_percent));
    }
    if (status.now_playing_title) {
      stateManager.updatePlayback({
        status: status.state === 'playing' ? 'playing' : 'paused',
        position: status.current_time || 0,
        song: {
          track_id: status.track_id,
          queue_id: status.track_id,
          title: status.now_playing_title,
          artist: status.now_playing_artist,
          album: status.now_playing_album,
          cover: status.artwork_url,
          source_url: status.now_playing_source_url,
          duration: status.duration,
          bpm: 120,
        },
        bpm: 120,
      });
    }
    return true;
  });

  const queueTask = apiClient.getQueue({ silent: true }).then(data => {
    const items = data?.items || data?.queue || data || [];
    if (!Array.isArray(items)) return false;
    return stateManager.updateQueue(items, { expectedRevision: queueRevision });
  });

  return Promise.allSettled([statusTask, queueTask]);
}
