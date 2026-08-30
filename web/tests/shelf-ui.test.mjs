import assert from 'node:assert/strict';
import test from 'node:test';


const storage = new Map();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: '' },
});
globalThis.localStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); },
};
globalThis.document = {
  addEventListener() {},
  getElementById() { return null; },
  createElement(tag) {
    if (tag !== 'canvas') return {};
    return { width: 0, height: 0, getContext() { return null; } };
  },
};
globalThis.window = {
  innerWidth: 1440,
  innerHeight: 900,
  addEventListener() {},
};
globalThis.Image = class {
  set src(value) { this._src = value; }
};

const THREE = await import('three');
const { Shelf3D } = await import('../src/visual/Shelf3D.js');
const { state } = await import('../src/shared/StateManager.js');
const { eventBus } = await import('../src/shared/EventBus.js');
const {
  applyShelfWheelInput,
  normalizeWheelDelta,
  wheelDeltaToCards,
} = await import('../src/visual/ShelfWheelDynamics.js');
clearInterval(state._idleTimer);


function makeShelf() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1440 / 900, 0.1, 100);
  camera.position.set(8, 0, 16);
  camera.lookAt(8, 0, 4);
  const stage = {
    scene,
    camera,
    particleGroup: new THREE.Group(),
    enterShelfMode() {},
    exitShelfMode() {},
  };
  const shelf = new Shelf3D({ innerHTML: '' }, stage);
  shelf._redrawCard = (card) => {
    card._drawnAsCenter = card.isCenter;
  };
  return shelf;
}


function queue(length, prefix = 'Song') {
  return Array.from({ length }, (_, index) => ({
    id: index,
    title: `${prefix} ${index + 1}`,
    artist: `Artist ${index + 1}`,
  }));
}


test('shelf keeps the existing five-card pool and draws the first center action immediately', () => {
  const shelf = makeShelf();
  shelf.updateItems(queue(8));
  shelf.show();

  assert.equal(shelf._cards.length, 5);
  const center = shelf._cards.find(card => card.isCenter && card.index === 0);
  assert.ok(center);
  assert.equal(center._drawnAsCenter, true);
  assert.equal(shelf._cards.filter(card => card.mesh.visible).length, 3);
});


test('empty and replacement queues update the existing card pool without rebuilding the shelf', () => {
  const shelf = makeShelf();
  const cards = shelf._cards;
  shelf.updateItems(queue(6));
  shelf.show();
  shelf._centerIdx = 3;
  shelf._centerTarget = 3;

  shelf.updateItems([]);
  assert.equal(shelf._allItems.length, 0);
  assert.ok(shelf._cards.every(card => !card.mesh.visible && card.index === -1));

  shelf.updateItems(queue(4, 'Replacement'));
  assert.equal(shelf._cards, cards);
  assert.equal(shelf._centerIdx, 0);
  assert.equal(shelf._centerTarget, 0);
  assert.equal(shelf._allItems[0].title, 'Replacement 1');
});


test('button hit regions are derived from the card texture metadata', () => {
  const shelf = makeShelf();
  shelf.updateItems(queue(1));
  shelf.show();
  const center = shelf._cards.find(card => card.isCenter && card.index === 0);
  center._playBtn = { x: 650, y: 550, w: 210, h: 52 };
  center._plBtnCX = 906;
  center._plBtnCY = 576;
  center._plBtnR = 27;
  center.mesh.updateMatrixWorld(true);

  const playPoint = shelf._projectCanvasPoint(center, 755, 576);
  const heartPoint = shelf._projectCanvasPoint(center, 906, 576);
  assert.equal(shelf._hitTestPillButton(center, playPoint.x, playPoint.y), true);
  assert.equal(shelf._hitTestHeartButton(center, heartPoint.x, heartPoint.y), true);
  assert.equal(shelf._hitTestPillButton(center, 0, 0), false);
});


