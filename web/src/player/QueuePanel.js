import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';
import { playlistManager } from '../shared/PlaylistManager.js';
import { playlistImporter } from './PlaylistImporter.js';

const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
  back: icon('<path d="m14 6-6 6 6 6"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  close: icon('<path d="m6 6 12 12M6 18 18 6"/>'),
  music: icon('<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>'),
  arrow: icon('<path d="M5 12h14m-6-6 6 6-6 6"/>'),
  trash: icon('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5"/>'),
};

/** Local playlists and sequential queue import; navigation never controls playback. */
export class QueuePanel {
  constructor(container, { apiClient = api, playlists = playlistManager, stateManager = state, bus = eventBus, importer = playlistImporter } = {}) {
    this.container = container;
    this._api = apiClient;
    this._playlists = playlists;
    this._state = stateManager;
    this._bus = bus;
    this._importer = importer;
    this._attached = false;
    this._importing = false;
    this._view = 'list';
    this._importResult = null;
    this._buildDOM();
    this._unsubscribeImport = importer.subscribe(() => this._syncImport());
    bus.on('ui:changed', (ui) => {
      if (ui.queueOpen) {
        const wasOpen = this.container.classList.contains('show');
        if (!this._attached) this._attachToBody();
        this._positionPanel();
        this.container.classList.add('show');
        if (!wasOpen && !this._importing) this._showView('list');
        this._render();
      } else {
        this.container.classList.remove('show');
      }
    });
    bus.on('playlist:changed', () => this._render());
    window.addEventListener('resize', () => {
      if (this.container.classList.contains('show')) this._positionPanel();
    });
    this._syncImport();
  }

  _attachToBody() {
    document.body.appendChild(this.container);
    this._attached = true;
    this.container.addEventListener('click', (event) => event.stopPropagation());
  }

  _positionPanel() {
    const button = document.querySelector('[data-action="queue"]');
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const bar = document.querySelector('.player-bar')?.getBoundingClientRect();
    const width = Math.min(420, Math.max(0, window.innerWidth - 32));
    const halfWidth = width / 2;
    const center = Math.max(16 + halfWidth, Math.min(window.innerWidth - 16 - halfWidth, rect.left + rect.width / 2));
    const bottom = Math.max(16, window.innerHeight - Math.min(rect.top, bar?.top ?? rect.top) + 14);
    this.container.style.left = `${center}px`;
    this.container.style.bottom = `${bottom}px`;
    this.container.style.maxHeight = `${Math.max(120, window.innerHeight - bottom - 16)}px`;
  }

  _buildDOM() {
    this.container.className = 'mini-queue-popover';
    this.container.setAttribute('aria-label', '播放列表');
    this.container.innerHTML = `
      <div class="mini-queue-head">
        <div class="mini-queue-heading">
          <button type="button" class="mini-queue-back playlist-icon-btn" aria-label="返回歌单" title="返回歌单" hidden>${icons.back}</button>
          <div class="mini-queue-heading-text">
            <div class="mini-queue-eyebrow">音乐收藏</div>
            <h2 class="mini-queue-title">我的歌单</h2>
            <div class="mini-queue-count"></div>
          </div>
        </div>
        <div class="mini-queue-actions">
          <button type="button" class="mini-queue-paste playlist-icon-btn" aria-label="新建歌单" title="新建歌单">${icons.plus}</button>
          <button type="button" class="mini-queue-close playlist-icon-btn" aria-label="关闭播放列表" title="关闭">${icons.close}</button>
        </div>
      </div>
      <section class="playlist-library">
        <div class="mini-queue-list" id="playlist-card-list"></div>
        <div class="mini-queue-empty">
          <span class="playlist-empty-icon">${icons.music}</span>
          <strong>把喜欢的歌曲收进歌单</strong>
          <p>粘贴歌曲名称，创建自己的播放列表</p>
          <button type="button" class="playlist-empty-create playlist-primary-btn">新建第一个歌单</button>
        </div>
        <p class="playlist-library-hint">选择歌单，将歌曲按顺序导入播放队列</p>
        <button type="button" class="playlist-import-resume" hidden></button>
      </section>
      <div class="playlist-paste-area" hidden>
        <label for="playlist-paste-name">歌单名称</label>
        <input id="playlist-paste-name" class="playlist-paste-name" placeholder="例如：晚间循环" maxlength="50" />
        <label for="playlist-paste-input">歌曲列表 <span class="playlist-draft-count">0 首</span></label>
        <textarea id="playlist-paste-input" class="playlist-paste-input" placeholder="每行一首歌曲&#10;例如：歌手 - 歌名" aria-describedby="playlist-paste-hint"></textarea>
        <p id="playlist-paste-hint" class="playlist-form-hint">支持“歌手 - 歌名”或直接填写歌名。创建后再点击歌单导入。</p>
        <div class="playlist-paste-actions">
          <button type="button" class="playlist-paste-cancel playlist-secondary-btn">返回歌单</button>
          <button type="button" class="playlist-paste-confirm playlist-primary-btn" disabled>创建歌单</button>
        </div>
      </div>
      <section class="playlist-import-view" hidden>
        <div class="playlist-import-overview">
          <div class="playlist-import-status" role="status" aria-live="polite"></div>
          <progress class="playlist-import-progress" max="1" value="0" aria-label="歌单导入进度"></progress>
          <div class="playlist-import-stats"></div>
        </div>
        <div class="playlist-import-log"></div>
        <div class="playlist-import-actions">
          <button type="button" class="playlist-import-stop playlist-secondary-btn" hidden>停止导入</button>
          <button type="button" class="playlist-import-back playlist-secondary-btn">返回歌单</button>
          <button type="button" class="playlist-import-create playlist-primary-btn">新建歌单</button>
        </div>
      </section>`;
    const listen = (selector, handler) => this.container.querySelector(selector).addEventListener('click', (event) => {
      event.stopPropagation();
      handler();
    });
    listen('.mini-queue-close', () => this._state.toggleUI('queueOpen'));
    for (const selector of ['.mini-queue-back', '.playlist-paste-cancel', '.playlist-import-back']) {
      listen(selector, () => this._showView('list'));
    }
    for (const selector of ['.mini-queue-paste', '.playlist-empty-create', '.playlist-import-create']) {
      listen(selector, () => {
        this._showView('create');
        this.container.querySelector('.playlist-paste-name').focus();
      });
    }
    listen('.playlist-import-resume', () => this._showView('import'));
    listen('.playlist-import-stop', () => this._importer.stop());
    listen('.playlist-paste-confirm', () => this._createPlaylist());
    this.container.querySelector('.playlist-paste-input').addEventListener('input', () => this._updateDraftCount());
    this.container.addEventListener('keydown', (event) => {
      if (event.key === ' ' || event.code === 'Space') event.stopPropagation();
    });
    this._showView('list');
  }

