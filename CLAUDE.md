# editorialboard Repo Context

See [README.md](README.md) for product overview. This file is the short coding context for agents working inside the repo.

## Current Project Shape

editorialboard.ai is a single-product, single-bootstrap web app for the **Editorial Room** — multi-agent LLM critique on editorial drafts.

- **Backend:** Hono server in `src/server.ts` (entry) → `src/clawrocket/web/editorial-app.ts` (routes). SQLite store via `src/db.ts` + `src/clawrocket/db/init.ts`.
- **Frontend:** Vite + React under `webapp/`. Six-phase Editorial flow.
- **LLM dispatch:** `src/clawrocket/llm/editorial-llm-call.ts` streams the panel-turn SSE endpoint against Anthropic / OpenAI / Gemini / NVIDIA NIM.

## Engineering Defaults

- Prefer long-term stable architecture over backward-compatibility scaffolding.
- Do not preserve legacy APIs, schema shapes, data, or local users by default unless the task explicitly requires it.
- Treat existing local users and stored data as disposable by default at this stage of the project.
- If a simpler implementation requires resetting, deleting, or rebuilding local data/users, do that instead of carrying compatibility baggage.
- Remove dead paths instead of supporting old and new behavior in parallel.

## Key Files

| File                                                                                                   | Purpose                                                                |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `src/server.ts`                                                                                        | bootstrap: init SQLite, start Hono, handle SIGINT/SIGTERM              |
| `src/db.ts`                                                                                            | better-sqlite3 connection helper (`getDb`, `initDatabase`)             |
| `src/clawrocket/config.ts`                                                                             | server + auth + provider env config                                    |
| `src/clawrocket/db/init.ts`                                                                            | 10-table editorial schema + provider-catalog seeds                     |
| `src/clawrocket/db/accessors.ts`                                                                       | typed accessors (User, WebSession, Invite, OAuthState, DeviceAuthCode) |
| `src/clawrocket/identity/auth-service.ts`                                                              | Google OAuth + device-code + session lifecycle                         |
| `src/clawrocket/web/editorial-app.ts`                                                                  | Hono app: route registration, SPA shell, helpers                       |
| `src/clawrocket/web/middleware/{auth,csrf,rate-limit}.ts`                                              | request-time guards                                                    |
| `src/clawrocket/web/routes/editorial-panel.ts`                                                         | POST `/api/v1/editorial/panel-turn` (SSE)                              |
| `src/clawrocket/web/routes/{ai-agents,llm-oauth,llm-oauth-openai}.ts`                                  | provider catalog + OAuth flows                                         |
| `src/clawrocket/llm/editorial-llm-call.ts`                                                             | streaming dispatcher (Anthropic, OpenAI, Gemini, NVIDIA)               |
| `src/clawrocket/llm/{anthropic-oauth,openai-codex-oauth}.ts`                                           | provider OAuth implementations                                         |
| `src/clawrocket/llm/provider-secret-store.ts`                                                          | encryption-at-rest for provider credentials                            |
| `webapp/src/pages/{EditorialSetup,ThemeTopicsWorkspace,PointsOutlineWorkspace,DraftWorkspace}Page.tsx` | the four canonical editorial pages                                     |

## Current Runtime Facts

- Single Node process; no IPC, no scheduler, no container runtime, no channels.
- Editorial routes are the only HTTP surface besides `/api/v1/health`.
- Provider secrets are encrypted at rest in SQLite; master key in `CLAWROCKET_PROVIDER_SECRET_KEY`.
- Anthropic and OpenAI Codex subscriptions are supported via OAuth; OpenAI/Gemini/NVIDIA via API key.
- SQLite store lives at `${STORE_DIR}/messages.db`; existing data is disposable.
- Session cookies: `cr_access_token` (HttpOnly), `cr_refresh_token` (HttpOnly), `cr_csrf_token` (JS-readable for double-submit CSRF).

## Development Commands

```bash
npm run dev               # backend on :3210
npm run dev:web           # webapp on :5173 (proxies /api/* to :3210)
npm run typecheck         # backend tsc --noEmit
npm run test              # backend vitest run (NANOCLAW_ALLOW_UNSUPPORTED_NODE=1 wrapper)
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
```

## Docs To Trust

- [docs/CLOUD_TARGET.md](docs/CLOUD_TARGET.md) — cloud port plan (Cloudflare Workers + Supabase Postgres). Phase A (PURGE) complete; Phase B is next.
- [docs/EDITORIAL_ROOM_CONTRACT.md](docs/EDITORIAL_ROOM_CONTRACT.md) — internal validation contracts.
- [docs/SCHEMA_DEFINITION.md](docs/SCHEMA_DEFINITION.md), [docs/THEME_TOPIC_POINTS_DEFINITION.md](docs/THEME_TOPIC_POINTS_DEFINITION.md) — data model.
- [docs/design/](docs/design/) — canonical UI specs.

## Vestigial Scaffolding (Future Cleanup)

- `setup/` — NanoClaw onboarding scripts (container, register, mounts, etc.). Imports refer to deleted chassis files; never invoked by the editorial product. Tests pass because they mock the broken paths.
- `skills-engine/` — NanoClaw skill management. Tests pass; not used by editorial code.

Both are kept as inert scaffolding; can be removed in a follow-up cleanup PR once we are sure no upstream borrowing is desired.
