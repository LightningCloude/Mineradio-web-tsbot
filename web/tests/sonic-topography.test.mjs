import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  selectRippleProfile,
  selectRippleOriginRadius,
  selectTerrainBeatPulse,
  shapeTerrainBeatEnvelope,
  advanceTerrainBeatEnvelope,
  selectTerrainHeightFloor,
  selectTerrainEnergyFloor,
  selectSustainedLowFloor,
  selectTerrainGridSize,
  selectThemeColor,
  shapeSonicBand,
} from '../src/visual/SonicTopographyStage.js';
import {
  loadVisualPreset,
  normalizeVisualPreset,
  saveVisualPreset,
  VISUAL_PRESET_STORAGE_KEY,
} from '../src/player/VisualPresetStore.js';

test('synthetic bands use a lower response range while non-low realtime values stay linear', () => {
  assert.equal(shapeSonicBand(3, 0.1, 'realtime'), 0.1);
  assert.ok(shapeSonicBand(3, 0.05, 'synthetic') > 0.1);
  assert.ok(shapeSonicBand(3, 0.1, 'synthetic') > 0.75);
  assert.ok(shapeSonicBand(3, 0.13, 'synthetic') > 0.98);
  assert.equal(shapeSonicBand(3, 0.14, 'synthetic'), 1);
  assert.equal(shapeSonicBand(3, -1, 'synthetic'), 0);
  assert.equal(shapeSonicBand(3, 4, 'synthetic'), 1);
});

test('quiet low-frequency bands receive visual lift without raising their peak ceiling', () => {
  assert.ok(shapeSonicBand(0, 0.04, 'realtime') > 0.14);
  assert.ok(shapeSonicBand(1, 0.08, 'realtime') > 0.19);
  assert.ok(shapeSonicBand(2, 0.08, 'realtime') > 0.13);
  assert.equal(shapeSonicBand(0, 0, 'realtime'), 0);
  assert.equal(shapeSonicBand(0, 1, 'realtime'), 1);
  assert.equal(shapeSonicBand(3, 0.08, 'realtime'), 0.08);
});

test('active audible playback sustains a low-frequency floor but true silence does not', () => {
  const quiet = selectSustainedLowFloor({
    active: true, source: 'analyzed', energy: 0.025,
    sectionEnergy: 0.01, subBass: 0.018, bass: 0.02, lowMid: 0.012,
  });
  assert.ok(quiet[0] >= 0.22 && quiet[1] >= 0.24 && quiet[2] >= 0.16);
  const whisper = selectSustainedLowFloor({
    active: true, source: 'realtime', energy: 1e-9, sectionEnergy: 0,
    subBass: 0, bass: 0, lowMid: 0, kickEnvelope: 0,
  });
  assert.ok(whisper[0] > 0 && whisper[1] > 0 && whisper[2] > 0);
  assert.deepEqual(selectSustainedLowFloor({
    active: true, source: 'realtime', energy: 0, sectionEnergy: 0,
    subBass: 0, bass: 0, lowMid: 0, kickEnvelope: 0,
  }), [0, 0, 0]);
  assert.deepEqual(selectSustainedLowFloor({
    active: false, source: 'analyzed', energy: 0.8, bass: 0.8,
  }), [0, 0, 0]);
});

test('terrain quality stays conservative and has a software-renderer safety tier', () => {
  assert.equal(selectTerrainGridSize({ softwareRenderer: true, hardwareConcurrency: 12, deviceMemory: 16 }), 45);
  assert.equal(selectTerrainGridSize({ isMobile: true, hardwareConcurrency: 12, deviceMemory: 16 }), 225);
  assert.equal(selectTerrainGridSize({ reducedMotion: true, hardwareConcurrency: 12, deviceMemory: 16 }), 193);
  assert.equal(selectTerrainGridSize({ hardwareConcurrency: 6, deviceMemory: 8, viewportWidth: 1400 }), 321);
  assert.equal(selectTerrainGridSize({ hardwareConcurrency: 12, deviceMemory: 16, viewportWidth: 1920 }), 321);
  assert.equal(selectTerrainGridSize({ quality: 'high', hardwareConcurrency: 12, deviceMemory: 16, viewportWidth: 1920 }), 385);
});

test('ripple quantity, power and footprint rise monotonically with song tide', () => {
  const low = selectRippleProfile(0.08);
  const middle = selectRippleProfile(0.48);
  const high = selectRippleProfile(0.92);
  assert.deepEqual([low.count, middle.count, high.count], [1, 2, 3]);
  assert.ok(low.power < middle.power && middle.power < high.power);
  assert.ok(low.originRadius < middle.originRadius && middle.originRadius < high.originRadius);
  assert.equal(selectRippleProfile(1, true).count, 1);
});

