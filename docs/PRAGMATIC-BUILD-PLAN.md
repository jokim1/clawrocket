# Pragmatic Build Plan

**Status:** Active
**Date:** 2026-03-14
**Companion document:** [WORKSPACE-REWRITE-PLAN.md](./WORKSPACE-REWRITE-PLAN.md) (north-star architecture)
**Source of truth for current work:** [ARCHITECTURE-REVIEW.md](./ARCHITECTURE-REVIEW.md) (implementation order + decisions)

This document defines the phased build plan for shipping ClawRocket from its current state toward the workspace architecture described in WORKSPACE-REWRITE-PLAN.md. Every phase ships independently. No phase depends on the full north-star being complete.

The principle: ship what works, scope honestly, extend when real infrastructure exists.

---

## Current State (as of 2026-03-14)

What exists and works today:

- **Direct HTTP execution** via `execution-resolver.ts` — resolves provider + credential + config for any registered agent. Anthropic API keys work. OAuth/subscription correctly rejected.
- **Seeded `provider.anthropic`** row with `claude-sonnet-4-6` default model.
- **Synthetic Claude card** in frontend reflects API-key-only readiness (but see known gap below re: default-provider bug).
- **Agent router** (`agent-router.ts`) delegates cleanly to execution-resolver — no inline credential logic.
- **Container execution** works for WhatsApp/Telegram/scheduled tasks via Docker + Claude Agent SDK. Not yet wired into Talk/Main executors.
- **Talk executor** streams LLM responses, resolves agents via registered-agents, executes context tools (Tier 1).
- **Main executor** exists but has no tools and no `executeToolCall` callback.
- **Connector tool definitions** exist in `runtime.ts` but aren't wired to the context loader or executor.
- **Registered-agent CRUD** exists in backend (`GET/POST/PUT/DELETE /api/v1/registered-agents`). No frontend UI.

What exists in schema AND is already partially wired:

- `thread_id` column on `talk_messages` (init.ts line 478) — exists, nullable, indexed. Not used in UI or context loading yet.
- `talk_context_goal` table (init.ts line 520) — goal/objective per Talk. **Already read by context-loader.ts** (`fetchGoal()`) and injected into system prompt. Not yet exposed in Talk settings UI for direct editing.
- `talk_context_rules` table (init.ts line 527) — rules with `sort_order`, `is_active`. **Already read by context-loader.ts** (`fetchRules()`) and injected into system prompt. **Already has a live UI** in TalkDetailPage.tsx (~line 3873): create, toggle active/inactive, delete. Working end-to-end.
- `talk_data_connectors` (init.ts line 591) — junction table linking Talks to data connectors. Already used for PostHog/Sheets attachment.
- `talk_channel_bindings` / `talk_channel_policies` (init.ts lines 616, 637) — full binding model with response_mode, responder_agent_id, delivery_mode, thread_mode, rate limits. **Already has a live UI** in TalkDetailPage.tsx (~line 4860): create binding with full policy controls, list existing bindings.
- `context-loader.ts` — already loads goal, rules, summary, and sources into a structured `ContextPackage` with system prompt assembly, token budgeting, and source manifest. This is the existing context assembly function.

Known current gaps:

- **RegisteredAgentsPanel default-provider preference** — already fixed: `readyProviders()` (line 97-104) prefers verified providers. Phase 1.1 should verify this with tests rather than treat it as active product work.

What doesn't work:

- ~~Multi-step tool loop~~ **DONE** — `agent-router.ts` lines 287-490 implement full tool loop with `MAX_TOOL_ITERATIONS = 10`, Anthropic + OpenAI format handling.
- ~~Talk agent editing~~ **DONE (Phase 1.4)** — `updateTalkAgentsRoute` now persists via `setTalkAgents()`, `listEffectiveTalkAgents` returns real data from new schema columns.
- Connector tools (definitions built but never passed to LLM)
- Main executor tools (zero tools, no callback)
- Container routing from Talk/Main (container is only used by external chat paths)
- ~~Registered-agent management UI~~ **DONE** — `RegisteredAgentsPanel.tsx` has full CRUD.
- User tool permissions UI (backend routes exist, no frontend)

---

