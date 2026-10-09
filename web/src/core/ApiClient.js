import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { buildQQLoginCheckQuery } from './QQLoginContract.js';

const BASE = '/api';

/** HTTP requests have one deadline covering headers and response decoding. No action retries. */
export function createApiClient({
  fetchImpl = (...args) => fetch(...args),
  storage = globalThis.localStorage,
  stateManager = state,
  bus = eventBus,
  timeoutMs = 20000,
} = {}) {
  async function request(method, path, body = null, options = {}) {
    const controller = new AbortController();
    const readToken = (key) => {
      try { return storage?.getItem(key); } catch { return null; }
    };
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    };
    const token = readToken('tsbot_api_token');
    if (token) opts.headers['Authorization'] = `Bearer ${token}`;
    if (options.admin) {
      const adminToken = readToken('tsbot_admin_token');
      if (adminToken) opts.headers['x-admin-token'] = adminToken;
    }
    if (body) opts.body = JSON.stringify(body);

    let expired = false;
    let rejectAbort;
    const interrupted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => {
      controller.abort();
      rejectAbort(new DOMException('Request cancelled', 'AbortError'));
    };
    const deadline = setTimeout(() => {
      expired = true;
      controller.abort();
      rejectAbort(new DOMException('Request timed out', 'TimeoutError'));
    }, Math.max(1, options.timeoutMs ?? timeoutMs));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (options.signal?.aborted) onAbort();
      const res = await Promise.race([
        options.signal?.aborted ? interrupted : fetchImpl(`${BASE}${path}`, opts),
        interrupted,
      ]);
      stateManager.updateConnection({ apiReachable: true });

      if (res.status === 401) {
        if (options.admin) {
          bus.emit('auth:admin_token_required');
          const error = new Error('请先登录管理员账号或配置 Admin Token');
          error.status = res.status;
          throw error;
        }
        bus.emit('toast', { message: 'API Token 未配置或已过期', level: 'error' });
        bus.emit('auth:token_required');
        const error = new Error('API Token 未配置或已过期');
        error.status = res.status;
        throw error;
      }

      if (!res.ok) {
        const err = await Promise.race([
          res.json().catch(() => ({ detail: res.statusText })), interrupted,
        ]);
        if (res.status === 403 && options.admin) {
          bus.emit('auth:admin_token_required');
        }
        if (!options.silent) {
          bus.emit('toast', { message: err.detail || '请求失败', level: 'error' });
        }
        const error = new Error(err.detail || `HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }

      return await Promise.race([res.status === 204 ? Promise.resolve(null) : res.json(), interrupted]);
    } catch (error) {
      // Superseded reads are normal: they must not show errors or mark the API offline.
      if (options.signal?.aborted && !expired) throw error;
      if (expired || (!error.status && error.name !== 'SyntaxError')) {
        stateManager.updateConnection({ apiReachable: false });
        if (!options.silent) {
          bus.emit('toast', {
            message: expired ? '服务器响应超时，请稍后重试' : '无法连接到服务器',
            level: 'error',
          });
        }
      }
      if (expired) throw new DOMException('Request timed out', 'TimeoutError');
      throw error;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  return {
    search(keyword, options = {}) {
      return request('GET', `/external/search?keywords=${encodeURIComponent(keyword)}&source=qqmusic`, null, options);
    },

    getQueue(options = {}) {
      return request('GET', '/external/queue', null, options);
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

    getStatus(options = {}) {
      return request('GET', '/external/status', null, options);
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

    getQQCookieStatus(options = {}) {
      return request('GET', '/admin/qqmusic/status', null, { ...options, admin: true });
    },

    getLyrics(queueItemId, options = {}) {
      return request('GET', `/lyrics/${encodeURIComponent(queueItemId)}`, null, options);
    },

    saveQQCookie(cookie) {
      return request('POST', '/admin/qqmusic/cookie', { cookie }, { admin: true });
    },

    clearQQCookie() {
      return request('DELETE', '/admin/qqmusic/cookie', null, { admin: true });
    },
  };
}

export const api = createApiClient();
