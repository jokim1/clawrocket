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
import {
  getSettingValue,
  getTalkRunById,
  updateTalkRunMetadata,
} from '../db/accessors.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from './agent-router.js';
import {
  EXECUTOR_MAIN_PROJECT_PATH_KEY,
  getContainerAllowedTools,
  planMainExecution,
  type MainExecutionPlan,
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
  promotionRequest?: MainPromotionRequest | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd?: number;
  };
}

export interface MainPromotionRequest {
  taskDescription: string;
  requiredToolFamilies: Array<'shell' | 'filesystem' | 'browser'>;
  userVisibleSummary: string;
  handoffNote: string | null;
  requiresApproval: boolean;
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
    }
  | {
      type: 'main_promotion_pending';
      runId: string;
      threadId: string;
      requestedToolFamilies: string[];
      userVisibleSummary: string;
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

const REQUEST_HEAVY_EXECUTION_TOOL = {
  name: 'request_heavy_execution',
  description:
    'Escalate this Main request into a heavy background run when shell, filesystem, or browser tools are required.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      taskDescription: { type: 'string', maxLength: 2000 },
      requiredToolFamilies: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['shell', 'filesystem', 'browser'],
        },
        minItems: 1,
        uniqueItems: true,
      },
      userVisibleSummary: { type: 'string', maxLength: 120 },
      handoffNote: { type: ['string', 'null'], maxLength: 500 },
    },
    required: ['taskDescription', 'requiredToolFamilies', 'userVisibleSummary'],
  },
} satisfies ExecutionContext['contextTools'][number];

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function appendSystemSection(
  base: string,
  heading: string,
  body: string,
): string {
  const section = [`# ${heading}`, '', body].join('\n');
  return base ? `${base}\n\n${section}` : section;
}

function toolFamilyEnabled(
  effectiveTools: MainExecutionPlan['effectiveTools'],
  family: string,
): boolean {
  return effectiveTools.some(
    (tool) => tool.toolFamily === family && tool.enabled,
  );
}

function updateRunTiming(runId: string, patch: Record<string, unknown>): void {
  updateTalkRunMetadata(runId, (current) => {
    const timing =
      current.timing &&
      typeof current.timing === 'object' &&
      !Array.isArray(current.timing)
        ? { ...(current.timing as Record<string, unknown>) }
        : {};
    return {
      ...current,
      timing: {
        ...timing,
        ...patch,
      },
    };
  });
}

function validatePromotionRequest(
  args: Record<string, unknown>,
  mainPlan: MainExecutionPlan,
): { ok: true; value: MainPromotionRequest } | { ok: false; error: string } {
  const taskDescription =
    typeof args.taskDescription === 'string' ? args.taskDescription.trim() : '';
  if (!taskDescription) {
    return { ok: false, error: 'taskDescription is required.' };
  }
  if (taskDescription.length > 2000) {
    return {
      ok: false,
      error: 'taskDescription must be 2000 characters or fewer.',
    };
  }

  const requiredToolFamiliesRaw = Array.isArray(args.requiredToolFamilies)
    ? args.requiredToolFamilies
    : [];
  const requiredToolFamilies = Array.from(
    new Set(
      requiredToolFamiliesRaw.filter(
        (entry): entry is 'shell' | 'filesystem' | 'browser' =>
          entry === 'shell' || entry === 'filesystem' || entry === 'browser',
      ),
    ),
  );
  if (requiredToolFamilies.length === 0) {
    return {
      ok: false,
      error:
        'requiredToolFamilies must include at least one of shell, filesystem, or browser.',
    };
  }

  const allowedFamilies = new Set(mainPlan.heavyToolFamilies);
  for (const family of requiredToolFamilies) {
    if (!allowedFamilies.has(family)) {
      return {
        ok: false,
        error: `Tool family '${family}' is not enabled for this Main agent.`,
      };
    }
  }

  const userVisibleSummary =
    typeof args.userVisibleSummary === 'string'
      ? args.userVisibleSummary.trim()
      : '';
  if (!userVisibleSummary) {
    return { ok: false, error: 'userVisibleSummary is required.' };
  }
  if (userVisibleSummary.length > 120) {
    return {
      ok: false,
      error: 'userVisibleSummary must be 120 characters or fewer.',
    };
  }

  const handoffNoteRaw =
    args.handoffNote == null
      ? null
      : typeof args.handoffNote === 'string'
        ? args.handoffNote.trim()
        : '';
  if (handoffNoteRaw !== null && handoffNoteRaw.length > 500) {
    return { ok: false, error: 'handoffNote must be 500 characters or fewer.' };
  }

  const toolByFamily = new Map(
    mainPlan.effectiveTools.map((tool) => [tool.toolFamily, tool]),
  );
  const requiresApproval = requiredToolFamilies.some(
    (family) => toolByFamily.get(family)?.requiresApproval === true,
  );

  return {
    ok: true,
    value: {
      taskDescription,
      requiredToolFamilies,
      userVisibleSummary,
      handoffNote: handoffNoteRaw || null,
      requiresApproval,
    },
  };
}

