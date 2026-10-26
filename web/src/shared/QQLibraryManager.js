import { api } from '../core/ApiClient.js';
import { eventBus } from './EventBus.js';
import { playlistDetail, PlaylistDetailCache, decodeText, safeCover } from '../core/QQMusicData.js';

export const QQ_LIBRARY_KEY = 'minerats-qq-library-v1';
const messages = { unconfigured: '尚未设置共享 QQ 账号，请在登录凭据中扫码或保存 Cookie', expired: '共享 QQ 账号登录已失效，请重新登录',
  unavailable: '暂时无法读取 QQ 歌单，请稍后刷新', account_changed: '共享账号已变更，请重新选择歌单', not_found: '此歌单已不在当前共享账号目录中' };

/** Remote references are deliberately NOT part of PlaylistManager's local favorites. */
export class QQLibraryManager {
  constructor({ apiClient = api, bus = eventBus, storage, now = Date.now } = {}) {
    Object.assign(this, { api: apiClient, bus, now });
    try { this.storage = storage ?? globalThis.localStorage; } catch { this.storage = null; }
    this.state = { status: 'idle', items: [], loading: false, error: '', updatedAt: 0, account_id: '', account_version: '', complete: true, storageError: '' };
    try { this._stored = JSON.parse(this.storage?.getItem(QQ_LIBRARY_KEY) || 'null'); } catch { this._stored = null; }
    this.cache = new PlaylistDetailCache({ now }); this.listeners = new Set(); this._epoch = 0;
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  _emit() { for (const callback of this.listeners) callback(this.state); }
  start() {
    if (this._started) return;
    this._started = true;
    this._unsubscribe = this.bus.on('qq:credentials-changed', ({ cleared } = {}) => {
      this.reset(cleared ? 'unconfigured' : 'idle');
      if (!cleared) void this.refresh({ force: true });
    });
    void this.refresh();
  }
  reset(status = 'idle') {
    this._epoch++; this._controller?.abort(); this._request = null;
    this._detailController?.abort(); this.cache.items.clear();
    this._stored = null;
    this.state = { ...this.state, status, items: [], loading: false, error: messages[status] || '', updatedAt: 0, account_id: '', account_version: '' };
    try { this.storage?.removeItem(QQ_LIBRARY_KEY); } catch { /* No credentials are stored here. */ }
    this._emit();
  }
  async refresh({ force = false } = {}) {
    if (this._request) return this._request;
    if (!force && this.state.status === 'ready' && this.now() - this.state.updatedAt < 300000) return true;
    const epoch = this._epoch; const controller = new AbortController(); this._controller = controller;
    this.state.loading = true; this._emit();
    const task = (async () => {
      try {
        const data = await this.api.getQQLibrary({ signal: controller.signal, refresh: force, silent: true });
        if (epoch !== this._epoch) return false;
        if (data.status !== 'ready') {
          if (['unconfigured', 'expired', 'account_changed'].includes(data.status)) {
            this.reset(data.status); return false;
          }
          const cached = this._stored;
          if (!this.state.account_id && cached?.account_id === data.account_id && cached?.account_version === data.account_version &&
              data.account_id && Array.isArray(cached.items)) {
            const items = cached.items.filter(item => /^\d+$/.test(String(item.id)) && ['liked', 'created'].includes(item.kind))
              .map(item => ({ ...item, id: String(item.id), name: decodeText(item.name), cover: safeCover(item.cover), songCount: Math.max(0, Number(item.songCount) || 0) }));
            this.state = { ...this.state, status: 'stale', items, account_id: data.account_id, account_version: data.account_version, updatedAt: Number(cached.updatedAt) || 0 };
          }
          throw new Error(messages[data.status] || messages.unavailable);
        }
        if (!data.account_id || !data.account_version || !Array.isArray(data.items)) throw new Error(messages.unavailable);
        if (this.state.account_version !== data.account_version) { this._detailController?.abort(); this.cache.items.clear(); }
        const items = data.items.filter(item => /^\d+$/.test(String(item.id)) && ['liked', 'created'].includes(item.kind))
          .map(item => ({ ...item, id: String(item.id), name: decodeText(item.name), cover: safeCover(item.cover), songCount: Math.max(0, Number(item.songCount) || 0) }));
        this.state = { ...this.state, status: 'ready', items, account_id: data.account_id, account_version: data.account_version,
          complete: data.complete !== false, updatedAt: this.now(), error: '', storageError: '' };
        try {
          if (!this.storage) throw new Error('storage');
          this._stored = { account_id: data.account_id, account_version: data.account_version, items, updatedAt: this.state.updatedAt };
          this.storage.setItem(QQ_LIBRARY_KEY, JSON.stringify(this._stored));
        } catch { this.state.storageError = '共享目录仅在本次页面中可用，无法缓存到此浏览器'; }
        return true;
      } catch (error) {
        if (epoch === this._epoch && !controller.signal.aborted) this.state.error = error.message || messages.unavailable;
        return false;
      } finally {
        if (epoch === this._epoch) { this.state.loading = false; this._request = null; this._emit(); }
      }
    })();
    this._request = task;
    return task;
  }
  async getDetail(id, version = this.state.account_version) {
    const epoch = this._epoch;
    if (version !== this.state.account_version || !this.state.items.some(item => item.id === id)) throw new Error(messages.account_changed);
    const cached = this.cache.get(id); if (cached) return cached;
    this._detailController?.abort(); const controller = new AbortController(); this._detailController = controller;
    const result = await this.api.getQQLibraryPlaylist(id, version, { signal: controller.signal, silent: true });
    if (epoch !== this._epoch || version !== this.state.account_version || controller.signal.aborted) throw new Error(messages.account_changed);
    if (result.status !== 'ready') {
      if (['account_changed', 'unconfigured', 'expired'].includes(result.status)) this.reset(result.status);
      throw new Error(messages[result.status] || messages.unavailable);
    }
    if (result.account_id !== this.state.account_id || result.account_version !== version) { this.reset('account_changed'); throw new Error(messages.account_changed); }
    const detail = { ...playlistDetail(result.data, result.playlist), account_id: result.account_id, account_version: version };
    this.cache.set(id, detail); return detail;
  }
  async prepare(id, version) {
    if (!await this.refresh({ force: true })) throw new Error(this.state.error || messages.unavailable);
    if (version !== this.state.account_version) throw new Error(messages.account_changed);
    return this.getDetail(id, version);
  }
}

export const qqLibrary = new QQLibraryManager();
