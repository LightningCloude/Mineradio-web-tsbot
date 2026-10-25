// QQ's search and playlist endpoints use different field names and duration units.
const list = value => Array.isArray(value) ? value : [];
const number = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function decodeText(value) {
  const text = String(value ?? '');
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', middot: '·' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

export function safeCover(value) {
  const url = String(value ?? '').trim();
  if (/^\/(?!\/)/.test(url) && !/[\\\u0000-\u0020]/.test(url)) return url;
  try {
    const parsed = new URL(url.startsWith('//') ? `https:${url}` : url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : '';
  } catch { return ''; }
}

export function normalizeSong(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const singers = list(raw.singer).map(person => decodeText(person?.name)).filter(Boolean).join(' / ');
  const album = raw.album && typeof raw.album === 'object' ? raw.album : {};
  const albumMid = String(album.mid || raw.albummid || '');
  const mid = String(raw.song_mid || raw.mid || raw.songmid || '').trim();
  return {
    song_mid: /^[a-zA-Z0-9_-]+$/.test(mid) ? mid : '',
    title: decodeText(raw.title || raw.name || raw.songname || raw.songorig || '未知歌曲'),
    artist: decodeText(raw.artist || singers || (typeof raw.singer === 'string' ? raw.singer : '') || raw.singername || ''),
    album: decodeText(typeof raw.album === 'string' ? raw.album : album.name || raw.albumname || ''),
    cover: safeCover(raw.cover || raw.cover_url || raw.artwork_url || raw.album_cover ||
      (albumMid && /^[a-zA-Z0-9]+$/.test(albumMid) ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '')),
    duration_ms: Math.round(number(raw.duration_ms ?? (raw.interval != null ? number(raw.interval) * 1000 : raw.duration))),
  };
}

export function assertQQSuccess(data) {
  if (!data || typeof data !== 'object') throw new Error('音乐服务返回了无效数据');
  for (const part of [data, data.req, data.req?.data]) {
    if (part?.code != null && Number(part.code) !== 0) throw new Error('QQ 音乐暂时无法返回结果，请稍后重试');
  }
  if (data.subcode != null && Number(data.subcode) !== 0) throw new Error('歌单暂时无法访问，请稍后重试');
}

export function normalizePlaylist(raw = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(raw.dissid || raw.diss_id || raw.id || ''),
    name: decodeText(raw.dissname || raw.name || '未命名歌单'),
    cover: safeCover(raw.imgurl || raw.logo || raw.cover || ''),
    creator: decodeText(raw.creator?.name || raw.nickname || (typeof raw.creator === 'string' ? raw.creator : '') || ''),
    songCount: number(raw.song_count ?? raw.songnum ?? raw.total_song_num),
    playCount: number(raw.listennum ?? raw.visitnum),
    description: decodeText(raw.introduction || raw.desc || ''),
  };
}

export function songPage(data, page = 1, limit = 20) {
  assertQQSuccess(data);
  const raw = list(data.items || data.songs || data.results);
  return { items: raw.map(normalizeSong), hasMore: data.has_more ?? (raw.length === limit), page };
}

export function playlistPage(data, page = 1, limit = 20) {
  assertQQSuccess(data);
  const payload = data.req?.data || {};
  const raw = list(payload.body?.songlist?.list);
  const meta = payload.meta || {};
  const total = number(meta.sum ?? meta.estimate_sum);
  return {
    items: raw.map(normalizePlaylist).filter(item => /^\d+$/.test(item.id)), page,
    hasMore: raw.length > 0 && (total ? page * limit < total : raw.length === limit),
  };
}

export function playlistDetail(data, fallback = {}) {
  assertQQSuccess(data);
  const raw = list(data.cdlist)[0];
  if (!raw) throw new Error('这个歌单不存在、已设为私密或暂时无法访问');
  const songs = list(raw.songlist).map(normalizeSong);
  const normalized = normalizePlaylist(raw);
  return { ...fallback, ...normalized, id: normalized.id || fallback.id,
    songCount: Math.max(normalized.songCount, number(fallback.songCount), songs.length), songs };
}

export function songLine(song) { return String(song.artist ? `${song.artist} - ${song.title}` : song.title).replace(/[\r\n]+/g, ' ').trim(); }

export class PlaylistDetailCache {
  constructor({ now = Date.now, max = 10, ttl = 300000 } = {}) { this.now = now; this.max = max; this.ttl = ttl; this.items = new Map(); }
  get(id) {
    const entry = this.items.get(id);
    if (!entry || this.now() - entry.time >= this.ttl) { this.items.delete(id); return null; }
    this.items.delete(id); this.items.set(id, entry);
    return entry.value;
  }
  set(id, value) {
    this.items.delete(id); this.items.set(id, { value, time: this.now() });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
  }
}
