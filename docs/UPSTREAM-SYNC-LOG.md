# Upstream Sync Log

## Baseline

- Date: 2026-03-03
- ClawRocket baseline tag: `pre-realign-baseline`
- Upstream remote: `https://github.com/qwibitai/nanoclaw.git`
- Realignment target tag: `v1.2.0`

## Sync Entries

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
  - Not executed in this sandbox due missing local channel credentials/container runtime. Run Phase E2 smoke checks on the target machine after branch promotion.
