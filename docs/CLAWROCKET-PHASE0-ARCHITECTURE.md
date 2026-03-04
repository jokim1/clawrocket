# ClawRocket Phase 0 Architecture Decisions

## Scope
Phase 0 delivers foundational runtime primitives only: schema/migrations, web API scaffold, security middleware, idempotency/replay, SSE stream stubs, and run-queue contracts.

## Locked Decisions
1. `DELETE /api/v1/talks/:id` is archive-only in v1.
2. MVP cutline is Phases 0-5. Phase 6 is stretch, Phase 7 is release hardening.
3. CSRF uses double-submit cookie (`cr_csrf_token` + `X-CSRF-Token`) for cookie-authenticated mutating routes.
4. Event and idempotency retention:
   - `event_outbox`: 72h retention + hot-topic floor (keep latest 5000 per topic).
   - `idempotency_cache`: 24h TTL.
5. Backups must use SQLite-safe online backup (`sqlite .backup` API or `VACUUM INTO`), not plain file copy while writes are active.

## Implemented Phase 0 API Surface
1. `GET /api/v1/health` (shallow process/DB check)
2. `GET /api/v1/status` (deep status scaffold)
3. `GET /api/v1/events` (user-scoped SSE)
4. `GET /api/v1/talks/:id/events` (talk-scoped SSE + ACL)
5. `POST /api/v1/talks/:id/chat/cancel` (run cancellation contract)

## Authoritative Storage
Single SQLite authority remains `store/messages.db`.

Added Phase 0 tables:
- `users`
- `talks`
- `talk_members`
- `web_sessions`
- `oauth_state`
- `event_outbox`
- `dead_letter_queue`
- `idempotency_cache`
- `talk_runs`
- `talk_llm_policies` (with `group_llm_policies` compatibility view)

## Concurrency and Delivery Guarantees
1. One active run per talk; extra runs are queued FIFO.
2. Mutating endpoints accept optional `Idempotency-Key`. If present, replay protection is enforced.
3. SSE replay uses monotonic `event_id` and `Last-Event-ID`.
4. Replay gap emits `replay_gap` event when resume point is outside retention.

## Security Notes
1. Session token hashes are SHA-256 over opaque high-entropy tokens (minimum 128-bit entropy requirement).
2. Request body hashes stay plain SHA-256 for deterministic idempotency comparisons.
3. Rate limits are process-local in Phase 0 (reset on process restart).

## SSE Mode
Phase 0 event endpoints are snapshot-style SSE responses that close after emitting buffered events. Full long-lived streaming is deferred to Phase 1+.

## Deferred to Phase 1+
1. Full OAuth/device flow UX.
2. Full talk CRUD API and chat orchestration.
3. Provider probing and runtime connector health beyond scaffold checks.
