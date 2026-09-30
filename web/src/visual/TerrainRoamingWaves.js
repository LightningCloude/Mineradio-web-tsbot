// Intersecting travelling crests form soft islands across the whole floor.
// Absolute time keeps their motion deterministic and independent of frame rate.
export const TERRAIN_ROAMING_WAVE_GLSL = /* glsl */`
float roamingWaveMask(vec2 cell, float time) {
  float crestA = smoothstep(0.15, 0.92,
    sin(cell.x * 0.085 + cell.y * 0.035 - time * 0.82) * 0.5 + 0.5);
  float crestB = smoothstep(0.10, 0.88,
    sin(cell.y * 0.078 - cell.x * 0.026 + time * 0.61) * 0.5 + 0.5);
  float fade = sin(cell.x * 0.032 - cell.y * 0.060 + time * 0.39) * 0.5 + 0.5;
  return crestA * crestB * (0.25 + fade * 0.75);
}
`;

function smoothstep(low, high, value) {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** CPU reference for regression checks against the actual GPU wave field. */
export function sampleRoamingWave(x, z, time) {
  if (![x, z, time].every(Number.isFinite)) return 0;
  const crestA = smoothstep(0.15, 0.92,
    Math.sin(x * 0.085 + z * 0.035 - time * 0.82) * 0.5 + 0.5);
  const crestB = smoothstep(0.10, 0.88,
    Math.sin(z * 0.078 - x * 0.026 + time * 0.61) * 0.5 + 0.5);
  const fade = Math.sin(x * 0.032 - z * 0.060 + time * 0.39) * 0.5 + 0.5;
  return crestA * crestB * (0.25 + fade * 0.75);
}
