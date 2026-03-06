import { listTalkMessages, type TalkMessageRecord } from '../db/index.js';
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

export interface ContextAssemblyInput {
  talkId: string;
  talkTitle?: string | null;
  currentRunId: string;
  currentUserMessageId: string;
  currentUserMessage: string;
  agent: {
    id: string;
    name: string;
    personaRole: TalkPersonaRole;
  };
  modelContextWindowTokens: number;
  maxOutputTokens: number;
  talkDirectives?: string | null;
}

interface HistoricalTurn {
  runId: string;
  user: TalkMessageRecord;
  assistant: TalkMessageRecord;
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
    'Adopt a devil\'s advocate persona. Challenge the strongest-looking path with concrete counterarguments and risks.',
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

function buildHistoricalTurns(
  talkId: string,
  currentRunId: string,
): HistoricalTurn[] {
  // v1 simplification: cap the DB scan while context assembly is purely
  // stateless replay. The actual retained history is still bounded by the
  // route/model token budget below.
  const messages = listTalkMessages({ talkId, limit: 500 });
  const byRunId = new Map<
    string,
    {
      user?: TalkMessageRecord;
      assistant?: TalkMessageRecord;
    }
  >();

  for (const message of messages) {
    if (!message.run_id || message.run_id === currentRunId) continue;
    const group = byRunId.get(message.run_id) || {};
    if (message.role === 'user' && !group.user) group.user = message;
    if (message.role === 'assistant' && !group.assistant) group.assistant = message;
    byRunId.set(message.run_id, group);
  }

  return Array.from(byRunId.entries())
    .map(([runId, group]) =>
      group.user && group.assistant
        ? {
            runId,
            user: group.user,
            assistant: group.assistant,
          }
        : null,
    )
    .filter((turn): turn is HistoricalTurn => Boolean(turn))
    .sort((a, b) => a.user.created_at.localeCompare(b.user.created_at));
}

export function assembleTalkPromptContext(
  input: ContextAssemblyInput,
): ContextAssemblyResult {
  const inputBudgetTokens = Math.max(
    256,
    input.modelContextWindowTokens - input.maxOutputTokens - 256,
  );

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
  systemMessages.push({
    role: 'system',
    text: buildPersonaPrompt(input),
  });

  const currentUserMessage: PromptMessage = {
    role: 'user',
    text: input.currentUserMessage,
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
  const historicalTurns = buildHistoricalTurns(input.talkId, input.currentRunId);
  for (let index = historicalTurns.length - 1; index >= 0; index -= 1) {
    const turn = historicalTurns[index];
    const userMessage: PromptMessage = {
      role: 'user',
      text: turn.user.content,
      talkMessageId: turn.user.id,
    };
    const assistantMessage: PromptMessage = {
      role: 'assistant',
      text: turn.assistant.content,
      talkMessageId: turn.assistant.id,
    };
    const turnCost =
      messageTokenCost(userMessage) + messageTokenCost(assistantMessage);
    if (usedTokens + turnCost > inputBudgetTokens) {
      break;
    }
    usedTokens += turnCost;
    selectedHistorical.unshift(userMessage, assistantMessage);
  }

  return {
    messages: [...systemMessages, ...selectedHistorical, currentUserMessage],
    estimatedInputTokens: usedTokens,
    inputBudgetTokens,
  };
}
