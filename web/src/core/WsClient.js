import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { api } from './ApiClient.js';
import { inheritSongAudioSource } from './SongAudioSource.js';
import { buildWebSocketProtocols } from './WebSocketAuth.js';
import { LatestRequest } from './LatestRequest.js';

const sameTrack = (left, right) => left != null && right != null && String(left) === String(right);
const normalizeQueue = (data) => {
  const raw = data?.items || data?.queue || data || [];
  return Array.isArray(raw)
    ? raw.map(q => ({ ...q, artwork: q.artwork || q.cover_url || q.artwork_url || '' }))
    : [];
};

/**
 * WebSocket client — receives playback progress, fetches lyrics on song change.
 */
export class WsClient {
  constructor({ stateManager = state, bus = eventBus, apiClient = api,
    socketClass = globalThis.WebSocket, random = Math.random } = {}) {
    this._state = stateManager;
    this._bus = bus;
    this._api = apiClient;
    this._Socket = socketClass;
    this._random = random;
    this.ws = null;
    this._reconnectDelay = 1000;
    this._maxDelay = 30000;
    this._intentionalClose = false;
    this._heartbeat = null;
    this._reconnectTimer = null;
    this._queueFollowupTimer = null;
    this._lyricsRequest = new LatestRequest();
    this._coverRequest = new LatestRequest();
    this._queueRequest = new LatestRequest();
    this._coverTrackId = null;
    this._lastTrackId = null;
    this._queueRefreshTick = 0;
    this._lastSongTitle = null;
    // ── Position interpolation (WS sends every ~1s, too coarse for lyric karaoke) ──
    this._wsPosTime = 0;          // last WS position (seconds)
    this._wsLocalTs = 0;          // performance.now() when we got that position
    this._interpRunning = false;
  }

