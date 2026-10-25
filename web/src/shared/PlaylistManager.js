import { eventBus } from './EventBus.js';
import { normalizeSong, songLine, safeCover } from '../core/QQMusicData.js';

const STORAGE_KEY = 'minerats-playlists-v2';
const lines = text => String(text || '').split(/[\n\r]+/).map(line => line.trim()).filter(Boolean);

/** Backwards-compatible text playlists with optional exact QQ song snapshots. */
export class PlaylistManager {
  constructor({ storage, bus = eventBus } = {}) {
    this._bus = bus; this._playlists = []; this.lastError = '';
    try {
      this._storage = storage ?? globalThis.localStorage;
      const value = JSON.parse(this._storage?.getItem(STORAGE_KEY) || '[]'); if (Array.isArray(value)) this._playlists = value;
    } catch (_) { /* Preserve stored data until an explicit successful write. */ }
  }
  get playlists() { return this._playlists; }
  _commit(next) {
    this.lastError = '';
    try {
      if (!this._storage) throw new Error('Storage unavailable');
      this._storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_) {
      this.lastError = '无法保存到此浏览器，存储空间不足或已禁用本地存储';
      this._bus.emit('toast', { message: this.lastError, level: 'error' }); return false;
    }
    this._playlists = next; this._bus.emit('playlist:changed', next); return true;
  }
  _new(name, text) {
    return { id: `pl_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
      name: String(name || '未命名歌单').trim().slice(0, 50) || '未命名歌单', songs: text || '', cover: '', createdAt: Date.now() };
  }
  create(name, songsText) {
    const playlist = this._new(name, songsText);
    return this._commit([...this._playlists, playlist]) ? playlist : null;
  }
  delete(id) { return this._commit(this._playlists.filter(playlist => playlist.id !== id)); }
  get(id) { return this._playlists.find(playlist => playlist.id === id) || null; }
  getSongs(id) { return lines(this.get(id)?.songs); }
  getEntries(id) {
    const playlist = this.get(id); const text = this.getSongs(id);
    // If external/legacy code has replaced the text, never associate it with unrelated old IDs.
    return Array.isArray(playlist?.entries) && playlist.entries.length === text.length && playlist.entries.every((entry, i) => entry.line === text[i])
      ? playlist.entries.map(entry => ({ ...entry })) : text.map(line => ({ kind: 'text', line }));
  }
  addSong(id, value) {
    this.lastError = ''; const playlist = this.get(id); const line = String(value || '').trim();
    if (!playlist || !line || this.getSongs(id).includes(line)) return false;
    const updated = { ...playlist, songs: [...this.getSongs(id), line].join('\n') };
    if (playlist.entries) updated.entries = [...this.getEntries(id), { kind: 'text', line }];
    return this._commit(this._playlists.map(item => item.id === id ? updated : item));
  }
  setCover(id, url) {
    return this._commit(this._playlists.map(item => item.id === id ? { ...item, cover: safeCover(url) } : item));
  }
  getDefault() { return this._playlists[0] || this.create('我的收藏'); }
  addSongToDefault(line) { const playlist = this.getDefault(); return playlist ? this.addSong(playlist.id, line) : false; }
  addTrackToDefault(raw) {
    this.lastError = ''; const song = normalizeSong(raw); if (!song.song_mid) return false;
    const playlist = this._playlists[0] || this._new('我的收藏', '');
    const entries = this.getEntries(playlist.id);
    if (entries.some(entry => entry.kind === 'song' && entry.song_mid === song.song_mid)) return false;
    const line = songLine(song);
    // Upgrade a text-only favorite to the exact selected version, instead of duplicating it.
    const textIndex = entries.findIndex(entry => entry.kind === 'text' && entry.line === line);
    const entry = { ...song, kind: 'song', line };
    if (textIndex >= 0) entries[textIndex] = entry; else entries.push(entry);
    const updated = { ...playlist, entries, songs: entries.map(item => item.line).join('\n'), cover: playlist.cover || song.cover };
    const next = this.get(playlist.id) ? this._playlists.map(item => item.id === playlist.id ? updated : item) : [...this._playlists, updated];
    return this._commit(next);
  }
  findSource(id) { return this._playlists.find(playlist => playlist.source === 'qqmusic' && playlist.sourcePlaylistId === String(id)) || null; }
  createFromQQ(detail) {
    this.lastError = ''; const existing = this.findSource(detail.id); if (existing) return { playlist: existing, exists: true };
    const entries = (detail.songs || []).map(raw => { const song = normalizeSong(raw); return { ...song, kind: 'song', line: songLine(song) }; });
    if (!entries.some(entry => entry.song_mid)) return null;
    const playlist = { ...this._new(detail.name, entries.map(entry => entry.line).join('\n')), cover: safeCover(detail.cover),
      entries, source: 'qqmusic', sourcePlaylistId: String(detail.id) };
    return this._commit([...this._playlists, playlist]) ? { playlist, exists: false } : null;
  }
}

export const playlistManager = new PlaylistManager();
