# Phase 0p / Phase 1A — editorialboard Kickoff

**Document type:** Editorial product spec + locked decisions for Phase 0p (current) and Phase 1A (the layered proof loop after 0p stop/go).
**Last updated:** 2026-05-03 (PURGE PR-4 rewrite — single-repo single-product framing; all rocketorchestra + Cloud Run sections removed).
**Audience:** Whoever picks up the editorial product mid-flight.
**How to use:** Read for product intent, locked decisions, and what to build. For cloud deploy plan, see `docs/CLOUD_TARGET.md`. For PURGE history, see `docs/PURGE_PLAN.md`.

**Companion docs:**

- [01_ARCHITECTURE.md](01_ARCHITECTURE.md) — substrate spec
- [02_HERO_APPLICATIONS.md](02_HERO_APPLICATIONS.md) — app spec
- [04_BUILD_PLAN.md](04_BUILD_PLAN.md) — engineering execution plan
- [05_DESIGN_BRIEF.md](05_DESIGN_BRIEF.md) — UX brief (high-level intent; canonical screen specs live in `design/`)
- [EDITORIAL_ROOM_CONTRACT.md](EDITORIAL_ROOM_CONTRACT.md) — internal validation contracts and JSON Schemas
- [OPTIMIZATION_LOOP.md](OPTIMIZATION_LOOP.md) — optimization loop spec the implementation must support
- [SCHEMA_DEFINITION.md](SCHEMA_DEFINITION.md) — persona schema
- [THEME_TOPIC_POINTS_DEFINITION.md](THEME_TOPIC_POINTS_DEFINITION.md) — definitions of editorial layers
- [SYNTHETICALRESEARCH_API_CHANGES.md](SYNTHETICALRESEARCH_API_CHANGES.md) — SSR API spec
- [CLOUD_TARGET.md](CLOUD_TARGET.md) — cloud port plan (Cloudflare + Supabase)
- **`design/01_setup.md`** — Setup screen — canonical UI spec
- **`design/02_theme_topics.md`** — combined Theme + Topics workspace — canonical UI spec
- **`design/03_points_outline.md`** — combined Points + Outline workspace — canonical UI spec
- **`design/04_draft.md`** — Draft editor with unified `+ OPTIMIZE` action — canonical UI spec

---

## Product intent

Joseph eventually takes a piece end-to-end through the layered flow — conceptually **Setup → Theme → Topic → Points → Research → Outline → Draft → Polish → Ship**, but the **visible UI consolidates these into 6 phase pills**:

```
01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP
```

Theme and Topic share one screen because the user's actual workflow is pick-a-Theme → drill-into-its-Topics in one flow. Points and Outline share one screen because Outline assembly happens _from_ Points (and the Sources tab covers Research). Setup defines deliverable, voice/length/destination, audience personas, LLM agent profiles, and scoring system before portfolio work starts.

Portfolio of themes/topics/points is real and persistent. The proof is portfolio-compounding across pieces, not speed on the first piece.

**Canonical screen specs live in `design/01-04*.md`. Read them before implementing any UI surface.**

---

## The 6-phase phase strip is the spine of the app

```
01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP
```

Navigation only — no audience/agent pickers, no Skill triggers in the strip itself.

## The five surfaces (one per phase cluster that has a UI of its own)

