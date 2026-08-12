#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p logs

if [[ -f "$ROOT_DIR/tsbot.env" ]]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/tsbot.env"
fi

port_listener_pid() {
  local port="$1"
  ss -ltnp "sport = :${port}" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | head -n1
}

port_is_listening() {
  local port="$1"
  ss -ltnH "sport = :${port}" 2>/dev/null | grep -q .
}

start_one() {
  local name="$1"
  local port="$2"
  local log_file="$3"
  local cmd="$4"

  local pid
  pid="$(port_listener_pid "$port" || true)"
  if port_is_listening "$port"; then
    if [[ -n "${pid}" ]]; then
      echo "[skip] ${name} already listening on :${port} (pid=${pid})"
    else
      echo "[skip] ${name} already listening on :${port} (pid hidden; try sudo ss -lntp 'sport = :${port}')"
    fi
    return 0
  fi

  echo "[start] ${name}"
  nohup bash -lc "cd '$ROOT_DIR' && if [[ -f '$ROOT_DIR/tsbot.env' ]]; then source '$ROOT_DIR/tsbot.env'; fi; exec ${cmd}" >>"$log_file" 2>&1 &
  echo $! >"$ROOT_DIR/logs/${name}.pid"
}

start_one "voice" 50051 "$ROOT_DIR/logs/voice.log" "env HOME=/home/${SUDO_USER:-$USER} bash ./run-voicemake.sh"

BACKEND_PORT="${TSBOT_PORT:-8009}"
start_one "backend" "$BACKEND_PORT" "$ROOT_DIR/logs/backend.log" "./run-backend.sh"

WEB_PORT="${TSBOT_WEB_PORT:-8080}"
start_one "web" "$WEB_PORT" "$ROOT_DIR/logs/web.log" "./run-web.sh"

echo ""
"$ROOT_DIR/nohup-status.sh" || true
