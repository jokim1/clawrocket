# Workspace Rewrite Plan (North-Star Architecture)

**Status:** Accepted as destination architecture
**Date:** 2026-03-14
**Scope:** Product model, runtime architecture, and migration plan for evolving ClawRocket from `Main + Talk` into `Main + Workspace + Thread`
**Build plan:** [PRAGMATIC-BUILD-PLAN.md](./PRAGMATIC-BUILD-PLAN.md) — phased implementation with decision gates
**Current work:** [ARCHITECTURE-REVIEW.md](./ARCHITECTURE-REVIEW.md) — active implementation order + technical decisions

> **Note:** This document defines the destination architecture. It is NOT a build plan.
> The phased build plan in PRAGMATIC-BUILD-PLAN.md defines what ships when, with
> explicit decision gates before each major phase. Each concept described here will be
> introduced incrementally as prior phases prove out.

## 1. Executive Summary

This document proposes a full product and architecture rewrite direction for ClawRocket without throwing away the existing codebase.

The key change is conceptual:

- `Main` remains the fast default personal assistant surface.
- `Workspace` becomes the durable container for a topic or objective.
- `Thread` becomes the focused conversation or task inside a workspace.

This structure better matches real usage:

- `Cal Football`
- `Black D1 Retention`
- `Kim Kids`
- `Gamemakers Content`

Each of those is not just "a chat." It is a persistent mission area with context, files, roles, connectors, outputs, and jobs.

## 2. What We Learned From ClawTalk

Reviewing ClawTalk changes the recommended shape in a few important ways.

ClawTalk already made several concepts first-class:

- `objective`
- `directives` / rules
- `jobs`
- `state`
- `platformBindings`
- `platformBehaviors`
- per-talk tools and execution policy

That matters because it shows what users actually found useful in practice, not what looks neat in a fresh taxonomy.

### 2.1 Objective is more useful than Overview

ClawTalk exposed `Objective` directly in the Talk config UI and API. That matches real usage better than a generic `Overview`.

For the rewrite:

- `Objective` should be a first-class editable workspace field.
- `Overview` should not be a primary config surface.
- If an overview exists at all, it should be a generated summary of recent work, not a top-level concept users manage.

### 2.2 Rules should stay first-class

ClawTalk had `directives`, and the UI already framed them as `Rules`.

That is the right product concept.

Examples:

- "If one of the Kim Kids writes about productive study time, add it to their weekly total in this format: xxx"
- "When drafting a public-facing retention memo, cite evidence and distinguish facts from inference."
- "For Cal Football updates, prioritize roster, injuries, recruiting, and game-impact changes."

Rules are not just prompt text. They are durable operating instructions for the workspace.

### 2.3 "Connectors" is too overloaded

ClawTalk and current ClawRocket prove that two different things are useful:

1. `Channel Bindings`
   - Slack
   - Telegram
   - WhatsApp
   - email-like inbound/outbound routing
   - behavior for how the workspace responds on those channels

2. `Data Connectors`
   - Gmail search/send
   - Google Docs / Drive / Sheets
   - analytics tools
   - domain APIs

These should be separate concepts in the product and the data model.

Do not collapse them into one vague "connector" bucket.

### 2.4 Which old concepts survive, and which should change

ClawTalk is useful as evidence, but it should not dictate the new architecture.

From first principles, a concept should survive only if it is at least one of:

- part of the user's real mental model
- durable workspace state
- operationally necessary for execution or automation
- important for auditability or reproducibility

Using that test:

**Keep as first-class concepts**

- `Objective`
- `Rules`
- `Threads`
- `Roles`
- `Outputs`
- `Jobs`
- `State`

**Keep, but reshape**

- `Knowledge` should become `Resources` plus `derived memory`
- `Connectors` should split into `Data Connectors` and `Channel Bindings`
- `Tools` should remain real in the data model but usually live under advanced configuration, not as the main user-facing object

**Demote or avoid**

- `Overview` as a hand-authored primary surface
- synthetic provider concepts that hide real execution differences
- forcing every advanced capability into a permanent top-level tab

### 2.5 State should be first-class

ClawTalk's state model is more important than it first appears, and it fits the new architecture well.

For many of the target workspaces, the system needs structured state, not just files and chat history.

Examples:

