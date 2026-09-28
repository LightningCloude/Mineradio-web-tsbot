const BAND_KEYS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'brilliance', 'air'];
const FREQUENCIES = [14, 10, 8];
const DAMPING = [0.58, 0.64, 0.70];
const BEAT_FREQUENCY = 12.5;
const BEAT_DAMPING = 0.38;

function unit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Three continuous time scales plus a per-beat whole-surface oscillator.
 * All state is fixed-size and allocation-free in the render loop.
 */
export class TerrainElasticMotion {
  constructor() {
    this.values = new Float32Array(4);
    this._positions = new Float64Array(3);
    this._velocities = new Float64Array(3);
    this._targets = new Float64Array(3);
    this._beatPosition = 0;
    this._beatVelocity = 0;
  }

  reset() {
    this.values.fill(0);
    this._positions.fill(0);
    this._velocities.fill(0);
    this._targets.fill(0);
    this._beatPosition = 0;
    this._beatVelocity = 0;
  }

  /** Inject one independent impulse for every analyzed/realtime beat event. */
  trigger(strength, tide = 0, reducedMotion = false) {
    const power = (0.34 + unit(strength) * 0.66) * (0.92 + unit(tide) * 0.18);
    const motionScale = reducedMotion ? 0.34 : 1;
    // A tiny instantaneous squeeze makes the following upward release legible
    // even at 30 FPS. Velocity stacking is bounded for rapid double kicks.
    this._beatPosition = Math.max(-0.34,
      this._beatPosition - power * 0.105 * motionScale);
    this._beatVelocity = Math.min(16.5,
      this._beatVelocity + power * 12.4 * motionScale);
  }

  update(frame, dt, reducedMotion = false) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.1, dt)) : 0;
    let signal = unit(frame?.energy);
    for (const key of BAND_KEYS) signal = Math.max(signal, unit(frame?.[key]));
    const kick = unit(frame?.kickEnvelope);
    signal = Math.max(signal, kick);
    const audible = frame?.active && frame?.source !== 'idle' && signal > 0;
    const energy = unit(frame?.energy);
    const low = Math.max(unit(frame?.subBass), unit(frame?.bass));
    const mid = Math.max(unit(frame?.lowMid), unit(frame?.mid), unit(frame?.highMid));
    // Analysis-startup fake audio must remain a quiet tide, never a chorus.
    const limit = frame?.source === 'synthetic' ? 0.18 : 1;
    this._targets[0] = audible ? Math.min(limit, kick * 0.82 + low * 0.12 + energy * 0.06) : 0;
    this._targets[1] = audible ? Math.min(limit, energy * 0.50 + low * 0.28 + kick * 0.22) : 0;
    this._targets[2] = audible ? Math.min(limit, mid * 0.60 + energy * 0.25 + kick * 0.15) : 0;

    for (let i = 0; i < 3; i++) {
      // Exact underdamped spring solution for a held target. Unlike Euler
      // integration this remains stable at low FPS and gives the same rebound
      // at 30/60/144 Hz. Small overshoot supplies the jelly-like softness.
      const omega = FREQUENCIES[i];
      const decay = DAMPING[i] * omega;
      const frequency = omega * Math.sqrt(1 - DAMPING[i] ** 2);
      const offset = this._positions[i] - this._targets[i];
      const velocity = this._velocities[i];
      const envelope = Math.exp(-decay * step);
      const cosine = Math.cos(frequency * step);
      const sine = Math.sin(frequency * step);
      const position = this._targets[i] + envelope
        * (offset * cosine + (velocity + decay * offset) / frequency * sine);
      const nextVelocity = envelope * (velocity * cosine
        - (decay * velocity + omega * omega * offset) / frequency * sine);
      this._positions[i] = Math.max(-0.12, Math.min(1.12, position));
      this._velocities[i] = position === this._positions[i] ? nextVelocity : 0;
      this.values[i] = this._positions[i] * (reducedMotion ? 0.28 : 1);
    }
    // Exact homogeneous underdamped oscillator around zero. It creates one
    // compression -> rise -> recoil cycle per trigger and cannot be held high
    // by sustained chorus energy.
    const beatDecay = BEAT_DAMPING * BEAT_FREQUENCY;
    const beatFrequency = BEAT_FREQUENCY * Math.sqrt(1 - BEAT_DAMPING ** 2);
    const envelope = Math.exp(-beatDecay * step);
    const cosine = Math.cos(beatFrequency * step);
    const sine = Math.sin(beatFrequency * step);
    const position = envelope * (this._beatPosition * cosine
      + (this._beatVelocity + beatDecay * this._beatPosition) / beatFrequency * sine);
    const velocity = envelope * (this._beatVelocity * cosine
      - (beatDecay * this._beatVelocity + BEAT_FREQUENCY ** 2 * this._beatPosition)
        / beatFrequency * sine);
    this._beatPosition = Math.max(-0.42, Math.min(0.92, position));
    this._beatVelocity = this._beatPosition === position
      ? Math.max(-16.5, Math.min(16.5, velocity)) : 0;
    this.values[3] = this._beatPosition;
    return this.values;
  }
}