1. **Setup** (`01 SETUP`) — choose deliverable, voice/length/destination, audience personas, LLM agent profiles, and scoring system. Canonical spec: `design/01_setup.md`. Three-column layout: Setup Sections rail (~210px) + Active Section workspace + Live Preview rail (~330px). Sections are jumpable, not a strict wizard.
2. **Theme + Topics workspace** (`02 THEME + TOPICS`) — combined into one screen because pick-Theme-then-drill-into-Topics is one flow. Canonical spec: `design/02_theme_topics.md`. Four-column layout: Themes (~140px) + Topics (~155px) + center editorial detail + Sources rail (~210px). Per-persona score row as **column headers** above the detail. Notes panel uses typed boxes (NOT discussion); Panel Discussion debates the notes. Counter-Topics get red accent.
3. **Points + Outline workspace** (`03 POINTS + OUTLINE`) — combined into one screen with two layout states toggled by chevron divider (`‹/›`). Canonical spec: `design/03_points_outline.md`. State `a` (default): Notes-as-right-rail, Discussion-in-center. State `b`: Notes-as-center, Discussion collapsed to bottom drawer. Same data, two adapted layouts. Outline assembly happens via the `Outline · 5/5-7` tab in the left rail. Sources tab covers research. Note types per `THEME_TOPIC_POINTS_DEFINITION.md` §5: claim/evidence/thought/question/counter/other.
4. **Draft Editor** (`04 DRAFT`) — three-column: Outline rail (left, with per-segment scores) + draft prose (center, Tiptap) + Panel chat (right, scoped to active segment). Canonical spec: `design/04_draft.md`. Action toolbar consolidates earlier separate "research / novel / multi-pass / alternatives" chips into a **single unified `+ OPTIMIZE` button (⌘O)** with a scope-aware popover. Quick-action chips (FULL DRAFT ⌘D, POLISH ⌘P, EXPAND ⌘E, → CONTINUE ⌘\, ? MISSING ⌘M) live alongside but are single-pass and don't run the multi-stage Optimize pipeline. Polish is a mode-shift inside the Draft Editor (Skills rail switches headline skills); not a separate page.
5. **Ship/Export** (`06 SHIP`) — export pane for copy/download/Google Doc/Substack-flavored Markdown.

Polish and Ship are mode-shifts of the editor / export pane, not separate top-level surfaces.

**The Outline Builder is no longer a separate surface.** Outline assembly happens inline via the Outline tab in the Points + Outline workspace; the Panel Discussion serves as the construction surface. Earlier kickoff drafts had a dedicated Outline Builder page — that was dropped.

---

## Locked decisions

- **Persistence (Phase 0p):** SQLite via `better-sqlite3`, ten editorial tables (see [CLAUDE.md](../CLAUDE.md)). Existing local data is disposable.
- **Persistence (cloud):** Postgres via Supabase + Cloudflare Hyperdrive. Plan in [CLOUD_TARGET.md](CLOUD_TARGET.md). Greenfield install — no migration of local SQLite data.
- **Auth (Phase 0p):** local cookie session (`cr_access_token` / `cr_refresh_token` / `cr_csrf_token`).
- **Auth (cloud):** Supabase Auth with the cookie-based pattern designed in [CLOUD_TARGET.md §3](CLOUD_TARGET.md). RLS + per-transaction JWT-claim binding pattern.
- **Compute (cloud):** Cloudflare Worker (Static Assets + Hono `/api/*`). Single Worker, single deploy.
- **Editor canonical format:** Tiptap JSON (JSONB) plus per-revision Markdown snapshot (TEXT). Markdown is a derived projection, not the source of truth. Define a supported canonical Markdown subset and test JSON → Markdown → JSON as normalized structural equivalence for that subset, not byte-for-byte losslessness.
- **Suggestions anchor to the `revision_id` the Skill read.** In Phase 0p, prove block-level anchors first. The Tiptap→Markdown exporter must emit a concrete `MarkdownSourceMap` alongside the Markdown snapshot with stable block IDs/content hashes, block-level ProseMirror ranges, Markdown character-offset ranges, normalized text, and before/after context. Span-level refs are optional until the source-map feasibility spike proves deterministic generation and re-resolution. Skills receive the Markdown snapshot plus this source map and return `schema_version`, `revision_id`, source-map block refs, optional span refs only when supported, Markdown ranges, `anchor_quote`, and `anchor_content_hash`. Resolve through the source map first; quote/hash fallback is secondary. If anchor resolution is stale or ambiguous, mark it stale and require rerun; never guess.
- **Accepting or editing one suggestion creates a new revision.** Remaining suggestions from the same Skill run can be accepted only after re-resolving against the latest revision and proving the expected source span is unchanged. If revalidation fails, mark the suggestion stale and require a rerun.
- **Setup state:** stored on the Editorial Piece as `setup_state` plus `setup_version`. Changing Setup marks dependent scores, proposal runs, and draft brief snapshots stale.
- **Setup is required before Theme** — deliverable type, voice/length/destination, audience personas, LLM agent profiles, and scoring system persist on the Piece and appear in a secondary context bar. Do not put audience/agent controls in the phase strip.
- **LLM Room agents are profiles** — avatar, name, role, short description, model/provider, cost/status. Do not render them as anonymous chips only.
- **LLM Discussion must earn its keep** — every discussion/proposal action records retained vs rejected output, estimated cost, elapsed latency, and partial-provider failures. If it does not produce retained notes/point improvements within the 0p budget, collapse it into narrower proposal buttons such as `Improve toward score` and `Research this point`.
- **Notes are freeform typed blocks** — Thought, Claim, Evidence, Question, Counterpoint. Do not force point notes into rigid form fields.
- **Scores apply before drafting** — Theme, Topic, and Point cards can show aggregate and persona-specific scores from the selected scoring pipeline. Store visible scores as `score_snapshots` keyed by Piece, `setup_version`, object ref/content hash, scoring pipeline ref, and selected persona refs. AutoResearch/AutoNovel-style improvement actions are explicit per-object actions; they never auto-promote or overwrite.
- **LLM Discussion is editorial-scoped** — use `discussion_sessions` scoped by Piece, phase, active object ref/hash, and `setup_version`, with `talk_kind='editorial_scoped'`.
- **Point notes are Piece-local working notes** — use `point_note_blocks` scoped by Piece, point ref, and `setup_version`. Notes stay Piece-local until the user explicitly promotes durable notes to the persistent `point` page.
- **Themes are manually seeded for v1** — Joseph hand-writes 5–7 themes plus the default `theme/misc`. AI-propose-themes ships in 1A.5.
- **Hierarchy:** strict by default — every topic has a parent theme (defaults to `theme/misc` for orphans); every point has exactly one parent topic. Multi-parent points and cross-references are deferred.
- **Outline is structured artifact; chat is construction surface.** Outline assembly happens _within the combined Points + Outline workspace_ via the `Outline` tab in the left rail. Outline (not chat history) is what flows to Draft.
- **Acceptance is portfolio-compounding, not speed.** Time-to-first-piece is 3–5 hours expected. Time-to-fifth-piece-on-same-theme drops to ~90 minutes because portfolio compounds.
- **First export targets:** Markdown copy, Markdown download, Google Docs, Substack-flavored Markdown. Export acceptance must prove destination fidelity, not just local string generation.

