import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { api } from '../core/ApiClient.js';

export class CookieView {
  constructor(container) {
    this.container = container;
    this._tokenRequirement = null;
    this._buildDOM();
    eventBus.on('ui:changed', (ui) => {
      this.container.style.display = ui.cookieOpen ? 'flex' : 'none';
      if (ui.cookieOpen) this._loadStatus();
    });
    eventBus.on('auth:token_required', () => this._openForToken('api'));
    eventBus.on('auth:admin_token_required', () => this._openForToken('admin'));
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="search-backdrop"></div>
      <div class="search-panel">
        <div class="search-header">
          <h3 style="color:var(--text-primary);margin:0;">QQ 音乐与访问设置</h3>
          <button class="search-close">✕</button>
        </div>
        <div class="cookie-status" style="color:var(--text-secondary);font-size:0.85rem;margin-bottom:0.5rem;"></div>
        <label style="display:block;color:var(--text-secondary);font-size:0.8rem;margin-top:0.6rem;">API Token</label>
        <input class="api-token-input" type="password" autocomplete="off" placeholder="TSBOT_API_TOKEN（未启用可留空）" style="
          width:100%;padding:0.65rem 0.75rem;margin-top:0.25rem;border-radius:8px;
          border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);
          color:white;font-size:0.85rem;" />
        <label style="display:block;color:var(--text-secondary);font-size:0.8rem;margin-top:0.6rem;">Admin Token</label>
        <input class="admin-token-input" type="password" autocomplete="off" placeholder="TSBOT_ADMIN_TOKEN（未启用可留空）" style="
          width:100%;padding:0.65rem 0.75rem;margin-top:0.25rem;border-radius:8px;
          border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);
          color:white;font-size:0.85rem;" />
        <div style="display:flex;gap:0.75rem;margin:0.75rem 0 1rem;">
          <button class="token-save" style="
            padding:0.6rem 1rem;border-radius:8px;border:1px solid rgba(255,255,255,0.2);
            background:rgba(255,255,255,0.06);color:var(--text-primary);cursor:pointer;font-size:0.85rem;">
            保存访问令牌
          </button>
          <button class="qq-login" style="
            padding:0.6rem 1rem;border-radius:8px;border:1px solid var(--accent-mint);
            background:rgba(156,255,223,0.1);color:var(--accent-mint);cursor:pointer;font-size:0.85rem;">
            QQ 扫码登录
          </button>
        </div>
        <label style="display:block;color:var(--text-secondary);font-size:0.8rem;">手动设置 QQ 音乐 Cookie</label>
        <textarea class="cookie-input" placeholder="粘贴 QQ 音乐的 cookie 字符串..." style="
          width:100%;height:120px;resize:vertical;padding:0.75rem;border-radius:10px;
          border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.05);
          color:white;font-size:0.85rem;font-family:monospace;"></textarea>
        <div style="display:flex;gap:0.75rem;margin-top:0.5rem;">
          <button class="cookie-save" style="
            padding:0.6rem 1.5rem;border-radius:8px;border:1px solid var(--accent-mint);
            background:rgba(156,255,223,0.1);color:var(--accent-mint);cursor:pointer;font-size:0.9rem;">
            保存 Cookie
          </button>
          <button class="cookie-clear" style="
            padding:0.6rem 1.5rem;border-radius:8px;border:1px solid rgba(255,100,100,0.3);
            background:rgba(255,100,100,0.05);color:rgba(255,120,120,0.8);cursor:pointer;font-size:0.9rem;">
            清除 Cookie
          </button>
        </div>
      </div>
    `;

    this.container.querySelector('.search-backdrop').addEventListener('click', () => state.toggleUI('cookieOpen'));
    this.container.querySelector('.search-close').addEventListener('click', () => state.toggleUI('cookieOpen'));
    this.container.querySelector('.token-save').addEventListener('click', () => this._saveTokens());
    this.container.querySelector('.qq-login').addEventListener('click', () => {
      this._persistTokens();
      if (state.ui.cookieOpen) state.toggleUI('cookieOpen');
      eventBus.emit('auth:qq_login_requested');
    });
    this.container.querySelector('.cookie-save').addEventListener('click', () => this._save());
    this.container.querySelector('.cookie-clear').addEventListener('click', () => this._clear());

    this.container.querySelector('.api-token-input').value = localStorage.getItem('tsbot_api_token') || '';
    this.container.querySelector('.admin-token-input').value = localStorage.getItem('tsbot_admin_token') || '';
  }

  async _loadStatus() {
    const el = this.container.querySelector('.cookie-status');
    if (this._tokenRequirement === 'api') {
      el.textContent = '⚠ 后端需要 API Token，请填写并保存';
      return;
    }
    if (this._tokenRequirement === 'admin') {
      el.textContent = '⚠ 此操作需要 Admin Token，请填写并保存';
      return;
    }

    try {
      const json = await api.getQQCookieStatus();
      el.textContent = json.admin_cookie_set
        ? '✅ QQ 音乐登录状态已设置'
        : '⚠ 未设置 QQ 音乐登录状态（搜索无需登录，完整音质可能需要）';
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) {
        el.textContent = '⚠ 无法获取 QQ 音乐登录状态';
      }
    }
  }

  _persistTokens() {
    const apiToken = this.container.querySelector('.api-token-input').value.trim();
    const adminToken = this.container.querySelector('.admin-token-input').value.trim();

    if (apiToken) localStorage.setItem('tsbot_api_token', apiToken);
    else localStorage.removeItem('tsbot_api_token');
    if (adminToken) localStorage.setItem('tsbot_admin_token', adminToken);
    else localStorage.removeItem('tsbot_admin_token');
    this._tokenRequirement = null;
  }

  async _saveTokens() {
    this._persistTokens();
    eventBus.emit('toast', { message: '访问令牌已保存', level: 'success' });
    await this._loadStatus();
  }

  _openForToken(kind) {
    this._tokenRequirement = kind;
    if (!state.ui.cookieOpen) state.toggleUI('cookieOpen');
    const selector = kind === 'admin' ? '.admin-token-input' : '.api-token-input';
    setTimeout(() => this.container.querySelector(selector)?.focus(), 0);
    this._loadStatus();
  }

  async _save() {
    const cookie = this.container.querySelector('.cookie-input').value.trim();
    if (!cookie) return;
    this._persistTokens();
    try {
      await api.saveQQCookie(cookie);
      eventBus.emit('toast', { message: 'Cookie 已保存', level: 'success' });
      await this._loadStatus();
    } catch (e) { /* toast handled by api */ }
  }

  async _clear() {
    this._persistTokens();
    try {
      await api.clearQQCookie();
      this.container.querySelector('.cookie-input').value = '';
      eventBus.emit('toast', { message: 'Cookie 已清除', level: 'info' });
      await this._loadStatus();
    } catch (e) {}
  }
}
