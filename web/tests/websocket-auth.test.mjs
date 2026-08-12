import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WEBSOCKET_PROTOCOL,
  WEBSOCKET_TOKEN_PREFIX,
  buildWebSocketProtocols,
} from '../src/core/WebSocketAuth.js';


test('omits WebSocket protocols when API token protection is disabled', () => {
  assert.equal(buildWebSocketProtocols(''), undefined);
});


test('encodes the API token in a URL-safe WebSocket subprotocol', () => {
  const protocols = buildWebSocketProtocols('令牌 token+/=');

  assert.equal(protocols[0], WEBSOCKET_PROTOCOL);
  assert.ok(protocols[1].startsWith(WEBSOCKET_TOKEN_PREFIX));

  const encoded = protocols[1].slice(WEBSOCKET_TOKEN_PREFIX.length);
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
  const decoded = Buffer.from(
    encoded.replace(/-/g, '+').replace(/_/g, '/') + padding,
    'base64',
  ).toString('utf8');
  assert.equal(decoded, '令牌 token+/=');
});
