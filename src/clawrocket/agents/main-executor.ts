/**
 * MainExecutor — pure execution function for the Main Agent Channel.
 *
 * Uses the SAME pipeline as Talk execution (agentRouter.execute()), but with:
 * - Main thread memory loaded via main-context-loader
 * - Only persists the run context snapshot; worker owns message + terminal writes
 * - No terminal event emits (worker owns completed/failed events)
 *
 * The executor resolves an agent, builds a thread-scoped context package,
 * records an auditable run snapshot, calls executeWithAgent, emits streaming
 * events (started, deltas, usage), and returns output.
 * On failure it throws — the worker catches and emits the authoritative failure.
 *
 * Phase 2: Main executor now has web_fetch and web_search tools.
 */

import { getDb } from '../../db.js';
import {
  getRegisteredAgent,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { getSettingValue, setTalkRunMetadataJson } from '../db/accessors.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from './agent-router.js';
import {
  EXECUTOR_MAIN_PROJECT_PATH_KEY,
  getContainerAllowedTools,
  planExecution,
} from './execution-planner.js';
import { getMainAgent } from './agent-registry.js';
import {
  buildMainSystemPrompt,
  loadMainContext,
  renderMainPromptPayload,
} from './main-context-loader.js';
import { resolveValidatedProjectMountPath } from './project-mounts.js';
import { executeContainerAgentTurn } from './container-turn-executor.js';
import {
  executeWebFetch,
  executeWebSearch,
  WEB_TOOL_DEFINITIONS,
} from '../tools/web-tools.js';

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
  latencyMs: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}

/** Streaming-only events emitted during execution. Terminal events are worker-owned. */
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
      usage: {
        inputTokens: number;
        outputTokens: number;
        estimatedCostUsd?: number;
      };
    };

function getModelContextWindow(agent: RegisteredAgentRecord): number {
  const row = getDb()
    .prepare(
      `
      SELECT context_window_tokens
      FROM llm_provider_models
      WHERE provider_id = ? AND model_id = ?
      LIMIT 1
    `,
    )
    .get(agent.provider_id, agent.model_id) as
    | { context_window_tokens: number }
    | undefined;

  return row?.context_window_tokens || 128000;
}

// ============================================================================
// Main Executor (worker-owned terminal writes; persists context snapshot only)
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
    throw new Error('No agent available for Main channel');
  }

  const plan = planExecution(agent, input.requestedBy);

  emitEvent({
    type: 'main_response_started',
    runId: input.runId,
    threadId: input.threadId,
    agentId: agent.id,
    agentName: agent.name,
  });

  // --- Step 2: Load thread-scoped Main memory context ---
  const modelContextWindow = getModelContextWindow(agent);
  const mainContext = loadMainContext(
    input.threadId,
    modelContextWindow,
    input.triggerMessageId,
  );
  setTalkRunMetadataJson(
    input.runId,
    JSON.stringify({
      ...mainContext.contextSnapshot,
      renderer: plan.backend,
    }),
  );

  // --- Step 3: Execute via agent router ---
  // Main channel has web tools but no context-source or connector tools.
  const context: ExecutionContext = {
    systemPrompt: buildMainSystemPrompt(mainContext.summaryText),
    contextTools: WEB_TOOL_DEFINITIONS,
    connectorTools: [], // No connectors for Main channel v1
    history: mainContext.history,
  };
  if (plan.backend === 'container') {
    const projectMountHostPath = resolveValidatedProjectMountPath(
      getSettingValue(EXECUTOR_MAIN_PROJECT_PATH_KEY),
      true,
    );
    const result = await executeContainerAgentTurn({
      runId: input.runId,
      userId: input.requestedBy,
      agent,
      promptLabel: 'main',
      userMessage: renderMainPromptPayload(mainContext, input.triggerContent),
      signal,
      allowedTools: getContainerAllowedTools({
        effectiveTools: plan.effectiveTools,
      }),
      context: {
        systemPrompt: agent.system_prompt?.trim() || '',
        history: mainContext.history,
      },
      modelContextWindow,
      containerCredential: plan.containerCredential,
      threadId: input.threadId,
      projectMountHostPath,
    });

    return {
      content: result.content,
      agentId: agent.id,
      agentName: agent.name,
      providerId: agent.provider_id,
      modelId: agent.model_id,
      threadId: input.threadId,
      latencyMs: Date.now() - startTime,
    };
  }

  const result = await executeWithAgent(
    agent.id,
    context,
    input.triggerContent,
    {
      runId: input.runId,
      userId: input.requestedBy,
      signal,
      emit: (event: ExecutionEvent) => {
        if (event.type === 'text_delta') {
          emitEvent({
            type: 'main_response_delta',
            runId: input.runId,
            threadId: input.threadId,
            text: event.text,
          });
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
      executeToolCall: buildMainToolExecutor(signal),
    },
  );

  return {
    content: result.content,
    agentId: agent.id,
    agentName: agent.name,
    providerId: agent.provider_id,
    modelId: agent.model_id,
    threadId: input.threadId,
    latencyMs: Date.now() - startTime,
    usage: result.usage,
  };
}

// ============================================================================
// Main Tool Executor
// ============================================================================

/**
 * Build the executeToolCall callback for the Main channel.
 * Main has web tools only — no context sources, no connectors.
 */
function buildMainToolExecutor(signal: AbortSignal) {
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    if (toolName === 'web_fetch') {
      return executeWebFetch(args, signal);
    }
    if (toolName === 'web_search') {
      return executeWebSearch(args, signal);
    }

    return {
      result: `Tool '${toolName}' is not available in Main channel execution`,
      isError: true,
    };
  };
}
