import { state } from '../shared/StateManager.js';
import { eventBus } from '../shared/EventBus.js';
import { resolveCoverUrl } from '../shared/CoverUrl.js';
import { api } from '../core/ApiClient.js';
import { playlistManager } from '../shared/PlaylistManager.js';
import {
  applyShelfWheelInput,
  SHELF_WHEEL_SNAP_DELAY_MS,
} from './ShelfWheelDynamics.js';
import * as THREE from 'three';

const CARD_W = 4.17;
const CARD_H = 2.12;
const CARD_TEX_W = 1024;
const CARD_TEX_H = 640;
const MAX_VISIBLE = 5;
const CARD_Y_SPAN = 5.0;
const BASE_X = 8.0;
const BASE_Z = 6.0;
const CARD_PAD = 18;
const CARD_RADIUS = 32;
const COVER_GAP = 30;
const OPEN_REVEAL_SECONDS = 0.38;

export class Shelf3D {
  constructor(container, particleStage) {
    this.container = container;
    this._stage = particleStage;
    this._scene = particleStage ? particleStage.scene : null;
    this._group = particleStage ? particleStage.particleGroup : null;
    this._camera = particleStage ? particleStage.camera : null;
    this._visible = false;
    this._cards = [];
    this._allItems = [];
    this._analysisReadyKeys = new Set();
    this._analysisReadyNames = new Set();
    this._analysisActiveKeys = new Set();
    this._analysisActiveNames = new Set();
    this._analysisSpinPhase = 0;
    this._analysisSpinLastDraw = 0;
    this._centerIdx = 0;
    this._centerTarget = 0;
    this._node = null;
    this._prevCenter = -1;
    this._dragging = false;
    this._dragStartY = 0;
    this._dragBaseTarget = 0;
    this._dragAccum = 0;
    this._pointerX = -1;
    this._pointerY = -1;
    this._hoveredCardIdx = -1;
    this._pillHovered = false;
    this._heartHovered = false;
    this._lastTickAt = performance.now();
    this._raycaster = new THREE.Raycaster();
    this._pointerNdc = new THREE.Vector2();

    eventBus.on('beat-analysis:ready', (detail) => this._markAnalysisReady(detail));
    eventBus.on('beat-analysis:status', (detail) => this._setAnalysisStatus(detail));

    if (state.user.isMobile) {
      this.container.innerHTML = '<div class="shelf-2d-fallback">Slide to browse</div>';
      eventBus.on('queue:changed', (queue) => this._render2D(queue));
      return;
    }

    if (this._scene) {
      this._node = new THREE.Group();
      this._node.name = 'shelf-cards';
      this._scene.add(this._node);
      this._preAllocate();
    }

    eventBus.on('queue:changed', (queue) => this.updateItems(queue));
    eventBus.on('ui:changed', (ui) => {
      if (ui.shelfOpen) this.show();
      else this.hide();
    });
    eventBus.on('playback:started', () => this._syncCenterFromPlayback());

    this._wheelLastAt = 0;
    this._wheelPrevDir = 0;
    this._wheelPendingSnap = false;
    this._onShelfWheel = (e) => {
      if (!this._visible || !this._allItems.length) return;
      if (e.clientX < window.innerWidth * 0.4) return;
      e.preventDefault();
      const now = performance.now();
      const gap = this._wheelLastAt ? now - this._wheelLastAt : Infinity;
      this._wheelLastAt = now;
      const next = applyShelfWheelInput({
        center: this._centerIdx,
        target: this._centerTarget,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        viewportHeight: window.innerHeight,
        gapMs: gap,
        previousDirection: this._wheelPrevDir,
        maxIndex: Math.max(0, this._allItems.length - 1),
      });
      this._centerTarget = next.target;
      this._wheelPrevDir = next.direction;
      this._wheelPendingSnap = true;
    };
    window.addEventListener('wheel', this._onShelfWheel, { passive: false });

    window.addEventListener('mousemove', (e) => {
      this._pointerX = e.clientX;
      this._pointerY = e.clientY;
    });

    this._onShelfDown = (e) => {
      if (!this._visible || !this._allItems.length) return;
      if (e.target.closest('#player-bar, #search-overlay, button, input')) return;
      const px = e.touches ? e.touches[0].clientX : e.clientX;
      const py = e.touches ? e.touches[0].clientY : e.clientY;
      if (px < window.innerWidth * 0.35) return;
      e.preventDefault();
      this._dragging = true;
      this._dragStartY = py;
      this._dragBaseTarget = this._centerTarget;
      this._dragAccum = 0;
    };
    this._onShelfMove = (e) => {
      if (!this._dragging) return;
      e.preventDefault();
      const py = e.touches ? e.touches[0].clientY : e.clientY;
      const dy = this._dragStartY - py;
      const sensitivity = 0.012;
      this._dragAccum = dy * sensitivity;
      const step = Math.round(this._dragAccum);
      this._centerTarget = THREE.MathUtils.clamp(
        this._dragBaseTarget + step, 0, Math.max(0, this._allItems.length - 1)
      );
    };
    this._onShelfUp = () => {
      if (!this._dragging) return;
      this._dragging = false;
    };
    window.addEventListener('mousedown', this._onShelfDown, { passive: false });
    window.addEventListener('touchstart', this._onShelfDown, { passive: false });
    window.addEventListener('mousemove', this._onShelfMove, { passive: false });
    window.addEventListener('touchmove', this._onShelfMove, { passive: false });
    window.addEventListener('mouseup', this._onShelfUp);
    window.addEventListener('touchend', this._onShelfUp);
    window.addEventListener('touchcancel', this._onShelfUp);

    this._openAt = 0;
    window.addEventListener('click', (e) => {
      if (!this._visible) return;
      if (e.target.closest('#player-bar, #search-overlay, .shelf-card-list, button')) return;
      if (performance.now() - this._openAt < 400) return;
      if (Math.abs(this._dragAccum) > 0.5) { this._dragAccum = 0; return; }
      this._centerTarget = Math.round(this._centerIdx);

      const center = this._cards.find(c => c.isCenter && c.index >= 0);
      if (center) {
        const hitBtn = this._hitTestPillButton(center, e.clientX, e.clientY);
        if (hitBtn) { this._playCard(center); return; }
        const hitHeart = this._hitTestHeartButton(center, e.clientX, e.clientY);
        if (hitHeart) { this._addToPlaylist(center); return; }
      }

      const hitCard = this._pickCardAt(e.clientX, e.clientY);

      // Right-click on any card = add to playlist
      if (e.button === 2) {
        if (hitCard) { this._addToPlaylist(hitCard); return; }
      }

      // Jump to card under click
      if (hitCard) {
        this._centerTarget = THREE.MathUtils.clamp(
          hitCard.index, 0, Math.max(0, this._allItems.length - 1)
        );
      }
    });
  }

