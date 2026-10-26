import { api } from '../core/ApiClient.js';
import { queueMutationGate } from '../core/QueueMutationGate.js';
import { state } from '../shared/StateManager.js';
import { playlistImporter } from './PlaylistImporter.js';

/** Never retries a destructive write. Playback/lyrics are deliberately untouched. */
export class QueueClearController {
  constructor({ apiClient = api, stateManager = state, importer = playlistImporter, gate = queueMutationGate } = {}) {
    Object.assign(this, { _api: apiClient, _state: stateManager, _importer: importer, _gate: gate });
  }
  async _reconcile() {
    // Invalidate reads started before the write, without inventing an empty queue.
    this._state.updateQueue(this._state.queue);
    const revision = this._state.queueRevision;
    const data = await this._api.getQueue({ silent: true });
    const items = data?.items || data?.queue;
    if (!Array.isArray(items)) throw new Error('队列同步失败');
    this._state.updateQueue(items.map(item => ({ ...item, artwork: item.artwork || item.cover_url || item.artwork_url || '' })), { expectedRevision: revision });
  }
  async clear() {
    if (!this._gate.beginClear()) return { busy: true };
    this._state.updateQueue(this._state.queue);
    try {
      await this._importer.stopAndWait();
      if (!await this._gate.drain()) {
        try { await this._reconcile(); } catch (_) { /* Remain explicit about uncertainty. */ }
        return { ok: false, uncertain: true, message: '此前入队请求的结果不确定，已暂停清空。请等待并核对队列后重新操作，未自动重试。' };
      }
      let result;
      try {
        result = await this._api.clearQueue({ silent: true });
        if (result?.ok !== true || !Number.isInteger(result.removed_count) || result.removed_count < 0) {
          throw new Error('服务器未返回明确的清空结果');
        }
      } catch (error) {
        let synced = true;
        try { await this._reconcile(); } catch (_) { synced = false; }
        return { ok: false, uncertain: !error.status, message: !error.status
          ? `清空请求结果不确定，未自动重试。${synced ? '已更新队列，请核对后再操作。' : '暂时无法核对队列，请恢复连接后检查。'}`
          : `清空失败：${error.message || '请求失败'}。${synced ? '已刷新队列。' : '队列暂未同步。'}` };
      }
      let synced = true;
      try { await this._reconcile(); } catch (_) { synced = false; }
      return { ok: true, removedCount: result.removed_count, synced };
    } finally { this._gate.endClear(); }
  }
}
