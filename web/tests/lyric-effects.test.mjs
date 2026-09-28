import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';

const stored = new Map();
globalThis.localStorage = {
  getItem: key => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, value),
};
globalThis.document = { addEventListener() {} };
if (!globalThis.navigator) globalThis.navigator = { userAgent: 'test' };

const { LyricEffectsManager, lyricEffectsManager } = await import('../src/shared/LyricEffectsManager.js');
const { lyricTranslationManager } = await import('../src/shared/LyricTranslationManager.js');
const { LyricStage } = await import('../src/visual/LyricStage.js');
const { state } = await import('../src/shared/StateManager.js');
clearInterval(state._idleTimer);

// Exercise the actual meshes/materials and event handlers without a DOM canvas.
class TextureOnlyLyricStage extends LyricStage {
  _buildSunTex() { return new THREE.Texture(); }
  _buildTextTex() {
    return { tex: new THREE.Texture(), worldW: 22, worldH: 5.5, textMinUv: 0.1, textMaxUv: 0.9 };
  }
  _buildTranslationTex() { return this._buildTextTex(); }
  _tweenScale(group, from, to) { group.scale.setScalar(to); }
  _tweenMat(mat, property, value) { mat[property] = value; }
}

test('lyric ghost choice persists and remains usable when browser storage is blocked', () => {
  const events = [];
  const bus = { emit: (name, value) => events.push({ name, ...value }) };
  const manager = new LyricEffectsManager(globalThis.localStorage, bus);
  assert.equal(manager.ghostEnabled, true);
  manager.setGhostEnabled(false);
  manager.setGhostEnabled(false);
  assert.equal(new LyricEffectsManager(globalThis.localStorage, bus).ghostEnabled, false);
  assert.deepEqual(events, [{ name: 'lyric:ghostChanged', enabled: false }]);
  manager.setGhostEnabled(true);
  assert.equal(new LyricEffectsManager(globalThis.localStorage, bus).ghostEnabled, true);

  const blocked = new LyricEffectsManager({
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
  }, bus);
  blocked.setGhostEnabled(false);
  assert.equal(blocked.ghostEnabled, false);
});

test('ghost toggle updates current and outgoing lyrics without resetting progress or allocating meshes', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stage = new TextureOnlyLyricStage(new THREE.Scene(), new THREE.Camera());
  const outgoing = stage._buildGroup('上一句', 'Previous line', true);
  const current = stage._buildGroup('当前歌词', 'Current lyrics', true);
  stage._currentGroup = current;
  stage._fadeOut(outgoing);
  const material = current.userData.txt.material;
  material.uniforms.uProgress.value = 0.42;
  current.userData.translatedText.material.uniforms.uProgress.value = 0.42;

  lyricEffectsManager.setGhostEnabled(false);
  for (const group of [outgoing, current]) {
    assert.equal(group.userData.glow.visible, false);
    assert.equal(group.userData.translatedGlow.visible, false);
    assert.equal(group.userData.txt.visible, true);
  }
  assert.equal(stage._currentGroup, current);
  assert.equal(current.userData.txt.material, material);
  assert.equal(material.uniforms.uProgress.value, 0.42);
  assert.equal(current.userData.translatedText.material.uniforms.uProgress.value, 0.42);
  assert.equal(stage._groups.size, 2);

  lyricEffectsManager.setGhostEnabled(true);
  assert.equal(current.userData.glow.visible, true);
  assert.equal(outgoing.userData.glow.visible, true);
  t.mock.timers.tick(500);
  assert.equal(stage._groups.size, 1);
  stage.clear();
  stage._sunTex.dispose();
});

test('all three lyric modes inherit the saved switch and keep ghost alignment during a beat', () => {
  const stage = new TextureOnlyLyricStage(new THREE.Scene(), new THREE.Camera());
  const line = { time: 0, text: '原文', translation: 'Translation' };
  lyricEffectsManager.setGhostEnabled(false);
  for (const mode of ['original', 'translation', 'both']) {
    lyricTranslationManager.setMode(mode);
    stage._lines = [line];
    stage.highlightLine(0, line);
    const data = stage._currentGroup.userData;
    assert.equal(data.text, mode === 'translation' ? line.translation : line.text);
    assert.equal(data.glow.visible, false);
    assert.equal(data.glow.position.y, data.txt.position.y);
    stage._onBeat({ type: 'downbeat', strength: 1 });
    stage.tick(1 / 60);
    assert.deepEqual(data.glow.scale, data.txt.scale);
    if (mode === 'both') {
      assert.equal(data.translatedGlow.visible, false);
      assert.equal(data.translatedGlow.position.y, data.translatedText.position.y);
      assert.deepEqual(data.translatedGlow.scale, data.translatedText.scale);
    } else {
      assert.equal(data.translatedGlow, null);
    }
    stage.clear();
  }
  stage._sunTex.dispose();
  lyricEffectsManager.setGhostEnabled(true);
});
