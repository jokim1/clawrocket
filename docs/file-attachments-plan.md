# File Attachments for Talks

## Context

Users want to share files (PDFs, text documents, spreadsheets) with agents in Talks for analysis and discussion. Today, Talks only accept plain text messages. The existing "saved sources" feature supports URL and text sources in a side panel, but has no file upload UI and no way to attach files inline with messages. The most natural interaction — drag a file into the chat — doesn't exist yet.

This plan adds **message-level file attachments** as the primary file sharing mechanism, with an optional path to promote attachments into persistent saved sources.

---

## File Persistence Recommendation

**Hybrid approach: inline for current turn, tool-accessible forever.**

- When a user attaches a file, the extracted text is included **inline with their message** for the current turn so the agent has immediate, full context without needing a tool call.
- For all **subsequent turns**, the message in history shows a compact marker (`[Attached: report.pdf]`) — the full extracted text is stripped from the history representation to save context budget.
- The agent can call `read_attachment(attachmentId)` at any time to retrieve any attachment's content from any prior message.
- The raw file and extracted text persist in storage/DB **for the lifetime of the Talk** (deleted when the Talk is deleted, or via a 90-day cleanup job for archived Talks).

**Why this is the right tradeoff:**
- First-turn inlining means the agent can analyze the file immediately without a roundtrip tool call — this matches user expectations.
- Stripping from historical turns prevents N large files from blowing up the context window across a long conversation.
- Tool access means the agent can always go back to any file when the user asks follow-up questions ("now break that spreadsheet down by quarter").
- No confusing expiration behavior for users. The file is there until the Talk is gone.

---

## Phase 1: Storage & Extraction Foundation

### 1a. Database schema

**File:** `src/clawrocket/db/init.ts` — add after `talk_context_sources` table (~line 677)

```sql
CREATE TABLE IF NOT EXISTS talk_message_attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES talk_messages(id) ON DELETE CASCADE,
  talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  extracted_text TEXT,
  extraction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(extraction_status IN ('pending', 'extracted', 'failed')),
  extraction_error TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
-- Lookup attachments by message
CREATE INDEX IF NOT EXISTS idx_tma_message ON talk_message_attachments(message_id);
-- Lookup all attachments in a talk (for cleanup, tool access)
CREATE INDEX IF NOT EXISTS idx_tma_talk ON talk_message_attachments(talk_id, created_at);
```

Wrap in try/catch for migration safety (same pattern as existing column migrations in init.ts).

### 1b. DB accessor functions

**File:** `src/clawrocket/db/context-accessors.ts` — add new section

Functions to add:
- `createMessageAttachment(input)` → `MessageAttachmentRecord`
- `listMessageAttachments(messageId)` → `MessageAttachmentRecord[]`
- `listTalkAttachments(talkId)` → `MessageAttachmentRecord[]` (for tool manifest)
- `getMessageAttachmentById(attachmentId, talkId)` → `MessageAttachmentRecord | null`
- `updateAttachmentExtraction(input: { attachmentId, extractedText?, extractionError?, extractionStatus })` → void
- `deleteMessageAttachments(messageId)` → number (count deleted)

Interface:
```typescript
interface MessageAttachmentRecord {
  id: string;
  message_id: string;
  talk_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_key: string;
  extracted_text: string | null;
  extraction_status: 'pending' | 'extracted' | 'failed';
  extraction_error: string | null;
  created_at: string;
  created_by: string | null;
}
```

### 1c. File storage on disk

**New file:** `src/clawrocket/talks/attachment-storage.ts`

Store raw files at `{STORE_DIR}/attachments/{talkId}/{attachmentId}.{ext}`.
- `saveAttachmentFile(attachmentId, talkId, buffer, fileName)` → `storageKey` string
- `loadAttachmentFile(storageKey)` → `Buffer`
- `deleteAttachmentFile(storageKey)` → void
- Use `fs.promises` for async I/O. Create directories with `{ recursive: true }`.
- `STORE_DIR` imported from `src/config.ts` (already exists, value is `./store`).