## Phase 1: Stabilize Execution (Weeks 1-2)

**Goal:** Every registered agent with an API key can execute multi-step tool calls through the direct HTTP path. Users can create and manage agents through the UI.

### 1.1 Registered-agent management UI on AI Agents page ✅ ALREADY DONE
- `RegisteredAgentsPanel.tsx` has full CRUD: list/create/edit/delete agents with name, provider, model, system prompt, tool permissions.
- `readyProviders()` (line 97-104) already prefers verified providers.
- **No work needed.** Verify with tests.

### 1.2 Fix agent-router tool loop ✅ ALREADY DONE
- `agent-router.ts` lines 287-490: full tool loop implementation with `MAX_TOOL_ITERATIONS = 10`.
- Handles both Anthropic (`tool_use` blocks) and OpenAI (separate `tool` messages) formats.
- Streams responses, accumulates text + tool calls, executes tools via callback, appends results, re-calls LLM.
- **No work needed.**

### 1.3 Honest connector copy (stopgap) ✅ DONE
- `DataConnectorsPage.tsx`: Updated main description to say "Connector query tools are coming soon."
- `DataConnectorsPage.tsx`: Updated Google Sheets OAuth message to remove branch-specific language.
- `TalkDetailPage.tsx`: Already had honest "coming soon" copy.

### 1.4 Talk agent persistence ✅ DONE
- **Schema:** Added `source_kind`, `provider_id`, `model_id`, `nickname`, `nickname_mode` columns to `talk_agents` table. Made `registered_agent_id` nullable. Inline migration for existing DBs.
- **Persistence:** `setTalkAgents()` in `agent-registry.ts` — full replace (delete + insert) in a transaction.
- **Read path:** `getTalkAgentRows()` returns all columns. `listEffectiveTalkAgents()` in `talks.ts` now returns real data.
- **Route:** `updateTalkAgentsRoute` now calls `setTalkAgents()` and returns persisted data via `listEffectiveTalkAgents()`.

### 1.5 Main agent selector ✅ DONE
- **Write function:** `setMainAgentId()` in `agent-registry.ts` — validates agent exists + enabled, writes to `settings_kv`.
- **Route:** `PUT /api/v1/registered-agents/main` in `agent-management.ts` — admin only, validates input.
- **Server wiring:** Route registered in `server.ts`.
- **API client:** `updateMainRegisteredAgent()` added to `api.ts`.
- **Frontend:** Main Agent selector section added to `AiAgentsPage.tsx` — dropdown of enabled registered agents, save button, loading/error states.

### Phase 1 exit criteria ✅ ALL MET
- ✅ A user can create a registered agent for Claude (with API key) or OpenAI through the UI
- ✅ That agent can be assigned to a Talk and execute multi-step tool calls (context tools)
- ✅ Main agent can be changed via UI
- ⚠️ Talk agent health pills show 'ready' (TODO: resolve real health from provider verification — deferred to Phase 2)
- ✅ No connector tools yet — but copy is honest about it

---

## Phase 2: Wire Direct Executor Tools (Weeks 3-4)

**Goal:** Direct executor agents have real tool capabilities — connectors, web fetch, web search.

### 2.1 Wire connector tools for Talks (with runtime verification) ✅ DONE
- **Context loader:** `buildConnectorTools()` in `context-loader.ts` now queries `listConnectorsForTalkRun()` and filters to `verificationStatus === 'verified'` before producing tool definitions. Uses `buildConnectorToolDefinitions()` from `runtime.ts`.
- **Runtime verification guard:** Only verified connectors produce tool definitions — fail closed.
- **Execution-time guard:** `buildToolExecutor()` in `new-executor.ts` re-checks `connector.verificationStatus` before executing. Stale connectors return a clear tool error to the LLM.
- **Talk executor callback:** Detects `connector_` prefixed tool names, resolves connector by ID, delegates to `executeConnectorTool()` with JIT decryption.

### 2.2 Web fetch tool ✅ DONE
- `executeWebFetch()` in shared `tools/web-tools.ts` — HTTP fetch with HTML-to-text extraction (strips script/style, decodes entities, collapses whitespace). 15s timeout, 32K char limit.
- Tool definition included in both Talk context tools and Main executor tools.

