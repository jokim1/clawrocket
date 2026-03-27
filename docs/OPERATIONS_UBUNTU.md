# ClawRocket Ubuntu Operations Runbook

Ubuntu `systemd --user` is the canonical production deployment path.

## 1. Install Or Refresh The User Service

```bash
cd ~/projects/clawrocket
mkdir -p ~/.config/systemd/user
cp ops/systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw
```

Optional for local-only installs. Required for public mode:

```bash
sudo loginctl enable-linger "$USER"
```

## 2. Standard Service Commands

```bash
systemctl --user status nanoclaw
systemctl --user restart nanoclaw
systemctl --user stop nanoclaw
systemctl --user start nanoclaw
journalctl --user -u nanoclaw -n 100
journalctl --user -u nanoclaw -f
```

## 3. Automated Deploys (Normal Path)

`clawtalk.app` is intended to track `main` through the GitHub Actions deploy workflow in
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

The workflow:

- triggers on pushes to `main` (and can also be run manually)
- runs on a self-hosted GitHub Actions runner installed on the Ubuntu host
- checks out the triggering commit only to source the checked-in deploy script
- runs `ops/deploy-production.sh` locally against the production checkout
- builds on the server
- restarts `nanoclaw`
- fails the deploy if local health checks do not pass

### 3.1 Self-hosted runner setup

For a private repository on GitHub Free, use a self-hosted runner instead of
GitHub-hosted SSH deploys.

Install the runner on the production host as the same Unix user that owns the
`nanoclaw` user service. For this repo, that should be `k1min8r`, not `root`.

Recommended runner location:

```bash
/home/k1min8r/actions-runner
```

Recommended labels:

- `self-hosted`
- `Linux`
- `X64`
- `alienware-prod`

The runner should be installed as a persistent service so deploys continue to
work across reboots.

### 3.2 GitHub Actions repository variables

Use repository-level `Settings -> Secrets and variables -> Actions`.

Required/expected repository variables:

- `DEPLOY_PATH` (defaults to `/home/k1min8r/projects/clawrocket`)
- `DEPLOY_SERVICE` (defaults to `nanoclaw`)

No deploy SSH secrets are needed in this model because the workflow executes on
the production host itself.

### 3.3 Server prerequisites

Before enabling the workflow, confirm the production host already has:

- the repo cloned at the deploy path
- the `nanoclaw` user service installed and working
- `sudo loginctl enable-linger "$USER"` set for public mode
- outbound HTTPS access to `nodejs.org` so deploy can refresh the repo-managed
  Node 24 LTS runtime under `.runtime/node-current`
- Cloudflare Tunnel already forwarding `clawtalk.app` to `127.0.0.1:3210`

### 3.4 What the deploy script does

`ops/deploy-production.sh` is the source of truth for both automated and manual deploys.

It:

- fetches and hard-resets the checkout to `origin/main`
- installs or refreshes the latest official Node `24.x` runtime under
  `.runtime/node-current`
- installs dependencies with `npm ci` where lockfiles exist
- builds the server and webapp bundle
- syncs the checked-in `systemd --user` unit file
- restarts `systemd --user` service `nanoclaw`
- waits for `http://127.0.0.1:3210/api/v1/health` to succeed
- exits non-zero and prints service logs if health checks fail

## 4. Manual Deploy Procedure (Emergency Or Debugging)

```bash
cd ~/projects/clawrocket
DEPLOY_PATH="$PWD" DEPLOY_SERVICE=nanoclaw bash ops/deploy-production.sh
```

Use this path when:

- GitHub Actions is unavailable
- you need to redeploy the current `main` revision manually
- you are debugging host-specific deployment failures

## 5. Runtime Verification

```bash
systemctl --user status nanoclaw
curl -i http://127.0.0.1:3210/api/v1/health
pgrep -fa "node dist/index.js"
```

Expected:

- service is `active (running)`
- health returns `200`
- one effective process owner for the active `DATA_DIR`
- `~/projects/clawrocket/.runtime/node-current/bin/node -v` reports `v24.x`

## 6. Rollback

Rollback is manual in v1.

```bash
cd ~/projects/clawrocket
git log --oneline -n 5
git reset --hard <previous-good-commit>
npm ci
npm --prefix webapp ci
npm run build
npm run build:web
systemctl --user restart nanoclaw
curl -fsS http://127.0.0.1:3210/api/v1/health
```

If `webapp/package-lock.json` is intentionally absent on a future branch, replace
`npm --prefix webapp ci` with `npm --prefix webapp install`.

If the rollback target predates the repo-managed runtime change, re-copy the
current checked-in service file after resetting:

