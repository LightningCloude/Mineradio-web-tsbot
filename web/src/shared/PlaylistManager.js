import { eventBus } from './EventBus.js';

const STORAGE_KEY = 'minerats-playlists-v2';

/**
 * PlaylistManager — multi-playlist system, localStorage-backed.
 *
 * Multiple named playlists, each storing songs as raw text lines (like AutoPlayTsbot).
 * No metadata — just one song name per line ("Artist - Title" or "Title").
 * First song's cover is auto-fetched on demand via search.
 */
class PlaylistManager {
  constructor() {
    this._playlists = [];
    this._load();
  }

  get playlists() { return this._playlists; }

  _save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._playlists)); } catch (e) {}
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) this._playlists = arr;
      }
    } catch (e) { this._playlists = []; }
  }

  /**
   * Create a new playlist.
   * @param {string} name
   * @param {string} [songsText] - raw newline-separated song names
   * @returns {object} the created playlist
   */
  create(name, songsText) {
    name = (name || 'Untitled').trim().slice(0, 50);
    const pl = {
      id: 'pl_' + Date.now(),
      name,
      songs: songsText || '',
      cover: '',
      createdAt: Date.now(),
    };
    this._playlists.push(pl);
    this._save();
    eventBus.emit('playlist:changed', this._playlists);
    return pl;
  }

  /** Delete playlist by ID. */
  delete(id) {
    const idx = this._playlists.findIndex(p => p.id === id);
    if (idx < 0) return;
    this._playlists.splice(idx, 1);
    this._save();
    eventBus.emit('playlist:changed', this._playlists);
  }

  /**
   * Add a song name (text line) to a playlist.
   * @param {string} playlistId
   * @param {string} line — "Artist - Title" or "Title"
   */
  addSong(playlistId, line) {
    const pl = this._playlists.find(p => p.id === playlistId);
    if (!pl) return false;
    line = line.trim();
    if (!line) return false;
    // Dedup
    const existing = pl.songs.split(/[\n\r]+/).map(l => l.trim());
    if (existing.includes(line)) return false;
    pl.songs = pl.songs ? (pl.songs + '\n' + line) : line;
    this._save();
    eventBus.emit('playlist:changed', this._playlists);
    return true;
  }

  /** Get song names as an array from a playlist. */
  getSongs(playlistId) {
    const pl = this._playlists.find(p => p.id === playlistId);
    if (!pl) return [];
    return pl.songs.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 0);
  }

  /** Update cover URL for a playlist. */
  setCover(playlistId, url) {
    const pl = this._playlists.find(p => p.id === playlistId);
    if (!pl) return;
    pl.cover = url;
    this._save();
  }

  /** Get a playlist by ID. */
  get(id) {
    return this._playlists.find(p => p.id === id) || null;
  }

  /** Get (or create) a default playlist. */
  getDefault() {
    if (this._playlists.length === 0) {
      this.create('My Playlist');
    }
    return this._playlists[0];
  }

  /** Add a song line to the default playlist. */
  addSongToDefault(line) {
    const pl = this.getDefault();
    return this.addSong(pl.id, line);
  }
}

export const playlistManager = new PlaylistManager();