- `Kim Kids`: weekly study totals, deadlines, streaks, school-specific trackers
- `Cal Football`: roster changes, injury watch, schedule snapshots
- `Black D1 Retention`: intervention backlog, recurring metrics, follow-up status
- `Gamemakers Content`: editorial calendar, topic backlog, publishing pipeline

This means a workspace should not only have `Resources`; it should also have `State`.

`State` is where the system keeps structured facts, ledgers, counters, snapshots, and machine-readable trackers that rules and jobs can update.

### 2.6 Not every concept should become a top-level surface

The new architecture should be cleaner than ClawTalk, not more overloaded.

So there is an important distinction between:

- first-class data-model concepts
- first-class top-level UI surfaces

For example:

- `Data Connectors` and `Channel Bindings` should be separate in the model
- but they can still live together under one `Integrations` area in the UI

Likewise:

- `Tools`, runtime, permissions, and execution policy are real
- but they should usually live under `Advanced`, not compete with `Threads` or `Objective` in the main navigation

## 3. Product Model

The product should have three primary user-facing objects:

### 3.1 Main

`Main` is the default everyday AI surface.

It is for:

- quick questions
- ad hoc help
- general assistant behavior
- low-friction interaction

Main should feel like "just ask Nanoclaw."

### 3.2 Workspace

`Workspace` is a durable topic or objective hub.

A workspace is where users organize ongoing work around a domain, problem, or responsibility.

Examples:

- `Cal Football`
- `Black D1 Retention`
- `Kim Kids`
- `Gamemakers Content`

### 3.3 Thread

`Thread` is a focused discussion, task, or sub-problem inside a workspace.

Examples inside `Cal Football`:

- `Spring roster movement`
- `Stanford game preview`
- `Transfer portal watch`

Examples inside `Kim Kids`:

- `Aiden weekly study log`
- `Summer planning`
- `School advice`

## 4. Workspace Structure

After reviewing ClawTalk and pressure-testing it against NanoClaw's architecture, the recommended workspace structure is:

1. `Objective`
2. `Rules`
3. `Threads`
4. `Resources`
5. `State`
6. `Roles`
7. `Integrations`
8. `Outputs`
9. `Jobs`
10. `Advanced`

### 4.1 Objective

The workspace objective is the clearest description of what the workspace is for.

It should answer:

- What is this workspace trying to accomplish?
- What domain or responsibility does it cover?
- What kind of help should the system provide here?

This replaces `Overview` as the primary human-authored top-level description.

### 4.2 Rules

Rules are durable instructions that shape behavior within the workspace.

They should support:

- procedural rules
- formatting rules
- domain-specific policies
- data update rules
- escalation rules
- response boundaries

Rules should be editable, ordered, and pausable, following the successful ClawTalk pattern.

### 4.3 Threads

Threads are the day-to-day working units inside a workspace.

The workspace keeps shared context and configuration. Threads keep focused conversation state.

### 4.4 Resources

Resources are the workspace-attached information layer.

It should support:

- PDFs
- DOCX / PPTX
- images
- URLs
- notes
- extracted text
- source summaries
- pinned facts

This is broader and more useful than a narrow `Knowledge` label because it includes raw files, notes, sources, and derived summaries.

### 4.5 State

State is the workspace's structured tracking layer.

It should support:

- counters
- ledgers
- timelines
- snapshots
- named trackers
- machine-readable facts

This is where rules and jobs can update durable structured information.

For the `Kim Kids` example, "If one of the Kim Kids writes about productive study time, add it to their weekly total" is not just a prompt instruction. It is best modeled as:

- a workspace rule
- an inbound channel or message source
- a structured state update
- and optionally a weekly job that summarizes or reports on that state

### 4.6 Roles

Roles are workspace-scoped actors.

This is intentionally different from rigid agent-level personas.

A role defines:

- the role name
- mission in this workspace
- responsibilities
- out-of-scope behavior
- output style
- evidence expectations
- selected model binding
- selected capability profile

Examples:

- `Beat Analyst`
- `Retention Researcher`
- `Parenting Planner`
- `Content Strategist`
- `Draft Critic`

### 4.7 Integrations

Integrations are how a workspace interacts with external systems.

The model should distinguish two kinds:

1. `Data Connectors`
2. `Channel Bindings`

#### Data Connectors

Data connectors give the workspace access to external systems as data/tools.

Examples:

- Gmail
- Google Docs
- Google Drive
- Google Sheets
- PostHog
- domain APIs

