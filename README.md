# editorialboard

editorialboard.ai is the **Editorial Room** — a multi-agent LLM critique workspace for editorial drafts. Define a deliverable and audience, build out theme/topics and points/outline, draft, then ask a panel of LLM personas (Claude, GPT, Gemini, NVIDIA NIM) for critique mid-edit.

Currently runs locally for Phase 0p. Cloud deploy to Cloudflare + Supabase tracked in [docs/CLOUD_TARGET.md](docs/CLOUD_TARGET.md).

## What Exists Today

Single product, single bootstrap, single SQLite store.

- Hono HTTP server (`src/server.ts` + `src/clawrocket/web/editorial-app.ts`) with auth, session, provider OAuth, and the editorial panel-turn SSE endpoint.
- Vite-built React webapp (`webapp/`) with the six-phase Editorial flow: Setup → Theme/Topics → Points/Outline → Draft → Polish → Ship.
- SQLite store (`src/db.ts` + `src/clawrocket/db/init.ts`) with ten editorial tables: users, invites, sessions, OAuth state, device codes, Google credentials, and the LLM provider catalog/secrets/verifications.
- Provider integrations:
  - Anthropic (API key + Claude.ai subscription via OAuth)
  - OpenAI (API key + ChatGPT Codex subscription via device-code OAuth)
  - Gemini (API key)
  - NVIDIA NIM (API key)

## Repo Shape

```text
src/
  server.ts                          Bootstrap (initDB → start Hono)
  db.ts                              SQLite connection
  config.ts, env.ts, logger.ts       Shared utilities
  types.ts                           Shared types

  clawrocket/
    config.ts                        Editorial-server config + envs
    db/init.ts                       10-table editorial schema
    db/accessors.ts                  User/session/invite/OAuth typed accessors
    identity/                        Auth service + sessions + Google scopes
    llm/                             Provider catalog, secret storage, OAuth flows
    llm/editorial-llm-call.ts        Multi-provider streaming dispatcher
    web/editorial-app.ts             Hono app + route registration
    web/middleware/                  Auth, CSRF, rate-limit
    web/routes/                      Auth, agents, llm-oauth, editorial-panel, system
    contracts/                       JSON-schema validation contracts

webapp/
  src/pages/                         EditorialSetup, ThemeTopics, PointsOutline, DraftWorkspace
  src/components/                    EditorialPhaseStrip, SignInView, ...
  src/lib/                           editorial-fixtures, llm-providers, panel-fanout, markdown export/import
```

## Editorial Flow

1. **Setup** — pick deliverable type, voice, audience, scoring rubric.
2. **Theme + Topics** — capture editorial intent and topic structure.
3. **Points + Outline** — turn topics into outline points with sources.
4. **Draft** — write inside the editor; hit `+ ASK PANEL` mid-edit to stream critique from a configured LLM persona via SSE.
5. **Polish** — iteration loop (Phase 1A).
6. **Ship** — export to Markdown.

## Quick Start

```bash
npm run install:all       # installs root + webapp deps
npm run dev               # tsx src/server.ts on :3210
npm run dev:web           # vite on :5173, proxies /api/* to :3210
```

Then open `http://localhost:5173`.

For local dev, the easiest way to sign in is the dev-login form on the sign-in page; it uses the loopback Google OAuth callback path and bypasses real Google.

Note: dev login from Vite (5173) → backend (3210) cross-origin fetch is blocked by browser CORS. Loading via `http://127.0.0.1:3210` directly works end-to-end.

## Development Commands

```bash
npm run dev               # backend on :3210
npm run dev:web           # webapp on :5173 (proxies /api/* to :3210)
npm run typecheck         # backend tsc --noEmit
npm run test              # backend vitest run
npm --prefix webapp run typecheck
npm --prefix webapp run test
npm --prefix webapp run build
npm run build             # backend tsc → dist/
npm start                 # node dist/server.js
```

## Docs

- [docs/CLOUD_TARGET.md](docs/CLOUD_TARGET.md) — cloud port plan (Cloudflare Workers + Supabase Postgres). Phase A (PURGE) complete; Phase B is next.
- [docs/05_DESIGN_BRIEF.md](docs/05_DESIGN_BRIEF.md) — UI design brief.
- [docs/06_PHASE_1A_KICKOFF.md](docs/06_PHASE_1A_KICKOFF.md) — Phase 1A kickoff and locked decisions.
- [docs/EDITORIAL_ROOM_CONTRACT.md](docs/EDITORIAL_ROOM_CONTRACT.md) — internal validation contracts.
- [docs/SCHEMA_DEFINITION.md](docs/SCHEMA_DEFINITION.md), [docs/THEME_TOPIC_POINTS_DEFINITION.md](docs/THEME_TOPIC_POINTS_DEFINITION.md) — data model.
- [docs/design/](docs/design/) — canonical UI specs.

## License

Private.
