import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { api } from './ApiClient.js';
import { inheritSongAudioSource } from './SongAudioSource.js';
import { buildWebSocketProtocols } from './WebSocketAuth.js';

/**
 * WebSocket client — receives playback progress, fetches lyrics on song change.
 */
export class WsClient {
  constructor() {
    this.ws = null;
    this._reconnectDelay = 1000;
    this._maxDelay = 30000;
    this._intentionalClose = false;
    this._heartbeat = null;
    this._lastTrackId = null;
    this._queueRefreshTick = 0;
    this._lastSongTitle = null;
    // ── Position interpolation (WS sends every ~1s, too coarse for lyric karaoke) ──
    this._wsPosTime = 0;          // last WS position (seconds)
    this._wsLocalTs = 0;          // performance.now() when we got that position
    this._interpRunning = false;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/status`;
    const protocols = buildWebSocketProtocols(localStorage.getItem('tsbot_api_token'));

    try {
      this.ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
    } catch (e) {
      console.error('[WsClient] Connection failed:', e);
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      state.updateConnection({ wsConnected: true });
      this._reconnectDelay = 1000;
      eventBus.emit('toast', { message: '', level: 'info', clear: true });
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this._handleMessage(msg);
      } catch (e) {
        console.error('[WsClient] Parse error:', e);
      }
    };

    this.ws.onclose = () => {
      state.updateConnection({ wsConnected: false });
      if (!this._intentionalClose) this._scheduleReconnect();
    };

    this.ws.onerror = () => {};
  }

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'started':
      case 'progress': {
        const previousSong = state.playback.song;
        let song = inheritSongAudioSource(
          msg.song || previousSong || {},
          previousSong,
          state.queue,
        );
        const trackId = song && song.track_id;

        // ── Preserve existing cover: WS may send empty artwork_url after refresh ──
        if ((!song.cover || song.cover === '') && state.playback.song && state.playback.song.cover) {
          song.cover = state.playback.song.cover;
        }

        if (msg.type === 'started' || (trackId && trackId !== this._lastTrackId)) {
          this._lastTrackId = trackId;
          this._fetchLyrics(trackId);
        }
        this._tickQueueRefresh();

        // Fill missing cover: try queue first, then external/status
        if (song && !(song.cover && song.cover.length > 4) && trackId != null) {
          this._ensureCover(song, trackId);
        }

        state.updatePlayback({
          status: msg.type === 'started' ? 'started' : (msg.state === 'paused' ? 'paused' : 'playing'),
          position: msg.position || 0,
          song: song,
          bpm: (song && song.bpm) || state.playback.bpm || 120,
        });
        if (msg.position !== undefined) {
          state.syncLyrics(msg.position + 0.5);
        }
        break;
      }

      case 'finished':
        state.updatePlayback({ status: 'finished', position: 0, song: null });
        state.updateLyrics([]);
        this._lastTrackId = null;
        this._refreshQueue();
        break;

      case 'paused':
        state.updatePlayback({ status: 'paused' });
        break;

      case 'queue_update':
        state.updateQueue(msg.queue || []);
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  async _ensureCover(song, trackId) {
    // Try queue data
    const qi = (state.queue || []).find(
      q => q.id === trackId || q.track_id === trackId || q.song_mid === trackId
    );
    if (qi && (qi.artwork || qi.cover_url || qi.artwork_url)) {
      const url = qi.artwork || qi.cover_url || qi.artwork_url;
      song.cover = url;
      eventBus.emit('cover:load', url);
      return;
    }
    // Try external/status (has queue_preview with artwork)
    try {
      const status = await api.getStatus();
      const qp = status && status.queue_preview;
      if (qp) {
        const item = qp.find(q => q.id === trackId);
        if (item && (item.artwork || item.artwork_url)) {
          const url = item.artwork || item.artwork_url;
          song.cover = url;
          eventBus.emit('cover:load', url);
          return;
        }
      }
      // Also check if status itself has artwork_url for current track
      if (status && status.artwork_url && status.track_id === trackId) {
        song.cover = status.artwork_url;
        eventBus.emit('cover:load', status.artwork_url);
      }
    } catch (e) { /* ignore */ }
  }

  async _fetchLyrics(queueItemId) {
    try {
      const data = await api.getLyrics(queueItemId);
      const lines = (data && data.lyrics) || [];
      state.updateLyrics(lines);
    } catch (e) {
      console.warn('[WsClient] Failed to fetch lyrics for item', queueItemId);
    }
  }

  _tickQueueRefresh() {
    this._queueRefreshTick++;
    if (this._queueRefreshTick >= 5) {
      this._queueRefreshTick = 0;
      this._refreshQueue();
    }
  }

  async _refreshQueue() {
    try {
      const data = await api.getQueue();
      const raw = data.items || data.queue || data || [];
      // Normalize: ensure artwork field carries cover URL
      const items = raw.map(q => ({ ...q, artwork: q.artwork || q.cover_url || q.artwork_url || '' }));
      const firstTitle = items[0] && items[0].title;
      if (firstTitle && firstTitle !== this._lastSongTitle) {
        this._lastSongTitle = firstTitle;
        setTimeout(() => {
          api.getQueue().then(d => {
            const r2 = (d && d.items) || (d && d.queue) || d || [];
            state.updateQueue(r2.map(q => ({ ...q, artwork: q.artwork || q.cover_url || '' })));
          }).catch(() => {});
        }, 1500);
      }
      state.updateQueue(items);
    } catch (e) { /* ignore */ }
  }

  _scheduleReconnect() {
    eventBus.emit('toast', { message: '连接中断，正在重连...', level: 'warn' });
    setTimeout(() => {
      if (!this._intentionalClose) this.connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this.ws) { this.ws.close(); this.ws = null; }
  }

  startHeartbeat() {
    this._heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send('ping');
    }, 30000);
  }
}

export const wsClient = new WsClient();