  _hitTestPillButton(card, sx, sy) {
    return !!(card && card._playBtn && this._hitTestCanvasRect(card, card._playBtn, sx, sy));
  }

  /** Hit-test for the circular heart button. */
  _hitTestHeartButton(card, sx, sy) {
    if (!card || card._plBtnCX == null || !this._camera) return false;
    const center = this._projectCanvasPoint(card, card._plBtnCX, card._plBtnCY);
    const edge = this._projectCanvasPoint(card, card._plBtnCX + card._plBtnR, card._plBtnCY);
    if (!center || !edge) return false;
    const scrR = Math.hypot(edge.x - center.x, edge.y - center.y);
    const dist = Math.hypot(sx - center.x, sy - center.y);
    return dist <= scrR * 1.15;
  }

  _projectCanvasPoint(card, canvasX, canvasY) {
    if (!card || !card.mesh || !this._camera) return null;
    const point = new THREE.Vector3(
      (canvasX / CARD_TEX_W - 0.5) * CARD_W,
      (0.5 - canvasY / CARD_TEX_H) * CARD_H,
      0
    );
    card.mesh.localToWorld(point);
    point.project(this._camera);
    return {
      x: (point.x + 1) * 0.5 * window.innerWidth,
      y: (1 - point.y) * 0.5 * window.innerHeight,
    };
  }