test('ripple origins cover the terrain disk instead of clustering at its centre', () => {
  const low = selectRippleProfile(0.08);
  const high = selectRippleProfile(0.92);
  assert.ok(low.originRadius >= 58);
  assert.ok(high.originRadius <= 64);
  assert.equal(selectRippleOriginRadius(0, 64), 4);
  assert.equal(selectRippleOriginRadius(1, 64), 64);
  // Area-uniform sampling puts the midpoint well outside half-radius.
  assert.ok(selectRippleOriginRadius(0.5, 64) > 44);
});

test('every meaningful analyzed beat produces an independent terrain pulse', () => {
  const pulse = selectTerrainBeatPulse({
    type: 'pulse', strength: 0.32, low: 0.18, sectionEnergy: 0.05,
  });
  const downbeat = selectTerrainBeatPulse({
    type: 'downbeat', strength: 0.32, low: 0.18, sectionEnergy: 0.05,
  });
  assert.ok(pulse > 0.045);
  assert.ok(downbeat > pulse);
  assert.equal(selectTerrainBeatPulse({ type: 'pulse', strength: 0, low: 0, impact: 0 }), 0);
});

test('beat envelope creates a pronounced rise while tide remains only the ceiling', () => {
  const quiet = shapeTerrainBeatEnvelope(0);
  const ordinary = shapeTerrainBeatEnvelope(selectTerrainBeatPulse({
    type: 'pulse', strength: 0.30, low: 0.20, impact: 0.28,
  }));
  const downbeat = shapeTerrainBeatEnvelope(selectTerrainBeatPulse({
    type: 'downbeat', strength: 0.55, low: 0.52, impact: 0.60,
  }));
  assert.equal(quiet, 0);
  assert.ok(ordinary > 0.55);
  assert.ok(downbeat > ordinary);
  assert.equal(shapeTerrainBeatEnvelope(1), 1);
});

test('height and light beat envelopes buffer attack and release without jumping', () => {
  const heightRise = advanceTerrainBeatEnvelope(0, 1, 1 / 60, 0.09, 0.24);
  const lightRise = advanceTerrainBeatEnvelope(0, 1, 1 / 60, 0.18, 0.46);
  assert.ok(heightRise > 0 && heightRise < 0.25);
  assert.ok(lightRise > 0 && lightRise < heightRise);
  const heightRelease = advanceTerrainBeatEnvelope(1, 0, 1 / 60, 0.09, 0.24);
  const lightRelease = advanceTerrainBeatEnvelope(1, 0, 1 / 60, 0.18, 0.46);
  assert.ok(heightRelease < 1 && heightRelease > 0.9);
  assert.ok(lightRelease > heightRelease);
});

test('climax keeps high terrain and brightness floors between beats', () => {
  const low = selectTerrainHeightFloor(0);
  const middle = selectTerrainHeightFloor(0.1625);
  const climax = selectTerrainHeightFloor(1);
  assert.equal(low, 0.12);
  assert.ok(middle > low && middle < climax);
  assert.equal(climax, 0.8);
  assert.equal(selectTerrainEnergyFloor(0), 0.24);
  assert.equal(selectTerrainEnergyFloor(1), 0.9);
});

test('final terrain output caps peak white and spark brightness at 80 percent', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /const TERRAIN_LIGHT_CEILING = 0\.80/);
  assert.match(source, /uniform float uLightCeiling/);
  assert.match(source, /color \*= uLightCeiling/);
  assert.match(source, /uLightCeiling: \{ value: TERRAIN_LIGHT_CEILING \}/);
  assert.ok(
    source.indexOf('color *= uLightCeiling')
      > source.indexOf('color = color / (vec3(1.0) + color * 0.28)'),
  );
});

test('cover palette rejects white pixels and falls back when no colour remains', () => {
  const pixels = new Uint8ClampedArray([
    255, 255, 255, 255,
    246, 246, 246, 255,
    30, 90, 210, 255,
    32, 92, 212, 255,
  ]);
  const theme = selectThemeColor(pixels);
  assert.ok(theme.blue > 0.80);
  assert.ok(theme.red < 0.15);
  assert.equal(selectThemeColor(new Uint8ClampedArray([
    255, 255, 255, 255,
    238, 238, 238, 255,
  ])), null);
});