```bash
mkdir -p ~/.config/systemd/user
cp ops/systemd/nanoclaw.service ~/.config/systemd/user/nanoclaw.service
systemctl --user daemon-reload
```

## 7. Single-Instance Guidance

ClawRocket now enforces one owner per `DATA_DIR`.

Operational guidance:

- use `systemctl --user restart nanoclaw` for normal restarts
- do not launch a second ad hoc production process against the same data dir unless you intentionally want it to take over
- if you do start a second instance, it will try to shut down the first gracefully before falling back to verified signals

Useful checks:

```bash
ls -la ~/projects/clawrocket/data/runtime/instance
cat ~/projects/clawrocket/data/runtime/instance/owner.json
```

## 8. Settings And Restart Support

The settings page can request restart only when the service environment includes:

```bash
CLAWROCKET_SELF_RESTART=1
```

That is already present in the bundled Ubuntu service file.

## 9. Talk Runtime Sanity Check

After signing in and sending a Talk message:

```bash
journalctl --user -u nanoclaw -n 200 | rg -n "direct_http|talk_run_started|talk_run_completed|talk_run_failed"
sqlite3 ~/projects/clawrocket/store/messages.db "SELECT status, created_at FROM talk_runs ORDER BY created_at DESC LIMIT 10;"
sqlite3 ~/projects/clawrocket/store/messages.db "SELECT provider_id, model_id, status, failure_class FROM llm_attempts ORDER BY created_at DESC LIMIT 20;"
```

## 10. Common Troubleshooting

### Health endpoint fails

1. Check `systemctl --user status nanoclaw`
2. Check recent logs
3. Verify DB path permissions and container runtime availability

### Unexpected takeover or process replacement

1. Check `owner.json`
2. Check whether another manual process was started against the same checkout
3. Prefer service-managed restarts instead of manual `node dist/index.js`

### Web bind issues

1. Check who owns port `3210`
2. Check whether another ClawRocket instance is already active
3. Use service restart instead of starting parallel processes

### Talk runtime failures

1. Verify Talk LLM settings in the admin UI
2. Verify provider credentials and routes
3. Inspect `llm_attempts` for failure class and fallback behavior

## 11. Public Access (Cloudflare-First)

Cloudflare Tunnel is the primary supported public deployment path for this batch.

Use [PUBLIC_ACCESS_PLAN.md](PUBLIC_ACCESS_PLAN.md) for:

- Google OAuth consent-screen setup
- test-user setup
- OAuth client creation
- redirect URI configuration

### Public-mode requirements

- `sudo loginctl enable-linger "$USER"` is required
- set:
  - `PUBLIC_MODE=true`
  - `AUTH_DEV_MODE=false`
  - `WEB_SECURE_COOKIES=true`
  - `TRUSTED_PROXY_MODE=cloudflare`
  - `INITIAL_OWNER_EMAIL=<owner-email>` unless an owner already exists
  - `GOOGLE_OAUTH_CLIENT_ID`
  - `GOOGLE_OAUTH_CLIENT_SECRET`
  - `GOOGLE_OAUTH_REDIRECT_URI=https://<your-domain>/api/v1/auth/google/callback`
  - `CLAWROCKET_PROVIDER_SECRET_KEY=<non-dev secret>`

### Outbound requirements

- `cloudflared` must reach Cloudflare on port `7844` TCP/UDP
- ClawRocket must reach `oauth2.googleapis.com` over HTTPS

### Cloudflare Tunnel summary

1. Install `cloudflared`
2. Run `cloudflared tunnel login`
3. Create a tunnel
4. Configure `/etc/cloudflared/config.yml` to forward the public hostname to `http://127.0.0.1:3210`
5. Install the `cloudflared` system service with an explicit `--config` path

### Cloudflare WAF auth throttling

Recommended free-plan rule:

- URI path starts with `/api/v1/auth/`
- threshold: `5 requests / 10 seconds / IP`
- mitigation timeout: `10 seconds`

### Verification summary

After the tunnel is live:

- verify `/api/v1/health`
- complete Google sign-in over HTTPS
- verify `/api/v1/session/me`
- verify a CSRF-protected Talk write
- verify `/api/v1/events?stream=1` and leave it open for 2-3 minutes
- verify device auth returns `403`
- verify app-side auth throttling before enabling Cloudflare WAF
- verify Cloudflare WAF throttling after enabling the rule

### Rollback

To return to local-only access:

```bash
sudo systemctl stop cloudflared
```

Then set:

- `PUBLIC_MODE=false`
- `TRUSTED_PROXY_MODE=none`

If you also revert to plain localhost HTTP, set:

- `WEB_SECURE_COOKIES=false`
