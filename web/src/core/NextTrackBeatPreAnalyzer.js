import { resolveSongAnalysisSource } from './SongAudioSource.js';

function identityValues(song) {
  if (!song) return [];
  return [song.queue_id, song.id, song.track_id, song.song_mid, song.mid]
    .filter(value => value !== undefined && value !== null && value !== '')
    .map(String);
}

export function songAnalysisKey(song) {
  return identityValues(song)[0] || '';
}

export function songCacheName(song) {
  return String(song?.title || song?.name || '').trim();
}

export function selectNextQueueSong(currentSong, queue) {
  return selectUpcomingQueueSongs(currentSong, queue)[0] || null;
}

export function selectUpcomingQueueSongs(currentSong, queue) {
  if (!Array.isArray(queue) || queue.length === 0) return null;

  const currentIds = new Set(identityValues(currentSong));
  const currentIndex = queue.findIndex(item =>
    identityValues(item).some(value => currentIds.has(value))
  );
  if (currentIndex >= 0) return queue.slice(currentIndex + 1);

  // The backend removes a naturally-finished/skipped item before publishing
  // the refreshed queue. In that state the first remaining item is next.
  return queue.slice();
}

/**
 * Low-priority, single-flight beat pre-analysis for the next queued song.
 * It never activates a beat grid; completed work is only kept in the local
 * analyzer and the shared server cache for the next playback transition.
 */
export class NextTrackBeatPreAnalyzer {
  constructor({
    api,
    analyzer,
    resolveSource = resolveSongAnalysisSource,
    // Deliberately leave a quiet interval between full-track downloads. Cache
    // hits still traverse the queue, but misses cannot saturate the proxy.
    delayMs = 8000,
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
    logger = console,
    onReady = () => {},
    onStatus = () => {},
  }) {
    this.api = api;
    this.analyzer = analyzer;
    this.resolveSource = resolveSource;
    this.delayMs = delayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.logger = logger;
    this.onReady = onReady;
    this.onStatus = onStatus;
    this._timer = null;
    this._running = null;
    this._targets = [];
    this._sequenceKey = '';
    this._generation = 0;
    this._completed = new Set();
    this._attempted = new Set();
  }

  schedule(currentSong, queue, currentAnalysisReady) {
    const songs = currentAnalysisReady
      ? selectUpcomingQueueSongs(currentSong, queue)
      : [];
    const targets = (songs || []).map(song => this._targetFor(song)).filter(Boolean);
    const sequenceKey = targets.map(target =>
      `${target.key}\u0000${target.completedKey}\u0000${this.resolveSource(target.song) || ''}`
    ).join('\u0001');

    if (sequenceKey !== this._sequenceKey) {
      this._sequenceKey = sequenceKey;
      this._targets = targets;
      this._generation++;
      this._attempted.clear();
      if (this._timer) this.clearTimer(this._timer);
      this._timer = null;
    }
    this._armNext();
  }

  dispose() {
    this._generation++;
    this._targets = [];
    this._sequenceKey = '';
    this._attempted.clear();
    if (this._timer) this.clearTimer(this._timer);
    this._timer = null;
  }

  _targetFor(song) {
    const key = songAnalysisKey(song);
    const name = songCacheName(song);
    if (!song || !key || !name) return null;
    return {
      song,
      key,
      name,
      completedKey: name.normalize('NFKC').toLocaleLowerCase(),
    };
  }

  _isCurrent(target, generation) {
    return generation === this._generation
      && this._targets.some(candidate => candidate.key === target.key);
  }

  _armNext() {
    if (this._running || this._timer) return;
    const target = this._targets.find(candidate =>
      !this._completed.has(candidate.completedKey)
      && !this._attempted.has(candidate.key)
    );
    if (!target) return;

    const generation = this._generation;
    this._timer = this.setTimer(() => {
      this._timer = null;
      if (!this._isCurrent(target, generation)) {
        this._armNext();
        return;
      }
      this._attempted.add(target.key);
      this._start(target, generation);
    }, this.delayMs);
  }

  _start(target, generation) {
    const task = this._run(target, generation);
    this._running = task;
    task.finally(() => {
      if (this._running === task) this._running = null;
      // Continue through the latest queue snapshot. A failed/unavailable song
      // is considered attempted for this snapshot and cannot block later ones.
      this._armNext();
    });
  }

  async _run(target, generation) {
    let ready = false;
    this.onStatus({ key: target.key, name: target.name, status: 'analyzing' });
    try {
      try {
        const cached = await this.api.getBeatAnalysis(target.name);
        if (cached?.hit && cached.result?.beats?.length) {
          this._completed.add(target.completedKey);
          this.onReady({ key: target.key, name: target.name, source: 'shared-cache' });
          this.onStatus({ key: target.key, name: target.name, status: 'ready', source: 'shared-cache' });
          ready = true;
          this.logger.log('[MineraTS] Next-track beat cache hit:', target.name);
          return;
        }
      } catch (error) {
        this.logger.warn('[MineraTS] Next-track cache lookup failed:', error?.message || error);
      }

      // Queue/track changes invalidate work that has not begun decoding yet.
      if (!this._isCurrent(target, generation)) return;
      const audioUrl = this.resolveSource(target.song);
      if (!audioUrl) return;

      this.logger.log('[MineraTS] Pre-analyzing next track:', target.name);
      const result = await this.analyzer.analyze(
        target.key, audioUrl, target.song.duration
      );
      if (!result?.beats?.length) return;

      // Even if the queue changes during decoding, the completed analysis is
      // still valid and useful to every user, so allow it into shared cache.
      this._completed.add(target.completedKey);
      this.onReady({ key: target.key, name: target.name, source: 'local-analysis' });
      this.onStatus({ key: target.key, name: target.name, status: 'ready', source: 'local-analysis' });
      ready = true;
      try {
        await this.api.storeBeatAnalysis(target.name, result);
      } catch (error) {
        this.logger.warn('[MineraTS] Next-track cache upload failed:', error?.message || error);
      }
    } catch (error) {
      this.logger.warn('[MineraTS] Next-track pre-analysis failed:', error?.message || error);
    } finally {
      if (!ready) {
        this.onStatus({ key: target.key, name: target.name, status: 'idle' });
      }
    }
  }
}
