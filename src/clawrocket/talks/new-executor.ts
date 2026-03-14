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
import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
  TalkExecutionEvent,
} from './executor.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * ContextPackage is returned from loadTalkContext.
 * It encapsulates all Talk-level context: system prompt, tools, and history.
 */
interface ContextPackage {
  systemPrompt: string;
  connectorTools: any[]; // LlmToolDefinition[]
  contextTools: any[]; // LlmToolDefinition[]
  history: any[]; // LlmMessage[]
  estimatedTokens: number;
  metadata: {
    talkId: string;
    sourceCount: number;
    connectorCount: number;
    historyTurnCount: number;
    hasSummary: boolean;
  };
}

// ============================================================================
// Context Loader
// ============================================================================

/**
 * Load Talk context: goal, rules, rolling summary, sources, connector tools, and message history.
 *
 * This function assembles a ContextPackage by:
 * 1. Fetching goal, rules, and rolling summary from talk_context_* tables
 * 2. Building source manifest from talk_context_sources
 * 3. Loading connector tools from talk_data_connectors
 * 4. Loading message history with simple token budgeting (backward fill to context window limit)
 * 5. Returning the complete package for agent execution
 *
 * Token budgeting: ~20 lines of simple logic.
 * - Estimate 1 char ≈ 0.25 tokens
 * - Fill backward from the context window, subtracting reserves for output and tools
 * - No complex priority system; simple ceiling
 */
async function loadTalkContext(
  talkId: string,
  modelContextWindowTokens: number,
): Promise<ContextPackage> {
  const db = getDb();

  // --- Load goal, rules, and rolling summary ---
  const goalRow = db.prepare('SELECT goal FROM talk_context_goal WHERE talk_id = ?').get(talkId) as
    | { goal: string }
    | undefined;
  const goal = goalRow?.goal || '';

  const rulesRows = db
    .prepare('SELECT rules FROM talk_context_rules WHERE talk_id = ? AND is_active = 1')
    .all(talkId) as Array<{ rules: string }>;
  const rules = rulesRows.map((r) => r.rules).join('\n');

  const summaryRow = db
    .prepare('SELECT summary FROM talk_context_summary WHERE talk_id = ?')
    .get(talkId) as { summary: string } | undefined;
  const hasSummary = !!summaryRow?.summary;
  const summary = summaryRow?.summary || '';

  // --- Build source manifest ---
  const sourcesRows = db
    .prepare(
      `
    SELECT id, title, source_type, uri, inline_content, extracted_size_bytes
    FROM talk_context_sources
    WHERE talk_id = ?
    ORDER BY created_at ASC
  `,
    )
    .all(talkId) as Array<{
    id: string;
    title: string;
    source_type: string;
    uri: string;
    inline_content: string | null;
    extracted_size_bytes: number;
  }>;

  const sourceCount = sourcesRows.length;
  let sourceManifest = '';
  if (sourceCount > 0) {
    sourceManifest = 'Sources:\n';
    for (const src of sourcesRows) {
      sourceManifest += `- [${src.title}](${src.uri})\n`;
      // Inline small sources (< 250 tokens ≈ 1000 chars)
      if (src.inline_content && src.extracted_size_bytes < 1000) {
        sourceManifest += `  ${src.inline_content}\n`;
      } else if (src.extracted_size_bytes > 0) {
        sourceManifest += `  (see read_context_source(ref="${src.id}"))\n`;
      }
    }
    sourceManifest += '\n';
  }

  // --- Build connector tools ---
  const connectorRows = db
    .prepare(
      `
    SELECT dc.id, dc.name, dc.description, dc.tool_definition_json
    FROM talk_data_connectors tdc
    JOIN data_connectors dc ON dc.id = tdc.connector_id
    WHERE tdc.talk_id = ?
  `,
    )
    .all(talkId) as Array<{
    id: string;
    name: string;
    description: string;
    tool_definition_json: string;
  }>;

  const connectorTools: any[] = connectorRows.map((c) => {
    try {
      return JSON.parse(c.tool_definition_json);
    } catch {
      return null;
    }
  });
  const connectorCount = connectorTools.filter((t) => t !== null).length;

  // --- Context tools (always included for Talk execution) ---
  const contextTools: any[] = [
    {
      name: 'read_context_source',
      description: 'Read content from a Talk context source by reference ID',
      input_schema: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'Source reference ID' },
        },
        required: ['ref'],
      },
    },
    {
      name: 'read_attachment',
      description: 'Read content from an attachment in the current turn',
      input_schema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: 'Attachment ID' },
        },
        required: ['attachmentId'],
      },
    },
  ];

  // --- Load message history with token budgeting ---
  // Reserve tokens: 2000 for output, 1000 for tool schemas, system prompt
  const outputReserve = 2000;
  const toolReserve = 1000;
  const systemPromptEstimate = Math.ceil(
    (goal.length + rules.length + summary.length + sourceManifest.length) * 0.25,
  );
  const availableTokens = modelContextWindowTokens - outputReserve - toolReserve - systemPromptEstimate;

  const messages = db
    .prepare(
      `
    SELECT id, talk_id, role, content, created_by, created_at, run_id, metadata_json
    FROM talk_messages
    WHERE talk_id = ?
    ORDER BY created_at DESC
  `,
    )
    .all(talkId) as Array<{
    id: string;
    talk_id: string;
    role: string;
    content: string;
    created_by: string | null;
    created_at: string;
    run_id: string | null;
    metadata_json: string | null;
  }>;

  // Walk backward, accumulating tokens until we hit the budget
  let estimatedTokens = 0;
  const history: any[] = [];
  for (const msg of messages) {
    const msgTokens = Math.ceil(msg.content.length * 0.25);
    if (estimatedTokens + msgTokens > availableTokens) {
      break; // Hit budget ceiling
    }
    history.unshift({
      role: msg.role,
      text: msg.content,
      talkMessageId: msg.id,
    });
    estimatedTokens += msgTokens;
  }

  const historyTurnCount = Math.floor(history.length / 2); // Rough: pairs of user/assistant

  // --- Build system prompt ---
  const systemPrompt =
    `You are an assistant engaged in a conversation.

## Goal
${goal}

## Rules
${rules}

${hasSummary ? `## Summary of Prior Discussion\n${summary}\n` : ''}

${sourceManifest ? `${sourceManifest}` : ''}

Remember to use the provided tools to access additional context as needed.`.trim();

  return {
    systemPrompt,
    connectorTools,
    contextTools,
    history,
    estimatedTokens,
    metadata: {
      talkId,
      sourceCount,
      connectorCount,
      historyTurnCount,
      hasSummary,
    },
  };
}

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
      const ref = args.ref as string | undefined;
      if (!ref) {
        return { result: 'Error: ref parameter required', isError: true };
      }

      const db = getDb();
      const sourceRow = db
        .prepare(
          `
        SELECT extracted_content, inline_content
        FROM talk_context_sources
        WHERE talk_id = ? AND id = ?
      `,
        )
        .get(talkId, ref) as
        | { extracted_content: string | null; inline_content: string | null }
        | undefined;

      if (!sourceRow) {
        return { result: `Source ${ref} not found`, isError: true };
      }

      const content = sourceRow.extracted_content || sourceRow.inline_content || '';
      return { result: content };
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
        FROM talk_attachments
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
      createMessage({
        id: messageId,
        talkId: input.talkId,
        role: 'assistant',
        content: lastExecutionResult.content,
        agentId: agent.id,
        createdBy: agent.id,
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