These are for reading, writing, searching, and generating artifacts.

#### Channel Bindings

Channel bindings connect the workspace to external conversation surfaces.

Examples:

- Slack channel
- Telegram chat
- WhatsApp thread
- email ingress/egress

These are closer to ClawTalk's `platformBindings` and `platformBehaviors`.

Each binding should have behavior policy, for example:

- when to respond
- whether to mirror inbound messages into the workspace
- whether to mirror outbound assistant responses back to the channel
- which role should answer on that channel

### 4.8 Outputs

Outputs are first-class workspace artifacts.

Examples:

- Google Doc report
- draft email
- memo
- spreadsheet update
- blog draft

Outputs should not be buried only in the transcript.

### 4.9 Jobs

Jobs are recurring or event-driven automations attached to the workspace.

Examples:

- weekly football recap
- monthly retention review
- Sunday study-plan generation
- weekly content idea draft

This follows ClawTalk's successful treatment of jobs as first-class workspace automation.

### 4.10 Advanced

Advanced settings hold the lower-level execution and policy controls that are real but should not dominate the product model.

Examples:

- tool families available in the workspace after applying:
  - model/runtime capability
  - role capability profile
  - workspace policy
  - user permissions
  - approval requirements
- runtime selection
- filesystem/network policy
- per-workspace overrides for sensitive capabilities

## 5. Role Model

Roles should be primarily defined at the workspace level.

That is a change from a traditional agent-centric design.

### 5.1 Why roles should be workspace-level

In practice, the same model may play different roles in different workspaces or even in the same workspace at different times.

So the system should separate:

- `how it runs` from
- `what it can do` from
- `who it is here`

### 5.2 Role composition

Each role should be composed from:

1. `Model Binding`
2. `Capability Profile`
3. `Workspace Role Instructions`

#### Model Binding

Defines the runtime target.

Examples:

- `Claude via Anthropic API`
- `Claude via Claude Executor`
- `GPT-4.1 via OpenAI API`

#### Capability Profile

Defines the tool posture.

Examples:

- `Research + Web`
- `Operator + Docs + Email`
- `Heavy Tooling`
- `Content Production`

#### Workspace Role Instructions

Defines the role's actual job in this workspace.

Examples:

- `Cal Football Beat Analyst`
- `Retention Researcher`
- `Kim Kids Study Tracker`

## 6. Execution Architecture

The current system spreads execution decisions across providers, agents, env vars, and frontend assumptions. The rewrite should centralize this.

### 6.1 Execution planner

Introduce a single planning layer:

- `planExecution(input) -> RunPlan`

The planner decides:

- execution mode
- binding
- effective tools
- approval gates
- context package
- streaming behavior
- fallback behavior

### 6.2 Execution modes

Execution should be expressed explicitly as one of:

- `provider_http`
- `claude_executor`
- `container`

### 6.3 Runtime adapters

Adapters execute a `RunPlan`.

- `ProviderHttpRuntime`
- `ClaudeExecutorRuntime`
- `ContainerRuntime`

The runtime should not invent behavior or infer product semantics. It only executes the resolved plan.

## 7. Credential and Binding Architecture

The current architecture overloads `provider_id` with too many responsibilities.

That should be replaced with two first-class concepts:

### 7.1 Credential Sources

Credential sources own secrets and verification.

Examples:

- `anthropic_api`
- `claude_executor`
- `openai_api`
- `google_workspace`
- `gmail`

Each credential source owns:

- secrets
- auth scheme
- base URL / proxy
- verification state
- compatibility metadata

### 7.2 Model Bindings

Model bindings point to a credential source and describe a concrete runtime target.

Examples:

- `Claude Sonnet via Anthropic API`
- `Claude via Claude Executor`
- `GPT-4.1 via OpenAI API`

This cleanly separates:

- provider-backed HTTP execution
- executor-backed Claude access
- container-backed heavy-tool execution

## 8. Conversation Model

The database transcript remains the single source of truth.

That principle should not change.

### 8.1 Shared run model

Main and Workspace Threads should use the same underlying run/message model.

The difference between them is product framing and default configuration, not a separate architecture.

### 8.2 Context snapshots

Each run should record or reference the normalized context package it used.

That helps with:

- reproducibility
- debugging
- auditability
- explaining different agent outputs

## 9. Context Strategy

The system should not inject all workspace context into every prompt.