---

## Phase 0p milestones (current)

- **0p Portfolio Contract:** Prove Setup, Theme/Topic, Points/Notes, fixture LLM Discussion, score states, and proposal accept/edit/reject/park locally.
- **0p Editor Contract:** Prove editor anchoring, suggestions, revision append, stale handling, and Substack Markdown locally.

Stop/go memo lives at `docs/PHASE_0P_STOP_GO.md`. After GO, cloud port begins per [CLOUD_TARGET.md](CLOUD_TARGET.md).

## Phase 0p validation work

0p-a. Prove the Setup/portfolio loop locally using the current SQLite stack and fixture data. Build the smallest real vertical slice: Setup surface, setup context bar, Theme/Topic workspace, Points/Notes workspace, fixture LLM Discussion, score-state rendering, and proposal accept/edit/reject/park. This validates the workflow and data contracts.

0p-b. Prove the Editorial Room editor loop locally. Build the smallest real vertical slice: Tiptap draft editor, Markdown snapshot generation with block-level `MarkdownSourceMap`, anchor resolver, fixture Skill suggestions shaped exactly like the planned `Suggestion[]`, suggestion overlay, accept/reject/edit, revision append, and Substack-flavored Markdown copy/download.

0p-b1. Run a source-map feasibility spike before building span-level anchoring. Verify the installed Tiptap Markdown support, freeze the supported Markdown subset, and prove block-level anchors first. Span-level refs are allowed in 0p only after paragraph/list/table/code fixtures prove deterministic source-map generation, re-resolution after edits, and stale/ambiguous handling.

0p-1. Freeze the executable contract. JSON Schemas under `docs/contracts/editorial-room/v0/*.schema.json` for `SetupState`, `Theme`, `Topic`, `Point`, `PointNote`, `point_note_blocks`, note promotion payloads, `ScoreSnapshot`, `ScoreResult`, `discussion_sessions`, LLM Discussion turns/proposals, `MarkdownSourceMap`, `Suggestion[]`, `run_skill`, and `get_run`. The contract specifies schema versions, required/nullable fields, idempotency replay behavior, stale revision/hash behavior, payload caps, and source-map anchor semantics. JSON Schemas are the canonical machine contract: every schema has `$id`, `schema_version`, required/nullable fields, payload caps where applicable, and `additionalProperties: false` unless an explicit extension object is reserved.