### 2.3 Web search tool ✅ DONE
- `executeWebSearch()` in shared `tools/web-tools.ts` — Brave Search API integration. 10s timeout, top 5 results.
- Returns clear error if `BRAVE_SEARCH_API_KEY` not configured.
- Tool definition included in both Talk context tools and Main executor tools.

### 2.4 Main executor tools + callback ✅ DONE
- `buildMainToolExecutor()` in `main-executor.ts` — handles `web_fetch` and `web_search` tool calls.
- Uses shared `WEB_TOOL_DEFINITIONS` from `tools/web-tools.ts` for tool definitions.
- `executeWithAgent` now receives `executeToolCall` callback for Main channel.

### 2.5 Wire Google Sheets OAuth end-to-end
- Users can currently walk into a dead end
- **Effort:** Medium
- **Deferred:** Requires OAuth flow work that is independent of execution wiring.

### 2.6 Gate connector attach in UI by verification status ✅ DONE
- `availableConnectors` in `TalkDetailPage.tsx` now filters `verificationStatus === 'verified'` in addition to `enabled`.
- Empty-state message updated to explain that connectors must be verified.

### Phase 2 exit criteria
- ✅ Talk agents can query PostHog, read Google Sheets, fetch web pages, run web searches — all via direct HTTP
- ✅ Main agent has web_fetch and web_search tool access
- ✅ Connector attachment requires verified credentials
- ✅ Tier 1-3 tools operational for any provider
- ⚠️ Google Sheets OAuth end-to-end (2.5) deferred — existing OAuth dead end remains

---

## Phase 3: Ship Main (Nanoclaw) Frontend (Week 4-5)

**Goal:** Main is a real user-facing surface, not just backend plumbing.

### 3.1 Main channel UI
- Sidebar entry: "Main (Nanoclaw)" above Talks section
- Thread list view
- Thread detail: message timeline + streaming
- New `mainStream.ts` client (same SSE patterns, separate endpoint from Talk)
- **Effort:** 1-2 days

### 3.2 New Talk defaults onboarding copy
- "This Talk is using the default agent with all tools enabled. [Customize →]"
- Runtime fallback chain already works — UI copy only
- **Effort:** ~1 hour

### Phase 3 exit criteria
- Users can talk to Nanoclaw through the web UI with direct-executor tools (Tiers 1-3: context, connectors, web fetch/search)
- Tier 5 tools (shell, filesystem, browser) are NOT available in Main until Phase 5 ships container routing
- Feels like the primary everyday AI surface for knowledge/research/connector tasks
- Talks still work as configured workspaces

---

## Phase 4: Threads + Context Standardization (Weeks 5-7)

**Goal:** Formalize threads using the existing `thread_id` infrastructure on both messages and runs, standardize the context build order that `context-loader.ts` already implements, and expose the objective for direct editing. No external infrastructure dependency (no Docker, no new services), but does touch existing persisted schema and execution assumptions — low risk, not zero.

> **Why before containers:** Phase 5 (container routing) is gated on Docker-in-Talk infrastructure that may not be ready. This phase has no external dependencies and delivers the best UX win. It proceeds regardless of container readiness.

### Existing infrastructure

- `talk_messages.thread_id` (init.ts line 478) — nullable column, indexed. Exists but unused.
- `talk_runs.thread_id` (init.ts line 670) — nullable column. Exists but current Talk-side code (run-queue.ts, talks.test.ts) assumes `thread_id: null` for Talk runs.
- `talk_context_goal` (init.ts line 520) — **already loaded by context-loader.ts** (`fetchGoal()`) and injected into system prompt. Not yet exposed in Talk settings UI for direct editing.
- `context-loader.ts` — already assembles a `ContextPackage` with goal → summary → rules → source manifest → message history, with token budgeting. This is the existing default context build order.

### What's genuinely new

- `talk_threads` table (new schema)
- Making `thread_id` NOT NULL on both `talk_messages` and `talk_runs` (migration + code changes in run-queue, SSE, tests)
- Objective editing UI
- Thread-scoped history loading and thread-scoped run queries

### Decided