test('overlapping card hover follows the visible render stack', () => {
  const shelf = makeShelf();
  shelf.updateItems(queue(5));
  shelf.show();
  shelf._openAt = performance.now() - 1000;
  shelf.tick();

  const center = shelf._cards.find(card => card.isCenter && card.index === 0);
  const next = shelf._cards.find(card => card.index === 1);
  assert.ok(center);
  assert.ok(next);

  // Reproduce the projected overlap at the selected card's lower half.
  next.mesh.position.copy(center.mesh.position);
  next.mesh.quaternion.copy(center.mesh.quaternion);
  next.mesh.scale.copy(center.mesh.scale);
  next.mesh.renderOrder = center.mesh.renderOrder - 10;
  shelf._node.updateMatrixWorld(true);

  const lowerCenterPoint = shelf._projectCanvasPoint(center, 512, 480);
  assert.equal(shelf._pickCardAt(lowerCenterPoint.x, lowerCenterPoint.y), center);
});

test('analysis-ready events mark and redraw the matching shelf card only', () => {
  const shelf = makeShelf();
  shelf.updateItems(queue(3));
  shelf.show();
  const redraws = [];
  shelf._redrawCard = card => redraws.push(card.item?.id);

  eventBus.emit('beat-analysis:ready', { key: '1', name: 'Song 2', source: 'local-cache' });

  assert.equal(shelf._isAnalysisReady(shelf._allItems[1]), true);
  assert.equal(shelf._isAnalysisReady(shelf._allItems[0]), false);
  assert.deepEqual(redraws, [1]);
});

test('analysis status shows progress until the matching card becomes ready', () => {
  const shelf = makeShelf();
  shelf.updateItems(queue(2));
  shelf.show();
  shelf._redrawCard = () => {};

  shelf._setAnalysisStatus({ key: '1', name: 'Song 2', status: 'analyzing' });
  assert.equal(shelf._isAnalysisActive(shelf._allItems[1]), true);
  assert.equal(shelf._isAnalysisReady(shelf._allItems[1]), false);

  shelf._setAnalysisStatus({ key: '1', name: 'Song 2', status: 'ready' });
  assert.equal(shelf._isAnalysisActive(shelf._allItems[1]), false);
  assert.equal(shelf._isAnalysisReady(shelf._allItems[1]), true);
});

test('wheel deltas normalize pixel, line and page modes consistently', () => {
  assert.equal(normalizeWheelDelta(6, 0, 900), 6);
  assert.equal(normalizeWheelDelta(3, 1, 900), 48);
  assert.equal(normalizeWheelDelta(1, 2, 900), 720);
});

test('wheel shaping accumulates touchpad input and compresses extreme wheel deltas', () => {
  assert.ok(wheelDeltaToCards(2) > 0 && wheelDeltaToCards(2) < 0.1);
  assert.equal(wheelDeltaToCards(96), 1);
  assert.ok(wheelDeltaToCards(384) > 1.5);
  assert.ok(wheelDeltaToCards(10000) <= 2.75);
});

test('adaptive wheel input supports slow, fast and reversed gestures without runaway lead', () => {
  let target = 5;
  let direction = 0;
  for (let i = 0; i < 48; i++) {
    const next = applyShelfWheelInput({
      center: 5,
      target,
      deltaY: 2,
      gapMs: i ? 12 : Infinity,
      previousDirection: direction,
      maxIndex: 20,
    });
    target = next.target;
    direction = next.direction;
  }
  assert.ok(target > 5.8 && target < 6.2);

  const fast = applyShelfWheelInput({
    center: 6,
    target: 6,
    deltaY: 800,
    gapMs: 10,
    previousDirection: 1,
    maxIndex: 20,
  });
  assert.ok(fast.target > 8 && fast.target <= 10);

  const reversed = applyShelfWheelInput({
    center: 6.4,
    target: fast.target,
    deltaY: -96,
    gapMs: 18,
    previousDirection: 1,
    maxIndex: 20,
  });
  assert.equal(reversed.target, 5);
});

test('shelf wheel uses fractional targets and snaps only after the gesture settles', async () => {
  const source = await import('node:fs/promises').then(fs =>
    fs.readFile(new URL('../src/visual/Shelf3D.js', import.meta.url), 'utf8')
  );
  assert.match(source, /applyShelfWheelInput\(\{/);
  assert.match(source, /this\._wheelPendingSnap = true/);
  assert.match(source, /now - this\._wheelLastAt >= SHELF_WHEEL_SNAP_DELAY_MS/);
  assert.doesNotMatch(source, /this\._wheelAccum \+= e\.deltaY \* 0\.2/);
});
