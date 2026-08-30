import * as THREE from 'three';

const RIPPLE_MAX = 10;
const FLOATING_BLOCK_MAX = 32;
const METEOR_MAX = 6;
const TERRAIN_LIGHT_CEILING = 0.80;
// The camera must always sit inside the terrain footprint. 168 world units
// keeps every supported aspect ratio away from a visible outer edge while the
// adaptive grid preserves the existing instance-count budget.
const TERRAIN_SIZE = 168;

const TERRAIN_VS = /* glsl */`
precision highp float;
attribute vec2 aCell;
attribute float aSeed;
uniform float uTime;
uniform float uAmplitude;
uniform float uClimax;
uniform float uBeatPulse;
uniform float uBeatLight;
uniform float uBands[8];
uniform vec4 uRipples[10];
varying float vEnergy;
varying float vRadius;
varying float vSide;
varying float vSeed;
varying float vPeakIntensity;

// Visual terrain functions adapted from Sonic Topography 1.1.x.  Keeping the
// noise in the vertex shader gives every fixed instance a continuous organic
// motion without per-frame CPU allocation or random flicker.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
    -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = x0.x > x0.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
    dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float easeLift(float raw, float maxHeight) {
  float x = clamp(raw, 0.0, 1.0);
  float eased = 1.0 - pow(1.0 - x, 2.5);
  float overshoot = sin(x * 9.4245) * exp(-x * 4.0) * 0.15;
  return max(0.0, eased + overshoot) * maxHeight;
}

float flowLift(float raw, float maxHeight) {
  float x = clamp(raw, 0.0, 1.0);
  return (pow(x, 0.75) + sin(x * 3.14159) * 0.12) * maxHeight;
}

void main() {
  float distanceFromCenter = length(aCell);
  float radius = clamp(distanceFromCenter / 84.0, 0.0, 1.0);
  float coverage = 1.0 - smoothstep(68.0, 84.0, distanceFromCenter);
  float direction = atan(aCell.y, aCell.x);
  vec2 noiseDrift = vec2(uTime * 0.10, uTime * 0.05);
  float terrainNoise = snoise(aCell * 0.052 + noiseDrift);
  float detailNoise = snoise(aCell * 0.145 - noiseDrift * 1.45);
  float broadWave = sin(aCell.x * 0.105 + uTime * 0.48)
    * cos(aCell.y * 0.082 - uTime * 0.34);
  float crossingWave = sin((aCell.x + aCell.y) * 0.13 - uTime * 0.58);
  float directionalWave = sin(direction * 4.0 + uTime * 0.42 + distanceFromCenter * 0.10);
  float mediumWave = sin(aCell.x * 0.19 - aCell.y * 0.15 + uTime * 0.51)
    * cos(aCell.x * 0.08 + aCell.y * 0.21 - uTime * 0.29);
  float fineWave = sin(aCell.x * 0.43 + aCell.y * 0.31 + uTime * 0.67)
    * cos(aCell.x * 0.27 - aCell.y * 0.47 - uTime * 0.38);
  float fineClusters = smoothstep(0.34, 0.88, fineWave * 0.5 + 0.5)
    * smoothstep(0.28, 0.92, aSeed);
  float microSpikes = smoothstep(0.76, 0.985,
    sin(aCell.x * 0.79 - aCell.y * 0.63 + aSeed * 12.0 + uTime * 0.76) * 0.5 + 0.5)
    * smoothstep(0.64, 0.96, aSeed);

  // Frequency becomes spatial scale: lows gather into one broad central
  // landmass, mids form several rolling regions, and highs excite only small
  // deterministic patches across the full floor. No per-frame randomness is
  // used, so these regions breathe instead of flickering.
  vec2 moundOffset = vec2(
    broadWave * 3.2 + terrainNoise * 4.6,
    crossingWave * 2.8 + detailNoise * 3.2
  );
  float moundDistance = length(aCell + moundOffset);
  float organicRadius = moundDistance + terrainNoise * 6.4 + detailNoise * 2.2;
  float centerMound = 1.0 - smoothstep(7.0, 38.0, organicRadius);
  float bassMound = 1.0 - smoothstep(13.0, 54.0,
    organicRadius + mediumWave * 4.0);
  float rollingHills = smoothstep(0.16, 0.88, broadWave * 0.5 + 0.5);
  float midPatches = smoothstep(0.30, 0.90, mediumWave * 0.5 + 0.5);
  float directionalPatches = smoothstep(0.18, 0.92, directionalWave * 0.5 + 0.5);

  float subField = easeLift(uBands[0], 7.2) * centerMound;
  float bassField = easeLift(uBands[1], 6.0) * bassMound
    * (0.72 + rollingHills * 0.48);
  float lowMidField = flowLift(uBands[2], 3.6)
    * (terrainNoise * 0.5 + 0.5);
  float midField = flowLift(uBands[3], 4.0) * midPatches;
  float highMidField = easeLift(uBands[4], 3.0)
    * directionalPatches * fineClusters;
  float presenceField = uBands[5] * fineClusters * 1.95;
  float brillianceField = uBands[6] * microSpikes * (1.75 + radius * 0.55);
  float airField = uBands[7] * microSpikes * (1.25 + aSeed * 1.05);
  float lowBody = max(subField, bassField);
  float midBody = max(lowMidField, midField);
  float highBody = max(highMidField, presenceField);
  // A strong mid-range envelope must read as a broad terrain event, not only
  // as isolated patches. This is intentionally wider and lower than the bass
  // mound, allowing a chorus to grow toward the centre without replacing the
  // low-frequency peak.
  float midCoreDrive = max(max(uBands[2] * 0.88, uBands[3]), uBands[4] * 0.72);
  float midCoreEnvelope = smoothstep(0.027, 0.24, midCoreDrive);
  float midCoreMound = midCoreEnvelope
    * (1.0 - smoothstep(10.0, 46.0, organicRadius)) * 3.20;
  // Section energy is percentile-normalized upstream. Expand its useful lower
  // half so a chorus starts building early, then reserve the large height for
  // a broad central peak. Deterministic satellite peaks make the surrounding
  // floor boil without introducing frame-to-frame random jitter.
  float spectralPeak = max(max(uBands[0], uBands[1] * 0.92),
    max(uBands[2] * 0.62, uBands[3] * 0.48));
  float sectionDrive = smoothstep(0.045, 0.28, uClimax);
  float climaxDrive = sectionDrive * smoothstep(0.06, 0.58, spectralPeak);
  float coreA = 1.0 - smoothstep(4.0, 38.0, organicRadius);
  float coreB = (1.0 - smoothstep(5.0, 27.0,
    length(aCell - vec2(13.0 + terrainNoise * 3.0, -7.0)))) * 0.74;
  float coreC = (1.0 - smoothstep(4.0, 24.0,
    length(aCell - vec2(-12.0, 10.0 + detailNoise * 3.0)))) * 0.62;
  float climaxCore = max(coreA, max(coreB, coreC));
  climaxCore *= 0.78 + (terrainNoise * 0.5 + 0.5) * 0.34;
  // The centre is the primary climax gesture. Its lift is held at 1.5 times
  // the original range so the chorus reads as one dominant landmass
  // before the secondary rings and satellite peaks.
  float climaxMound = easeLift(climaxDrive, 18.75) * climaxCore;
  float satelliteMask = smoothstep(13.0, 24.0, moundDistance)
    * (1.0 - smoothstep(54.0, 74.0, moundDistance));
  float satellitePattern = smoothstep(0.42, 0.82,
    fineWave * 0.42 + directionalWave * 0.18 + aSeed * 0.40 + 0.48);
  float climaxSatellites = easeLift(climaxDrive, 3.4) * satelliteMask
    * (0.12 + satellitePattern * 0.72 + microSpikes * 0.42);
  float spectralLift = (lowBody + midBody * 0.78 + midCoreMound * 0.82
    + climaxMound + climaxSatellites
    + highBody * 0.62 + max(brillianceField, airField) * 0.52) * coverage;
  float spectralEnergy = clamp(
    uBands[0] * centerMound * 0.78
    + uBands[1] * bassMound * 0.62
    + uBands[2] * rollingHills * 0.42
    + uBands[3] * midPatches * 0.38
    + uBands[4] * directionalPatches * fineClusters * 0.34
    + uBands[5] * fineClusters * 0.40
    + uBands[6] * microSpikes * 0.52
    + uBands[7] * microSpikes * 0.60
    + midCoreEnvelope * centerMound * 0.48
    + climaxDrive * climaxCore * 0.92
    + climaxDrive * satellitePattern * satelliteMask * 0.34,
    0.0, 1.2) * coverage;
  float idle = 0.42 + broadWave * 0.17 + crossingWave * 0.06;
  // The floor never becomes perfectly flat. Several slow deterministic
  // hummocks remain visible at the quietest point, while staying far below a
  // real low-frequency or section-driven rise.
  float lowTideNoise = snoise(aCell * 0.074
    + vec2(-uTime * 0.032, uTime * 0.024)) * 0.5 + 0.5;
  float lowTidePatch = smoothstep(0.42, 0.79, lowTideNoise)
    * (0.46 + centerMound * 0.54) * coverage;
  float lowTideBreath = 0.58 + 0.42
    * sin(uTime * 0.70 + terrainNoise * 1.8 + aSeed * 2.2);
  float lowTideLift = lowTidePatch * (0.14 + lowTideBreath * 0.20);

  // Section energy describes the tide; this separate fast envelope makes
  // every analyzed beat readable within that section. Deterministic patches
  // let groups of columns tap upward without moving the whole landscape as a
  // rigid plate.
  float beatPatch = smoothstep(0.30, 0.80,
    aSeed * 0.56 + (broadWave * 0.5 + 0.5) * 0.24
    + (detailNoise * 0.5 + 0.5) * 0.20);
  float beatLift = uBeatPulse
    * (0.30 + beatPatch * 0.92 + centerMound * 0.26) * coverage;
  // Frequency and section fields define the available terrain ceiling. The
  // fast beat envelope decides how much of that ceiling is used right now, so
  // a chorus permits tall motion without holding the landscape permanently up.
  float tideHeightFloor = mix(0.12, 0.80, sectionDrive);
  float beatHeightGate = tideHeightFloor
    + uBeatPulse * (1.0 - tideHeightFloor);

  float rippleLift = 0.0;
  for (int i = 0; i < 10; i++) {
    vec4 ripple = uRipples[i];
    if (abs(ripple.w) <= 0.001 || ripple.z < 0.0 || ripple.z > 4.8) continue;
    float accent = ripple.w < 0.0 ? 1.0 : 0.0;
    float dist = distance(aCell, ripple.xy);
    // Each beat behaves like a drop hitting a flexible surface: a brief impact
    // at the origin gives way to a rounded crest, a shallow trailing trough
    // and a much weaker secondary crest. This reads as displaced water rather
    // than a solid luminous hoop moving across the terrain.
    float ringDrive = clamp((abs(ripple.w) - 0.38) / 1.52, 0.0, 1.0);
    float ringSpeed = mix(10.8, 14.2, ringDrive) * mix(1.0, 1.16, accent);
    float ringRadius = max(0.0, ripple.z) * ringSpeed;
    float ringWidth = mix(1.10, 1.82, ringDrive)
      + max(0.0, ripple.z) * mix(0.025, 0.075, ringDrive);
    ringWidth *= mix(1.0, 0.66, accent);
    float ringOffset = dist - ringRadius;
    float mainCrest = exp(-pow(ringOffset / ringWidth, 2.0));
    float trailingTrough = exp(-pow(
      (ringOffset + ringWidth * 1.72) / (ringWidth * 1.28), 2.0));
    float secondaryCrest = exp(-pow(
      (ringOffset + ringWidth * 3.55) / (ringWidth * 1.62), 2.0));
    float waterWave = mainCrest - trailingTrough * 0.30
      + secondaryCrest * 0.16;
    float impactAge = max(0.0, ripple.z);
    float impactRadius = mix(1.35, 2.15, ringDrive);
    float impact = exp(-pow(dist / impactRadius, 2.0))
      * exp(-pow(impactAge / 0.19, 2.0));
    float ringLife = mix(2.70, 4.35, ringDrive);
    float attack = smoothstep(0.0, 0.075, impactAge);
    float lifeFade = 1.0 - smoothstep(ringLife * 0.54, ringLife, impactAge);
    // Mineradio's distance fade is the important source characteristic: the
    // crest loses energy continuously as it travels, instead of disappearing
    // at an outer threshold.
    float travelFade = exp(-ringRadius / mix(27.0, 39.0, ringDrive));
    float ring = waterWave * attack + impact * 0.72;
    float elevation = mix(1.72 + ringDrive * 1.22, 0.92 + ringDrive * 0.42, accent);
    float corePriority = mix(1.0, 0.10, climaxDrive * climaxCore);
    rippleLift += ring * lifeFade * travelFade * abs(ripple.w) * elevation
      * mix(1.0, 0.22, climaxDrive) * corePriority;
  }

  float height = 0.22 + (idle + terrainNoise * 0.18) * 0.18
    + lowTideLift
    + beatLift * uAmplitude
    + spectralLift * beatHeightGate * uAmplitude * 0.62
    + rippleLift * uAmplitude * 0.72;
  height = clamp(height, 0.12, mix(6.2, 22.5, climaxDrive));

  vec3 transformed = position;
  transformed.y = transformed.y * height + height * 0.5 - 2.65;
  transformed += vec3(aCell.x, 0.0, aCell.y);

  float tideEnergyFloor = mix(0.24, 0.90, sectionDrive);
  float beatEnergyGate = tideEnergyFloor
    + uBeatLight * (1.0 - tideEnergyFloor);
  vEnergy = clamp(spectralEnergy * beatEnergyGate + rippleLift * 0.24
    + uBeatLight * (0.10 + beatPatch * 0.26)
    + microSpikes * (uBands[6] + uBands[7]) * 0.16, 0.0, 1.45);
  vPeakIntensity = clamp(
    climaxDrive * climaxCore * 1.08 + centerMound * uBands[0] * 0.62,
    0.0, 1.0);
  vRadius = radius;
  vSide = 1.0 - smoothstep(-0.45, 0.50, position.y);
  vSeed = aSeed;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

const TERRAIN_FS = /* glsl */`
precision highp float;
uniform vec3 uBaseColor;
uniform vec3 uCoolColor;
uniform vec3 uWarmColor;
uniform vec3 uAccentColor;
uniform vec3 uPeakColor;
uniform float uBrightness;
uniform float uOpacity;
uniform float uLightCeiling;
varying float vEnergy;
varying float vRadius;
varying float vSide;
varying float vSeed;
varying float vPeakIntensity;

