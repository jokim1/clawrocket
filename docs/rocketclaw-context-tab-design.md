# Context Tab V1

## Summary

- Add one `Context` tab per talk with 3 sections: `Goal`, `Rules`, and `Saved Sources`.
- Inject `Goal`, active `Rules`, and a compact saved-source manifest every turn.
- Inline only tiny text snippets.
- Use one tool, `read_context_source(sourceRef)`, for full source access on tool-capable routes.

## Key Changes

### Goal

- Optional, single-line, trimmed, no newlines.
- Hard limit: `160` characters.
- Inject as one compact system message when present.

### Rules

- Ordered list of persistent constraints.
- Max `8` active rules.
- Hard limit: `240` characters per rule.
- Support add, edit, pause, remove, reorder.
- Inject all active rules every turn.

### Saved Sources

- Types: `url`, `file`, `text`.
- Max `20` sources per talk in v1.
- Each source has:
  - stable `sourceRef` assigned at creation (`S1`, `S2`, ...)
  - `sortOrder` for user-controlled display priority
  - title
  - optional "why this matters" note
  - timestamps
  - normalized extracted text
  - status
- Reordering changes display and inline priority, but never changes `sourceRef`.
- Deleting a source never recompacts refs. Gaps are expected (`S1`, `S3`, `S5`).
  Subsequent sources continue from the next unused integer, never reuse old refs.

## Prompt Behavior

- Always include a compact manifest for all saved sources, not only the first 10.
- Manifest entry format includes:
  - `sourceRef`
  - type
  - title
  - optional note
  - availability status
- Keep manifest compact by truncating long title/note text in prompt rendering.
  - Title: max 80 chars in manifest, truncated with `…`
  - Note: max 120 chars in manifest, truncated with `…`
- No hidden `+N more` tail in v1.

### Tiny Text Inlining

- Only `text` sources are eligible.
- Inline full text when estimated size is `<= 250` tokens using rough `chars / 4` heuristic.
- Aggregate inline budget across the talk: `<= 600` estimated tokens.
- Tie-breaker: process eligible text sources in `sortOrder`; inline until the aggregate budget
  is exhausted; remaining eligible items fall back to preview-only in the manifest.
- URL and file sources are never auto-included as full bodies in v1.

## Source Tool

- Ship only `read_context_source(sourceRef)`.
- Return:
  - `sourceRef`
  - `type`
  - `title`
  - `note`
  - `status`
  - `totalChars`
  - `returnedChars`
  - `truncated`
  - `content`
- Return up to `12,000` characters of normalized extracted text.
- Store up to `50,000` characters of extracted text.
- No paging or offsets in v1; truncated reads are an explicit known limitation.
- If real usage shows agents repeatedly opening most sources every turn,
  revisit with batch read, broader inline thresholds, or limited Tier 2 include policy.

## Non-Tool-Capable Routes

- Goal, rules, manifest, and inline tiny text still apply.
- Saved-source full reads are unavailable.
- Show a clear UI warning before execution.

## Ingestion, Safety, and Refresh

### URL Fetch

- Allow only `http` and `https`.
- Max `5` redirects.
- Timeout: `15s`.
- Max response body: `10MB`.
- Allow MIME types: `text/plain`, `text/html`, `application/pdf`.
- No JS rendering in v1.
- SSRF protection must be enforced at socket connect time and on each redirect hop,
  not only at preflight DNS resolution (prevents DNS rebinding).
- Block loopback, private, link-local, multicast, and localhost targets.

### File Upload

- Max upload size: `10MB`.
- Allow MIME types: `text/plain`, `text/markdown`, `text/html`, `application/pdf`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- No images/OCR in v1.

### Extraction and Status

- Normalize extracted text and store up to `50,000` characters.
- Mark truncation explicitly.
- Core statuses: `pending`, `ready`, `failed`.
- If a source has last-good content and a refresh is running, agent-facing manifest
  status remains `ready`; refresh progress is UI-only.

### Refresh / Edit Flow

- URL: explicit `Re-fetch` action.
  - On success: replace extracted text and update timestamps.
  - On failure: preserve last-good extracted text, show refresh failure in UI only.
- File: explicit `Replace file` action on the same source record. No version history in v1.
- Text: edit in place.

## Data Model

### talk_context_goal

| Column | Type | Notes |
|---|---|---|
| `talk_id` | TEXT PK | FK → talks(id) ON DELETE CASCADE |
| `goal_text` | TEXT NOT NULL | Max 160 chars, trimmed, no newlines |
| `updated_at` | TEXT NOT NULL | |
| `updated_by` | TEXT | FK → users(id) |

