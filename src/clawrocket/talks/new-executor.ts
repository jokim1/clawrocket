/**
 * CleanTalkExecutor orchestrates a single Talk run execution.
 *
 * Responsibilities:
 * 1. Resolve the target agent
 * 2. Load Talk context for that agent
 * 3. Inject ordered-round prior outputs into the step-local user message
 * 4. Execute via agent-router
 * 5. Stream TalkExecutionEvents
 *
 * Persistence is intentionally handled by the worker / DB atomic helpers.
 */

import { getDb } from '../../db.js';
import {
  getRegisteredAgent,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { getTalkById } from '../db/accessors.js';
import {
  listConnectorsForTalkRun,
  type TalkRunConnectorRecord,
} from '../db/connector-accessors.js';
import {
  executeConnectorTool,
  type ToolExecutionContext,
} from '../connectors/tool-executors.js';
import { parseConnectorToolName } from '../connectors/runtime.js';
import {
  executeWithAgent,
  type ExecutionContext,
  type ExecutionEvent,
} from '../agents/agent-router.js';
import {
  getContainerAllowedTools,
  planExecution,
} from '../agents/execution-planner.js';
import { getMainAgent, resolvePrimaryAgent } from '../agents/agent-registry.js';
import { resolveValidatedProjectMountPath } from '../agents/project-mounts.js';
import { executeContainerAgentTurn } from '../agents/container-turn-executor.js';
import { executeWebFetch, executeWebSearch } from '../tools/web-tools.js';
import { loadTalkContext } from './context-loader.js';
import {
  TalkExecutorError,
  type TalkExecutionEvent,
  type TalkExecutor,
  type TalkExecutorInput,
  type TalkExecutorOutput,
} from './executor.js';

function mapExecutionEvent(
  event: ExecutionEvent,
  input: TalkExecutorInput,
  agent: RegisteredAgentRecord,
): TalkExecutionEvent | null {
  const shared = {
    runId: input.runId,
    talkId: input.talkId,
    threadId: input.threadId,
    agentId: agent.id,
    agentNickname: agent.name,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    providerId: agent.provider_id,
    modelId: agent.model_id,
  };

  switch (event.type) {
    case 'started':
      return {
        type: 'talk_response_started',
        ...shared,
        providerId: event.providerId,
        modelId: event.modelId,
      };

    case 'text_delta':
      return {
        type: 'talk_response_delta',
        ...shared,
        deltaText: event.text,
      };

    case 'usage':
      return {
        type: 'talk_response_usage',
        ...shared,
        usage: {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        },
      };

    case 'completed':
      return {
        type: 'talk_response_completed',
        ...shared,
      };

    case 'failed':
      return {
        type: 'talk_response_failed',
        ...shared,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
      };

    case 'cancelled':
      return {
        type: 'talk_response_cancelled',
        ...shared,
      };

    case 'tool_call':
    case 'tool_result':
    case 'awaiting_confirmation':
      return null;

    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/** @internal Exported for integration testing only. */
export function buildToolExecutor(talkId: string, signal: AbortSignal) {
  let connectorCache: Map<string, TalkRunConnectorRecord> | null = null;

  function loadConnectors(): Map<string, TalkRunConnectorRecord> {
    if (connectorCache) return connectorCache;
    const connectors = listConnectorsForTalkRun(talkId);
    connectorCache = new Map(
      connectors.map((connector) => [connector.id, connector]),
    );
    return connectorCache;
  }

  return async (
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ result: string; isError?: boolean }> => {
    if (toolName === 'read_context_source') {
      const ref = args.sourceRef as string | undefined;
      if (!ref) {
        return { result: 'Error: sourceRef parameter required', isError: true };
      }

      const sourceRow = getDb()
        .prepare(
          `
        SELECT extracted_text
        FROM talk_context_sources
        WHERE talk_id = ? AND (id = ? OR source_ref = ?)
      `,
        )
        .get(talkId, ref, ref) as { extracted_text: string | null } | undefined;

      if (!sourceRow) {
        return { result: `Source ${ref} not found`, isError: true };
      }

      return { result: sourceRow.extracted_text || '' };
    }

    if (toolName === 'read_attachment') {
      const attachmentId = args.attachmentId as string | undefined;
      if (!attachmentId) {
        return {
          result: 'Error: attachmentId parameter required',
          isError: true,
        };
      }

      const attachmentRow = getDb()
        .prepare(
          `
        SELECT extracted_text
        FROM talk_message_attachments
        WHERE id = ? AND talk_id = ?
      `,
        )
        .get(attachmentId, talkId) as
        | { extracted_text: string | null }
        | undefined;

      if (!attachmentRow) {
        return {
          result: `Attachment ${attachmentId} not found`,
          isError: true,
        };
      }

      return { result: attachmentRow.extracted_text || '' };
    }

    if (toolName.startsWith('connector_')) {
      const parsed = parseConnectorToolName(toolName);
      if (!parsed) {
        return {
          result: `Unknown connector tool format: ${toolName}`,
          isError: true,
        };
      }

      const connectors = loadConnectors();
      const connector = connectors.get(parsed.connectorId);
      if (!connector) {
        return {
          result: `Connector '${parsed.connectorId}' is not available for this Talk.`,
          isError: true,
        };
      }

      if (connector.verificationStatus !== 'verified') {
        return {
          result: `Connector '${connector.name}' is no longer verified (status: ${connector.verificationStatus}). Please re-verify the connector credentials.`,
          isError: true,
        };
      }

      const context: ToolExecutionContext = {
        connector,
        signal,
      };

      const result = await executeConnectorTool(toolName, args, context);
      return { result: result.content, isError: result.isError };
    }

    if (toolName === 'web_fetch') {
      return executeWebFetch(args, signal);
    }
    if (toolName === 'web_search') {
      return executeWebSearch(args, signal);
    }

    return {
      result: `Tool '${toolName}' is not available in Talk context execution`,
      isError: true,
    };
  };
}

function resolveTalkAgent(
  talkId: string,
  targetAgentId?: string | null,
): RegisteredAgentRecord {
  const targeted = targetAgentId ? getRegisteredAgent(targetAgentId) : null;
  if (targeted) return targeted;

  const primary = resolvePrimaryAgent(talkId);
  if (primary) return primary;

  const main = getMainAgent();
  if (main) return main;

  throw new TalkExecutorError(
    'NO_AGENT_AVAILABLE',
    'No agent could be resolved for this Talk',
  );
}

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

const CHARS_TO_TOKENS = 0.25;
const ORDERED_USER_MESSAGE_RESERVE_TOKENS = 1024;
const MAX_ORDERED_PRIOR_OUTPUT_TOKENS = 12000;
const MAX_ORDERED_PRIOR_OUTPUT_CONTEXT_SHARE = 0.15;
const TRUNCATED_CONTEXT_SUFFIX = '\n\n[truncated for context window]';
const OMITTED_CONTEXT_MARKER = '[omitted due to context window]';

type PriorOrderedOutput = {
  sequenceIndex: number;
  agentId: string | null;
  agentNickname: string | null;
  content: string;
};

function listPriorOrderedOutputs(
  responseGroupId: string,
  currentSequenceIndex: number,
): PriorOrderedOutput[] {
  return getDb()
    .prepare(
      `
      WITH ordered_assistant_messages AS (
        SELECT
          talk_messages.run_id,
          talk_messages.content
        FROM talk_messages
        WHERE talk_messages.role = 'assistant'
        ORDER BY
          talk_messages.run_id ASC,
          COALESCE(talk_messages.sequence_in_run, 0) ASC,
          talk_messages.created_at ASC,
          talk_messages.id ASC
      ),
      assistant_outputs AS (
        SELECT
          ordered_assistant_messages.run_id,
          GROUP_CONCAT(ordered_assistant_messages.content, '\n\n') AS content
        FROM ordered_assistant_messages
        GROUP BY ordered_assistant_messages.run_id
      )
      SELECT
        r.sequence_index AS sequenceIndex,
        r.target_agent_id AS agentId,
        COALESCE(ra.name, 'Agent') AS agentNickname,
        ao.content AS content
      FROM talk_runs r
      JOIN assistant_outputs ao ON ao.run_id = r.id
      LEFT JOIN registered_agents ra ON ra.id = r.target_agent_id
      WHERE r.response_group_id = ?
        AND r.sequence_index IS NOT NULL
        AND r.sequence_index < ?
        AND r.status = 'completed'
      ORDER BY r.sequence_index ASC
    `,
    )
    .all(responseGroupId, currentSequenceIndex) as PriorOrderedOutput[];
}

function getOrderedGroupMaxSequence(responseGroupId: string): number | null {
  const row = getDb()
    .prepare(
      `
      SELECT MAX(sequence_index) AS max_sequence_index
      FROM talk_runs
      WHERE response_group_id = ?
        AND sequence_index IS NOT NULL
    `,
    )
    .get(responseGroupId) as { max_sequence_index: number | null } | undefined;

  if (!row || row.max_sequence_index == null) {
    return null;
  }

  return row.max_sequence_index;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * CHARS_TO_TOKENS);
}

function tokenBudgetToCharBudget(tokens: number): number {
  return Math.max(0, Math.floor(tokens / CHARS_TO_TOKENS));
}

function truncateForContextWindow(text: string, maxChars: number): string {
  if (maxChars <= 0) {
    return OMITTED_CONTEXT_MARKER;
  }
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= TRUNCATED_CONTEXT_SUFFIX.length) {
    return TRUNCATED_CONTEXT_SUFFIX.slice(0, maxChars);
  }
  return `${text.slice(0, maxChars - TRUNCATED_CONTEXT_SUFFIX.length).trimEnd()}${TRUNCATED_CONTEXT_SUFFIX}`;
}

function computePriorOutputBudgetChars(input: {
  modelContextWindow: number;
  estimatedContextTokens: number;
  originalQuestion: string;
}): number {
  const questionTokens = estimateTokens(input.originalQuestion);
  const cappedPromptShare = Math.floor(
    input.modelContextWindow * MAX_ORDERED_PRIOR_OUTPUT_CONTEXT_SHARE,
  );
  const promptBudgetTokens = Math.min(
    MAX_ORDERED_PRIOR_OUTPUT_TOKENS,
    cappedPromptShare,
  );
  const remainingTokens =
    input.modelContextWindow -
    input.estimatedContextTokens -
    ORDERED_USER_MESSAGE_RESERVE_TOKENS -
    questionTokens;
  return tokenBudgetToCharBudget(
    Math.max(0, Math.min(promptBudgetTokens, remainingTokens)),
  );
}

function formatPriorOutputs(
  priorOutputs: PriorOrderedOutput[],
  maxContentChars: number,
): string {
  const maxCharsPerOutput =
    priorOutputs.length > 0
      ? Math.max(0, Math.floor(maxContentChars / priorOutputs.length))
      : 0;
  return priorOutputs
    .map((output) => {
      const label = output.agentNickname || output.agentId || 'Agent';
      return `[${label}]\n${truncateForContextWindow(output.content, maxCharsPerOutput)}`;
    })
    .join('\n\n');
}

function buildOrderedUserMessage(input: {
  originalQuestion: string;
  priorOutputs: PriorOrderedOutput[];
  isSynthesis: boolean;
  maxPriorOutputChars: number;
}): string {
  const sections = [
    `Original user request:\n${input.originalQuestion}`,
    `Prior analyses from other agents:\n${formatPriorOutputs(input.priorOutputs, input.maxPriorOutputChars)}`,
  ];

  if (input.isSynthesis) {
    sections.push(
      [
        'Synthesize these perspectives.',
        'Identify areas of agreement, resolve tensions between differing viewpoints,',
        'and produce a unified recommendation that captures the strongest insights from each perspective.',
        "Treat the prior analyses as other agents' work, not as your own previous statements.",
      ].join(' '),
    );
  } else {
    sections.push(
      [
        'Provide your own analysis from your role and perspective.',
        'Use the prior analyses as context from other agents, not as your own previous statements.',
        'Do not merely restate them; add your independent reasoning.',
      ].join(' '),
    );
  }

  return sections.join('\n\n');
}

function buildStepUserMessage(input: {
  triggerContent: string;
  estimatedContextTokens: number;
  modelContextWindow: number;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
}): { userMessage: string; isSynthesis: boolean } {
  if (
    !input.responseGroupId ||
    typeof input.sequenceIndex !== 'number' ||
    input.sequenceIndex <= 0
  ) {
    return { userMessage: input.triggerContent, isSynthesis: false };
  }

  const priorOutputs = listPriorOrderedOutputs(
    input.responseGroupId,
    input.sequenceIndex,
  );
  if (priorOutputs.length === 0) {
    return { userMessage: input.triggerContent, isSynthesis: false };
  }

  const maxSequenceIndex = getOrderedGroupMaxSequence(input.responseGroupId);
  const isSynthesis =
    maxSequenceIndex != null &&
    maxSequenceIndex > 0 &&
    input.sequenceIndex === maxSequenceIndex;
  const maxPriorOutputChars = computePriorOutputBudgetChars({
    modelContextWindow: input.modelContextWindow,
    estimatedContextTokens: input.estimatedContextTokens,
    originalQuestion: input.triggerContent,
  });

  return {
    userMessage: buildOrderedUserMessage({
      originalQuestion: input.triggerContent,
      priorOutputs,
      isSynthesis,
      maxPriorOutputChars,
    }),
    isSynthesis,
  };
}

function buildResponseMetadataJson(input: {
  runId: string;
  providerId: string;
  modelId: string;
  estimatedContextTokens: number;
  responseGroupId?: string | null;
  sequenceIndex?: number | null;
  isSynthesis: boolean;
}): string {
  return JSON.stringify({
    runId: input.runId,
    providerId: input.providerId,
    modelId: input.modelId,
    contextTokens: input.estimatedContextTokens,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    ...(input.isSynthesis ? { isSynthesis: true } : {}),
  });
}

export class CleanTalkExecutor implements TalkExecutor {
  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const emitEvent = emit || (() => {});
    let failureEmitted = false;
    let resolvedAgent: RegisteredAgentRecord | null = null;

    const emitTalkEvent = (event: TalkExecutionEvent) => {
      if (event.type === 'talk_response_failed') {
        failureEmitted = true;
      }
      emitEvent(event);
    };

    try {
      resolvedAgent = resolveTalkAgent(input.talkId, input.targetAgentId);
      const modelContextWindow = getModelContextWindow(resolvedAgent);
      const contextPackage = await loadTalkContext(
        input.talkId,
        modelContextWindow,
        input.threadId,
        input.triggerMessageId,
      );

      const context: ExecutionContext = {
        systemPrompt: contextPackage.systemPrompt,
        contextTools: contextPackage.contextTools,
        connectorTools: contextPackage.connectorTools,
        history: contextPackage.history,
      };

      const orderedStep = buildStepUserMessage({
        triggerContent: input.triggerContent,
        estimatedContextTokens: contextPackage.estimatedTokens,
        modelContextWindow,
        responseGroupId: input.responseGroupId,
        sequenceIndex: input.sequenceIndex,
      });

      const plan = planExecution(resolvedAgent, input.requestedBy);

      if (plan.backend === 'container') {
        const talk = getTalkById(input.talkId);
        const projectMountHostPath = resolveValidatedProjectMountPath(
          talk?.project_path ?? null,
          false,
        );
        emitTalkEvent({
          type: 'talk_response_started',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: resolvedAgent.id,
          agentNickname: resolvedAgent.name,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: resolvedAgent.provider_id,
          modelId: resolvedAgent.model_id,
        });

        const containerResult = await executeContainerAgentTurn({
          runId: input.runId,
          userId: input.requestedBy,
          agent: resolvedAgent,
          promptLabel: 'talk',
          userMessage: orderedStep.userMessage,
          signal,
          allowedTools: getContainerAllowedTools({
            effectiveTools: plan.effectiveTools,
            includeConnectorTools: contextPackage.connectorTools.length > 0,
          }),
          context: {
            systemPrompt: [
              contextPackage.systemPrompt,
              resolvedAgent.system_prompt?.trim() || '',
            ]
              .filter(Boolean)
              .join('\n\n'),
            history: contextPackage.history,
          },
          modelContextWindow,
          containerCredential: plan.containerCredential,
          talkId: input.talkId,
          threadId: input.threadId,
          triggerMessageId: input.triggerMessageId,
          historyMessageIds: contextPackage.metadata.historyMessageIds,
          projectMountHostPath,
        });

        emitTalkEvent({
          type: 'talk_response_completed',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: resolvedAgent.id,
          agentNickname: resolvedAgent.name,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: resolvedAgent.provider_id,
          modelId: resolvedAgent.model_id,
        });

        return {
          content: containerResult.content,
          agentId: resolvedAgent.id,
          agentNickname: resolvedAgent.name,
          providerId: resolvedAgent.provider_id,
          modelId: resolvedAgent.model_id,
          responseSequenceInRun: 1,
          metadataJson: buildResponseMetadataJson({
            runId: input.runId,
            providerId: resolvedAgent.provider_id,
            modelId: resolvedAgent.model_id,
            estimatedContextTokens: contextPackage.estimatedTokens,
            responseGroupId: input.responseGroupId,
            sequenceIndex: input.sequenceIndex,
            isSynthesis: orderedStep.isSynthesis,
          }),
        };
      }

      const toolExecutor = buildToolExecutor(input.talkId, signal);
      const result = await executeWithAgent(
        resolvedAgent.id,
        context,
        orderedStep.userMessage,
        {
          runId: input.runId,
          userId: input.requestedBy,
          signal,
          emit: (event: ExecutionEvent) => {
            const mappedEvent = mapExecutionEvent(event, input, resolvedAgent!);
            if (mappedEvent) {
              emitTalkEvent(mappedEvent);
            }
          },
          executeToolCall: toolExecutor,
        },
      );

      return {
        content: result.content,
        agentId: result.agentId,
        agentNickname: resolvedAgent.name,
        providerId: result.providerId,
        modelId: result.modelId,
        usage: result.usage
          ? {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              estimatedCostUsd: result.usage.estimatedCostUsd,
            }
          : undefined,
        responseSequenceInRun: 1,
        metadataJson: buildResponseMetadataJson({
          runId: input.runId,
          providerId: result.providerId,
          modelId: result.modelId,
          estimatedContextTokens: contextPackage.estimatedTokens,
          responseGroupId: input.responseGroupId,
          sequenceIndex: input.sequenceIndex,
          isSynthesis: orderedStep.isSynthesis,
        }),
      };
    } catch (error) {
      const errorCode =
        error instanceof TalkExecutorError
          ? error.code
          : error instanceof Error
            ? 'EXECUTOR_ERROR'
            : 'UNKNOWN_ERROR';
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (!failureEmitted) {
        emitTalkEvent({
          type: 'talk_response_failed',
          runId: input.runId,
          talkId: input.talkId,
          threadId: input.threadId,
          agentId: resolvedAgent?.id,
          responseGroupId: input.responseGroupId ?? null,
          sequenceIndex: input.sequenceIndex ?? null,
          providerId: resolvedAgent?.provider_id,
          modelId: resolvedAgent?.model_id,
          errorCode,
          errorMessage,
        });
      }

      throw error;
    }
  }
}

export default CleanTalkExecutor;
