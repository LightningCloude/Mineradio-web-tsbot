import { eventBus } from '../shared/EventBus.js';

/**
 * Beat engine — dual-mode: real-time audio analysis + fixed BPM grid fallback.
 *
 * Mode 1 — Realtime (AudioAnalyzer):
 *   Receives beat events from AudioAnalyzer via EventBus ('beat:detected').
 *   Beats carry time, strength, combo type, and spectral properties from
 *   live audio onset detection. BPM is continuously tracked.
 *
 * Mode 2 — Fixed grid fallback:
 *   When no real-time data is available (connection issues, no audio element),
 *   falls back to an 8-beat uniform grid at the last known BPM (or 120 default).
 *
 * Beat type assignment for grid fallback (8-beat cycle):
 *   0 → downbeat, 1 → pulse, 2 → accent, 3 → pulse,
 *   4 → drop,    5 → pulse, 6 → rebound, 7 → pulse
 */
export class BeatEngine {
  constructor() {
    this.bpm = 120;
    this._beatInterval = 0.5;
    this._lastBeatIndex = -1;
    this._customGrid = null;
    this._gridIndex = 0;
    this._lastCustomIndex = -1;

    // ── Realtime beat tracking ──
    this._realtimeBeats = [];       // Recent beat events from AudioAnalyzer
    this._realtimeIdx = 0;          // Cursor for getBeatAtWithGrid
    this._lastRealtimeIdx = -1;
    this._realtimeActive = false;   // True when we have recent real-time beats
    this._realtimeBeatCount = 0;    // Total beats detected this song

    // ── Listen for real-time beats ──
    eventBus.on('beat:detected', (beat) => this._onRealtimeBeat(beat));
  }

  // ── Real-time beat input ──

  _onRealtimeBeat(beat) {
    if (!beat || !beat.hit) return;

    // Track BPM from audio analyzer
    if (beat.bpm && beat.bpm > 40 && beat.bpm < 200) {
      this.bpm = beat.bpm;
      this._beatInterval = 60 / this.bpm;
    }

    // Store beat for position-based queries
    this._realtimeBeats.push({
      time: beat.time,
      type: beat.combo || 'pulse',
      intensity: beat.strength || 0.5,
      strength: beat.strength,
      confidence: beat.confidence,
      low: beat.low,
      body: beat.body,
      snap: beat.snap,
      mass: beat.mass,
      sharpness: beat.sharpness,
      score: beat.score,
    });

    this._realtimeBeatCount++;
    this._realtimeActive = true;

    // Prune old beats (keep last 512)
    if (this._realtimeBeats.length > 512) {
      const trim = this._realtimeBeats.length - 512;
      this._realtimeBeats.splice(0, trim);
      this._realtimeIdx = Math.max(0, this._realtimeIdx - trim);
    }
  }

  // ── Config ──

  setBPM(bpm) {
    this.bpm = bpm || 120;
    this._beatInterval = 60 / this.bpm;
    this._lastBeatIndex = -1;
    this._lastCustomIndex = -1;
    this._lastRealtimeIdx = -1;
    // Don't clear realtime beats — they're time-indexed
  }

  // ── Grid fallback ──

  /** Beat type + intensity from 8-beat cycle pattern. */
  _typeFromIndex(idx) {
    const slot = ((idx % 8) + 8) % 8;
    switch (slot) {
      case 0: return { type: 'downbeat', intensity: 1.0 };
      case 2: return { type: 'accent',   intensity: 0.7 };
      case 4: return { type: 'drop',     intensity: 0.85 };
      case 6: return { type: 'rebound',  intensity: 0.65 };
      default: return { type: 'pulse',   intensity: 0.4 };
    }
  }

  /**
   * Query beat info at a given playback position (seconds).
   * Returns null if within the same beat as last call.
   */
  getBeatAt(position) {
    if (!position || position < 0) return null;

    const beatIndex = Math.floor(position / this._beatInterval);
    if (beatIndex === this._lastBeatIndex) return null;
    this._lastBeatIndex = beatIndex;

    const beatTime = beatIndex * this._beatInterval;
    const timeToNextBeat = (beatTime + this._beatInterval) - position;
    const { type, intensity } = this._typeFromIndex(beatIndex);

    return { index: beatIndex, type, intensity, timeToNextBeat };
  }

  // ── Custom grid (offline dj-analyzer, future use) ──

  /** Load pre-analyzed beat grid. Format: [{ time, type, intensity }, ...] */
  loadBeatGrid(grid) {
    if (!grid || !grid.length) return;
    this._customGrid = grid;
    this._gridIndex = 0;
    this._lastCustomIndex = -1;
  }

  clearBeatGrid() {
    this._customGrid = null;
    this._gridIndex = 0;
    this._lastCustomIndex = -1;
  }

  /** Stable section-level energy at an arbitrary playback position. */
  getSectionEnergyAt(position) {
    const grid = this._customGrid;
    if (!grid || !grid.length || !Number.isFinite(position)) return 0;
    let low = 0, high = grid.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (grid[mid].time <= position) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found >= 0 ? Math.max(0, Math.min(1, Number(grid[found].sectionEnergy) || 0)) : 0;
  }

