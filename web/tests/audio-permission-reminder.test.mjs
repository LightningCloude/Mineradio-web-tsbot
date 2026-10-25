import assert from 'node:assert/strict';
import test from 'node:test';
import { AudioPermissionReminderState, AudioPermissionReminder } from '../src/player/AudioPermissionReminder.js';

test('already using a visual preset without capture shows a reminder immediately', () => {
  const model = new AudioPermissionReminderState({ active: false });
  model.selectPreset(2);
  assert.equal(model.visible, true);
});

test('authorized audio never prompts, even after changing presets', () => {
  const model = new AudioPermissionReminderState({ active: true });
  model.selectPreset(2, true);
  assert.equal(model.visible, false);
});

test('later suppresses repeated updates but switching to another preset reminds again', () => {
  const model = new AudioPermissionReminderState({ active: false });
  model.selectPreset(0);
  model.dismiss();
  for (let i = 0; i < 100; i++) model.updateCapture({ active: false });
  model.selectPreset(0, true);
  assert.equal(model.visible, false);
  model.selectPreset(2, true);
  assert.equal(model.visible, true);
});

test('ending an active audio share shows a new reminder after an earlier dismissal', () => {
  const model = new AudioPermissionReminderState({ active: false });
  model.dismiss();
  model.updateCapture({ active: true });
  assert.equal(model.visible, false);
  model.updateCapture({ active: false });
  assert.equal(model.visible, true);
});

test('requesting capture does not lose the reminder or reopen a dismissed one', () => {
  const model = new AudioPermissionReminderState({ active: false });
  model.updateCapture({ active: false, status: 'requesting' });
  assert.equal(model.visible, true);
  model.dismiss();
  model.updateCapture({ active: false, status: 'idle' });
  assert.equal(model.visible, false);
});

test('only explicit authorize requests capture; unsupported and duplicate requests do not', async () => {
  let calls = 0;
  const capture = { active: false, supported: true, status: 'idle', async start() { calls++; } };
  const controller = Object.create(AudioPermissionReminder.prototype);
  controller.capture = capture;
  await controller.authorize();
  assert.equal(calls, 1);
  capture.status = 'requesting';
  await controller.authorize();
  capture.status = 'idle';
  capture.supported = false;
  await controller.authorize();
  capture.supported = true;
  capture.active = true;
  await controller.authorize();
  assert.equal(calls, 1);
});

test('denied authorization keeps the reminder and displays the returned error safely', async () => {
  const controller = Object.create(AudioPermissionReminder.prototype);
  controller.capture = {
    active: false, supported: true, status: 'idle',
    async start() { throw new Error('未授权系统音频捕获'); },
    snapshot() { return { active: false }; },
  };
  controller.model = new AudioPermissionReminderState({ active: false });
  controller.render = error => { controller.lastError = error; };
  await controller.authorize();
  assert.equal(controller.model.visible, true);
  assert.equal(controller.lastError, '未授权系统音频捕获');
});
