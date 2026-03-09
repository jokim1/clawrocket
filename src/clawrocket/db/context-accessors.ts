import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContextSourceType = 'url' | 'file' | 'text';
export type ContextSourceStatus = 'pending' | 'ready' | 'failed';

export interface TalkGoalRecord {
  talk_id: string;
  goal_text: string;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkContextRuleRecord {
  id: string;
  talk_id: string;
  rule_text: string;
  sort_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface TalkContextSourceRecord {
  id: string;
  talk_id: string;
  source_ref: string;
  source_type: ContextSourceType;
  title: string;
  note: string | null;
  sort_order: number;
  status: ContextSourceStatus;
  source_url: string | null;
  file_name: string | null;
  file_size: number | null;
  mime_type: string | null;
  storage_key: string | null;
  extracted_text: string | null;
  extracted_at: string | null;
  extraction_error: string | null;
  is_truncated: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

// ---------------------------------------------------------------------------
// Snapshot types (API-facing, camelCase)
// ---------------------------------------------------------------------------

export interface GoalSnapshot {
  goalText: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ContextRuleSnapshot {
  id: string;
  ruleText: string;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ContextSourceSnapshot {
  id: string;
  sourceRef: string;
  sourceType: ContextSourceType;
  title: string;
  note: string | null;
  sortOrder: number;
  status: ContextSourceStatus;
  sourceUrl: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  extractedTextLength: number | null;
  extractedAt: string | null;
  extractionError: string | null;
  isTruncated: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface ContextSourceWithContent extends ContextSourceSnapshot {
  extractedText: string | null;
}

export interface TalkContextSnapshot {
  goal: GoalSnapshot | null;
  rules: ContextRuleSnapshot[];
  sources: ContextSourceSnapshot[];
}

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

function toRuleSnapshot(row: TalkContextRuleRecord): ContextRuleSnapshot {
  return {
    id: row.id,
    ruleText: row.rule_text,
    sortOrder: row.sort_order,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSourceSnapshot(row: TalkContextSourceRecord): ContextSourceSnapshot {
  return {
    id: row.id,
    sourceRef: row.source_ref,
    sourceType: row.source_type,
    title: row.title,
    note: row.note,
    sortOrder: row.sort_order,
    status: row.status,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    fileSize: row.file_size,
    mimeType: row.mime_type,
    extractedTextLength: row.extracted_text?.length ?? null,
    extractedAt: row.extracted_at,
    extractionError: row.extraction_error,
    isTruncated: row.is_truncated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by,
  };
}

function toSourceWithContent(
  row: TalkContextSourceRecord,
): ContextSourceWithContent {
  return {
    ...toSourceSnapshot(row),
    extractedText: row.extracted_text,
  };
}

// ---------------------------------------------------------------------------
// Goal accessors
// ---------------------------------------------------------------------------

export function getTalkGoal(talkId: string): GoalSnapshot | null {
  const row = getDb()
    .prepare(`SELECT * FROM talk_context_goal WHERE talk_id = ? LIMIT 1`)
    .get(talkId) as TalkGoalRecord | undefined;
  if (!row) return null;
  return {
    goalText: row.goal_text,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export function setTalkGoal(input: {
  talkId: string;
  goalText: string;
  updatedBy: string;
}): GoalSnapshot | null {
  const text = input.goalText.replace(/[\r\n]/g, '').trim();
  if (!text) {
    getDb()
      .prepare(`DELETE FROM talk_context_goal WHERE talk_id = ?`)
      .run(input.talkId);
    return null;
  }
  if (text.length > 160) {
    throw new Error('Goal text exceeds 160-character limit');
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_goal (talk_id, goal_text, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        goal_text = excluded.goal_text,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(input.talkId, text, now, input.updatedBy);
  return getTalkGoal(input.talkId);
}

// ---------------------------------------------------------------------------
// Rule accessors
// ---------------------------------------------------------------------------

export function listTalkContextRules(talkId: string): ContextRuleSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_context_rules
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as TalkContextRuleRecord[];
  return rows.map(toRuleSnapshot);
}

export function getActiveRuleCount(talkId: string): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
    `,
    )
    .get(talkId) as { count: number };
  return row.count;
}

export function createTalkContextRule(input: {
  talkId: string;
  ruleText: string;
}): ContextRuleSnapshot {
  const text = input.ruleText.trim();
  if (!text) throw new Error('Rule text is required');
  if (text.length > 240)
    throw new Error('Rule text exceeds 240-character limit');

  const activeCount = getActiveRuleCount(input.talkId);
  if (activeCount >= 8) {
    throw new Error('Maximum 8 active rules per talk');
  }

  const id = randomUUID();
  const now = new Date().toISOString();

  // Insert at end of list
  const maxOrder = getDb()
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM talk_context_rules WHERE talk_id = ?`,
    )
    .get(input.talkId) as { max_order: number };

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_rules (id, talk_id, rule_text, sort_order, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `,
    )
    .run(id, input.talkId, text, maxOrder.max_order + 1, now, now);

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ?`)
    .get(id) as TalkContextRuleRecord;
  return toRuleSnapshot(row);
}

export function patchTalkContextRule(input: {
  ruleId: string;
  talkId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): ContextRuleSnapshot | undefined {
  const existing = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ? AND talk_id = ?`)
    .get(input.ruleId, input.talkId) as TalkContextRuleRecord | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  let nextText = existing.rule_text;
  let nextActive = existing.is_active;
  let nextOrder = existing.sort_order;

  if (input.ruleText !== undefined) {
    nextText = input.ruleText.trim();
    if (!nextText) throw new Error('Rule text is required');
    if (nextText.length > 240)
      throw new Error('Rule text exceeds 240-character limit');
  }

  if (input.isActive !== undefined) {
    const willActivate = input.isActive && existing.is_active === 0;
    if (willActivate) {
      const activeCount = getActiveRuleCount(input.talkId);
      if (activeCount >= 8) {
        throw new Error('Maximum 8 active rules per talk');
      }
    }
    nextActive = input.isActive ? 1 : 0;
  }

  if (input.sortOrder !== undefined) {
    nextOrder = input.sortOrder;
  }

  getDb()
    .prepare(
      `
      UPDATE talk_context_rules
      SET rule_text = ?, is_active = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(nextText, nextActive, nextOrder, now, input.ruleId);

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_rules WHERE id = ?`)
    .get(input.ruleId) as TalkContextRuleRecord;
  return toRuleSnapshot(row);
}

export function deleteTalkContextRule(ruleId: string, talkId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_context_rules WHERE id = ? AND talk_id = ?`)
    .run(ruleId, talkId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Source ref counter
// ---------------------------------------------------------------------------

function allocateSourceRef(talkId: string): string {
  const row = getDb()
    .prepare(
      `SELECT next_ref_number FROM talk_context_source_ref_counter WHERE talk_id = ?`,
    )
    .get(talkId) as { next_ref_number: number } | undefined;

  const nextNumber = row?.next_ref_number ?? 1;

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_source_ref_counter (talk_id, next_ref_number)
      VALUES (?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        next_ref_number = excluded.next_ref_number
    `,
    )
    .run(talkId, nextNumber + 1);

  return `S${nextNumber}`;
}

// ---------------------------------------------------------------------------
// Source accessors
// ---------------------------------------------------------------------------

export function listTalkContextSources(
  talkId: string,
): ContextSourceSnapshot[] {
  const rows = getDb()
    .prepare(
      `
      SELECT * FROM talk_context_sources
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as TalkContextSourceRecord[];
  return rows.map(toSourceSnapshot);
}

export function getTalkContextSourceCount(talkId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count FROM talk_context_sources WHERE talk_id = ?`,
    )
    .get(talkId) as { count: number };
  return row.count;
}

export function getTalkContextSourceById(
  sourceId: string,
  talkId: string,
): ContextSourceSnapshot | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(sourceId, talkId) as TalkContextSourceRecord | undefined;
  return row ? toSourceSnapshot(row) : undefined;
}

export function getTalkContextSourceByRef(
  sourceRef: string,
  talkId: string,
): ContextSourceWithContent | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM talk_context_sources WHERE source_ref = ? AND talk_id = ?`,
    )
    .get(sourceRef, talkId) as TalkContextSourceRecord | undefined;
  return row ? toSourceWithContent(row) : undefined;
}

export function createTalkContextSource(input: {
  talkId: string;
  sourceType: ContextSourceType;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  storageKey?: string | null;
  extractedText?: string | null;
  createdBy: string;
}): ContextSourceSnapshot {
  const count = getTalkContextSourceCount(input.talkId);
  if (count >= 20) {
    throw new Error('Maximum 20 saved sources per talk');
  }

  const id = randomUUID();
  const sourceRef = allocateSourceRef(input.talkId);
  const now = new Date().toISOString();
  const title = input.title.trim();
  if (!title) throw new Error('Source title is required');

  // Determine initial status
  let status: ContextSourceStatus = 'pending';
  let extractedText: string | null = null;
  let isTruncated = 0;
  let extractedAt: string | null = null;

  if (input.sourceType === 'text') {
    // Text sources are immediately ready
    extractedText = input.extractedText ?? null;
    if (extractedText && extractedText.length > 50_000) {
      extractedText = extractedText.slice(0, 50_000);
      isTruncated = 1;
    }
    status = 'ready';
    extractedAt = now;
  }

  // Insert at end
  const maxOrder = getDb()
    .prepare(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM talk_context_sources WHERE talk_id = ?`,
    )
    .get(input.talkId) as { max_order: number };

  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, note,
        sort_order, status, source_url, file_name, file_size,
        mime_type, storage_key, extracted_text, extracted_at,
        extraction_error, is_truncated, created_at, updated_at, created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      sourceRef,
      input.sourceType,
      title,
      input.note?.trim() || null,
      maxOrder.max_order + 1,
      status,
      input.sourceUrl ?? null,
      input.fileName ?? null,
      input.fileSize ?? null,
      input.mimeType ?? null,
      input.storageKey ?? null,
      extractedText,
      extractedAt,
      isTruncated,
      now,
      now,
      input.createdBy,
    );

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ?`)
    .get(id) as TalkContextSourceRecord;
  return toSourceSnapshot(row);
}

export function patchTalkContextSource(input: {
  sourceId: string;
  talkId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): ContextSourceSnapshot | undefined {
  const existing = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .get(input.sourceId, input.talkId) as TalkContextSourceRecord | undefined;
  if (!existing) return undefined;

  const now = new Date().toISOString();
  let nextTitle = existing.title;
  let nextNote = existing.note;
  let nextOrder = existing.sort_order;

  if (input.title !== undefined) {
    nextTitle = input.title.trim();
    if (!nextTitle) throw new Error('Source title is required');
  }
  if (input.note !== undefined) {
    nextNote = input.note?.trim() || null;
  }
  if (input.sortOrder !== undefined) {
    nextOrder = input.sortOrder;
  }

  // For text sources, allow inline content editing
  if (input.extractedText !== undefined && existing.source_type === 'text') {
    let text = input.extractedText;
    let isTruncated = 0;
    if (text && text.length > 50_000) {
      text = text.slice(0, 50_000);
      isTruncated = 1;
    }
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET title = ?, note = ?, sort_order = ?, extracted_text = ?,
            extracted_at = ?, is_truncated = ?, status = 'ready', updated_at = ?
        WHERE id = ?
      `,
      )
      .run(
        nextTitle,
        nextNote,
        nextOrder,
        text,
        now,
        isTruncated,
        now,
        input.sourceId,
      );
  } else {
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET title = ?, note = ?, sort_order = ?, updated_at = ?
        WHERE id = ?
      `,
      )
      .run(nextTitle, nextNote, nextOrder, now, input.sourceId);
  }

  const row = getDb()
    .prepare(`SELECT * FROM talk_context_sources WHERE id = ?`)
    .get(input.sourceId) as TalkContextSourceRecord;
  return toSourceSnapshot(row);
}

export function updateSourceExtraction(input: {
  sourceId: string;
  extractedText: string | null;
  extractionError: string | null;
  mimeType?: string | null;
}): void {
  const now = new Date().toISOString();

  if (input.extractionError) {
    // Failed extraction — keep last-good content if it exists
    getDb()
      .prepare(
        `
        UPDATE talk_context_sources
        SET extraction_error = ?,
            status = CASE WHEN extracted_text IS NOT NULL THEN status ELSE 'failed' END,
            updated_at = ?
        WHERE id = ?
      `,
      )
      .run(input.extractionError, now, input.sourceId);
    return;
  }

  let text = input.extractedText;
  let isTruncated = 0;
  if (text && text.length > 50_000) {
    text = text.slice(0, 50_000);
    isTruncated = 1;
  }

  getDb()
    .prepare(
      `
      UPDATE talk_context_sources
      SET extracted_text = ?,
          extracted_at = ?,
          extraction_error = NULL,
          is_truncated = ?,
          status = 'ready',
          mime_type = COALESCE(?, mime_type),
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(text, now, isTruncated, input.mimeType ?? null, now, input.sourceId);
}

export function deleteTalkContextSource(
  sourceId: string,
  talkId: string,
): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_context_sources WHERE id = ? AND talk_id = ?`)
    .run(sourceId, talkId);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Full context snapshot (for the GET /context endpoint)
// ---------------------------------------------------------------------------

export function getTalkContext(talkId: string): TalkContextSnapshot {
  return {
    goal: getTalkGoal(talkId),
    rules: listTalkContextRules(talkId),
    sources: listTalkContextSources(talkId),
  };
}

// ---------------------------------------------------------------------------
// Prompt assembly helpers — used by context-assembler, not by API routes
// ---------------------------------------------------------------------------

export interface TalkContextForPrompt {
  goalText: string | null;
  activeRules: string[];
  sources: Array<{
    sourceRef: string;
    sourceType: ContextSourceType;
    title: string;
    note: string | null;
    status: ContextSourceStatus;
    extractedText: string | null;
    sortOrder: number;
  }>;
}

export function getTalkContextForPrompt(talkId: string): TalkContextForPrompt {
  const goal = getTalkGoal(talkId);

  const rules = getDb()
    .prepare(
      `
      SELECT rule_text
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{ rule_text: string }>;

  const sources = getDb()
    .prepare(
      `
      SELECT source_ref, source_type, title, note, status, extracted_text, sort_order
      FROM talk_context_sources
      WHERE talk_id = ?
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{
    source_ref: string;
    source_type: ContextSourceType;
    title: string;
    note: string | null;
    status: ContextSourceStatus;
    extracted_text: string | null;
    sort_order: number;
  }>;

  return {
    goalText: goal?.goalText ?? null,
    activeRules: rules.map((r) => r.rule_text),
    sources: sources.map((s) => ({
      sourceRef: s.source_ref,
      sourceType: s.source_type,
      title: s.title,
      note: s.note,
      status: s.status,
      extractedText: s.extracted_text,
      sortOrder: s.sort_order,
    })),
  };
}
