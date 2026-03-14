/**
 * MainExecutor — shared execution substrate for the Main Agent Channel.
 *
 * Uses the SAME pipeline as Talk execution (talk_runs → agentRouter.execute() →
 * llm_attempts), but with:
 * - talk_id = NULL (Main channel, not a Talk)
 * - thread_id for message grouping
 * - No context loading (context-free in v1)
 * - All agent tools enabled (Main is the power surface)
 *
 * This is deliberately thin: ~150 lines. Context loading deferred to v2.
 */

import { randomUUID } from 'crypto';
import { getDb } from '../../db.js';
import {
  createMessage,
  createLlmAttempt,
  getRegisteredAgent,
  type LlmAttemptStatus,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
  type AgentExecutionResult,
} from './agent-router.js';
import { getMainAgent } from './agent-registry.js';

// ============================================================================
// Types
// ============================================================================

export interface MainExecutorInput {
  runId: string;
  threadId: string;
  requestedBy: string;
  triggerMessageId: string;
  triggerContent: string;
  targetAgentId?: string | null;
}

export interface MainExecutorOutput {
  content: string;
  agentId: string;
  agentName: string;
  providerId: string;
  modelId: string;
  threadId: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}

export type MainExecutionEvent =
  | {
      type: 'main_response_started';
      runId: string;
      threadId: string;
      agentId: string;
      agentName: string;
    }
  | {
      type: 'main_response_delta';
      runId: string;
      threadId: string;
      text: string;
    }
  | {
      type: 'main_response_usage';
      runId: string;
      threadId: string;
      usage: { inputTokens: number; outputTokens: number; estimatedCostUsd?: number };
    }
  | {
      type: 'main_response_completed';
      runId: string;
      threadId: string;
      agentId: string;
    }
  | {
      type: 'main_response_failed';
      runId: string;
      threadId: string;
      errorCode: string;
      errorMessage: string;
    };

// ============================================================================
// Main Executor
// ============================================================================

export async function executeMainChannel(
  input: MainExecutorInput,
  signal: AbortSignal,
  emit?: (event: MainExecutionEvent) => void,
): Promise<MainExecutorOutput> {
  const emitEvent = emit || (() => {});
  const startTime = Date.now();

  // --- Step 1: Resolve agent ---
  let agent: RegisteredAgentRecord | undefined;
  if (input.targetAgentId) {
    agent = getRegisteredAgent(input.targetAgentId);
  }
  if (!agent) {
    agent = getMainAgent();
  }

  if (!agent) {
    const errorCode = 'NO_AGENT_AVAILABLE';
    const errorMessage = 'No agent available for Main channel';
    emitEvent({ type: 'main_response_failed', runId: input.runId, threadId: input.threadId, errorCode, errorMessage });
    throw new Error(errorMessage);
  }

  emitEvent({
    type: 'main_response_started',
    runId: input.runId,
    threadId: input.threadId,
    agentId: agent.id,
    agentName: agent.name,
  });

  // --- Step 2: Load thread history (simple backward fill) ---
  const db = getDb();
  const threadMessages = db
    .prepare(
      `
    SELECT role, content
    FROM talk_messages
    WHERE thread_id = ? AND talk_id IS NULL
    ORDER BY created_at ASC
  `,
    )
    .all(input.threadId) as Array<{ role: string; content: string }>;

  const history = threadMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }));

  // --- Step 3: Execute via agent router (context-free: no system prompt, no context tools) ---
  const context: ExecutionContext = {
    systemPrompt: agent.system_prompt || '',
    contextTools: [], // No context tools for Main channel
    connectorTools: [], // No connectors for Main channel v1
    history,
  };

  let result: AgentExecutionResult;
  try {
    result = await executeWithAgent(agent.id, context, input.triggerContent, {
      runId: input.runId,
      userId: input.requestedBy,
      signal,
      emit: (event: ExecutionEvent) => {
        if (event.type === 'text_delta') {
          emitEvent({ type: 'main_response_delta', runId: input.runId, threadId: input.threadId, text: event.text });
        } else if (event.type === 'usage') {
          emitEvent({
            type: 'main_response_usage',
            runId: input.runId,
            threadId: input.threadId,
            usage: {
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              estimatedCostUsd: event.estimatedCostUsd,
            },
          });
        }
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    emitEvent({
      type: 'main_response_failed',
      runId: input.runId,
      threadId: input.threadId,
      errorCode: 'EXECUTION_ERROR',
      errorMessage,
    });
    throw err;
  }

  // --- Step 4: Store assistant message ---
  const messageId = randomUUID();
  const now = new Date().toISOString();

  createMessage({
    id: messageId,
    talkId: null, // Main channel
    threadId: input.threadId,
    role: 'assistant',
    content: result.content,
    agentId: agent.id,
    createdBy: agent.id,
    metadataJson: JSON.stringify({
      runId: input.runId,
      providerId: agent.provider_id,
      modelId: agent.model_id,
    }),
  });

  // --- Step 5: Record LLM attempt ---
  const latencyMs = Date.now() - startTime;
  createLlmAttempt({
    runId: input.runId,
    talkId: null, // Main channel
    agentId: agent.id,
    providerId: agent.provider_id,
    modelId: agent.model_id,
    status: 'success' as LlmAttemptStatus,
    latencyMs,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    estimatedCostUsd: result.usage?.estimatedCostUsd,
    createdAt: now,
  });

  // --- Step 6: Emit completion ---
  emitEvent({
    type: 'main_response_completed',
    runId: input.runId,
    threadId: input.threadId,
    agentId: agent.id,
  });

  return {
    content: result.content,
    agentId: agent.id,
    agentName: agent.name,
    providerId: agent.provider_id,
    modelId: agent.model_id,
    threadId: input.threadId,
    usage: result.usage,
  };
}
