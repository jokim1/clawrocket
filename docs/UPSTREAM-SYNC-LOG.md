# Upstream Sync Log

## Baseline

- Date: 2026-03-03
- ClawRocket baseline tag: `pre-realign-baseline`
- Upstream remote: `https://github.com/qwibitai/nanoclaw.git`
- Realignment target tag: `v1.2.0`

## Sync Entries

### 2026-03-04 - Post-Cutover Server Smoke Validation

- Upstream range/tag: `v1.2.0` baseline (running default branch `codex/realign-upstream-v1.2.0`)
- Environment:
  - Host: `Alienware-Aurora-R13` (Ubuntu 24.04.3 LTS)
  - Docker: `29.1.5`
  - Node: `v22.22.0`
  - npm: `11.11.0`
- Runtime checks:
  - `docker --version` ✅
  - `docker info` ✅
  - `npm start` ✅
- API checks:
  - `GET /api/v1/health` -> `200` ✅
  - `GET /api/v1/status` (unauthenticated) -> `401` ✅ (expected)
  - OAuth dev flow:
    - `POST /api/v1/auth/google/start` -> `200` ✅
    - `GET /api/v1/auth/google/callback?...` -> `200` ✅ (cookies set)
  - `GET /api/v1/session/me` (cookie auth) -> `200` ✅
  - `GET /api/v1/status` (cookie auth) -> `200` ✅
  - `GET /api/v1/talks` -> `200` ✅
  - `POST /api/v1/talks` with CSRF + idempotency -> `201` ✅
  - `GET /api/v1/talks/:id` -> `200` ✅
  - `GET /api/v1/talks/:id/messages` -> `200` ✅
  - `GET /api/v1/events` -> `200` ✅
    - SSE header: `x-clawrocket-sse-mode: snapshot`
    - Received event: `talk_created`
- Channel checks:
  - `status.channels.registered` includes `telegram` ✅
- Result:
  - **PASS**: post-cutover server smoke validation succeeded.

### 2026-03-03 - Boundary-First Realignment to `v1.2.0`

- Upstream range/tag: `v1.2.0`
- Conflicts resolved:
  - Rename/delete conflicts for `src/clawrocket/identity/*`, `src/clawrocket/talks/*`, and `src/clawrocket/web/*` during curated replay. Resolved by keeping ClawRocket relocated modules under `src/clawrocket/*`.
  - Content conflicts in `src/index.ts` and `src/task-scheduler.ts`. Resolved by preserving upstream core behavior and reapplying only explicit ClawRocket seam hooks.
  - `src/db.test.ts` merge conflict. Resolved with boundary-split version that explicitly initializes ClawRocket test schema after `_initTestDatabase()`.
- Notes:
  - Added `src/clawrocket/types.ts` and updated ClawRocket imports to avoid extending core `src/types.ts`, keeping core closer to upstream.
  - `build:web`/`dev:web`/`test:web` now fail fast with a clear preflight message when `webapp` dependencies are missing.
- Automated gates:
  - `npm run typecheck` ✅
  - `npm run test` ✅ (37 files, 353 tests)
  - `npm run build` ✅
  - `npm run format:check` ✅
- Manual smoke checks:
  - Startup smoke on this host: `npm start` ❌
    - Failure: container runtime missing (`docker: command not found`), so boot fails in `ensureContainerRuntimeRunning()` before channel/web loops.
  - Channel routing smoke on this host: blocked.
    - `src/channels/index.ts` has no active channel imports in this checkout, so registry is empty until channels are explicitly enabled.
  - Scheduler/container-runner end-to-end smoke: blocked by missing Docker runtime.
  - ClawRocket web auth/talk/event manual smoke: blocked because process exits during startup runtime preflight.