void main() {
  float energy = clamp(vEnergy, 0.0, 1.0);
  vec3 lowColor = mix(uBaseColor, uCoolColor, 0.28 + vRadius * 0.40);
  vec3 highColor = mix(uWarmColor, uAccentColor, smoothstep(0.52, 1.0, energy));
  vec3 color = mix(lowColor, highColor, smoothstep(0.12, 0.92, energy));
  float peakBlend = pow(clamp(vPeakIntensity, 0.0, 1.0), 0.85);
  color = mix(color, uPeakColor, peakBlend * mix(0.34, 0.62, 1.0 - vSide));
  // Source-style vertical peak glow keeps aligned side faces luminous instead
  // of allowing a dark perspective seam through the centre of the mountain.
  float sideLight = mix(0.66, 0.92, peakBlend);
  float topLight = mix(1.08, sideLight, vSide);
  float edgeSpark = smoothstep(0.74, 1.0, energy) * (0.84 + vSeed * 0.16);
  color *= (0.40 + energy * 0.60 + edgeSpark * 0.14 + peakBlend * 0.18)
    * topLight * uBrightness;
  // Soft highlight compression preserves the source's hot peak without
  // turning a broad chorus mound into a flat white patch on SDR displays.
  color = color / (vec3(1.0) + color * 0.28);
  // The beat-light floor remains 90% of this ceiling. Applying the ceiling at
  // final output also limits the white peak colour and edge sparks, not only
  // the spectral energy term that selected them.
  color *= uLightCeiling;
  float boundaryFog = smoothstep(0.66, 0.94, vRadius);
  color = mix(color, uCoolColor, boundaryFog * 0.62);
  float alpha = uOpacity * (1.0 - smoothstep(0.74, 0.985, vRadius));
  if (alpha < 0.015) discard;
  gl_FragColor = vec4(color, alpha);
}
`;

const MIST_VS = /* glsl */`
precision highp float;
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const MIST_FS = /* glsl */`
precision highp float;
uniform float uTime;
uniform float uEnergy;
uniform float uOpacity;
uniform vec3 uCoolColor;
uniform vec3 uAccentColor;
varying vec2 vUv;

void main() {
  vec2 centered = vUv * 2.0 - 1.0;
  float radius = length(centered);
  float broadMist = smoothstep(0.43, 0.67, radius)
    * (1.0 - smoothstep(0.91, 1.08, radius));
  float edgeMist = smoothstep(0.68, 0.82, radius)
    * (1.0 - smoothstep(0.94, 1.10, radius));
  float drift = sin(centered.x * 13.0 + uTime * 0.16)
    * cos(centered.y * 11.0 - uTime * 0.11);
  float grain = 0.78 + drift * 0.12;
  float response = clamp(uEnergy, 0.0, 1.0);
  vec3 fogColor = mix(uCoolColor, uAccentColor, 0.12 + response * 0.46);
  fogColor *= 0.42 + response * 0.58;
  float alpha = (broadMist * 0.16 + edgeMist * 0.28)
    * grain * (0.72 + response * 0.70) * uOpacity;
  if (alpha < 0.004) discard;
  gl_FragColor = vec4(fogColor, alpha);
}
`;

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

