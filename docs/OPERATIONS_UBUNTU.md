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

## 3. Deploy Procedure

```bash
cd ~/projects/clawrocket
git pull --ff-only origin main
npm install
npm run build
systemctl --user restart nanoclaw
```

If the webapp bundle is part of the deploy:

```bash
npm run build:web
```

## 4. Runtime Verification

```bash
systemctl --user status nanoclaw
curl -i http://127.0.0.1:3210/api/v1/health
pgrep -fa "node dist/index.js"
```

Expected:

- service is `active (running)`
- health returns `200`
- one effective process owner for the active `DATA_DIR`

## 5. Single-Instance Guidance

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

## 6. Settings And Restart Support

The settings page can request restart only when the service environment includes:

```bash
CLAWROCKET_SELF_RESTART=1
```

That is already present in the bundled Ubuntu service file.

## 7. Talk Runtime Sanity Check

After signing in and sending a Talk message:

```bash
journalctl --user -u nanoclaw -n 200 | rg -n "direct_http|talk_run_started|talk_run_completed|talk_run_failed"
sqlite3 ~/projects/clawrocket/data/messages.db "SELECT status, created_at FROM talk_runs ORDER BY created_at DESC LIMIT 10;"
sqlite3 ~/projects/clawrocket/data/messages.db "SELECT provider_id, model_id, status, failure_class FROM llm_attempts ORDER BY created_at DESC LIMIT 20;"
```

## 8. Common Troubleshooting

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

## 9. Public Access (Cloudflare-First)

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
