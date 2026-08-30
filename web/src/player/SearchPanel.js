import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';
import { playlistManager } from '../shared/PlaylistManager.js';

async function refreshQueue() {
  try {
    const data = await api.getQueue();
    const raw = data.items || data.queue || data || [];
    state.updateQueue(raw.map(q => ({ ...q, artwork: q.artwork || q.cover_url || '' })));
  } catch (e) { /* ignore */ }
}

/**
 * Overlay search panel with QQ Music search.
 * Opens when searchOpen is toggled in state.ui.
 */
export class SearchPanel {
  constructor(container) {
    this.container = container;
    this._buildDOM();
    eventBus.on('ui:changed', (ui) => {
      this.container.style.display = ui.searchOpen ? 'flex' : 'none';
      if (ui.searchOpen) {
        const inp = this.container.querySelector('.search-input');
        inp.value = '';
        inp.focus();
        this.container.querySelector('.search-results').innerHTML = '<div class="search-hint">输入关键词搜索</div>';
      }
    });
  }

  _buildDOM() {
    this.container.innerHTML = `
      <div class="search-backdrop"></div>
      <div class="search-panel">
        <div class="search-header">
          <input class="search-input" type="text" placeholder="搜索 QQ 音乐..." />
          <button class="search-close">✕</button>
        </div>
        <div class="search-results"><div class="search-hint">输入关键词搜索</div></div>
      </div>
    `;

    this.container.querySelector('.search-backdrop').addEventListener('click', () => {
      state.toggleUI('searchOpen');
    });
    this.container.querySelector('.search-close').addEventListener('click', () => {
      state.toggleUI('searchOpen');
    });

    const input = this.container.querySelector('.search-input');
    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this._doSearch(input.value.trim()), 300);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') state.toggleUI('searchOpen');
    });
  }

  async _doSearch(keyword) {
    const resultsEl = this.container.querySelector('.search-results');
    if (!keyword) {
      resultsEl.innerHTML = '<div class="search-hint">输入关键词搜索</div>';
      return;
    }

    resultsEl.innerHTML = '<div class="search-loading">搜索中...</div>';

    try {
      const data = await api.search(keyword);
      const songs = data.items || data.songs || data.results || [];

      if (!songs.length) {
        // Check if cookie expired
        const cookieOk = await this._checkQQCookie();
        if (!cookieOk) {
          resultsEl.innerHTML = '<div class="search-error">QQ 音乐登录已过期<br/><button class="sri-relogin">重新登录</button></div>';
          resultsEl.querySelector('.sri-relogin')?.addEventListener('click', () => {
            state.toggleUI('searchOpen');
            state.toggleUI('cookieOpen');
          });
        } else {
          resultsEl.innerHTML = '<div class="search-empty">未找到结果</div>';
        }
        return;
      }

      resultsEl.innerHTML = songs.map(song => {
        const rawCover = song.artwork_url || song.cover || song.album_cover || '';
        return `
        <div class="search-result-item"
             data-mid="${song.song_mid || song.mid || ''}"
             data-title="${this._escAttr(song.title || song.name || song.songname || '')}"
             data-artist="${this._escAttr(song.artist || song.singer || song.singername || '')}"
             data-duration="${song.duration_ms || song.duration || 0}"
             data-cover="${this._escAttr(rawCover)}">
          <img class="sri-cover" src="${this._escAttr(resolveCoverUrl(rawCover))}" alt="" />
          <div class="sri-info">
            <div class="sri-title">${this._esc(song.title || song.name || song.songname || '')}</div>
            <div class="sri-artist">${this._esc(song.artist || song.singer || song.singername || '')}</div>
          </div>
          <button class="sri-play" title="立即播放">▶</button>
          <button class="sri-add" title="添加到队列">+</button>
          <button class="sri-playlist" title="加入歌单">♡</button>
        </div>
      `;
      }).join('');

      // ▶ Play now button
      resultsEl.querySelectorAll('.sri-play').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = btn.closest('.search-result-item');
          this._enqueue(item, true);
        });
      });

      resultsEl.querySelectorAll('.sri-add').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = btn.closest('.search-result-item');
          this._enqueue(item, false);
        });
      });

      // Add to playlist button
      resultsEl.querySelectorAll('.sri-playlist').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const item = btn.closest('.search-result-item');
          this._addToPlaylist(item);
        });
      });

      // Click on row = play now
      resultsEl.querySelectorAll('.search-result-item').forEach(item => {
        item.addEventListener('click', () => {
          this._enqueue(item, true);
        });
      });
    } catch (e) {
      resultsEl.innerHTML = '<div class="search-error">搜索失败</div>';
    }
  }

  _escAttr(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async _enqueue(item, playNow) {
    const mid = item.dataset.mid;
    const title = item.dataset.title || '';
    const artist = item.dataset.artist || '';
    const duration = parseInt(item.dataset.duration || '0');
    const cover = item.dataset.cover || '';
    try {
      await api.addToQueue(mid, { title, artist, duration_ms: duration, cover_url: cover, playNow });
      // Instantly show cover if playing now
      if (playNow) {
        const song = { title, artist, cover, duration: duration / 1000, bpm: 120 };
        state.updatePlayback({ status: 'started', position: 0, song });
        // Explicitly load cover into particle stage
        if (cover) eventBus.emit('cover:load', cover);
      }
      state.toggleUI('searchOpen');
      eventBus.emit('toast', { message: playNow ? '正在播放' : '已添加到队列', level: 'success' });
      refreshQueue();
    } catch (e) { /* ApiClient handles toast */ }
  }

  _esc(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  _addToPlaylist(item) {
    const title = item.dataset.title || '';
    const artist = item.dataset.artist || '';
    const line = artist ? artist + ' - ' + title : title;
    const ok = playlistManager.addSongToDefault(line);
    eventBus.emit('toast', {
      message: ok ? 'Added: ' + line : 'Already in playlist',
      level: ok ? 'success' : 'info'
    });
  }

  async _checkQQCookie() {
    try {
      const res = await fetch('/api/admin/qqmusic/status');
      const json = await res.json();
      return !!(json.admin_cookie_set || json.cookie_set);
    } catch (e) {
      return false;
    }
  }
}
