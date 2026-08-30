const DB_NAME = 'mineradio-web-tsbot';
const STORE_NAME = 'beat-analysis';
const DB_VERSION = 1;
const CACHE_VERSION = 1;
const MAX_ENTRIES = 80;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function normalize(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase();
}

/**
 * Build a stable, browser-local cache key without using queue position. Queue
 * ids change between sessions, while provider ids (or title + artist) remain
 * useful across plays by the same user.
 */
export function songBeatCacheKey(song) {
  const trackId = normalize(song?.song_mid || song?.mid || song?.track_id || song?.id);
  const source = normalize(song?.source || song?.provider || trackId.split(':')[0]);
  const title = normalize(song?.title || song?.name);
  const artist = normalize(song?.artist || song?.singer);
  const identity = trackId || `${title}\u0000${artist}`;
  return identity ? `v${CACHE_VERSION}:${source || 'unknown'}:${identity}` : '';
}

function isBeatGrid(result) {
  return Boolean(result)
    && Array.isArray(result.beats)
    && result.beats.length > 0;
}

/**
 * Per-browser persistent cache for decoded offline beat grids. IndexedDB keeps
 * potentially large analysis maps out of the API/database path. If storage is
 * unavailable (for example private browsing), it falls back to this tab's
 * memory cache and never affects playback.
 */
export class LocalBeatAnalysisCache {
  constructor({
    indexedDBFactory = globalThis.indexedDB,
    now = () => Date.now(),
    maxEntries = MAX_ENTRIES,
    maxAgeMs = MAX_AGE_MS,
  } = {}) {
    this.indexedDBFactory = indexedDBFactory;
    this.now = now;
    this.maxEntries = maxEntries;
    this.maxAgeMs = maxAgeMs;
    this.memory = new Map();
    this._dbPromise = null;
    this._storageDisabled = !indexedDBFactory;
  }

  keyFor(song) {
    return songBeatCacheKey(song);
  }

  async get(song) {
    const key = this.keyFor(song);
    if (!key) return null;

    let record = this.memory.get(key) || null;
    if (!record && !this._storageDisabled) {
      try {
        record = await this._read(key);
      } catch (error) {
        this._disableStorage(error);
      }
    }
    if (!record || !isBeatGrid(record.result) || this._isExpired(record)) {
      if (record) this.memory.delete(key);
      if (record && !this._storageDisabled) this._delete(key).catch(() => {});
      return null;
    }
    this.memory.set(key, record);
    return record.result;
  }

  async set(song, result) {
    const key = this.keyFor(song);
    if (!key || !isBeatGrid(result)) return false;

    const record = {
      key,
      result,
      updatedAt: this.now(),
      version: CACHE_VERSION,
    };
    this.memory.set(key, record);
    if (this._storageDisabled) return true;
    try {
      await this._write(record);
      this._prune().catch(() => {});
      return true;
    } catch (error) {
      this._disableStorage(error);
      return true;
    }
  }

  clearMemory() {
    this.memory.clear();
  }

  _isExpired(record) {
    return record.version !== CACHE_VERSION
      || !Number.isFinite(record.updatedAt)
      || this.now() - record.updatedAt > this.maxAgeMs;
  }

  _disableStorage(error) {
    this._storageDisabled = true;
    console.warn('[MineraTS] Local beat cache storage unavailable:', error?.message || error);
  }

  _open() {
    if (this._storageDisabled) return Promise.reject(new Error('IndexedDB unavailable'));
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      const request = this.indexedDBFactory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open IndexedDB'));
      request.onblocked = () => reject(new Error('IndexedDB open blocked'));
    });
    return this._dbPromise;
  }

  async _read(key) {
    const db = await this._open();
    return this._request(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key));
  }

  async _write(record) {
    const db = await this._open();
    await this._request(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
  }

  async _delete(key) {
    const db = await this._open();
    await this._request(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(key));
  }

  async _prune() {
    const db = await this._open();
    const records = await this._request(
      db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll(),
    );
    const expired = records.filter(record => this._isExpired(record));
    const retained = records
      .filter(record => !this._isExpired(record))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const excess = retained.slice(this.maxEntries);
    const removals = [...expired, ...excess];
    if (!removals.length) return;
    const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
    for (const record of removals) {
      store.delete(record.key);
      this.memory.delete(record.key);
    }
  }

  _request(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
    });
  }
}

export const localBeatAnalysisCache = new LocalBeatAnalysisCache();