That is expensive, noisy, and usually worse.

The simplest good rule is:

> Inject a small default package, prefer explicit working-set context, retrieve only when needed, and leave the rest discoverable through tools.

This keeps the system efficient by default and adds complexity only when it clearly improves results.

### 9.1 Context sources

The planner should consider all relevant persistence surfaces, but it should not treat them all the same.

#### Canonical sources

These are the primary sources of truth:

- workspace objective
- active rules
- role instructions
- thread and message history in the database
- structured workspace state
- explicit resources and outputs
- jobs and integration metadata

#### Derived sources

These are helper artifacts, not truth:

- `context.md`
- `CLAUDE.md`
- summaries
- cached indexes
- affinity or retrieval caches

Derived sources are useful because they are compact, but they should not outrank canonical state when the two disagree.

### 9.2 Default context package

Most runs should start with the same small default package:

- workspace objective
- active rules
- role instructions
- current user turn or job input
- recent thread history
- short thread summary if available
- small state summary only if it is relevant

That is enough for many turns. The system should stop there unless the task clearly needs more.

### 9.3 Context build order

The planner should add context in this order:

1. `Default package`
2. `Explicit working set`
3. `Small relevant retrieval`
4. `Tool access for everything else`

This means:

- if the user selected a doc, email thread, or file, use that first
- if the task obviously needs more context, retrieve a small amount
- if the task still needs deeper access, let the agent use tools

This is simpler and usually more effective than trying to build a giant all-knowing prompt upfront.

### 9.4 What should almost never be injected by default

The system should not inject by default:

- all workspace files
- all outputs
- all jobs
- all connectors
- full state ledgers
- full archived history
- all messages across every thread

Those belong in retrieval or tool access, not in the base prompt.

### 9.5 State should be summarized first

Structured state is important, but raw state should rarely be injected in full.

Default behavior:

- inject a compact summary when relevant
- retrieve a few specific state entries if needed
- use tools for full ledger access

Example:

- inject: "Aiden has 6.5 productive study hours this week; goal is 10."
- retrieve: recent study entries for Aiden
- tool access: full study ledger across all kids

### 9.6 Resources should be selected, not dumped

For files and documents:

- inject titles and short summaries by default
- inject full content only for explicit working-set items or clearly relevant files
- otherwise use tools to open/search them on demand

This is especially important for large PDFs, docs, and slide decks.

### 9.7 Integrations should expose capability first, data second

Integrations should usually contribute capability awareness, not raw prompt data.

Examples:

- "Gmail is available for search and send"
- "Google Docs is available for read/write"
- "Slack binding exists for #retention-team"

Actual external data should usually be fetched only when needed.

### 9.8 Thread context should outrank workspace context

The planner should strongly prefer current-thread material before broader workspace material.

Priority order:

1. current turn
2. recent thread messages
3. thread summary
4. explicit working-set items
5. relevant workspace state/resources/outputs
6. archived or older material

This keeps the model focused on the actual task.

### 9.9 Role should affect context selection

Different roles should prefer different context.

Examples:

- `Beat Analyst`: roster, schedule, injuries, recent news
- `Draft Critic`: current draft, target audience, revision goals
- `Parenting Planner`: calendars, rules, state trackers

So context selection should be lightly role-aware, not purely generic.

### 9.10 Backend adaptation should stay simple

The planner should produce one logical context package.

Then:

- direct execution gets compact injected text and any necessary structured content
- container execution gets the same logical context, with large working-set items materialized as ephemeral files when useful

The important part is consistency of logical context, not identical prompt shape.

### 9.11 Minimal default algorithm

A simple default algorithm is enough for v1:

1. Build the default package.
2. Add explicit working-set items.
3. If the task needs more, retrieve a small number of relevant resources or state items.
4. If the task still needs more, rely on tools.

No more sophistication is needed until real usage proves it is necessary.

### 9.12 Context should be inspectable

For debugging and trust, each run should expose what context was actually used.

At minimum, the system should be able to show:

- active rules
- included resources
- included state summaries or snippets
- referenced outputs
- available capabilities

That is enough to debug most context failures without overbuilding a giant tracing system.

## 10. Multi-Role Execution Modes

Do not build hidden free-form role-to-role debate.

Support three explicit modes:

### 10.1 Independent

Selected roles respond independently to the same user turn.

This is the correct v1 default.

### 10.2 Ordered