function buildPromotionHandoffSection(
  promotionRequest: MainPromotionRequest,
): string {
  return [
    'This Main turn was promoted into container execution because heavy tools are required.',
    '',
    `Task description: ${promotionRequest.taskDescription}`,
    promotionRequest.handoffNote
      ? `Additional note: ${promotionRequest.handoffNote}`
      : null,
    `Required tool families: ${promotionRequest.requiredToolFamilies.join(', ')}`,
  ]
    .filter(Boolean)
    .join('\n');
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

  const mainPlan = planMainExecution(agent, input.requestedBy);
  const runMetadata = parseObject(getTalkRunById(input.runId)?.metadata_json);
  const promotedRun =
    runMetadata.kind === 'main_promotion'
      ? ({
          taskDescription:
            typeof runMetadata.taskDescription === 'string'
              ? runMetadata.taskDescription
              : '',
          requiredToolFamilies: Array.isArray(runMetadata.requestedToolFamilies)
            ? runMetadata.requestedToolFamilies.filter(
                (entry): entry is 'shell' | 'filesystem' | 'browser' =>
                  entry === 'shell' ||
                  entry === 'filesystem' ||
                  entry === 'browser',
              )
            : [],
          userVisibleSummary:
            typeof runMetadata.userVisibleSummary === 'string'
              ? runMetadata.userVisibleSummary
              : 'Background task',
          handoffNote:
            typeof runMetadata.handoffNote === 'string'
              ? runMetadata.handoffNote
              : null,
          requiresApproval: false,
        } satisfies MainPromotionRequest)
      : null;

  updateRunTiming(input.runId, {
    executorStartedAt: new Date().toISOString(),
  });

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
  updateTalkRunMetadata(input.runId, (current) => ({
    ...current,
    ...mainContext.contextSnapshot,
    renderer:
      promotedRun || mainPlan.policy === 'container_only'
        ? 'container'
        : 'direct_http',
    executionPolicy: mainPlan.policy,
  }));

  // --- Step 3: Execute via agent router ---
  // Main channel has web tools but no context-source or connector tools.
  const shouldUseContainer =
    Boolean(promotedRun) || mainPlan.policy === 'container_only';
  if (shouldUseContainer) {
    const containerPlan = mainPlan.containerPlan;
    if (!containerPlan) {
      throw new Error(
        'Main container execution is not configured for this agent',
      );
    }
    const projectMountHostPath = resolveValidatedProjectMountPath(
      getSettingValue(EXECUTOR_MAIN_PROJECT_PATH_KEY),
      true,
    );
    let systemPrompt = agent.system_prompt?.trim() || '';
    if (mainContext.summaryText) {
      systemPrompt = appendSystemSection(
        systemPrompt,
        'Main Thread Context',
        mainContext.summaryText,
      );
    }
    if (promotedRun) {
      systemPrompt = appendSystemSection(
        systemPrompt,
        'Promotion Handoff',
        buildPromotionHandoffSection(promotedRun),
      );
    }
    const containerEffectiveTools = promotedRun
      ? containerPlan.effectiveTools.filter(
          (tool) =>
            tool.toolFamily === 'web' ||
            promotedRun.requiredToolFamilies.includes(
              tool.toolFamily as 'shell' | 'filesystem' | 'browser',
            ),
        )
      : containerPlan.effectiveTools;
    const result = await executeContainerAgentTurn({
      runId: input.runId,
      userId: input.requestedBy,
      agent,
      promptLabel: 'main',
      userMessage: renderMainPromptPayload(mainContext, input.triggerContent),
      signal,
      allowedTools: getContainerAllowedTools({
        effectiveTools: containerEffectiveTools,
      }),
      context: {
        systemPrompt,
        history: mainContext.history,
      },
      modelContextWindow,
      containerCredential: containerPlan.containerCredential,
      threadId: input.threadId,
      projectMountHostPath,
    });

    updateRunTiming(input.runId, {
      completedAt: new Date().toISOString(),
    });
    return {
      content: result.content,
      agentId: agent.id,
      agentName: agent.name,
      providerId: agent.provider_id,
      modelId: agent.model_id,
      threadId: input.threadId,
      latencyMs: Date.now() - startTime,
      promotionRequest: null,
    };
  }

  if (!mainPlan.directPlan) {
    throw new Error('Main direct execution is not configured for this agent');
  }

  let firstProviderEventRecorded = false;
  let firstTokenRecorded = false;
  let promotionRequest: MainPromotionRequest | null = null;
  const directContextTools = toolFamilyEnabled(mainPlan.effectiveTools, 'web')
    ? WEB_TOOL_DEFINITIONS
    : [];
  const context: ExecutionContext = {
    systemPrompt: buildMainSystemPrompt(mainContext.summaryText),
    contextTools:
      mainPlan.policy === 'direct_with_promotion'
        ? [...directContextTools, REQUEST_HEAVY_EXECUTION_TOOL]
        : directContextTools,
    connectorTools: [],
    history: mainContext.history,
  };
  const result = await executeWithAgent(
    agent.id,
    context,
    input.triggerContent,
    {
      runId: input.runId,
      userId: input.requestedBy,
      signal,
      alwaysAllowedContextToolNames:
        mainPlan.policy === 'direct_with_promotion'
          ? [REQUEST_HEAVY_EXECUTION_TOOL.name]
          : undefined,
      emit: (event: ExecutionEvent) => {
        if (
          !firstProviderEventRecorded &&
          (event.type === 'text_delta' ||
            event.type === 'tool_call' ||
            event.type === 'tool_result' ||
            event.type === 'usage')
        ) {
          firstProviderEventRecorded = true;
          const firstProviderEventAt = new Date().toISOString();
          updateRunTiming(input.runId, {
            firstProviderEventAt,
          });
        }
        if (event.type === 'text_delta') {
          if (!firstTokenRecorded) {
            firstTokenRecorded = true;
            updateRunTiming(input.runId, {
              firstTokenAt: new Date().toISOString(),
            });
          }
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
      executeToolCall: buildMainToolExecutor({
        signal,
        input,
        mainPlan,
        onPromotionRequested: (request) => {
          promotionRequest = request;
          updateTalkRunMetadata(input.runId, (current) => ({
            ...current,
            promotionRequested: true,
            promotionState: 'pending',
            promotionChildRunId: null,
            requestedToolFamilies: request.requiredToolFamilies,
            userVisibleSummary: request.userVisibleSummary,
          }));
          emitEvent({
            type: 'main_promotion_pending',
            runId: input.runId,
            threadId: input.threadId,
            requestedToolFamilies: request.requiredToolFamilies,
            userVisibleSummary: request.userVisibleSummary,
          });
        },
      }),
    },
  );

  updateRunTiming(input.runId, {
    completedAt: new Date().toISOString(),
  });
  return {
    content: result.content,
    agentId: agent.id,
    agentName: agent.name,
    providerId: agent.provider_id,
    modelId: agent.model_id,
    threadId: input.threadId,
    latencyMs: Date.now() - startTime,
    promotionRequest,
    usage: result.usage,
  };
}

// ============================================================================
// Main Tool Executor
// ============================================================================

/**
 * Build the executeToolCall callback for the Main channel.
 * Main supports direct web/browser tools plus promotion requests — no context sources or connectors.
 */
function buildMainToolExecutor(input: {
  signal: AbortSignal;
  input: MainExecutorInput;
  mainPlan: MainExecutionPlan;
  onPromotionRequested: (request: MainPromotionRequest) => void;
}) {
  let promotionRequested = false;
  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    if (toolName === 'web_fetch') {
      if (!toolFamilyEnabled(input.mainPlan.effectiveTools, 'web')) {
        return {
          result: "Tool 'web_fetch' is not enabled for this Main agent",
          isError: true,
        };
      }
      return executeWebFetch(args, input.signal);
    }
    if (toolName === 'web_search') {
      if (!toolFamilyEnabled(input.mainPlan.effectiveTools, 'web')) {
        return {
          result: "Tool 'web_search' is not enabled for this Main agent",
          isError: true,
        };
      }
      return executeWebSearch(args, input.signal);
    }
    if (toolName === REQUEST_HEAVY_EXECUTION_TOOL.name) {
      if (input.mainPlan.policy !== 'direct_with_promotion') {
        return {
          result:
            'Heavy execution promotion is not available for this Main run.',
          isError: true,
        };
      }
      if (!input.mainPlan.containerPlan) {
        return {
          result: 'Heavy execution is not configured for this Main agent.',
          isError: true,
        };
      }
      const validated = validatePromotionRequest(args, input.mainPlan);
      if (!validated.ok) {
        return {
          result: `Retry request_heavy_execution with a shorter valid handoff. ${validated.error}`,
          isError: true,
        };
      }
      if (promotionRequested) {
        return {
          result:
            'Heavy execution has already been requested for this Main turn.',
          isError: true,
        };
      }
      promotionRequested = true;
      input.onPromotionRequested(validated.value);
      return {
        result: `Heavy execution requested: ${validated.value.userVisibleSummary}`,
      };
    }

    return {
      result: `Tool '${toolName}' is not available in Main channel execution`,
      isError: true,
    };
  };
}
