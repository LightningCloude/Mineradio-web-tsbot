import { eventBus } from '../shared/EventBus.js';

/**
 * AudioAnalyzer — real-time audio beat detection via Web Audio API.
 *
 * Ported from Mineradio's processRealtimeBeatEngine (index.html:4391-4581).
 * Splits audio into 5 frequency bands, tracks fast/slow envelopes, computes
 * spectral-flux onset detection with an adaptive threshold, estimates tempo
 * from inter-onset intervals, and classifies beats into a 4-beat cycle.
 *
 * Key simplifications vs Mineradio:
 *   - No DJ mode (no server-side offline lock-step)
 *   - No voice mask suppression
 *   - Tempo tracking uses median gap (simpler than weighted histogram)
 *   - Single AnalyserNode (not separate frequency + time-domain)
 */

// ── Constants ──
const FFT_SIZE = 2048;
const SMOOTHING = 0.85;

// Frequency band edges (Hz) — matches Mineradio
const BANDS = {
  sub:  [38, 74],
  kick: [52, 165],
  body: [165, 420],
  vocal:[420, 2600],
  snap: [1800, 9200],
};

// Visual-only ranges ported from Mineradio's Sonic audio monitor.  They are
// intentionally narrower than generic EQ bands: more spatial separation makes
// the terrain move from a broad low-frequency centre into progressively finer
// outer detail.  Beat detection above remains unchanged.
const VISUAL_BANDS = {
  subBass:    [32, 58],
  bass:       [58, 118],
  lowMid:     [118, 260],
  mid:        [260, 720],
  highMid:    [720, 1800],
  presence:   [1800, 4200],
  brilliance: [4200, 9000],
  air:        [9000, 16000],
};

// ── Envelope follower ──
function follow(cur, next, upTau, downTau, dt) {
  const tau = next > cur ? upTau : downTau;
  return cur + (next - cur) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function median(arr) {
  if (!arr || !arr.length) return 0;
  const sorted = arr.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * 0.5)] : 0;
}

/**
 * Compute RMS in a frequency band from byte frequency data.
 */
function bandRms(data, sampleRate, fftSize, hz0, hz1) {
  const binHz = sampleRate / fftSize;
  const a = Math.max(1, Math.floor(hz0 / binHz));
  const b = Math.min(data.length - 1, Math.ceil(hz1 / binHz));
  let sum = 0;
  let count = 0;
  for (let i = a; i <= b; i++) {
    const v = data[i] / 255;
    sum += v * v;
    count++;
  }
  return count ? Math.sqrt(sum / count) : 0;
}

export class AudioAnalyzer {
  constructor() {
    this._ctx = null;
    this._source = null;
    this._analyser = null;
    this._freqData = null;
    this._timeData = null;
    this._connected = false;
    this._audioEl = null;

    // ── Band state (fast/slow followers, peaks, previous) ──
    this._bands = {};
    for (const name of Object.keys(BANDS)) {
      this._bands[name] = { fast: 0, slow: 0, peak: 0, prev: 0 };
    }
    this._prevRms = 0;

    this._visualBands = {};
    for (const name of Object.keys(VISUAL_BANDS)) {
      this._visualBands[name] = { fast: 0, peak: 0 };
    }
    this._visualFrame = null;
    this._visualFrameAt = 0;

    // ── Onset state ──
    this._onsetAvg = 0.012;
    this._onsetPeak = 0.060;

    // ── Tempo state ──
    this._lastHitAt = -10;
    this._gapHistory = [];       // recent inter-onset gaps
    this._tempoGap = 0;          // current BPM-based beat interval
    this._tempoConfidence = 0;
    this._beatCount = 0;
    this._primedFrames = 0;
    this._warmupUntil = 0;

    // ── Current values (exposed for shader uniforms) ──
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.energy = 0;
    this.beatPulse = 0;
    this.beatScore = 0;
    this.beatType = null;
    this.tempoConfidence = 0;
    this.tempoBpm = 0;
  }

