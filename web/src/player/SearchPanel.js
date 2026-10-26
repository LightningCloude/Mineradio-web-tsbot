import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';
import { playlistManager } from '../shared/PlaylistManager.js';
import { playlistImporter } from './PlaylistImporter.js';
import { queueMutationGate } from '../core/QueueMutationGate.js';
import { LatestRequest } from '../core/LatestRequest.js';
import { songPage, playlistPage, playlistDetail, PlaylistDetailCache, safeCover, songLine } from '../core/QQMusicData.js';

const icon = path => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  search: icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>'),
  close: icon('<path d="m6 6 12 12M6 18 18 6"/>'), back: icon('<path d="m14 6-6 6 6 6"/>'),
  play: icon('<path d="m9 5 11 7-11 7Z"/>'), add: icon('<path d="M12 5v14M5 12h14"/>'),
  save: icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/>'),
  music: icon('<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="3"/><ellipse cx="17" cy="16" rx="3" ry="3"/>'),
  heart: icon('<path d="M20.8 4.6a5.4 5.4 0 0 0-7.6 0L12 5.8l-1.2-1.2a5.4 5.4 0 0 0-7.6 7.6L12 21l8.8-8.8a5.4 5.4 0 0 0 0-7.6Z"/>'),
  arrow: icon('<path d="m9 5 7 7-7 7"/>'),
};
const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const emptyPage = () => ({ items: [], page: 0, hasMore: false, loading: false, error: '', scroll: 0 });
const time = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const count = value => value >= 10000 ? `${(value / 10000).toFixed(1)}万` : String(value || 0);

/** Session-local navigation. Reads may be cancelled; queue writes never retry. */
export class SearchPanel {
  constructor(container, { apiClient = api, playlists = playlistManager, stateManager = state, bus = eventBus, importer = playlistImporter } = {}) {
    Object.assign(this, { container, _api: apiClient, _playlists: playlists, _state: stateManager, _bus: bus, _importer: importer });
    this._searchRequest = new LatestRequest(); this._detailRequest = new LatestRequest();
    this._cache = new PlaylistDetailCache(); this._pages = { songs: emptyPage(), playlists: emptyPage() };
    this._type = 'songs'; this._keyword = ''; this._view = 'results'; this._detail = null;
    this._detailLoading = false; this._detailError = ''; this._visibleSongs = 50; this._detailScroll = 0;
    this._pendingWrites = new Set(); this._debounceTimer = null; this._wasOpen = false; this._composing = false;
    this._buildDOM();
    this._unsubscribe = bus.on('ui:changed', ui => this._onUI(ui));
    this._unsubscribePlaylists = bus.on('playlist:changed', () => { if (this._wasOpen) this._renderDetailActions(); });
    this._unsubscribeImport = importer?.subscribe(() => this._renderProgress());
    this._unsubscribeQueueGate = queueMutationGate.subscribe(() => this._renderProgress());
    this._viewport = () => {
      const viewport = window.visualViewport;
      container.style.setProperty('--search-viewport-height', `${viewport?.height || window.innerHeight}px`);
      container.style.setProperty('--search-viewport-top', `${viewport?.offsetTop || 0}px`);
    };
    window.visualViewport?.addEventListener('resize', this._viewport);
    window.visualViewport?.addEventListener('scroll', this._viewport);
    window.addEventListener('resize', this._viewport);
    this._viewport(); this._render();
  }

  _onUI(ui) {
    if (this._wasOpen === ui.searchOpen) return;
    this._wasOpen = ui.searchOpen;
    if (!ui.searchOpen) {
      this._rememberScroll(); this._cancelSearch(); this.container.style.display = 'none';
      this._returnFocus?.focus?.({ preventScroll: true }); return;
    }
    this._returnFocus = document.activeElement; this.container.style.display = 'flex';
    this.container.querySelector('.search-input').value = this._keyword;
    this._render(); this.container.querySelector(this._view === 'detail' ? '.search-back' : '.search-input').focus();
    if (this._view === 'detail' && !this._detail?.songs) this._openPlaylist(this._detail);
    else if (this._view === 'results' && this._keyword && !this._pages[this._type].page) this._doSearch(this._keyword);
  }

  _close() { if (this._state.ui.searchOpen) this._state.toggleUI('searchOpen'); }

