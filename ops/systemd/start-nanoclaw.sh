#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
NODE_RUNTIME_DIR="${NODE_RUNTIME_DIR:-$APP_DIR/.runtime/node-current}"

cd "$APP_DIR"

if [[ -x "$NODE_RUNTIME_DIR/bin/npm" ]]; then
  export PATH="$NODE_RUNTIME_DIR/bin:$PATH"
  exec "$NODE_RUNTIME_DIR/bin/npm" start
fi

exec npm start