  /**
   * Connect to an HTML audio element.
   * Must be called after user gesture (click/tap) due to autoplay policy.
   */
  connect(audioEl) {
    if (this._connected && this._audioEl === audioEl) return;

    // Disconnect previous
    this.disconnect();

    try {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      this._source = this._ctx.createMediaElementSource(audioEl);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = FFT_SIZE;
      this._analyser.smoothingTimeConstant = SMOOTHING;

      // Connect: source → analyser → destination (so audio still plays)
      this._source.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);

      this._freqData = new Uint8Array(this._analyser.frequencyBinCount);
      this._timeData = new Uint8Array(this._analyser.frequencyBinCount);
      this._connected = true;
      this._audioEl = audioEl;

      // Reset state
      this._reset();

      console.log('[AudioAnalyzer] Connected to audio element');
    } catch (e) {
      console.error('[AudioAnalyzer] Failed to connect:', e);
      this._connected = false;
    }
  }

  disconnect() {
    if (this._source) {
      try { this._source.disconnect(); } catch (e) { /* ignore */ }
    }
    if (this._analyser) {
      try { this._analyser.disconnect(); } catch (e) { /* ignore */ }
    }
    if (this._ctx && this._ctx.state !== 'closed') {
      // Don't close — might be reused. Just suspend.
      try { this._ctx.suspend(); } catch (e) { /* ignore */ }
    }
    this._source = null;
    this._analyser = null;
    this._connected = false;
    this._audioEl = null;
  }

  /**
   * Ensure AudioContext is running (resume after suspend/user gesture).
   */
  async _ensureRunning() {
    if (this._ctx && this._ctx.state === 'suspended') {
      try { await this._ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  _reset() {
    for (const b of Object.values(this._bands)) {
      b.fast = 0;
      b.slow = 0;
      b.peak = 0;
      b.prev = 0;
    }
    this._prevRms = 0;
    for (const b of Object.values(this._visualBands)) {
      b.fast = 0;
      b.peak = 0;
    }
    this._visualFrame = null;
    this._visualFrameAt = 0;
    this._onsetAvg = 0.012;
    this._onsetPeak = 0.060;
    this._lastHitAt = -10;
    this._gapHistory = [];
    this._tempoGap = 0;
    this._tempoConfidence = 0;
    this._beatCount = 0;
    this._primedFrames = 0;
    this._warmupUntil = (this._audioEl && isFinite(this._audioEl.currentTime))
      ? this._audioEl.currentTime + 1.15
      : 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.energy = 0;
    this.beatPulse = 0;
    this.beatScore = 0;
    this.beatType = null;
    this.tempoConfidence = 0;
    this.tempoBpm = 0;
  }

  /**
   * Main per-frame tick. Call from render loop (~60fps). Returns beat event or null.
   * @param {number} dt — delta time in seconds
   * @returns {object|null} beat event or null
   */
  tick(dt) {
    if (!this._connected || !this._analyser || !this._ctx) return null;
    const audioEl = this._audioEl;
    if (!audioEl || audioEl.paused) return null;

    dt = Math.max(0.001, Math.min(0.080, dt || 0.016));

    // ── Read analyser data ──
    this._analyser.getByteFrequencyData(this._freqData);
    this._analyser.getByteTimeDomainData(this._timeData);

    const sr = this._ctx.sampleRate || 44100;
    const fftSize = this._analyser.fftSize;

    // ── Band RMS ──
    const sub = bandRms(this._freqData, sr, fftSize, BANDS.sub[0], BANDS.sub[1]);
    const kick = bandRms(this._freqData, sr, fftSize, BANDS.kick[0], BANDS.kick[1]);
    const body = bandRms(this._freqData, sr, fftSize, BANDS.body[0], BANDS.body[1]);
    const vocal = bandRms(this._freqData, sr, fftSize, BANDS.vocal[0], BANDS.vocal[1]);
    const snap = bandRms(this._freqData, sr, fftSize, BANDS.snap[0], BANDS.snap[1]);
    const low = Math.min(1, kick * 0.86 + sub * 0.42);
    const visualRaw = {};
    for (const [name, range] of Object.entries(VISUAL_BANDS)) {
      visualRaw[name] = bandRms(this._freqData, sr, fftSize, range[0], range[1]);
    }

    // ── Time-domain RMS ──
    let rms = 0;
    for (let i = 0; i < this._timeData.length; i++) {
      const tv = (this._timeData[i] - 128) / 128;
      rms += tv * tv;
    }
    rms = Math.sqrt(rms / this._timeData.length);

    // ── Fast/slow followers (matching Mineradio time constants) ──
    const bs = this._bands;
    bs.sub.fast  = follow(bs.sub.fast,  sub,  0.018, 0.064, dt);
    bs.sub.slow  = follow(bs.sub.slow,  sub,  0.320, 0.520, dt);
    bs.kick.fast = follow(bs.kick.fast, low,  0.016, 0.070, dt);
    bs.kick.slow = follow(bs.kick.slow, low,  0.300, 0.540, dt);
    bs.body.fast = follow(bs.body.fast, body, 0.020, 0.082, dt);
    bs.body.slow = follow(bs.body.slow, body, 0.360, 0.600, dt);
    bs.vocal.fast= follow(bs.vocal.fast,vocal,0.026, 0.090, dt);
    bs.vocal.slow= follow(bs.vocal.slow,vocal,0.340, 0.580, dt);
    bs.snap.fast = follow(bs.snap.fast, snap, 0.012, 0.060, dt);
    bs.snap.slow = follow(bs.snap.slow, snap, 0.300, 0.520, dt);

    // ── Peak tracking ──
    const peakDecay = 0.990;
    bs.sub.peak  = Math.max(bs.sub.peak  * Math.pow(peakDecay, dt * 60), sub,  0.045);
    bs.kick.peak = Math.max(bs.kick.peak * Math.pow(0.989, dt * 60),    low,  0.060);
    bs.body.peak = Math.max(bs.body.peak * Math.pow(peakDecay, dt * 60), body, 0.040);
    bs.vocal.peak= Math.max(bs.vocal.peak* Math.pow(peakDecay, dt * 60), vocal,0.040);
    bs.snap.peak = Math.max(bs.snap.peak * Math.pow(peakDecay, dt * 60), snap, 0.035);

    // ── Spectral flux ──
    const subFlux   = Math.max(0, sub   - bs.sub.prev);
    const lowFlux   = Math.max(0, low   - bs.kick.prev);
    const bodyFlux  = Math.max(0, body  - bs.body.prev);
    const vocalFlux = Math.max(0, vocal - bs.vocal.prev);
    const snapFlux  = Math.max(0, snap  - bs.snap.prev);
    const rmsFlux   = Math.max(0, rms   - this._prevRms);

    // ── Rise (fast - slow) ──
    const subRise   = Math.max(0, bs.sub.fast   - bs.sub.slow);
    const lowRise   = Math.max(0, bs.kick.fast  - bs.kick.slow);
    const bodyRise  = Math.max(0, bs.body.fast  - bs.body.slow);
    const vocalRise = Math.max(0, bs.vocal.fast - bs.vocal.slow);
    const snapRise  = Math.max(0, bs.snap.fast  - bs.snap.slow);

    // ── Onset signal (Mineradio weights) ──
    const drumOnset = subRise * 0.88 + subFlux * 0.66 + lowRise * 1.62 + lowFlux * 1.34;
    const musicalOnset = bodyRise * 0.34 + bodyFlux * 0.24 + vocalRise * 0.52
                       + vocalFlux * 0.36 + snapRise * 0.08 + snapFlux * 0.06 + rmsFlux * 0.20;
    const onset = drumOnset + musicalOnset * 0.16;

    // ── Adaptive threshold ──
    const avgTau = onset > this._onsetAvg ? 1.10 : 0.34;
    this._onsetAvg = follow(this._onsetAvg, onset, avgTau, avgTau, dt);
    this._onsetPeak = Math.max(
      this._onsetPeak * Math.pow(0.988, dt * 60), onset, 0.032
    );
    const floor = this._onsetAvg * 0.84;
    const score = clamp01((onset - floor) / Math.max(0.014, this._onsetPeak - floor));

    // ── Normalized band values ──
    const subNorm  = clamp01(sub  / Math.max(0.045, bs.sub.peak  * 0.70));
    const lowNorm  = clamp01(low  / Math.max(0.060, bs.kick.peak * 0.72));
    const bodyNorm = clamp01(body / Math.max(0.045, bs.body.peak * 0.72));
    const vocalNorm= clamp01(vocal/ Math.max(0.045, bs.vocal.peak* 0.72));
    const snapNorm = clamp01(snap / Math.max(0.040, bs.snap.peak * 0.72));

    // ── Expose current energy values for shaders ──
    this.bass   = lowNorm;
    this.mid    = (bodyNorm + vocalNorm) * 0.5;
    this.treble = snapNorm;
    this.energy = clamp01(lowNorm * 0.5 + bodyNorm * 0.3 + vocalNorm * 0.15 + snapNorm * 0.05);
    this._updateVisualFrame(visualRaw, dt, lowNorm, bodyNorm, snapNorm);

    // ── Tempo tracking ──
    const nowT = audioEl.currentTime || 0;
    this._primedFrames++;
    const warmingUp = nowT < this._warmupUntil || this._primedFrames < 18;

    const gapFromLast = nowT - this._lastHitAt;
    const expectedGap = this._tempoGap > 0 ? this._tempoGap : 0;
    const phaseWindow = expectedGap > 0
      ? Math.max(0.055, Math.min(0.105, expectedGap * 0.16))
      : 0;
    const tempoDue = expectedGap > 0
      && gapFromLast > expectedGap - phaseWindow
      && gapFromLast < expectedGap + phaseWindow;

    // ── Drum gate ──
    const lowPresence = Math.max(lowNorm, subNorm * 0.74);
    const lowAttack = lowRise + lowFlux * 0.72 + subRise * 0.58 + subFlux * 0.40;
    const lowDominance = low / Math.max(0.001, vocal * 0.84 + body * 0.36 + snap * 0.10);
    const lowFluxDom = (lowFlux + subFlux * 0.58)
      / Math.max(0.001, vocalFlux * 0.72 + bodyFlux * 0.42 + snapFlux * 0.16);

    let drumGate = lowPresence > 0.38
      && lowAttack > Math.max(0.014, this._onsetAvg * 0.34);
    drumGate = drumGate
      && (lowDominance > 0.72 || lowFluxDom > 1.02 || subNorm > 0.56);

    const strongTransient = drumGate && score > 0.54
      && drumOnset > this._onsetAvg * 0.84;
    const kickTransient = drumGate && score > 0.40
      && lowAttack > Math.max(0.018, this._onsetAvg * 0.46);
    const tempoAssist = tempoDue && this._tempoConfidence > 0.42
      && drumGate && lowPresence > 0.48
      && score > 0.22
      && lowAttack > Math.max(0.016, this._onsetAvg * 0.34);

    let candidateHit = strongTransient || kickTransient || tempoAssist;
    if (warmingUp) candidateHit = false;

    // ── Rhythm gate ──
    const hasTempoLock = this._tempoGap >= 0.42 && this._tempoGap <= 0.88
      && this._tempoConfidence > 0.38;
    const lockedWindow = hasTempoLock
      ? Math.max(0.070, Math.min(0.110, this._tempoGap * 0.16))
      : 0;

    let rhythmAccept = false;
    if (candidateHit) {
      if (this._lastHitAt < 0) {
        rhythmAccept = strongTransient && score > 0.62 && lowPresence > 0.48;
      } else if (hasTempoLock) {
        const oneBeatErr = Math.abs(gapFromLast - this._tempoGap);
        const twoBeatErr = Math.abs(gapFromLast - this._tempoGap * 2);
        rhythmAccept = oneBeatErr <= lockedWindow && (kickTransient || strongTransient);
        rhythmAccept = rhythmAccept
          || (twoBeatErr <= lockedWindow * 1.35 && strongTransient && score > 0.58);
        rhythmAccept = rhythmAccept
          || (gapFromLast > this._tempoGap * 1.55 && strongTransient && lowPresence > 0.44);
      } else {
        rhythmAccept = gapFromLast >= 0.340
          && strongTransient && score > 0.58 && lowPresence > 0.44;
      }
    }

    // ── Minimum gap enforcement ──
    let hit = candidateHit && rhythmAccept;
    const minGap = hasTempoLock
      ? Math.max(0.400, Math.min(0.540, this._tempoGap * 0.72))
      : 0.340;
    if (hit && gapFromLast < minGap) {
      hit = false;
    }

    // ── Update previous values ──
    bs.sub.prev  = sub;
    bs.kick.prev = low;
    bs.body.prev = body;
    bs.vocal.prev= vocal;
    bs.snap.prev = snap;
    this._prevRms = rms;

    // ── Decay beat pulse ──
    this.beatPulse *= Math.pow(0.18, dt);
    this._tempoConfidence *= Math.pow(0.996, dt * 60);

    if (!hit) {
      this.tempoBpm = this._tempoGap > 0 ? 60 / this._tempoGap : 0;
      this.tempoConfidence = this._tempoConfidence;
      this.beatScore = score;
      return null;
    }

    // ── Beat HIT — update tempo ──
    if (this._lastHitAt > 0) {
      let gap = nowT - this._lastHitAt;
      // Time-scale gap to valid range
      while (gap > 0.88) gap *= 0.5;
      while (gap < 0.42) gap *= 2.0;
      if (gap >= 0.42 && gap <= 0.88) {
        // Update tempo estimate
        const tempoEase = hasTempoLock ? 0.10 : 0.22;
        this._tempoGap = this._tempoGap
          ? this._tempoGap * (1 - tempoEase) + gap * tempoEase
          : gap;
        this._tempoConfidence = Math.min(1,
          this._tempoConfidence + (tempoAssist ? 0.04 : 0.18)
        );

        // Keep recent gaps for median-based fallback
        this._gapHistory.push(gap);
        if (this._gapHistory.length > 24) this._gapHistory.shift();
      }
    }

    this._lastHitAt = nowT;
    this._beatCount++;

    // ── Beat strength ──
    let strength = clamp01(
      0.24 + score * 0.36 + lowPresence * 0.34
      + Math.min(1.25, lowDominance) * 0.07 + rmsFlux * 0.95
    );
    if (tempoAssist) {
      strength = Math.max(strength,
        0.48 + this._tempoConfidence * 0.10 + lowPresence * 0.14
      );
    }

    // ── Combo classification (4-beat cycle) ──
    const comboSlot = (this._beatCount - 1) % 4;
    let combo = comboSlot === 0 ? 'downbeat'
      : (comboSlot === 1 ? 'push'
        : (comboSlot === 2 ? 'drop' : 'rebound'));
    if (strength > 0.84 && comboSlot !== 0) combo = 'accent';

    this.beatPulse = Math.max(this.beatPulse, strength);
    this.beatType = combo;
    this.beatScore = score;
    this.tempoBpm = this._tempoGap > 0 ? 60 / this._tempoGap : 0;
    this.tempoConfidence = this._tempoConfidence;

    const beatEvent = {
      hit: true,
      time: nowT,
      strength,
      confidence: clamp01(score * 0.62 + lowPresence * 0.26 + this._tempoConfidence * 0.12),
      low: Math.max(0.05, lowPresence),
      body: Math.max(0.02, bodyNorm * 0.62),
      snap: Math.max(0.02, snapNorm),
      mass: clamp01(lowPresence * 0.76 + bodyNorm * 0.20),
      sharpness: clamp01(snapNorm * 0.70 + bodyNorm * 0.12),
      combo,
      score,
      bpm: this.tempoBpm,
      tempoConfidence: this._tempoConfidence,
    };

    // ── Emit via EventBus ──
    eventBus.emit('beat:detected', beatEvent);

    return beatEvent;
  }

  /**
   * Reset analysis state (e.g. on song change).
   */
  reset() {
    this._reset();
  }

  _updateVisualFrame(raw, dt, lowNorm, bodyNorm, snapNorm) {
    const normalized = {};
    for (const name of Object.keys(VISUAL_BANDS)) {
      const state = this._visualBands[name];
      const value = Math.max(0, Number(raw[name]) || 0);
      state.fast = follow(state.fast, value, 0.030, 0.110, dt);
      state.peak = Math.max(state.peak * Math.pow(0.992, dt * 60), value, 0.025);
      normalized[name] = clamp01(state.fast / Math.max(0.025, state.peak * 0.76));
    }

    const highEnergy = normalized.highMid * 0.38
      + normalized.presence * 0.32
      + normalized.brilliance * 0.20
      + normalized.air * 0.10;
    this._visualFrame = Object.freeze({
      source: 'realtime',
      ...normalized,
      kickEnvelope: clamp01(Math.max(this.beatPulse, lowNorm * 0.72)),
      energy: clamp01(
        normalized.subBass * 0.18
        + normalized.bass * 0.22
        + normalized.lowMid * 0.15
        + normalized.mid * 0.18
        + highEnergy * 0.27
      ),
      sharpness: clamp01(Math.max(snapNorm * 0.70, highEnergy)),
    });
    this._visualFrameAt = performance.now();
  }

  /** Return a recent immutable FFT frame, or null when live audio is absent. */
  getVisualFrame(maxAgeMs = 250) {
    if (!this._connected || !this._audioEl || this._audioEl.paused || !this._visualFrame) {
      return null;
    }
    if (performance.now() - this._visualFrameAt > maxAgeMs) return null;
    return this._visualFrame;
  }

  /**
   * Destroy — full cleanup.
   */
  destroy() {
    this.disconnect();
    if (this._ctx) {
      try { this._ctx.close(); } catch (e) { /* ignore */ }
    }
    this._ctx = null;
  }
}

export const audioAnalyzer = new AudioAnalyzer();