  _showView(view) {
    if (!['list', 'create', 'import'].includes(view)) return;
    this._view = view;
    this.container.querySelector('.playlist-library').hidden = view !== 'list';
    this.container.querySelector('.playlist-paste-area').hidden = view !== 'create';
    this.container.querySelector('.playlist-import-view').hidden = view !== 'import';
    this.container.querySelector('.mini-queue-back').hidden = view === 'list';
    this.container.querySelector('.mini-queue-paste').hidden = view === 'create';
    this._updateHeading();
    if (view === 'list') this._render();
  }

  _updateHeading() {
    const titles = { list: '我的歌单', create: '新建歌单', import: this._importing ? '正在导入' : '导入结果' };
    this.container.querySelector('.mini-queue-title').textContent = titles[this._view];
    this.container.querySelector('.mini-queue-count').textContent = this._view === 'list'
      ? `${this._playlists.playlists.length} 个歌单 · 保存在此浏览器`
      : (this._view === 'create' ? '粘贴歌曲名称，保存你的音乐收藏' : this._importResult?.name || '');
  }

  _updateDraftCount() {
    const count = this.container.querySelector('.playlist-paste-input').value.split(/[\n\r]+/).filter(line => line.trim()).length;
    this.container.querySelector('.playlist-draft-count').textContent = `${count} 首`;
    this.container.querySelector('.playlist-paste-confirm').disabled = count === 0;
  }

  _createPlaylist() {
    const nameInput = this.container.querySelector('.playlist-paste-name');
    const textInput = this.container.querySelector('.playlist-paste-input');
    const songs = textInput.value.trim();
    if (!songs) return;
    const name = nameInput.value.trim() || `歌单 ${new Date().toLocaleDateString()}`;
    if (!this._playlists.create(name, songs)) return;
    nameInput.value = '';
    textInput.value = '';
    this._updateDraftCount();
    this._showView('list');
    this._bus.emit('toast', { message: `已创建歌单：${name}`, level: 'success' });
  }