/**
 * Select a cover theme while rejecting white and near-white neutral pixels.
 * Returns normalized RGB or null when the cover has no usable colour.
 */
export function selectThemeColor(pixels) {
  let red = 0, green = 0, blue = 0, weight = 0;
  if (!pixels || typeof pixels.length !== 'number') return null;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 96) continue;
    const r = pixels[i] / 255;
    const g = pixels[i + 1] / 255;
    const b = pixels[i + 2] / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const saturation = maximum > 0.001 ? (maximum - minimum) / maximum : 0;
    const nearWhite = minimum >= 0.90
      || (maximum >= 0.84 && saturation < 0.10);
    if (nearWhite) continue;

    // Prefer meaningful chroma without allowing very dark pixels to dominate.
    const currentWeight = (0.22 + maximum * 0.48)
      * (0.35 + saturation * 1.15);
    red += r * currentWeight;
    green += g * currentWeight;
    blue += b * currentWeight;
    weight += currentWeight;
  }

  if (weight <= 0.001) return null;
  return Object.freeze({ red: red / weight, green: green / weight, blue: blue / weight });
}

const SYNTHETIC_BAND_FLOORS = [0.015, 0.012, 0.008, 0.004, 0.006, 0.006, 0.005, 0.004];
const SYNTHETIC_BAND_CEILINGS = [0.52, 0.46, 0.24, 0.14, 0.20, 0.22, 0.22, 0.21];
// Weak low-frequency values need more visual headroom than mids and highs.
// A sub-linear curve lifts quiet bass detail while keeping a full-scale peak
// at exactly 1, so this does not raise the established climax ceiling.
const LOW_BAND_VISUAL_GAMMA = [0.58, 0.64, 0.76];