### 1d. Extraction pipeline

**New file:** `src/clawrocket/talks/attachment-extraction.ts`

**New dependencies** (add to `package.json`):
- `pdf-parse` — lightweight PDF text extraction
- `mammoth` — DOCX → text/markdown
- `exceljs` — Excel spreadsheet parsing

Extraction router function:
```typescript
async function extractAttachmentText(buffer: Buffer, mimeType: string, fileName: string): Promise<string>
```

| MIME type | Library | Strategy |
|-----------|---------|----------|
| `text/plain`, `text/markdown`, `text/csv` | — | Direct UTF-8 decode |
| `text/html` | — | Reuse `extractTextFromHtml()` from `source-ingestion.ts` (export it) |
| `application/pdf` | pdf-parse | Extract text layer; mark `[scanned PDF]` if empty |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | mammoth | Extract as markdown |
| `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | exceljs | Concat sheets as `## Sheet: {name}\n` + rows as pipe-delimited tables, max 10 sheets |

Limits: truncate at 50,000 chars with `[…truncated]` marker. On error, write descriptive message to `extraction_error`.

Also: **export `extractTextFromHtml` from `source-ingestion.ts`** so both pipelines share it. Currently it's a module-private function.

---

## Phase 2: Upload API

### 2a. Upload endpoint

**New file:** `src/clawrocket/web/routes/talk-attachments.ts`

**Two-step upload flow:**
1. `POST /talks/:talkId/attachments` — upload file, returns `attachmentId` (not yet linked to a message)
2. Existing `POST /talks/:talkId/messages` — extended to accept `attachmentIds: string[]`, links attachments to message

Why two-step: keeps the message endpoint JSON-only (no multipart), lets extraction start while the user is still typing, and gives the frontend an attachment preview before send.

**Upload endpoint handler:**
```typescript
export async function uploadTalkAttachmentRoute(c: Context): Promise<Response>
```

- Parse multipart body via Hono's `c.req.parseBody()` (native support, no extra lib)
- Validate: talk exists, user has edit access, file size ≤ 10 MB, MIME type in allowlist
- Save file to disk via `saveAttachmentFile()`
- Create DB record with `extraction_status: 'pending'`
- Run extraction synchronously (files are small, extraction is fast) — update DB with result
- Return `{ ok: true, data: { attachment: { id, fileName, fileSize, mimeType, extractionStatus } } }`

Orphan cleanup: attachments not linked to a message within 1 hour are deleted by a periodic check (add to existing cron-like task runner if one exists, or note as future work).

**Validation constants:**
```typescript
const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_ATTACHMENTS_PER_MESSAGE = 5;
```

### 2b. Extend message send

**File:** `src/clawrocket/web/routes/talks.ts` — modify message creation handler

Accept optional `attachmentIds: string[]` in the request body. After creating the message:
1. For each attachmentId: verify it belongs to this talk, is unlinked (message_id is null), and link it by updating `message_id`.
2. This means the schema needs a small tweak: `message_id` should be **nullable** initially (set on link), not a NOT NULL constraint. Update the schema to:
   ```sql
   message_id TEXT REFERENCES talk_messages(id) ON DELETE CASCADE,
   ```
   (Remove NOT NULL, add it conceptually via the link step.)

### 2c. Register routes

**File:** `src/clawrocket/web/server.ts`

Add `POST /api/talks/:talkId/attachments` route pointing to the new handler. Needs multipart body parsing, so apply `bodyLimit` but **not** the JSON body parser for this route.

---

## Phase 3: Agent Integration

### 3a. Context assembler changes

**File:** `src/clawrocket/talks/context-assembler.ts`

Extend `ContextAssemblyInput`:
```typescript
currentTurnAttachments?: Array<{
  id: string;
  fileName: string;
  mimeType: string;
  extractedText: string | null;
  extractionStatus: string;
}>;
```

Modify `assembleTalkPromptContext()`:

**Current user message augmentation** (~line 200): Before building the `currentUserMessage` PromptMessage, prepend attachment content:

