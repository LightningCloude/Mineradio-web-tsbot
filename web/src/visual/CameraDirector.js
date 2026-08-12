import { eventBus } from '../shared/EventBus.js';

/**
 * Mineradio cinematic camera — render-loop lerp orbit system.
 *
 * All 6 dj-analyzer beat types:
 *   downbeat → strong push-in + FOV expand
 *   pulse    → restrained depth punch
 *   drop     → rapid zoom-out + FOV contract (energy release)
 *   rebound  → bounce back + slight undershoot
 *   accent   → quick depth punch + fast return
 */

const BASE_FOV = 45;
const BEAT_TARGET_DECAY = 5.2;
const BEAT_ATTACK_RATE = 11.0;
const BEAT_RELEASE_RATE = 6.5;
const BEAT_LIMITS = Object.freeze({
  thetaKick: 0.10,
  phiKick: 0.12,
  radiusKick: 1.15,
  punch: 0.90,
  fovOffset: 2.80,
});

function emptyBeatMotion() {
  return {
    thetaKick: 0,
    phiKick: 0,
    radiusKick: 0,
    punch: 0,
    fovOffset: 0,
  };
}

function expFollow(current, target, rate, dt) {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}

function clampSigned(value, limit) {
  return Math.max(-limit, Math.min(limit, value));
}

export class CameraDirector {
  constructor(camera) {
    this.camera = camera;

    this.orbit = {
      userTheta: 0, userPhi: 0.08, userRadius: 36,
      cineTheta: 0, cinePhi: 0, cineRadius: 0,
      theta: 0, phi: 0.08, radius: 36,
      baselineTheta: 0, baselinePhi: 0.08, baselineRadius: 36,
      lookAt: { x: 0, y: 0, z: 0 },
    };

    this.beatCam = emptyBeatMotion();
    this._beatTarget = emptyBeatMotion();
    this._beatSerial = 0;

    this._currentFov = BASE_FOV;
    this._returningToBaseline = false;

    eventBus.on('visual:beat', (beat) => this._onBeat(beat));
    eventBus.on('playback:finished', () => this._resetToBaseline());
  }

  tick(dt) {
    if (!dt || dt <= 0) return;

    const lerpSpeed = 1 - Math.exp(-4.5 * dt);
    this.orbit.cineTheta  += (0 - this.orbit.cineTheta)  * lerpSpeed;
    this.orbit.cinePhi    += (0 - this.orbit.cinePhi)    * lerpSpeed;
    this.orbit.cineRadius += (0 - this.orbit.cineRadius) * lerpSpeed;

    for (const key of Object.keys(BEAT_LIMITS)) {
      const target = this._beatTarget[key];
      const current = this.beatCam[key];
      const isAttacking = Math.abs(target) > Math.abs(current);
      this.beatCam[key] = expFollow(
        current,
        target,
        isAttacking ? BEAT_ATTACK_RATE : BEAT_RELEASE_RATE,
        dt,
      );
      this._beatTarget[key] *= Math.exp(-BEAT_TARGET_DECAY * dt);
      if (Math.abs(this._beatTarget[key]) < 0.0001) this._beatTarget[key] = 0;
      if (Math.abs(this.beatCam[key]) < 0.0001) this.beatCam[key] = 0;
    }

    if (this._returningToBaseline) {
      this.orbit.userTheta  += (this.orbit.baselineTheta  - this.orbit.userTheta)  * lerpSpeed * 0.5;
      this.orbit.userPhi    += (this.orbit.baselinePhi    - this.orbit.userPhi)    * lerpSpeed * 0.5;
      this.orbit.userRadius += (this.orbit.baselineRadius - this.orbit.userRadius) * lerpSpeed * 0.5;
    }

    this.orbit.theta = this.orbit.userTheta + this.orbit.cineTheta + this.beatCam.thetaKick;
    this.orbit.phi   = this.orbit.userPhi   + this.orbit.cinePhi   + this.beatCam.phiKick;
    this.orbit.radius = this.orbit.userRadius + this.orbit.cineRadius + this.beatCam.radiusKick;

    this.orbit.phi = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, this.orbit.phi));
    this.orbit.radius = Math.max(10, Math.min(60, this.orbit.radius));

    const r = this.orbit.radius;
    const phi = this.orbit.phi;
    const theta = this.orbit.theta;
    const lx = this.orbit.lookAt.x;
    const ly = this.orbit.lookAt.y;
    const lz = this.orbit.lookAt.z;

    this.camera.position.x = lx + r * Math.cos(phi) * Math.sin(theta);
    this.camera.position.y = ly + r * Math.sin(phi);
    this.camera.position.z = lz + r * Math.cos(phi) * Math.cos(theta);
    this.camera.lookAt(lx, ly, lz);

    const targetFov = BASE_FOV + this.beatCam.fovOffset + this.beatCam.punch * 2.5;
    this._currentFov += (targetFov - this._currentFov) * lerpSpeed;
    this.camera.fov = this._currentFov;
    this.camera.updateProjectionMatrix();
  }

  _onBeat(beat) {
    // ── Use real-time beat data when available; fall back to grid intensity ──
    const I = beat.strength || beat.intensity || 0.5;
    const mass     = beat.mass != null ? beat.mass : I * 0.7;

    switch (beat.type) {
      case 'downbeat':
        // Rounded push-in: the rendered camera follows this target over time.
        this._queueBeatMotion({
          radiusKick: -0.75 * I,
          punch: 0.55 * I,
          fovOffset: 1.40 * I,
        });
        break;

      case 'pulse':
      case 'push':
        this._queueBeatMotion({
          punch: I * 0.15,
        });
        break;

      case 'drop':
        this._queueBeatMotion({
          radiusKick: 0.90 * I,
          fovOffset: -2.20 * I,
          punch: I * 0.30,
        });
        break;

      case 'rebound':
        this._queueBeatMotion({
          radiusKick: 0.35 * I,
          punch: I * 0.20,
        });
        break;

      case 'accent':
        this._queueBeatMotion({
          punch: Math.max(I * 0.38, mass * 0.42),
          fovOffset: I * 0.70,
        });
        break;

      default: break;
    }
  }

  _queueBeatMotion(values) {
    for (const [key, value] of Object.entries(values)) {
      if (!(key in BEAT_LIMITS) || !Number.isFinite(value)) continue;
      const carriedMotion = this._beatTarget[key] * 0.35;
      this._beatTarget[key] = clampSigned(carriedMotion + value, BEAT_LIMITS[key]);
    }
  }

  _resetToBaseline() {
    this._returningToBaseline = true;
    this.beatCam = emptyBeatMotion();
    this._beatTarget = emptyBeatMotion();
  }

  lock() { this._returningToBaseline = false; }
  setLookAt(x, y, z) { this.orbit.lookAt = { x, y, z }; }
}
