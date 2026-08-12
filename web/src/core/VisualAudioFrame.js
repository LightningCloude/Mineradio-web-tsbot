const BAND_KEYS = Object.freeze([
  'subBass',
  'bass',
  'lowMid',
  'mid',
  'highMid',
  'presence',
  'brilliance',
  'air',
]);

const EMPTY_FRAME = Object.freeze({
  source: 'idle',
  active: false,
  subBass: 0,
  bass: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  presence: 0,
  brilliance: 0,
  air: 0,
  kickEnvelope: 0,
  energy: 0,
  sharpness: 0,
  sectionEnergy: 0,
});

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function follow(current, target, attack, release, dt) {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / Math.max(0.001, tau)));
}

/**
 * Converts either live FFT features or the existing beat grid into one stable,
 * normalized frame for audio-reactive visuals. Synthetic mode is deliberately
 * deterministic so a missing browser audio stream never creates random jitter.
 */
export class VisualAudioFrameAdapter {
  constructor(analyzer = null, bus = null) {
    this._analyzer = analyzer;
    this._phase = 0;
    this._frame = { ...EMPTY_FRAME };
    this._beatLow = 0;
    this._beatBody = 0;
    this._beatHigh = 0;
    this._beatKick = 0;
    this._sectionEnergy = 0;
    this._sectionTarget = 0;
    this._analysisPending = false;
    this._analyzedFrame = null;

    if (bus && typeof bus.on === 'function') {
      bus.on('visual:beat', beat => this.acceptBeat(beat));
      bus.on('playback:finished', () => this.reset());
    }
  }

  acceptBeat(beat = {}) {
    const strength = clamp01(beat.strength ?? beat.intensity ?? 0.5);
    const low = clamp01(beat.low ?? strength * 0.82);
    const body = clamp01(beat.body ?? strength * 0.52);
    const high = clamp01(beat.snap ?? strength * 0.30);
    const section = clamp01(beat.sectionEnergy);
    const typeBoost = beat.type === 'downbeat' || beat.type === 'drop' ? 1 : 0.78;

    this._beatLow = Math.max(this._beatLow, low * typeBoost);
    this._beatBody = Math.max(this._beatBody, body);
    this._beatHigh = Math.max(this._beatHigh, high);
    this._beatKick = Math.max(this._beatKick, strength * typeBoost);
    this._sectionTarget = Math.max(section, this._sectionTarget * 0.84);
  }

  setSectionEnergy(value) {
    this._sectionTarget = clamp01(value);
  }

  /**
   * Marks the short interval while the current track's offline beat grid is
   * being prepared. The substitute pulse stays local to the visual frame: it
   * never emits a beat event and therefore cannot trigger climax effects.
   */
  setAnalysisPending(pending) {
    this._analysisPending = Boolean(pending);
    if (this._analysisPending) {
      this._sectionTarget = 0;
    }
  }

  isAnalysisPending() {
    return this._analysisPending;
  }

  setAnalyzedFrame(frame) {
    this._analyzedFrame = frame?.source === 'analyzed' ? frame : null;
  }

  tick(dt, active = true) {
    dt = Math.max(0.001, Math.min(0.1, Number(dt) || 1 / 60));
    this._phase += dt;
    this._sectionEnergy = follow(
      this._sectionEnergy,
      active ? this._sectionTarget : 0,
      0.12,
      0.58,
      dt,
    );

    const realtime = active && this._analyzer?.getVisualFrame
      ? this._analyzer.getVisualFrame()
      : null;
    const analyzed = active ? this._analyzedFrame : null;
    const target = realtime ? {
      ...realtime,
      lowMid: Math.max(clamp01(realtime.lowMid), this._sectionEnergy * 0.42),
      mid: Math.max(clamp01(realtime.mid), this._sectionEnergy * 0.62),
      highMid: Math.max(clamp01(realtime.highMid), this._sectionEnergy * 0.34),
      energy: Math.max(clamp01(realtime.energy), this._sectionEnergy * 0.78),
    } : (analyzed ? this._analyzedTarget(analyzed) : (active
      ? (this._analysisPending ? this._analysisFallbackTarget() : this._syntheticTarget())
      : EMPTY_FRAME));
    const source = realtime ? 'realtime' : (analyzed ? 'analyzed' : (active ? 'synthetic' : 'idle'));

    for (const key of BAND_KEYS) {
      this._frame[key] = follow(
        this._frame[key],
        clamp01(target[key]),
        source === 'realtime' ? 0.045 : (source === 'analyzed' ? 0.050 : 0.070),
        source === 'idle' ? 0.62 : 0.30,
        dt,
      );
    }
    this._frame.kickEnvelope = follow(
      this._frame.kickEnvelope,
      clamp01(target.kickEnvelope),
      0.022,
      source === 'idle' ? 0.42 : 0.19,
      dt,
    );
    this._frame.energy = follow(
      this._frame.energy,
      clamp01(target.energy),
      0.055,
      source === 'idle' ? 0.65 : 0.32,
      dt,
    );
    this._frame.sharpness = follow(
      this._frame.sharpness,
      clamp01(target.sharpness),
      0.045,
      0.26,
      dt,
    );
    this._frame.source = source;
    this._frame.active = Boolean(active);
    this._frame.sectionEnergy = this._sectionEnergy;

    const lowDecay = Math.exp(-4.2 * dt);
    const bodyDecay = Math.exp(-5.0 * dt);
    const highDecay = Math.exp(-6.5 * dt);
    this._beatLow *= lowDecay;
    this._beatBody *= bodyDecay;
    this._beatHigh *= highDecay;
    this._beatKick *= Math.exp(-7.2 * dt);
    this._sectionTarget *= Math.exp(-0.45 * dt);

    return Object.freeze({ ...this._frame });
  }

