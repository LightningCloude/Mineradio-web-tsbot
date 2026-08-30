#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

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

stop_pid() {
  local name="$1"
  local pid="$2"

  echo "[stop] ${name} (pid=${pid})"
  kill -TERM "$pid" 2>/dev/null || true

  local count=0
  while kill -0 "$pid" 2>/dev/null && [[ $count -lt 10 ]]; do
    sleep 1
    count=$((count + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "[force-stop] ${name} (pid=${pid}) - graceful shutdown timeout"
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi

  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  echo "[graceful-stop] ${name} shutdown complete"
  return 0
}

stop_one() {
  local name="$1"
  local port="$2"
  local pid_file="$ROOT_DIR/logs/${name}.pid"

  local pid=""
  local handled=0
  if [[ -f "$pid_file" ]]; then
    pid=$(cat "$pid_file" 2>/dev/null || true)
    rm -f "$pid_file"
  fi

  if [[ -z "$pid" ]]; then
    pid=$(port_listener_pid "$port" || true)
  fi

  if [[ -n "$pid" ]]; then
    stop_pid "$name" "$pid" || true
    handled=1
  fi

  if port_is_listening "$port"; then
    local listener_pid
    listener_pid="$(port_listener_pid "$port" || true)"
    if [[ -n "$listener_pid" && "$listener_pid" != "$pid" ]]; then
      stop_pid "${name}/listener" "$listener_pid" || true
      handled=1
    fi
  fi

  if port_is_listening "$port"; then
    if [[ $EUID -ne 0 ]]; then
      echo "[warn] ${name} still listening on :${port}; PID info may be hidden. Try: sudo ss -lntp 'sport = :${port}'"
    else
      echo "[warn] ${name} still listening on :${port} after stop attempt"
    fi
  elif [[ "$handled" -eq 0 ]]; then
    echo "[skip] ${name} not running"
  fi
}

echo "Stopping TSBot services..."

WEB_PORT="${TSBOT_WEB_PORT:-8080}"
stop_one "web" "$WEB_PORT"
if [[ "${VITE_DEV_PORT:-5173}" != "$WEB_PORT" ]]; then
  stop_one "web-dev" "${VITE_DEV_PORT:-5173}"
fi
stop_one "backend" "${TSBOT_PORT:-8009}"
stop_one "voice" 50051

echo "All services stopped."