```
[Attached files]
- report.pdf (application/pdf, 3.2 MB)
- data.xlsx (spreadsheet, 1.1 MB)

--- Content of report.pdf ---
[extracted text, up to ~4000 tokens worth]

--- Content of data.xlsx ---
[extracted text, up to ~4000 tokens worth]

[User's actual message text]
```

If an attachment's extracted text exceeds ~4000 tokens (~16,000 chars), truncate and append: `Use read_attachment("{id}") for the full content.`

**Historical turns** (~line 107-148, `buildHistoricalTurns`): No change needed. Historical user messages in `talk_messages.content` are stored as the original user text (without attachment content). The attachment content was only prepended at prompt assembly time, not stored in the message record. This means historical turns naturally exclude attachment text — exactly the behavior we want.

**Key insight:** Attachment text is assembled at execution time, not stored in message content. The `talk_messages.content` column always holds the user's original text only.

### 3b. Attachment tool definition

**File:** `src/clawrocket/talks/context-directives.ts`

Add alongside existing source tool:

```typescript
export function buildAttachmentToolDefinition(): { toolName: string; description: string; inputSchema: Record<string, unknown> } {
  return {
    toolName: 'read_attachment',
    description: 'Read the extracted text of a file attachment from any message in this talk. Returns up to 12,000 characters.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          description: 'The attachment ID from the attached files listing.',
        },
      },
      required: ['attachmentId'],
    },
  };
}

export function executeReadAttachment(talkId: string, attachmentId: string): { ... } | { error: string } {
  // Look up attachment by ID, verify talk_id matches
  // Return extracted_text (up to 12,000 chars), metadata, truncation flag
  // Return error if not found or extraction failed
}
```

### 3c. Executor integration

**File:** `src/clawrocket/talks/direct-executor.ts`

**ConnectorToolContext** (~line 157): Add `attachmentTool?: ContextSourceToolDef` alongside existing `contextSourceTool`.

**Tool registration** (in the execute method where tools are assembled):
- Query `listTalkAttachments(talkId)` — if any exist, register the `read_attachment` tool
- Load current message's attachments for the assembler input

**Tool dispatch** (in the tool call handler loop):
- Add case for `toolName === 'read_attachment'` → call `executeReadAttachment(talkId, input.attachmentId)`
- Follow same pattern as `read_context_source` dispatch

### 3d. Attachment manifest in directives

**File:** `src/clawrocket/talks/context-directives.ts`

In `buildTalkContextDirectives()`, add an optional `## Message Attachments` section to the directives text listing all talk attachments with their IDs, file names, and which message they belong to. This gives the agent awareness of all available files.

Format:
```
## Message Attachments
- att_abc123: "report.pdf" (PDF, 3.2 MB) — attached to message at 2026-03-09 14:30
- att_def456: "data.xlsx" (Excel, 1.1 MB) — attached to message at 2026-03-09 14:30
Use read_attachment(attachmentId) to read full content.
```

---

## Phase 4: Frontend

### 4a. Compose area drag-and-drop

**File:** `webapp/src/pages/TalkDetailPage.tsx`

Add to component state:
```typescript
const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
// PendingAttachment = { id: string; file: File; fileName: string; fileSize: number; status: 'uploading' | 'ready' | 'error'; attachmentId?: string }
```

Add event handlers on the compose form element:
- `onDragOver` / `onDragEnter` — set visual drop indicator
- `onDragLeave` — remove indicator
- `onDrop` — validate files (type, size, count), call upload API for each, add to `pendingAttachments`

Add a "paperclip" / attach button next to the send button as an alternative to drag-drop. Uses a hidden `<input type="file" multiple accept=".txt,.md,.pdf,.docx,.xlsx,.csv,.html">`.

### 4b. Attachment chips in compose area

Between the textarea and controls, render attachment chips:
```
[📄 report.pdf ✕] [📊 data.xlsx (uploading…) ✕]
```

Each chip shows file name, upload status, and a remove button. Clicking ✕ removes from pending list (and calls delete API if already uploaded).