/**
 * Server playback usually has no browser FFT stream, so its deterministic
 * synthetic bands occupy a deliberately smaller numeric range. Expand only
 * that source here; realtime FFT values are already peak-normalized upstream.
 */
export function shapeSonicBand(index, value, source = 'realtime') {
  const normalized = clamp01(value);
  const safeIndex = Math.max(0, Math.min(7, Number(index) | 0));
  let shaped = normalized;
  if (source === 'synthetic') {
    const floor = SYNTHETIC_BAND_FLOORS[safeIndex];
    const ceiling = SYNTHETIC_BAND_CEILINGS[safeIndex];
    const t = clamp01((normalized - floor) / Math.max(0.001, ceiling - floor));
    shaped = t * t * (3 - 2 * t);
  }
  return safeIndex < LOW_BAND_VISUAL_GAMMA.length
    ? Math.pow(shaped, LOW_BAND_VISUAL_GAMMA[safeIndex])
    : shaped;
}

// Any measured non-zero signal is low tide. This deliberately has no
// perceptual threshold: only a truly silent frame may settle back to idle.
const AUDIBLE_SIGNAL_THRESHOLD = 0;

/**
 * Keep a visible low-frequency body throughout active playback. The floor is
 * gated by any measured/analyzed signal energy, so a genuinely silent track
 * can still settle to the idle landscape without discarding quiet passages.
 */
export function selectSustainedLowFloor(frame, presence = 1) {
  if (!frame?.active || frame.source === 'idle') return Object.freeze([0, 0, 0]);
  const activity = Math.max(
    clamp01(frame.energy),
    clamp01(frame.sectionEnergy),
    clamp01(frame.subBass),
    clamp01(frame.bass),
    clamp01(frame.lowMid) * 0.72,
    clamp01(frame.kickEnvelope) * 0.65,
  );
  if (activity <= AUDIBLE_SIGNAL_THRESHOLD) return Object.freeze([0, 0, 0]);
  const hold = clamp01(presence);
  const motion = clamp01(activity * 1.8);
  return Object.freeze([
    (0.22 + motion * 0.10) * hold,
    (0.24 + motion * 0.11) * hold,
    (0.16 + motion * 0.08) * hold,
  ]);
}