0p-2. Add fixture files for one setup selection, one portfolio of themes/topics/points/notes, score snapshots/results in `pending` / `unknown` / `stale` / `partial` / `scored` states, scoped LLM discussion sessions and proposals, partial-provider timeout/failure examples, retained/rejected proposal outcomes, cost/latency budget metadata, one GameMakers draft, one Adversarial Cut response, and one Opus Review response. Draft fixtures must include `schema_version`, `revision_id`, `target_content_hash`, block-level `MarkdownSourceMap` entries, optional source-map span references only if the feasibility spike passes, anchor metadata, categories, rationale, and replacements/cuts.

0p-3. Local portfolio acceptance gate: Joseph can choose setup, select a theme/topic, select one active point, add Thought / Claim / Evidence / Question / Counterpoint notes, run fixture `Find stronger topics` / `Improve toward score` / `Research this point`, and accept/edit/reject/park proposals. The LLM Discussion/proposal panel must show which outputs were retained, estimated cost, elapsed latency, and partial-provider status; one failed/timed-out agent still returns a usable partial result and does not block accept/edit/reject/park.

0p-4. Local editor acceptance gate: Joseph can paste or load the fixture draft, render block-level anchored suggestions, accept one, reject one, edit one, see a new revision, mark stale suggestions safely, and export Substack-flavored Markdown. If either local gate fails, fix the contract before continuing.

0p-5. Write `docs/PHASE_0P_STOP_GO.md`. GO only if Joseph can complete the local portfolio and editor flows without manual DB/JSON edits, rates the workflow at least 4/5 useful or says he would use it for the next GameMakers article, retains at least one proposal/discussion output as a note or point improvement, LLM Discussion/proposal actions stay within the recorded 0p cost/latency budget, partial provider failure degrades cleanly, and boundary/performance tests pass. If Setup feels like form-filling, scoring is decorative, LLM Discussion is noisy or unretained, provider failures block the flow, anchoring is brittle, or export is unused, simplify and rerun 0p instead of migrating.

## Phase 1A app work (after 0p GO; cloud port runs in parallel per CLOUD_TARGET.md)

12. **Phase-aware workspace shell + 6-pill compact top phase strip.** Build `webapp/src/pages/EditorialRoomShell.tsx` and `webapp/src/components/PhaseStrip.tsx`. Strip shows **6 pills**: `01 SETUP | 02 THEME + TOPICS | 03 POINTS + OUTLINE | 04 DRAFT | 05 POLISH | 06 SHIP`. Active pill has dark fill + light text; visible-but-not-active pills muted with status text. Click navigates to that phase's surface. **Phase strip is navigation only** — keep audience/agent pickers, Skill triggers, and any workflow controls out of the strip. Canonical spec: `design/01_setup.md` §2 + §4.

13. **Setup surface.** `webapp/src/pages/EditorialSetupPage.tsx`. Canonical spec: `design/01_setup.md`. Three-column layout: Setup Sections rail (~210px, jumpable not strict-wizard) + Active Section workspace + Live Preview rail (~330px). Four sections: Deliverable, Audience, LLM Room, Scoring System. User selects deliverable type, voice, length target, destination, audience personas from a persona library, LLM agent profiles from an agent library, and scoring system. Setup persists on the Editorial Piece as `setup_state` with `setup_version` and appears in a secondary context bar below the phase strip. Any Setup change marks dependent score/proposal/draft-brief snapshots stale.

14. **Theme + Topics workspace (combined).** `webapp/src/pages/ThemeTopicsWorkspacePage.tsx`. Canonical spec: `design/02_theme_topics.md`. Four columns: Themes (~140px) + Topics (~155px) + Center editorial detail + Sources rail (~210px). The center detail is the active Topic's workspace (one-liner, Notes, Panel Discussion). The Panel Discussion binds to the active Topic ref/hash/setup version with `talk_kind='editorial_scoped'`. Notes are typed boxes with fixed types per `THEME_TOPIC_POINTS_DEFINITION.md` (NOT a discussion thread). Counter-Topics get a separate sub-section with red accent border.

