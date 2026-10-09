import assert from 'node:assert/strict';
import test from 'node:test';
import { ParticleStage } from '../src/visual/ParticleStage.js';
import { VisualPerformance, PERFORMANCE_STORAGE_KEY } from '../src/visual/VisualPerformance.js';

function lifecycleStage() {
  const documentTarget = new EventTarget();
  documentTarget.hidden = false;
  globalThis.document = documentTarget;
  globalThis.window = new EventTarget();
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const calls = { clock: 0, reset: 0, resize: 0, frame: 0, dispose: 0 };
  const stage = Object.assign(Object.create(ParticleStage.prototype), {
    canvas: new EventTarget(), _hidden: false, _contextLost: false, _renderAccumulator: 5,
    _clock: { getDelta() { calls.clock += 1; return 1 / 60; } },
    _performance: { reset() { calls.reset += 1; }, observe() { throw Error('render must not run'); } },
    _onResize() { calls.resize += 1; },
    _frameCallback() { calls.frame += 1; },
    _disposers: [], _dotTex: { dispose() {} },
    renderer: { dispose() { calls.dispose += 1; } }, scene: { clear() {} },
  });
  stage._bindRenderingLifecycle();
  return { stage, calls, documentTarget };
}

test('actual context event handlers suspend rendering and restore timing and viewport', () => {
  const { stage, calls } = lifecycleStage();
  const lost = new Event('webglcontextlost', { cancelable: true });
  stage.canvas.dispatchEvent(lost);
  assert.equal(lost.defaultPrevented, true, 'allow the browser to restore the WebGL context');
  assert.equal(stage._contextLost, true);
  stage._animate();
  assert.equal(calls.clock, 0);
  assert.equal(calls.frame, 0);
  stage.canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(stage._contextLost, false);
  assert.equal(stage._renderAccumulator, 0);
  assert.equal(calls.clock, 1);
  assert.equal(calls.reset, 1);
  assert.equal(calls.resize, 1);
  stage.destroy();
});

test('visibility events pause expensive work and reset accumulated time when returning', () => {
  const { stage, calls, documentTarget } = lifecycleStage();
  documentTarget.hidden = true;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  stage._animate();
  assert.equal(stage._hidden, true);
  assert.equal(calls.clock, 1, 'only the visibility handler touches the clock');
  assert.equal(calls.frame, 0);
  stage._renderAccumulator = 10;
  documentTarget.hidden = false;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(stage._hidden, false);
  assert.equal(stage._renderAccumulator, 0);
  assert.equal(calls.reset, 2);
  stage.destroy();
});

test('destroy removes WebGL and visibility listeners so disposed stages cannot be reactivated', () => {
  const { stage, calls, documentTarget } = lifecycleStage();
  stage.destroy();
  stage.canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
  stage.canvas.dispatchEvent(new Event('webglcontextrestored'));
  documentTarget.hidden = true;
  documentTarget.dispatchEvent(new Event('visibilitychange'));
  assert.equal(stage._contextLost, false);
  assert.equal(stage._hidden, false);
  assert.equal(calls.clock, 0);
  assert.equal(calls.resize, 0);
  assert.equal(calls.dispose, 1);
  assert.equal(stage._frameId, null);
});

test('performance mode persists across new controllers without changing terrain density', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const first = new VisualPerformance({ storage, deviceRatio: 2 });
  first.setMode('saving');
  const reopened = new VisualPerformance({ storage, deviceRatio: 2 });
  assert.equal(values.get(PERFORMANCE_STORAGE_KEY), 'saving');
  assert.equal(reopened.mode, 'saving');
  assert.equal(reopened.pixelRatio, 1);
  reopened.setMode('high');
  assert.equal(new VisualPerformance({ storage, deviceRatio: 2 }).pixelRatio, 2);
});
