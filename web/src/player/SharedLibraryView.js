import { qqLibrary } from '../shared/QQLibraryManager.js';
import { playlistManager } from '../shared/PlaylistManager.js';
import { playlistImporter } from './PlaylistImporter.js';
import { eventBus } from '../shared/EventBus.js';
import { queueMutationGate } from '../core/QueueMutationGate.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { songLine } from '../core/QQMusicData.js';

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const svg = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const refreshIcon = svg('<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.5-2L20 8M4 16l2.4 3A7 7 0 0 0 18 17"/>');
const musicIcon = svg('<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>');

/** A remote-only section; explicit import is the only path that can write the queue. */
export class SharedLibraryView {
  constructor(container, { library = qqLibrary, playlists = playlistManager, importer = playlistImporter, bus = eventBus,
    gate = queueMutationGate, onNavigate = () => {}, onImport = () => {} } = {}) {
    Object.assign(this, { container, library, playlists, importer, bus, gate, onNavigate, onImport });
    this.list = container.querySelector('.qq-library'); this.detailNode = container.querySelector('.qq-library-detail');
    this._token = 0; this._clearRevision = 0; this._visible = 50; this.detail = null; this.error = ''; this.loading = false; this.preparing = false;
    this._brokenCovers = new Set(); this._importBusy = importer.running;
    this.library.subscribe(() => {
      if (this.detail && this.detail.account_version !== this.library.state.account_version) {
        this._token++; this.detail = null; this.error = '共享账号已变更，请返回重新选择歌单'; this.loading = false;
      }
      this.render();
    });
    this.importer.subscribe(() => {
      // Per-song progress is rendered by QueuePanel, not by rebuilding 50 detail rows.
      if (this._importBusy !== this.importer.running) { this._importBusy = this.importer.running; this.render(); }
    });
    this.gate.subscribe(clearing => { if (clearing) this._clearRevision++; this.render(); });
    this.list.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.qqId) void this.open(button.dataset.qqId);
      else if (button.dataset.qqAction === 'refresh') void this.library.refresh({ force: true });
    });
    this.detailNode.addEventListener('click', event => {
      const button = event.target.closest('button'); if (!button || button.disabled) return;
      if (button.dataset.qqAction === 'more') { this._visible += 50; this.render(); }
      else if (button.dataset.qqAction === 'retry') void this.open(this._selectedId);
      else if (button.dataset.qqAction) void this.act(button.dataset.qqAction);
    });
    this.detailNode.addEventListener('change', event => {
      if (event.target.matches('[data-qq-partial]')) { this._partialAccepted = event.target.checked; this.render(); }
    });
    container.addEventListener('error', event => {
      if (!event.target.matches('.qq-library img, .qq-library-detail img')) return;
      this._brokenCovers.add(event.target.getAttribute('src'));
      const fallback = document.createElement('span'); fallback.className = 'playlist-card-cover playlist-card-placeholder'; fallback.innerHTML = musicIcon;
      event.target.replaceWith(fallback);
    }, true);
    this.render();
  }
  _cover(value) {
    const url = resolveCoverUrl(value);
    return url && !this._brokenCovers.has(url) ? `<img class="playlist-card-cover" src="${esc(url)}" alt="" loading="lazy" />`
      : `<span class="playlist-card-cover playlist-card-placeholder">${musicIcon}</span>`;
  }
  render() {
    const state = this.library.state;
    this.container.classList.toggle('has-shared-library', state.items.length > 0);
    const scroll = this.list.scrollTop; const detailScroll = this.detailNode.querySelector('.qq-library-tracks')?.scrollTop || 0;
    const active = this.container.contains(document.activeElement) ? document.activeElement : null;
    const action = active?.dataset.qqAction; const id = active?.dataset.qqId; const partialFocus = active?.hasAttribute('data-qq-partial');
    this.list.innerHTML = `<div class="qq-library-heading"><div><h3>共享 QQ 账号歌单</h3><p>来自服务器共享账号 · 仅同步目录，不自动播放</p></div>
      <button type="button" class="playlist-icon-btn" data-qq-action="refresh" aria-label="刷新共享 QQ 歌单" title="刷新共享 QQ 歌单" ${state.loading ? 'disabled' : ''}>${refreshIcon}</button></div>
      <p class="qq-library-status" role="status" aria-live="polite">${esc(state.loading ? '正在同步共享歌单…' : state.error || (state.status === 'ready' ? `${state.items.length} 个歌单 · 更新于 ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '正在检查共享账号…'))}</p>
      ${state.storageError ? `<p class="qq-library-notice">${esc(state.storageError)}</p>` : ''}
      ${!state.complete ? '<p class="qq-library-notice">目录未完整获取，请稍后刷新</p>' : ''}
      <div class="qq-library-cards">${state.items.map(item => `<article class="qq-library-card">
        <button type="button" class="playlist-card-import" data-qq-id="${esc(item.id)}" aria-label="查看共享歌单：${esc(item.name)}">
          ${this._cover(item.cover)}<span class="playlist-card-info"><span class="playlist-card-name">${esc(item.name)}</span>
          <span class="playlist-card-sub">${item.songCount} 首 · ${item.kind === 'liked' ? '我喜欢' : '自建歌单'} · 查看详情</span></span><span aria-hidden="true">›</span>
        </button></article>`).join('')}</div>
      ${state.status === 'ready' && !state.items.length ? '<p class="qq-library-notice">此共享账号暂无可读取的歌单</p>' : ''}`;
    this.list.scrollTop = scroll;
    const detail = this.detail;
    if (this.loading) this.detailNode.innerHTML = '<p class="qq-library-status" role="status">正在读取歌单歌曲…</p>';
    else if (!detail) this.detailNode.innerHTML = `<p class="qq-library-notice" role="status">${esc(this.error || '请选择共享歌单')}</p><button type="button" class="playlist-secondary-btn" data-qq-action="retry">重新读取</button>`;
    else {
      const partial = detail.songs.length < detail.songCount; const valid = detail.songs.filter(song => song.song_mid).length;
      const blocked = this.preparing || this.importer.running || this.gate.clearing;
      const unavailable = !valid || (partial && !this._partialAccepted);
      const saved = Boolean(this.playlists.findSource(detail.id));
      this.detailNode.innerHTML = `<div class="qq-library-summary">${this._cover(detail.cover)}<div><h3>${esc(detail.name)}</h3><p>来自服务器共享账号 · 已获取 ${detail.songs.length} / ${detail.songCount} 首</p></div></div>
        ${partial ? `<label class="qq-library-partial"><input type="checkbox" data-qq-partial ${this._partialAccepted ? 'checked' : ''} /> 我已知晓仅获取 ${detail.songs.length} / ${detail.songCount} 首，继续处理已获取部分</label>` : ''}
        <div class="qq-library-operations">
          <button type="button" class="playlist-primary-btn" data-qq-action="append" ${blocked || unavailable ? 'disabled' : ''}>加入队列</button>
          <button type="button" class="playlist-secondary-btn" data-qq-action="play" ${blocked || unavailable ? 'disabled' : ''}>播放全部</button>
          <button type="button" class="playlist-secondary-btn" data-qq-action="save" ${this.preparing || unavailable || saved ? 'disabled' : ''}>${saved ? '已另存到本地' : '另存为本地歌单'}</button>
        </div><p class="qq-library-notice" role="status" aria-live="polite">${esc(this.preparing ? '正在核对共享账号与歌单…' : this.error || (!valid ? '没有可导入的歌曲' : valid < detail.songs.length ? `${detail.songs.length - valid} 首歌曲缺少有效 ID，不可导入` : '追加不打断当前播放，播放全部不清空已有队列'))}</p>
        <div class="qq-library-tracks" tabindex="0" aria-label="共享歌单歌曲">${detail.songs.slice(0, this._visible).map((song, index) => `<div class="qq-library-track"><span>${index + 1}</span><div><strong>${esc(song.title)}</strong><small>${esc(song.artist || '未知歌手')}</small></div><span>${song.song_mid ? `${Math.floor(song.duration_ms / 60000)}:${String(Math.floor(song.duration_ms / 1000) % 60).padStart(2, '0')}` : '不可导入'}</span></div>`).join('') || '<p class="qq-library-notice">此歌单还没有歌曲</p>'}</div>
        ${detail.songs.length > this._visible ? '<button type="button" class="playlist-secondary-btn" data-qq-action="more">显示更多歌曲</button>' : ''}`;
      this.detailNode.querySelector('.qq-library-tracks').scrollTop = detailScroll;
    }
    if (active && !active.isConnected) {
      const target = partialFocus ? this.detailNode.querySelector('[data-qq-partial]')
        : action ? [...this.container.querySelectorAll('[data-qq-action]')].find(node => node.dataset.qqAction === action && node.getClientRects().length)
        : id ? [...this.list.querySelectorAll('[data-qq-id]')].find(node => node.dataset.qqId === id) : null;
      target?.focus({ preventScroll: true });
    }
  }
  async open(id) {
    if (this.preparing) return;
    this._listScroll = this.container.querySelector('.playlist-library').scrollTop;
    const token = ++this._token; this._selectedId = id;
    this.detail = null; this.loading = true; this.error = ''; this._visible = 50; this._partialAccepted = false;
    this.onNavigate('shared'); this.render();
    try { const detail = await this.library.getDetail(id); if (token === this._token) this.detail = detail; }
    catch (error) { if (token === this._token) this.error = error.message; }
    finally { if (token === this._token) { this.loading = false; this.render(); } }
  }
  async act(action) {
    if (this.preparing || !this.detail || !['append', 'play', 'save'].includes(action)) return;
    const selected = this.detail; const token = this._token; const clearRevision = this._clearRevision;
    if ((action !== 'save' && (this.importer.running || this.gate.clearing)) || (selected.songs.length < selected.songCount && !this._partialAccepted)) return;
    this.preparing = true; this.error = ''; this.render();
    try {
      const detail = await this.library.prepare(selected.id, selected.account_version);
      if (token !== this._token) return;
      if (detail.songs.length < detail.songCount && (detail.songs.length !== selected.songs.length || detail.songCount !== selected.songCount)) {
        this.detail = detail; this._partialAccepted = false;
        throw new Error('已获取歌曲数量发生变化，请重新确认部分结果');
      }
      if (detail.songs.length < detail.songCount && !this._partialAccepted) throw new Error('歌曲未完整获取，请先确认部分结果');
      if (action === 'save') {
        const result = this.playlists.createFromQQ(detail);
        if (result) this.bus.emit('toast', { message: result.exists ? '此歌单已保存在本地，未覆盖修改' : '已另存为本地歌单', level: 'success' });
        else this.error = this.playlists.lastError || '没有可保存的歌曲';
      } else {
        if (clearRevision !== this._clearRevision) throw new Error('准备期间队列已清空，本次导入已取消，请重新操作');
        if (this.importer.running || this.gate.clearing) throw new Error('正在导入或清空队列，请稍后重试');
        const entries = detail.songs.map(song => ({ ...song, kind: 'song', line: songLine(song) }));
        if (!entries.some(song => song.song_mid)) throw new Error('没有可导入的歌曲');
        // start snapshots synchronously before its first await; later account changes cannot retarget it.
        const task = this.importer.start({ id: `qq:${detail.account_id}:${detail.id}`, name: detail.name, entries, playNow: action === 'play', playFirstSuccess: true });
        this.onImport(); void task;
      }
    } catch (error) { this.error = error.message; }
    finally { this.preparing = false; this.render(); }
  }
}
