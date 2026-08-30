import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQQLoginCheckQuery,
  normalizeQQLoginPayload,
} from '../src/core/QQLoginContract.js';


test('normalizes QR payload and prefers the embedded image', () => {
  const result = normalizeQQLoginPayload({
    qr_key: 'qr-key',
    ptqrtoken: 12345,
    pt_login_sig: 'login-sig',
    qr_image_base64: 'aW1hZ2U=',
    qr_url: 'https://example.test/remote-qr',
  });

  assert.equal(result.imageSrc, 'data:image/png;base64,aW1hZ2U=');
  assert.deepEqual(result.session, {
    qrKey: 'qr-key',
    ptqrtoken: '12345',
    ptLoginSig: 'login-sig',
  });
});


test('builds the backend QR check query with all required fields', () => {
  const query = new URLSearchParams(buildQQLoginCheckQuery({
    qrKey: 'qr key',
    ptqrtoken: '12345',
    ptLoginSig: 'login sig',
  }));

  assert.equal(query.get('qr_key'), 'qr key');
  assert.equal(query.get('ptqrtoken'), '12345');
  assert.equal(query.get('pt_login_sig'), 'login sig');
});


test('rejects an incomplete QR session', () => {
  assert.throws(
    () => normalizeQQLoginPayload({ qr_key: 'qr-key' }),
    /二维码会话数据不完整/,
  );
});
