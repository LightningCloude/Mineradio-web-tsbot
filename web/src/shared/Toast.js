import { eventBus } from './EventBus.js';

export class Toast {
  constructor(container) {
    this.container = container;
    eventBus.on('toast', ({ message, level, clear }) => {
      if (clear) { this.container.innerHTML = ''; return; }
      this._show(message, level || 'info');
    });
  }

  _show(message, level) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${level}`;
    toast.textContent = message;
    this.container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
      toast.classList.remove('toast-visible');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }
}
