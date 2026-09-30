const BAND_KEYS = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'brilliance', 'air'];
const FREQUENCIES = [14, 10, 8];
const DAMPING = [0.58, 0.64, 0.70];
const JELLY_FREQUENCIES = [25, 29, 23];
const JELLY_DAMPING = [0.30, 0.32, 0.29];
const JELLY_LIMITS = [0.65, 0.42, 0.60];
const JELLY_VELOCITY_LIMITS = [28, 22, 26];

function unit(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** Continuous terrain envelopes plus per-beat 3D surface displacement.
 * All state is fixed-size and allocation-free in the render loop.
 */
export class TerrainElasticMotion {
  constructor() {
    this.values = new Float32Array(3);
    this.offset = new Float32Array(3);
    this._positions = new Float64Array(3);
    this._velocities = new Float64Array(3);
    this._targets = new Float64Array(3);
    this._jellyPositions = new Float64Array(3);
    this._jellyVelocities = new Float64Array(3);
    this._beatSequence = 0;
  }

  reset() {
    this.values.fill(0);
    this._positions.fill(0);
    this._velocities.fill(0);
    this._targets.fill(0);
    this.offset.fill(0);
    this._jellyPositions.fill(0);
    this._jellyVelocities.fill(0);
    this._beatSequence = 0;
  }

  /** Inject one independent impulse for every analyzed/realtime beat event. */
  trigger(strength, tide = 0, reducedMotion = false) {
    const power = (0.34 + unit(strength) * 0.66) * (0.92 + unit(tide) * 0.18);
    const motionScale = reducedMotion ? 0.34 : 1;
    const angle = ++this._beatSequence * 2.399963229728653;
    // Change velocity, never position: the surface leaves its resting point
    // smoothly on the next frame. Deterministic directions and different axis
    // frequencies make a small 3D wobble rather than a repeated vertical hop.
    const impulse = power * motionScale;
    this._jellyVelocities[0] += Math.cos(angle) * impulse * 18;
    this._jellyVelocities[1] += impulse * 11.5;
    this._jellyVelocities[2] += Math.sin(angle) * impulse * 16;
    for (let i = 0; i < 3; i++) {
      const limit = JELLY_VELOCITY_LIMITS[i];
      this._jellyVelocities[i] = Math.max(-limit, Math.min(limit, this._jellyVelocities[i]));
    }
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
    // Three short, underdamped springs around the fixed scene origin. All
    // columns share these offsets, including at the terrain height ceiling.
    for (let i = 0; i < 3; i++) {
      const omega = JELLY_FREQUENCIES[i];
      const decay = JELLY_DAMPING[i] * omega;
      const frequency = omega * Math.sqrt(1 - JELLY_DAMPING[i] ** 2);
      const envelope = Math.exp(-decay * step);
      const cosine = Math.cos(frequency * step);
      const sine = Math.sin(frequency * step);
      const previous = this._jellyPositions[i];
      const velocity = this._jellyVelocities[i];
      const position = envelope * (previous * cosine
        + (velocity + decay * previous) / frequency * sine);
      const nextVelocity = envelope * (velocity * cosine
        - (decay * velocity + omega * omega * previous) / frequency * sine);
      const limit = JELLY_LIMITS[i];
      this._jellyPositions[i] = Math.max(-limit, Math.min(limit, position));
      this._jellyVelocities[i] = position === this._jellyPositions[i] ? nextVelocity : 0;
      this.offset[i] = this._jellyPositions[i];
    }
    return this.values;
  }
}