- **Thread model:** Every message belongs to a thread. `thread_id` is NOT NULL after migration. Existing Talk messages migrate into a default thread per Talk. No "talk-level messages" concept survives — that creates two query paths forever.
- **Rename:** Defer until Phase 7+ when the workspace model is substantively different from a Talk.
- **Context inheritance:** Threads inherit Talk-level objective + rules + roles. Thread-level overrides are a future concern.

### 4.1 Standardize default context build order (thread-aware)
- The existing `context-loader.ts` already does this correctly: goal → summary → rules → source manifest → message history with token budgeting. Formalize it:
  - Document the build order as the canonical contract (not ad hoc)
  - Add `thread_id` awareness to `loadMessageHistory()` — only load messages from the active thread
  - **Thread-aware summary strategy:** `fetchSummary()` currently queries by `talk_id` only (context-loader.ts line 154-166). A single talk-level summary injected into every thread will leak cross-thread context. Decision for Phase 4: disable summary injection for threaded runs until summaries are per-thread. Rationale: a stale/wrong summary is worse than no summary — the model still has recent thread history. Per-thread summary generation is a Phase 8 concern (context refinement).
  - Extend `ContextPackage.metadata` with `threadId` and `activeRuleCount`
  - This ensures Phases 5-7 all build on a stable, documented context assembly rather than evolving ad hoc behavior
- **Effort:** 3-4 hours (includes summary strategy change)

