import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { buildQQLoginCheckQuery } from './QQLoginContract.js';

const BASE = '/api';

async function request(method, path, body = null, options = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  const token = localStorage.getItem('tsbot_api_token');
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (options.admin) {
    const adminToken = localStorage.getItem('tsbot_admin_token');
    if (adminToken) opts.headers['x-admin-token'] = adminToken;
  }
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(`${BASE}${path}`, opts);
  } catch (e) {
    state.updateConnection({ apiReachable: false });
    if (!options.silent) {
      eventBus.emit('toast', { message: '无法连接到服务器', level: 'error' });
    }
    throw e;
  }

  state.updateConnection({ apiReachable: true });

  if (res.status === 401) {
    eventBus.emit('toast', { message: 'API Token 未配置或已过期', level: 'error' });
    eventBus.emit('auth:token_required');
    const error = new Error('API Token 未配置或已过期');
    error.status = res.status;
    throw error;
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    if (res.status === 403 && options.admin) {
      eventBus.emit('auth:admin_token_required');
    }
    if (!options.silent) {
      eventBus.emit('toast', { message: err.detail || '请求失败', level: 'error' });
    }
    const error = new Error(err.detail || `HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return res.json();
}

export const api = {
  search(keyword) {
    return request('GET', `/external/search?keywords=${encodeURIComponent(keyword)}&source=qqmusic`);
  },

  getQueue() {
    return request('GET', '/external/queue');
  },

  addToQueue(songMid, meta = {}) {
    return request('POST', '/external/queue', {
      song_mid: songMid,
      source: 'qqmusic',
      play_now: meta.playNow || false,
      title: meta.title || '',
      artist: meta.artist || '',
      duration_ms: meta.duration_ms || 0,
      cover_url: meta.cover_url || meta.artwork_url || '',
    });
  },

  removeFromQueue(index) {
    return request('DELETE', `/external/queue/${index}`);
  },

  playerAction(action) {
    return request('POST', '/external/player/action', { action });
  },

  setVolume(volume) {
    return request('PUT', '/voice/volume', { volume_percent: volume });
  },

  skip() {
    return this.playerAction('next');
  },

  getHistory() {
    return request('GET', '/external/history');
  },

  getStatus() {
    return request('GET', '/external/status');
  },

  getBeatAnalysis(songName) {
    return request(
      'GET',
      `/visual/beat-cache?name=${encodeURIComponent(songName)}`,
      null,
      { silent: true },
    );
  },

  storeBeatAnalysis(songName, result) {
    return request(
      'POST',
      '/visual/beat-cache',
      { name: songName, result },
      { silent: true },
    );
  },

  getQQLoginQR() {
    return request('GET', '/qqmusic/login/qr/key');
  },

  checkQQLogin(qrSession) {
    const query = buildQQLoginCheckQuery(qrSession);
    return request('GET', `/qqmusic/login/qr/check?${query}`, null, { silent: true });
  },

  confirmQQLogin(authUrl) {
    return request('POST', '/admin/qqmusic/qr/confirm', { auth_url: authUrl }, { admin: true });
  },

  getQQCookieStatus() {
    return request('GET', '/admin/qqmusic/status', null, { admin: true });
  },

  getLyrics(queueItemId) {
    return request('GET', `/lyrics/${queueItemId}`);
  },

  saveQQCookie(cookie) {
    return request('POST', '/admin/qqmusic/cookie', { cookie }, { admin: true });
  },

  clearQQCookie() {
    return request('DELETE', '/admin/qqmusic/cookie', null, { admin: true });
  },
};
