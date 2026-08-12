import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { api } from '../core/ApiClient.js';
import { normalizeQQLoginPayload } from '../core/QQLoginContract.js';

/**
 * QQ Music QR code login overlay.
 */
export class LoginView {
  constructor(container) {
    this.container = container;
    this._pollTimer = null;
    this._qrSession = null;
    this._buildDOM();
    eventBus.on('auth:changed', (auth) => {
      if (auth.qqLoggedIn) this.hide();
    });
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="login-overlay">
        <div class="login-dialog">
          <h3>登录 QQ 音乐</h3>
          <p class="login-desc">扫码登录后可使用完整音质</p>
          <div class="login-qr-wrap">
            <img class="login-qr" src="" alt="QR Code" />
            <div class="login-qr-expired">二维码已过期，点击刷新</div>
          </div>
          <p class="login-hint">请使用手机 QQ 音乐客户端扫码</p>
          <button class="login-close">暂不登录</button>
        </div>
      </div>
    `;

    this.container.querySelector('.login-close').addEventListener('click', () => this.hide());
    this.container.querySelector('.login-qr-expired').addEventListener('click', () => this._loadQR());
  }

  async show() {
    this.container.style.display = 'flex';
    await this._loadQR();
  }

  hide() {
    this.container.style.display = 'none';
    this._stopPolling();
  }

  async _loadQR() {
    this._stopPolling();
    const qrImg = this.container.querySelector('.login-qr');
    const expiredEl = this.container.querySelector('.login-qr-expired');
    expiredEl.textContent = '正在获取二维码…';
    expiredEl.style.display = 'flex';
    qrImg.style.display = 'none';

    try {
      const data = await api.getQQLoginQR();
      const normalized = normalizeQQLoginPayload(data);
      this._qrSession = normalized.session;
      qrImg.src = normalized.imageSrc;
      expiredEl.style.display = 'none';
      qrImg.style.display = 'block';
      this._setHint('请使用手机 QQ 扫码，并在手机上确认登录');
      this._schedulePoll();
    } catch (e) {
      if (e.status === 401) {
        this.hide();
        return;
      }
      this._showExpired('获取二维码失败，点击重试');
    }
  }

  _schedulePoll() {
    if (!this._qrSession) return;
    this._pollTimer = setTimeout(() => this._pollOnce(), 2000);
  }

  async _pollOnce() {
    const qrSession = this._qrSession;
    if (!qrSession) return;

    try {
      const result = await api.checkQQLogin(qrSession);
      if (this._qrSession !== qrSession) return;

      if (result.status === 'success' || result.qq_logged_in || result.code === 0) {
        if (!result.auth_url) {
          this._showExpired('登录确认信息不完整，点击重试');
          return;
        }
        this._setHint('正在保存登录状态…');
        let confirmed;
        try {
          confirmed = await api.confirmQQLogin(result.auth_url);
        } catch (e) {
          if (e.status === 401 || e.status === 403) {
            this.hide();
          } else {
            this._showExpired('保存登录状态失败，点击重试');
          }
          return;
        }
        if (!confirmed.admin_cookie_set) {
          this._showExpired('登录状态未保存，点击重试');
          return;
        }
        state.updateAuth({ qqLoggedIn: true });
        this.hide();
        eventBus.emit('toast', { message: 'QQ音乐登录成功', level: 'success' });
        return;
      }

      if (result.status === 'expired' || result.code === 65 || result.code === 68) {
        this._showExpired();
        return;
      }
      if (result.status === 'scanning') {
        this._setHint('已扫码，请在手机上确认登录');
      }
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        this.hide();
        return;
      }
    }

    if (this._qrSession === qrSession) this._schedulePoll();
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    this._qrSession = null;
  }

  _setHint(message) {
    this.container.querySelector('.login-hint').textContent = message;
  }

  _showExpired(message = '二维码已过期，点击刷新') {
    this._stopPolling();
    this.container.querySelector('.login-qr').style.display = 'none';
    const expiredEl = this.container.querySelector('.login-qr-expired');
    expiredEl.textContent = message;
    expiredEl.style.display = 'flex';
  }
}
