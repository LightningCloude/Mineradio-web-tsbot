export const WEBSOCKET_PROTOCOL = 'minerats-v1';
export const WEBSOCKET_TOKEN_PREFIX = 'minerats-token.';


export function buildWebSocketProtocols(token) {
  const normalized = (token || '').trim();
  if (!normalized) return undefined;

  const bytes = new TextEncoder().encode(normalized);
  const binary = String.fromCharCode(...bytes);
  const encoded = btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return [WEBSOCKET_PROTOCOL, `${WEBSOCKET_TOKEN_PREFIX}${encoded}`];
}
