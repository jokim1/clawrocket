/**
 * @deprecated — SCHEDULED FOR DELETION
 * Replaced by: talks/context-loader.ts
 * This file is kept temporarily while server.ts is being rewired.
 * Do not add new code here.
 */

import { listTalkReplayRows, type TalkMessageRecord } from '../db/index.js';
import type { TalkPersonaRole } from '../llm/types.js';

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  text: string;
  talkMessageId?: string;
  agentId?: string;
}

export interface ContextAssemblyResult {
  messages: PromptMessage[];
  estimatedInputTokens: number;
  inputBudgetTokens: number;
}

export interface CurrentTurnAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  extractedText: string | null;
  extractionStatus: string;
}

export interface ContextAssemblyInput {
  talkId: string;
  talkTitle?: string | null;
  currentRunId: string;
  currentUserMessageId: string;
  currentUserMessage: string;
  currentTurnAttachments?: CurrentTurnAttachment[];
  agent: {
    id: string;
    name: string;
    personaRole: TalkPersonaRole;
  };
  modelContextWindowTokens: number;
  maxOutputTokens: number;
  talkDirectives?: string | null;
  channelContextNote?: string | null;
  sourcePreamble?: string | null;
  toolDefinitions?: unknown[];
}

interface HistoricalTurn {
  user: TalkMessageRecord;
  assistants: TalkMessageRecord[];
}

export class ContextAssemblyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContextAssemblyError';
    this.code = code;
  }
}

const PERSONA_PROMPTS: Record<TalkPersonaRole, string> = {
  assistant:
    'Adopt a balanced, collaborative assistant posture. Be clear, direct, and useful.',
  analyst:
    'Adopt an analyst persona. Break problems into structured observations, assumptions, and conclusions.',
  critic:
    'Adopt a critic persona. Look for weak assumptions, edge cases, and failure modes before endorsing an approach.',
  strategist:
    'Adopt a strategist persona. Focus on tradeoffs, sequencing, leverage, and long-term consequences.',
  'devils-advocate':
    "Adopt a devil's advocate persona. Challenge the strongest-looking path with concrete counterarguments and risks.",
  synthesizer:
    'Adopt a synthesizer persona. Combine competing viewpoints into a coherent, decisive answer.',
  editor:
    'Adopt an editor persona. Improve clarity, precision, and concision while preserving substance.',
};

function estimateTokens(text: string): number {
  if (!text) return 0;
  // Conservative v1 estimator; bias toward under-filling the window rather than
  // risking upstream context-limit failures before tokenizer-specific support exists.
  return Math.ceil(text.length / 4) + 4;
}

function estimateToolDefinitionTokens(toolDefinitions: unknown[]): number {
  if (toolDefinitions.length === 0) return 0;
  return Math.ceil(JSON.stringify(toolDefinitions).length / 4) + 32;
}

function parseMessageMetadataKind(message: TalkMessageRecord): string | null {
  if (!message.metadata_json) return null;
  try {
    const parsed = JSON.parse(message.metadata_json) as Record<string, unknown>;
    return typeof parsed.kind === 'string' ? parsed.kind : null;
  } catch {
    return null;
  }
}

function messageTokenCost(message: PromptMessage): number {
  return estimateTokens(message.text) + 6;
}

function buildBaseSystemPrompt(title?: string | null): string {
  if (title?.trim()) {
    return `You are participating in a collaborative talk titled "${title.trim()}". Keep answers grounded in the conversation context and respond as the selected talk agent.`;
  }
  return 'You are participating in a collaborative talk. Keep answers grounded in the conversation context and respond as the selected talk agent.';
}

function buildPersonaPrompt(input: ContextAssemblyInput): string {
  const persona = PERSONA_PROMPTS[input.agent.personaRole];
  return `Selected talk agent: ${input.agent.name}.\n${persona}`;
}

/**
 * Max chars of attachment text to inline directly in the user message.
 * Larger attachments are referenced by the read_attachment tool hint.
 */
const INLINE_ATTACHMENT_MAX_CHARS = 16_000; // ~4000 tokens

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAugmentedUserMessage(
  originalText: string,
  attachments: CurrentTurnAttachment[],
): string {
  if (attachments.length === 0) return originalText;

  const parts: string[] = [];

  // Attachment manifest
  parts.push('[Attached files]');
  for (const att of attachments) {
    parts.push(
      `- ${att.fileName} (${att.mimeType}, ${formatFileSize(att.fileSize)})`,
    );
  }
  parts.push('');

  // Inline extracted content for each attachment
  for (const att of attachments) {
    if (att.extractionStatus !== 'extracted' || !att.extractedText) {
      parts.push(
        `--- ${att.fileName} ---\n[Extraction ${att.extractionStatus === 'failed' ? 'failed' : 'pending'}. Use read_attachment("${att.id}") once available.]\n`,
      );
      continue;
    }

    const text = att.extractedText;
    if (text.length <= INLINE_ATTACHMENT_MAX_CHARS) {
      parts.push(`--- ${att.fileName} ---\n${text}\n`);
    } else {
      parts.push(
        `--- ${att.fileName} (first ${INLINE_ATTACHMENT_MAX_CHARS} chars) ---\n${text.slice(0, INLINE_ATTACHMENT_MAX_CHARS)}\n[…truncated — use read_attachment("${att.id}") for full content]\n`,
      );
    }
  }

  // Original user message
  parts.push(originalText);

  return parts.join('\n');
}