test('production terrain uses a dense grid with slim column footprints', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /return 321/);
  assert.match(source, /return 385/);
  assert.match(source, /createColumnGeometry\(spacing \* 0\.78\)/);
});

test('particle stage exposes three presets and lazily creates terrain', async () => {
  const source = await readFile(new URL('../src/visual/ParticleStage.js', import.meta.url), 'utf8');
  assert.match(source, /Math\.min\(2, index \| 0\)/);
  assert.match(source, /if \(idx === 2\) this\._ensureSonicStage\(\)/);
  assert.match(source, /const particlesVisible = idx !== 2/);
  assert.match(source, /this\._sonicStage\?\.dispose\(\)/);
  assert.doesNotMatch(source, /TUNNEL|float spin =|float baseR =/);
  assert.doesNotMatch(source, /\/\/ ── Default fallback ──\s*else\s*\{/);
});

test('visual settings exposes exactly three presets without tunnel', async () => {
  const source = await readFile(new URL('../src/player/VisualSettings.js', import.meta.url), 'utf8');
  const buttons = [...source.matchAll(/class="preset-btn[^"\n]*" data-preset="(\d)"/g)];
  assert.deepEqual(buttons.map(match => match[1]), ['0', '1', '2']);
  assert.match(source, /data-preset="2">音域回响/);
  assert.doesNotMatch(source, /TUNNEL|隧道/);
});

test('visual preset survives browser restart and invalid storage safely falls back', () => {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(normalizeVisualPreset('2'), 2);
  assert.equal(normalizeVisualPreset('7'), 0);
  assert.equal(normalizeVisualPreset('1.5'), 0);
  assert.equal(normalizeVisualPreset('invalid'), 0);
  assert.equal(saveVisualPreset(2, storage), 2);
  assert.equal(values.get(VISUAL_PRESET_STORAGE_KEY), '2');
  assert.equal(loadVisualPreset(storage), 2);
  values.set(VISUAL_PRESET_STORAGE_KEY, '99');
  assert.equal(loadVisualPreset(storage), 0);
  assert.equal(loadVisualPreset({ getItem: () => { throw new Error('storage denied'); } }), 0);
});

test('visual settings restores the cached preset and persists user changes', async () => {
  const source = await readFile(new URL('../src/player/VisualSettings.js', import.meta.url), 'utf8');
  assert.match(source, /this\._restorePreset\(\)/);
  assert.match(source, /this\._applyPreset\(btn\.dataset\.preset, true\)/);
  assert.match(source, /this\._applyPreset\(loadVisualPreset\(\), false\)/);
  assert.match(source, /if \(persist\) saveVisualPreset\(idx\)/);
});

test('native terrain does not add iframe, React, or a second renderer', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /iframe|postMessage|React|WebGLRenderer/);
  assert.match(source, /new THREE\.InstancedMesh\(geometry, material, count\)/);
  assert.match(source, /RIPPLE_MAX = 10/);
  assert.match(source, /FLOATING_BLOCK_MAX = 32/);
});