### 4.2 Thread formalization (messages AND runs — all creation and consumption paths)
- Create `talk_threads` table: `id`, `talk_id`, `title`, `created_at`, `updated_at`
- Migration for `talk_messages`: create a default thread per Talk, backfill `thread_id` on all existing messages, then make NOT NULL
- Migration for `talk_runs`: backfill `thread_id` on existing runs (matching via `trigger_message_id` → message's thread), then make NOT NULL
- After migration, every message AND every run belongs to a thread — no NULL steady state
- **Full surface area — all Talk message AND run producers/consumers:**
  - **Message creation:** `accessors.ts` Talk message helper (line ~1471) does not accept or persist `thread_id` — must require it
  - **Channel ingress:** `channel-accessors.ts` (line ~1245) creates Talk messages and runs with `thread_id: null` — must resolve to the correct thread (or create one) on inbound channel messages
  - **Run creation:** `accessors.ts` run insertion helper (line ~1819) currently hardcodes `thread_id: null` for Talk runs — must require thread_id
  - **Run creation input type:** `accessors.ts` (line ~2180) has `thread_id: string | null` — make required for Talk runs
  - **Run queue:** `run-queue.ts` — enqueue, claim, status transitions must be thread-aware
  - **SSE state filtering:** thread-scoped event delivery
  - **Cancellation:** cancel by thread, not just by talk
  - **Executors:** all executor code paths that create runs (new-executor.ts, main-executor.ts) — must pass thread_id
  - **Tests:** all test code that assumes `thread_id: null` for Talk messages or runs (talks.test.ts and others)
- **Effort:** ~2 days (message producers + run producers + queue + SSE + channel ingress)

### 4.3 Thread UI
- Thread list in Talk sidebar
- Thread creation (+ button or from conversation)
- Thread-scoped message view
- Cross-thread search within a Talk
- **Effort:** 1-2 days

### 4.4 Expose objective (talk_context_goal) in UI
- The table, context injection, and API route all already exist:
  - `talk_context_goal` table (init.ts line 520)
  - `fetchGoal()` in context-loader.ts injects into system prompt
  - `PUT /talks/:talkId/context/goal` route exists in talk-context.ts (line 96-125) with validation (160 char limit)
- What's missing is frontend wiring only:
  - Editable "Objective" field in Talk settings UI (prominent, not buried)
  - Wire to existing PUT route
- **Effort:** 1-2 hours (pure frontend wiring — backend is done)

### Phase 4 exit criteria
- Users can create multiple Threads within a Talk
- Each Thread has its own conversation history
- Threads inherit Talk-level objective, rules, and roles
- Objective is editable in Talk settings and visible in context
- Context build order is documented and thread-aware
- Existing single-conversation Talks migrate cleanly (all messages in a default thread)

---

## Phase 5: Container Routing in Talk/Main (Weeks 7-9)

**Goal:** Agents with Tier 5 capabilities (shell, filesystem, browser) route to container execution from Talk and Main — not just from external chat paths. This is where the execution model expands beyond "direct HTTP only."

### Decision gate before starting Phase 5

The following infrastructure must exist:

1. Docker-in-Talk infrastructure exists (container-runner can be invoked from Talk/Main executors, not just external chat worker)
2. The output protocol is defined (v1: final-result-only, not streaming deltas)

The state ownership model is already decided (ARCHITECTURE-REVIEW.md Commitment #1): containerized Talk/Main agents are stateless per turn. DB is truth. No session resume. This is not open for debate — it's a firm architectural commitment. The gate here is whether the infrastructure to enforce it is built.

If the infrastructure isn't ready, Phase 5 blocks. Phase 6 can proceed independently.

### 5.1 Per-agent container routing
- In Talk executor (`new-executor.ts`) and Main executor (`main-executor.ts`): compute `effectiveToolAccess(agent, user)`
- If effective permissions include shell/filesystem/browser → route to container execution
- Validate provider is Claude-compatible (container requires Claude Agent SDK)
- If Tier 5 tools are `requiresApproval` → check approval state before spawning container (reuse `awaiting_confirmation`/`run_confirmations`)
- **Effort:** ~1 day for routing logic

### 5.2 Stateless container adapter for Talk/Main
- No `sessionId`, no `resume`, no `resumeAt` for Talk/Main container runs
- Each turn: load context from DB → compile into container input → execute → persist result back
- Session resume kept ONLY for legacy external-chat paths (WhatsApp/Telegram)
- **Effort:** ~1 day

### 5.3 Ephemeral per-run context directory
- Create `/workspace/run-{runId}/` per container invocation
- Mount context files there (TALK_CONTEXT.md, source snapshots) via `additionalDirectories`
- Delete after run completes (success or failure)
- Context files MUST NOT land in persistent `/workspace/group` mount (Commitment #5)
- **Effort:** ~0.5 days

### 5.4 Output mapping
- v1: final-result-only (container returns on `message.type === 'result'`)
- Talk UI shows "running..." → completed result
- Map container output into Talk/Main message format
- Future: delta streaming protocol (separate phase)
- **Effort:** ~0.5 days

### 5.5 User tool permissions UI
- Profile page or sidebar destination
- Per tool family: toggle (allowed/blocked) + checkbox (requires approval)
- Reflects per-agent routing tiers: Tier 5 permissions gate container execution
- **Effort:** 2-3 hours

### 5.6 Agent chip tooltip — capability vs effective execution
- Hover shows: agent capabilities, effective execution (after user permission intersection), execution backend
- Makes the per-agent routing model visible to users
- **Effort:** 3-4 hours
- **Depends on:** 5.1 (routing logic), 1.4 (real agent data via JOIN), and ideally Talk agent health from provider verification (ARCHITECTURE-REVIEW #7/#12) for accurate health display

### Phase 5 exit criteria
- A Claude agent with shell/filesystem permissions in a Talk routes to container execution
- A GPT agent in the same Talk routes to direct executor
- Users see which execution backend each agent uses
- User permissions correctly gate container spawn
- Container agents are stateless per turn — no session drift

### What Phase 5 does NOT deliver
- Streaming from containerized Talk/Main agents (final-result-only)
- Automatic execution mode selection at agent creation (user explicitly enables Tier 5 tools)
- Container execution for non-Claude providers (Claude Agent SDK requirement)

---

## Phase 6: Elevate Rules + Add State (Weeks 9-11)

**Goal:** Promote rules from a side panel feature to the primary workspace configuration surface. Add structured state as a genuinely new primitive.

### What already works (not new)

- `talk_context_rules` schema (init.ts line 527) — full schema with `sort_order`, `is_active`.
- Context-loader already reads active rules via `fetchRules()` and injects them into the system prompt.
- TalkDetailPage.tsx (~line 3873) already has a live Rules UI: create, toggle active/inactive, delete.
- Rules are already end-to-end functional: user creates rule → stored in DB → loaded by context-loader → injected into agent system prompt.

### What's missing

- **Drag-to-reorder** (writes `sort_order`) — current UI lacks reorder
- **Inline edit** of rule text — current UI only has create and delete
- **Rules as a primary navigation surface** — currently buried in the Talk config panel, should be elevated to a prominent tab or section
- **Thread-level rule awareness** — after Phase 4 threads, rules should be visible as "inherited from Talk" in the thread view

### 6.1 Elevate rules to primary product surface
- Promote Rules from a sub-section of Talk config to a first-class tab/section
- Add drag-to-reorder (writes `sort_order`)
- Add inline edit of rule text
- Show rule count badge in Talk navigation
- In thread view: show "N rules active" indicator linking back to Talk-level rules
- **Effort:** ~0.5 day (UI polish + reorder, not schema or backend work)

### 6.2 Structured state (genuinely new)
- `talk_state_entries` table — new schema:
  - `id`, `talk_id`, `key`, `value` (JSON), `version` (INTEGER NOT NULL DEFAULT 1), `updated_at`, `updated_by`, `updated_by_run_id`
  - `version` enables compare-and-swap: `UPDATE ... SET value = ?, version = version + 1 WHERE key = ? AND version = ?`. If the WHERE misses (another writer incremented version), the update returns 0 rows changed → conflict detected.
  - `updated_by_run_id` provides provenance: which agent run wrote this value. Required for debugging when fan-out agents or jobs write the same key.
- State summary injected into context when relevant (extend context-loader)
- Agent tool: `update_state` — compare-and-swap semantics. Agent receives current `{key, value, version}` in context; sends `{key, value, expected_version}` on write. On conflict: tool returns an error with the current value so the agent can retry or merge.
- v1 scope: state is best suited for low-contention, set-style operations (counters, trackers, snapshots). High-contention concurrent writes (multiple fan-out agents racing on the same key) will surface conflicts via CAS — the agent must handle the retry. This is intentionally simple; append-only ledgers or CRDT-style merges are v2 if real usage demands them.
- UI: simple key-value viewer in Talk settings with version + last-updated-by-run info, read-only for now
- **Effort:** 1.5-2 days (CAS logic + tool + context integration)

### Phase 6 exit criteria
- Rules are a prominent, polished surface (reorder, inline edit, count badge)
- State entries track structured facts (counters, trackers, snapshots) with version-controlled writes
- Agents can update state entries via compare-and-swap tool calls; conflicts are surfaced, not silently lost
- State writes are auditable (which run wrote which value)
- Both rules and state summaries flow through the standardized context package

---

## Phase 7: Complete Connector/Binding Split + Google Docs (Weeks 11-13)

**Goal:** Finish and clean up the already-existing split between data connectors and channel bindings. Add Google Docs as a real data connector.

### What already works (not new)

- `talk_data_connectors` (init.ts line 591) — junction table. Already used for PostHog/Sheets attachment with a working UI.
- `talk_channel_bindings` (init.ts line 616) — full binding model with `response_mode`, `responder_agent_id`, `active` flag.
- `talk_channel_policies` (init.ts line 637) — per-binding policy with response_mode, responder_mode, delivery_mode, thread_mode, rate limits.
- TalkDetailPage.tsx (~line 4860) already has a live Channels UI: create binding with full policy controls (response mode, delivery mode, busy timeout, context note), list/manage existing bindings.
- The data model split already exists end-to-end. Both sides have working UI.

### What's missing

- The UI does not visually separate data connectors from channel bindings as distinct concepts — they're in different tabs but not labeled as a clear "Integrations" taxonomy
- Channel binding policy editing for existing bindings (create works, edit/update may be incomplete)
- Google Docs as a data connector type

### 7.1 Clarify the connector/binding split in UI
- Rename/reorganize the Talk config to make the split explicit: "Data Connectors" section and "Channel Bindings" section under a shared "Integrations" area
- Ensure existing channel binding policies are fully editable (not just create-only)
- No schema migration — the split is already in the DB and the UI surfaces exist
- **Effort:** ~0.5-1 day (UI reorganization, not new features)

### 7.2 Google Docs read/write connector
- New connector kind following Google Sheets OAuth pattern
- Tools: `google_docs_read`, `google_docs_write`, `google_docs_create`
- **Effort:** ~1 day

### Phase 7 exit criteria
- UI clearly labels and separates data connectors from channel bindings
- Channel binding policies are fully editable (create + update)
- Google Docs read/write works as a data connector tool

---

## Phase 8: Context Refinement + Inspection (Weeks 13-15)

**Goal:** Evolve the existing context-loader into a complete, inspectable context strategy that incorporates all primitives built in prior phases (threads, state, elevated rules).

### What already works (not new)

- `context-loader.ts` already implements a structured `loadTalkContext()` function that builds a `ContextPackage` with: goal → summary → rules → source manifest → message history, with token budgeting.
- Phase 4 adds thread-awareness and formalizes the build order.
- Phase 6 adds state summaries to the context package.

### What's left for Phase 8

- **Role-aware context selection** — different roles should prefer different context (north-star section 9.9)
- **Context inspection** — each run records what context was actually used, making it auditable
- **Retrieval layer** — when the task needs more than the default package, retrieve a small number of relevant resources/state items before falling back to tools
- **Backend adaptation** — container execution gets the same logical context but with large working-set items materialized as ephemeral files

### 8.1 Role-aware context hints
- Extend `ContextPackage` to accept role-specific context preferences (e.g., Beat Analyst prefers roster/schedule/injuries)
- Keep it simple: a list of preferred state keys or resource tags per role, not a full retrieval engine
- **Effort:** ~0.5 days

### 8.2 Context inspection
- Each run records what context was actually used (`run_context_snapshot`: active rules, included sources, state summaries, available tools)
- Debugging surface in Talk UI: expand a message to see "Context used for this response"
- **Effort:** ~1 day

### 8.3 Lightweight retrieval
- When the task needs more than the default package: retrieve a small number of relevant resources or state entries by keyword/similarity
- This is NOT a full RAG pipeline — it's a targeted lookup when the default package is insufficient
- **Effort:** 1-2 days

### Phase 8 exit criteria
- Context is auditable per run (users can inspect what the agent saw)
- Role-aware context preferences work for at least one role type
- Lightweight retrieval provides relevant resources beyond the default package
- The context strategy builds on the standardized context-loader, not a parallel system

---

## Unsettled Questions

These are architectural decisions that don't need to be made now but will need resolution before or during their respective phases.

### Execution model (Phase 5 gate)
The current execution-resolver.ts is honest about v1 scope: direct HTTP only. Container-in-Talk is the next execution expansion. The key questions:

1. **Should `execution_kind` live on `registered_agents` or be computed at runtime?** Through Phase 5, routing is derived from effective permissions + runtime compatibility. Do NOT add an explicit `execution_kind` field until there are multiple real backends in Talk/Main AND a user-facing reason to expose the choice. Adding it before container-in-Talk is fully real creates a second source of truth that disagrees with the derived routing. If/when it's added (post Phase 5), it should be a user-declared preference, not the authoritative runtime decision — the runtime still validates compatibility.

2. **What happens when a user with only OAuth credentials tries to create a Claude agent for direct HTTP?** Currently: rejected with `ANTHROPIC_REQUIRES_API_KEY`. Future: if container-in-Talk exists, the agent could be created and routed to container execution automatically. This requires Phase 5 to be complete.

3. **Proxy path (v1.5):** `TALK_EXECUTOR_ANTHROPIC_BASE_URL` exists in the resolver specifically for the case where the host layer stands up a proxy that accepts API-key-style auth and translates to the user's actual credential. If this proxy ships before Phase 5, it closes the OAuth/subscription gap without container routing. This is the lowest-effort path to universal Claude agent support.

### Workspace rename (Phase 7+ gate)
When does "Talk" become "Workspace"? The north-star uses Workspace terminology. The current codebase uses Talk everywhere. Renaming is a large surface-area change (DB tables, API routes, frontend). Recommendation: defer rename until Phase 7+ when the workspace model is substantively different from a Talk. Premature rename creates confusion without product value.

### Multi-role execution (Post Phase 6)
The north-star describes Independent, Ordered, and Targeted execution modes for multi-role workspaces. v1 delivers Independent (fan-out panel — all agents respond to the same user turn). Ordered and Targeted require queue changes and explicit UI for role addressing. These should be built only after Rules + State are solid and there's real user demand for sequenced role execution.

### Main → Talk migration (Post Phase 7)
The product direction is decided: Main (Nanoclaw) eventually becomes a special Talk so it can sync with external channels. This migration happens when channel sync is built. Until then, Main runs on its own executor with `talk_id IS NULL`.

---

## Relationship to North-Star Architecture

WORKSPACE-REWRITE-PLAN.md defines the destination. This document defines the road.

| North-Star Concept | Build Plan Phase | Current State | Notes |
|---|---|---|---|
| Workspace | Phase 4+ | Talks exist | Talks evolve toward Workspaces incrementally |
| Threads | Phase 4 | `thread_id` column exists | Formalize with `talk_threads` table, backfill, make NOT NULL |
| Objective | Phase 4 | `talk_context_goal` exists, context-loader reads it | Expose editing UI |
| Rules | Phase 6 | `talk_context_rules` exists, context-loader reads, UI works (create/toggle/delete) | Elevate to primary surface, add reorder + inline edit |
| State | Phase 6 | Nothing exists | Genuinely new: `talk_state_entries` with CAS versioning + `update_state` agent tool |
| Roles | Phase 1 (partial) | `registered_agents` + `talk_agents` exist | Proto-roles via agent assignment |
| Data Connectors | Phase 7 | `talk_data_connectors` exists, attach UI works | Clarify UI taxonomy |
| Channel Bindings | Phase 7 | `talk_channel_bindings` + `talk_channel_policies` exist, create UI works | Complete edit/update, clarify UI taxonomy |
| Context Strategy | Phase 4 (basic) + 8 (full) | `context-loader.ts` already builds ContextPackage | Phase 4 standardizes; Phase 8 adds inspection + retrieval |
| Outputs | Future | Nothing exists | After context strategy is solid |
| Jobs | Future | Nothing exists | After rules + state prove the pattern |
| Execution Planner | Future | `execution-resolver.ts` handles direct HTTP | After container-in-Talk + context strategy ship |
| Credential Sources / Model Bindings | Future | execution-resolver.ts is the v1 version | |
| Multi-Role Execution | Future | Independent fan-out works | Ordered/Targeted later |

**Key insight:** Most of the north-star's primitives already exist in the schema and many already have working UI. The plan's job is to standardize, elevate, and complete them — not to create parallel concepts. Only `talk_threads`, `talk_state_entries`, and future entities (outputs, jobs, execution planner) require genuinely new schema.

---

## Required Test Coverage by Phase

Tests that must exist before a phase is considered complete. These are not optional polish — they guard against the specific integration gaps identified during review.

### Phase 2 tests
- **Stale/unverified connector runtime:** `runtime.ts` must have tests proving `buildConnectorToolDefinitions()` excludes connectors where `verificationStatus !== 'verified'`. `tool-executors.ts` must have tests proving `executeConnectorTool()` returns a tool error (not a crash or silent failure) when the connector is stale at execution time. `connector-accessors.ts` already includes `verificationStatus` on `TalkRunConnectorRecord`, so the data is available — the tests confirm the guards use it.

### Phase 4 tests
- **Thread migration completeness:** After migration, no `NULL` `thread_id` values exist in `talk_messages` or `talk_runs`. Every Talk has at least one thread.
- **Channel ingress threading:** Inbound channel messages (Slack, Telegram, WhatsApp) create messages and runs with a valid `thread_id`, not `null`. Test against `channel-accessors.ts` message/run creation paths.
- **Talk run creation:** All Talk executor paths (new-executor.ts, main-executor.ts) produce runs with `thread_id`. Test that creating a Talk run without `thread_id` fails.
- **SSE thread scoping:** SSE events for a thread do not include messages/runs from other threads in the same Talk.
- **Cancellation:** Cancelling a thread's runs does not cancel runs in other threads of the same Talk.
- **Summary suppression:** Threaded runs do not inject talk-level summary into context (per 4.1 decision).

### Phase 6 tests
- **CAS conflict detection:** Two concurrent `update_state` calls on the same key with the same `expected_version` — one succeeds, one returns a conflict error with the current value.
- **Provenance tracking:** Every state write records the correct `updated_by_run_id`.
- **Version monotonicity:** State entry `version` only increments, never decreases or resets.