  /**
   * Continuous visual-frequency frame reconstructed from the offline grid.
   * Unlike the old sine-wave substitute, every value is tied to the analyzed
   * beat at the current playback position and its section-level envelope.
   */
  getAnalyzedFrameAt(position) {
    const grid = this._customGrid;
    if (!grid || !grid.length || !Number.isFinite(position)) return null;
    let low = 0, high = grid.length - 1, found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (grid[mid].time <= position) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found < 0) found = 0;
    const beat = grid[found];
    const next = grid[Math.min(grid.length - 1, found + 1)];
    const interval = Math.max(0.24, Number(next?.time) - Number(beat.time) || this._beatInterval);
    const age = Math.max(0, position - Number(beat.time || 0));
    const pulse = Math.exp(-age / Math.max(0.055, interval * 0.24));
    const section = Math.max(0, Math.min(1, Number(beat.sectionEnergy) || 0));
    const strength = Math.max(0, Math.min(1, Number(beat.strength ?? beat.intensity) || 0));
    const lowBand = Math.max(0, Math.min(1, Number(beat.low) || strength * 0.82));
    const bodyBand = Math.max(0, Math.min(1, Number(beat.body) || strength * 0.52));
    const snapBand = Math.max(0, Math.min(1, Number(beat.snap) || strength * 0.30));
    const impact = Math.max(0, Math.min(1, Number(beat.impact) || strength));

    return Object.freeze({
      source: 'analyzed',
      subBass: Math.min(1, section * 0.18 + lowBand * pulse * 0.92),
      bass: Math.min(1, section * 0.22 + lowBand * pulse * 0.78),
      lowMid: Math.min(1, section * 0.46 + (lowBand * 0.22 + bodyBand * 0.56) * pulse),
      mid: Math.min(1, section * 0.68 + bodyBand * pulse * 0.70),
      highMid: Math.min(1, section * 0.34 + (bodyBand * 0.36 + snapBand * 0.40) * pulse),
      presence: Math.min(1, section * 0.16 + snapBand * pulse * 0.68),
      brilliance: Math.min(1, section * 0.10 + snapBand * pulse * 0.52),
      air: Math.min(1, section * 0.07 + snapBand * pulse * 0.34),
      kickEnvelope: Math.min(1, impact * pulse),
      energy: Math.min(1, section * 0.78 + strength * pulse * 0.54),
      sharpness: Math.min(1, snapBand * pulse),
      sectionEnergy: section,
    });
  }

  hasAnalyzedGrid() {
    return Boolean(this._customGrid?.length);
  }

  // ── Unified query ──

  /**
   * Query with real-time beats → custom grid → uniform grid fallback.
   * Called by ParticleStage._onProgress and CameraDirector._onProgress.
   */
  getBeatAtWithGrid(position) {
    // ── Priority 1: Real-time beats ──
    if (this._realtimeActive && this._realtimeBeats.length > 0) {
      // Advance cursor to beats at or before position
      while (this._realtimeIdx < this._realtimeBeats.length
             && this._realtimeBeats[this._realtimeIdx].time <= position) {
        this._realtimeIdx++;
      }
      const beat = this._realtimeBeats[this._realtimeIdx - 1];
      if (beat && this._lastRealtimeIdx !== this._realtimeIdx - 1) {
        this._lastRealtimeIdx = this._realtimeIdx - 1;
        const nextBeat = this._realtimeBeats[this._realtimeIdx];
        return {
          index: this._realtimeIdx - 1,
          type: beat.type,
          intensity: beat.intensity,
          strength: beat.strength,
          confidence: beat.confidence,
          low: beat.low,
          body: beat.body,
          snap: beat.snap,
          mass: beat.mass,
          sharpness: beat.sharpness,
          score: beat.score,
          realtime: true,
          timeToNextBeat: nextBeat ? nextBeat.time - position : 1,
        };
      }
      // If no new beat but realtime is active, return null
      // (realtime beats are event-driven, not continuous)
      return null;
    }

    // ── Priority 2: Custom grid ──
    if (this._customGrid) {
      while (this._gridIndex < this._customGrid.length &&
             this._customGrid[this._gridIndex].time <= position) {
        this._gridIndex++;
      }
      const beat = this._customGrid[this._gridIndex - 1];
      if (beat && this._lastCustomIndex !== this._gridIndex - 1) {
        this._lastCustomIndex = this._gridIndex - 1;
        const nextBeat = this._customGrid[this._gridIndex];
        return {
          index: this._gridIndex - 1,
          type: beat.type || 'pulse',
          intensity: beat.intensity || 0.5,
          strength: beat.strength,
          confidence: beat.confidence,
          low: beat.low,
          body: beat.body,
          snap: beat.snap,
          mass: beat.mass,
          sharpness: beat.sharpness,
          impact: beat.impact,
          sectionEnergy: beat.sectionEnergy,
          offline: true,
          timeToNextBeat: nextBeat ? nextBeat.time - position : 1,
        };
      }
      return null;
    }

    // ── Priority 3: Uniform grid fallback ──
    return this.getBeatAt(position);
  }

  // ── State queries ──

  /** Whether real-time beat detection is active and producing beats. */
  isRealtimeActive() {
    return this._realtimeActive;
  }

  /** Current BPM (from real-time analysis or fallback). */
  getBPM() {
    return this.bpm;
  }

  /** Total real-time beats detected this session. */
  getRealtimeBeatCount() {
    return this._realtimeBeatCount;
  }

  /** Reset real-time state (e.g. on song change). */
  resetRealtime() {
    this._realtimeBeats = [];
    this._realtimeIdx = 0;
    this._lastRealtimeIdx = -1;
    this._realtimeActive = false;
    this._realtimeBeatCount = 0;
    this._lastBeatIndex = -1;
    this._gridIndex = 0;
    this._lastCustomIndex = -1;
  }
}

export const beatEngine = new BeatEngine();