/** A bounded ring profile derived from the current section/tide energy. */
export function selectRippleProfile(tide, reducedMotion = false) {
  const level = clamp01(tide);
  const count = reducedMotion ? 1 : (level >= 0.68 ? 3 : (level >= 0.30 ? 2 : 1));
  return Object.freeze({
    level,
    count,
    power: 0.48 + level * 1.18,
    // Spawn across nearly the full visible terrain. The outer coverage fade
    // begins at 68 units, so this retains a small margin for complete rings.
    originRadius: 58 + level * 6,
  });
}

/** Map a uniform random value to an area-uniform radius on the terrain disk. */
export function selectRippleOriginRadius(unit, maxRadius, minRadius = 4) {
  const outer = Math.max(0, Number(maxRadius) || 0);
  const inner = Math.max(0, Math.min(outer, Number(minRadius) || 0));
  return inner + Math.sqrt(clamp01(unit)) * (outer - inner);
}

/** Convert one real/analyzed beat event into a short terrain impact. */
export function selectTerrainBeatPulse(beat = {}) {
  const strength = clamp01(beat.strength ?? beat.intensity ?? 0.5);
  const low = clamp01(beat.low ?? strength * 0.82);
  const impact = clamp01(beat.impact ?? strength);
  const typeScale = beat.type === 'downbeat' || beat.type === 'drop'
    ? 1.10 : (beat.type === 'accent' ? 0.92 : 0.80);
  const curvedStrength = Math.pow(Math.max(strength, low * 0.92, impact), 0.72);
  return clamp01(curvedStrength * typeScale);
}

/** Shape the raw beat hit into the terrain's fast rise/fall height envelope. */
export function shapeTerrainBeatEnvelope(pulse) {
  const x = clamp01((clamp01(pulse) - 0.025) / 0.495);
  return x * x * (3 - 2 * x);
}

/** Frame-rate-independent attack/release smoothing for visual beat channels. */
export function advanceTerrainBeatEnvelope(
  current, target, dt, attackSeconds, releaseSeconds,
) {
  const from = clamp01(current);
  const to = clamp01(target);
  const seconds = Math.max(0, Number(dt) || 0);
  const tau = Math.max(0.001, to > from ? attackSeconds : releaseSeconds);
  return from + (to - from) * (1 - Math.exp(-seconds / tau));
}

/** Low tide rests low; a full climax keeps 80% of its available height. */
export function selectTerrainHeightFloor(sectionEnergy) {
  const x = clamp01((clamp01(sectionEnergy) - 0.045) / 0.235);
  const sectionDrive = x * x * (3 - 2 * x);
  return 0.12 + sectionDrive * 0.68;
}

/** Keep climax colour nearly steady while retaining low-tide contrast. */
export function selectTerrainEnergyFloor(sectionEnergy) {
  const x = clamp01((clamp01(sectionEnergy) - 0.045) / 0.235);
  const sectionDrive = x * x * (3 - 2 * x);
  return 0.24 + sectionDrive * 0.66;
}

function hash01(seed) {
  const value = Math.sin(seed * 91.733 + 17.17) * 43758.5453;
  return value - Math.floor(value);
}

