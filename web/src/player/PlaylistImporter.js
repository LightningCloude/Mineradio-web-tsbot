import { api } from '../core/ApiClient.js';
import { eventBus } from '../shared/EventBus.js';
import { state } from '../shared/StateManager.js';
import { normalizeSong, songLine } from '../core/QQMusicData.js';
import { queueMutationGate } from '../core/QueueMutationGate.js';

/** One page-wide batch. Read failures may continue; uncertain writes stop without retry. */
export class PlaylistImporter {
  constructor({ apiClient = api, bus = eventBus, stateManager = state, now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), interval = 300, queueGate = queueMutationGate } = {}) {
    Object.assign(this, { _api: apiClient, _bus: bus, _state: stateManager, _now: now, _sleep: sleep, _interval: interval });
    this._listeners = new Set(); this.task = null; this._lastWrite = -Infinity;
    this._queueGate = queueGate;
  }
  get running() { return Boolean(this.task?.running); }
  subscribe(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _notify() {
    for (const listener of this._listeners) { try { listener(this.task); } catch (error) { console.error('[PlaylistImporter] view update failed', error); } }
  }
  stop() { if (this.running) { this.task.stopRequested = true; this._notify(); } }
  async stopAndWait() {
    if (!this.running) return;
    const stopped = new Promise(resolve => {
      const unsubscribe = this.subscribe(() => { if (!this.running) { unsubscribe(); resolve(); } });
    });
    this.stop(); await stopped;
  }

  async start({ id, name, entries, playNow = false, playFirstSuccess = true }) {
    if (this.running || this._queueGate.clearing || !entries?.length) return null;
    const task = this.task = {
      id, name, running: true, total: entries.length, ok: 0, fail: 0, current: '',
      stopped: false, stopRequested: false, uncertain: false, interrupted: false,
      rows: entries.map(entry => ({ line: entry.line || songLine(entry), state: 'pending', label: '等待导入' })),
    };
    // Snapshot input before observers run: editing or deleting local lists cannot change this batch.
    const snapshot = entries.map(entry => ({ ...entry }));
    this._notify();
    try {
      for (let index = 0; index < snapshot.length; index++) {
        if (task.stopRequested) { task.stopped = true; break; }
        const entry = snapshot[index]; const row = task.rows[index];
        task.current = row.line; row.state = 'searching'; row.label = entry.kind === 'text' ? '检索中' : '准备导入'; this._notify();
        let song;
        try {
          if (entry.kind === 'text') {
            const data = await this._api.search(entry.line, { silent: true });
            const result = data?.items || data?.songs || data?.results || [];
            if (Array.isArray(result) && result.length) song = normalizeSong(result[0]);
          } else song = normalizeSong(entry);
        } catch (_) { row.label = '检索失败'; }
        if (task.stopRequested) { row.state = 'pending'; row.label = '未导入'; task.stopped = true; break; }
        if (!song?.song_mid) {
          task.fail++; row.state = 'fail'; row.label = row.label === '检索失败' ? row.label : entry.kind === 'text' ? '未找到' : '不可导入'; this._notify(); continue;
        }
        const remaining = this._interval - (this._now() - this._lastWrite);
        if (remaining > 0) await this._sleep(remaining);
        if (task.stopRequested) { row.state = 'pending'; row.label = '未导入'; task.stopped = true; break; }
        row.label = '加入中'; this._notify();
        this._lastWrite = this._now();
        const shouldPlay = playNow && (playFirstSuccess ? task.ok === 0 : index === 0);
        try {
          await this._api.addToQueue(song.song_mid, { title: song.title, artist: song.artist,
            cover_url: song.cover, duration_ms: song.duration_ms, playNow: shouldPlay });
          task.ok++; row.state = 'ok'; row.label = '已加入'; row.song = song;
          if (shouldPlay && song.cover) this._bus.emit('cover:load', song.cover);
        } catch (error) {
          if (!error.status) {
            task.uncertain = true; task.interrupted = true; row.state = 'uncertain'; row.label = '结果不确定';
            this._notify(); break;
          }
          task.fail++; row.state = 'fail'; row.label = '加入失败';
        }
        this._notify();
      }
    } catch (_) { task.interrupted = true; }
    finally {
      task.stopped ||= task.stopRequested;
      task.running = false; this._notify();
    }
    this._bus.emit('toast', { message: task.uncertain ? '入队请求结果不确定，请检查队列；未自动重试'
      : `${task.stopped ? '已停止导入' : task.interrupted ? '导入中断' : '导入完成'}：${task.ok}/${task.total} 首成功`,
      level: task.uncertain || task.interrupted ? 'warn' : task.ok ? 'success' : 'info' });
    if (task.ok || task.uncertain) this._refreshQueue();
    return task;
  }

  async _refreshQueue() {
    const revision = this._state.queueRevision;
    const task = this.task;
    try {
      const data = await this._api.getQueue({ silent: true }); const raw = data?.items || data?.queue;
      if (task === this.task && Array.isArray(raw)) this._state.updateQueue(raw.map(song => ({ ...song, artwork: song.artwork || song.cover_url || '' })), { expectedRevision: revision });
    } catch (_) { /* Status updates will reconcile if this read fails. */ }
  }
}

export const playlistImporter = new PlaylistImporter();