  _buildDOM() {
    this.container.innerHTML = `<div class="search-backdrop"></div>
      <section class="search-panel" role="dialog" aria-modal="true" aria-labelledby="music-search-title">
        <div class="music-search-heading"><div><span class="search-eyebrow">发现你的下一首</span><h2 id="music-search-title">搜索音乐</h2></div>
          <button type="button" class="search-close search-icon-btn" aria-label="关闭搜索" title="关闭搜索">${icons.close}</button></div>
        <div class="search-header"><span class="search-input-icon">${icons.search}</span>
          <input class="search-input" type="search" placeholder="搜索歌曲、歌手或歌单" aria-label="搜索关键词" autocomplete="off" />
          <button type="button" class="search-clear search-icon-btn" aria-label="清空关键词" title="清空关键词" hidden>${icons.close}</button></div>
        <div class="search-tabs" role="tablist" aria-label="搜索类型">
          <button type="button" role="tab" id="search-tab-songs" aria-controls="music-search-results" data-search-type="songs">歌曲</button>
          <button type="button" role="tab" id="search-tab-playlists" aria-controls="music-search-results" data-search-type="playlists">歌单</button><span class="search-provider">QQ 音乐</span></div>
        <div class="search-detail-nav" hidden><button type="button" class="search-back search-text-btn">${icons.back}返回搜索结果</button></div>
        <div class="search-detail-actions" hidden></div>
        <div class="search-results" id="music-search-results" role="tabpanel" aria-labelledby="search-tab-songs"></div>
        <div class="search-import-progress" role="status" aria-live="polite" hidden></div></section>`;
    this._click = event => {
      const button = event.target.closest('button');
      if (event.target.classList.contains('search-backdrop') || button?.classList.contains('search-close')) { this._close(); return; }
      if (!button) {
        const row = event.target.closest('[data-row-song-index]');
        const songs = this._view === 'detail' ? this._detail?.songs : this._pages.songs.items;
        const song = row && songs?.[Number(row.dataset.rowSongIndex)];
        if (song) this._enqueue(song, true);
        return;
      }
      if (button.disabled) return;
      if (button.classList.contains('search-clear')) { this.container.querySelector('.search-input').value = ''; this._changeKeyword(''); this.container.querySelector('.search-input').focus(); }
      else if (button.dataset.searchType) this._switchType(button.dataset.searchType);
      else if (button.classList.contains('search-back')) this._back();
      else if (button.dataset.playlistId) this._openPlaylist(this._pages.playlists.items.find(item => item.id === button.dataset.playlistId));
      else if (button.dataset.songIndex != null) {
        const songs = this._view === 'detail' ? this._detail?.songs : this._pages.songs.items;
        const song = songs?.[Number(button.dataset.songIndex)];
        if (song) button.dataset.songAction === 'save' ? this._saveSong(song) : this._enqueue(song, button.dataset.songAction === 'play', button);
      } else if (button.dataset.searchAction === 'more') this._doSearch(this._keyword, true);
      else if (button.dataset.searchAction === 'retry') this._doSearch(this._keyword, this._pages[this._type].page > 0);
      else if (button.dataset.searchAction === 'retry-detail') this._openPlaylist(this._detail);
      else if (button.dataset.searchAction === 'more-detail') { this._visibleSongs += 50; this._render(true); }
      else if (button.dataset.searchAction === 'save-playlist') this._savePlaylist();
      else if (button.dataset.searchAction === 'append-playlist') this._startImport(false);
      else if (button.dataset.searchAction === 'play-playlist') this._startImport(true);
      else if (button.dataset.searchAction === 'stop-import') this._importer?.stop();
    };
    this.container.addEventListener('click', this._click);
    this._imageError = event => {
      if (event.target.tagName !== 'IMG') return;
      const fallback = document.createElement('span'); fallback.className = `${event.target.className} search-cover-placeholder`;
      fallback.innerHTML = icons.music; event.target.replaceWith(fallback);
    };
    this.container.addEventListener('error', this._imageError, true);
    const input = this.container.querySelector('.search-input');
    input.addEventListener('compositionstart', () => { this._composing = true; this._cancelSearch(); });
    input.addEventListener('compositionend', () => { this._composing = false; this._changeKeyword(input.value.trim()); });
    input.addEventListener('input', () => { if (!this._composing) this._changeKeyword(input.value.trim()); });
    this._keydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); this._close(); }
      else if (['Enter', ' '].includes(event.key) && event.target.matches('[data-row-song-index]')) {
        event.preventDefault(); const songs = this._view === 'detail' ? this._detail?.songs : this._pages.songs.items;
        const song = songs?.[Number(event.target.dataset.rowSongIndex)]; if (song) this._enqueue(song, true);
      }
      else if (event.key === 'Enter' && event.target === input && !event.isComposing && !this._composing) {
        event.preventDefault(); this._cancelSearch(); this._doSearch(input.value.trim());
      } else if (event.key === 'Tab') {
        const focusable = [...this.container.querySelectorAll('button:not(:disabled), input, summary, [tabindex="0"]')].filter(node => node.getClientRects().length > 0);
        const index = focusable.indexOf(document.activeElement);
        if (!focusable.length) return;
        if (event.shiftKey && index <= 0) { event.preventDefault(); focusable.at(-1).focus(); }
        else if (!event.shiftKey && (index === focusable.length - 1 || index === -1)) { event.preventDefault(); focusable[0].focus(); }
      } else if (['ArrowLeft', 'ArrowRight'].includes(event.key) && event.target.matches('[role="tab"]')) {
        event.preventDefault(); this._switchType(this._type === 'songs' ? 'playlists' : 'songs'); this.container.querySelector(`[data-search-type="${this._type}"]`).focus();
      }
    };
    this.container.addEventListener('keydown', this._keydown);
  }

  _changeKeyword(keyword) {
    this._cancelSearch(); this._keyword = keyword; this._pages = { songs: emptyPage(), playlists: emptyPage() }; this._view = 'results'; this._render();
    this._debounceTimer = setTimeout(() => { this._debounceTimer = null; this._doSearch(keyword); }, 300);
  }
  _switchType(type) {
    if (type === this._type && this._view === 'results') return;
    this._rememberScroll(); this._cancelSearch(); this._view = 'results'; this._type = type; this._render();
    if (this._keyword && !this._pages[type].page) this._doSearch(this._keyword);
  }
  _rememberScroll() {
    const scroll = this.container.querySelector('.search-results').scrollTop;
    if (this._view === 'detail') this._detailScroll = scroll; else this._pages[this._type].scroll = scroll;
  }

  async _doSearch(keyword, append = false) {
    clearTimeout(this._debounceTimer); this._debounceTimer = null;
    if (keyword !== this._keyword) { this._keyword = keyword; this._pages = { songs: emptyPage(), playlists: emptyPage() }; }
    this._view = 'results'; const type = this._type; const result = this._pages[type];
    if (append && result.loading) return;
    const request = this._searchRequest.begin(); const page = append ? result.page + 1 : 1;
    if (append) this._rememberScroll(); else { result.items = []; result.page = 0; result.scroll = 0; }
    result.error = ''; result.loading = Boolean(keyword); this._render(); if (!keyword) return;
    try {
      const options = { signal: request.signal, page, limit: 20, silent: true };
      const data = await (type === 'songs' ? this._api.search(keyword, options) : this._api.searchPlaylists(keyword, options));
      if (!request.isCurrent()) return;
      const normalized = type === 'songs' ? songPage(data, page) : playlistPage(data, page);
      const key = item => type === 'songs' ? item.song_mid || `${item.artist}\0${item.title}\0${item.album}` : item.id;
      const known = new Set(result.items.map(key));
      const fresh = normalized.items.filter(item => { const id = key(item); if (known.has(id)) return false; known.add(id); return true; });
      result.items.push(...fresh); result.page = page; result.hasMore = normalized.hasMore && fresh.length > 0;
    } catch (error) {
      if (!request.isCurrent()) return;
      result.error = error.name === 'TimeoutError' ? '搜索超时，请稍后重试' : error.status ? '暂时无法搜索，请稍后重试' : error.message || '搜索失败，请稍后重试';
    } finally { if (request.isCurrent()) { result.loading = false; this._render(); } }
  }

  async _openPlaylist(playlist) {
    if (!playlist) return;
    if (this._view !== 'detail') { this._rememberScroll(); this._detailScroll = 0; }
    this._cancelSearch(); this._view = 'detail'; this._detail = playlist;
    this._visibleSongs = 50; this._detailError = ''; this._detailLoading = true;
    const request = this._detailRequest.begin(); this._render();
    try {
      const cached = this._cache.get(playlist.id);
      const detail = cached || playlistDetail(await this._api.getPlaylist(playlist.id, { signal: request.signal, silent: true }), playlist);
      if (!request.isCurrent()) return;
      this._cache.set(playlist.id, detail); this._detail = detail;
    } catch (error) { if (request.isCurrent()) this._detailError = error.status ? '无法读取歌单，请稍后重试' : error.message || '无法读取歌单'; }
    finally { if (request.isCurrent()) { this._detailLoading = false; this._render(); } }
  }
  _back() { this._cancelSearch(); this._view = 'results'; this._render(); this.container.querySelector('[data-search-type="playlists"]').focus(); }
  _cover(url, className) {
    const cover = safeCover(url);
    return cover ? `<img class="${className}" src="${esc(resolveCoverUrl(cover))}" alt="" loading="lazy" decoding="async" />` : `<span class="${className} search-cover-placeholder">${icons.music}</span>`;
  }
  _songMarkup(song, index) {
    const disabled = !song.song_mid;
    const action = (name, title, image) => `<button type="button" class="search-icon-btn sri-${name === 'save' ? 'playlist' : name}" data-song-index="${index}" data-song-action="${name}" aria-label="${title}：${esc(song.title)}" title="${title}" ${disabled || this._pendingWrites.has(song.song_mid) || (name !== 'save' && this._importer?.running) ? 'disabled' : ''}>${image}</button>`;
    return `<article class="search-result-item${disabled ? ' search-song-unavailable' : ''}" data-row-song-index="${index}" ${disabled ? '' : `tabindex="0" role="group" aria-label="${esc(song.title)}，回车播放"`}>${this._cover(song.cover, 'sri-cover')}<div class="sri-info"><div class="sri-title" title="${esc(song.title)}">${esc(song.title)}</div>
      <div class="sri-artist" title="${esc(song.artist)}">${esc(song.artist || '未知歌手')}<span class="sri-album">${song.album ? ` · ${esc(song.album)}` : ''}</span></div>${disabled ? '<span class="search-unavailable-label">暂不可导入</span>' : ''}</div>
      <span class="sri-duration">${song.duration_ms ? time(song.duration_ms) : '—'}</span><div class="sri-actions">${action('play', '立即播放', icons.play)}${action('add', '添加到队列', icons.add)}${action('save', '收藏到我的歌单', icons.heart)}</div></article>`;
  }

  _render(preserveScroll = false) {
    if (preserveScroll) this._rememberScroll();
    const result = this._pages[this._type]; const detail = this._view === 'detail';
    this.container.querySelector('.search-tabs').hidden = detail; this.container.querySelector('.search-detail-nav').hidden = !detail;
    this.container.querySelector('.search-clear').hidden = !this._keyword;
    for (const type of ['songs', 'playlists']) {
      const tab = this.container.querySelector(`[data-search-type="${type}"]`);
      tab.setAttribute('aria-selected', String(type === this._type)); tab.tabIndex = type === this._type ? 0 : -1;
    }
    const element = this.container.querySelector('.search-results');
    element.setAttribute('aria-labelledby', detail ? 'music-search-title' : `search-tab-${this._type}`);
    element.setAttribute('aria-busy', String(detail ? this._detailLoading : result.loading));
    if (detail) {
      const playlist = this._detail;
      if (this._detailLoading) element.innerHTML = this._loading();
      else if (this._detailError) element.innerHTML = this._message(this._detailError, 'retry-detail');
      else {
        const songs = playlist?.songs || []; const partial = playlist.songCount > songs.length;
        element.innerHTML = `<div class="search-playlist-hero">${this._cover(playlist.cover, 'search-detail-cover')}<div><span class="search-eyebrow">QQ 音乐歌单</span><h3>${esc(playlist.name)}</h3><p>${esc(playlist.creator || '未知创建者')} · ${partial ? `已获取 ${songs.length} / ${playlist.songCount}` : songs.length} 首</p></div></div>
          ${playlist.description ? `<details class="search-playlist-description"><summary>歌单简介</summary><p>${esc(playlist.description)}</p></details>` : ''}${partial ? '<p class="search-partial-note">部分歌曲暂未返回，仅能保存或导入已获取的歌曲。</p>' : ''}
          <div class="search-result-summary">${songs.length} 首歌曲</div>${songs.length ? songs.slice(0, this._visibleSongs).map((song, index) => this._songMarkup(song, index)).join('') : this._message('这个歌单暂时没有可显示的歌曲')}
          ${songs.length > this._visibleSongs ? '<button type="button" class="search-more" data-search-action="more-detail">显示更多歌曲</button>' : ''}`;
      }
    } else if (result.loading && !result.items.length) element.innerHTML = this._loading();
    else if (!this._keyword) element.innerHTML = `<div class="search-welcome"><span class="search-welcome-icon">${icons.music}</span><strong>找到此刻想听的音乐</strong><p>输入歌名、歌手，或切换到歌单探索更多收藏</p></div>`;
    else {
      const items = this._type === 'songs' ? result.items.map((song, index) => this._songMarkup(song, index)).join('') : result.items.map(playlist => `<button type="button" class="search-playlist-card" data-playlist-id="${esc(playlist.id)}">${this._cover(playlist.cover, 'search-playlist-cover')}<span class="search-playlist-info"><strong>${esc(playlist.name)}</strong><span>${esc(playlist.creator || '未知创建者')} · ${playlist.songCount} 首</span><small>${count(playlist.playCount)} 次播放</small></span><span class="search-playlist-arrow">${icons.arrow}</span></button>`).join('');
      element.innerHTML = `${items ? `<div class="search-result-summary">已找到 ${result.items.length} ${this._type === 'songs' ? '首歌曲' : '个歌单'}</div>${items}` : ''}${result.error ? this._message(result.error, 'retry') : !items ? this._message('未找到相关结果，试试其他关键词') : ''}
        ${result.loading ? '<div class="search-loading" role="status">正在加载更多…</div>' : result.hasMore && !result.error ? '<button type="button" class="search-more" data-search-action="more">加载更多</button>' : ''}`;
    }
    element.scrollTop = detail ? this._detailScroll : result.scroll;
    this._renderDetailActions(); this._renderProgress();
  }
  _loading() { return '<div class="search-loading" role="status">正在寻找音乐…</div><div class="search-skeleton" aria-hidden="true"></div><div class="search-skeleton" aria-hidden="true"></div><div class="search-skeleton" aria-hidden="true"></div>'; }
  _message(message, retry = '') { return `<div class="${retry ? 'search-error' : 'search-empty'}" role="status">${esc(message)}${retry ? `<button type="button" class="search-text-btn" data-search-action="${retry}">重新尝试</button>` : ''}</div>`; }
  _renderDetailActions() {
    const element = this.container.querySelector('.search-detail-actions');
    element.hidden = this._view !== 'detail' || this._detailLoading || Boolean(this._detailError); if (element.hidden) return;
    const usable = this._detail?.songs?.some(song => song.song_mid) && !this._pendingWrites.size; const saved = this._playlists.findSource?.(this._detail.id);
    element.innerHTML = `<button type="button" class="search-primary-btn" data-search-action="append-playlist" ${!usable || this._importer?.running ? 'disabled' : ''}>${icons.add}加入队列</button><button type="button" class="search-secondary-btn" data-search-action="play-playlist" ${!usable || this._importer?.running ? 'disabled' : ''}>${icons.play}播放全部</button><button type="button" class="search-secondary-btn" data-search-action="save-playlist" ${!usable || saved ? 'disabled' : ''}>${icons.save}${saved ? '已保存' : '保存到我的歌单'}</button>`;
  }
  async _enqueue(song, playNow, button) {
    if (!song.song_mid || this._pendingWrites.has(song.song_mid) || this._importer?.running || queueMutationGate.clearing) return;
    this._pendingWrites.add(song.song_mid); if (button) button.disabled = true;
    try {
      await this._api.addToQueue(song.song_mid, { title: song.title, artist: song.artist, duration_ms: song.duration_ms, cover_url: song.cover, playNow });
      if (playNow) {
        this._state.updatePlayback({ status: 'started', position: 0, song: { ...song, duration: song.duration_ms / 1000 } });
        if (song.cover) this._bus.emit('cover:load', song.cover); this._close();
      }
      this._bus.emit('toast', { message: playNow ? '正在播放' : '已添加到队列', level: 'success' }); this._refreshQueue();
    } catch (_) { /* API reports failures. Never retry a queue write. */ }
    finally { this._pendingWrites.delete(song.song_mid); if (this._wasOpen) this._render(true); }
  }
  async _refreshQueue() {
    this._queueRequest ||= new LatestRequest(); const request = this._queueRequest.begin(); const revision = this._state.queueRevision;
    try {
      const data = await this._api.getQueue({ signal: request.signal, silent: true }); const raw = data.items || data.queue || [];
      if (request.isCurrent() && Array.isArray(raw)) this._state.updateQueue(raw.map(song => ({ ...song, artwork: song.artwork || song.cover_url || '' })), { expectedRevision: revision });
    } catch (_) { /* WebSocket will reconcile the queue. */ }
  }
  _saveSong(song) {
    const ok = this._playlists.addTrackToDefault?.(song);
    if (!this._playlists.lastError) this._bus.emit('toast', { message: ok ? '已收藏到我的歌单' : '歌曲已在歌单中', level: ok ? 'success' : 'info' });
  }
  _savePlaylist() {
    if (!this._detail?.songs) return;
    const result = this._playlists.createFromQQ?.(this._detail);
    if (result) this._bus.emit('toast', { message: result.exists ? '这个歌单已保存' : '已保存到我的歌单', level: 'success' });
    this._renderDetailActions();
  }
  _startImport(playNow) {
    if (!this._importer || this._importer.running || this._pendingWrites.size || !this._detail?.songs) return;
    this._importer.start({ id: `qq:${this._detail.id}`, name: this._detail.name, entries: this._detail.songs.map(song => ({ ...song, kind: 'song', line: songLine(song) })), playNow, playFirstSuccess: true });
  }
  _renderProgress() {
    const element = this.container.querySelector('.search-import-progress'); const task = this._importer?.task;
    element.hidden = !task;
    if (task) {
      const label = task.uncertain ? '请求结果不确定，请检查队列后再操作' : task.running ? `正在导入：${task.current || task.name}` : task.stopped ? '导入已停止，已加入的歌曲保留' : task.interrupted ? '导入已中断' : '导入完成';
      element.innerHTML = `<div><strong>${esc(label)}</strong><span>成功 ${task.ok} · 失败 ${task.fail} · 共 ${task.total} 首</span></div><progress max="${task.total || 1}" value="${task.ok + task.fail}" aria-label="导入进度"></progress>${task.running ? '<button type="button" class="search-text-btn" data-search-action="stop-import">停止导入</button>' : ''}`;
    }
    for (const button of this.container.querySelectorAll('[data-search-action="append-playlist"], [data-search-action="play-playlist"], [data-song-action="play"], [data-song-action="add"]')) {
      const songs = this._view === 'detail' ? this._detail?.songs : this._pages.songs.items; const song = songs?.[Number(button.dataset.songIndex)];
      button.disabled = queueMutationGate.clearing || Boolean(this._importer?.running) || (button.dataset.songIndex != null ? !song?.song_mid || this._pendingWrites.has(song.song_mid) : Boolean(this._pendingWrites.size) || !songs?.some(song => song.song_mid));
    }
  }
  _cancelSearch() {
    clearTimeout(this._debounceTimer); this._debounceTimer = null; this._searchRequest.cancel(); this._detailRequest.cancel();
    for (const result of Object.values(this._pages)) result.loading = false; this._detailLoading = false;
  }
  dispose() {
    this._cancelSearch(); this._queueRequest?.cancel(); this._unsubscribe?.(); this._unsubscribePlaylists?.(); this._unsubscribeImport?.(); this._unsubscribeQueueGate?.();
    this.container.removeEventListener('click', this._click); this.container.removeEventListener('keydown', this._keydown); this.container.removeEventListener('error', this._imageError, true);
    window.visualViewport?.removeEventListener('resize', this._viewport); window.visualViewport?.removeEventListener('scroll', this._viewport); window.removeEventListener('resize', this._viewport);
  }
}
