/**
 * CleanTalkExecutor — thin orchestrator for Talk execution.
 *
 * Replaces the 99KB direct-executor.ts with a clean, focused orchestrator that:
 * 1. Loads Talk context (goal, rules, history) via context-loader
 * 2. Resolves the target agent (explicit or primary)
 * 3. Calls agent-router to execute with context
 * 4. Maps ExecutionEvents to TalkExecutionEvents
 * 5. Stores results in the database
 *
 * This is ~300 lines and has a single responsibility: orchestrate the
 * interaction between Talk context loading, agent execution, and result persistence.
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
} from '../agents/agent-router.js';
import { resolvePrimaryAgent, getMainAgent } from '../agents/agent-registry.js';
import { loadTalkContext, type ContextPackage } from './context-loader.js';
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
  TalkExecutionEvent,
} from './executor.js';

// ============================================================================
// Event Mapping
// ============================================================================

/**
 * Map ExecutionEvent from agent-router to TalkExecutionEvent.
 *
 * Agent router emits: started, text_delta, tool_call, tool_result, usage,
 * awaiting_confirmation, completed, failed, cancelled
 *
 * Talk executor emits: talk_response_started, talk_response_delta,
 * talk_response_usage, talk_response_completed, talk_response_failed, talk_response_cancelled
 *
 * Internal events (tool_call, tool_result, awaiting_confirmation) are not
 * mapped; they're handled internally and don't propagate to the caller.
 */
function mapExecutionEvent(
  event: ExecutionEvent,
  input: TalkExecutorInput,
  agent: RegisteredAgentRecord,
  providerId: string,
  modelId: string,
): TalkExecutionEvent | null {
  switch (event.type) {
    case 'started':
      return {
        type: 'talk_response_started',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        agentNickname: agent.name,
        providerId,
        modelId,
      };

    case 'text_delta':
      return {
        type: 'talk_response_delta',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        agentNickname: agent.name,
        deltaText: event.text,
        providerId,
        modelId,
      };

    case 'usage':
      return {
        type: 'talk_response_usage',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
        providerId,
        modelId,
      };

    case 'completed':
      return {
        type: 'talk_response_completed',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        agentNickname: agent.name,
        providerId,
        modelId,
      };

    case 'failed':
      return {
        type: 'talk_response_failed',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        providerId,
        modelId,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };

    case 'cancelled':
      return {
        type: 'talk_response_cancelled',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
      };

    case 'tool_call':
    case 'tool_result':
    case 'awaiting_confirmation':
      // Internal events; no TalkExecutionEvent equivalent
      return null;

    default:
      // Exhaustiveness check will catch new event types at compile time
      const _: never = event;
      return _;
  }
}

// ============================================================================
// Tool Execution Callback
// ============================================================================

/**
 * Build the executeToolCall callback for agent-router.
 *
 * This callback handles:
 * - Context tools (read_context_source, read_attachment): query DB directly
 * - Connector tools: delegate to connectors/tool-executors.ts
 * - All other tools: return error (main agent handles these via container)
 */
function buildToolExecutor(
  talkId: string,
  // contextPackage: ContextPackage,  // Could use for source lookups
) {
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    // --- Context tools: query DB directly ---
    if (toolName === 'read_context_source') {
      const ref = args.sourceRef as string | undefined;
      if (!ref) {
        return { result: 'Error: sourceRef parameter required', isError: true };
      }

      const db = getDb();
      const sourceRow = db
        .prepare(
          `
        SELECT extracted_text
        FROM talk_context_sources
        WHERE talk_id = ? AND (id = ? OR source_ref = ?)
      `,
        )
        .get(talkId, ref, ref) as
        | { extracted_text: string | null }
        | undefined;

      if (!sourceRow) {
        return { result: `Source ${ref} not found`, isError: true };
      }

      return { result: sourceRow.extracted_text || '' };
    }

    if (toolName === 'read_attachment') {
      const attachmentId = args.attachmentId as string | undefined;
      if (!attachmentId) {
        return { result: 'Error: attachmentId parameter required', isError: true };
      }

      const db = getDb();
      const attachmentRow = db
        .prepare(
          `
        SELECT extracted_text
        FROM talk_message_attachments
        WHERE id = ? AND talk_id = ?
      `,
        )
        .get(attachmentId, talkId) as { extracted_text: string | null } | undefined;

      if (!attachmentRow) {
        return { result: `Attachment ${attachmentId} not found`, isError: true };
      }

      return { result: attachmentRow.extracted_text || '' };
    }

    // --- Connector tools: delegate to tool-executors (todo: import when available) ---
    // For now, return an error; in production, import and call the connector executor
    if (toolName.startsWith('connector_')) {
      return {
        result: `Connector tool '${toolName}' execution not yet implemented`,
        isError: true,
      };
    }

    // --- All other tools: not available in Talk context ---
    return {
      result: `Tool '${toolName}' is not available in Talk context execution`,
      isError: true,
    };
  };
}

// ============================================================================
// CleanTalkExecutor
// ============================================================================

export class CleanTalkExecutor implements TalkExecutor {
  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const db = getDb();
    const emitEvent = emit || (() => {});
    const startTime = Date.now();

