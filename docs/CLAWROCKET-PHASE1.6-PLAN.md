# ClawRocket Phase 1.6 Plan (Revised)

## Scope Summary
Phase 1.6 delivers the first usable web chat experience with real-time updates while preserving backward compatibility for existing API consumers.

### Locked Decisions
1. Focus: Streaming SSE + web chat shell.
2. UI stack: React + Vite SPA.
3. Auth model: HttpOnly cookie auth + CSRF for mutating requests.
4. Hosting: same-origin SPA served from Hono in production.
5. SSE rollout: opt-in long-lived streaming via `?stream=1` (snapshot default remains).

## Key Revisions from Review Feedback
1. Dev proxy is required:
   - Vite dev server proxies `/api` to `http://localhost:3210`.
   - Frontend fetch always uses `credentials: 'include'`.
   - Dev OAuth callback uses frontend origin path (`http://localhost:5173/api/v1/auth/google/callback`) so proxy preserves same-origin cookie behavior.
2. SSE ownership is explicit:
   - Phase 1.6 uses per-connection polling loops (single-process household scale).
   - Shared fanout watcher is deferred.
   - Add an in-memory per-user live-stream connection cap to avoid unbounded concurrent polling.
3. Replay-gap handling is in-loop:
   - Stream mode checks retention gap continuously, not only on initial connect.
4. OAuth redirect chain is explicit:
   - SPA initiates auth with full-page `window.location.href` redirect.
   - Callback sets cookies and redirects to `/app/talks`.
5. EventSource limitations are handled:
   - Cookie-auth for SSE only (no custom headers needed).
   - On stream error, client checks `/api/v1/session/me` before reconnecting to avoid 401 loops.
6. Frontend state scope is reduced:
   - `useReducer` for active talk timeline/run state.
   - `useState` for talk list.
   - No generalized normalized cache layer in Phase 1.6.
7. Frontend testing stack is explicit:
   - Vitest + Testing Library + jsdom + MSW.
8. Test sequencing is shifted earlier:
   - Each implementation step carries its own tests.
9. Missing UI edge behavior is explicit:
   - Talk 404/forbidden shows unavailable state with back-to-list CTA.
10. CSP baseline is added:
   - Production HTML/static responses include restrictive CSP.

## Implementation Sequence

### Step A: Backend stream mode (opt-in)
1. Add `?stream=1` support to:
   - `GET /api/v1/events`
   - `GET /api/v1/talks/:talkId/events`
2. Keep default snapshot behavior for compatibility.
3. Stream mode behavior:
   - Initial replay from `Last-Event-ID`.
   - Per-connection poll loop (`250ms`) against `event_outbox`.
   - Heartbeat comment every `15s`.
   - Per-user concurrent live stream limit (in-memory guard).
   - Mid-stream `replay_gap` detection + emission.
   - Monotonic cursor advancement.
4. Headers:
   - `x-clawrocket-sse-mode: snapshot|stream`.

### Step B: SPA scaffold + production serving
1. Create `webapp/` with React + Vite + TypeScript.
2. Add scripts:
   - `dev:web`, `build:web`, `test:web`.
3. Configure Vite dev proxy for `/api`.
4. Serve `webapp/dist` from Hono for non-API routes.
5. Add production CSP headers for SPA HTML/static responses.

### Step C: Auth gate + talk list/detail shell
1. Session gate via `GET /api/v1/session/me`.
2. Sign-in flow from SPA:
   - `POST /api/v1/auth/google/start`.
   - Full-page redirect to provider.
   - Callback redirects to `/app/talks`.
3. Talk list page (`/app/talks`) via `GET /api/v1/talks`.
4. Talk detail page (`/app/talks/:talkId`) via `GET /api/v1/talks/:talkId/messages`.
5. Handle unavailable talk (404/forbidden) with explicit UI state.

### Step D: Live timeline + send/cancel
1. Open talk stream with `EventSource(...?stream=1)`.
2. Apply events:
   - `message_appended`
   - `talk_run_started`
   - `talk_run_queued`
   - `talk_run_completed`
   - `talk_run_failed`
   - `talk_run_cancelled` (batched `runIds`).
3. Send messages via `POST /api/v1/talks/:talkId/chat`.
4. Cancel via `POST /api/v1/talks/:talkId/chat/cancel`.
5. Stream reconnect behavior:
   - On error, call `/api/v1/session/me`.
   - Reconnect only if authenticated.
   - On `replay_gap`, resync by reloading messages.

### Step E: Cross-cutting hardening and docs
1. End-to-end reconnect/replay-gap/resync validation.
2. Confirm rate-limit and ACL behavior in stream mode.
3. Update architecture/security docs for stream mode + SPA hosting.

## Test Gates by Step
1. Step A:
   - Snapshot mode unchanged when `stream` not set.
   - Stream mode emits incremental events.
   - Mid-stream `replay_gap` emitted when cursor lags retention.
   - ACL for talk stream preserved.
2. Step B:
   - Vite proxy works for `/api`.
   - Hono serves built SPA with correct route fallback.
   - CSP headers present in production responses.
3. Step C:
   - Unauth user gated.
   - Auth redirect chain lands on `/app/talks`.
   - Talk list and detail render from API.
   - Unavailable talk state rendered.
4. Step D:
   - Live updates apply correctly for all event types.
   - Send/cancel flow updates timeline/run state.
   - Stream error path performs session check before reconnect.
5. Step E:
   - Full regression: `typecheck`, `test`, `build`, `format:check`, `build:web`, `test:web`.

## Assumptions and Defaults
1. Single-process deployment in Phase 1.6.
2. No message broker introduced in this phase.
3. Snapshot SSE remains default for backward compatibility.
4. Batched cancellation event remains unchanged in 1.6; per-run cancel events are deferred.
5. Settings UI, family account UX, and multi-provider model controls remain out of Phase 1.6.
