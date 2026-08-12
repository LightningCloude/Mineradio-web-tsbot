import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';
import { playlistManager } from '../shared/PlaylistManager.js';

/**
 * Playlist panel — shows playlist cards, paste-to-create, batch-import.
 *
 * Each playlist stores raw song names (one per line). Clicking a playlist
 * card batch-searches each song and adds the first result to the server queue,
 * AutoPlayTsbot-style.
 */
export class QueuePanel {
  constructor(container) {
    this.container = container;
    this._attached = false;
    this._importing = false; // true while batch-importing
    this._buildDOM();
    eventBus.on('ui:changed', (ui) => {
      if (ui.queueOpen) {
        if (!this._attached) this._attachToBody();
        this._positionPanel();
        this.container.classList.add('show');
        this._render();
      } else {
        this.container.classList.remove('show');
      }
    });
    eventBus.on('playlist:changed', () => this._render());
    window.addEventListener('resize', () => {
      if (this.container.classList.contains('show')) this._positionPanel();
    });
  }

  _attachToBody() {
    document.body.appendChild(this.container);
    this._attached = true;
    this.container.addEventListener('click', (e) => e.stopPropagation());
  }

  _positionPanel() {
    const btn = document.querySelector('[data-action="queue"]');
    if (!btn) return;

    const rect = btn.getBoundingClientRect();
    const panelWidth = Math.min(420, Math.max(0, window.innerWidth - 32));
    const halfWidth = panelWidth / 2;
    const desiredCenter = rect.left + rect.width / 2;
    const center = Math.max(16 + halfWidth, Math.min(window.innerWidth - 16 - halfWidth, desiredCenter));

    this.container.style.left = `${center}px`;
    this.container.style.bottom = `${Math.max(16, window.innerHeight - rect.top + 14)}px`;
  }

