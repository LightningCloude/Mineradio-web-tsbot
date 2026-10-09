import { eventBus } from './EventBus.js';

export class ConnectionBar {
  constructor(container) {
    this.container = container;
    this._unsubscribe = eventBus.on('connection:changed', ({ wsConnected, apiReachable }) => {
      if (!wsConnected) {
        this.container.innerHTML = '<div class="conn-bar">⚠ 连接中断 — 正在重连...</div>';
        this.container.style.display = 'block';
      } else if (apiReachable === false) {
        this.container.innerHTML = '<div class="conn-bar">⚠ 播放进度连接正常，但控制接口暂时不可用</div>';
        this.container.style.display = 'block';
      } else {
        this.container.style.display = 'none';
        this.container.innerHTML = '';
      }
    });
  }

  dispose() {
    this._unsubscribe?.();
  }
}