    try {
      // --- Step 1: Load Talk context ---
      const contextPackage = await loadTalkContext(input.talkId, 128000); // Assume 128K context window for now

      // --- Step 2: Resolve agent ---
      let agent: RegisteredAgentRecord | undefined;
      if (input.targetAgentId) {
        agent = getRegisteredAgent(input.targetAgentId);
      }
      if (!agent) {
        agent = resolvePrimaryAgent(input.talkId);
      }
      if (!agent) {
        agent = getMainAgent();
      }

      if (!agent) {
        const errorCode = 'NO_AGENT_AVAILABLE';
        const errorMessage = 'No agent could be resolved for this Talk';
        emitEvent({
          type: 'talk_response_failed',
          runId: input.runId,
          talkId: input.talkId,
          errorCode,
          errorMessage,
        });
        throw new Error(errorMessage);
      }

      // --- Step 3: Get agent's model context window ---
      const modelRow = db
        .prepare(
          `
        SELECT context_window_tokens
        FROM llm_provider_models
        WHERE provider_id = ? AND model_id = ?
      `,
        )
        .get(agent.provider_id, agent.model_id) as { context_window_tokens: number } | undefined;

      const modelContextWindow = modelRow?.context_window_tokens || 128000;

      // Reload context with correct context window
      const contextPackageWithCorrectWindow = await loadTalkContext(input.talkId, modelContextWindow);

      // --- Step 4: Build ExecutionContext ---
      const context: ExecutionContext = {
        systemPrompt: contextPackageWithCorrectWindow.systemPrompt,
        contextTools: contextPackageWithCorrectWindow.contextTools,
        connectorTools: contextPackageWithCorrectWindow.connectorTools,
        history: contextPackageWithCorrectWindow.history,
      };

      // --- Step 5: Execute via agent router ---
      let lastExecutionResult: AgentExecutionResult | null = null;
      let executionFailed = false;
      let executionErrorCode = '';
      let executionErrorMessage = '';

      const toolExecutor = buildToolExecutor(input.talkId);

      try {
        lastExecutionResult = await executeWithAgent(agent.id, context, input.triggerContent, {
          runId: input.runId,
          userId: input.requestedBy,
          signal,
          emit: (event: ExecutionEvent) => {
            // Map agent-router events to Talk events
            const talkEvent = mapExecutionEvent(
              event,
              input,
              agent!,
              agent!.provider_id,
              agent!.model_id,
            );
            if (talkEvent) {
              emitEvent(talkEvent);
            }
          },
          executeToolCall: toolExecutor,
        });
      } catch (err) {
        executionFailed = true;
        executionErrorCode = err instanceof Error ? 'EXECUTION_ERROR' : 'UNKNOWN_ERROR';
        executionErrorMessage = err instanceof Error ? err.message : String(err);
      }

      if (executionFailed || !lastExecutionResult) {
        emitEvent({
          type: 'talk_response_failed',
          runId: input.runId,
          talkId: input.talkId,
          agentId: agent.id,
          providerId: agent.provider_id,
          modelId: agent.model_id,
          errorCode: executionErrorCode,
          errorMessage: executionErrorMessage,
        });
        throw new Error(executionErrorMessage);
      }

      // --- Step 6: Store results in database ---
      const messageId = randomUUID();
      const now = new Date().toISOString();

      // Store the assistant's response message in unified messages table
      // Note: createdBy is for the *user* who created a message; assistant
      // messages are system-generated, so createdBy must be null.
      createMessage({
        id: messageId,
        talkId: input.talkId,
        role: 'assistant',
        content: lastExecutionResult.content,
        agentId: agent.id,
        createdBy: null,
        metadataJson: JSON.stringify({
          runId: input.runId,
          providerId: agent.provider_id,
          modelId: agent.model_id,
        }),
      });

      // Store LLM attempt for tracking
      const latencyMs = Date.now() - startTime;
      const attemptStatus: LlmAttemptStatus = 'success';
      createLlmAttempt({
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        status: attemptStatus,
        latencyMs,
        inputTokens: lastExecutionResult.usage?.inputTokens,
        outputTokens: lastExecutionResult.usage?.outputTokens,
        estimatedCostUsd: lastExecutionResult.usage?.estimatedCostUsd,
        createdAt: now,
      });

      // --- Step 7: Emit completion event ---
      emitEvent({
        type: 'talk_response_completed',
        runId: input.runId,
        talkId: input.talkId,
        agentId: agent.id,
        agentNickname: agent.name,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        usage: lastExecutionResult.usage ? {
          inputTokens: lastExecutionResult.usage.inputTokens,
          outputTokens: lastExecutionResult.usage.outputTokens,
          estimatedCostUsd: lastExecutionResult.usage.estimatedCostUsd,
        } : undefined,
      });

      // --- Step 8: Return result ---
      return {
        content: lastExecutionResult.content,
        agentId: agent.id,
        agentNickname: agent.name,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        usage: lastExecutionResult.usage ? {
          inputTokens: lastExecutionResult.usage.inputTokens,
          outputTokens: lastExecutionResult.usage.outputTokens,
          estimatedCostUsd: lastExecutionResult.usage.estimatedCostUsd,
        } : undefined,
        responseSequenceInRun: 1,
        metadataJson: JSON.stringify({
          agentId: agent.id,
          providerId: agent.provider_id,
          modelId: agent.model_id,
          contextTokens: contextPackageWithCorrectWindow.estimatedTokens,
        }),
      };
    } catch (err) {
      // Final catch: emit failure if not already emitted
      const errorCode = err instanceof Error ? 'EXECUTOR_ERROR' : 'UNKNOWN_ERROR';
      const errorMessage = err instanceof Error ? err.message : String(err);

      emitEvent({
        type: 'talk_response_failed',
        runId: input.runId,
        talkId: input.talkId,
        errorCode,
        errorMessage,
      });

      throw err;
    }
  }
}

// Export for use
export default CleanTalkExecutor;