  _buildDOM() {
    this.container.className = 'mini-queue-popover';
    this.container.innerHTML = `
      <div class="mini-queue-head">
        <div>
          <div class="mini-queue-title">My Playlists</div>
          <div class="mini-queue-count"></div>
        </div>
        <div class="mini-queue-actions">
          <button class="mini-queue-paste" title="Create playlist from paste">+</button>
          <button class="mini-queue-close">X</button>
        </div>
      </div>
      <div class="mini-queue-list" id="playlist-card-list"></div>
      <div class="mini-queue-empty">No playlists — paste a song list or add via</div>
      <!-- Paste/create area (hidden by default) -->
      <div class="playlist-paste-area" style="display:none">
        <input class="playlist-paste-name" placeholder="Playlist name" />
        <textarea class="playlist-paste-input" placeholder="Paste songs, one per line&#10;Format: Artist - Title"></textarea>
        <div class="playlist-paste-actions">
          <button class="playlist-paste-confirm">Create playlist</button>
          <button class="playlist-paste-cancel">Cancel</button>
        </div>
      </div>
      <!-- Batch import log (hidden by default) -->
      <div class="playlist-import-log" style="display:none"></div>
    `;

    this.container.querySelector('.mini-queue-close').addEventListener('click', (e) => {
      e.stopPropagation();
      state.toggleUI('queueOpen');
    });

    // Toggle paste area
    const pasteBtn = this.container.querySelector('.mini-queue-paste');
    const pasteArea = this.container.querySelector('.playlist-paste-area');
    const listEl = this.container.querySelector('.mini-queue-list');
    const emptyEl = this.container.querySelector('.mini-queue-empty');

    pasteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = pasteArea.style.display === 'none';
      pasteArea.style.display = show ? 'flex' : 'none';
      if (listEl) listEl.style.display = show ? 'none' : '';
      if (emptyEl) emptyEl.style.display = show ? 'none' : '';
    });

    this.container.querySelector('.playlist-paste-cancel').addEventListener('click', (e) => {
      e.stopPropagation();
      pasteArea.style.display = 'none';
      if (listEl) listEl.style.display = '';
      this._render();
    });

    this.container.querySelector('.playlist-paste-confirm').addEventListener('click', (e) => {
      e.stopPropagation();
      const nameInput = this.container.querySelector('.playlist-paste-name');
      const textInput = this.container.querySelector('.playlist-paste-input');
      const name = nameInput.value.trim() || 'Playlist ' + new Date().toLocaleDateString();
      const songs = textInput.value.trim();
      if (!songs) return;
      playlistManager.create(name, songs);
      nameInput.value = '';
      textInput.value = '';
      pasteArea.style.display = 'none';
      if (listEl) listEl.style.display = '';
      eventBus.emit('toast', { message: 'Playlist created: ' + name, level: 'success' });
    });
  }

  _render() {
    const list = this.container.querySelector('.mini-queue-list');
    const empty = this.container.querySelector('.mini-queue-empty');
    const count = this.container.querySelector('.mini-queue-count');
    const importLog = this.container.querySelector('.playlist-import-log');
    const playlists = playlistManager.playlists;

    if (importLog && importLog.style.display === 'block') return; // don't overlay import log

    if (!playlists.length) {
      if (list) list.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (count) count.textContent = '';
      return;
    }

    if (empty) empty.style.display = 'none';
    if (count) count.textContent = playlists.length + ' lists';

    if (list) {
      list.innerHTML = playlists.map(pl => {
        const songCount = pl.songs ? pl.songs.split(/[\n\r]+/).filter(l => l.trim()).length : 0;
        return `
        <div class="playlist-card-item" data-id="${pl.id}">
          <img class="playlist-card-cover" src="${this._escAttr(resolveCoverUrl(pl.cover))}" alt="" />
          <div class="playlist-card-info">
            <div class="playlist-card-name">${this._esc(pl.name)}</div>
            <div class="playlist-card-sub">${songCount} songs</div>
          </div>
          <button class="playlist-card-delete" data-id="${pl.id}" title="Delete">X</button>
        </div>
        `;
      }).join('');

      // Click card = batch import
      list.querySelectorAll('.playlist-card-item').forEach(item => {
        item.addEventListener('click', (e) => {
          if (e.target.closest('.playlist-card-delete')) return;
          const id = item.dataset.id;
          this._startBatchImport(id);
        });
      });

      // Delete button
      list.querySelectorAll('.playlist-card-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const id = btn.dataset.id;
          const pl = playlistManager.get(id);
          if (pl && confirm('Delete "' + pl.name + '"?')) {
            playlistManager.delete(id);
          }
        });
      });
    }
  }

  /**
   * Batch import all songs from a playlist into the server queue.
   * AutoPlayTsbot-style: search each line, enqueue first result.
   */
  async _startBatchImport(playlistId) {
    if (this._importing) return;
    const pl = playlistManager.get(playlistId);
    if (!pl) return;

    const songs = playlistManager.getSongs(playlistId);
    if (!songs.length) {
      eventBus.emit('toast', { message: 'Playlist is empty', level: 'warn' });
      return;
    }

    this._importing = true;
    const listEl = this.container.querySelector('.mini-queue-list');
    const emptyEl = this.container.querySelector('.mini-queue-empty');
    const importLog = this.container.querySelector('.playlist-import-log');
    const pasteArea = this.container.querySelector('.playlist-paste-area');
    if (pasteArea) pasteArea.style.display = 'none';
    if (listEl) listEl.style.display = 'none';
    if (emptyEl) emptyEl.style.display = 'none';
    if (importLog) {
      importLog.style.display = 'block';
      importLog.innerHTML = '<div class="import-log-title">Importing: ' + this._esc(pl.name) + ' (' + songs.length + ' songs)</div>';
    }

    let ok = 0, fail = 0;
    let firstCover = null;

    for (let i = 0; i < songs.length; i++) {
      const line = songs[i];
      if (importLog) {
        importLog.innerHTML += `<div class="import-log-row"><span class="import-idx">${i + 1}.</span> <span class="import-line">${this._esc(line)}</span> <span class="import-status searching">searching...</span></div>`;
        importLog.scrollTop = importLog.scrollHeight;
      }

      try {
        const data = await api.search(line);
        const results = data.items || data.songs || data.results || [];
        if (results.length > 0) {
          const song = results[0];
          const mid = song.song_mid || song.mid || '';
          const title = song.title || song.name || song.songname || line;
          const artist = song.artist || song.singer || song.singername || '';
          const cover = song.artwork_url || song.cover || song.album_cover || '';
          const duration = song.duration_ms || song.duration || 0;

          // Capture first cover as playlist cover
          if (!firstCover && cover) {
            firstCover = cover;
            playlistManager.setCover(playlistId, cover);
          }

          await api.addToQueue(mid, {
            title, artist, duration_ms: duration,
            cover_url: cover, playNow: i === 0,
          });

          if (i === 0 && cover) eventBus.emit('cover:load', cover);

          ok++;
          const rowEl = importLog.querySelectorAll('.import-log-row')[i];
          if (rowEl) {
            rowEl.querySelector('.import-status').className = 'import-status ok';
            rowEl.querySelector('.import-status').textContent = 'added';
          }
        } else {
          fail++;
          const rowEl = importLog.querySelectorAll('.import-log-row')[i];
          if (rowEl) {
            rowEl.querySelector('.import-status').className = 'import-status fail';
            rowEl.querySelector('.import-status').textContent = 'not found';
          }
        }
      } catch (e) {
        fail++;
        const rowEl = importLog.querySelectorAll('.import-log-row')[i];
        if (rowEl) {
          rowEl.querySelector('.import-status').className = 'import-status fail';
          rowEl.querySelector('.import-status').textContent = 'error';
        }
      }
    }

    if (importLog) {
      importLog.innerHTML += `<div class="import-log-summary">Done: ${ok} added, ${fail} failed</div>`;
    }

    eventBus.emit('toast', { message: 'Imported ' + ok + '/' + songs.length + ' songs from ' + pl.name, level: ok > 0 ? 'success' : 'warn' });
    state.toggleUI('queueOpen');
    this._importing = false;
  }

  _escAttr(s) { if (!s) return ''; return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  _esc(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
}
