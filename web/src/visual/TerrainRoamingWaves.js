// Two smoothly advected noise scales form dense, irregular connected islands.
// Coordinate warping hides lattice alignment; absolute time prevents flicker.
export const TERRAIN_ROAMING_WAVE_GLSL = /* glsl */`
float roamingHash(vec2 cell) {
  vec2 p = mod(cell, vec2(251.0, 241.0));
  float h = mod(p.x * 73.0 + p.y * 151.0 + p.x * p.y * 17.0, 4093.0);
  h = mod(h * 73.0 + 19.0, 4093.0);
  // Bounded integer arithmetic stays exact in highp floats, including the CPU
  // reference. No sine hash, per-pillar random toggles or new texture resources.
  return mod(h * h, 4093.0) / 4092.0;
}

float roamingNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(roamingHash(cell), roamingHash(cell + vec2(1.0, 0.0)), f.x),
    mix(roamingHash(cell + vec2(0.0, 1.0)), roamingHash(cell + vec2(1.0)), f.x), f.y);
}

float roamingWaveMask(vec2 cell, float time) {
  vec2 drift = vec2(time * 0.82, -time * 0.62);
  vec2 warp = vec2(
    sin(cell.y * 0.093 + time * 0.17) * 2.8,
    sin(cell.x * 0.081 - time * 0.13) * 2.8);
  vec2 p = cell + warp;
  float body = roamingNoise((p + drift) * 0.30);
  // A differently oriented detail field breaks equal-sized rounded humps.
  vec2 detailCell = vec2(p.x * 0.8 - p.y * 0.6, p.x * 0.6 + p.y * 0.8);
  float detail = roamingNoise((detailCell - drift * 0.61) * 0.53 + vec2(37.0, -19.0));
  return body * 0.70 + detail * 0.30;
}

float roamingRegionMask(float wave) {
  // Connected bodies occupy more floor, separated by irregular channels.
  // Soft edges retain wave-like emergence instead of a static cellular pattern.
  return smoothstep(0.32, 0.66, wave);
}
`;

function smoothstep(low, high, value) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

const mod = (value, divisor) => value - Math.floor(value / divisor) * divisor;
function hash(x, z) {
  x = mod(x, 251);
  z = mod(z, 241);
  let h = mod(x * 73 + z * 151 + x * z * 17, 4093);
  h = mod(h * 73 + 19, 4093);
  return mod(h * h, 4093) / 4092;
}

function noise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = smoothstep(0, 1, x - ix), fz = smoothstep(0, 1, z - iz);
  const a = hash(ix, iz), b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}

/** CPU reference for regression checks against the actual GPU wave field. */
export function sampleRoamingWave(x, z, time) {
  if (![x, z, time].every(Number.isFinite)) return 0;
  const px = x + Math.sin(z * 0.093 + time * 0.17) * 2.8;
  const pz = z + Math.sin(x * 0.081 - time * 0.13) * 2.8;
  const dx = time * 0.82, dz = -time * 0.62;
  const body = noise((px + dx) * 0.30, (pz + dz) * 0.30);
  const detail = noise((px * 0.8 - pz * 0.6 - dx * 0.61) * 0.53 + 37,
    (px * 0.6 + pz * 0.8 - dz * 0.61) * 0.53 - 19);
  return body * 0.70 + detail * 0.30;
}

export function sampleRoamingRegion(x, z, time) {
  return smoothstep(0.32, 0.66, sampleRoamingWave(x, z, time));
}
