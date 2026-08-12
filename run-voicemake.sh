#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/tsbot.env" ]]; then
  source "$ROOT_DIR/tsbot.env"
fi

mkdir -p "$ROOT_DIR/logs"

if [[ -z "${TSBOT_TS3_IDENTITY_FILE:-}" ]]; then
  export TSBOT_TS3_IDENTITY_FILE="$ROOT_DIR/logs/identity.json"
elif [[ "${TSBOT_TS3_IDENTITY_FILE}" != /* ]]; then
  export TSBOT_TS3_IDENTITY_FILE="$ROOT_DIR/${TSBOT_TS3_IDENTITY_FILE#./}"
fi

CARGO_BIN="$HOME/.cargo/bin/cargo"
if [[ ! -x "$CARGO_BIN" ]]; then
  CARGO_BIN="$(command -v cargo || true)"
fi

if [[ -z "${CARGO_BIN:-}" ]]; then
  echo "cargo not found in \$HOME/.cargo/bin or PATH" >&2
  exit 1
fi

VOICE_BIN="$ROOT_DIR/voice-service/target/debug/voice-service"

echo "Building voice service..."
"$CARGO_BIN" build --manifest-path "$ROOT_DIR/voice-service/Cargo.toml" --locked

if [[ ! -x "$VOICE_BIN" ]]; then
  echo "voice-service binary not found at $VOICE_BIN" >&2
  exit 1
fi

: "${TSBOT_TS3_HOST:?Set TSBOT_TS3_HOST in tsbot.env before starting voice-service}"
export TSBOT_TS3_HOST
export TSBOT_TS3_PORT="${TSBOT_TS3_PORT:-9987}"
export TSBOT_TS3_NICKNAME="${TSBOT_TS3_NICKNAME:-tsbot}"
export TSBOT_TS3_CHANNEL_ID="${TSBOT_TS3_CHANNEL_ID:-2}"

echo "Starting voice service..."
echo "Use Ctrl+C to stop gracefully"
exec "$VOICE_BIN" 127.0.0.1:50051