15. **Points + Outline workspace (combined; chevron-toggleable).** `webapp/src/pages/PointsOutlineWorkspacePage.tsx`. Canonical spec: `design/03_points_outline.md`. Left rail has tabs: `Points 8 | Outline · 5/5-7 | + POINT | OPT...`. Center column shows active Point detail (claim + stake + per-persona score row + 4 NOTES badge). Right rail (state `a`): Notes panel with typed boxes (claim/evidence/thought/question/counter/other; one-letter codes T/C/E/Q/!/O); Panel Discussion takes the main center area. State `b`: Notes take the center column; Panel Discussion collapses to a quiet bottom drawer. Toggle: chevron on the divider, keyboard `⌘]` / `⌘[`, drag the divider. **Annotation: "panel never disappears, just gets quieter"** — even in state `b` the drawer shows the latest turn summary. Notes are freeform typed blocks scoped to the active Point and stay Piece-local until explicitly promoted. Counter-Points get a separate sub-section with red accent border.

15a. **Score snapshots + score-improvement actions.** `webapp/src/features/scoring/*` plus a `score_snapshots` migration. Store each visible score snapshot by `piece_id`, `setup_version`, object ref, object content hash, scoring pipeline ref, selected persona refs, status, freshness timestamp, and `ScoreResult`. Add explicit per-object actions such as `Find stronger topics`, `Improve toward score`, and `Research this point`. Returned work is a proposal, note, or suggestion that the user accepts/edits/rejects.

16. **Outline assembly (folded into Points + Outline workspace, NOT a separate page).** Implementation: `webapp/src/features/outline/OutlinePanel.tsx` is a tab component inside `PointsOutlineWorkspacePage.tsx`, not a separate page. The `factory_outline_builder` Skill is invoked from a button in the Outline tab; when run, it updates the structured outline alongside the Panel Discussion. User can also direct-edit outline (drag-reorder Points in the left rail, attach/detach Points, edit hook). Outline (NOT chat history) is the artifact that flows to Draft.

17. **Draft Editor (three-column).** `webapp/src/pages/DraftWorkspacePage.tsx`. Canonical spec: `design/04_draft.md`. Three columns: Outline rail (left, ~210px, with per-segment scores and tabs `Outline · 5/5-7 | Sources · 4 | Versions · 3`) + draft prose center (Tiptap, flex 1 ~720–880px) + Panel chat right (~280px, scoped to active draft segment). Top action toolbar:

```
FULL DRAFT ⌘D   POLISH ⌘P   EXPAND ⌘E   → CONTINUE ⌘\   ? MISSING ⌘M   ┃   + OPTIMIZE ⌘O    SCOPE: WHOLE DRAFT
```

- **Quick-action chips** (left of separator): single-pass, fast (<5s), don't run the multi-stage Optimize pipeline.
- **`+ OPTIMIZE` button** (right of separator, accented): the headline change. Opens a popover (does NOT immediately optimize). Popover shows: scope echo, dynamic description, 4 stages (`AUTORESEARCH → AUTONOVEL → PANEL PASS → PROPOSE 2–3`), cost preview (`≈28K TOK · 12S · ≈$0.08`), `CUSTOMIZE` (full stage config), `RUN ⌥↵`.
- **Scope chip** (right of OPTIMIZE): `SCOPE: <label>` auto-detected from cursor selection — `WHOLE DRAFT` (no selection), `§ POINT 2`, `PARAGRAPH 3`, `SELECTION`. Click cycles manually.
- **Sub-meta bar** (above toolbar): `1,247 / 1,200–1,400 WORDS · 7.6 SSR · ✓ GATES · LAST AUTOSAVE 11:52`. When Setup target is missing, render `1,247 WORDS · ⚠ NO TARGET · …` with the chip clickable to jump to Setup → Deliverable.
- **Skills rail behavior**: Polish skills (Adv Cut, Opus Review) are NOT in the Panel chat by default; they appear when user enters Polish mode. Layer-1-3 critics (Argument Critic, Counter-Audience, Claim Coverage) run as part of the `+ OPTIMIZE` Panel Pass stage and via proposal chips inside the Panel chat.
- **Post-Run UX**: side-by-side alternatives appear in the center column. Arrow keys + `↵` to accept, `Esc` dismiss, `⌘Z` revert.
- **Autosave**: every ~1 minute, only if changes occurred since last snapshot.
- **Versions tab**: hybrid named (durable: pre/post-Optimize, manual save, phase entry/exit) + auto (last 20 autosaves, FIFO prune).
- Inline mechanical scorer + voice-lock banner per the v3 spec. Suggestion overlay + revision history per v3 spec.

