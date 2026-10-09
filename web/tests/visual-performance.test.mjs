import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisualPerformance, PERFORMANCE_STORAGE_KEY } from '../src/visual/VisualPerformance.js';

test('default preserves current resolution; storage failure is harmless', () => {
  const policy = new VisualPerformance({ deviceRatio: 3, storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
  assert.equal(policy.mode, 'high');
  assert.equal(policy.pixelRatio, 2);
  for (let i = 0; i < 200; i++) policy.observe(1 / 20);
  assert.equal(policy.pixelRatio, 2);
  policy.setMode('saving');
  assert.equal(policy.pixelRatio, 1);
});

test('automatic resolution responds to sustained slow frames, not isolated spikes', () => {
  const data = new Map([[PERFORMANCE_STORAGE_KEY, 'auto']]);
  const policy = new VisualPerformance({ deviceRatio: 2, storage: { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) } });
  policy.observe(2);
  for (let i = 0; i < 20; i++) policy.observe(1 / 30);
  assert.equal(policy.pixelRatio, 2);
  for (let i = 0; i < 120; i++) policy.observe(1 / 30);
  assert.ok(policy.pixelRatio < 2);
  const lowered = policy.pixelRatio;
  policy.reset();
  for (let i = 0; i < 630; i++) policy.observe(1 / 60);
  assert.ok(policy.pixelRatio > lowered);
  policy.idle = true;
  assert.ok(policy.pixelRatio <= 1);
  policy.setMode('high');
  assert.equal(data.get(PERFORMANCE_STORAGE_KEY), 'high');
});
