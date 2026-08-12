/**
 * OfflineBeatAnalyzer — prefetch audio, decode with Web Audio API, run onset
 * detection, and return beat grids for the current playback controller.
 *
 * Ported from Mineradio's dj-analyzer buildBeatMapFromLowEnergy (server-side)
 * and the frontend beat prefetch system. Works with the remote-playback
 * architecture (no local audio element needed).
 *
 * Flow:
 *   1. Get audio URL from the current song
 *   2. Fetch audio data (with Range support for partial analysis)
 *   3. Decode with AudioContext.decodeAudioData()
 *   4. Split into frequency bands via biquad filters
 *   5. Onset detection + BPM estimation
 *   6. Generate beat grid for the active track
 *   7. Cache results by track ID
 */

// ── Biquad filter (matches Mineradio dj-analyzer) ──
function makeBiquad(type, freq, q, sr) {
  freq = Math.max(8, Math.min(freq, sr * 0.45));
  const w0 = 2 * Math.PI * freq / sr;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * (q || 0.707));
  let b0, b1, b2;
  if (type === 'highpass') {
    b0 = (1 + cos) * 0.5;
    b1 = -(1 + cos);
    b2 = (1 + cos) * 0.5;
  } else {
    b0 = (1 - cos) * 0.5;
    b1 = 1 - cos;
    b2 = (1 - cos) * 0.5;
  }
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  const inv = 1 / a0;
  return { b0: b0 * inv, b1: b1 * inv, b2: b2 * inv, a1: a1 * inv, a2: a2 * inv, x1: 0, x2: 0, y1: 0, y2: 0 };
}

function runBiquad(st, x) {
  const y = st.b0 * x + st.b1 * st.x1 + st.b2 * st.x2 - st.a1 * st.y1 - st.a2 * st.y2;
  st.x2 = st.x1;
  st.x1 = x;
  st.y2 = st.y1;
  st.y1 = y;
  return y;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}

function clampRange(v, min, max) {
  return Math.max(min, Math.min(max, Number(v) || 0));
}

function percentile(arr, p, maxSamples) {
  const len = arr ? arr.length : 0;
  if (!len) return 0.001;
  maxSamples = maxSamples || 16000;
  let sample;
  if (len <= maxSamples) {
    sample = Array.prototype.slice.call(arr);
  } else {
    sample = new Array(maxSamples);
    const step = (len - 1) / (maxSamples - 1);
    for (let i = 0; i < maxSamples; i++) {
      sample[i] = arr[Math.min(len - 1, Math.floor(i * step))] || 0;
    }
  }
  sample.sort((a, b) => a - b);
  return sample[Math.max(0, Math.min(sample.length - 1, Math.floor(sample.length * p)))] || 0.001;
}

