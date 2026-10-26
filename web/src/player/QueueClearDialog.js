import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { playlistImporter } from './PlaylistImporter.js';
import { QueueClearController } from './QueueClearController.js';

export class QueueClearDialog {
  constructor({ stateManager = state, bus = eventBus, importer = playlistImporter, controller = new QueueClearController() } = {}) {
    Object.assign(this, { _state: stateManager, _bus: bus, _importer: importer, _controller: controller });
    this._busy = false;
    this.element = document.createElement('dialog');
    this.element.className = 'queue-clear-dialog';
    this.element.setAttribute('aria-labelledby', 'queue-clear-title');
    this.element.setAttribute('aria-describedby', 'queue-clear-description');
    this.element.innerHTML = `<form method="dialog">
      <span class="queue-clear-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/></svg></span>
      <h2 id="queue-clear-title">清空播放队列？</h2>
      <p class="queue-clear-count"></p>
      <p id="queue-clear-description">影响所有用户的共享队列；当前歌曲继续播放；不会删除本地保存的歌单。</p>
      <p class="queue-clear-import" hidden>正在导入的任务将停止，等待当前请求结束后清空。</p>
      <p class="queue-clear-status" role="status" aria-live="polite" hidden></p>
      <div class="queue-clear-actions"><button type="button" class="queue-clear-cancel" autofocus>取消</button><button type="button" class="queue-clear-confirm">清空队列</button></div>
    </form>`;
    document.body.appendChild(this.element);
    this._cancel = this.element.querySelector('.queue-clear-cancel');
    this._confirm = this.element.querySelector('.queue-clear-confirm');
    this._status = this.element.querySelector('.queue-clear-status');
    this._cancel.addEventListener('click', () => this.close());
    this._confirm.addEventListener('click', () => this._submit());
    this.element.addEventListener('submit', event => event.preventDefault());
    this.element.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
    this.element.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this.close(); }
      if (event.key === 'Tab') {
        const buttons = [this._cancel, this._confirm].filter(button => !button.disabled && !button.hidden);
        if (!buttons.length) { event.preventDefault(); this.element.focus(); return; }
        const next = buttons.indexOf(document.activeElement) + (event.shiftKey ? -1 : 1);
        if (next < 0 || next >= buttons.length) { event.preventDefault(); buttons[event.shiftKey ? buttons.length - 1 : 0].focus(); }
      }
    });
    this.element.addEventListener('close', () => this._returnFocus?.focus?.({ preventScroll: true }));
  }
  open(trigger) {
    if (this.element.open) return;
    if (!this._state.queue?.length && !this._importer.running) {
      this._bus.emit('toast', { message: '队列已经为空', level: 'info' }); return;
    }
    this._returnFocus = trigger || document.activeElement;
    this._status.hidden = true; this._confirm.hidden = false; this._cancel.textContent = '取消';
    this._confirm.textContent = this._importer.running ? '停止导入并清空' : '清空队列';
    this.element.querySelector('.queue-clear-import').hidden = !this._importer.running;
    this.element.querySelector('.queue-clear-count').textContent = `当前队列共 ${this._state.queue.length} 首歌曲`;
    this.element.showModal(); this._cancel.focus();
  }
  close() { if (!this._busy) this.element.close(); }
  async _submit() {
    if (this._busy) return;
    this._busy = true; this.element.setAttribute('aria-busy', 'true');
    this._confirm.disabled = this._cancel.disabled = true;
    this._confirm.textContent = '正在清空…'; this._status.textContent = '正在清空…'; this._status.hidden = false;
    // Yield for an actual painted frame before starting network work.
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    let result;
    try { result = await this._controller.clear(); }
    catch (_) { result = { ok: false, message: '操作未完成，请检查队列后再操作；未自动重试。' }; }
    finally {
      this._busy = false; this.element.removeAttribute('aria-busy');
      this._confirm.disabled = this._cancel.disabled = false;
    }
    if (result.ok) {
      const message = `已清空 ${result.removedCount} 首歌曲，当前播放状态保持不变`;
      this._bus.emit('toast', { message: result.synced ? message : `${message}；队列显示稍后同步`, level: result.synced ? 'success' : 'warn' });
      this.close();
    } else {
      this._status.textContent = result.message || '已有清空操作正在进行，请稍后检查队列。';
      this._confirm.hidden = true; this._cancel.textContent = '关闭'; this._cancel.focus();
    }
  }
}