18. **Production Brief side rail.** `webapp/src/features/brief/ProductionBriefRail.tsx`. Shows Deliverable + Voice + Audience + Scoring System + current Theme + Topic + selected Points/Notes + Outline summary. Click any item to navigate back to its source surface. Used by both the Draft Editor and the Polish mode.

19. **Polish stage (mode-shift inside Draft Editor).** When user clicks "Send to Polish" from Draft, the Skills rail mode-shifts: now shows `factory_adv_cut` and `factory_opus_review` as headline skills. Same suggestion overlay + revision history as Draft. The user still writes in Tiptap; Polish is a mode shift, not a separate page.

20. **Voice-lock banner.** `webapp/src/features/editor/VoiceLockBanner.tsx`. Shows voice page slug; click opens side sheet.

21. **AI suggestion overlay (ProseMirror).** `webapp/src/features/editor/SuggestionOverlay.ts` and `webapp/src/features/editor/SuggestionPopover.tsx`. Decoration maps rebuild only when source revision/content hash/suggestion set changes. Stale/ambiguous suggestions are visible but cannot be accepted. After accept/edit creates a new revision, revalidate all remaining pending suggestions from the old revision against the latest source map; keep only suggestions whose source span still resolves unchanged.

22. **Inline mechanical scorer.** `webapp/src/features/editor/MechanicalScorerInline.ts`. Run on save and debounced idle work, not every keystroke/render. `requestIdleCallback`, Web Worker, or save-only fallback for large drafts.

23. **Skills rail with `run_skill` dispatch.** `webapp/src/features/editor/SkillsRail.tsx`. Mode-aware (Draft mode shows layer-1-3 skills; Polish mode shows layer-4 skills). Show expected runtime/cost from verified provider/model metadata when available; render unknown when stale/missing. Dispatch `run_skill` with `schema_version`, `idempotency_key`, `target_revision_id`, `target_content_hash`, Markdown snapshot, and `MarkdownSourceMap`. Same idempotency key replays the same run/result; never enqueues duplicate jobs. Poll `get_run` with backoff, `Retry-After`, abort-on-unmount/navigation, hidden-tab slowdown, recoverable timeout state. Persist returned suggestions only if revision/hash still matches.

24. **Revision history panel.** `webapp/src/features/editor/RevisionHistory.tsx`. Revert creates a new revision; nothing is destroyed.

25. **Ship/Export pane.** `webapp/src/features/editor/ExportPane.tsx`. Four buttons: copy plain Markdown, copy Substack-flavored Markdown, download `.md`, open/update Google Doc via `user_google_credentials`. Destination-fidelity fixture tests for Substack paste/import and Google Docs create/update across headings/lists/links/tables/code/blockquotes/hard breaks/spacing.

26. **`optimization_rounds` table + persistence (per `EDITORIAL_ROOM_CONTRACT.md` §4.7).** Migration + accessor for the full nested shape: `OptimizationRound` with `top_k: TopKCandidate[]` containing `rubric_scores: Record<axis, RubricScore>`, `ssr_distributions: SsrPersonaResult[]`, `counter_audience: CounterAudienceResult[]` (Drafts only), `comparable_history`, `diversity_position`, `composite_score`, `novelty_bonus`, `cohort_coverage_score`. Indexes on `piece_id` + `setup_version`. Stale flag set on Setup change per §1.

27. **Cost preview + launch UX (inside the unified Optimize popover, not a separate modal).** `webapp/src/components/optimization/OptimizePopover.tsx` + `webapp/src/components/optimization/OptimizeCustomizePanel.tsx` + `DoubleConfirmModal.tsx`. Canonical spec: `design/04_draft.md` §5. Cost estimate inside the popover: `≈28K TOKENS · 12S WALL · ≈$0.08`. Estimator targets ±20% accuracy; uses static per-stage multipliers initially, switches to learned multipliers from the `optimization_cost_calibration` ledger after ~20 runs of a given stage. `CUSTOMIZE` button in the popover footer expands to per-stage parameter controls. Mandatory double-confirm modal **only** for `target_kind = "draft_fullsearch"` per `OPTIMIZATION_LOOP.md` §5.3 (this fires AFTER the user clicks `RUN ⌥↵` in the popover).

