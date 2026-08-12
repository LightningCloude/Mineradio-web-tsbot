#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/tsbot.env" ]]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/tsbot.env"
fi

VOICE_PORT="50051"
BACKEND_PORT="${TSBOT_PORT:-8009}"
WEB_PORT="${TSBOT_WEB_PORT:-8080}"
DEV_WEB_PORT="${VITE_DEV_PORT:-5173}"
PORT_PATTERN="${VOICE_PORT}|${BACKEND_PORT}|${WEB_PORT}"
if [[ "$DEV_WEB_PORT" != "$WEB_PORT" ]]; then
  PORT_PATTERN="${PORT_PATTERN}|${DEV_WEB_PORT}"
fi

echo "ports:"
ss -ltnp | grep -E ":(${PORT_PATTERN})\\b" || true

echo ""
echo "logs:"
echo "  tail -f $ROOT_DIR/logs/voice.log"
echo "  tail -f $ROOT_DIR/logs/backend.log"
echo "  tail -f $ROOT_DIR/logs/web.log"