### 4c. Modify send handler

**`submitDraft()`** (~line 2377): Include `attachmentIds` from `pendingAttachments` (only those with status 'ready') in the `sendTalkMessage()` call. Clear `pendingAttachments` on successful send.

### 4d. Attachment display in message timeline

In the message rendering section (~line 1500), after the message content, render attachment indicators:
```
[📄 report.pdf · 3.2 MB] [📊 data.xlsx · 1.1 MB]
```

This requires either: (a) fetching attachments alongside messages, or (b) including attachment metadata in the message list API response. **Option (b)** is cleaner — extend the `listTalkMessages` response to include a `attachments` array on each message (just metadata, not content).

### 4e. API client updates

**File:** `webapp/src/lib/api.ts`

Add:
- `uploadTalkAttachment(talkId: string, file: File)` → `{ attachment: AttachmentMeta }`
- `deleteTalkAttachment(talkId: string, attachmentId: string)` → void
- Extend `TalkMessage` type with `attachments?: AttachmentMeta[]`
- Extend `sendTalkMessage` input with `attachmentIds?: string[]`

---

## Phase 5: Promote to Source (Optional / Lower Priority)

Add a context menu action on attachment chips in the message timeline: **"Save as context source"**.

This calls `createTalkContextSource()` with `sourceType: 'file'`, copying the `extracted_text`, `file_name`, `file_size`, `mime_type`, and `storage_key` from the attachment record. The source-creation route (`src/clawrocket/web/routes/talk-context.ts`) needs a minor update to accept `sourceType: 'file'` with pre-extracted content.

---

## Verification Plan

1. **Unit tests for extraction**: Test each file type (PDF, DOCX, XLSX, plain text, CSV, HTML) with sample files. Verify truncation at 50K chars. Verify error handling for corrupt files.
2. **API integration test**: Upload a file, verify DB record and disk storage. Send a message with attachmentIds, verify linkage. List messages, verify attachment metadata included.
3. **Context assembly test**: Create a message with attachments. Call `assembleTalkPromptContext()` and verify the user message includes inline attachment text. Verify historical turns do NOT include attachment text.
4. **Tool execution test**: Call `executeReadAttachment()` with valid/invalid IDs. Verify 12K char truncation. Verify talk_id scoping.
5. **End-to-end manual test**: Drag a PDF into the compose area, type a message, send. Verify the agent's response demonstrates it read the file. Send a follow-up question about the file. Verify the agent can use `read_attachment` to access it.
6. **Frontend test**: Verify drag-drop works. Verify file type/size rejection with user-friendly errors. Verify upload progress. Verify attachment chips render and remove correctly.

---

## Key Files Summary

| File | Change |
|------|--------|
| `src/clawrocket/db/init.ts` | Add `talk_message_attachments` table |
| `src/clawrocket/db/context-accessors.ts` | Add attachment CRUD functions |
| `src/clawrocket/talks/attachment-storage.ts` | **New** — disk I/O for raw files |
| `src/clawrocket/talks/attachment-extraction.ts` | **New** — PDF/DOCX/Excel extraction |
| `src/clawrocket/talks/source-ingestion.ts` | Export `extractTextFromHtml` for reuse |
| `src/clawrocket/talks/context-assembler.ts` | Inline attachment text in current-turn user message |
| `src/clawrocket/talks/context-directives.ts` | Add `read_attachment` tool + attachment manifest |
| `src/clawrocket/talks/direct-executor.ts` | Register tool, handle tool calls, load attachments |
| `src/clawrocket/web/routes/talk-attachments.ts` | **New** — upload endpoint |
| `src/clawrocket/web/routes/talks.ts` | Accept `attachmentIds` on message send |
| `src/clawrocket/web/server.ts` | Register upload route with multipart support |
| `webapp/src/pages/TalkDetailPage.tsx` | Drag-drop, compose attachments, message display |
| `webapp/src/lib/api.ts` | New API functions, extended types |
| `package.json` | Add pdf-parse, mammoth, exceljs |