  connect() {
    if (this.ws && (this.ws.readyState === this._Socket.OPEN
      || this.ws.readyState === this._Socket.CONNECTING)) return;
    this._intentionalClose = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${location.host}/ws/status`;
    const protocols = buildWebSocketProtocols(localStorage.getItem('tsbot_api_token'));

    try {
      this.ws = protocols ? new this._Socket(url, protocols) : new this._Socket(url);
    } catch (e) {
      console.error('[WsClient] Connection failed:', e);
      this._scheduleReconnect();
      return;
    }

    const socket = this.ws;
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this._state.updateConnection({ wsConnected: true });
      this._reconnectDelay = 1000;
      this._bus.emit('toast', { message: '', level: 'info', clear: true });
    };

    socket.onmessage = (evt) => {
      if (this.ws !== socket) return;
      try {
        const msg = JSON.parse(evt.data);
        this._handleMessage(msg).catch(error => {
          console.error('[WsClient] Message handling failed:', error);
        });
      } catch (e) {
        console.error('[WsClient] Parse error:', e);
      }
    };

    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this._cancelRequests();
      this._lastTrackId = null;
      this._state.updateConnection({ wsConnected: false });
      if (!this._intentionalClose) this._scheduleReconnect();
    };

    socket.onerror = () => {};
  }

  async _handleMessage(msg) {
    switch (msg.type) {
      case 'started':
      case 'progress': {
        const previousSong = this._state.playback.song;
        let song = inheritSongAudioSource(
          msg.song || previousSong || {},
          previousSong,
          this._state.queue,
        );
        const trackId = song && song.track_id;

        // ── Preserve existing cover: WS may send empty artwork_url after refresh ──
        if (!song.cover && sameTrack(trackId, previousSong?.track_id) && previousSong.cover) {
          song.cover = previousSong.cover;
        }

        const trackChanged = trackId != null && !sameTrack(trackId, this._lastTrackId);
        if (trackChanged) {
          this._lyricsRequest.cancel();
          this._coverRequest.cancel();
          this._coverTrackId = null;
          this._lastTrackId = trackId;
          this._state.updateLyrics([]);
        }
        this._tickQueueRefresh();

        this._state.updatePlayback({
          status: msg.type === 'started' ? 'started' : (msg.state === 'paused' ? 'paused' : 'playing'),
          position: msg.position || 0,
          song: song,
          bpm: (song && song.bpm) || this._state.playback.bpm || 120,
        });
        if (trackId != null && (trackChanged || msg.type === 'started')) this._fetchLyrics(trackId);
        // Do not launch overlapping status reads for each progress event.
        if (!(song.cover && song.cover.length > 4) && trackId != null
          && !sameTrack(trackId, this._coverTrackId)) this._ensureCover(song, trackId);
        if (msg.position !== undefined) {
          this._state.syncLyrics(msg.position + 0.5);
        }
        break;
      }

      case 'finished':
        this._cancelRequests();
        this._state.updatePlayback({ status: 'finished', position: 0, song: null });
        this._state.updateLyrics([]);
        this._lastTrackId = null;
        this._refreshQueue();
        break;

      case 'paused':
        this._state.updatePlayback({ status: 'paused' });
        break;

      case 'queue_update':
        this._queueRequest.cancel();
        clearTimeout(this._queueFollowupTimer);
        this._state.updateQueue(msg.queue || []);
        break;

      case 'pong':
        break;

      default:
        break;
    }
  }

  async _ensureCover(song, trackId) {
    const request = this._coverRequest.begin();
    this._coverTrackId = trackId;
    const applyCover = (url) => {
      if (!request.isCurrent() || !sameTrack(this._state.playback.song?.track_id, trackId)) return;
      song.cover = url;
      this._state.playback.song.cover = url;
      this._bus.emit('cover:load', url);
    };
    // Try queue data
    const qi = (this._state.queue || []).find(
      q => [q.id, q.track_id, q.song_mid].some(id => sameTrack(id, trackId))
    );
    if (qi && (qi.artwork || qi.cover_url || qi.artwork_url)) {
      const url = qi.artwork || qi.cover_url || qi.artwork_url;
      applyCover(url);
      this._coverTrackId = null;
      return;
    }
    // Try external/status (has queue_preview with artwork)
    try {
      const status = await this._api.getStatus({ signal: request.signal, silent: true });
      if (!request.isCurrent()) return;
      const qp = status && status.queue_preview;
      if (qp) {
        const item = qp.find(q => sameTrack(q.id, trackId));
        if (item && (item.artwork || item.artwork_url || item.cover_url)) {
          const url = item.artwork || item.artwork_url || item.cover_url;
          applyCover(url);
          return;
        }
      }
      // Also check if status itself has artwork_url for current track
      if (status && status.artwork_url && sameTrack(status.track_id, trackId)) {
        applyCover(status.artwork_url);
      }
    } catch (e) { /* Missing covers do not interrupt playback. */ }
    finally { if (request.isCurrent()) this._coverTrackId = null; }
  }

  async _fetchLyrics(queueItemId) {
    const request = this._lyricsRequest.begin();
    try {
      const data = await this._api.getLyrics(queueItemId, { signal: request.signal, silent: true });
      if (!request.isCurrent() || !sameTrack(this._state.playback.song?.track_id, queueItemId)) return;
      const lines = (data && data.lyrics) || [];
      this._state.updateLyrics(lines);
    } catch (e) {
      if (request.isCurrent()) console.warn('[WsClient] Failed to fetch lyrics for item', queueItemId);
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
    const request = this._queueRequest.begin();
    const revision = this._state.queueRevision;
    clearTimeout(this._queueFollowupTimer);
    try {
      const data = await this._api.getQueue({ signal: request.signal, silent: true });
      if (!request.isCurrent() || this._state.queueRevision !== revision) return;
      const items = normalizeQueue(data);
      if (!this._state.updateQueue(items, { expectedRevision: revision })) return;
      const firstTitle = items[0] && items[0].title;
      if (firstTitle && firstTitle !== this._lastSongTitle) {
        this._lastSongTitle = firstTitle;
        const updatedRevision = this._state.queueRevision;
        this._queueFollowupTimer = setTimeout(() => {
          this._queueFollowupTimer = null;
          if (request.isCurrent() && this._state.queueRevision === updatedRevision) this._refreshQueue();
        }, 1500);
      }
    } catch (e) { /* ignore */ }
  }

  _scheduleReconnect() {
    if (this._intentionalClose || this._reconnectTimer !== null) return;
    this._bus.emit('toast', { message: '连接中断，正在重连...', level: 'warn' });
    const delay = this._reconnectDelay * (0.8 + this._random() * 0.4);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._intentionalClose) this.connect();
    }, delay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this._maxDelay);
  }

  disconnect() {
    this._intentionalClose = true;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._cancelRequests();
    this._lastTrackId = null;
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = null;
    const socket = this.ws;
    this.ws = null;
    socket?.close();
    this._state.updateConnection({ wsConnected: false });
  }

  startHeartbeat() {
    if (this._heartbeat) clearInterval(this._heartbeat);
    this._heartbeat = setInterval(() => {
      if (this.ws && this.ws.readyState === this._Socket.OPEN) {
        try { this.ws.send('ping'); } catch { /* onclose handles reconnection. */ }
      }
    }, 30000);
  }

  _cancelRequests() {
    this._lyricsRequest.cancel();
    this._coverRequest.cancel();
    this._queueRequest.cancel();
    this._coverTrackId = null;
    clearTimeout(this._queueFollowupTimer);
    this._queueFollowupTimer = null;
  }
}

export const wsClient = new WsClient();