// Top plus four side faces prevent a dark seam when the terrain rotates. This
// remains lighter than BoxGeometry because the permanently hidden bottom face
// is omitted.
function createColumnGeometry(width) {
  const half = width * 0.5;
  const positions = new Float32Array([
    // top
    -half, 0.5, -half,  half, 0.5, -half,  half, 0.5, half,
    -half, 0.5, -half,  half, 0.5, half, -half, 0.5, half,
    // x-facing side
    half, -0.5, -half,  half, 0.5, -half,  half, 0.5, half,
    half, -0.5, -half,  half, 0.5, half,  half, -0.5, half,
    // z-facing side
    -half, -0.5, half,  half, -0.5, half,  half, 0.5, half,
    -half, -0.5, half,  half, 0.5, half, -half, 0.5, half,
    // opposite x-facing side
    -half, -0.5, half, -half, 0.5, half, -half, 0.5, -half,
    -half, -0.5, half, -half, 0.5, -half, -half, -0.5, -half,
    // opposite z-facing side
    half, -0.5, -half, -half, -0.5, -half, -half, 0.5, -half,
    half, -0.5, -half, -half, 0.5, -half, half, 0.5, -half,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  return geometry;
}

export function selectTerrainGridSize(capabilities = {}) {
  const reducedMotion = Boolean(capabilities.reducedMotion);
  const isMobile = Boolean(capabilities.isMobile);
  const cores = Number(capabilities.hardwareConcurrency) || 4;
  const memory = Number(capabilities.deviceMemory) || 4;
  const viewportWidth = Number(capabilities.viewportWidth) || 1280;
  // Keep the software tier odd so one column sits on the visual centreline;
  // this avoids a dark seam while staying above 30 FPS in headless Chromium.
  if (capabilities.softwareRenderer) return 45;
  // Odd grids place one physical pillar on the visual centreline. This avoids
  // a perspective aisle bisecting the main peak while changing load by <1%.
  if (reducedMotion) return 193;
  if (isMobile || cores <= 4 || memory <= 4) return 225;
  if (capabilities.quality === 'high' && cores >= 8 && memory >= 8 && viewportWidth >= 1600) return 385;
  return 321;
}

function detectCapabilities(renderer) {
  let rendererName = '';
  try {
    const context = renderer?.getContext();
    const info = context?.getExtension('WEBGL_debug_renderer_info');
    rendererName = info ? String(context.getParameter(info.UNMASKED_RENDERER_WEBGL) || '') : '';
  } catch (_) { /* capability detection is best-effort */ }
  return {
    reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    isMobile: /Mobi|Android/i.test(navigator.userAgent),
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    viewportWidth: window.innerWidth,
    softwareRenderer: /swiftshader|llvmpipe|software/i.test(rendererName)
      || navigator.webdriver === true
      || /HeadlessChrome/i.test(navigator.userAgent),
  };
}

/** TSBot renderer integration around the attributed Sonic Topography terrain functions. */
export class SonicTopographyStage {
  constructor(renderer = null) {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      48,
      window.innerWidth / Math.max(1, window.innerHeight),
      0.1,
      360,
    );
    // Frame the terrain as a complete audio landscape. Its radial fade and
    // response-coloured mist now conceal the finite grid instead of overscan.
    this.camera.position.set(0, 54, 112);
    this.camera.lookAt(0, -8, -18);

    this.root = new THREE.Group();
    this.root.name = 'tsbot-sonic-topography';
    this.root.visible = false;
    this.root.position.set(0, -6.2, -18);
    // Avoid looking exactly down an inter-column aisle on even production
    // grids. The slight yaw also matches the source's oblique landscape view.
    this.root.rotation.y = -0.35;
    this.scene.add(this.root);

    this.gridSize = selectTerrainGridSize(detectCapabilities(renderer));
    this._reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false;
    this._bands = new Array(8).fill(0);
    this._ripples = Array.from({ length: RIPPLE_MAX }, () => new THREE.Vector4(0, 0, -10, 0));
    this._meteors = Array.from({ length: METEOR_MAX }, () => ({ active: false, age: 0, seed: 0 }));
    this._rippleCursor = 0;
    this._meteorCursor = 0;
    this._beatSequence = 0;
    this._beatPulse = 0;
    this._beatVisual = 0;
    this._beatLight = 0;
    this._responseLevel = 0;
    this._lowPresence = 0;
    this._amplitude = 1.2;
    this._brightness = 1;
    this._buildTerrain();
    this._buildBoundaryMist();
    this._buildFloatingBlocks();
    this._buildMeteors();
  }

  _buildTerrain() {
    const count = this.gridSize * this.gridSize;
    const spacing = TERRAIN_SIZE / Math.max(1, this.gridSize - 1);
    // A slimmer footprint plus a denser grid reads as fine topography instead
    // of oversized blocks, without reducing the audio-driven column height.
    // Retain visibly separate pillars while narrowing the long perspective
    // aisles that otherwise converge into a dark seam at production density.
    const geometry = createColumnGeometry(spacing * 0.78);
    const cells = new Float32Array(count * 2);
    const seeds = new Float32Array(count);
    const half = TERRAIN_SIZE * 0.5;

    for (let i = 0; i < count; i++) {
      const x = i % this.gridSize;
      const y = Math.floor(i / this.gridSize);
      cells[i * 2] = x * spacing - half;
      cells[i * 2 + 1] = y * spacing - half;
      seeds[i] = hash01(i + 1);
    }
    geometry.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));

    this._uniforms = {
      uTime: { value: 0 },
      uAmplitude: { value: this._amplitude },
      uClimax: { value: 0 },
      uBeatPulse: { value: 0 },
      uBeatLight: { value: 0 },
      uBands: { value: this._bands },
      uRipples: { value: this._ripples },
      uBaseColor: { value: new THREE.Color('#03060c') },
      uCoolColor: { value: new THREE.Color('#1c5f91') },
      uWarmColor: { value: new THREE.Color('#c45345') },
      uAccentColor: { value: new THREE.Color('#8dd8db') },
      uPeakColor: { value: new THREE.Color('#efffff') },
      uBrightness: { value: this._brightness },
      uLightCeiling: { value: TERRAIN_LIGHT_CEILING },
      uOpacity: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: TERRAIN_VS,
      fragmentShader: TERRAIN_FS,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, count);
    this.mesh.name = 'sonic-terrain-grid';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.root.add(this.mesh);
  }

  _buildBoundaryMist() {
    this._mistUniforms = {
      uTime: { value: 0 },
      uEnergy: { value: 0 },
      uOpacity: { value: 1 },
      // Share the live palette objects so cover-colour changes also recolour
      // the boundary transition without allocating or copying each frame.
      uCoolColor: this._uniforms.uCoolColor,
      uAccentColor: this._uniforms.uAccentColor,
    };
    const geometry = new THREE.PlaneGeometry(TERRAIN_SIZE * 1.28, TERRAIN_SIZE * 1.28);
    const material = new THREE.ShaderMaterial({
      uniforms: this._mistUniforms,
      vertexShader: MIST_VS,
      fragmentShader: MIST_FS,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.boundaryMist = new THREE.Mesh(geometry, material);
    this.boundaryMist.name = 'sonic-boundary-mist';
    this.boundaryMist.rotation.x = -Math.PI / 2;
    this.boundaryMist.position.y = -2.2;
    this.boundaryMist.renderOrder = 1;
    this.boundaryMist.frustumCulled = false;
    this.root.add(this.boundaryMist);
  }

  _buildFloatingBlocks() {
    const geometry = new THREE.BoxGeometry(0.16, 0.16, 0.16);
    const material = new THREE.MeshBasicMaterial({
      color: 0x9edce2,
      transparent: true,
      opacity: this._reducedMotion ? 0 : 0.54,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.floatingBlocks = new THREE.InstancedMesh(geometry, material, FLOATING_BLOCK_MAX);
    this.floatingBlocks.frustumCulled = false;
    this.floatingBlocks.renderOrder = 3;
    this.root.add(this.floatingBlocks);
  }

  _buildMeteors() {
    const geometry = new THREE.BoxGeometry(0.055, 0.055, 1.15);
    const material = new THREE.MeshBasicMaterial({
      color: 0xeafcff,
      transparent: true,
      opacity: this._reducedMotion ? 0 : 0.76,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this.meteorMesh = new THREE.InstancedMesh(geometry, material, METEOR_MAX);
    this.meteorMesh.frustumCulled = false;
    this.meteorMesh.renderOrder = 4;
    this.root.add(this.meteorMesh);
  }

  setVisible(visible) {
    this.root.visible = Boolean(visible);
    if (!this.root.visible) {
      this._beatPulse = 0;
      this._beatVisual = 0;
      this._beatLight = 0;
      this._uniforms.uBeatPulse.value = 0;
      this._uniforms.uBeatLight.value = 0;
    }
  }

  resize(width, height) {
    this.camera.aspect = Math.max(1, width) / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(renderer) {
    if (this.root.visible) renderer.render(this.scene, this.camera);
  }

  setAmplitude(value) {
    this._amplitude = Math.max(0.2, Math.min(3, Number(value) || 1.2));
    this._uniforms.uAmplitude.value = this._amplitude;
  }

  setBrightness(value) {
    this._brightness = Math.max(0.3, Math.min(2.5, Number(value) || 1));
    this._uniforms.uBrightness.value = this._brightness;
  }

  resetPalette() {
    this._uniforms.uBaseColor.value.set('#03060c');
    this._uniforms.uCoolColor.value.set('#1c5f91');
    this._uniforms.uWarmColor.value.set('#c45345');
    this._uniforms.uAccentColor.value.set('#8dd8db');
    this._uniforms.uPeakColor.value.set('#efffff');
  }

  setPaletteFromCanvas(canvas) {
    if (!canvas) return;
    try {
      const sample = document.createElement('canvas');
      sample.width = 10;
      sample.height = 10;
      const context = sample.getContext('2d', { willReadFrequently: true });
      context.drawImage(canvas, 0, 0, 10, 10);
      const pixels = context.getImageData(0, 0, 10, 10).data;
      const theme = selectThemeColor(pixels);
      if (!theme) {
        this.resetPalette();
        return;
      }
      const accent = new THREE.Color(theme.red, theme.green, theme.blue);
      const hsl = {};
      accent.getHSL(hsl);
      this._uniforms.uAccentColor.value.copy(accent);
      this._uniforms.uCoolColor.value.setHSL((hsl.h + 0.93) % 1, Math.max(0.38, hsl.s), 0.34);
      this._uniforms.uWarmColor.value.setHSL((hsl.h + 0.08) % 1, Math.max(0.42, hsl.s), 0.44);
      this._uniforms.uPeakColor.value.copy(accent).lerp(new THREE.Color('#ffffff'), 0.60);
    } catch (_) {
      // Keep the stable default palette when canvas sampling is unavailable.
    }
  }

  onBeat(beat = {}) {
    if (!this.root.visible) return;
    const strength = clamp01(beat.strength ?? beat.intensity ?? 0.5);
    const low = clamp01(beat.low ?? strength * 0.8);
    const high = clamp01(beat.snap ?? strength * 0.3);
    const tide = Math.max(
      this._responseLevel,
      clamp01(beat.sectionEnergy),
    );
    const profile = selectRippleProfile(tide, this._reducedMotion);
    const beatPulse = selectTerrainBeatPulse(beat);
    this._beatPulse = Math.max(this._beatPulse, beatPulse);
    this._beatSequence += 1;

    // Tide controls how many drops and how far they can spread, but no longer
    // suppresses ordinary analyzed beats. Every meaningful beat gets at least
    // one local water response.
    if (beatPulse > 0.045) {
      for (let i = 0; i < profile.count; i++) {
        const seed = this._beatSequence * 7 + i * 29;
        const angle = hash01(seed + 19) * Math.PI * 2;
        const radius = selectRippleOriginRadius(
          hash01(seed + 41), profile.originRadius
        );
        const power = profile.power * (0.58 + beatPulse * 0.72)
          * (1 - i * 0.055);
        this._spawnRipple(angle, radius, -i * 0.075, power);
      }
    }
    if (!this._reducedMotion && (high > 0.55 || beat.type === 'accent')) {
      const angle = hash01(this._beatSequence + 71) * Math.PI * 2;
      const radius = selectRippleOriginRadius(
        hash01(this._beatSequence + 83), 62, 6
      );
      // A negative strength tags the narrow, faster high-frequency wave.
      this._spawnRipple(angle, radius, 0,
        -(0.42 + high * 0.58 + profile.level * 0.62));
      const meteor = this._meteors[this._meteorCursor];
      meteor.active = true;
      meteor.age = 0;
      meteor.seed = this._beatSequence;
      this._meteorCursor = (this._meteorCursor + 1) % METEOR_MAX;
    }
  }

  _spawnRipple(angle, radius, age, power) {
    const ripple = this._ripples[this._rippleCursor];
    ripple.set(Math.cos(angle) * radius, Math.sin(angle) * radius, age, power);
    this._rippleCursor = (this._rippleCursor + 1) % RIPPLE_MAX;
  }

  update(dt, elapsed, frame) {
    if (!this.root.visible) return;
    this._uniforms.uTime.value = elapsed;
    this._mistUniforms.uTime.value = elapsed;
    this._mistUniforms.uEnergy.value = clamp01(frame?.energy);
    this._uniforms.uClimax.value = clamp01(frame?.sectionEnergy);
    this._beatPulse *= Math.exp(-dt / 0.18);
    if (this._beatPulse < 0.001) this._beatPulse = 0;
    const beatTarget = shapeTerrainBeatEnvelope(this._beatPulse);
    // Height remains responsive but never jumps on the event frame. Light is
    // deliberately slower and longer-lived so consecutive beats blend instead
    // of flashing the full terrain on and off.
    this._beatVisual = advanceTerrainBeatEnvelope(
      this._beatVisual, beatTarget, dt, 0.09, 0.24,
    );
    this._beatLight = advanceTerrainBeatEnvelope(
      this._beatLight, beatTarget, dt, 0.18, 0.46,
    );
    this._uniforms.uBeatPulse.value = this._beatVisual;
    this._uniforms.uBeatLight.value = this._beatLight;
    const responseTarget = Math.max(
      clamp01(frame?.sectionEnergy),
      clamp01(frame?.energy) * 0.52,
    );
    const responseTau = responseTarget > this._responseLevel ? 0.16 : 0.78;
    this._responseLevel += (responseTarget - this._responseLevel)
      * (1 - Math.exp(-dt / responseTau));
    const signalActivity = Math.max(
      clamp01(frame?.energy),
      clamp01(frame?.sectionEnergy),
      clamp01(frame?.subBass),
      clamp01(frame?.bass),
      clamp01(frame?.lowMid) * 0.72,
      clamp01(frame?.kickEnvelope) * 0.65,
    );
    const audibleTarget = frame?.active && frame?.source !== 'idle'
      && signalActivity > AUDIBLE_SIGNAL_THRESHOLD ? 1 : 0;
    const audibleTau = audibleTarget > this._lowPresence ? 0.12 : 1.0;
    this._lowPresence += (audibleTarget - this._lowPresence)
      * (1 - Math.exp(-dt / audibleTau));
    const keys = ['subBass', 'bass', 'lowMid', 'mid', 'highMid', 'presence', 'brilliance', 'air'];
    for (let i = 0; i < keys.length; i++) {
      this._bands[i] = shapeSonicBand(i, frame?.[keys[i]], frame?.source);
    }
    const lowFloor = selectSustainedLowFloor(frame, this._lowPresence);
    this._bands[0] = Math.max(this._bands[0], lowFloor[0]);
    this._bands[1] = Math.max(this._bands[1], lowFloor[1]);
    this._bands[2] = Math.max(this._bands[2], lowFloor[2]);

    for (const ripple of this._ripples) {
      if (Math.abs(ripple.w) <= 0.001) continue;
      ripple.z += dt;
      if (ripple.z > 4.8) ripple.set(0, 0, -10, 0);
    }
    this._updateFloatingBlocks(elapsed, frame?.energy || 0);
    this._updateMeteors(dt);
  }

  _updateFloatingBlocks(elapsed, energy) {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    for (let i = 0; i < FLOATING_BLOCK_MAX; i++) {
      const seed = i + 1;
      const radius = 12 + hash01(seed) * 43;
      const angle = hash01(seed + 31) * Math.PI * 2 + elapsed * (0.025 + hash01(seed + 7) * 0.035);
      position.set(
        Math.cos(angle) * radius,
        -0.7 + hash01(seed + 13) * 5.2 + Math.sin(elapsed * 0.35 + seed) * 0.22,
        Math.sin(angle) * radius,
      );
      const size = 0.55 + hash01(seed + 47) * 1.8 + clamp01(energy) * 0.18;
      scale.setScalar(size);
      matrix.compose(position, quaternion, scale);
      this.floatingBlocks.setMatrixAt(i, matrix);
    }
    this.floatingBlocks.instanceMatrix.needsUpdate = true;
  }

  _updateMeteors(dt) {
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.62, 0.25, 0));
    for (let i = 0; i < METEOR_MAX; i++) {
      const meteor = this._meteors[i];
      if (!meteor.active) {
        scale.setScalar(0.0001);
        matrix.compose(position.set(0, -20, 0), quaternion, scale);
      } else {
        meteor.age += dt;
        const progress = meteor.age / 1.15;
        if (progress >= 1) {
          meteor.active = false;
          scale.setScalar(0.0001);
          matrix.compose(position.set(0, -20, 0), quaternion, scale);
        } else {
          const seed = meteor.seed;
          const startX = (hash01(seed + 5) - 0.5) * 72;
          const startZ = (hash01(seed + 11) - 0.5) * 64;
          position.set(startX + progress * 3.2, 7.5 - progress * 11.5, startZ + progress * 2.0);
          scale.set(1, 1, 0.55 + (1 - progress) * 1.8);
          matrix.compose(position, quaternion, scale);
        }
      }
      this.meteorMesh.setMatrixAt(i, matrix);
    }
    this.meteorMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    for (const object of [this.mesh, this.boundaryMist, this.floatingBlocks, this.meteorMesh]) {
      object.geometry.dispose();
      object.material.dispose();
      this.root.remove(object);
    }
    this.scene.remove(this.root);
    this.scene.clear();
  }
}