### talk_context_rules

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `talk_id` | TEXT NOT NULL | FK → talks(id) ON DELETE CASCADE |
| `rule_text` | TEXT NOT NULL | Max 240 chars |
| `sort_order` | INTEGER NOT NULL | User-controlled |
| `is_active` | INTEGER NOT NULL DEFAULT 1 | 1 = active, 0 = paused |
| `created_at` | TEXT NOT NULL | |
| `updated_at` | TEXT NOT NULL | |

### talk_context_sources

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `talk_id` | TEXT NOT NULL | FK → talks(id) ON DELETE CASCADE |
| `source_ref` | TEXT NOT NULL | `S1`, `S2`, … — stable, never reused |
| `source_type` | TEXT NOT NULL | `url`, `file`, `text` |
| `title` | TEXT NOT NULL | User-editable |
| `note` | TEXT | Optional "why this matters" |
| `sort_order` | INTEGER NOT NULL | User-controlled display priority |
| `status` | TEXT NOT NULL | `pending`, `ready`, `failed` |
| `source_url` | TEXT | For `url` type |
| `file_name` | TEXT | For `file` type |
| `file_size` | INTEGER | For `file` type, bytes |
| `mime_type` | TEXT | For `url` and `file` types |
| `storage_key` | TEXT | For `file` type, reference to file storage |
| `extracted_text` | TEXT | Normalized content, up to 50,000 chars |
| `extracted_at` | TEXT | When extraction last succeeded |
| `extraction_error` | TEXT | Last error message if failed |
| `is_truncated` | INTEGER NOT NULL DEFAULT 0 | 1 if extracted text was truncated |
| `created_at` | TEXT NOT NULL | |
| `updated_at` | TEXT NOT NULL | |
| `created_by` | TEXT | FK → users(id) |

### talk_context_source_ref_counter

| Column | Type | Notes |
|---|---|---|
| `talk_id` | TEXT PK | FK → talks(id) ON DELETE CASCADE |
| `next_ref_number` | INTEGER NOT NULL DEFAULT 1 | Monotonically increasing, never resets |

## API Endpoints

```
GET    /talks/{talkId}/context                       — Full context snapshot (goal + rules + sources)
PUT    /talks/{talkId}/context/goal                  — Set or clear goal
GET    /talks/{talkId}/context/rules                 — List rules
POST   /talks/{talkId}/context/rules                 — Add rule
PATCH  /talks/{talkId}/context/rules/{ruleId}        — Edit rule text, toggle active, reorder
DELETE /talks/{talkId}/context/rules/{ruleId}        — Remove rule
POST   /talks/{talkId}/context/sources               — Add source (url, file, text)
PATCH  /talks/{talkId}/context/sources/{sourceId}    — Edit title, note, text content, reorder
DELETE /talks/{talkId}/context/sources/{sourceId}     — Remove source
POST   /talks/{talkId}/context/sources/{sourceId}/refetch  — Re-fetch URL content
POST   /talks/{talkId}/context/sources/{sourceId}/replace  — Replace file upload
```

## Test Plan

- Goal validation: trim, reject newline, reject over-160 chars, clear goal.
- Rules validation: per-rule limit, active-rule cap (8), reorder and pause behavior.
- Source ref stability: refs never recompact on delete; gaps remain; counter is monotonic.
- Source ordering: manifest and tiny-text inline priority follow persisted `sortOrder`.
- Source cap: reject source creation beyond 20 per talk.
- Prompt assembly includes goal, rules, and all manifested source refs, but not URL/file bodies.
- Tiny text snippets inline only within per-item (250 token est.) and aggregate (600 token est.) budgets,
  processed in `sortOrder`.
- `read_context_source` returns bounded content, `totalChars`, and correct truncation metadata.
- Non-tool-capable routes warn correctly and still apply goal, rules, manifest, and inline tiny text.
- URL safety: blocked internal targets, redirect handling, connect-time enforcement, timeout, size cap, MIME allowlist.
- Refresh: URL re-fetch preserves last-good content on failure; file replacement updates extracted text.

## Assumptions

- Typical talks will use `3-10` saved sources; `20` is a bounded v1 ceiling.
- Semantic search, embeddings, and paged source reads are out of scope for v1.
- `sourceRef` values are permanent. Deletion creates gaps; new sources always get the next integer.
- If real usage shows agents repeatedly opening most sources every turn, revisit.
