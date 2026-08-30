import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { SonicTopographyStage } from './SonicTopographyStage.js';
import {
  clampRippleOrigin,
  selectRippleSlots,
} from './ParticleWallDynamics.js';
import * as THREE from 'three';

// ─── Mineradio 3D Simplex noise ───
const SNOSIE_GLSL = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289v(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 perm(vec4 x){return mod289v(((x*34.0)+1.0)*x);}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=inversesqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float hash11(float p){return fract(sin(p*127.1)*43758.5453123);}
`;

// ─── Vertex shader: Mineradio-style snoise wave + cover mapping ───
const PARTICLE_VS = SNOSIE_GLSL + /* glsl */`
precision highp float;
uniform float uTime, uBass, uMid, uEnergy, uBeat, uBurstAmt;
uniform float uIntensity, uDepth, uPointScale, uSpeed, uBrightMul;
uniform float uPixel, uHasCover, uColorMixT;
uniform sampler2D uCoverTex;
uniform sampler2D uRippleTex;
uniform int uRippleCount;
uniform float uPreset;
#define PI 3.14159265359
attribute float aRand;
attribute vec2 aUv;
varying vec3 vColor;
varying float vBright, vAlpha;

// ── Ripple displacement for a single particle position ──
float rippleSumAt(vec2 p, out float maxAmp) {
  float sum = 0.0; maxAmp = 0.0;
  for (int ri = 0; ri < 24; ri++) {
    if (ri >= uRippleCount) break;
    float vCoord = (float(ri) + 0.5) / 24.0;
    vec4 rd = texture2D(uRippleTex, vec2(0.5, vCoord));
    float age = rd.z; float str = rd.w;
    if (str < 0.005 || age < 0.0 || age > 2.0) continue;
    float dx = p.x - rd.x, dy = p.y - rd.y;
    float dist = sqrt(dx*dx + dy*dy);
    float lifeN = age / 2.0;
    float fadeIn  = smoothstep(0.0, 0.06, age);
    float fadeOut = 1.0 - smoothstep(0.7, 1.0, lifeN);
    float env = fadeIn * fadeOut;
    float bulgeW = 0.55 + age * 0.80;
    float bulge  = exp(-dist*dist / (2.0 * bulgeW * bulgeW)) * (1.0 - smoothstep(0.0, 0.55, lifeN));
    float waveR  = age * 2.10;
    float ringW  = 0.40 + age * 0.22;
    float ring   = exp(-pow((dist - waveR) / ringW, 2.0));
    float local  = (bulge * 2.4 + ring * 1.30) * env * str;
    sum += local;
    maxAmp = max(maxAmp, abs(local));
  }
  return sum;
}

void main(){
  float t = uTime * uSpeed;
  vec3 pos = position;

  float K = uIntensity * 2.5;

  // ── Mineradio-style drive: all bands blend for smooth organic amplitude ──
  float drive = uMid + uBass * 0.5 + uBeat * 0.3 + uEnergy * 0.2;

  float maxRippleAmp = 0.0;

  // ── Default palette (fallback for all presets) ──
  vec3 c1 = vec3(0.8, 0.38, 0.55);
  vec3 c2 = vec3(0.3, 0.58, 0.85);
  vec3 c3 = vec3(0.55, 0.3, 0.72);
  vec3 c4 = vec3(0.45, 0.62, 0.55);
  vec3 c5 = vec3(0.75, 0.55, 0.35);
  float mx = pos.x / 9.0 + 0.5;
  float my = pos.y / 9.0 + 0.5;
  float hue = fract(aRand * 3.7 + uTime * 0.015);
  vec3 colA = mix(c3, mix(c1, c2, mx), my);
  vec3 colB = mix(c5, c4, mx + my * 0.5);
  vec3 defaultColor = mix(colA, colB, 0.3 + uEnergy * 0.25 + hue * 0.1);

  // ── Preset 0: Original particle wall — snoise waves + ripple + cover mapping ──
  if (uPreset < 0.5) {
    float wave1 = snoise(vec3(pos.x * 0.65, pos.y * 0.65, t * 0.38)) * 0.55;
    float wave2 = snoise(vec3(pos.x * 0.45 + 1.7, pos.y * 0.45 - 0.8, t * 0.52)) * 0.35;
    float wave3 = sin(pos.x * 1.2 + t * 0.8) * cos(pos.y * 0.9 + t * 0.55) * 0.25;
    float wave4 = sin(pos.x * 2.5 - t * 1.1) * cos(pos.y * 2.2 + t * 0.7) * 0.15;

    float rippleZ = rippleSumAt(pos.xy, maxRippleAmp);
    pos.z += (wave1 + wave2 + wave3 + wave4) * K * drive + rippleZ * 1.30;

    if (uHasCover > 0.5) {
      vec2 uv = aUv;
      uv = clamp(uv, vec2(0.001), vec2(0.999));
      vec3 coverColor = texture2D(uCoverTex, uv).rgb;
      float lum = dot(coverColor, vec3(0.299, 0.587, 0.114));
      float keep = smoothstep(0.02, 0.10, lum);
      coverColor = coverColor * 1.4;
      vColor = mix(defaultColor, coverColor, clamp(uColorMixT, 0.0, 1.0) * (0.3 + keep * 0.7));
    } else {
      vColor = defaultColor;
    }
    vAlpha = 1.0;
  }

  // ── Preset 1: 星河 — aurora ribbons + depth stars (Mineradio WALLPAPER PULSE) ──
  else {
    float bassGlow = smoothstep(0.07, 0.78, uBass) * 0.34 + uBeat * 0.014;
    float midGlow  = smoothstep(0.07, 0.62, uMid) * 0.42;
    float highGlow = smoothstep(0.04, 0.46, uEnergy) * 0.46;
    float lane     = aUv.y;
    float transition = clamp(uBurstAmt, 0.0, 1.0);

    if (lane < 0.80) {
      float laneWarp = snoise(vec3(aUv.x * 0.42, lane * 1.7, t * 0.026)) * 0.11 + (hash11(aRand * 73.1) - 0.5) * 0.045;
      float warpedLane = clamp(lane + laneWarp, 0.0, 0.80);
      float bandCoord = warpedLane / 0.80 * 5.65 + snoise(vec3(aUv.x * 0.82, lane * 2.25, t * 0.032)) * 0.62;
      float band = floor(bandCoord);
      float local = fract(bandCoord + hash11(band * 9.13 + aRand * 2.4) * 0.18);
      float bandN = clamp((band + 0.5) / 5.65, 0.0, 1.0);
      float seed = hash11(band * 19.17 + aRand * 31.0);
      float flow = fract(aUv.x + t * (0.0034 + bandN * 0.0038 + seed * 0.0022) + seed * 0.53);
      float arc = (flow - 0.5) * PI * (1.35 + bandN * 0.72 + seed * 0.24);
      float armCurve = sin(arc + bandN * 2.2 + seed * 5.3);
      float spiralRadius = 9.2 + bandN * 11.8 + seed * 6.0 + local * 2.9;
      float ribbonPhase = flow * PI * 2.0 * (0.55 + bandN * 0.24 + seed * 0.10) + t * (0.010 + bandN * 0.007) + seed * 5.7;
      float broadWave = sin(ribbonPhase) * 0.92;
      float fineWave = sin(ribbonPhase * (1.36 + seed * 0.62) - t * 0.044 + seed * 5.0) * 0.045;
      float ridgeCenter = 0.43 + (seed - 0.5) * 0.18;
      float ridge = exp(-pow((local - ridgeCenter) / (0.25 + seed * 0.04), 2.0));
      float softMask = smoothstep(0.010, 0.12, lane) * (1.0 - smoothstep(0.72, 0.81, lane));
      float ribbonNoise = snoise(vec3(flow * 1.18 + seed, bandN * 2.0, t * 0.018)) * 0.74;
      float zLayer = mix(-23.5, 15.5, bandN) + (seed - 0.5) * 6.0;

      pos.x = cos(arc * 0.72 + bandN * 0.92 + seed * 1.3) * spiralRadius + (flow - 0.5) * (13.5 + bandN * 9.5) + ribbonNoise * 1.40 + sin(t * 0.012 + seed * 8.0) * 0.22;
      pos.y = (bandN - 0.5) * 13.2 + armCurve * (2.3 + bandN * 1.6) + (seed - 0.5) * 1.85 + snoise(vec3(bandN * 2.0, flow * 0.62, seed)) * 0.92 + broadWave + fineWave + (local - 0.5) * (0.58 + ridge * 0.14);
      pos.z = zLayer + broadWave * 1.35 + ribbonNoise * 1.85;

      float pulseLine = 0.5 + 0.5 * sin(ribbonPhase * (1.7 + seed * 0.9) - t * 0.32 + seed * 6.0);
      vec3 aurora = mix(vec3(0.52, 0.86, 1.0), vec3(0.70, 0.58, 1.0), bandN);
      aurora = mix(aurora, vec3(0.96, 0.98, 0.92), bassGlow * 0.05);
      float alpha = (0.18 + ridge * 0.78 + pulseLine * highGlow * 0.035 + bassGlow * 0.025) * softMask * (0.96 + transition * 0.02);
      vColor = mix(defaultColor, aurora, 0.62 + ridge * 0.22) * (0.76 + ridge * 0.86 + pulseLine * highGlow * 0.05 + bassGlow * 0.04);
      vAlpha = alpha;
    } else {
      float q = (lane - 0.80) / 0.20;
      float seed = hash11(aRand * 917.0 + floor(q * 130.0));
      float depth = mix(-32.0, 18.0, seed);
      float drift = fract(aUv.x + t * (0.0014 + seed * 0.0048) + seed * 0.63);
      float cluster = snoise(vec3(seed * 2.0, q * 3.2, t * 0.007));
      float sx = (drift - 0.5) * (45.0 + seed * 22.0) + cluster * 3.4;
      float sy = (hash11(aRand * 331.0 + seed * 5.0) - 0.5) * 22.0 + sin(t * (0.018 + seed * 0.028) + seed * 7.0) * 0.86;
      float sz = depth + sin(t * (0.020 + seed * 0.032) + aRand * 8.0) * 1.05;
      float twinkle = pow(0.5 + 0.5 * sin(t * (0.24 + seed * 0.42) + aRand * 17.0), 5.0);
      float dust = smoothstep(0.22, 0.98, hash11(aRand * 661.0 + floor(q * 160.0)));

      pos = vec3(sx, sy, sz);
      float alpha = dust * (0.16 + twinkle * 0.46 + highGlow * 0.025 + bassGlow * 0.018) * (1.0 - q * 0.06);
      vColor = mix(defaultColor, vec3(0.92, 0.97, 1.0), 0.62 + twinkle * 0.14) * (0.72 + twinkle * 0.62 + bassGlow * 0.025);
      vAlpha = alpha;
    }

    if (transition > 0.001) {
      float bloom = smoothstep(0.0, 1.0, transition);
      vec2 burstVec = pos.xy + vec2(hash11(aRand * 31.0) - 0.5, hash11(aRand * 47.0) - 0.5) * 0.75;
      vec2 burstDir = burstVec / max(length(burstVec), 0.001);
      pos.xy += burstDir * bloom * 0.026;
      pos.xy += vec2(snoise(vec3(aRand, t * 0.014, 1.0)), snoise(vec3(aRand, t * 0.014, 5.0))) * bloom * 0.06;
      pos.xy *= 1.0 + bloom * 0.014;
      pos.z += (hash11(aRand * 123.0) - 0.5) * bloom * 0.18;
      vAlpha *= 0.86 + bloom * 0.22;
    }

    if (uHasCover > 0.5) {
      vec2 coverUv = clamp(aUv, vec2(0.001), vec2(0.999));
      vec3 coverColor = texture2D(uCoverTex, coverUv).rgb;
      float lum = dot(coverColor, vec3(0.299, 0.587, 0.114));
      float keep = smoothstep(0.02, 0.10, lum);
      coverColor = coverColor * 1.2;
      vColor = mix(vColor, coverColor, clamp(uColorMixT, 0.0, 1.0) * 0.28 * keep);
    }
    // Tilt star field backward 17° around X axis
    float tiltA = -0.2967; // -17° in radians
    float ct = cos(tiltA), st = sin(tiltA);
    pos.yz = mat2(ct, -st, st, ct) * pos.yz;
    // Intensity drives overall scale
    pos *= 4.0;
    pos.z += 40.0;
    pos.y += 4.0;
  }

  // ── Narrow-range brightness ──
  vBright = (0.82 + uBass * 0.10 + uEnergy * 0.05) * uBrightMul;

  // ── Depth-based sizing only (no audioBoost = no flash) ──
  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  float depthSize = 36.0 / max(0.3, -mvPos.z);
  float sz = clamp(depthSize, 1.05, 6.5);
  gl_PointSize = sz * uPixel * uPointScale;
  gl_Position = projectionMatrix * mvPos;
}
`;

// ─── Fragment shaders ───
const PARTICLE_FS = /* glsl */`
precision highp float;
uniform sampler2D uDotTex; uniform float uAlpha;
varying vec3 vColor; varying float vBright, vAlpha;
void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.02) discard;
  vec3 col = vColor * vBright;
  col = clamp(col, vec3(0.0), vec3(1.9));
  gl_FragColor = vec4(col, tex.a * uAlpha * vAlpha);
}
`;

const BLOOM_FS = /* glsl */`
precision highp float;
uniform sampler2D uDotTex; uniform float uAlpha, uBloomStrength;
varying vec3 vColor; varying float vBright, vAlpha;
void main(){
  vec4 tex = texture2D(uDotTex, gl_PointCoord);
  if (tex.a < 0.01) discard;
  float soft = tex.a * tex.a;
  vec3 col = vColor * (0.6 + vBright * 0.9);
  col = clamp(col, vec3(0.0), vec3(1.9));
  gl_FragColor = vec4(col, soft * uAlpha * uBloomStrength * 0.7 * vAlpha);
}
`;

// ─── Constants ───
const PLANE_SIZE  = 28;
const GRID        = 240;         // 57,600 particles
const PCOUNT      = GRID * GRID;
const CAMERA_Z    = 36;

export class ParticleStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = this.scene = this.camera = null;
    this.particleGroup = null;
    this._bloomLayer = this._mainLayer = null;
    this._clock = new THREE.Clock();
    this._frameId = null;
    this._breathing = true;
    this._paused = false;
    this._frameCallback = null;
    this._uniforms = null;
    this._lastFPSCheck = 0;
    this._fps = 60;
    this._coverUrl = null;
    this._coverLoadToken = 0;
    this._coverFadeId = null;
    this._disposers = [];
    // ── Smooth playback energy ──
    this._playbackEnergy = 0;
    // ── Visual settings ──
    this._brightnessMultiplier = 1.0;
    this._rotationScale = 1.0;
    // ── Drag-to-rotate ──
    this._isDragging = false;
    this._dragRotY = 0;
    this._dragRotX = 0;
    this._dragLastX = 0;
    this._dragLastY = 0;
    // ── Shelf mode ──
    this._shelfActive = false;
    this._shelfTargetY = 0;
    this._shelfTargetX = 0;
    // ── Ripple system ──
    this._RIPPLE_MAX = 24;
    this._ripples = [];
    this._rippleIdx = 0;
    this._rippleData = null;
    this._rippleTex = null;
    this._lastRippleAt = 0;
    this._rippleRegions = [];
    this._sonicStage = null;
    this._visualAudioFrame = null;
    this._coverCanvas = null;
    this._init();
  }

  _init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x000000, 1);

    this.scene = new THREE.Scene();
    this.particleGroup = new THREE.Group();
    this.scene.add(this.particleGroup);

    this.camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 0, CAMERA_Z);
    this.camera.lookAt(0, 0, 0);

    this._buildDotTexture();
    this._buildParticles();

    this._onWindowResize = () => this._onResize();
    this._onUserIdle = () => this._setPixelRatio(Math.min(window.devicePixelRatio * 0.5, 1));
    this._onUserActive = () => this._setPixelRatio(Math.min(window.devicePixelRatio, 2));
    window.addEventListener('resize', this._onWindowResize);
    this._disposers.push(eventBus.on('visual:beat', (beat) => this._onBeat(beat)));
    this._disposers.push(eventBus.on('playback:started', () => this._onStarted()));
    this._disposers.push(eventBus.on('playback:changed', (pb) => {
      if (pb.song && pb.song.cover) this.loadCover(pb.song.cover);
      else if (pb.song) {
        this._clearCover();
        this._coverCanvas = null;
        this._sonicStage?.resetPalette();
      }
    }));
    this._disposers.push(eventBus.on('cover:load', (url) => {
      if (url) this.loadCover(url);
    }));
    this._disposers.push(eventBus.on('playback:finished', () => {
      this._breathing = true; this._paused = false;
      this._zeroAudioUniforms();
      this._clearCover();
      this._coverCanvas = null;
      this._sonicStage?.resetPalette();
      this._playbackEnergy = 0;
    }));
    this._disposers.push(eventBus.on('playback:paused', () => {
      this._breathing = true; this._paused = true; this._zeroAudioUniforms();
      this._playbackEnergy = 0;
    }));
    this._disposers.push(eventBus.on('user:idle', this._onUserIdle));
    this._disposers.push(eventBus.on('user:active', this._onUserActive));

    // ── Drag-to-rotate ──
    this._onDragStart = this._onDragStart.bind(this);
    this._onDragMove = this._onDragMove.bind(this);
    this._onDragEnd = this._onDragEnd.bind(this);
    this.canvas.addEventListener('mousedown', this._onDragStart, { passive: false });
    this.canvas.addEventListener('touchstart', this._onDragStart, { passive: false });
    window.addEventListener('mousemove', this._onDragMove, { passive: false });
    window.addEventListener('touchmove', this._onDragMove, { passive: false });
    window.addEventListener('mouseup', this._onDragEnd);
    window.addEventListener('touchend', this._onDragEnd);
    window.addEventListener('touchcancel', this._onDragEnd);
  }

  _buildDotTexture() {
    const s = 128, cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.6, 'rgba(255,255,255,1)');
    g.addColorStop(0.78, 'rgba(255,255,255,0.85)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    this._dotTex = new THREE.CanvasTexture(cv);
    this._dotTex.minFilter = THREE.NearestFilter; this._dotTex.magFilter = THREE.NearestFilter;
  }

  _buildParticles() {
    const positions = new Float32Array(PCOUNT * 3);
    const rands = new Float32Array(PCOUNT);
    const uvs = new Float32Array(PCOUNT * 2);
    const half = PLANE_SIZE / 2;
    const step = PLANE_SIZE / (GRID - 1);

    for (let i = 0; i < PCOUNT; i++) {
      const gx = i % GRID, gy = Math.floor(i / GRID), i3 = i * 3;
      positions[i3]     = gx * step - half;
      positions[i3 + 1] = gy * step - half;
      positions[i3 + 2] = 0;
      rands[i] = Math.random();
      uvs[i * 2]     = gx / (GRID - 1);
      uvs[i * 2 + 1] = gy / (GRID - 1);
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));
    geom.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));

    const coverPlaceholder = document.createElement('canvas');
    coverPlaceholder.width = 2; coverPlaceholder.height = 2;
    const coverTex = new THREE.CanvasTexture(coverPlaceholder);
    coverTex.minFilter = THREE.LinearFilter; coverTex.magFilter = THREE.LinearFilter;
    this._coverTex = coverTex;

    // ── Ripple DataTexture: 24 ripples × (x, y, age, strength) ──
    const RIPPLE_MAX = 24;
    this._rippleData = new Float32Array(RIPPLE_MAX * 4);
    this._rippleTex = new THREE.DataTexture(
      this._rippleData, 1, RIPPLE_MAX, THREE.RGBAFormat, THREE.FloatType
    );
    this._rippleTex.magFilter = THREE.NearestFilter;
    this._rippleTex.minFilter = THREE.NearestFilter;
    for (let ri = 0; ri < RIPPLE_MAX; ri++) {
      this._ripples.push({ x: 0, y: 0, age: -10, str: 0 });
    }

    this._preset = 0;  // 0=粒子墙, 1=星河, 2=音域回响
    for (let ry = 0; ry < 3; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        this._rippleRegions.push({
          x: (rx / 4 - 0.5) * PLANE_SIZE * 0.88,
          y: (ry / 2 - 0.5) * PLANE_SIZE * 0.82,
        });
      }
    }

    this._uniforms = {
      uDotTex:       { value: this._dotTex },
      uCoverTex:     { value: coverTex },
      uRippleTex:    { value: this._rippleTex },
      uRippleCount:  { value: 0 },
      uTime:         { value: 0 },
      uBass:         { value: 0 },
      uMid:          { value: 0 },
      uEnergy:       { value: 0 },
      uBeat:         { value: 0 },
      uBurstAmt:     { value: 0 },
      uHasCover:     { value: 0 },
      uColorMixT:    { value: 0 },
      uIntensity:    { value: 1.2 },
      uDepth:        { value: 1.0 },
      uPointScale:   { value: 2.2 },
      uSpeed:        { value: 0.95 },
      uPixel:        { value: this.renderer.getPixelRatio() },
      uAlpha:        { value: 0.95 },
      uBloomStrength:{ value: 0.55 },
      uBrightMul:    { value: 1.0 },
      uPreset:       { value: 0 },
    };

    // Bloom layer
    const bloomMat = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: PARTICLE_VS.replace(
        'gl_PointSize = sz * uPixel * uPointScale;',
        'gl_PointSize = sz * uPixel * uPointScale * 1.2;'
      ),
      fragmentShader: BLOOM_FS,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    });
    this._bloomLayer = new THREE.Points(geom, bloomMat);
    this._bloomLayer.frustumCulled = false;
    this._bloomLayer.renderOrder = 0;
    this.particleGroup.add(this._bloomLayer);

    // Main layer
    const mainMat = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._mainLayer = new THREE.Points(geom.clone(), mainMat);
    this._mainLayer.frustumCulled = false;
    this._mainLayer.renderOrder = 1;
    this.particleGroup.add(this._mainLayer);
  }

  onFrame(fn) { this._frameCallback = fn; }

  start() { this._clock.start(); this._animate(); }

  _animate() {
    this._frameId = requestAnimationFrame(() => this._animate());
    const dt = Math.min(this._clock.getDelta(), 0.1);
    const elapsed = this._clock.elapsedTime;

    if (elapsed - this._lastFPSCheck > 2) {
      this._fps = Math.round(1 / Math.max(dt, 0.001));
      this._lastFPSCheck = elapsed;
    }
    if (this._frameCallback) this._frameCallback(dt);

    // ── Slow decays (Mineradio-style: smooth, never jarring) ──
    this._uniforms.uBeat.value     *= Math.exp(-2.5 * dt);
    this._uniforms.uBurstAmt.value *= Math.exp(-1.0 * dt);
    this._uniforms.uBass.value     *= Math.exp(-0.5 * dt);
    this._uniforms.uMid.value      *= Math.exp(-0.5 * dt);
    this._uniforms.uEnergy.value   *= Math.exp(-0.8 * dt);

    // ── Smooth playback energy: reacts to beats but never spikes ──
    // Target: 0 (idle) → ~0.8 (playing with beat energy)
    const energyTarget = this._breathing ? 0 : this._playbackEnergy;
    this._playbackEnergy += (energyTarget - this._playbackEnergy) * Math.min(dt * 4.5, 1);

    // ── Breathing baseline: Mineradio-style multi-layer idle wave ──
    if (this._breathing) {
      if (this._paused) {
        this._uniforms.uBass.value   = Math.max(this._uniforms.uBass.value,   0.08 + Math.sin(elapsed * 0.35) * 0.05 + Math.sin(elapsed * 0.62) * 0.04);
        this._uniforms.uMid.value    = Math.max(this._uniforms.uMid.value,    0.10 + Math.sin(elapsed * 0.40) * 0.06 + Math.sin(elapsed * 0.68) * 0.05 + Math.cos(elapsed * 0.85) * 0.04);
        this._uniforms.uEnergy.value = Math.max(this._uniforms.uEnergy.value, 0.04 + Math.sin(elapsed * 0.48) * 0.03);
      } else {
        // Rich idle breathing — multi-frequency oscillation
        this._uniforms.uBass.value   = Math.max(this._uniforms.uBass.value,   0.14 + Math.sin(elapsed * 0.38) * 0.08 + Math.sin(elapsed * 0.67) * 0.06);
        this._uniforms.uMid.value    = Math.max(this._uniforms.uMid.value,    0.16 + Math.sin(elapsed * 0.42) * 0.10 + Math.sin(elapsed * 0.70) * 0.08 + Math.cos(elapsed * 0.88) * 0.05);
        this._uniforms.uEnergy.value = Math.max(this._uniforms.uEnergy.value, 0.06 + Math.sin(elapsed * 0.52) * 0.04);
      }
    } else {
      // Playing floors share the same real/analyzed frame as Sonic terrain.
      // No independent sine beat remains once the offline grid is available.
      const frame = this._visualAudioFrame;
      const bass = Math.max(0, Math.min(1, Number(frame?.bass) || 0));
      const subBass = Math.max(0, Math.min(1, Number(frame?.subBass) || 0));
      const mid = Math.max(0, Math.min(1, Number(frame?.mid) || 0));
      const lowMid = Math.max(0, Math.min(1, Number(frame?.lowMid) || 0));
      const energy = Math.max(0, Math.min(1, Number(frame?.energy) || 0));
      this._playbackEnergy = Math.max(this._playbackEnergy, energy * 0.82);
      this._uniforms.uBass.value = Math.max(
        this._uniforms.uBass.value, 0.045 + bass * 0.56 + subBass * 0.24
      );
      this._uniforms.uMid.value = Math.max(
        this._uniforms.uMid.value, 0.050 + mid * 0.48 + lowMid * 0.24
      );
      this._uniforms.uEnergy.value = Math.max(
        this._uniforms.uEnergy.value, 0.025 + energy * 0.48
      );
    }

    this._uniforms.uTime.value = elapsed;

    // ── Rotation: shelf mode, drag, or auto-oscillation ──
    if (this._shelfActive) {
      // Lerp wall toward shelf target
      const sl = 1 - Math.exp(-3.5 * dt);
      this.particleGroup.rotation.y += (this._shelfTargetY - this.particleGroup.rotation.y) * sl;
      this.particleGroup.rotation.x += (this._shelfTargetX - this.particleGroup.rotation.x) * sl;

      // Camera facing cards directly — positioned at (8, 0, 16) looking at (8, 0, 4)
      const tcX = 8.0, tcY = 0, tcZ = 4.0;   // center of cards
      const cpZ_target = 16.0;                  // camera distance from wall
      const zl = 1 - Math.exp(-2.5 * dt);
      this.camera.position.x += (tcX - this.camera.position.x) * zl;
      this.camera.position.y += (tcY - this.camera.position.y) * zl;
      this.camera.position.z += (cpZ_target - this.camera.position.z) * zl;
      this.camera.lookAt(tcX, tcY, tcZ);

      this._dragRotY *= Math.exp(-0.6 * dt);
      this._dragRotX *= Math.exp(-0.6 * dt);
    } else {
      // Auto-oscillation (suppressed during drag)
      const autoY = this._isDragging ? 0 : Math.sin(elapsed * 0.12) * 0.30 * this._rotationScale;
      const autoX = this._isDragging ? 0 : Math.sin(elapsed * 0.09 + 1.2) * 0.12 * this._rotationScale;

      // Drag spring-back
      if (!this._isDragging) {
        const springRate = 0.55;
        const decay = Math.exp(-springRate * dt);
        this._dragRotY *= decay;
        this._dragRotX *= decay;
        if (Math.abs(this._dragRotY) < 0.0005) this._dragRotY = 0;
        if (Math.abs(this._dragRotX) < 0.0005) this._dragRotX = 0;
      }

      this.particleGroup.rotation.y = autoY + this._dragRotY;
      this.particleGroup.rotation.x = autoX + this._dragRotX;
    }

    // ── Update active visual only ──
    if (this._preset === 2) {
      this._sonicStage?.update(dt, elapsed, this._visualAudioFrame);
    } else {
      this._updateRipples(dt, elapsed);
    }

    if (this._preset === 2 && this._sonicStage) {
      const previousAutoClear = this.renderer.autoClear;
      this.renderer.autoClear = false;
      this.renderer.clear(true, true, true);
      this._sonicStage.render(this.renderer);
      this.renderer.clearDepth();
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = previousAutoClear;
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  // ── Ripple system ──

  /** Trigger a ripple at world XY coordinates on the particle plane. */
  triggerRipple(x, y, strength) {
    // Find the oldest (most expired) ripple to overwrite — never kill young ones
    let bestIdx = this._rippleIdx;
    let bestAge = -1;
    for (let i = 0; i < this._RIPPLE_MAX; i++) {
      const r = this._ripples[i];
      // Prefer replacing dead or nearly-expired ripples first
      if (r.str < 0.005 || r.age < 0) { bestIdx = i; break; }
      // Otherwise find the oldest one (most expendable)
      if (r.age > bestAge) { bestAge = r.age; bestIdx = i; }
    }
    const r = this._ripples[bestIdx];
    const origin = clampRippleOrigin(x, y, PLANE_SIZE);
    r.x = origin.x; r.y = origin.y; r.age = 0; r.str = strength;
    this._rippleIdx = (bestIdx + 1) % this._RIPPLE_MAX;
  }

  _updateRipples(dt, elapsed) {
    // ── Bass-driven auto-ripple ──
    const bass = this._uniforms.uBass.value;
    const bassThresh = 0.25;
    const cooldown = 0.45; // seconds — slower to avoid flooding the pool
    const now = elapsed || this._uniforms.uTime.value;
    if (bass > bassThresh && (now - this._lastRippleAt) > cooldown) {
      this._lastRippleAt = now;
      const count = 1 + Math.floor(Math.random() * 2); // 1-2
      const used = {};
      for (let k = 0; k < count; k++) {
        let idx, tries = 0;
        do { idx = Math.floor(Math.random() * this._rippleRegions.length); tries++; }
        while (used[idx] && tries < 12);
        used[idx] = true;
        const reg = this._rippleRegions[idx];
        const jx = reg.x + (Math.random() - 0.5) * PLANE_SIZE * 0.70;
        const jy = reg.y + (Math.random() - 0.5) * PLANE_SIZE * 0.55;
        const str = 0.50 + bass * 1.3 + Math.random() * 0.30;
        this.triggerRipple(jx, jy, str);
      }
    }

    // Age each ripple, then compact active slots before upload. The shader
    // reads a contiguous prefix; holes used to make later ripples disappear.
    for (let i = 0; i < this._RIPPLE_MAX; i++) {
      const r = this._ripples[i];
      if (r.str > 0.005) {
        r.age += dt;
        if (r.age > 2.0) { r.str = 0; r.age = -10; }
      }
    }
    const activeRipples = selectRippleSlots(this._ripples, this._RIPPLE_MAX);
    for (let i = 0; i < this._RIPPLE_MAX; i++) {
      const r = activeRipples[i];
      const off = i * 4;
      this._rippleData[off]     = r?.x ?? 0;
      this._rippleData[off + 1] = r?.y ?? 0;
      this._rippleData[off + 2] = r?.age ?? -10;
      this._rippleData[off + 3] = r?.str ?? 0;
    }
    this._rippleTex.needsUpdate = true;
    this._uniforms.uRippleCount.value = activeRipples.length;
  }

  _onBeat(beat) {
    // ── Use real-time beat data when available; fall back to grid intensity ──
    const I = beat.strength || beat.intensity || 0.5;
    // Spectral bands from real-time analysis (normalized 0-1)
    const lowBand  = beat.low  != null ? beat.low  : I * 0.8;
    const bodyBand = beat.body != null ? beat.body : I * 0.5;
    const snapBand = beat.snap != null ? beat.snap : I * 0.3;
    const mass     = beat.mass != null ? beat.mass : I * 0.7;
    this._sonicStage?.onBeat(beat);

    // ── Smooth beat push: gently nudge uniforms, never spike ──
    // Real-time beats carry per-band energy; grid fallback scales from intensity
    switch (beat.type) {
      case 'downbeat':
        this._uniforms.uBeat.value     = Math.min(this._uniforms.uBeat.value + I * 0.38, 1.1);
        this._uniforms.uBurstAmt.value = Math.min(this._uniforms.uBurstAmt.value + mass * 0.42, 1.0);
        this._uniforms.uBass.value     = Math.min(this._uniforms.uBass.value + lowBand * 0.28, 1.0);
        this._uniforms.uMid.value      = Math.min(this._uniforms.uMid.value + bodyBand * 0.22, 1.0);
        this._uniforms.uEnergy.value   = Math.min(this._uniforms.uEnergy.value + lowBand * 0.24, 0.8);
        this._playbackEnergy = Math.min(this._playbackEnergy + I * 0.18, 0.9);
        // Ripple burst on downbeat — wide scatter across the wall
        for (let k = 0; k < 3; k++) {
          const reg = this._rippleRegions[Math.floor(Math.random() * this._rippleRegions.length)];
          this.triggerRipple(
            reg.x + (Math.random() - 0.5) * PLANE_SIZE * 0.75,
            reg.y + (Math.random() - 0.5) * PLANE_SIZE * 0.60,
            0.50 + I * 1.0 + Math.random() * 0.25
          );
        }
        break;
      case 'drop':
        this._uniforms.uBurstAmt.value = Math.min(this._uniforms.uBurstAmt.value + mass * 0.38, 1.0);
        this._uniforms.uEnergy.value   = Math.min(this._uniforms.uEnergy.value + lowBand * 0.28, 0.8);
        this._uniforms.uBass.value     = Math.min(this._uniforms.uBass.value + lowBand * 0.25, 1.0);
        this._uniforms.uMid.value      = Math.min(this._uniforms.uMid.value + bodyBand * 0.20, 0.9);
        this._playbackEnergy = Math.min(this._playbackEnergy + I * 0.14, 0.85);
        // Ripple burst on drop — wider rings
        for (let k = 0; k < 2; k++) {
          const reg = this._rippleRegions[Math.floor(Math.random() * this._rippleRegions.length)];
          this.triggerRipple(
            reg.x + (Math.random() - 0.5) * PLANE_SIZE * 0.65,
            reg.y + (Math.random() - 0.5) * PLANE_SIZE * 0.50,
            0.40 + I * 0.85 + Math.random() * 0.20
          );
        }
        break;
      case 'accent':
        this._uniforms.uBurstAmt.value = Math.min(this._uniforms.uBurstAmt.value + snapBand * 0.48, 1.0);
        this._uniforms.uEnergy.value   = Math.min(this._uniforms.uEnergy.value + snapBand * 0.32, 0.85);
        this._uniforms.uMid.value      = Math.min(this._uniforms.uMid.value + bodyBand * 0.24, 0.9);
        this._playbackEnergy = Math.min(this._playbackEnergy + I * 0.10, 0.8);
        // Single sharp ripple on accent — random position
        {
          const reg = this._rippleRegions[Math.floor(Math.random() * this._rippleRegions.length)];
          this.triggerRipple(
            reg.x + (Math.random() - 0.5) * PLANE_SIZE * 0.55,
            reg.y + (Math.random() - 0.5) * PLANE_SIZE * 0.45,
            0.50 + snapBand * 1.2
          );
        }
        break;
      case 'rebound':
        this._uniforms.uBeat.value     = Math.min(this._uniforms.uBeat.value + I * 0.20, 0.7);
        this._uniforms.uMid.value      = Math.min(this._uniforms.uMid.value + bodyBand * 0.22, 0.8);
        this._uniforms.uBass.value     = Math.min(this._uniforms.uBass.value + lowBand * 0.14, 0.7);
        this._playbackEnergy = Math.min(this._playbackEnergy + I * 0.06, 0.7);
        break;
      case 'pulse':
      case 'push':
        this._uniforms.uBeat.value     = Math.min(this._uniforms.uBeat.value + I * 0.12, 0.5);
        this._uniforms.uMid.value      = Math.min(this._uniforms.uMid.value + bodyBand * 0.14, 0.6);
        this._playbackEnergy = Math.min(this._playbackEnergy + I * 0.04, 0.6);
        break;
      default: break;
    }
  }

  _onStarted() {
    this._breathing = false;
    this._paused = false;
    // Gentle entry push
    this._uniforms.uBurstAmt.value = 0.4;
    this._uniforms.uBeat.value     = 0.3;
    this._uniforms.uEnergy.value   = 0.25;
    this._playbackEnergy = 0.4;
  }

  _zeroAudioUniforms() {
    this._uniforms.uBeat.value = 0;
    this._uniforms.uBurstAmt.value = 0;
    this._uniforms.uBass.value = 0;
    this._uniforms.uMid.value = 0;
    this._uniforms.uEnergy.value = 0;
  }

  /** Load album cover onto particle grid. */
  loadCover(url) {
    if (!url || url === this._coverUrl) return;
    this._coverUrl = url;
    const token = ++this._coverLoadToken;
    const finalUrl = resolveCoverUrl(url);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (token !== this._coverLoadToken || url !== this._coverUrl) return;
      const maxDim = 512;
      let w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      this._applyCoverTex(cv);
    };
    img.onerror = () => {
      if (token !== this._coverLoadToken) return;
      this._coverUrl = null;
      console.warn('[ParticleStage] Cover load failed:', url);
    };
    img.src = finalUrl;
  }

  _applyCoverTex(cv) {
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const previousTexture = this._uniforms.uCoverTex.value;
    this._uniforms.uCoverTex.value = tex;
    this._coverTex = tex;
    if (previousTexture && previousTexture !== tex) previousTexture.dispose();
    this._uniforms.uHasCover.value = 1;
    this._coverCanvas = cv;
    this._sonicStage?.setPaletteFromCanvas(cv);
    this._uniforms.uColorMixT.value = 0;
    if (this._coverFadeId != null) cancelAnimationFrame(this._coverFadeId);
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / 1200);
      const ease = 1 - Math.pow(1 - t, 2);
      this._uniforms.uColorMixT.value = ease;
      if (t < 1) this._coverFadeId = requestAnimationFrame(tick);
      else this._coverFadeId = null;
    };
    tick();
  }

  _clearCover() {
    this._coverLoadToken++;
    this._coverUrl = null;
    if (this._coverFadeId != null) cancelAnimationFrame(this._coverFadeId);
    this._coverFadeId = null;
    if (this._uniforms) {
      this._uniforms.uHasCover.value = 0;
      this._uniforms.uColorMixT.value = 0;
    }
  }

  // ── Drag-to-rotate handlers ──

  _getPointerPos(e) {
    if (e.touches && e.touches.length) return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    return { x: e.clientX, y: e.clientY };
  }

  _onDragStart(e) {
    // Ignore drags starting on UI controls
    if (e.target.closest('#player-bar, #search-overlay, #queue-panel, #shelf-3d, #cookie-overlay, #toast-container, button, input')) return;
    e.preventDefault();
    this._isDragging = true;
    const pos = this._getPointerPos(e);
    this._dragLastX = pos.x;
    this._dragLastY = pos.y;
    this.canvas.style.cursor = 'grabbing';
  }

  _onDragMove(e) {
    if (!this._isDragging) return;
    e.preventDefault();
    const pos = this._getPointerPos(e);
    const dx = pos.x - this._dragLastX;
    const dy = pos.y - this._dragLastY;
    this._dragLastX = pos.x;
    this._dragLastY = pos.y;

    // Sensitivity: normalize to screen height for consistent feel across devices
    const sensitivity = 2.5;
    const norm = sensitivity / Math.max(window.innerHeight, 1);
    this._dragRotY += dx * norm;
    this._dragRotX += dy * norm;
  }

  _onDragEnd() {
    if (!this._isDragging) return;
    this._isDragging = false;
    this.canvas.style.cursor = 'grab';
    // Drag offset will spring-back naturally via _animate decay
  }

  _onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this._uniforms.uPixel.value = this.renderer.getPixelRatio();
    this._sonicStage?.resize(window.innerWidth, window.innerHeight);
  }

  _setPixelRatio(value) {
    this.renderer.setPixelRatio(value);
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    if (this._uniforms) this._uniforms.uPixel.value = this.renderer.getPixelRatio();
  }

  // ── Visual settings hooks ──
  setUniform(key, value) {
    if (this._uniforms[key]) this._uniforms[key].value = value;
    if (key === 'uIntensity') this._sonicStage?.setAmplitude(value);
  }

  setBrightness(value) {
    this._brightnessMultiplier = value;
    this._uniforms.uBrightMul.value = value;
    this._sonicStage?.setBrightness(value);
  }

  setRotationScale(value) {
    this._rotationScale = value;
  }

  /** Switch visual preset: 0=粒子墙, 1=星河, 2=音域回响. */
  setPreset(index) {
    const idx = Math.max(0, Math.min(2, index | 0));
    if (idx === this._preset) return;
    if (idx === 2) this._ensureSonicStage();
    this._preset = idx;
    this._uniforms.uPreset.value = Math.min(idx, 1);
    const particlesVisible = idx !== 2;
    this._mainLayer.visible = particlesVisible;
    this._bloomLayer.visible = particlesVisible;
    this._sonicStage?.setVisible(idx === 2);
    // Restore each particle preset's original point size on round trips.
    if (idx === 0) this._uniforms.uPointScale.value = 2.2;
    else if (idx === 1) this._uniforms.uPointScale.value = 1.2;
    console.log('[ParticleStage] Preset switched to:', ['粒子墙', '星河', '音域回响'][idx]);
  }

  _ensureSonicStage() {
    if (this._sonicStage) return this._sonicStage;
    this._sonicStage = new SonicTopographyStage(this.renderer);
    this._sonicStage.setAmplitude(this._uniforms.uIntensity.value);
    this._sonicStage.setBrightness(this._brightnessMultiplier);
    if (this._coverCanvas) this._sonicStage.setPaletteFromCanvas(this._coverCanvas);
    return this._sonicStage;
  }

  /** Supply the immutable frame produced by VisualAudioFrameAdapter. */
  setVisualAudioFrame(frame) {
    this._visualAudioFrame = frame || null;
  }

  /** Toggle background video — when on, renderer clears with alpha 0. */
  setBgVideo(on) {
    this.renderer.setClearColor(0x000000, on ? 0 : 1);
  }

  /** Get current preset index. */
  getPreset() { return this._preset; }

  /** Enter shelf-select mode: wall rotates left + camera faces cards head-on. */
  enterShelfMode() {
    this._shelfActive = true;
    this._shelfTargetY = -0.5934;  // -34°
    this._shelfTargetX = 0;
    // Ripple burst at shelf open — anchored near the card area (right side)
    for (let k = 0; k < 5; k++) {
      this.triggerRipple(
        6.0 + (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 8.0,
        0.45 + Math.random() * 0.40
      );
    }
  }

  /** Exit shelf mode: wall springs back, camera returns to orbit baseline. */
  exitShelfMode() {
    const elapsed = this._clock.elapsedTime;
    const autoY = Math.sin(elapsed * 0.12) * 0.30 * this._rotationScale;
    const autoX = Math.sin(elapsed * 0.09 + 1.2) * 0.12 * this._rotationScale;
    this._dragRotY = this.particleGroup.rotation.y - autoY;
    this._dragRotX = this.particleGroup.rotation.x - autoX;
    this._shelfActive = false;
    // Ripple burst at shelf close — same card area
    for (let k = 0; k < 4; k++) {
      this.triggerRipple(
        6.0 + (Math.random() - 0.5) * 4.0,
        (Math.random() - 0.5) * 8.0,
        0.38 + Math.random() * 0.35
      );
    }
  }

  destroy() {
    cancelAnimationFrame(this._frameId);
    if (this._coverFadeId != null) cancelAnimationFrame(this._coverFadeId);
    window.removeEventListener('resize', this._onWindowResize);
    this.canvas.removeEventListener('mousedown', this._onDragStart);
    this.canvas.removeEventListener('touchstart', this._onDragStart);
    window.removeEventListener('mousemove', this._onDragMove);
    window.removeEventListener('touchmove', this._onDragMove);
    window.removeEventListener('mouseup', this._onDragEnd);
    window.removeEventListener('touchend', this._onDragEnd);
    window.removeEventListener('touchcancel', this._onDragEnd);
    this._disposers.splice(0).forEach(dispose => dispose());
    [this._bloomLayer, this._mainLayer].forEach(layer => {
      if (layer) { layer.geometry.dispose(); layer.material.dispose(); }
    });
    this._dotTex.dispose();
    this._coverTex?.dispose();
    this._rippleTex?.dispose();
    this._sonicStage?.dispose();
    this._sonicStage = null;
    this.renderer.dispose();
    this.scene.clear();
  }
}
