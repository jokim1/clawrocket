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
import {
  type LlmToolDefinition,
  type LlmMessage,
} from '../agents/llm-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContextPackage {
  /** System prompt: goal + summary (if exists) + rules + source manifest */
  systemPrompt: string;

  /** Tool definitions for reading context sources and attachments */
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
    sourceCount: number;
    connectorCount: number;
    historyTurnCount: number;
    hasSummary: boolean;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OUTPUT_RESERVE = 4096; // Tokens to reserve for model output
const TOOL_SCHEMA_RESERVE = 2000; // Tokens to reserve for tool definitions
const CHARS_TO_TOKENS = 0.25; // Simple estimation: 1 char ≈ 0.25 tokens
const SMALL_SOURCE_THRESHOLD = 250; // Max tokens to inline a source

// ---------------------------------------------------------------------------
// Main Context Loader
// ---------------------------------------------------------------------------

export async function loadTalkContext(
  talkId: string,
  modelContextWindow: number,
): Promise<ContextPackage> {
  const db = getDb();

  // Step 1: Fetch goal, rules, and rolling summary
  const goal = fetchGoal(db, talkId);
  const rules = fetchRules(db, talkId);
  const summary = fetchSummary(db, talkId);

  // Step 2: Build source manifest
  const sources = fetchSources(db, talkId);
  const sourceLines = buildSourceManifest(sources);

  // Step 3: Build connector tools (currently empty stub)
  const connectorTools = buildConnectorTools(db, talkId);

  // Step 4: Assemble system prompt
  const systemPrompt = assembleSystemPrompt(goal, summary, rules, sourceLines);
  const systemPromptTokens = Math.ceil(systemPrompt.length * CHARS_TO_TOKENS);

  // Step 5: Build context tools (always included)
  const contextTools = buildContextTools();

  // Step 6: Load message history with token budgeting
  const availableBudget =
    modelContextWindow -
    OUTPUT_RESERVE -
    systemPromptTokens -
    TOOL_SCHEMA_RESERVE;
  const history = loadMessageHistory(db, talkId, availableBudget);

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
    sourceCount: sources.length,
    connectorCount: connectorTools.length,
    historyTurnCount: history.length,
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

function fetchGoal(
  db: any,
  talkId: string,
): string | null {
  const row = db
    .prepare(`SELECT goal_text FROM talk_context_goal WHERE talk_id = ? LIMIT 1`)
    .get(talkId) as { goal_text: string } | undefined;
  return row?.goal_text ?? null;
}

function fetchRules(
  db: any,
  talkId: string,
): string[] {
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

function fetchSummary(
  db: any,
  talkId: string,
): string | null {
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

function fetchSources(
  db: any,
  talkId: string,
): SourceRow[] {
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
  return sources.map((source, index) => {
    // Build the source reference line (e.g., "[src-1] Title - URL")
    let refLine = `[src-${index + 1}] ${source.title}`;
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
      ref: `src-${index + 1}`,
      line: refLine,
      inlineContent,
    };
  });
}

// ---------------------------------------------------------------------------
// Step 3: Build Connector Tools
// ---------------------------------------------------------------------------

function buildConnectorTools(
  db: any,
  talkId: string,
): LlmToolDefinition[] {
  // TODO: Fetch talk_data_connectors JOIN data_connectors
  // Parse config_json to extract tool definitions
  // For now, return empty array
  return [];
}

// ---------------------------------------------------------------------------
// Step 4: Assemble System Prompt
// ---------------------------------------------------------------------------

function assembleSystemPrompt(
  goal: string | null,
  summary: string | null,
  rules: string[],
  sourceLines: Array<{ ref: string; line: string; inlineContent: string | null }>,
): string {
  const parts: string[] = [];

  if (goal) {
    parts.push(`**Goal:**\n${goal}`);
  }

  if (summary) {
    parts.push(`**Summary:**\n${summary}`);
  }

  // Build source manifest section
  if (sourceLines.length > 0) {
    const manifestLines = sourceLines.map((s) => s.line);
    parts.push(`**Sources:**\n${manifestLines.join('\n')}`);

    // Append inline content
    const inlineBlocks = sourceLines
      .filter((s) => s.inlineContent)
      .map(
        (s) =>
          `\n[${s.ref}] Content:\n${s.inlineContent}`,
      );
    if (inlineBlocks.length > 0) {
      parts.push(inlineBlocks.join('\n'));
    }
  }

  // Add rules section
  if (rules.length > 0) {
    const ruleLines = rules.map((r, i) => `${i + 1}. ${r}`);
    parts.push(`**Rules:**\n${ruleLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Step 5: Build Context Tools
// ---------------------------------------------------------------------------

function buildContextTools(): LlmToolDefinition[] {
  return [
    {
      name: 'read_context_source',
      description:
        'Read the content of a context source by its ref ID (e.g., src-1)',
      inputSchema: {
        type: 'object',
        properties: {
          sourceRef: {
            type: 'string',
            description: 'Source ref like src-1',
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
): LlmMessage[] {
  const rows = db
    .prepare(
      `
      SELECT id, role, content, agent_id, created_at, metadata_json
      FROM talk_messages
      WHERE talk_id = ?
      ORDER BY created_at DESC
    `,
    )
    .all(talkId) as MessageRow[];

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
  return selectedRows.map((row) => ({
    role: row.role as 'user' | 'assistant' | 'system' | 'tool',
    content: row.content,
  }));
}