// ── Core beat map builder (ported from dj-analyzer buildBeatMapFromLowEnergy) ──
function buildBeatMap(lowEnergy, hitEnergy, bodyEnergy, hopSec, durationSec) {
  const nFrames = Math.min(lowEnergy.length, hitEnergy.length, bodyEnergy.length);
  if (nFrames < 20) return { beats: [], gridStep: 0 };

  function bandAt(arr, idx) {
    idx = Math.max(0, Math.min(nFrames - 1, idx | 0));
    const a = arr[Math.max(0, idx - 1)] || 0;
    const b = arr[idx] || 0;
    const c = arr[Math.min(nFrames - 1, idx + 1)] || 0;
    return (a + b * 2 + c) * 0.25;
  }

  const lowFloor = Math.max(0.0004, percentile(lowEnergy, 0.22));
  const lowMid = Math.max(lowFloor + 0.0002, percentile(lowEnergy, 0.58));
  const lowRef = Math.max(lowMid + 0.0002, percentile(lowEnergy, 0.86));
  const lowCeil = Math.max(lowRef + 0.0004, percentile(lowEnergy, 0.96));
  const hitRef = Math.max(0.0004, percentile(hitEnergy, 0.86));

  // A beat onset is too brief to describe a chorus. Smooth the unfiltered RMS
  // over roughly 1.2 seconds so every beat also carries a stable section-level
  // loudness envelope for sustained terrain movement.
  const bodyPrefix = new Float64Array(nFrames + 1);
  for (let i = 0; i < nFrames; i++) bodyPrefix[i + 1] = bodyPrefix[i] + bodyEnergy[i];
  const bodyRadius = Math.max(8, Math.round(0.60 / hopSec));
  const sectionEnergy = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const from = Math.max(0, i - bodyRadius);
    const to = Math.min(nFrames, i + bodyRadius + 1);
    sectionEnergy[i] = (bodyPrefix[to] - bodyPrefix[from]) / Math.max(1, to - from);
  }
  const sectionFloor = percentile(sectionEnergy, 0.20);
  const sectionCeil = Math.max(sectionFloor + 0.0001, percentile(sectionEnergy, 0.90));

  // Onset detection
  const onset = new Float32Array(nFrames);
  for (let i = 4; i < nFrames; i++) {
    const prev = lowEnergy[i - 1] * 0.62 + lowEnergy[i - 2] * 0.28 + lowEnergy[i - 3] * 0.10;
    const lowRise = Math.max(0, lowEnergy[i] - prev);
    const wideRise = Math.max(0,
      (lowEnergy[i] + lowEnergy[i - 1]) * 0.5
      - (lowEnergy[i - 3] + lowEnergy[i - 4]) * 0.5
    );
    const peakRise = Math.max(0, hitEnergy[i] - hitEnergy[i - 2] * 0.84);
    onset[i] = lowRise * 1.72 + wideRise * 0.86 + peakRise * 0.10;
  }

  const winN = Math.max(52, Math.round(0.82 / hopSec));
  const minFrameGap = Math.max(18, Math.round(0.215 / hopSec));
  const candidates = [];
  let sumO = 0, sqO = 0;
  for (let i = 0; i < winN; i++) {
    const o = onset[i] || 0;
    sumO += o;
    sqO += o * o;
  }
  for (let f = winN + 4; f < nFrames - 4; f++) {
    const mean = sumO / winN;
    const std = Math.sqrt(Math.max(0, sqO / winN - mean * mean));
    const th = mean + std * 1.66 + lowRef * 0.0038;
    const o = onset[f];
    if (o > th && o >= onset[f - 1] && o > onset[f + 1]) {
      let peakF = f, peakScore = o + lowEnergy[f] * 0.10;
      for (let pf = f - 2; pf <= f + 3; pf++) {
        const ps = (onset[pf] || 0) + (lowEnergy[pf] || 0) * 0.10;
        if (ps > peakScore) { peakScore = ps; peakF = pf; }
      }
      const lowTone = Math.min(2.6, bandAt(lowEnergy, peakF) / lowRef);
      const hitTone = Math.min(2.6, bandAt(hitEnergy, peakF) / hitRef);
      const lowRel = clamp01((bandAt(lowEnergy, peakF) - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
      const score = (o - th) / Math.max(0.0006, std + mean * 0.38 + lowRef * 0.012);
      if (score > 0.16 && (lowTone > 0.32 || lowRel > 0.22 || hitTone > 0.52)) {
        const cand = { frame: peakF, time: peakF * hopSec, score, lowTone, hitTone, lowRel, raw: o };
        cand.power = cand.score * 0.56
          + Math.pow(clamp01((cand.lowTone - 0.22) / 1.42), 0.82) * 0.34
          + Math.min(1.5, cand.hitTone) * 0.08 + cand.lowRel * 0.10;
        const last = candidates[candidates.length - 1];
        if (last && cand.frame - last.frame < minFrameGap) {
          if (cand.power > last.power) candidates[candidates.length - 1] = cand;
        } else {
          candidates.push(cand);
        }
      }
    }
    const old = onset[f - winN] || 0;
    const next = onset[f] || 0;
    sumO += next - old;
    sqO += next * next - old * old;
  }

  if (!candidates.length) return { beats: [], gridStep: 0 };

  // BPM estimation
  const powers = candidates.map(c => c.power);
  const p30 = percentile(powers, 0.30);
  const p50 = percentile(powers, 0.50);
  const p90 = Math.max(p50 + 0.001, percentile(powers, 0.90));
  const p96 = Math.max(p90 + 0.001, percentile(powers, 0.965));
  let strong = candidates.filter(c => c.power >= p50 && c.lowTone > 0.34);
  if (strong.length < 16) strong = candidates.slice();

  function estimateStep(list) {
    if (!list || list.length < 3) return 0;
    const bin = 0.006, hist = {};
    for (let ai = 0; ai < list.length; ai++) {
      for (let bi = ai + 1; bi < list.length && bi < ai + 10; bi++) {
        const rawGap = list[bi].time - list[ai].time;
        if (rawGap < 0.24) continue;
        if (rawGap > 2.55) break;
        for (let div = 1; div <= 6; div++) {
          const g = rawGap / div;
          if (g < 0.31) break;
          if (g > 0.86) continue;
          const weight = Math.sqrt(Math.max(0.001, list[ai].power * list[bi].power))
            / Math.sqrt((bi - ai) * div);
          const key = Math.round(g / bin);
          hist[key] = (hist[key] || 0) + weight;
        }
      }
    }
    let bestKey = null, bestScore = 0;
    Object.keys(hist).forEach(k => {
      const key = parseInt(k, 10);
      const score = (hist[key] || 0) + (hist[key - 1] || 0) * 0.72 + (hist[key + 1] || 0) * 0.72;
      if (score > bestScore) { bestScore = score; bestKey = key; }
    });
    return bestKey != null ? bestKey * bin : 0.50;
  }

  let globalStep = estimateStep(strong) || estimateStep(candidates) || 0.50;
  globalStep = clampRange(globalStep, 0.32, 0.86);

  // Phase anchoring
  function scorePhase(anchorTime, step) {
    let start = anchorTime;
    while (start - step > 0.05) start -= step;
    const end = Math.min(durationSec || nFrames * hopSec, 180);
    const win = Math.max(0.055, Math.min(0.125, step * 0.18));
    let score = 0, count = 0, cursor = 0;
    for (let gt = start; gt < end; gt += step) {
      while (cursor < candidates.length && candidates[cursor].time < gt - win) cursor++;
      let bestScore = 0;
      for (let pi = cursor; pi < candidates.length && candidates[pi].time <= gt + win; pi++) {
        const dist = Math.abs(candidates[pi].time - gt);
        const s = candidates[pi].power * (1 - dist / win * 0.44);
        if (s > bestScore) bestScore = s;
      }
      score += bestScore ? bestScore : -p30 * 0.08;
      count++;
    }
    return count ? score / count : -Infinity;
  }

  let phaseSource = strong.filter(c => c.time < Math.min(durationSec || nFrames * hopSec, 180)).slice(0, 72);
  if (!phaseSource.length) phaseSource = strong.slice(0, 1);
  let bestAnchor = phaseSource[0] ? phaseSource[0].time : 0;
  let bestAnchorScore = -Infinity;
  for (let i = 0; i < phaseSource.length; i++) {
    const sc = scorePhase(phaseSource[i].time, globalStep);
    if (sc > bestAnchorScore) { bestAnchorScore = sc; bestAnchor = phaseSource[i].time; }
  }

  let anchor = bestAnchor;
  while (anchor - globalStep > 0.05) anchor -= globalStep;

  // Build beat grid
  const beats = [];
  let gridIndex = 0;
  const duration = durationSec || nFrames * hopSec;

  function nearestCandidate(center, windowSec, startIdx) {
    let best = null, bestScore = -Infinity;
    let j = startIdx || 0;
    while (j < candidates.length && candidates[j].time < center - windowSec) j++;
    for (let ni = j; ni < candidates.length && candidates[ni].time <= center + windowSec; ni++) {
      const dist = Math.abs(candidates[ni].time - center);
      const sc = candidates[ni].power * (1 - dist / Math.max(0.001, windowSec) * 0.42);
      if (sc > bestScore) { best = candidates[ni]; bestScore = sc; }
    }
    return best;
  }

  let cursorIdx = 0;
  for (let gridT = anchor; gridT < duration - 0.04;) {
    const winSec = Math.max(0.060, Math.min(0.135, globalStep * 0.20));
    while (cursorIdx < candidates.length && candidates[cursorIdx].time < gridT - winSec) cursorIdx++;
    const bestCand = nearestCandidate(gridT, winSec, cursorIdx);
    const gf = Math.max(0, Math.min(nFrames - 1, Math.round(gridT / hopSec)));
    const gridLow = bandAt(lowEnergy, gf);
    const gridHit = bandAt(hitEnergy, gf);
    const gridLowTone = Math.min(2.6, gridLow / lowRef);
    const gridHitTone = Math.min(2.6, gridHit / hitRef);
    const lowTone = bestCand ? Math.max(gridLowTone * 0.62, bestCand.lowTone) : gridLowTone;
    const hitTone = bestCand ? Math.max(gridHitTone * 0.62, bestCand.hitTone) : gridHitTone;
    const distPenalty = bestCand
      ? (1 - Math.min(1, Math.abs(bestCand.time - gridT) / winSec) * 0.26) : 0.54;
    const basePower = bestCand
      ? bestCand.power * distPenalty : (gridLowTone * 0.25 + gridHitTone * 0.06);
    const powerRel = clamp01((basePower - p30 * 0.78) / Math.max(0.001, p96 - p30 * 0.78));
    const lowRel = clamp01((gridLow - lowFloor) / Math.max(0.0001, lowCeil - lowFloor));
    const sectionRel = clamp01(
      (sectionEnergy[gf] - sectionFloor) / Math.max(0.0001, sectionCeil - sectionFloor)
    );
    const kickRel = clamp01(powerRel * 0.74 + lowRel * 0.22 + clamp01((hitTone - 0.26) / 1.70) * 0.04);
    const softGrid = ((!bestCand && lowRel < 0.20) || kickRel < 0.16) && sectionRel < 0.38;

    // 4-beat cycle
    const slot = gridIndex % 4;
    let combo = slot === 0 ? 'downbeat'
      : (slot === 1 ? 'push' : (slot === 2 ? 'drop' : 'rebound'));
    if (kickRel > 0.84 && combo !== 'downbeat') combo = 'accent';

    const visualRel = kickRel > 0.76 ? 0.76 + (kickRel - 0.76) * 0.52 : kickRel;
    const downLift = combo === 'downbeat'
      ? (visualRel > 0.18 ? (0.016 + visualRel * 0.036) : visualRel * 0.028) : 0;
    let impact = Math.max(0.020, Math.min(0.88, 0.022 + Math.pow(visualRel, 1.62) * 0.86 + downLift));
    let strength = Math.max(0.12, Math.min(0.93, 0.13 + Math.pow(visualRel, 1.12) * 0.68 + downLift * 0.70));
    if (softGrid) {
      impact *= combo === 'downbeat' ? 0.48 : 0.30;
      strength *= 0.58;
    }
    strength = Math.max(strength, 0.10 + sectionRel * 0.72);
    impact = Math.max(impact, 0.04 + sectionRel * 0.54);

    const timingPull = bestCand
      ? (0.24 + clamp01((kickRel - 0.25) / 0.65) * 0.46) : 0;
    const sourceTime = bestCand
      ? (gridT * (1 - timingPull) + bestCand.time * timingPull) : gridT;

    const lowMix = Math.max(0.42, Math.min(0.90,
      0.52 + visualRel * 0.32 + lowTone * 0.035 - (combo === 'accent' ? 0.10 : 0)));
    const bodyMix = Math.max(0.035, Math.min(0.54,
      0.060 + visualRel * 0.12 + sectionRel * 0.24
      + (combo === 'push' ? 0.18 : 0) + (combo === 'drop' ? 0.24 : 0)));
    const snapMix = Math.max(0.015, Math.min(0.62,
      0.026 + (combo === 'accent' ? 0.40 : 0) + (combo === 'rebound' ? 0.08 : 0) + visualRel * 0.038));

    beats.push({
      time: sourceTime,
      type: combo,
      intensity: strength,
      strength,
      confidence: Math.max(0.44, Math.min(0.99, 0.46 + kickRel * 0.43 + (bestCand ? 0.08 : -0.03))),
      low: lowMix,
      body: bodyMix,
      snap: snapMix,
      mass: Math.max(0.36, Math.min(0.94, lowMix * 0.72 + Math.pow(visualRel, 1.22) * 0.24)),
      sharpness: Math.max(0.03, Math.min(0.28, snapMix * 1.18)),
      impact,
      sectionEnergy: sectionRel,
      offline: true,
    });

    gridIndex++;
    gridT += globalStep;
  }

  return {
    beats,
    gridStep: globalStep,
    duration,
    beatCount: beats.length,
  };
}

// ── OfflineBeatAnalyzer ──
export class OfflineBeatAnalyzer {
  constructor() {
    this._cache = new Map();       // trackId → beat grid
    this._pending = new Map();     // trackId → Promise (prevents duplicate analysis)
    this._ctx = null;
  }

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._ctx;
  }

  /**
   * Analyze a song by its audio URL. Caches results by track ID.
   * @param {string} trackId - unique track identifier
   * @param {string} audioUrl - direct audio URL (or proxied)
   * @param {number} [durationSec] - song duration hint
   * @returns {Promise<object>} beat grid result
   */
  async analyze(trackId, audioUrl, durationSec) {
    if (!trackId || !audioUrl) return null;
    if (this._cache.has(trackId)) return this._cache.get(trackId);
    if (this._pending.has(trackId)) return this._pending.get(trackId);

    const promise = this._doAnalyze(trackId, audioUrl, durationSec);
    this._pending.set(trackId, promise);

    try {
      const result = await promise;
      this._cache.set(trackId, result);
      return result;
    } finally {
      this._pending.delete(trackId);
    }
  }

  async _doAnalyze(trackId, audioUrl, durationSec) {
    console.log('[OfflineBeatAnalyzer] Starting analysis:', trackId);

    try {
      // Fetch audio
      const resp = await fetch(audioUrl);
      if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
      const arrayBuffer = await resp.arrayBuffer();

      // Decode
      const ctx = this._getCtx();
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const sr = audioBuffer.sampleRate;
      const data = audioBuffer.getChannelData(0);
      // Also mix in right channel if available
      const right = audioBuffer.numberOfChannels > 1
        ? audioBuffer.getChannelData(1) : null;

      // Split into low/hit energy bands (matches dj-analyzer)
      const hopSec = 0.010;
      const sampleStep = sr >= 44100 ? 4 : (sr >= 32000 ? 3 : 2);
      const effectiveSr = sr / sampleStep;
      const hopSize = Math.max(80, Math.floor(effectiveSr * hopSec));

      const hp = makeBiquad('highpass', 32, 0.72, effectiveSr);
      const lp = makeBiquad('lowpass', 178, 0.82, effectiveSr);

      const lowEnergy = [];
      const hitEnergy = [];
      const bodyEnergy = [];
      let frameSum = 0, framePeak = 0, bodySum = 0, frameCount = 0;
      const n = data.length;

      for (let i = 0; i < n; i += sampleStep) {
        const x = right
          ? ((data[i] || 0) + (right[i] || 0)) * 0.5
          : (data[i] || 0);
        const y = runBiquad(lp, runBiquad(hp, x));
        const ay = Math.abs(y);
        frameSum += y * y;
        bodySum += x * x;
        if (ay > framePeak) framePeak = ay;
        frameCount++;
        if (frameCount >= hopSize) {
          lowEnergy.push(Math.sqrt(frameSum / Math.max(1, frameCount)));
          hitEnergy.push(framePeak);
          bodyEnergy.push(Math.sqrt(bodySum / Math.max(1, frameCount)));
          frameSum = 0; framePeak = 0; bodySum = 0; frameCount = 0;
        }
      }
      if (frameCount > 0) {
        lowEnergy.push(Math.sqrt(frameSum / Math.max(1, frameCount)));
        hitEnergy.push(framePeak);
        bodyEnergy.push(Math.sqrt(bodySum / Math.max(1, frameCount)));
      }

      const duration = effectiveSr > 0
        ? (lowEnergy.length * hopSize) / effectiveSr
        : audioBuffer.duration;

      const map = buildBeatMap(lowEnergy, hitEnergy, bodyEnergy, hopSec, duration || durationSec || 0);

      console.log('[OfflineBeatAnalyzer] Analysis complete:',
        map.beats.length, 'beats, step =', map.gridStep.toFixed(3), 's');

      return map;
    } catch (e) {
      console.warn('[OfflineBeatAnalyzer] Analysis failed for', trackId, ':', e.message);
      return null;
    }
  }

  /** Clear cache (e.g. memory pressure). */
  clearCache() {
    this._cache.clear();
  }

  /** Check if cached. */
  hasCache(trackId) {
    return this._cache.has(trackId);
  }
}

export const offlineBeatAnalyzer = new OfflineBeatAnalyzer();