function buildHistoricalTurns(
  talkId: string,
  currentRunId: string,
  currentUserMessageId: string,
): HistoricalTurn[] {
  const replayRows = listTalkReplayRows({
    talkId,
    currentRunId,
    currentUserMessageId,
    limit: 500,
  });
  const byUserId = new Map<string, HistoricalTurn>();

  for (const row of replayRows) {
    if (parseMessageMetadataKind(row.assistant) === 'assistant_tool_use') {
      continue;
    }

    const existing = byUserId.get(row.user.id);
    if (existing) {
      existing.assistants.push(row.assistant);
      continue;
    }

    byUserId.set(row.user.id, {
      user: row.user,
      assistants: [row.assistant],
    });
  }

  return Array.from(byUserId.values()).sort((a, b) =>
    compareMessagePosition(a.user, b.user),
  );
}

function compareMessagePosition(
  left: Pick<TalkMessageRecord, 'created_at' | 'sequence_in_run' | 'id'>,
  right: Pick<TalkMessageRecord, 'created_at' | 'sequence_in_run' | 'id'>,
): number {
  const createdAtCompare = left.created_at.localeCompare(right.created_at);
  if (createdAtCompare !== 0) return createdAtCompare;

  const leftSequence = left.sequence_in_run ?? 0;
  const rightSequence = right.sequence_in_run ?? 0;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;

  return left.id.localeCompare(right.id);
}

export function assembleTalkPromptContext(
  input: ContextAssemblyInput,
): ContextAssemblyResult {
  const toolDefinitionReserve = estimateToolDefinitionTokens(
    input.toolDefinitions || [],
  );
  const inputBudgetTokens = Math.max(
    0,
    input.modelContextWindowTokens -
      input.maxOutputTokens -
      256 -
      toolDefinitionReserve,
  );

  if (inputBudgetTokens < 256) {
    throw new ContextAssemblyError(
      'tool_definitions_too_large_for_route',
      'Attached connector tools exceed the available context budget for the selected route.',
    );
  }

  const systemMessages: PromptMessage[] = [
    {
      role: 'system',
      text: buildBaseSystemPrompt(input.talkTitle),
    },
  ];
  if (input.talkDirectives?.trim()) {
    systemMessages.push({
      role: 'system',
      text: input.talkDirectives.trim(),
    });
  }
  if (input.channelContextNote?.trim()) {
    systemMessages.push({
      role: 'system',
      text: input.channelContextNote.trim(),
    });
  }
  if (input.sourcePreamble?.trim()) {
    systemMessages.push({
      role: 'system',
      text: input.sourcePreamble.trim(),
    });
  }
  systemMessages.push({
    role: 'system',
    text: buildPersonaPrompt(input),
  });

  // Augment the user's message with inline attachment content for the current turn
  const augmentedText =
    input.currentTurnAttachments && input.currentTurnAttachments.length > 0
      ? buildAugmentedUserMessage(
          input.currentUserMessage,
          input.currentTurnAttachments,
        )
      : input.currentUserMessage;

  const currentUserMessage: PromptMessage = {
    role: 'user',
    text: augmentedText,
    talkMessageId: input.currentUserMessageId,
    agentId: input.agent.id,
  };

  let usedTokens = systemMessages.reduce(
    (sum, message) => sum + messageTokenCost(message),
    0,
  );
  usedTokens += messageTokenCost(currentUserMessage);

  if (usedTokens > inputBudgetTokens) {
    throw new ContextAssemblyError(
      'message_too_large_for_route',
      'The preserved system context plus the current message exceed the selected route budget.',
    );
  }

  const selectedHistorical: PromptMessage[] = [];
  const historicalTurns = buildHistoricalTurns(
    input.talkId,
    input.currentRunId,
    input.currentUserMessageId,
  );
  for (let index = historicalTurns.length - 1; index >= 0; index -= 1) {
    const turn = historicalTurns[index];
    const turnMessages: PromptMessage[] = [
      {
        role: 'user',
        text: turn.user.content,
        talkMessageId: turn.user.id,
      },
      ...turn.assistants
        .slice()
        .sort(compareMessagePosition)
        .map(
          (assistant): PromptMessage => ({
            role: 'assistant',
            text: assistant.content,
            talkMessageId: assistant.id,
          }),
        ),
    ];
    const turnCost = turnMessages.reduce(
      (sum, message) => sum + messageTokenCost(message),
      0,
    );
    if (usedTokens + turnCost > inputBudgetTokens) {
      break;
    }
    usedTokens += turnCost;
    selectedHistorical.unshift(...turnMessages);
  }

  return {
    messages: [...systemMessages, ...selectedHistorical, currentUserMessage],
    estimatedInputTokens: usedTokens,
    inputBudgetTokens,
  };
}
