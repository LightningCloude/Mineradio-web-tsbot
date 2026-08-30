import { eventBus } from './EventBus.js';

export class ConnectionBar {
  constructor(container) {
    this.container = container;
    eventBus.on('connection:changed', ({ wsConnected }) => {
      if (!wsConnected) {
        this.container.innerHTML = '<div class="conn-bar">⚠ 连接中断 — 正在重连...</div>';
        this.container.style.display = 'block';
      } else {
        this.container.style.display = 'none';
        this.container.innerHTML = '';
      }
    });
  }
}
