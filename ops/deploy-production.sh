#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-$(pwd)}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-nanoclaw}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3210/api/v1/health}"
DEPLOY_HEALTH_INTERVAL="${DEPLOY_HEALTH_INTERVAL:-2}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-60}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-$DEPLOY_PATH/data/runtime/deploy.lock}"

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

log() {
  printf '[deploy] %s\n' "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '[deploy] missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

wait_for_health() {
  local max_attempts
  max_attempts=$((DEPLOY_WAIT_SECONDS / DEPLOY_HEALTH_INTERVAL))
  if (( max_attempts < 1 )); then
    max_attempts=1
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if systemctl --user is-active --quiet "$DEPLOY_SERVICE" &&
      curl -fsS "$DEPLOY_HEALTH_URL" >/dev/null; then
      return 0
    fi
    sleep "$DEPLOY_HEALTH_INTERVAL"
  done

  return 1
}

require_command git
require_command npm
require_command curl
require_command systemctl
require_command flock

if [[ ! -d "$DEPLOY_PATH/.git" ]]; then
  printf '[deploy] repo checkout not found at %s\n' "$DEPLOY_PATH" >&2
  exit 1
fi

mkdir -p "$(dirname "$DEPLOY_LOCK_FILE")"
exec 9>"$DEPLOY_LOCK_FILE"
if ! flock -n 9; then
  printf '[deploy] another deployment is already running\n' >&2
  exit 1
fi

cd "$DEPLOY_PATH"

current_sha="$(git rev-parse --short HEAD 2>/dev/null || true)"
log "Current SHA: ${current_sha:-unknown}"

log "Fetching ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
git fetch "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
git switch "$DEPLOY_BRANCH"
target_ref="${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
target_sha="$(git rev-parse --short "$target_ref")"

if [[ "${current_sha:-}" == "$target_sha" ]]; then
  log "Already at ${target_sha}; rebuilding and restarting anyway"
else
  log "Deploying ${target_sha}"
fi

git reset --hard "$target_ref"

if [[ -f package-lock.json ]]; then
  log "Installing root dependencies with npm ci"
  npm ci
else
  log "package-lock.json missing; falling back to npm install"
  npm install
fi

if [[ -f webapp/package.json ]]; then
  if [[ -f webapp/package-lock.json ]]; then
    log "Installing webapp dependencies with npm ci"
    npm --prefix webapp ci
  else
    log "webapp/package-lock.json missing; falling back to npm install"
    npm --prefix webapp install
  fi
fi

log "Building server"
npm run build

if [[ -f webapp/package.json ]]; then
  log "Building webapp"
  npm run build:web
fi

log "Restarting ${DEPLOY_SERVICE}"
systemctl --user restart "$DEPLOY_SERVICE"

if ! wait_for_health; then
  printf '[deploy] service failed health checks after restart\n' >&2
  systemctl --user status "$DEPLOY_SERVICE" --no-pager || true
  journalctl --user -u "$DEPLOY_SERVICE" -n 100 --no-pager || true
  exit 1
fi

deployed_sha="$(git rev-parse HEAD)"
log "Deployment healthy at ${deployed_sha}"
