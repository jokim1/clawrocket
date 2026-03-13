# ClawRocket Public Access Plan

This document is the current reference for the **v11 self-hosted public-access path**.

Current batch scope:

- manual setup first
- Cloudflare Tunnel as the primary verified public path
- Caddy proxy mode supported in code, but not the primary batch-1 ops path
- `setup-public` CLI deferred
- managed `*.clawtalk.app` platform deferred

Existing local-only installs require **no config changes**. The new startup guards only apply when public mode is active.

## 1. What This Batch Ships

The current implementation adds:

- canonical `isPublicMode` detection
- fail-closed startup guards for public deployments
- `INITIAL_OWNER_EMAIL` first-owner bootstrap
- device auth disabled in public mode
- proxy-aware client IP extraction via `TRUSTED_PROXY_MODE`
- Cloudflare-first docs, verification steps, and rollback steps

## 2. Public Mode Behavior

Public mode is active when **any** of these are true:

- `PUBLIC_MODE=true`
- `TRUSTED_PROXY_MODE != none`
- `GOOGLE_OAUTH_REDIRECT_URI` is a non-localhost URL

When public mode is active, startup fails unless:

- `AUTH_DEV_MODE=false`
- `WEB_SECURE_COOKIES=true`
- `CLAWROCKET_PROVIDER_SECRET_KEY` is set and is not the unsafe dev fallback
- `TRUSTED_PROXY_MODE` is set to `cloudflare` or `caddy`
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and a non-localhost `GOOGLE_OAUTH_REDIRECT_URI` are set
- either `INITIAL_OWNER_EMAIL` is set or an owner already exists in the DB

At runtime:

- device auth returns `403` in public mode
- when no owner exists, only `INITIAL_OWNER_EMAIL` may claim owner
- once an owner exists, `INITIAL_OWNER_EMAIL` is ignored and normal invite logic applies
- if forwarded headers are seen while public mode is off, ClawRocket logs a once-per-process warning

## 3. Required Environment

Minimum public-mode env:

```bash
PUBLIC_MODE=true
AUTH_DEV_MODE=false
WEB_SECURE_COOKIES=true
INITIAL_OWNER_EMAIL=you@gmail.com
TRUSTED_PROXY_MODE=cloudflare
GOOGLE_OAUTH_CLIENT_ID=<google-client-id>
GOOGLE_OAUTH_CLIENT_SECRET=<google-client-secret>
GOOGLE_OAUTH_REDIRECT_URI=https://clawtalk.app/api/v1/auth/google/callback
CLAWROCKET_PROVIDER_SECRET_KEY=<openssl rand -hex 32>
```

For local-only installs:

- leave `PUBLIC_MODE=false`
- keep `TRUSTED_PROXY_MODE=none`
- you may continue using localhost redirect and dev auth mode

## 4. Google OAuth Setup

This section is the authoritative walkthrough for Google Cloud configuration.

### 4.1 Create or choose a Google Cloud project

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project or select an existing one for this ClawRocket install.

### 4.2 Configure the consent screen

1. Go to [OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent).
2. Choose `External` unless you are intentionally limiting access to a Google Workspace org.
3. Fill in:
   - app name
   - user support email
   - developer contact email
4. Ensure the standard Google Sign-In scopes are available:
   - `openid`
   - `email`
   - `profile`
5. Save the consent screen.

### 4.3 Testing mode

By default the app starts in `Testing` mode.

Implications:

- only listed Google test users can sign in
- this is the expected default for early self-hosted installs
- for self or family use, add the owner account and any family members who need access

Google currently allows up to 100 test users.

### 4.4 Create the OAuth client

1. Go to [Credentials](https://console.cloud.google.com/apis/credentials).
2. Create an `OAuth 2.0 Client ID`.
3. Choose `Web application`.
4. Set Authorized JavaScript origins:
   - `https://clawtalk.app`
5. Set Authorized redirect URIs:
   - `https://clawtalk.app/api/v1/auth/google/callback`
6. Save the client and copy:
   - client ID
   - client secret

Important:

- the callback path is `/api/v1/auth/google/callback`
- do **not** use `/api/v1/session/oauth/callback`

### 4.5 Publishing later is optional

For broader multi-user access, the operator may later publish the Google app. That requires:

- verified authorized domain in Google Search Console
- public homepage on that domain
- privacy policy page on that domain

This is **not** required for the default self/family testing-mode path.

## 5. Manual Cloudflare Tunnel Path

This is the primary verified public deployment path for batch 1.

### 5.1 Prerequisites

- Cloudflare-managed DNS for the domain
- ClawRocket running locally on `127.0.0.1:3210`
- outbound egress from the server:
  - `cloudflared` to Cloudflare on port `7844` TCP/UDP
  - ClawRocket HTTPS access to `oauth2.googleapis.com`

### 5.2 Install and authenticate cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
```

### 5.3 Create the tunnel

```bash
cloudflared tunnel create clawrocket
```

### 5.4 Configure `/etc/cloudflared/config.yml`

```yaml
tunnel: <TUNNEL_UUID>
credentials-file: /etc/cloudflared/<TUNNEL_UUID>.json

ingress:
  - hostname: clawtalk.app
    service: http://127.0.0.1:3210
  - service: http_status:404
```

Copy the credentials JSON into `/etc/cloudflared/`, then install the service with an explicit config path:

```bash
sudo cloudflared --config /etc/cloudflared/config.yml service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

### 5.5 Cloudflare WAF rate limiting

Create a WAF rate-limiting rule for `/api/v1/auth/*`.

Recommended free-plan rule:

- match: URI path starts with `/api/v1/auth/`
- threshold: `5 requests / 10 seconds / IP`
- mitigation: block for `10 seconds`

Notes:

- Cloudflare free plan allows only one rate-limit rule for the zone
- if that single rule is already in use elsewhere on the zone, ClawRocket gets no edge auth throttling

## 6. Verification Checklist

After the tunnel is live:

1. `curl -i https://clawtalk.app/api/v1/health`
2. sign in with the `INITIAL_OWNER_EMAIL` account
3. verify `/api/v1/session/me`
4. verify a CSRF-protected Talk write
5. verify `/api/v1/events?stream=1`
6. keep the SSE stream open for 2-3 minutes and confirm keepalives continue
7. verify device auth returns `403`
8. verify app-side auth rate limiting before enabling edge rate limits
9. enable the Cloudflare WAF rule and verify edge throttling
10. verify another account:
   - reaches `invite_required` if it is also a Google test user
   - or is blocked by Google first while the app remains in Testing mode

## 7. Rollback

To revert to local-only access:

1. stop the `cloudflared` service
2. set:
   - `PUBLIC_MODE=false`
   - `TRUSTED_PROXY_MODE=none`
3. restore local-only redirect/auth settings as needed
4. if returning to plain localhost HTTP, set `WEB_SECURE_COOKIES=false`

## 8. Deferred Managed Platform Working Assumptions

These are working assumptions only. They are **not** committed product decisions.

- any future managed `*.clawtalk.app` platform is a separate hosted product
- centralized identity and managed transport are likely directions, but the architecture is unresolved
- pricing, billing, entitlement enforcement, abuse handling, privacy scope, and platform governance remain unresolved
- no migration path is assumed between self-hosted mode and any future managed mode
- if a managed mode is built later, it can be treated as fresh-instance onboarding