  _render() {
    const list = this.container.querySelector('.mini-queue-list');
    const playlists = this._playlists.playlists;
    this.container.querySelector('.mini-queue-empty').hidden = playlists.length > 0;
    this.container.querySelector('.playlist-library-hint').hidden = playlists.length === 0;
    list.innerHTML = playlists.map(playlist => {
      const songCount = (playlist.songs || '').split(/[\n\r]+/).filter(line => line.trim()).length;
      const cover = resolveCoverUrl(playlist.cover);
      const coverMarkup = cover
        ? `<img class="playlist-card-cover" src="${this._escAttr(cover)}" alt="" loading="lazy" />`
        : `<span class="playlist-card-cover playlist-card-placeholder">${icons.music}</span>`;
      return `<article class="playlist-card-item" data-id="${this._escAttr(playlist.id)}">
        <button type="button" class="playlist-card-import" data-id="${this._escAttr(playlist.id)}" aria-label="${this._escAttr(`导入歌单：${playlist.name}`)}" ${this._importing ? 'disabled' : ''}>
          ${coverMarkup}
          <span class="playlist-card-info"><span class="playlist-card-name">${this._esc(playlist.name)}</span><span class="playlist-card-sub">${songCount} 首歌曲 · 导入队列</span></span>
          <span class="playlist-card-arrow">${icons.arrow}</span>
        </button>
        <button type="button" class="playlist-card-delete playlist-icon-btn" data-id="${this._escAttr(playlist.id)}" aria-label="${this._escAttr(`删除歌单：${playlist.name}`)}" title="删除歌单" ${this._importing && this._importResult?.id === playlist.id ? 'disabled' : ''}>${icons.trash}</button>
      </article>`;
    }).join('');
    list.querySelectorAll('.playlist-card-import').forEach(button => button.addEventListener('click', () => this._startBatchImport(button.dataset.id)));
    list.querySelectorAll('.playlist-card-delete').forEach(button => button.addEventListener('click', () => {
      const playlist = this._playlists.get(button.dataset.id);
      if (playlist && confirm(`确定删除歌单“${playlist.name}”？`)) this._playlists.delete(playlist.id);
    }));
    this._updateHeading();
    this._renderImportProgress();
  }

  _renderImportProgress() {
    const result = this._importResult;
    const resume = this.container.querySelector('.playlist-import-resume');
    resume.hidden = !result;
    if (!result) return;
    const completed = result.ok + result.fail;
    const status = result.uncertain ? '入队结果不确定，请先检查队列；未自动重试'
      : this._importing ? `正在检索并导入 ${completed}/${result.total} 首`
      : result.stopped ? '导入已停止，已加入的歌曲保留'
      : result.interrupted ? '导入已中断，请检查队列' : '导入完成，可以继续选择其他歌单';
    this.container.querySelector('.playlist-import-status').textContent = status;
    this.container.querySelector('.playlist-import-stats').textContent = `成功 ${result.ok} 首 · 失败 ${result.fail} 首 · 共 ${result.total} 首`;
    const progress = this.container.querySelector('.playlist-import-progress');
    progress.max = result.total;
    progress.value = completed;
    resume.textContent = this._importing ? `正在导入 · ${completed}/${result.total} 首 · 查看进度` : `上次导入 · ${result.ok}/${result.total} 首成功 · 查看结果`;
    const stop = this.container.querySelector('.playlist-import-stop');
    stop.hidden = !this._importing;
    stop.disabled = Boolean(result.stopRequested);
    this._updateHeading();
  }

  _appendImportRow(line, index) {
    const row = document.createElement('div');
    row.className = 'import-log-row';
    row.innerHTML = `<span class="import-idx">${String(index + 1).padStart(2, '0')}</span><span class="import-line">${this._esc(line)}</span><span class="import-status searching">检索中</span>`;
    const log = this.container.querySelector('.playlist-import-log');
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  }

  _setRowStatus(row, status, label) {
    const element = row.querySelector('.import-status');
    element.className = `import-status ${status}`;
    element.textContent = label;
  }

  async _startBatchImport(playlistId) {
    if (this._importer.running) return;
    const playlist = this._playlists.get(playlistId);
    if (!playlist) return;
    const entries = this._playlists.getEntries(playlistId);
    if (!entries.length) {
      this._bus.emit('toast', { message: '这个歌单还没有歌曲', level: 'warn' });
      return;
    }
    this._showView('import');
    return this._importer.start({ id: playlistId, name: playlist.name, entries, playNow: true, playFirstSuccess: Boolean(playlist.entries) });
  }

  _syncImport() {
    const task = this._importer.task;
    if (task !== this._importResult) {
      this._importRowNodes = [];
      this.container.querySelector('.playlist-import-log').replaceChildren();
    }
    this._importResult = task;
    this._importing = this._importer.running;
    if (task) {
      this._importRowNodes ||= [];
      task.rows.forEach((row, index) => {
        if (row.state === 'pending') return;
        const node = this._importRowNodes[index] ||= this._appendImportRow(row.line, index);
        this._setRowStatus(node, row.state === 'uncertain' ? 'fail' : row.state, row.label);
      });
      const playlist = this._playlists.get(task.id);
      const cover = task.rows.find(row => row.song?.cover)?.song.cover;
      if (playlist && !playlist.cover && cover && this._coverAttemptTask !== task) {
        this._coverAttemptTask = task;
        this._playlists.setCover(task.id, cover);
      }
    }
    // Completion never changes view, closes the panel, or overwrites an editor draft.
    this._render();
  }

  _escAttr(value) { return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  _esc(value) { return this._escAttr(value); }
}
