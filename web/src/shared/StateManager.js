import { eventBus } from './EventBus.js';

/**
 * Centralized application state.
 * Modules read state via getters and mutate it via dedicated update methods.
 * Every mutation emits an event so reactive modules can respond.
 */
class StateManager {
  constructor() {
    // ── Position interpolation (WS currently sends every ~1s, too coarse for karaoke) ──
    this._posBase = 0;       // last WS position
    this._posBaseTs = 0;     // performance.now() at that moment

    this.state = {
      playback: {
        status: 'idle',
        position: 0,
        song: null,
        bpm: 120,
      },
      queue: [],
      lyrics: {
        lines: [],
        currentIndex: -1,
      },
      connection: {
        wsConnected: false,
        apiReachable: true,
      },
      ui: {
        searchOpen: false,
        queueOpen: false,
        shelfOpen: false,
        cookieOpen: false,
        visualSettingsOpen: false,
      },
      auth: {
        qqLoggedIn: false,
      },
      user: {
        idleTime: 0,
        isMobile: /Mobi|Android/i.test(navigator.userAgent),
      },
    };

    this._idleTimer = null;
    this._wasIdle = false;
    this._startIdleTracking();
  }

  /** Playback state */

  updatePlayback(data) {
    const prev = this.state.playback;
    this.state.playback = { ...this.state.playback, ...data };
    eventBus.emit('playback:changed', this.state.playback);

    if (data.status === 'started' && prev.status !== 'started') {
      eventBus.emit('playback:started', this.state.playback);
    }
    if (data.status === 'finished') {
      eventBus.emit('playback:finished', this.state.playback);
    }
    if (data.status === 'paused') {
      eventBus.emit('playback:paused', this.state.playback);
    }
    if (data.status === 'error') {
      eventBus.emit('playback:error', this.state.playback);
    }
    if (data.position !== undefined) {
      // Feed interpolation clock
      this._posBase = data.position;
      this._posBaseTs = performance.now();
      eventBus.emit('playback:progress', this.state.playback);
    }
    // Reset interpolation on song change
    if (data.status === 'started' || data.status === 'finished') {
      this._posBase = data.position || 0;
      this._posBaseTs = performance.now();
    }
  }

  /** Queue */

  updateQueue(queue) {
    this.state.queue = queue;
    eventBus.emit('queue:changed', this.state.queue);
  }

  /** Lyrics */

  updateLyrics(lines) {
    this.state.lyrics = { lines, currentIndex: -1 };
    eventBus.emit('lyrics:loaded', this.state.lyrics);
  }

  /**
   * Smooth playback position — linearly interpolates between WS updates.
   * WS sends progress every ~1s; between those, this advances at wall-clock rate.
   */
  getInterpolatedPosition() {
    if (this._posBaseTs <= 0) return this.state.playback.position || 0;
    if (this.state.playback.status !== 'playing' && this.state.playback.status !== 'started') return this._posBase;
    const elapsed = (performance.now() - this._posBaseTs) / 1000;
    return this._posBase + elapsed;
  }

  syncLyrics(position) {
    const { lines, currentIndex } = this.state.lyrics;
    if (!lines.length) return;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= position) idx = i;
      else break;
    }
    if (idx !== currentIndex) {
      this.state.lyrics.currentIndex = idx;
      eventBus.emit('lyrics:progress', { index: idx, line: lines[idx] || null });
    }
  }

  /** Connection */

  updateConnection(data) {
    const prev = this.state.connection;
    this.state.connection = { ...this.state.connection, ...data };
    if (prev.wsConnected !== this.state.connection.wsConnected) {
      eventBus.emit('connection:changed', this.state.connection);
    }
  }

  /** UI toggles */

  toggleUI(key) {
    this.state.ui[key] = !this.state.ui[key];
    eventBus.emit('ui:changed', this.state.ui);
  }

  /** Auth */

  updateAuth(data) {
    this.state.auth = { ...this.state.auth, ...data };
    eventBus.emit('auth:changed', this.state.auth);
  }

  /** Idle tracking for performance auto-dimming */

  _startIdleTracking() {
    const reset = () => {
      this.state.user.idleTime = 0;
      if (this._wasIdle) {
        this._wasIdle = false;
        eventBus.emit('user:active');
      }
    };
    ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(e =>
      document.addEventListener(e, reset, { passive: true })
    );
    this._idleTimer = setInterval(() => {
      this.state.user.idleTime += 1;
      if (this.state.user.idleTime === 300) {
        this._wasIdle = true;
        eventBus.emit('user:idle');
      }
    }, 1000);
  }

  get playback() { return this.state.playback; }
  get queue() { return this.state.queue; }
  get lyrics() { return this.state.lyrics; }
  get connection() { return this.state.connection; }
  get ui() { return this.state.ui; }
  get auth() { return this.state.auth; }
  get user() { return this.state.user; }
}

export const state = new StateManager();
