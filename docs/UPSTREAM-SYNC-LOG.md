# Upstream Sync Log

## Baseline

- Date: 2026-03-03
- ClawRocket baseline tag: `pre-realign-baseline`
- Upstream remote: `https://github.com/qwibitai/nanoclaw.git`
- Realignment target tag: `v1.2.0`

## Sync Entries

### 2026-03-06 - Singleton Guard And Context Documentation Cleanup

- Added a real per-`DATA_DIR` singleton coordinator:
  - held `ownership.lock` file handle
  - `owner.json` metadata
  - control-socket graceful takeover
  - verified signal fallback
- Startup now installs signal handlers before singleton acquisition and only reports web-server success after confirmed bind.
- Cleaned active documentation to reflect current ClawRocket architecture:
  - core executor remains containerized and upstream-sensitive
  - Talks run through the direct HTTP runtime
  - Ubuntu `systemd --user` remains the canonical production model
- Removed stale planning/duplicate architecture docs from the active docs set.

### 2026-03-05 - Phase 1.9 Step F Runtime Validation Closeout (Ubuntu Host)

- Host: `Alienware-Aurora-R13` (Ubuntu 24.04.3 LTS)
- Runtime mode verification:
  - Startup log confirms:
    - `mode: "real"`
    - `hasProviderAuth: true`
    - `hasValidAliasMap: true`
- API/session verification:
  - `GET /api/v1/health` -> `200`
  - `GET /api/v1/session/me` (cookie auth) -> `200`
- Talk run lifecycle verification:
  - Snapshot SSE events for active talk show terminal progression for recent runs:
    - `talk_run_started` -> `talk_run_completed`
  - Assistant responses are persisted and visible in `GET /api/v1/talks/:id/messages`.
- Operational baseline update:
  - Service operations standardized to Ubuntu `systemd --user` workflow.
  - One-time migration cutover requires stopping unmanaged `nohup`/manual processes before enabling service to prevent `EADDRINUSE` and Telegram `getUpdates 409` conflict.
  - Deploy procedure now includes syncing `container/agent-runner/src/` to all existing `data/sessions/<group>/agent-runner-src/` folders.

### 2026-03-05 - Phase 1.9 Step F Real Talk Executor Rollout Notes

- Added stateful real talk executor path with per-talk persisted session metadata.
- Runtime selection is automatic in `src/clawrocket/web/index.ts`:
  - Real executor is enabled only when:
    - provider auth is present (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`)
    - and `TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON` is present and valid JSON object.
  - Otherwise runtime falls back to `MockTalkExecutor`.
- Added compatibility seed alias map in runtime defaults to prevent day-one failures:
  - `Mock`, `Gemini`, `Opus4.6`, `Haiku`, `GPT-4o`, `Opus` -> `default`.
- Rollback toggle:
  - Remove/empty `TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON` to force mock mode without code changes.

### 2026-03-04 - Cutover Mechanics Execution (Maintainer Clone)

- Repository: `jokim1/clawrocket`
- Completed:
  - Created and pushed canonical branch `main` from `codex/realign-upstream-v1.2.0`.
  - Repointed local maintainer clone to track `origin/main`.
  - Materialized legacy Step 1.6 stash safely in pre-realign context:
    - Created `codex/stash-port-source` from `pre-realign-baseline`.
    - Ran `git stash branch codex/phase1.6-legacy-port stash@{0}`.
    - Verified stash was auto-dropped on success.
  - Preserved legacy reference as remote branch:
    - `origin/codex/phase1.6-legacy-port`
- Pending admin-only actions (not executable from current CLI auth):
  - Switch GitHub default branch from `codex/realign-upstream-v1.2.0` to `main`.
  - Apply branch protection rule on `main` (PR required, 0 approvals, no force-push/deletion).
- Notes:
  - Current `gh` auth token has `READ` permission on `jokim1/clawrocket`, so repository settings changes must be done by repo admin in UI.

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
