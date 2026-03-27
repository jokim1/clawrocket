#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${DEPLOY_PATH:-$(pwd)}"
DEPLOY_SERVICE="${DEPLOY_SERVICE:-nanoclaw}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3210/api/v1/health}"
DEPLOY_HEALTH_INTERVAL="${DEPLOY_HEALTH_INTERVAL:-2}"
DEPLOY_HEALTH_CONNECT_TIMEOUT="${DEPLOY_HEALTH_CONNECT_TIMEOUT:-2}"
DEPLOY_HEALTH_MAX_TIME="${DEPLOY_HEALTH_MAX_TIME:-5}"
DEPLOY_WAIT_SECONDS="${DEPLOY_WAIT_SECONDS:-180}"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-$DEPLOY_PATH/data/runtime/deploy.lock}"
MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED="${MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED:-}"
NODE_RUNTIME_MAJOR="${NODE_RUNTIME_MAJOR:-24}"
NODE_RUNTIME_ROOT="${NODE_RUNTIME_ROOT:-$DEPLOY_PATH/.runtime}"
NODE_RUNTIME_LINK_NAME="${NODE_RUNTIME_LINK_NAME:-node-current}"
NODE_RUNTIME_BASE_URL="${NODE_RUNTIME_BASE_URL:-https://nodejs.org/dist/latest-v${NODE_RUNTIME_MAJOR}.x}"

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
  local max_attempts attempt elapsed service_state
  max_attempts=$(((DEPLOY_WAIT_SECONDS + DEPLOY_HEALTH_INTERVAL - 1) / DEPLOY_HEALTH_INTERVAL))
  if (( max_attempts < 1 )); then
    max_attempts=1
  fi

  log "Waiting up to ${DEPLOY_WAIT_SECONDS}s for ${DEPLOY_SERVICE} health at ${DEPLOY_HEALTH_URL}"

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if systemctl --user is-active --quiet "$DEPLOY_SERVICE" &&
      curl --fail --silent --show-error \
        --connect-timeout "$DEPLOY_HEALTH_CONNECT_TIMEOUT" \
        --max-time "$DEPLOY_HEALTH_MAX_TIME" \
        "$DEPLOY_HEALTH_URL" >/dev/null; then
      elapsed=$((attempt * DEPLOY_HEALTH_INTERVAL))
      log "Service reported healthy after ${elapsed}s"
      return 0
    fi

    if (( attempt == 1 || attempt == max_attempts || attempt % 5 == 0 )); then
      service_state="$(systemctl --user is-active "$DEPLOY_SERVICE" 2>/dev/null || true)"
      log "Health still pending (${attempt}/${max_attempts}); service state=${service_state:-unknown}"
    fi

    sleep "$DEPLOY_HEALTH_INTERVAL"
  done

  return 1
}

require_command git
require_command curl
require_command tar
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

resolve_node_runtime_dist() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "${os}/${arch}" in
    Linux/x86_64)
      printf 'linux-x64\n'
      ;;
    Linux/aarch64 | Linux/arm64)
      printf 'linux-arm64\n'
      ;;
    Darwin/x86_64)
      printf 'darwin-x64\n'
      ;;
    Darwin/arm64)
      printf 'darwin-arm64\n'
      ;;
    *)
      printf '[deploy] unsupported platform for managed Node runtime: %s/%s\n' "$os" "$arch" >&2
      exit 1
      ;;
  esac
}

compute_sha256() {
  local target="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
    return
  fi

  printf '[deploy] missing sha256 tool (need sha256sum or shasum)\n' >&2
  exit 1
}

ensure_repo_node_runtime() {
  local dist shasums tarball expected_sha version install_dir tmpdir archive actual_sha
  dist="$(resolve_node_runtime_dist)"
  mkdir -p "$NODE_RUNTIME_ROOT"

  shasums="$(curl --fail --silent --show-error "${NODE_RUNTIME_BASE_URL}/SHASUMS256.txt")"
  tarball="$(
    printf '%s\n' "$shasums" |
      awk '{print $2}' |
      grep -E "^node-v[0-9.]+-${dist}\\.tar\\.xz$" |
      head -n 1
  )"

  if [[ -z "$tarball" ]]; then
    printf '[deploy] could not resolve a Node %s runtime tarball for %s\n' "$NODE_RUNTIME_MAJOR" "$dist" >&2
    exit 1
  fi

  expected_sha="$(
    printf '%s\n' "$shasums" |
      awk -v target="$tarball" '$2==target {print $1; exit}'
  )"
  version="${tarball#node-v}"
  version="${version%-${dist}.tar.xz}"
  install_dir="$NODE_RUNTIME_ROOT/node-v${version}-${dist}"

  if [[ ! -x "$install_dir/bin/node" ]]; then
    log "Installing Node ${version} (${dist}) into ${install_dir}"
    tmpdir="$(mktemp -d)"
    archive="$tmpdir/$tarball"
    trap 'rm -rf "$tmpdir"' RETURN
    curl --fail --location --silent --show-error \
      "${NODE_RUNTIME_BASE_URL}/${tarball}" \
      --output "$archive"
    actual_sha="$(compute_sha256 "$archive")"
    if [[ "$expected_sha" != "$actual_sha" ]]; then
      printf '[deploy] checksum mismatch for %s\n' "$tarball" >&2
      printf '[deploy] expected %s\n' "$expected_sha" >&2
      printf '[deploy] actual   %s\n' "$actual_sha" >&2
      exit 1
    fi
    tar -xJf "$archive" -C "$NODE_RUNTIME_ROOT"
    rm -rf "$tmpdir"
    trap - RETURN
  fi

  ln -sfn "$install_dir" "$NODE_RUNTIME_ROOT/$NODE_RUNTIME_LINK_NAME"
  export PATH="$NODE_RUNTIME_ROOT/$NODE_RUNTIME_LINK_NAME/bin:$PATH"
  log "Using Node runtime $(node -v) / npm $(npm -v)"
}

sync_systemd_unit() {
  local source target
  source="$DEPLOY_PATH/ops/systemd/${DEPLOY_SERVICE}.service"
  target="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${DEPLOY_SERVICE}.service"

  if [[ ! -f "$source" ]]; then
    printf '[deploy] systemd unit source not found: %s\n' "$source" >&2
    exit 1
  fi

  chmod +x "$DEPLOY_PATH/ops/systemd/start-nanoclaw.sh"
  mkdir -p "$(dirname "$target")"
  if [[ ! -f "$target" ]] || ! cmp -s "$source" "$target"; then
    log "Syncing systemd user service unit to ${target}"
    cp "$source" "$target"
    systemctl --user daemon-reload
  fi
}

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

ensure_repo_node_runtime
require_command node
require_command npm

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

if [[ -n "$MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED" ]]; then
  log "Setting systemd user environment: MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED=${MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED}"
  systemctl --user set-environment \
    "MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED=${MAIN_SUBSCRIPTION_WARM_WORKER_ENABLED}"
fi

sync_systemd_unit

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
