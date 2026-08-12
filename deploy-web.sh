#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/tsbot.env" ]]; then
  # shellcheck disable=SC1090
  source "$ROOT_DIR/tsbot.env"
fi

PYTHON_BIN="$ROOT_DIR/backend/.venv/bin/python"
if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || command -v python || true)"
fi

if [[ -z "${PYTHON_BIN:-}" ]]; then
  echo "python not found; install Python 3 or create backend/.venv first" >&2
  exit 2
fi

exec "$PYTHON_BIN" "$ROOT_DIR/scripts/deploy_web.py" "$@"