test('terrain footprint hides its boundary and audio fields span broad overlapping regions', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /TERRAIN_SIZE = 168/);
  assert.doesNotMatch(source, /this\.root\.scale\.x/);
  assert.match(source, /float coverage = 1\.0 - smoothstep\(68\.0, 84\.0/);
  assert.match(source, /float centerMound = 1\.0 - smoothstep\(7\.0, 38\.0/);
  assert.match(source, /float bassMound = 1\.0 - smoothstep\(13\.0, 54\.0/);
  assert.match(source, /float snoise\(vec2 v\)/);
  assert.match(source, /float easeLift\(float raw, float maxHeight\)/);
  assert.match(source, /float flowLift\(float raw, float maxHeight\)/);
  assert.match(source, /float organicRadius = moundDistance \+ terrainNoise/);
  assert.match(source, /float lowTideNoise = snoise/);
  assert.match(source, /float lowTideLift = lowTidePatch/);
  assert.match(source, /\+ lowTideLift/);
  assert.match(source, /float subField = easeLift\(uBands\[0\], 7\.2\) \* centerMound/);
  assert.match(source, /float bassField = easeLift\(uBands\[1\], 6\.0\) \* bassMound/);
  assert.match(source, /float lowMidField = flowLift\(uBands\[2\], 3\.6\)/);
  assert.match(source, /float highMidField = easeLift\(uBands\[4\], 3\.0\)/);
  assert.match(source, /float midCoreDrive = max\(max\(uBands\[2\] \* 0\.88, uBands\[3\]\), uBands\[4\] \* 0\.72\)/);
  assert.match(source, /float midCoreEnvelope = smoothstep\(0\.027, 0\.24, midCoreDrive\)/);
  assert.match(source, /midCoreMound \* 0\.82/);
  assert.match(source, /float sectionDrive = smoothstep\(0\.045, 0\.28, uClimax\)/);
  assert.match(source, /float climaxDrive = sectionDrive \* smoothstep\(0\.06, 0\.58, spectralPeak\)/);
  assert.match(source, /float climaxMound = easeLift\(climaxDrive, 18\.75\) \* climaxCore/);
  assert.match(source, /float climaxSatellites = easeLift\(climaxDrive, 3\.4\) \* satelliteMask/);
  assert.match(source, /float coreB = \(1\.0 - smoothstep/);
  assert.match(source, /float coreC = \(1\.0 - smoothstep/);
  assert.match(source, /mix\(6\.2, 22\.5, climaxDrive\)/);
  assert.match(source, /uClimax: \{ value: 0 \}/);
  assert.match(source, /uClimax\.value = clamp01\(frame\?\.sectionEnergy\)/);
  assert.match(source, /uPeakColor: \{ value: new THREE\.Color\('#efffff'\) \}/);
  assert.match(source, /vPeakIntensity = clamp/);
  assert.match(source, /float brillianceField = uBands\[6\] \* microSpikes/);
  assert.match(source, /uBands\[0\] \* centerMound \* 0\.78/);
  assert.doesNotMatch(source, /length\(aCell\) \/ 16\.8|bandPos = radius \* 7\.0/);
});

test('beat waves use the full fixed pool and travel across the expanded floor', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /uniform vec4 uRipples\[10\]/);
  assert.match(source, /float ringDrive = clamp/);
  assert.match(source, /float ringSpeed = mix\(10\.8, 14\.2, ringDrive\)/);
  assert.match(source, /float ringLife = mix\(2\.70, 4\.35, ringDrive\)/);
  assert.match(source, /const profile = selectRippleProfile\(tide, this\._reducedMotion\)/);
  assert.match(source, /for \(let i = 0; i < profile\.count; i\+\+\)/);
  assert.match(source, /spectralLift \* beatHeightGate \* uAmplitude \* 0\.62/);
  assert.match(source, /rippleLift \* uAmplitude \* 0\.72/);
  assert.match(source, /float corePriority = mix\(1\.0, 0\.10, climaxDrive \* climaxCore\)/);
  assert.match(source, /mix\(1\.0, 0\.22, climaxDrive\) \* corePriority/);
  assert.match(source, /ripple\.z > 4\.8/);
  assert.match(source, /selectRippleOriginRadius\(\s*hash01\(seed \+ 41\), profile\.originRadius/);
  assert.match(source, /selectRippleOriginRadius\(\s*hash01\(this\._beatSequence \+ 83\), 62, 6/);
});

test('beat rings use a water-drop crest, trough and distance-damped wake', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /float mainCrest = exp\(-pow\(ringOffset \/ ringWidth, 2\.0\)\)/);
  assert.match(source, /float trailingTrough = exp\(-pow\(/);
  assert.match(source, /float secondaryCrest = exp\(-pow\(/);
  assert.match(source, /float waterWave = mainCrest - trailingTrough \* 0\.30/);
  assert.match(source, /float impact = exp\(-pow\(dist \/ impactRadius, 2\.0\)\)/);
  assert.match(source, /float attack = smoothstep\(0\.0, 0\.075, impactAge\)/);
  assert.match(source, /float travelFade = exp\(-ringRadius \/ mix\(27\.0, 39\.0, ringDrive\)\)/);
  assert.doesNotMatch(source, /float travelFade = 1\.0 - smoothstep/);
});

test('terrain beat envelope is separate from the section tide and decays quickly', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /uniform float uBeatPulse/);
  assert.match(source, /uniform float uBeatLight/);
  assert.match(source, /float beatLift = uBeatPulse/);
  assert.match(source, /float tideHeightFloor = mix\(0\.12, 0\.80, sectionDrive\)/);
  assert.match(source, /float tideEnergyFloor = mix\(0\.24, 0\.90, sectionDrive\)/);
  assert.match(source, /float beatHeightGate = tideHeightFloor/);
  assert.match(source, /uBeatPulse \* \(1\.0 - tideHeightFloor\)/);
  assert.match(source, /spectralLift \* beatHeightGate \* uAmplitude \* 0\.62/);
  assert.match(source, /\+ beatLift \* uAmplitude/);
  assert.match(source, /const beatPulse = selectTerrainBeatPulse\(beat\)/);
  assert.match(source, /if \(beatPulse > 0\.045\)/);
  assert.match(source, /this\._beatPulse \*= Math\.exp\(-dt \/ 0\.18\)/);
  assert.match(source, /this\._beatVisual, beatTarget, dt, 0\.09, 0\.24/);
  assert.match(source, /this\._beatLight, beatTarget, dt, 0\.18, 0\.46/);
  assert.match(source, /this\._uniforms\.uBeatPulse\.value = this\._beatVisual/);
  assert.match(source, /this\._uniforms\.uBeatLight\.value = this\._beatLight/);
  assert.match(source, /beatEnergyGate = tideEnergyFloor\s*\+ uBeatLight/);
  assert.doesNotMatch(source, /if \(low > 0\.34/);
  assert.match(source, /const AUDIBLE_SIGNAL_THRESHOLD = 0/);
  assert.match(source, /signalActivity > AUDIBLE_SIGNAL_THRESHOLD/);
});

test('terrain columns omit only the hidden bottom face and peak light stays controlled', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /opposite x-facing side/);
  assert.match(source, /opposite z-facing side/);
  assert.match(source, /peakBlend \* mix\(0\.34, 0\.62, 1\.0 - vSide\)/);
  assert.match(source, /float sideLight = mix\(0\.66, 0\.92, peakBlend\)/);
  assert.match(source, /lerp\(new THREE\.Color\('#ffffff'\), 0\.60\)/);
  assert.match(source, /color = color \/ \(vec3\(1\.0\) \+ color \* 0\.28\)/);
  assert.match(source, /this\.root\.rotation\.y = -0\.35/);
});

test('visual FFT bands use Mineradio Sonic frequency regions without changing beat bands', async () => {
  const source = await readFile(new URL('../src/core/AudioAnalyzer.js', import.meta.url), 'utf8');
  assert.match(source, /subBass:\s+\[32, 58\]/);
  assert.match(source, /bass:\s+\[58, 118\]/);
  assert.match(source, /lowMid:\s+\[118, 260\]/);
  assert.match(source, /mid:\s+\[260, 720\]/);
  assert.match(source, /highMid:\s+\[720, 1800\]/);
  assert.match(source, /presence:\s+\[1800, 4200\]/);
  assert.match(source, /brilliance:\s+\[4200, 9000\]/);
  assert.match(source, /air:\s+\[9000, 16000\]/);
  assert.match(source, /kick: \[52, 165\]/);
});

test('copied non-commercial visual portions retain an explicit source notice', async () => {
  const notice = await readFile(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8');
  assert.match(notice, /Sonic Topography/);
  assert.match(notice, /Non-Commercial Learning License/);
  assert.match(notice, /Mineradio/);
});

test('terrain boundary fades into a response-coloured independent mist ring', async () => {
  const source = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  assert.match(source, /sonic-boundary-mist/);
  assert.match(source, /uCoolColor: this\._uniforms\.uCoolColor/);
  assert.match(source, /uAccentColor: this\._uniforms\.uAccentColor/);
  assert.match(source, /1\.0 - smoothstep\(0\.74, 0\.985, vRadius\)/);
  assert.match(source, /this\._mistUniforms\.uEnergy\.value = clamp01\(frame\?\.energy\)/);
  assert.match(source, /this\.boundaryMist\.geometry\.dispose|this\.boundaryMist/);
});

test('terrain uses an independent scene and camera before the lyric scene', async () => {
  const terrain = await readFile(new URL('../src/visual/SonicTopographyStage.js', import.meta.url), 'utf8');
  const particle = await readFile(new URL('../src/visual/ParticleStage.js', import.meta.url), 'utf8');
  assert.match(terrain, /this\.scene = new THREE\.Scene\(\)/);
  assert.match(terrain, /this\.camera = new THREE\.PerspectiveCamera/);
  assert.match(terrain, /this\.camera\.position\.set\(0, 54, 112\)/);
  assert.match(terrain, /this\.camera\.lookAt\(0, -8, -18\)/);
  assert.doesNotMatch(terrain, /parentGroup\.add\(this\.root\)/);
  assert.match(particle, /this\._sonicStage\.render\(this\.renderer\)/);
  assert.match(particle, /this\.renderer\.clearDepth\(\)/);
  assert.ok(
    particle.indexOf('this._sonicStage.render(this.renderer)')
      < particle.indexOf('this.renderer.clearDepth()'),
  );
});
