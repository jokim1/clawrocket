# ClawRocket

ClawRocket is a NanoClaw-derived personal assistant that keeps the upstream containerized core small while adding an authenticated web app, multi-agent Talks, executor settings, and provider-routed direct HTTP talk execution.

## What Exists Today

The repo has two execution domains:

1. **Core executor**
   - Runs through the existing container/Claude path.
   - Uses the NanoClaw-style orchestrator in `src/index.ts`.
   - Remains Anthropic-compatible and upstream-sensitive.

2. **Talk runtime**
   - Runs through ClawRocket’s direct HTTP runtime in `src/clawrocket/talks/direct-executor.ts`.
   - Streams responses, reconstructs context statelessly, and supports multiple talk agents per talk.
   - Uses provider/route configuration stored in SQLite.

ClawRocket also adds:

- authenticated web UI and API
- RBAC (`owner`, `admin`, `member`)
- executor settings and status APIs
- Talk LLM provider/route settings
- per-talk multi-agent routing
- sequential provider fallback for Talks
- a per-`DATA_DIR` single-instance takeover guard
- systemd-friendly self-restart support for Ubuntu deployments

## Repo Shape

```text
src/
  index.ts                    Core orchestrator + singleton startup
  container-runner.ts         Containerized core executor path
  instance-coordinator.ts     Single-instance takeover guard
  task-scheduler.ts           Core scheduler loop
  db.ts                       Shared SQLite connection

  clawrocket/
    db/                       Web/talk schema and typed accessors
    identity/                 Auth, sessions, invites
    talks/                    Direct Talk runtime, workers, settings
    web/                      Hono API server and routes
    llm/                      Talk-provider capabilities and secret storage

webapp/
  src/pages/SettingsPage.tsx  Executor + Talk LLM settings UI
  src/pages/TalkDetailPage.tsx
```

## Architecture Summary

```text
Channels / scheduler / IPC
        |
        v
  Core orchestrator (`src/index.ts`)
        |
        +--> Containerized Claude/NanoClaw execution
        |
        +--> ClawRocket web server
                |
                +--> Auth + RBAC
                +--> Talks API + SSE
                +--> TalkRunWorker
                        |
                        v
                 Direct HTTP Talk runtime
                 (Anthropic + OpenAI-compatible providers)
```

## Current Runtime Behavior

### Core executor

- Uses container isolation and the existing agent-runner path.
- Reads executor settings from the typed executor settings service.
- Supports restart-aware settings changes and boot-marker verification.

### Talks

- Default runtime mode is `direct_http`.
- Talks are text-only and stateless in v1.
- Every Talk has at least one agent and exactly one primary agent.
- Talk agents reference named routes.
- Routes contain ordered provider/model steps for sequential fallback.
- A built-in mock route is seeded for fresh installs.

### Single-instance behavior

- Only one process should own a given `DATA_DIR`.
- Starting a second instance against the same `DATA_DIR` triggers graceful takeover:
  - control-socket shutdown request first
  - verified `SIGTERM`
  - verified `SIGKILL` only if needed
- Ownership is held by a live `ownership.lock` file handle plus runtime metadata in `data/runtime/instance/`.

## Local Development

Install:

```bash
npm install
npm run install:webapp
```

Run:

```bash
npm run dev
npm run dev:web
```

Common checks:

```bash
npm run typecheck
npm run test
npm run build
npm --prefix webapp run typecheck
npm --prefix webapp run test
```

## Operations Notes

- Ubuntu `systemd --user` is the canonical production deployment path.
- The web restart button only works when `CLAWROCKET_SELF_RESTART=1` is present in the service environment.
- Do not run an ad hoc second production instance against the same `DATA_DIR` unless you intend to take over the running service.

See:

- [docs/OPERATIONS_UBUNTU.md](docs/OPERATIONS_UBUNTU.md)
- [docs/DEBUG_CHECKLIST.md](docs/DEBUG_CHECKLIST.md)

## Documentation Map

- [CLAUDE.md](CLAUDE.md): coding-agent context for this repo
- [docs/SPEC.md](docs/SPEC.md): current architecture and data-flow spec
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md): current design constraints and priorities
- [docs/SECURITY.md](docs/SECURITY.md): security model and current limitations
- [docs/UPSTREAM-PATCH-SURFACE.md](docs/UPSTREAM-PATCH-SURFACE.md): allowed NanoClaw-core touchpoints
- [docs/UPSTREAM-SYNC-LOG.md](docs/UPSTREAM-SYNC-LOG.md): maintained sync/runtime history

## Scope Guidance For Contributors

- Changes under `src/clawrocket/*` are generally preferred for ClawRocket-specific functionality.
- Changes to NanoClaw-core files should stay within the patch-surface rules in [docs/UPSTREAM-PATCH-SURFACE.md](docs/UPSTREAM-PATCH-SURFACE.md).
- Docs in this repo should describe the current implementation, not old rollout phases or speculative plans.