28. **Mid-run progress UX (inline in the Draft toolbar, not a separate progress bar).** `webapp/src/components/optimization/RunProgressChip.tsx` + `ProgressDetailDrawer.tsx`. Canonical spec: `design/04_draft.md` §5.6. While Optimize is running, the toolbar `+ OPTIMIZE` button shows a spinner and label changes to `OPTIMIZING… 7s` (live elapsed). A small progress chip in the toolbar shows current stage. Click chip opens `ProgressDetailDrawer.tsx` for live cost-so-far, projected-actual, current iteration, current phase, `partial_provider_failures` badge. User can keep editing other parts of the draft while Optimize runs. Mid-run **Cancel** button (in the drawer) preserves `acceptable_pool_ids`.

29. **Top-K candidate display + ProposalCard contents.** `webapp/src/components/optimization/TopKList.tsx` + `ProposalCard.tsx` (extend) + `ScoreBreakdown.tsx`. Per-candidate ProposalCard surfaces `rubric_scores` (per axis with gap quote and fix), `ssr_distributions` (full PMF per primary persona with confidence), `counter_audience` objections (Drafts only), `comparable_history`, `diversity_position`. Diversity-reserved slots labeled (`cohort-reservation` / `novelty-reservation`). User accepts from top-K (single-select for Topic/Outline; multi-select for Points).

30. **Post-run report UX.** `webapp/src/components/optimization/RunReport.tsx` + `RejectReasonHistogram.tsx`. Convergence reason, cost actual vs estimate, reject-reason histogram (e.g., "18× specificity_lt_3, 12× diversity_lt_0_4, 9× disputability_lt_3"). Useful for diagnosing tight gates / weak persona panels.

31. **Settings → Optimization page.** `webapp/src/pages/SettingsOptimizationPage.tsx`. User-configurable diversity floor (default 0.4 per `OPTIMIZATION_LOOP.md` §4.2), per-Skill default `n_candidates` / `n_iterations` / `budget_usd` / `top_k_returned`. Reset-to-documented-defaults button.

32. **PCP-window selector UI in Theme search.** `webapp/src/components/optimization/PcpContextSelector.tsx` + Theme-search launch flow. When launching `factory_theme_propose_optimize`, user can optionally enable PCP context, select window (last N days; default null = no PCP), select PCP types from {`calendar`, `linear`, `slack_dm`, `work_this_week`, `github_activity`, `manual_notes`}.

---

## Milestone acceptance

- **0p-Portfolio:** executable setup/portfolio/scoring contract exists → choose setup → theme/topic selection → active point → typed notes → fixture proposal action → accept/edit/reject/park proposal.
- **0p-Editor:** executable draft contract exists → Tiptap Markdown support and supported subset are verified → paste or load the fixture draft → render block-level source-map anchored suggestions → accept/reject/edit → create a new revision → mark stale suggestions safely → copy/download Substack Markdown → Substack fixture output preserves expected publish structure.
- **1A-Cloud:** PURGE complete → cloud port Phase B–E ship per [CLOUD_TARGET.md](CLOUD_TARGET.md). Cookie-based Supabase Auth with per-transaction JWT-claim binding; RLS multi-user gate passes; Worker CPU benchmark passes; rate limit + spend cap + Sentry wired before public beta.
- **1A-Portfolio Core:** production Setup + Theme/Topic + Points/Notes works against live page/scoring contracts; fixture proposal actions can be swapped to live Skill results without changing UI.
- **1A-Draft/Polish/Ship:** paste a real 1500-word draft → run Adversarial Cut → accept/reject/edit suggestions → run Opus Review → accept suggestions → revision history is correct → mechanical scorer warnings render without slowing input → Markdown/Substack export works against destination fixtures.
- **1A-Integrations:** voice page opens, Google Doc export works, provider metadata renders unknown/stale honestly, streaming parser fixtures pass.
- **Full Phase 1A:** Joseph can paste into Substack and publish without manual workarounds.

---

_End of editorialboard kickoff._
