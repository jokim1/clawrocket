/**
 * context-loader.ts
 *
 * Core context loading function that replaces context-assembler.ts and context-directives.ts.
 * Builds a ContextPackage from a Talk ID for consumption by the agent router.
 *
 * Handles:
 * 1. Fetching goal, rules, and rolling summary
 * 2. Building source manifest with inline small sources
 * 3. Building connector tools (currently stub)
 * 4. Loading message history with token budgeting
 * 5. Assembling into a ContextPackage with metadata
 */

import { getDb } from '../../db.js';
import { listConnectorsForTalkRun } from '../db/connector-accessors.js';
import { listTalkStateEntries } from '../db/context-accessors.js';
import {
  buildConnectorToolDefinitions,
  type ConnectorToolDefinition,
} from '../connectors/runtime.js';
import {
  type LlmToolDefinition,
  type LlmMessage,
} from '../agents/llm-client.js';
import { WEB_TOOL_DEFINITIONS } from '../tools/web-tools.js';
import {
  buildBoundGoogleDrivePromptSection,
  buildGoogleDriveContextTools,
} from './google-drive-tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextPackage {
  /** System prompt: goal + summary + rules + state + sources + bound Drive resources */
  systemPrompt: string;

  /** Tool definitions for reading context sources, attachments, and bound Drive resources */
  contextTools: LlmToolDefinition[];

  /** Tool definitions from bound data connectors */
  connectorTools: LlmToolDefinition[];

  /** Conversation history (after summary cutoff) in chronological order */
  history: LlmMessage[];

  /** Rough token estimate for budgeting (systemPrompt + history) */
  estimatedTokens: number;

  /** Metadata about the loaded context */
  metadata: {
    talkId: string;
    threadId: string | null;
    sourceCount: number;
    connectorCount: number;
    historyTurnCount: number;
    historyMessageIds: string[];
    activeRuleCount: number;
    stateEntryCount: number;
    hasSummary: boolean;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_RESERVE = 4096; // Tokens to reserve for model output
const TOOL_SCHEMA_RESERVE = 2000; // Tokens to reserve for tool definitions
const STATE_SNAPSHOT_RESERVE = 2000; // Tokens reserved for bounded Talk state
const CHARS_TO_TOKENS = 0.25; // Simple estimation: 1 char ≈ 0.25 tokens
const SMALL_SOURCE_THRESHOLD = 250; // Max tokens to inline a source

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

// ---------------------------------------------------------------------------
// Main Context Loader
// ---------------------------------------------------------------------------

/**
 * Load Talk context for agent execution.
 *
 * Canonical context build order (documented contract — not ad hoc):
 *   1. Goal (talk_context_goal)
 *   2. Rolling summary (talk_context_summary) — disabled for threaded runs
 *      because a single talk-level summary injected into every thread leaks
 *      cross-thread context. Per-thread summaries are a future concern.
 *   3. Rules (talk_context_rules, active only)
 *   4. State snapshot (talk_state_entries, bounded by dedicated token budget)
 *   5. Source manifest (talk_context_sources, inline small sources)
 *   6. Bound Google Drive resources manifest (talk_resource_bindings)
 *   7. Connector tools (verified connectors only)
 *   8. Message history (thread-scoped when threadId provided, with token budgeting)
 *
 * @param talkId - The Talk to load context for
 * @param modelContextWindow - The model's context window in tokens
 * @param threadId - Optional thread to scope message history to. When provided,
 *   only messages from this thread are loaded and summary injection is skipped.
 */
export async function loadTalkContext(
  talkId: string,
  modelContextWindow: number,
  threadId?: string | null,
  historyThroughMessageId?: string | null,
  userId?: string | null,
): Promise<ContextPackage> {
  const db = getDb();

  // Step 1: Fetch goal, rules, state, and rolling summary
  const goal = fetchGoal(db, talkId);
  const rules = fetchRules(db, talkId);
  const stateEntries = listTalkStateEntries(talkId);

  // When loading for a specific thread, skip talk-level summary to avoid
  // leaking cross-thread context. A stale/wrong summary is worse than no
  // summary — the model still has recent thread history.
  const summary = threadId ? null : fetchSummary(db, talkId);
  const stateSnapshot = buildStateSnapshot(
    stateEntries,
    STATE_SNAPSHOT_RESERVE,
  );

  // Step 2: Build source manifest
  const sources = fetchSources(db, talkId);
  const sourceLines = buildSourceManifest(sources);
  const boundGoogleDriveResources = buildBoundGoogleDrivePromptSection(talkId);

  // Step 3: Build connector tools (currently empty stub)
  const connectorTools = buildConnectorTools(db, talkId);

  // Step 4: Assemble system prompt
  const systemPrompt = assembleSystemPrompt(
    goal,
    summary,
    rules,
    stateSnapshot,
    sourceLines,
    boundGoogleDriveResources,
  );
  const systemPromptTokens = Math.ceil(systemPrompt.length * CHARS_TO_TOKENS);

  // Step 5: Build context tools (always included)
  const contextTools = buildContextTools(talkId, userId);

  // Step 6: Load message history with token budgeting (thread-scoped if threadId provided)
  const availableBudget =
    modelContextWindow -
    OUTPUT_RESERVE -
    systemPromptTokens -
    TOOL_SCHEMA_RESERVE;
  const historySelection = loadMessageHistory(
    db,
    talkId,
    availableBudget,
    threadId,
    historyThroughMessageId,
  );
  const history = historySelection.messages;

  // Estimate total tokens
  const historyTokens = history.reduce((sum, msg) => {
    const contentStr =
      typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
    return sum + Math.ceil(contentStr.length * CHARS_TO_TOKENS);
  }, 0);
  const estimatedTokens =
    systemPromptTokens + historyTokens + TOOL_SCHEMA_RESERVE;

  // Build metadata
  const metadata = {
    talkId,
    threadId: threadId ?? null,
    sourceCount: sources.length,
    connectorCount: connectorTools.length,
    historyTurnCount: history.length,
    historyMessageIds: historySelection.messageIds,
    activeRuleCount: rules.length,
    stateEntryCount: stateEntries.length,
    hasSummary: summary !== null,
  };

  return {
    systemPrompt,
    connectorTools,
    contextTools,
    history,
    estimatedTokens,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Step 1: Fetch Goal, Rules, and Summary
// ---------------------------------------------------------------------------

function fetchGoal(db: any, talkId: string): string | null {
  const row = db
    .prepare(
      `SELECT goal_text FROM talk_context_goal WHERE talk_id = ? LIMIT 1`,
    )
    .get(talkId) as { goal_text: string } | undefined;
  return row?.goal_text ?? null;
}

function fetchRules(db: any, talkId: string): string[] {
  const rows = db
    .prepare(
      `
      SELECT rule_text
      FROM talk_context_rules
      WHERE talk_id = ? AND is_active = 1
      ORDER BY sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as Array<{ rule_text: string }>;
  return rows.map((r) => r.rule_text);
}

function fetchSummary(db: any, talkId: string): string | null {
  const row = db
    .prepare(
      `
      SELECT summary_text
      FROM talk_context_summary
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as { summary_text: string } | undefined;
  return row?.summary_text ?? null;
}

// ---------------------------------------------------------------------------
// Step 2: Build Source Manifest
// ---------------------------------------------------------------------------

interface SourceRow {
  source_ref: string;
  source_type: string;
  title: string;
  source_url: string | null;
  file_name: string | null;
  extracted_text: string | null;
  status: string;
}

function fetchSources(db: any, talkId: string): SourceRow[] {
  const rows = db
    .prepare(
      `
      SELECT
        source_ref,
        source_type,
        title,
        source_url,
        file_name,
        extracted_text,
        status
      FROM talk_context_sources
      WHERE talk_id = ? AND status = 'ready'
      ORDER BY sort_order ASC
    `,
    )
    .all(talkId) as SourceRow[];
  return rows;
}

function buildSourceManifest(sources: SourceRow[]): Array<{
  ref: string;
  line: string;
  inlineContent: string | null;
}> {
  return sources.map((source) => {
    // Use the stable source_ref from the DB (e.g., "S1", "S4")
    const ref = source.source_ref;

    // Build the source reference line (e.g., "[S1] Title - URL")
    let refLine = `[${ref}] ${source.title}`;
    if (source.source_type === 'url' && source.source_url) {
      refLine += ` - ${source.source_url}`;
    } else if (source.source_type === 'file' && source.file_name) {
      refLine += ` (${source.file_name})`;
    }

    // For small text sources, inline the content
    let inlineContent: string | null = null;
    if (
      source.source_type === 'text' &&
      source.extracted_text &&
      source.extracted_text.length * CHARS_TO_TOKENS < SMALL_SOURCE_THRESHOLD
    ) {
      inlineContent = source.extracted_text;
    }

    return {
      ref,
      line: refLine,
      inlineContent,
    };
  });
}

// ---------------------------------------------------------------------------
// Step 3: Build Connector Tools
// ---------------------------------------------------------------------------

/**
 * Load connector tool definitions for a Talk.
 *
 * Runtime verification guard: only connectors that are enabled, have a
 * credential, AND have verificationStatus === 'verified' produce tool
 * definitions. An attached connector that later becomes invalid or
 * unavailable is silently excluded — fail closed.
 */
function buildConnectorTools(_db: any, talkId: string): LlmToolDefinition[] {
  // listConnectorsForTalkRun already filters: enabled=1, has ciphertext.
  const connectors = listConnectorsForTalkRun(talkId);

  // Additional runtime guard: only verified connectors produce tools.
  const verified = connectors.filter(
    (c) => c.verificationStatus === 'verified',
  );

  const defs = buildConnectorToolDefinitions(verified);
  return defs.map((def) => ({
    name: def.toolName,
    description: def.description,
    inputSchema: def.inputSchema,
  }));
}

// ---------------------------------------------------------------------------
// Step 4: Assemble System Prompt
// ---------------------------------------------------------------------------

function assembleSystemPrompt(
  goal: string | null,
  summary: string | null,
  rules: string[],
  stateSnapshot: string | null,
  sourceLines: Array<{
    ref: string;
    line: string;
    inlineContent: string | null;
  }>,
  boundGoogleDriveResources: string | null,
): string {
  const parts: string[] = [];

  if (goal) {
    parts.push(`**Goal:**\n${goal}`);
  }

  if (summary) {
    parts.push(`**Summary:**\n${summary}`);
  }

  if (rules.length > 0) {
    const ruleLines = rules.map((r, i) => `${i + 1}. ${r}`);
    parts.push(`**Rules:**\n${ruleLines.join('\n')}`);
  }

  if (stateSnapshot) {
    parts.push(stateSnapshot);
  }

  if (sourceLines.length > 0) {
    const manifestLines = sourceLines.map((s) => s.line);
    parts.push(`**Sources:**\n${manifestLines.join('\n')}`);

    // Append inline content
    const inlineBlocks = sourceLines
      .filter((s) => s.inlineContent)
      .map((s) => `\n[${s.ref}] Content:\n${s.inlineContent}`);
    if (inlineBlocks.length > 0) {
      parts.push(inlineBlocks.join('\n'));
    }
  }

  if (boundGoogleDriveResources) {
    parts.push(boundGoogleDriveResources);
  }

  return parts.join('\n\n');
}

function buildStateSnapshot(
  entries: Array<{
    key: string;
    value: unknown;
    version: number;
    updatedAt: string;
  }>,
  budgetTokens: number,
): string | null {
  if (entries.length === 0 || budgetTokens <= 0) {
    return null;
  }

  const lines: string[] = [];
  let usedTokens = estimateTokens('**State Snapshot:**\n');
  let omitted = 0;

  for (const entry of entries) {
    const line = `- ${entry.key} (v${entry.version}, updated ${entry.updatedAt}): ${JSON.stringify(entry.value)}`;
    const lineTokens = estimateTokens(line);
    if (usedTokens + lineTokens > budgetTokens) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    usedTokens += lineTokens;
  }

  if (lines.length === 0) {
    return `**State Snapshot:**\n${entries.length} state entr${
      entries.length === 1 ? 'y' : 'ies'
    } omitted to stay within context budget.`;
  }

  if (omitted > 0) {
    lines.push(
      `- ${omitted} additional state entr${
        omitted === 1 ? 'y' : 'ies'
      } omitted to stay within context budget.`,
    );
  }

  return `**State Snapshot:**\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Step 5: Build Context Tools
// ---------------------------------------------------------------------------

function buildContextTools(
  talkId: string,
  userId?: string | null,
): LlmToolDefinition[] {
  return [
    {
      name: 'read_context_source',
      description:
        'Read the content of a context source by its stable ref (e.g., S1, S2)',
      inputSchema: {
        type: 'object',
        properties: {
          sourceRef: {
            type: 'string',
            description: 'Stable source ref like S1, S2, etc.',
          },
        },
        required: ['sourceRef'],
      },
    },
    {
      name: 'read_attachment',
      description: 'Read a message attachment by ID',
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: {
            type: 'string',
            description: 'Attachment ID',
          },
        },
        required: ['attachmentId'],
      },
    },
    {
      name: 'update_state',
      description:
        'Persist a structured JSON state entry for this Talk using compare-and-swap versioning. Create new keys with expectedVersion 0. Update existing keys with their current version from the state snapshot. On conflict, the tool returns the current stored value as an error so you can retry.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description: 'State entry key',
          },
          value: {
            description:
              'JSON value to store for this key. Can be an object, array, string, number, boolean, or null.',
          },
          expectedVersion: {
            type: 'number',
            description:
              'Use 0 to create a new key. For updates, use the current version from the state snapshot.',
          },
        },
        required: ['key', 'value', 'expectedVersion'],
      },
    },
    ...buildGoogleDriveContextTools({ talkId, userId }),
    ...WEB_TOOL_DEFINITIONS,
  ];
}

// ---------------------------------------------------------------------------
// Step 6: Load Message History with Token Budgeting
// ---------------------------------------------------------------------------

interface MessageRow {
  id: string;
  role: string;
  content: string;
  agent_id: string | null;
  created_at: string;
  metadata_json: string | null;
}

function loadMessageHistory(
  db: any,
  talkId: string,
  budgetTokens: number,
  threadId?: string | null,
  historyThroughMessageId?: string | null,
): { messages: LlmMessage[]; messageIds: string[] } {
  const cutoff = historyThroughMessageId
    ? (db
        .prepare(
          `
          SELECT id, created_at
          FROM talk_messages
          WHERE id = ? AND talk_id = ?
            AND (? IS NULL OR thread_id = ?)
          LIMIT 1
        `,
        )
        .get(
          historyThroughMessageId,
          talkId,
          threadId ?? null,
          threadId ?? null,
        ) as { id: string; created_at: string } | undefined)
    : undefined;

  // When threadId is provided, only load messages from that thread.
  // Otherwise load all messages for the Talk (legacy/pre-thread behavior).
  let rows: MessageRow[];
  if (threadId) {
    rows = db
      .prepare(
        `
        SELECT id, role, content, agent_id, created_at, metadata_json
        FROM talk_messages
        WHERE talk_id = ? AND thread_id = ?
          AND (
            ? IS NULL
            OR created_at < ?
            OR (created_at = ? AND id <= ?)
          )
        ORDER BY created_at DESC
      `,
      )
      .all(
        talkId,
        threadId,
        cutoff?.id ?? null,
        cutoff?.created_at ?? null,
        cutoff?.created_at ?? null,
        cutoff?.id ?? null,
      ) as MessageRow[];
  } else {
    rows = db
      .prepare(
        `
        SELECT id, role, content, agent_id, created_at, metadata_json
        FROM talk_messages
        WHERE talk_id = ?
          AND (
            ? IS NULL
            OR created_at < ?
            OR (created_at = ? AND id <= ?)
          )
        ORDER BY created_at DESC
      `,
      )
      .all(
        talkId,
        cutoff?.id ?? null,
        cutoff?.created_at ?? null,
        cutoff?.created_at ?? null,
        cutoff?.id ?? null,
      ) as MessageRow[];
  }

  // Walk backward through messages, accumulating token count
  let accumulatedTokens = 0;
  const selectedRows: MessageRow[] = [];

  for (const row of rows) {
    const messageTokens = Math.ceil(row.content.length * CHARS_TO_TOKENS);
    if (accumulatedTokens + messageTokens > budgetTokens) {
      break; // Budget exceeded, stop here
    }
    accumulatedTokens += messageTokens;
    selectedRows.push(row);
  }

  // Reverse to chronological order
  selectedRows.reverse();

  // Convert to LlmMessage format
  return {
    messages: selectedRows.map((row) => ({
      role: row.role as 'user' | 'assistant' | 'system' | 'tool',
      content: row.content,
    })),
    messageIds: selectedRows.map((row) => row.id),
  };
}