Role B sees Role A's output before responding.

This supports patterns like:

- researcher -> critic -> synthesizer

### 10.3 Targeted

The user explicitly addresses one role.

These modes should be visible in the product, not hidden in runtime behavior.

## 11. UI Structure

The long-term UI should be:

- `Main`
- `Workspaces`

Inside a workspace:

- `Objective`
- `Rules`
- `Threads`
- `Resources`
- `State`
- `Roles`
- `Integrations`
- `Outputs`
- `Jobs`
- `Advanced`

### 10.1 Why not Overview

Based on ClawTalk and real usage, `Overview` should not be the primary user-maintained object.

Better approach:

- `Objective` is the authoritative user-authored statement.
- `Overview` can exist as a generated summary card if useful.

### 10.2 Suggested UI simplification

The model should stay rich, but the UI should stay focused.

A good default workspace UI is:

- `Objective`
- `Threads`
- `Resources`
- `State`
- `Roles`
- `Outputs`
- `Jobs`
- `Integrations`
- `Advanced`

This is intentionally simpler than exposing every low-level concept as a separate permanent tab.

## 12. Data Model

Suggested first-class entities:

- `workspaces`
- `workspace_threads`
- `workspace_rules`
- `workspace_state_streams`
- `workspace_state_snapshots`
- `workspace_roles`
- `credential_sources`
- `model_bindings`
- `capability_profiles`
- `workspace_resource_assets`
- `workspace_data_connectors`
- `workspace_channel_bindings`
- `workspace_outputs`
- `workspace_jobs`
- `runs`
- `messages`

This lets the product separate:

- conversation
- automation
- resources
- state
- channel behavior
- data access
- runtime execution

It should also add run-scoped context records, for example:

- `run_context_packages`
- `run_context_references`

These make context selection auditable and reproducible.

## 13. Migration Plan

> **Note:** The migration phases below describe a conceptual sequence — what to
> introduce, reshape, and delete.  They are NOT the build schedule.  See
> [PRAGMATIC-BUILD-PLAN.md](./PRAGMATIC-BUILD-PLAN.md) for the week-by-week
> execution plan with decision gates.  The migration phases here are numbered
> independently from the build plan's phases.

This should be an in-place migration, not a greenfield rebuild.

### 13.1 Migration Phase A

Introduce the new concepts beside the current system:

- credential sources
- model bindings
- workspace roles

Treat current `talks` as future `workspaces`.

### 13.2 Migration Phase B

Treat each current talk conversation as the first thread in that workspace.

### 13.3 Migration Phase C

Move current talk agent assignments to workspace roles.

### 13.4 Migration Phase D

Split current "connectors" into:

- data connectors
- channel bindings

### 13.5 Migration Phase E

Unify Main and Workspace Thread execution on the same run model.

### 13.6 Migration Phase F

Delete compatibility hacks:

- synthetic provider assumptions
- special-case credential bridging
- Talk/Main divergence where unnecessary

## 14. Immediate Product Guidance

Even before a full rewrite, the product direction should align with this model.

### 13.1 Rename direction

Long term:

- rename `Talk` to `Workspace` if it is the durable container
- use `Thread` for the conversation inside it

### 13.2 First-class surfaces to emphasize

For the current product, the surfaces worth emphasizing are:

- Objective
- Rules
- Roles
- State
- Integrations
- Jobs

These are the concepts users actually use to make a topic/objective hub valuable.

### 13.3 Avoid

Avoid reinforcing these long-term mistakes:

- one vague "connector" concept
- rigid agent-level personas as the only role mechanism
- synthetic provider abstractions that hide real runtime differences
- treating a workspace as just a chat with extra tabs

## 15. Final Recommendation

The best long-term organization for ClawRocket is:

- `Main` for everyday assistant use
- `Workspace` for a persistent topic/objective hub
- `Thread` for focused discussions and tasks inside a workspace
- `Objective` and `Rules` as first-class workspace configuration
- `Roles` as workspace-scoped actors
- `Data Connectors` and `Channel Bindings` as separate concepts
- `Outputs` and `Jobs` as first-class operational artifacts
- a single execution planner that resolves runtime behavior explicitly

That model best supports the kinds of applications users actually want:

- fandom and latest-info hubs
- family planning and tracking hubs
- research and program-improvement hubs
- writing and publishing hubs
- operational assistant hubs