  _syntheticTarget() {
    const slow = 0.5 + 0.5 * Math.sin(this._phase * 0.61);
    const drift = 0.5 + 0.5 * Math.sin(this._phase * 0.37 + 1.4);
    const low = this._beatLow;
    const body = this._beatBody;
    const high = this._beatHigh;
    const kick = this._beatKick;
    const section = this._sectionEnergy;

    return {
      source: 'synthetic',
      subBass: 0.035 + slow * 0.025 + low * 0.88,
      bass: 0.045 + drift * 0.025 + low * 0.74 + kick * 0.12,
      lowMid: 0.050 + slow * 0.030 + body * 0.62 + low * 0.18 + section * 0.34,
      mid: 0.055 + drift * 0.035 + body * 0.78 + section * 0.62,
      highMid: 0.040 + slow * 0.025 + body * 0.38 + high * 0.38 + section * 0.26,
      presence: 0.030 + drift * 0.022 + high * 0.62,
      brilliance: 0.022 + slow * 0.018 + high * 0.48,
      air: 0.016 + drift * 0.014 + high * 0.30,
      kickEnvelope: kick,
      energy: 0.055 + low * 0.34 + body * 0.26 + high * 0.12 + section * 0.62,
      sharpness: high,
    };
  }

  _analyzedTarget(frame) {
    const section = clamp01(frame.sectionEnergy);
    return {
      source: 'analyzed',
      subBass: Math.max(clamp01(frame.subBass), this._beatLow * 0.82),
      bass: Math.max(clamp01(frame.bass), this._beatLow * 0.70),
      lowMid: Math.max(clamp01(frame.lowMid), this._beatBody * 0.56, section * 0.42),
      mid: Math.max(clamp01(frame.mid), this._beatBody * 0.70, section * 0.62),
      highMid: Math.max(clamp01(frame.highMid), this._beatHigh * 0.36, section * 0.34),
      presence: Math.max(clamp01(frame.presence), this._beatHigh * 0.58),
      brilliance: Math.max(clamp01(frame.brilliance), this._beatHigh * 0.44),
      air: Math.max(clamp01(frame.air), this._beatHigh * 0.28),
      kickEnvelope: Math.max(clamp01(frame.kickEnvelope), this._beatKick),
      energy: Math.max(clamp01(frame.energy), section * 0.78),
      sharpness: Math.max(clamp01(frame.sharpness), this._beatHigh),
    };
  }

  _analysisFallbackTarget() {
    // A deterministic 78 BPM pulse. Its energy is deliberately restricted to
    // the low bands and kept below all section/climax thresholds.
    const beatPhase = (this._phase * 1.3) % 1;
    const pulse = Math.exp(-beatPhase * 7.8);
    const breath = 0.5 + 0.5 * Math.sin(this._phase * 0.72);

    return {
      source: 'synthetic',
      subBass: 0.026 + breath * 0.010 + pulse * 0.040,
      bass: 0.024 + breath * 0.008 + pulse * 0.032,
      lowMid: 0.012 + pulse * 0.009,
      mid: 0.004,
      highMid: 0.003,
      presence: 0.002,
      brilliance: 0.001,
      air: 0.001,
      kickEnvelope: pulse * 0.055,
      energy: 0.035 + breath * 0.012 + pulse * 0.035,
      sharpness: 0,
    };
  }

  reset() {
    this._beatLow = 0;
    this._beatBody = 0;
    this._beatHigh = 0;
    this._beatKick = 0;
    this._sectionEnergy = 0;
    this._sectionTarget = 0;
    this._analysisPending = false;
    this._analyzedFrame = null;
  }

  getFrame() {
    return Object.freeze({ ...this._frame });
  }
}

export { BAND_KEYS, EMPTY_FRAME };
