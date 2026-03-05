# NanoClaw Ubuntu Operations Runbook

This runbook is the canonical production workflow for Ubuntu hosts.
Use a user-level `systemd` service (`nanoclaw.service`) and avoid `nohup`.

## One-Time Migration Cutover (from nohup/manual)

Run these once before enabling the service:

```bash
cd ~/projects/clawrocket

# Stop unmanaged process(es) first.
pkill -f "node dist/index.js" || true
systemctl --user stop nanoclaw || true

# Remove stale web-talk containers that may keep old runner behavior.
docker ps --filter name=nanoclaw-web-talks -q | xargs -r docker rm -f

# Verify clean slate (required to avoid EADDRINUSE / duplicate polling).
pgrep -fa "node dist/index.js" || true
lsof -iTCP:3210 -sTCP:LISTEN || true
```

Expected:
- `pgrep` prints nothing.
- `lsof` prints nothing.

## Install and Enable systemd User Service

```bash
cd ~/projects/clawrocket
mkdir -p ~/.config/systemd/user
cp ops/systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw
```

Optional (start on boot even without active login session):

```bash
sudo loginctl enable-linger k1min8r
```

## Daily Service Commands

```bash
# Status
systemctl --user status nanoclaw

# Restart
systemctl --user restart nanoclaw

# Stop
systemctl --user stop nanoclaw

# Start
systemctl --user start nanoclaw

# Recent logs
journalctl --user -u nanoclaw -n 100

# Follow logs live
journalctl --user -u nanoclaw -f
```

## Standard Deploy / Update Procedure

```bash
cd ~/projects/clawrocket
git pull --ff-only origin main
npm install
npm run build

# Sync agent-runner source to all existing group session folders.
mkdir -p data/sessions
for group_dir in data/sessions/*; do
  [ -d "$group_dir" ] || continue
  mkdir -p "$group_dir/agent-runner-src"
  rsync -a --delete container/agent-runner/src/ "$group_dir/agent-runner-src/"
done

systemctl --user restart nanoclaw
```

Notes:
- The sync loop intentionally updates all existing groups, not just `web-talks`.
- If `data/sessions/*` has no directories yet, the loop safely no-ops.

## Verification Checklist

```bash
# Service + API
systemctl --user status nanoclaw
curl -i http://127.0.0.1:3210/api/v1/health

# Single-instance guard
pgrep -fa "node dist/index.js"

# Check for duplicate Telegram polling conflicts
journalctl --user -u nanoclaw -n 200 | rg -n "getUpdates|409|Conflict" || true
```

Expected:
- Health returns `200`.
- One effective runtime chain (`sh -c ...` wrapper + `node dist/index.js` child).
- No recurring `getUpdates 409` conflict messages.

## Talk Execution Sanity Check

After signing in and sending one message:

```bash
BASE="http://127.0.0.1:3210"
TALK_ID="<talk-id>"

curl -s -b /tmp/claw_cookies.txt "$BASE/api/v1/talks/$TALK_ID/events?stream=0" \
  | rg -n "talk_run_started|talk_run_completed|talk_run_failed"
```

Expected:
- For the latest run: `talk_run_started` followed by `talk_run_completed` or `talk_run_failed`.

## Troubleshooting

### `EADDRINUSE` or `ERR_CONNECTION_REFUSED`
1. Ensure only service-managed process is running:
   - `pkill -f "node dist/index.js" || true`
2. Restart service:
   - `systemctl --user restart nanoclaw`
3. Re-check health endpoint.

### Telegram `getUpdates 409 Conflict`
1. Check for duplicate app processes.
2. Stop all unmanaged processes.
3. Restart only via `systemctl --user restart nanoclaw`.

### Stale `agent-runner-src` behavior
Run the all-group sync loop from the deploy procedure, then restart service.
