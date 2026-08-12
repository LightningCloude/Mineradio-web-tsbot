#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/tsbot.env" ]]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/tsbot.env"
fi

HOST="${TSBOT_WEB_HOST:-127.0.0.1}"
PORT="${TSBOT_WEB_PORT:-8080}"

HOST="${HOST//$'\r'/}"
HOST="${HOST#http://}"
HOST="${HOST#https://}"
HOST="${HOST%%/*}"
HOST="${HOST%%:*}"

PORT="${PORT//$'\r'/}"
PORT="${PORT#:}"

cd "$ROOT_DIR/web"
npm run build
exec npm run preview -- --host "$HOST" --port "$PORT"