  _hitTestCanvasRect(card, rect, sx, sy) {
    const corners = [
      this._projectCanvasPoint(card, rect.x, rect.y),
      this._projectCanvasPoint(card, rect.x + rect.w, rect.y),
      this._projectCanvasPoint(card, rect.x + rect.w, rect.y + rect.h),
      this._projectCanvasPoint(card, rect.x, rect.y + rect.h),
    ];
    if (corners.some(p => !p)) return false;
    let sign = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      const cross = (b.x - a.x) * (sy - a.y) - (b.y - a.y) * (sx - a.x);
      if (Math.abs(cross) < 0.01) continue;
      const edgeSign = Math.sign(cross);
      if (sign && edgeSign !== sign) return false;
      sign = edgeSign;
    }
    return true;
  }

  _pickCardAt(sx, sy) {
    if (!this._camera || !this._node || !Number.isFinite(sx) || !Number.isFinite(sy)) {
      return null;
    }
    const candidates = this._cards
      .filter(card => card.mesh.visible && card.index >= 0)
      .map(card => card.mesh);
    if (!candidates.length) return null;

    this._pointerNdc.set(
      sx / window.innerWidth * 2 - 1,
      1 - sy / window.innerHeight * 2,
    );
    this._camera.updateMatrixWorld();
    this._node.updateMatrixWorld(true);
    this._raycaster.setFromCamera(this._pointerNdc, this._camera);
    const hits = this._raycaster.intersectObjects(candidates, false);
    if (!hits.length) return null;

    // Cards intentionally overlap and render with depth testing disabled.
    // Match the visible stack: the greatest renderOrder is painted on top.
    hits.sort((a, b) =>
      b.object.renderOrder - a.object.renderOrder || a.distance - b.distance
    );
    return this._cards.find(card => card.mesh === hits[0].object) || null;
  }

  _preAllocate() {
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const cv = document.createElement('canvas');
      cv.width = CARD_TEX_W;
      cv.height = CARD_TEX_H;
      const tx = new THREE.CanvasTexture(cv);
      tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
      const geom = new THREE.PlaneGeometry(CARD_W, CARD_H);
      const mat = new THREE.MeshBasicMaterial({
        map: tx, side: THREE.DoubleSide,
        transparent: true, opacity: 1.0, depthTest: false, depthWrite: false,
      });
      const y = -(i - Math.floor(MAX_VISIBLE/2)) * (CARD_Y_SPAN / (MAX_VISIBLE - 1));
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(BASE_X, y, BASE_Z);
      mesh.visible = false;
      mesh.renderOrder = 20 + i;
      mesh.userData = { canvas: cv };
      this._node.add(mesh);
      this._cards.push({
        mesh,
        index: -1,
        item: null,
        isCenter: false,
        slot: i - Math.floor(MAX_VISIBLE/2),
        targetY: y,
        targetOpacity: 0.35,
        targetScale: 0.70,
        _hoverMix: 0,
      });
    }
  }

  _redrawCard(card, item, itemIdx, coverImg) {
    const ctx = card.mesh.userData.canvas.getContext('2d');
    ctx.clearRect(0, 0, CARD_TEX_W, CARD_TEX_H);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    const W = CARD_TEX_W, H = CARD_TEX_H;
    const pad = CARD_PAD;
    const innerW = W - pad * 2;
    const innerH = H - pad * 2;
    const coverH = innerH - 12;
    const coverW = Math.round(
      coverH * CARD_H * CARD_TEX_W / (CARD_W * CARD_TEX_H)
    );
    const cx = pad + 6;
    const cy = pad + 6;
    const tx = cx + coverW + COVER_GAP;
    const textRight = W - pad - 18;
    const isCardHovered = card.index === this._hoveredCardIdx;
    const isEmphasized = card.isCenter || isCardHovered;

    const roundRect = (x, y, w, h, radius) => {
      const r = Math.min(radius, w * 0.5, h * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    };
    const drawWrappedText = (text, x, y, maxWidth, lineHeight, maxLines) => {
      const chars = String(text || '').split('');
      const lines = [];
      let line = '';
      for (let i = 0; i < chars.length; i++) {
        const next = line + chars[i];
        if (line && ctx.measureText(next).width > maxWidth) {
          lines.push(line);
          line = chars[i];
          if (lines.length >= maxLines) break;
        } else {
          line = next;
        }
      }
      if (line && lines.length < maxLines) lines.push(line);
      const consumed = lines.join('').length;
      if (consumed < chars.length && lines.length) {
        let last = lines.length - 1;
        while (lines[last] && ctx.measureText(lines[last] + '…').width > maxWidth) {
          lines[last] = lines[last].slice(0, -1);
        }
        lines[last] += '…';
      }
      lines.forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight));
    };

    // Mineradio-inspired solid black glass: opaque enough to feel physical,
    // with only a restrained diagonal highlight over the surface.
    roundRect(pad, pad, innerW, innerH, CARD_RADIUS);
    ctx.fillStyle = 'rgba(2,4,9,0.94)';
    ctx.fill();
    const glass = ctx.createLinearGradient(pad, pad, W - pad, H - pad);
    glass.addColorStop(0, 'rgba(255,255,255,0.115)');
    glass.addColorStop(0.34, 'rgba(255,255,255,0.038)');
    glass.addColorStop(0.72, 'rgba(255,255,255,0.012)');
    glass.addColorStop(1, 'rgba(142,169,203,0.035)');
    ctx.fillStyle = glass;
    ctx.fill();

    // Cover image with object-fit: cover cropping.
    roundRect(cx, cy, coverW, coverH, 26);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    ctx.fill();
    if (coverImg) {
      const sourceW = coverImg.naturalWidth || coverImg.width || coverW;
      const sourceH = coverImg.naturalHeight || coverImg.height || coverH;
      const crop = Math.min(sourceW, sourceH);
      const sourceX = (sourceW - crop) * 0.5;
      const sourceY = (sourceH - crop) * 0.5;
      ctx.save();
      roundRect(cx, cy, coverW, coverH, 26);
      ctx.clip();
      ctx.drawImage(coverImg, sourceX, sourceY, crop, crop, cx, cy, coverW, coverH);
      const coverShade = ctx.createLinearGradient(cx, cy, cx, cy + coverH);
      coverShade.addColorStop(0, 'rgba(255,255,255,0.035)');
      coverShade.addColorStop(0.72, 'rgba(0,0,0,0)');
      coverShade.addColorStop(1, 'rgba(0,0,0,0.20)');
      ctx.fillStyle = coverShade;
      ctx.fillRect(cx, cy, coverW, coverH);
      ctx.restore();
    }

    // Cover hairline and card edge.
    roundRect(cx + 0.5, cy + 0.5, coverW - 1, coverH - 1, 26);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1.25;
    ctx.stroke();
    roundRect(pad + 0.75, pad + 0.75, innerW - 1.5, innerH - 1.5, CARD_RADIUS);
    ctx.strokeStyle = isEmphasized ? 'rgba(220,232,247,0.32)' : 'rgba(255,255,255,0.14)';
    ctx.lineWidth = isEmphasized ? 1.8 : 1.15;
    ctx.stroke();

    // Typography follows the reference shelf: compact tag, substantial title,
    // quiet metadata and a short mechanical progress rail.
    ctx.font = '700 19px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = card.isCenter ? 'rgba(224,235,249,0.94)' : 'rgba(205,216,230,0.66)';
    ctx.fillText(`QUEUE  /  ${String(itemIdx + 1).padStart(2, '0')}`, tx, pad + 48);

    const analysisReady = this._isAnalysisReady(item);
    const analysisActive = !analysisReady && this._isAnalysisActive(item);
    if (analysisReady || analysisActive) {
      const badgeX = textRight - 20;
      const badgeY = pad + 40;
      const badgeR = 18;
      ctx.save();
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = card.isCenter ? 'rgba(211,229,247,0.13)' : 'rgba(211,229,247,0.075)';
      ctx.fill();
      ctx.strokeStyle = card.isCenter ? 'rgba(219,235,251,0.62)' : 'rgba(211,228,246,0.34)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = card.isCenter ? 'rgba(235,245,255,0.92)' : 'rgba(224,237,250,0.60)';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (analysisReady) {
        ctx.moveTo(badgeX - 8, badgeY);
        ctx.lineTo(badgeX - 4, badgeY);
        ctx.lineTo(badgeX - 1, badgeY - 6);
        ctx.lineTo(badgeX + 3, badgeY + 6);
        ctx.lineTo(badgeX + 7, badgeY - 2);
        ctx.lineTo(badgeX + 10, badgeY - 2);
      } else {
        const start = this._analysisSpinPhase;
        ctx.arc(badgeX, badgeY, 9, start, start + Math.PI * 1.32);
      }
      ctx.stroke();
      if (analysisActive) {
        const dotAngle = this._analysisSpinPhase + Math.PI * 1.32;
        ctx.beginPath();
        ctx.arc(badgeX + Math.cos(dotAngle) * 9, badgeY + Math.sin(dotAngle) * 9, 2.2, 0, Math.PI * 2);
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fill();
      }
      ctx.restore();
    }

    ctx.font = '700 42px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(248,250,253,0.97)';
    drawWrappedText((item && item.title) || '', tx, pad + 112, textRight - tx, 48, 2);

    ctx.font = '400 25px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(194,204,217,0.62)';
    ctx.fillText(this._truncate((item && item.artist) || '', 20), tx, pad + 232);

    const railY = pad + 278;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tx, railY);
    ctx.lineTo(textRight - 18, railY);
    ctx.stroke();
    ctx.strokeStyle = card.isCenter ? 'rgba(217,229,244,0.76)' : 'rgba(184,200,219,0.28)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tx, railY);
    ctx.lineTo(tx + (textRight - tx - 18) * (card.isCenter ? 0.56 : 0.22), railY);
    ctx.stroke();
    ctx.lineCap = 'butt';

    card._playBtn = null;
    if (card.isCenter) {
      const btnW = 310;
      const btnH = 72;
      const btnX = tx;
      const btnY = H - pad - btnH - 70;
      const btnR = btnH * 0.5;
      const btnHovered = this._pillHovered;
      roundRect(btnX, btnY, btnW, btnH, btnR);
      const buttonGlass = ctx.createLinearGradient(btnX, btnY, btnX + btnW, btnY + btnH);
      buttonGlass.addColorStop(0, btnHovered ? 'rgba(255,255,255,0.98)' : 'rgba(245,248,252,0.92)');
      buttonGlass.addColorStop(0.58, 'rgba(215,226,239,0.88)');
      buttonGlass.addColorStop(1, 'rgba(164,184,208,0.80)');
      ctx.fillStyle = buttonGlass;
      ctx.fill();
      ctx.strokeStyle = btnHovered ? 'rgba(255,255,255,0.86)' : 'rgba(255,255,255,0.42)';
      ctx.lineWidth = btnHovered ? 2 : 1.2;
      ctx.stroke();

      const label = '播放歌曲';
      ctx.font = '700 25px Inter, "PingFang SC", "Microsoft YaHei", sans-serif';
      const textW = ctx.measureText(label).width;
      const iconW = 20;
      const contentW = iconW + 16 + textW;
      const contentX = btnX + (btnW - contentW) * 0.5;
      const centerY = btnY + btnH * 0.5;
      ctx.beginPath();
      ctx.moveTo(contentX, centerY - 13);
      ctx.lineTo(contentX, centerY + 13);
      ctx.lineTo(contentX + iconW, centerY);
      ctx.closePath();
      ctx.fillStyle = 'rgba(8,13,20,0.92)';
      ctx.fill();
      ctx.fillStyle = 'rgba(8,13,20,0.92)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, contentX + iconW + 16, centerY);
      card._playBtn = { x: btnX, y: btnY, w: btnW, h: btnH };
    }

    // Keep the existing add-to-playlist affordance, rendered as a quiet ghost control.
    {
      const heartR = card.isCenter ? 27 : 24;
      const heartCX = card.isCenter
        ? card._playBtn.x + card._playBtn.w + heartR + 14
        : W - pad - heartR - 16;
      const heartCY = card.isCenter
        ? card._playBtn.y + card._playBtn.h * 0.5
        : H - pad - heartR - 16;
      ctx.beginPath();
      ctx.arc(heartCX, heartCY, heartR, 0, Math.PI * 2);
      ctx.fillStyle = this._heartHovered && card.isCenter
        ? 'rgba(229,237,247,0.16)'
        : 'rgba(255,255,255,0.055)';
      ctx.fill();
      ctx.strokeStyle = this._heartHovered && card.isCenter
        ? 'rgba(235,242,250,0.72)'
        : 'rgba(255,255,255,0.18)';
      ctx.lineWidth = this._heartHovered && card.isCenter ? 1.8 : 1.15;
      ctx.stroke();
      ctx.font = `${Math.round(heartR * 1.08)}px "Segoe UI Symbol", Arial, sans-serif`;
      ctx.fillStyle = card.isCenter ? 'rgba(238,243,249,0.86)' : 'rgba(224,232,242,0.54)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♥', heartCX, heartCY + 1);
      card._plBtnCX = heartCX;
      card._plBtnCY = heartCY;
      card._plBtnR = heartR;
    }

    // Selected/hovered edge glow stays narrow and neutral instead of neon.
    if (isEmphasized) {
      ctx.save();
      ctx.shadowColor = isCardHovered ? 'rgba(191,214,241,0.34)' : 'rgba(180,202,229,0.20)';
      ctx.shadowBlur = isCardHovered ? 16 : 10;
      roundRect(pad + 2.5, pad + 2.5, innerW - 5, innerH - 5, CARD_RADIUS - 2);
      ctx.strokeStyle = isCardHovered ? 'rgba(225,236,249,0.54)' : 'rgba(211,225,243,0.28)';
      ctx.lineWidth = isCardHovered ? 2.1 : 1.25;
      ctx.stroke();
      ctx.restore();
    }

    card.mesh.material.map.needsUpdate = true;
  }

  _assignSlots() {
    const items = this._allItems;
    if (!items.length) {
      this._cards.forEach(c => { c.mesh.visible = false; c.index = -1; });
      return;
    }
    const half = Math.floor(MAX_VISIBLE / 2);
    const floatCenter = this._centerIdx;
    const intCenter = Math.round(floatCenter);
    const frac = floatCenter - intCenter;
    const yStep = CARD_Y_SPAN / (MAX_VISIBLE - 1);

    for (let i = 0; i < this._cards.length; i++) {
      const slot = i - half;
      const itemIdx = intCenter + slot;
      const card = this._cards[i];

      if (itemIdx < 0 || itemIdx >= items.length) {
        card.mesh.visible = false;
        card.index = -1; card.item = null; card.isCenter = false;
        continue;
      }
      const item = items[itemIdx];
      const isCenter = slot === 0;
      const centerChanged = card.isCenter !== isCenter;

      if (card.index !== itemIdx) {
        card.index = itemIdx; card.item = item; card._coverImg = null;
        card._hoverMix = 0;
        card.isCenter = isCenter;
        this._redrawCard(card, item, itemIdx, null);
        const coverUrl = item.artwork || item.cover_url || item.cover || '';
        if (coverUrl) {
          const img = new Image(); img.crossOrigin = 'anonymous';
          img.onload = () => {
            if (card.index !== itemIdx || card.item !== item) return;
            card._coverImg = img;
            this._redrawCard(card, item, itemIdx, img);
          };
          img.src = resolveCoverUrl(coverUrl);
        }
      } else if (centerChanged) {
        card.isCenter = isCenter;
        this._redrawCard(card, item, itemIdx, card._coverImg);
      }

      card.isCenter = isCenter;
      card.slot = slot;
      card.targetY = -(slot - frac) * yStep;
      const distance = Math.abs(slot - frac);
      card.targetOpacity = Math.max(0.48, 1.0 - distance * 0.24);
      card.targetScale = Math.max(0.72, 1.08 - distance * 0.16);
      card.mesh.renderOrder = 900 - Math.round(distance * 10);
      card.mesh.visible = true;
    }
  }

  tick() {
    if (!this._visible) return;

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(1 / 240, (now - this._lastTickAt) / 1000));
    this._lastTickAt = now;
    if (this._wheelPendingSnap && now - this._wheelLastAt >= SHELF_WHEEL_SNAP_DELAY_MS) {
      this._centerTarget = THREE.MathUtils.clamp(
        Math.round(this._centerTarget), 0, Math.max(0, this._allItems.length - 1)
      );
      this._wheelPendingSnap = false;
      this._wheelPrevDir = 0;
    }
    const diff = this._centerTarget - this._centerIdx;
    const centerEase = 1 - Math.exp(-10.5 * dt);
    if (Math.abs(diff) < 0.0015) this._centerIdx = this._centerTarget;
    else this._centerIdx += diff * centerEase;

    this._assignSlots();

    if (now - this._analysisSpinLastDraw >= 120) {
      const activeCards = this._cards.filter(card =>
        card.mesh.visible && card.item && this._isAnalysisActive(card.item)
        && !this._isAnalysisReady(card.item)
      );
      if (activeCards.length) {
        this._analysisSpinLastDraw = now;
        this._analysisSpinPhase = (this._analysisSpinPhase + 0.42) % (Math.PI * 2);
        activeCards.forEach(card => this._redrawCard(card, card.item, card.index, card._coverImg));
      }
    }

    const camZ = this._camera ? this._camera.position.z : 36;
    const camX = this._camera ? this._camera.position.x : 0;
    const pointerNX = this._pointerX >= 0 ? THREE.MathUtils.clamp(this._pointerX / window.innerWidth * 2 - 1, -1, 1) : 0;
    const pointerNY = this._pointerY >= 0 ? THREE.MathUtils.clamp(1 - this._pointerY / window.innerHeight * 2, -1, 1) : 0;
    const yStep = CARD_Y_SPAN / (MAX_VISIBLE - 1);

    this._cards.forEach(c => {
      if (!c.mesh.visible) return;

      const isHovered = c.index >= 0 && c.index === this._hoveredCardIdx;
      const targetMix = isHovered ? 1 : 0;
      const mixRate = 1 - Math.exp(-(targetMix > c._hoverMix ? 14 : 10) * dt);
      c._hoverMix += (targetMix - c._hoverMix) * mixRate;
      if (!targetMix && c._hoverMix < 0.005) c._hoverMix = 0;

      const delta = c.index - this._centerIdx;
      const distance = Math.abs(delta);
      const parallaxWeight = Math.max(0.15, 1 - distance * 0.30);
      const revealRaw = THREE.MathUtils.clamp(
        ((now - this._openAt) / 1000 - distance * 0.045) / OPEN_REVEAL_SECONDS,
        0,
        1
      );
      const reveal = revealRaw * revealRaw * (3 - 2 * revealRaw);
      const entry = 1 - reveal;
      const direction = delta === 0 ? 0 : Math.sign(delta);
      const positionX = BASE_X + distance * 0.10 + entry * 0.38 - c._hoverMix * 0.07;
      const positionY = -delta * yStep + direction * entry * 0.12
        + pointerNY * 0.018 * parallaxWeight + c._hoverMix * 0.065;
      const positionZ = BASE_Z - distance * 0.18 - entry * 0.18 + c._hoverMix * 0.20;
      c.mesh.position.set(positionX, positionY, positionZ);
      c.mesh.scale.setScalar(c.targetScale * (0.94 + reveal * 0.06) * (1 + c._hoverMix * 0.045));
      c.mesh.material.opacity = Math.min(1, (c.targetOpacity + c._hoverMix * 0.045) * reveal);
      c.mesh.rotation.y = Math.atan2(camX - positionX, camZ - positionZ) - 0.24
        + pointerNX * 0.014 * parallaxWeight;
      c.mesh.rotation.x = -delta * 0.035 - pointerNY * 0.010 * parallaxWeight;

      const corners = [
        this._projectCanvasPoint(c, 0, 0),
        this._projectCanvasPoint(c, CARD_TEX_W, 0),
        this._projectCanvasPoint(c, CARD_TEX_W, CARD_TEX_H),
        this._projectCanvasPoint(c, 0, CARD_TEX_H),
      ];
      if (corners.every(Boolean)) {
        const xs = corners.map(point => point.x);
        const ys = corners.map(point => point.y);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        c._screenX = (minX + maxX) * 0.5;
        c._screenY = (minY + maxY) * 0.5;
        c._screenW = (maxX - minX) * 0.5;
        c._screenH = (maxY - minY) * 0.5;
      }
    });

    // Card hover detection
    if (this._pointerY > 0 && this._pointerX > 0) {
      const hoveredCard = this._pickCardAt(this._pointerX, this._pointerY);
      const bestIdx = hoveredCard ? hoveredCard.index : -1;
      if (bestIdx !== this._hoveredCardIdx) {
        const old = this._cards.find(c => c.index === this._hoveredCardIdx);
        const cur = this._cards.find(c => c.index === bestIdx);
        this._hoveredCardIdx = bestIdx;
        if (old && old.item) this._redrawCard(old, old.item, old.index, old._coverImg);
        if (cur && cur.item) this._redrawCard(cur, cur.item, cur.index, cur._coverImg);
      }
    }

    // Pill + heart hover detection
    const center = this._cards.find(c => c.isCenter && c.index >= 0);
    const pillHit = center ? this._hitTestPillButton(center, this._pointerX, this._pointerY) : false;
    const heartHit = center ? this._hitTestHeartButton(center, this._pointerX, this._pointerY) : false;

    if (pillHit !== this._pillHovered || heartHit !== this._heartHovered) {
      this._pillHovered = pillHit;
      this._heartHovered = heartHit;
      if (center && center.item) this._redrawCard(center, center.item, center.index, center._coverImg);
      const pc = document.getElementById('particle-canvas');
      if (pc) pc.style.cursor = (pillHit || heartHit) ? 'pointer' : 'default';
    }
  }

  show() {
    if (state.ui.queueOpen) state.toggleUI('queueOpen');
    this._visible = true;
    this._openAt = performance.now();
    this._prevCenter = -1;
    this._centerTarget = 0;
    this._centerIdx = 0;
    this._wheelPendingSnap = false;
    this._wheelPrevDir = 0;
    this._wheelLastAt = 0;
    this._lastTickAt = performance.now();
    this._assignSlots();
    if (this._stage) this._stage.enterShelfMode();
  }

  hide() {
    this._visible = false;
    this._wheelPendingSnap = false;
    this._wheelPrevDir = 0;
    this._cards.forEach(c => { c.mesh.visible = false; c.index = -1; c.item = null; });
    if (this._stage) this._stage.exitShelfMode();
  }

  updateItems(queue) {
    const items = (queue && queue.length) ? [...queue] : [];
    const sameHead = items.length && this._allItems.length &&
      items[0].title === this._allItems[0].title;
    this._allItems = items;
    if (!sameHead) { this._centerTarget = 0; this._centerIdx = 0; this._prevCenter = -1; }
    if (this._visible) this._assignSlots();
  }

  _analysisItemKey(item) {
    const value = item && [item.queue_id, item.id, item.track_id, item.song_mid, item.mid]
      .find(candidate => candidate !== undefined && candidate !== null && candidate !== '');
    return value === undefined ? '' : String(value);
  }

  _analysisItemName(item) {
    return String(item?.title || item?.name || '').trim().normalize('NFKC').toLocaleLowerCase();
  }

  _isAnalysisReady(item) {
    const key = this._analysisItemKey(item);
    const name = this._analysisItemName(item);
    return Boolean((key && this._analysisReadyKeys.has(key))
      || (name && this._analysisReadyNames.has(name)));
  }

  _isAnalysisActive(item) {
    const key = this._analysisItemKey(item);
    const name = this._analysisItemName(item);
    return Boolean((key && this._analysisActiveKeys.has(key))
      || (name && this._analysisActiveNames.has(name)));
  }

  _setAnalysisStatus(detail) {
    if (detail?.status === 'ready') {
      this._markAnalysisReady(detail);
      return;
    }
    const key = detail?.key == null ? '' : String(detail.key);
    const name = String(detail?.name || '').trim().normalize('NFKC').toLocaleLowerCase();
    if (detail?.status === 'analyzing') {
      if (key) this._analysisActiveKeys.add(key);
      if (name) this._analysisActiveNames.add(name);
    } else {
      if (key) this._analysisActiveKeys.delete(key);
      if (name) this._analysisActiveNames.delete(name);
    }
    this._redrawAnalysisItems(key, name);
  }

  _markAnalysisReady(detail) {
    const key = detail?.key == null ? '' : String(detail.key);
    const name = String(detail?.name || '').trim().normalize('NFKC').toLocaleLowerCase();
    if (!key && !name) return;
    if (key) this._analysisReadyKeys.add(key);
    if (name) this._analysisReadyNames.add(name);
    if (key) this._analysisActiveKeys.delete(key);
    if (name) this._analysisActiveNames.delete(name);

    this._redrawAnalysisItems(key, name);
  }

  _redrawAnalysisItems(key, name) {

    if (state.user.isMobile) {
      this._render2D(this._allItems);
      return;
    }
    this._cards.forEach(card => {
      if (card.item && ((key && this._analysisItemKey(card.item) === key)
          || (name && this._analysisItemName(card.item) === name))) {
        this._redrawCard(card, card.item, card.index, card._coverImg);
      }
    });
  }

  _syncCenterFromPlayback() {
    const title = state.playback.song && state.playback.song.title;
    if (!title) return;
    const idx = this._allItems.findIndex(q => q.title === title);
    if (idx >= 0) { this._centerTarget = idx; }
  }

  _addToPlaylist(card) {
    if (!card || !card.item) return;
    const item = card.item;
    const artist = item.artist || '';
    const title = item.title || '';
    const line = artist ? artist + ' - ' + title : title;
    const ok = playlistManager.addSongToDefault(line);
    eventBus.emit('toast', {
      message: ok ? 'Added to playlist: ' + line : 'Already in playlist',
      level: ok ? 'success' : 'info'
    });
  }

  async _playCard(card) {
    const idx = card.index;
    if (idx < 0 || idx >= this._allItems.length) return;
    try {
      for (let i = idx - 1; i >= 0; i--) {
        const item = this._allItems[i];
        if (item && item.id != null) await api.removeFromQueue(item.id);
      }
      await api.skip();
    } catch (e) { /* ignore */ }
    state.toggleUI('shelfOpen');
  }

  _truncate(s, max) { return s && s.length > max ? s.slice(0, max - 1) + '...' : s || ''; }

  _render2D(queue) {
    this._allItems = Array.isArray(queue) ? [...queue] : [];
    this.container.innerHTML = queue.length
      ? queue.map(t => `<div class="shelf-2d-item">${t.title} - ${t.artist}${this._isAnalysisReady(t) ? '  ·  ✓' : (this._isAnalysisActive(t) ? '  ·  ◌' : '')}</div>`).join('')
      : '<div class="shelf-2d-empty">Queue empty</div>';
  }
}
