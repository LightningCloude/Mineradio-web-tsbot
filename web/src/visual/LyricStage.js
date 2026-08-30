import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { lyricColorManager } from '../shared/LyricColorManager.js';
import { getLyricLineProgress } from '../shared/LyricTiming.js';
import {
  LYRIC_DISPLAY_MODES,
  lyricTranslationManager,
} from '../shared/LyricTranslationManager.js';
import * as THREE from 'three';

const STAGE_W = 22.0;
const SUN_W = STAGE_W * 1.3;
const SUN_H = STAGE_W * 0.4;
const GLOW_W = STAGE_W * 1.1;

function lighten(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return '#' + [
    Math.min(255, r + Math.round((255 - r) * amount)),
    Math.min(255, g + Math.round((255 - g) * amount)),
    Math.min(255, b + Math.round((255 - b) * amount)),
  ].map(v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Karaoke text shader — GPU-side left-to-right progress reveal.
 * Full bright text is drawn to a canvas once, then this shader mixes
 * between dim (unfilled) and bright (filled) based on uProgress.
 */
const KARAOKE_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const KARAOKE_FS = /* glsl */`
  precision highp float;
  uniform sampler2D uMap;
  uniform float uProgress;
  uniform float uFeather;
  uniform float uTextMin;   // left edge of text in UV space
  uniform float uTextMax;   // right edge of text in UV space
  uniform float uOpacity;
  uniform vec3 uDimColor;   // base (unfilled) tint
  uniform vec3 uBrightColor;// highlight (filled) tint
  uniform float uDimAlpha;
  varying vec2 vUv;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    if (tex.a < 0.01) discard;

    // Where are we horizontally within the text?
    float p = clamp((vUv.x - uTextMin) / max(0.001, uTextMax - uTextMin), 0.0, 1.0);

    // Smooth step at progress boundary
    float filled = 1.0 - smoothstep(uProgress, uProgress + uFeather, p);

    // Dim base → bright highlight
    vec3 color = mix(uDimColor * uDimAlpha, uBrightColor, filled);

    // Subtle glow line at the progress edge
    float edge = 1.0 - smoothstep(0.0, uFeather * 2.0, abs(p - uProgress));
    color += uBrightColor * edge * 0.12;

    gl_FragColor = vec4(color, tex.a * uOpacity);
  }
`;

export class LyricStage {
  constructor(scene, camera) {
    this._scene = scene;
    this._camera = camera;
    this._lines = [];
    this._currentIndex = -1;
    this._beatGlow = 0;
    this._beatGlowTarget = 0;
    this._pendingBeatGlow = 0;
    this._currentGroup = null;
    this._sunTex = null;
    this._ready = false;

    // Karaoke progress — GPU-driven, just update uniform
    this._lineProgress = 0;
    this._karaokeMat = null;  // reference to active karaoke material
    this._translationKaraokeMat = null;

    this._init();
  }

  _init() {
    this._sunTex = this._buildSunTex();
    this._ready = true;

    eventBus.on('lyrics:loaded', ({ lines }) => this.setLyrics(lines));
    eventBus.on('lyrics:progress', ({ index, line }) => this.highlightLine(index, line));
    eventBus.on('playback:finished', () => this.clear());
    eventBus.on('lyric:colorChanged', () => {
      if (this._sunTex) this._sunTex.dispose();
      this._sunTex = this._buildSunTex();
      this._rebuildCurrentLine();
    });
    eventBus.on('lyric:translationChanged', () => this._rebuildCurrentLine());
    eventBus.on('visual:beat', (beat) => this._onBeat(beat));
  }

  _rebuildCurrentLine() {
    const index = this._currentIndex;
    const line = index >= 0 ? this._lines[index] : null;
    if (!line?.text && !line?.translation) return;
    this._clearGroup();
    this._currentIndex = -1;
    this.highlightLine(index, line);
  }

  _onBeat(beat) {
    const I = beat.strength || beat.intensity || 0.5;
    let impulse = 0;
    switch (beat.type) {
      case 'downbeat': impulse = I; break;
      case 'drop':     impulse = I * 0.82; break;
      case 'accent':   impulse = I * 0.90; break;
      case 'rebound':  impulse = I * 0.60; break;
      default:         impulse = I * 0.35; break;
    }
    this._pendingBeatGlow = Math.min(1, Math.max(this._pendingBeatGlow, impulse));
  }

  _buildSunTex() {
    const s = 256, cv = document.createElement('canvas');
    cv.width = s; cv.height = s;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s*0.43);
    const pal = lyricColorManager.palette;
    g.addColorStop(0.00, pal.sunBloom);
    g.addColorStop(0.18, pal.glow);
    g.addColorStop(0.46, 'rgba(120,160,210,0.12)');
    g.addColorStop(1.00, 'rgba(100,140,190,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
    return t;
  }


  /**
   * Draw full bright text to canvas ONCE.
   * Karaoke progress is done GPU-side via ShaderMaterial.
   * Returns { tex, worldW, worldH, textMinUv, textMaxUv }
   */
  _buildTextTex(text) {
    const W = 4096, H = 1024;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let fs = 400;
    for (; fs >= 100; fs -= 10) {
      ctx.font = `bold ${fs}px "PingFang SC","Microsoft YaHei","SimHei","Noto Sans SC",sans-serif`;
      if (ctx.measureText(text).width <= W - 320) break;
    }

    const cx = W / 2, cy = H / 2;
    const pal = lyricColorManager.palette;

    // Measure text bounds in UV space (0-1 across canvas)
    const metrics = ctx.measureText(text);
    const textPixelW = metrics.width;
    const textLeftPx = cx - textPixelW / 2;
    const textMinUv = textLeftPx / W;
    const textMaxUv = (textLeftPx + textPixelW) / W;

    // Draw bright text with full glow — no dimming, GPU handles that
    const grad = ctx.createLinearGradient(cx, cy - fs * 0.6, cx, cy + fs * 0.6);
    grad.addColorStop(0, pal.textGradTop);
    grad.addColorStop(0.5, pal.textGradBottom);
    grad.addColorStop(1, lighten(pal.base, 0.85));
    ctx.fillStyle = grad;
    ctx.shadowColor = pal.glow;
    ctx.shadowBlur = 32;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(text, cx, cy);
    ctx.shadowColor = pal.glowShadow;
    ctx.shadowBlur = 60;
    ctx.fillText(text, cx, cy);

    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = true;

    const w = STAGE_W;
    const h = w * (H / W);
    return { tex, worldW: w, worldH: h, textMinUv, textMaxUv };
  }

  _buildTranslationTex(text) {
    const W = 4096, H = 512;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    let fs = 250;
    for (; fs >= 84; fs -= 8) {
      ctx.font = `bold ${fs}px "PingFang SC","Microsoft YaHei","SimHei","Noto Sans SC",sans-serif`;
      if (ctx.measureText(text).width <= W - 360) break;
    }

    const cx = W / 2, cy = H / 2;
    const pal = lyricColorManager.palette;

    const grad = ctx.createLinearGradient(cx, cy - fs * 0.6, cx, cy + fs * 0.6);
    grad.addColorStop(0, pal.textGradTop);
    grad.addColorStop(0.5, pal.textGradBottom);
    grad.addColorStop(1, lighten(pal.base, 0.85));
    ctx.fillStyle = grad;
    ctx.shadowColor = pal.glow;
    ctx.shadowBlur = 32;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.fillText(text, cx, cy);
    ctx.shadowColor = pal.glowShadow;
    ctx.shadowBlur = 60;
    ctx.fillText(text, cx, cy);

    const metrics = ctx.measureText(text);
    const textMinUv = (cx - metrics.width / 2) / W;
    const textMaxUv = (cx + metrics.width / 2) / W;

    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.premultiplyAlpha = true;
    const worldW = STAGE_W * 0.84;
    return {
      tex,
      worldW,
      worldH: worldW * (H / W),
      textMinUv,
      textMaxUv,
    };
  }

  /** Build complete 3D group for one lyric line */
  _buildGroup(text, translation, active) {
    const { tex, worldW, worldH, textMinUv, textMaxUv } = this._buildTextTex(text);
    const group = new THREE.Group();

    // 1. Sun bloom
    const sunG = new THREE.PlaneGeometry(SUN_W, SUN_H);
    const sunM = new THREE.MeshBasicMaterial({
      map: this._sunTex, transparent: true,
      opacity: active ? 0.48 : 0.10, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const sun = new THREE.Mesh(sunG, sunM);
    sun.renderOrder = 96; sun.position.z = -0.05;
    group.add(sun);

    // 2. Glow halo
    const glowG = new THREE.PlaneGeometry(GLOW_W, worldH * 1.2);
    const glowM = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      opacity: active ? 0.22 : 0.04,
      color: new THREE.Color(active ? lighten(lyricColorManager.color, 0.6) : '#556688'),
    });
    const glow = new THREE.Mesh(glowG, glowM);
    glow.renderOrder = 97; glow.position.z = -0.02;
    group.add(glow);

    // 3. Karaoke text — GPU shader progress
    const txtG = new THREE.PlaneGeometry(worldW, worldH);
    const pal = lyricColorManager.palette;
    const dimColor = new THREE.Color(lighten(pal.base, 0.45));
    const brightColor = new THREE.Color('#ffffff');
    const feather = Math.max(0.008, 0.025 * (4096 / 4096)); // ~2% of text width

    const txtM = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex },
        uProgress: { value: 0 },
        uFeather: { value: feather },
        uTextMin: { value: textMinUv },
        uTextMax: { value: textMaxUv },
        uOpacity: { value: active ? 0.95 : 0.45 },
        uDimColor: { value: dimColor },
        uBrightColor: { value: brightColor },
        uDimAlpha: { value: 0.55 },
      },
      vertexShader: KARAOKE_VS,
      fragmentShader: KARAOKE_FS,
      transparent: true, depthWrite: false, depthTest: false,
      side: THREE.DoubleSide,
    });
    const txt = new THREE.Mesh(txtG, txtM);
    txt.renderOrder = 98;
    if (translation) txt.position.y = 0.32;
    group.add(txt);

    let translatedGlow = null;
    let translatedText = null;
    if (translation) {
      const translatedTex = this._buildTranslationTex(translation);
      const translatedGlowM = new THREE.MeshBasicMaterial({
        map: translatedTex.tex,
        transparent: true,
        opacity: active ? 0.22 : 0.04,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        color: new THREE.Color(lighten(lyricColorManager.color, 0.6)),
      });
      translatedGlow = new THREE.Mesh(
        new THREE.PlaneGeometry(translatedTex.worldW * 1.1, translatedTex.worldH * 1.2),
        translatedGlowM,
      );
      translatedGlow.position.set(0, -1.82, 0.005);
      translatedGlow.renderOrder = 99;
      group.add(translatedGlow);

      const translatedM = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: translatedTex.tex },
          uProgress: { value: 0 },
          uFeather: { value: 0.025 },
          uTextMin: { value: translatedTex.textMinUv },
          uTextMax: { value: translatedTex.textMaxUv },
          uOpacity: { value: active ? 0.95 : 0.45 },
          uDimColor: { value: new THREE.Color(lighten(pal.base, 0.45)) },
          uBrightColor: { value: new THREE.Color('#ffffff') },
          uDimAlpha: { value: 0.55 },
        },
        vertexShader: KARAOKE_VS,
        fragmentShader: KARAOKE_FS,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
      });
      translatedText = new THREE.Mesh(
        new THREE.PlaneGeometry(translatedTex.worldW, translatedTex.worldH),
        translatedM,
      );
      translatedText.position.set(0, -1.82, 0.015);
      translatedText.renderOrder = 100;
      group.add(translatedText);
      if (active) this._translationKaraokeMat = translatedM;
    }

    // Store reference for progress updates
    if (active) this._karaokeMat = txtM;

    group.userData = {
      sun, glow, txt, translatedGlow, translatedText,
      worldW, worldH, text, translation, active, tex,
    };
    return group;
  }

  /** Called every frame from main render loop */
  tick(dt) {
    // ── Beat-synced glow bloom + rounded scale pulse ──
    this._beatGlowTarget = Math.max(this._beatGlowTarget, this._pendingBeatGlow);
    this._pendingBeatGlow = 0;
    this._beatGlowTarget *= Math.exp(-5.2 * dt);
    const glowRate = this._beatGlowTarget > this._beatGlow ? 11.0 : 6.0;
    this._beatGlow +=
      (this._beatGlowTarget - this._beatGlow) * (1 - Math.exp(-glowRate * dt));
    this._beatGlow = Math.max(0, this._beatGlow);

    if (!this._currentGroup) return;

    const d = this._currentGroup.userData;

    // ── Sun bloom — 2× bigger pulse ──
    if (d.sun) {
      const bloomTarget = 0.48 + this._beatGlow * 3.0;
      d.sun.material.opacity += (bloomTarget - d.sun.material.opacity) * 0.15;
    }

    // ── Glow layer — 2× stronger boost ──
    if (d.glow) {
      const glowTarget = 0.22 + this._beatGlow * 1.6;
      d.glow.material.opacity += (glowTarget - d.glow.material.opacity) * 0.15;
    }
    if (d.translatedGlow) {
      const translatedGlowTarget = 0.22 + this._beatGlow * 1.6;
      d.translatedGlow.material.opacity +=
        (translatedGlowTarget - d.translatedGlow.material.opacity) * 0.15;
    }

    // ── Scale pulse: capped at 6.5%, with frame-rate-independent easing ──
    const scaleTarget = 1.0 + Math.min(1, this._beatGlow) * 0.065;
    const s = d.txt ? d.txt.scale.x : this._currentGroup.scale.x;
    if (d.txt) {
      const newS = s + (scaleTarget - s) * (1 - Math.exp(-9.0 * dt));
      d.txt.scale.set(newS, newS, 1);
      if (d.translatedText) d.translatedText.scale.set(newS, newS, 1);
      if (d.translatedGlow) d.translatedGlow.scale.set(newS, newS, 1);
    }

    // Subtle float
    this._currentGroup.position.y +=
      (Math.sin(performance.now() * 0.001 * 0.5) * 0.06
       - this._currentGroup.position.y) * 0.05;

    // Karaoke progress — GPU uniform update only
    this._updateKaraokeProgress(dt);
  }

  _updateKaraokeProgress(dt) {
    if ((!this._karaokeMat && !this._translationKaraokeMat)
        || !this._lines.length || this._currentIndex < 0) return;

    // Use interpolated position — smooth between WS updates
    const pos = state.getInterpolatedPosition();
    if (!pos || pos <= 0) return;

    const curLine = this._lines[this._currentIndex];
    const nextLine = this._lines[this._currentIndex + 1];
    const lineStart = curLine ? (curLine.time || 0) : 0;
    const lineEnd = nextLine ? (nextLine.time || (lineStart + 4)) : (lineStart + 4);
    const targetProgress = getLyricLineProgress(pos, lineStart, lineEnd);

    // Exponential smooth — dt×8 gives fast tracking with no visible stepping
    // Interpolation is handled by getInterpolatedPosition() — use target directly
    this._lineProgress = targetProgress;

    // GPU uniform write only — zero canvas work, zero texture upload
    if (this._karaokeMat) {
      this._karaokeMat.uniforms.uProgress.value = this._lineProgress;
    }
    if (this._translationKaraokeMat) {
      this._translationKaraokeMat.uniforms.uProgress.value = this._lineProgress;
    }
  }

  setLyrics(lines) {
    this._lines = lines || [];
    this._currentIndex = -1;
    this._lineProgress = 0;
    this._karaokeMat = null;
    this._translationKaraokeMat = null;
    this._clearGroup();
    if (this._lines.length > 0) {
      requestAnimationFrame(() => {
        if (this._lines[0]) this.highlightLine(0, this._lines[0]);
      });
    }
  }

  highlightLine(index, line) {
    if (index < 0 || index === this._currentIndex) return;
    this._currentIndex = index;
    this._lineProgress = 0;
    this._karaokeMat = null;
    this._translationKaraokeMat = null;

    const currentLine = line || this._lines[index] || null;
    const original = currentLine?.text || '';
    const translated = currentLine?.translation || '';
    if (!original && !translated) return;

    let primaryText = original || translated;
    let secondaryText = '';
    if (lyricTranslationManager.mode === LYRIC_DISPLAY_MODES.TRANSLATION) {
      primaryText = translated || original;
    } else if (lyricTranslationManager.mode === LYRIC_DISPLAY_MODES.BOTH) {
      secondaryText = translated;
    }

    if (this._currentGroup) this._fadeOut(this._currentGroup);

    this._currentGroup = this._buildGroup(primaryText, secondaryText, true);
    this._currentGroup.scale.set(0.01, 0.01, 0.01);
    this._currentGroup.position.set(0, -0.1, 3.8);
    this._scene.add(this._currentGroup);

    this._tweenScale(this._currentGroup, 0.01, 1.0, 450);
  }

  _fadeOut(group) {
    if (!group || !group.userData) return;
    const d = group.userData;
    const dur = 350;
    if (d.sun)  this._tweenMat(d.sun.material, 'opacity', 0, dur);
    if (d.glow) this._tweenMat(d.glow.material, 'opacity', 0, dur);
    if (d.translatedGlow) this._tweenMat(d.translatedGlow.material, 'opacity', 0, dur);
    if (d.txt)  this._tweenMat(d.txt.material.uniforms.uOpacity, 'value', 0, dur);
    if (d.translatedText) {
      this._tweenMat(d.translatedText.material.uniforms.uOpacity, 'value', 0, dur);
    }
    this._tweenScale(group, group.scale.x, group.scale.x * 1.06, dur);
    setTimeout(() => { this._scene.remove(group); this._dispose(group); }, 500);
  }

  _clearGroup() {
    if (this._currentGroup) {
      this._scene.remove(this._currentGroup);
      this._dispose(this._currentGroup);
      this._currentGroup = null;
    }
    this._karaokeMat = null;
    this._translationKaraokeMat = null;
  }

  _dispose(g) {
    g.traverse(c => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        if (c.material.map && c.material.map !== this._sunTex)
          c.material.map.dispose();
        c.material.dispose();
      }
    });
  }

  clear() {
    this._lines = [];
    this._currentIndex = -1;
    this._lineProgress = 0;
    this._karaokeMat = null;
    this._translationKaraokeMat = null;
    this._clearGroup();
  }

  _tweenMat(mat, prop, target, duration) {
    const startVal = prop === 'value'
      ? (mat[prop] != null ? mat[prop] : 1)
      : (mat[prop] != null ? mat[prop] : 1);
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const ease = 1 - Math.pow(1 - t, 2);
      const val = startVal + (target - startVal) * ease;
      try {
        if (prop === 'value') mat.value = val;
        else mat[prop] = val;
      } catch (e) { /* ignore disposed */ }
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
  }

  _tweenScale(group, from, to, duration) {
    const start = performance.now();
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      const s = from + (to - from) * ease;
      group.scale.set(s, s, s);
      if (t < 1) requestAnimationFrame(tick);
    };
    tick();
  }
}
