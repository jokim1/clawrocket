import { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';

import {
  runContainerAgent,
  type ContainerOutput,
} from '../../container-runner.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import {
  appendRuntimeTalkMessage,
  createLlmAttempt,
  getProviderSecretByProviderId,
  getTalkById,
  listConnectorsForTalkRun,
  resolveTalkAgent,
  setTalkRunExecutorProfile,
} from '../db/index.js';
import { TALK_EXECUTOR_WEB_GROUP_FOLDER } from '../config.js';
import { DataConnectorVerifier } from '../connectors/connector-verifier.js';
import {
  buildConnectorToolDefinitions,
  parseConnectorToolName,
  type ConnectorToolDefinition,
} from '../connectors/runtime.js';
import { executeConnectorTool } from '../connectors/tool-executors.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import type {
  LlmFailureClass,
  LlmProviderRecord,
  LlmProviderModelRecord,
  ProviderSecretPayload,
} from '../llm/types.js';

import {
  assembleTalkPromptContext,
  ContextAssemblyError,
  type PromptMessage,
} from './context-assembler.js';
import type {
  TalkExecutionEvent,
  TalkExecutionUsage,
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';
import { TalkExecutorError } from './executor.js';
import { getActiveExecutorSettingsService } from './executor-settings.js';
import type { TalkPersonaRole } from '../llm/types.js';

const DEFAULT_RESPONSE_START_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 300_000;

interface ClassifiedTalkError {
  code: string;
  message: string;
  failureClass: LlmFailureClass;
  retryable: boolean;
}

interface AttemptContext {
  input: TalkExecutorInput;
  agentId: string;
  agentNickname: string;
  routeId: string;
  routeStepPosition: number;
  providerId: string;
  modelId: string;
}

interface StreamAttemptResult {
  content: string;
  usage?: TalkExecutionUsage;
  responseSequenceInRun?: number | null;
}

interface TimeoutConfig {
  responseStartTimeoutMs: number;
  streamIdleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

interface SseEvent {
  event?: string;
  data: string;
}

interface ConnectorToolContext {
  attachedConnectorCount: number;
  toolDefinitions: ConnectorToolDefinition[];
  connectorsById: Map<
    string,
    ReturnType<typeof listConnectorsForTalkRun>[number]
  >;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

type AnthropicConversationMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type OpenAiConversationMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

interface NormalizedToolCall {
  id: string;
  name: string;
  input: unknown;
}

interface ToolLoopTurnResult {
  stopReason: 'end_turn' | 'tool_use';
  text: string;
  usage?: TalkExecutionUsage;
  toolCalls: NormalizedToolCall[];
  anthropicAssistantContent?: AnthropicContentBlock[];
  openAiAssistantMessage?: Extract<
    OpenAiConversationMessage,
    { role: 'assistant' }
  >;
}

export interface DirectTalkExecutorOptions {
  fetchImpl?: typeof fetch;
  runContainer?: typeof runContainerAgent;
  groupFolder?: string;
}

function abortError(reason?: unknown): Error {
  const error = new Error(
    typeof reason === 'string' ? reason : 'Talk execution aborted',
  );
  error.name = 'AbortError';
  return error;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function buildTimeoutConfig(provider: LlmProviderRecord): TimeoutConfig {
  return {
    responseStartTimeoutMs:
      provider.response_start_timeout_ms ?? DEFAULT_RESPONSE_START_TIMEOUT_MS,
    streamIdleTimeoutMs:
      provider.stream_idle_timeout_ms ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    absoluteTimeoutMs:
      provider.absolute_timeout_ms ?? DEFAULT_ABSOLUTE_TIMEOUT_MS,
  };
}

function buildAuthHeaders(
  provider: LlmProviderRecord,
  secret: ProviderSecretPayload | null,
): Record<string, string> {
  if (!secret) return {};

  const headers: Record<string, string> = {};
  if (provider.auth_scheme === 'x_api_key') {
    headers['x-api-key'] = secret.apiKey;
  } else {
    headers.authorization = `Bearer ${secret.apiKey}`;
  }

  if (secret.organizationId) {
    // v1 only supports the OpenAI-style organization header; other provider-
    // specific org/account headers can be added when we support them.
    headers['OpenAI-Organization'] = secret.organizationId;
  }

  return headers;
}

function parseSseBuffer(buffer: string): {
  events: SseEvent[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const remainder = parts.pop() || '';
  const events = parts
    .map((block) => {
      const lines = block.split('\n');
      let eventType: string | undefined;
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          const rawData = line.slice(5);
          dataLines.push(rawData.startsWith(' ') ? rawData.slice(1) : rawData);
        }
      }
      return {
        event: eventType,
        data: dataLines.join('\n'),
      };
    })
    .filter((event) => event.data || event.event);

  return { events, remainder };
}

async function readSseResponse(
  response: Response,
  controller: AbortController,
  parentSignal: AbortSignal,
  timeouts: TimeoutConfig,
  onEvent: (event: SseEvent) => Promise<void> | void,
): Promise<void> {
  if (!response.body) {
    throw new TalkExecutorError(
      'provider_response_missing_body',
      'Provider response did not include a streaming body.',
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sawFirstChunk = false;

  let responseStartTimer: ReturnType<typeof setTimeout> | null = setTimeout(
    () => {
      controller.abort('response_start_timeout');
    },
    timeouts.responseStartTimeoutMs,
  );
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const absoluteTimer = setTimeout(() => {
    controller.abort('absolute_timeout');
  }, timeouts.absoluteTimeoutMs);

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      controller.abort('stream_idle_timeout');
    }, timeouts.streamIdleTimeoutMs);
  };

  try {
    while (!parentSignal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      if (!sawFirstChunk) {
        sawFirstChunk = true;
        if (responseStartTimer) {
          clearTimeout(responseStartTimer);
          responseStartTimer = null;
        }
      }

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) {
        await onEvent(event);
      }
    }

    if (buffer.trim()) {
      const parsed = parseSseBuffer(`${buffer}\n\n`);
      for (const event of parsed.events) {
        await onEvent(event);
      }
    }
  } catch (error) {
    if (parentSignal.aborted) {
      throw abortError(parentSignal.reason);
    }
    if (controller.signal.aborted) {
      throw new TalkExecutorError(
        String(controller.signal.reason || 'provider_timeout'),
        'Provider response timed out.',
      );
    }
    throw error;
  } finally {
    if (responseStartTimer) clearTimeout(responseStartTimer);
    if (idleTimer) clearTimeout(idleTimer);
    clearTimeout(absoluteTimer);
    reader.releaseLock();
  }
}

async function parseErrorResponse(response: Response): Promise<{
  status: number;
  body: unknown;
  message: string;
}> {
  const contentType = (
    response.headers.get('content-type') || ''
  ).toLowerCase();
  const text = await response.text();

  if (contentType.includes('application/json')) {
    try {
      const body = JSON.parse(text) as unknown;
      const message =
        typeof body === 'object' &&
        body &&
        'error' in body &&
        typeof (body as { error?: { message?: unknown } }).error?.message ===
          'string'
          ? String((body as { error: { message: string } }).error.message)
          : text || `Provider request failed with status ${response.status}`;
      return { status: response.status, body, message };
    } catch {
      // fall through
    }
  }

  return {
    status: response.status,
    body: text,
    message: text || `Provider request failed with status ${response.status}`,
  };
}

function classifyProviderFailure(error: unknown): ClassifiedTalkError {
  if (error instanceof ContextAssemblyError) {
    return {
      code: error.code,
      message: error.message,
      failureClass: 'invalid_request',
      retryable: false,
    };
  }

  if (error instanceof TalkExecutorError) {
    if (
      error.code === 'response_start_timeout' ||
      error.code === 'stream_idle_timeout' ||
      error.code === 'absolute_timeout' ||
      error.code === 'provider_timeout'
    ) {
      return {
        code: 'provider_timeout',
        message: error.sourceMessage,
        failureClass: 'timeout',
        retryable: true,
      };
    }
    if (
      error.code === 'message_too_large_for_route' ||
      error.code === 'tool_definitions_too_large_for_route' ||
      error.code === 'provider_request_missing_credentials' ||
      error.code === 'route_unavailable' ||
      error.code === 'talk_agent_not_found' ||
      error.code === 'connector_not_ready' ||
      error.code === 'connector_tools_require_tool_capable_model' ||
      error.code === 'connector_auth_mode_unsupported' ||
      error.code === 'provider_response_missing_body'
    ) {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass:
          error.code === 'message_too_large_for_route'
            ? 'invalid_request'
            : error.code === 'tool_definitions_too_large_for_route'
              ? 'configuration'
              : 'configuration',
        retryable: false,
      };
    }
    if (error.code === 'provider_quota_exhausted') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'quota_exhausted',
        retryable: true,
      };
    }
    if (error.code === 'provider_rate_limited') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'retryable_429',
        retryable: true,
      };
    }
    if (error.code === 'provider_auth_failed') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'auth',
        retryable: false,
      };
    }
    if (error.code === 'provider_unavailable') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'upstream_5xx',
        retryable: true,
      };
    }
    if (error.code === 'provider_invalid_request') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'invalid_request',
        retryable: false,
      };
    }
    if (error.code === 'provider_policy_rejected') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'policy',
        retryable: false,
      };
    }
    return {
      code: error.code,
      message: error.sourceMessage,
      failureClass: 'unknown',
      retryable: false,
    };
  }

  if (error instanceof TypeError) {
    return {
      code: 'provider_network_error',
      message: error.message || 'Provider network request failed.',
      failureClass: 'network',
      retryable: true,
    };
  }

  return {
    code: 'execution_failed',
    message:
      error instanceof Error ? error.message : 'Unknown talk execution failure',
    failureClass: 'unknown',
    retryable: false,
  };
}

function classifyHttpFailure(response: {
  status: number;
  body: unknown;
  message: string;
}): ClassifiedTalkError {
  const message =
    response.message || `Provider request failed with ${response.status}`;
  const bodyText = JSON.stringify(response.body).toLowerCase();

  if (response.status === 429) {
    const isQuota =
      bodyText.includes('quota') ||
      bodyText.includes('credit') ||
      bodyText.includes('billing') ||
      bodyText.includes('insufficient_quota');
    return {
      code: isQuota ? 'provider_quota_exhausted' : 'provider_rate_limited',
      message,
      failureClass: isQuota ? 'quota_exhausted' : 'retryable_429',
      retryable: true,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      code: 'provider_auth_failed',
      message,
      failureClass: 'auth',
      retryable: false,
    };
  }

  if (response.status >= 500) {
    return {
      code: 'provider_unavailable',
      message,
      failureClass: 'upstream_5xx',
      retryable: true,
    };
  }

  if (bodyText.includes('policy') || bodyText.includes('safety')) {
    return {
      code: 'provider_policy_rejected',
      message,
      failureClass: 'policy',
      retryable: false,
    };
  }

  return {
    code: 'provider_invalid_request',
    message,
    failureClass: 'invalid_request',
    retryable: false,
  };
}

function renderPromptTranscript(promptMessages: PromptMessage[]): string {
  return promptMessages
    .map((message) => {
      const label =
        message.role === 'system'
          ? 'SYSTEM'
          : message.role === 'assistant'
            ? 'ASSISTANT'
            : 'USER';
      return `${label}:\n${message.text}`;
    })
    .join('\n\n');
}

function looksLikeClaudeAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('oauth') ||
    normalized.includes('login') ||
    normalized.includes('credential') ||
    normalized.includes('api key') ||
    normalized.includes('authentication') ||
    normalized.includes('authorization') ||
    normalized.includes('auth token')
  );
}

function getClaudeTimeoutMessage(reason: unknown): string {
  switch (String(reason || 'provider_timeout')) {
    case 'response_start_timeout':
      return 'Claude did not start streaming a response in time.';
    case 'stream_idle_timeout':
      return 'Claude stopped streaming for too long.';
    case 'absolute_timeout':
      return 'Claude response exceeded the maximum time limit.';
    default:
      return 'Claude response timed out.';
  }
}

function classifyClaudeDefaultFailure(error: unknown): ClassifiedTalkError {
  if (error instanceof ContextAssemblyError) {
    return {
      code: error.code,
      message: error.message,
      failureClass: 'invalid_request',
      retryable: false,
    };
  }

  if (error instanceof TalkExecutorError) {
    if (
      error.code === 'response_start_timeout' ||
      error.code === 'stream_idle_timeout' ||
      error.code === 'absolute_timeout' ||
      error.code === 'provider_timeout'
    ) {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'timeout',
        retryable: true,
      };
    }
    if (error.code === 'executor_not_configured') {
      return {
        code: error.code,
        message: error.sourceMessage,
        failureClass: 'configuration',
        retryable: false,
      };
    }
    if (error.code === 'executor_container_error') {
      const sourceMessage = error.sourceMessage || error.message;
      if (looksLikeClaudeAuthFailure(sourceMessage)) {
        return {
          code: 'provider_auth_failed',
          message: sourceMessage,
          failureClass: 'auth',
          retryable: false,
        };
      }
      if (sourceMessage.toLowerCase().includes('timeout')) {
        return {
          code: 'provider_timeout',
          message: sourceMessage,
          failureClass: 'timeout',
          retryable: true,
        };
      }
      return {
        code: error.code,
        message: sourceMessage,
        failureClass: 'unknown',
        retryable: false,
      };
    }
    return {
      code: error.code,
      message: error.sourceMessage,
      failureClass: 'unknown',
      retryable: false,
    };
  }

  return {
    code: 'execution_failed',
    message:
      error instanceof Error
        ? error.message
        : 'Unknown Claude execution failure',
    failureClass: 'unknown',
    retryable: false,
  };
}

function createWebTalkGroup(groupFolder: string): RegisteredGroup {
  return {
    name: 'Web Talk Executor',
    folder: groupFolder,
    trigger: '@web',
    added_at: '1970-01-01T00:00:00.000Z',
    requiresTrigger: false,
    isMain: false,
  };
}

function buildAnthropicMessages(promptMessages: PromptMessage[]): {
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
} {
  const systemParts: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of promptMessages) {
    if (message.role === 'system') {
      systemParts.push(message.text);
    } else {
      messages.push({
        role: message.role,
        content: message.text,
      });
    }
  }
  return {
    system: systemParts.join('\n\n'),
    messages,
  };
}

function buildOpenAiMessages(promptMessages: PromptMessage[]): Array<{
  role: 'system' | 'user' | 'assistant';
  content: string;
}> {
  return promptMessages.map((message) => ({
    role: message.role,
    content: message.text,
  }));
}

function isToolCapableModel(
  model: LlmProviderModelRecord | undefined,
): boolean {
  return model?.supports_tools === 1;
}

function buildAnthropicToolDefinitions(
  toolDefinitions: ConnectorToolDefinition[],
): Array<{
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}> {
  return toolDefinitions.map((tool) => ({
    name: tool.toolName,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

function buildOpenAiToolDefinitions(
  toolDefinitions: ConnectorToolDefinition[],
): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}> {
  return toolDefinitions.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.toolName,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

function mergeUsageTotals(
  current: TalkExecutionUsage | undefined,
  incoming: TalkExecutionUsage | undefined,
): TalkExecutionUsage | undefined {
  if (!incoming) return current;
  return {
    inputTokens: (current?.inputTokens || 0) + (incoming.inputTokens || 0),
    outputTokens: (current?.outputTokens || 0) + (incoming.outputTokens || 0),
    estimatedCostUsd:
      current?.estimatedCostUsd !== undefined ||
      incoming.estimatedCostUsd !== undefined
        ? (current?.estimatedCostUsd || 0) + (incoming.estimatedCostUsd || 0)
        : undefined,
  };
}

function summarizeToolNames(toolCalls: NormalizedToolCall[]): string {
  const uniqueNames = Array.from(new Set(toolCalls.map((call) => call.name)));
  if (uniqueNames.length === 0) {
    return 'Using attached data connector tools.';
  }
  return `Using attached data connector tools: ${uniqueNames.join(', ')}.`;
}

function buildAssistantToolUseMetadata(input: {
  agentId: string;
  agentNickname: string;
  toolCalls: NormalizedToolCall[];
  displaySummary: string;
}): string {
  return JSON.stringify({
    kind: 'assistant_tool_use',
    agentId: input.agentId,
    agentNickname: input.agentNickname,
    toolNames: input.toolCalls.map((tool) => tool.name),
    displaySummary: input.displaySummary,
  });
}

function buildToolResultMetadata(input: {
  agentId: string;
  agentNickname: string;
  toolName: string;
  toolCallId: string;
  displaySummary: string;
  isError: boolean;
}): string {
  return JSON.stringify({
    kind: 'tool_result',
    agentId: input.agentId,
    agentNickname: input.agentNickname,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    displaySummary: input.displaySummary,
    isError: input.isError,
  });
}

export class DirectTalkExecutor implements TalkExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly runContainer: typeof runContainerAgent;
  private readonly groupFolder: string;
  private readonly connectorVerifier: DataConnectorVerifier;

  constructor(options: DirectTalkExecutorOptions = {}) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.runContainer = options.runContainer || runContainerAgent;
    this.groupFolder = options.groupFolder || TALK_EXECUTOR_WEB_GROUP_FOLDER;
    this.connectorVerifier = new DataConnectorVerifier({
      fetchImpl: this.fetchImpl,
    });
  }

  private async buildConnectorToolContext(
    talkId: string,
  ): Promise<ConnectorToolContext> {
    let connectors = listConnectorsForTalkRun(talkId);
    const needsVerification = connectors.filter(
      (connector) =>
        connector.verificationStatus === 'not_verified' ||
        connector.verificationStatus === 'verifying',
    );

    if (needsVerification.length > 0) {
      await Promise.all(
        needsVerification.map((connector) =>
          this.connectorVerifier.verify(connector.id).catch(() => undefined),
        ),
      );
      connectors = listConnectorsForTalkRun(talkId);
    }

    const usableConnectors = connectors.filter(
      (connector) => connector.verificationStatus === 'verified',
    );

    return {
      attachedConnectorCount: connectors.length,
      toolDefinitions: buildConnectorToolDefinitions(usableConnectors),
      connectorsById: new Map(
        usableConnectors.map((connector) => [connector.id, connector]),
      ),
    };
  }

  private emitBufferedTerminalResponse(
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    result: StreamAttemptResult,
  ): void {
    emit?.({
      type: 'talk_response_started',
      runId: context.input.runId,
      talkId: context.input.talkId,
      agentId: context.agentId,
      agentNickname: context.agentNickname,
      routeStepPosition: context.routeStepPosition,
      providerId: context.providerId,
      modelId: context.modelId,
    });

    if (result.content) {
      emit?.({
        type: 'talk_response_delta',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        agentNickname: context.agentNickname,
        deltaText: result.content,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
      });
    }

    if (result.usage) {
      emit?.({
        type: 'talk_response_usage',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        usage: result.usage,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
      });
    }
  }

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const talk = getTalkById(input.talkId);
    if (!talk) {
      throw new TalkExecutorError('talk_not_found', 'Talk not found.');
    }

    const resolved = resolveTalkAgent(input.talkId, input.targetAgentId);
    if (!resolved) {
      throw new TalkExecutorError(
        'talk_agent_not_found',
        'The selected talk agent could not be resolved.',
      );
    }

    if (resolved.route.enabled !== 1) {
      throw new TalkExecutorError(
        'route_unavailable',
        'The selected talk route is disabled.',
      );
    }

    if (resolved.steps.length === 0) {
      throw new TalkExecutorError(
        'route_unavailable',
        'The selected talk route does not have any configured steps.',
      );
    }

    const connectorToolContext = await this.buildConnectorToolContext(
      input.talkId,
    );
    const requiresConnectorTools =
      connectorToolContext.attachedConnectorCount > 0;

    if (
      requiresConnectorTools &&
      connectorToolContext.toolDefinitions.length === 0
    ) {
      throw new TalkExecutorError(
        'connector_not_ready',
        'Attached data connectors are not ready. Verify their credentials and configuration before running this talk.',
      );
    }

    if (resolved.sourceKind === 'claude_default') {
      const primaryStep = resolved.steps[0];
      if (!resolved.modelId && !primaryStep?.model.model_id) {
        throw new TalkExecutorError(
          'route_unavailable',
          'The selected Claude agent does not have a configured model.',
        );
      }

      const needsToolLoop = requiresConnectorTools;

      if (needsToolLoop && !isToolCapableModel(primaryStep?.model)) {
        throw new TalkExecutorError(
          'connector_tools_require_tool_capable_model',
          'Attached data connectors require a tool-capable model on the selected Claude route.',
        );
      }

      if (needsToolLoop) {
        return this.executeClaudeDefaultWithTools(
          {
            input,
            agentId: resolved.agent.id,
            agentNickname: resolved.agent.name,
            routeId: resolved.route.id,
            routeStepPosition: primaryStep?.routeStep.position ?? 0,
            providerId: 'provider.anthropic',
            modelId: resolved.modelId || primaryStep.model.model_id,
          },
          talk.topic_title,
          resolved.agent.persona_role,
          primaryStep?.model.context_window_tokens ?? 200_000,
          primaryStep?.model.default_max_output_tokens ?? 4_096,
          connectorToolContext,
          signal,
          emit,
        );
      }

      return this.executeClaudeDefaultAttempt(
        {
          input,
          agentId: resolved.agent.id,
          agentNickname: resolved.agent.name,
          routeId: resolved.route.id,
          routeStepPosition: primaryStep?.routeStep.position ?? 0,
          providerId: 'provider.anthropic',
          modelId: resolved.modelId || primaryStep.model.model_id,
        },
        talk.topic_title,
        resolved.agent.persona_role,
        primaryStep?.model.context_window_tokens ?? 200_000,
        primaryStep?.model.default_max_output_tokens ?? 4_096,
        signal,
        emit,
      );
    }

    let sawEligibleStep = false;
    let sawToolCapableStep = false;

    for (const step of resolved.steps) {
      const attemptContext: AttemptContext = {
        input,
        agentId: resolved.agent.id,
        agentNickname: resolved.agent.name,
        routeId: resolved.route.id,
        routeStepPosition: step.routeStep.position,
        providerId: step.provider.id,
        modelId: step.model.model_id,
      };

      if (step.provider.enabled !== 1 || step.model.enabled !== 1) {
        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'skipped',
          failureClass: 'configuration',
        });
        continue;
      }

      if (!step.talkUsable) {
        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'skipped',
          failureClass: 'configuration',
        });
        continue;
      }

      if (requiresConnectorTools && !isToolCapableModel(step.model)) {
        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'skipped',
          failureClass: 'configuration',
        });
        continue;
      }

      if (requiresConnectorTools) {
        sawToolCapableStep = true;
      }
      sawEligibleStep = true;

      if (step.provider.base_url.startsWith('mock://')) {
        if (requiresConnectorTools) {
          createLlmAttempt({
            runId: input.runId,
            talkId: input.talkId,
            agentId: resolved.agent.id,
            routeId: resolved.route.id,
            routeStepPosition: step.routeStep.position,
            providerId: step.provider.id,
            modelId: step.model.model_id,
            status: 'skipped',
            failureClass: 'configuration',
          });
          continue;
        }
        const result = await this.executeMockAttempt(
          attemptContext,
          emit,
          signal,
        );
        return {
          ...result,
          agentId: resolved.agent.id,
          agentNickname: resolved.agent.name,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          metadataJson: JSON.stringify({
            agentId: resolved.agent.id,
            agentNickname: resolved.agent.name,
            personaRole: resolved.agent.persona_role,
            routeId: resolved.route.id,
            providerId: step.provider.id,
            modelId: step.model.model_id,
          }),
        };
      }

      if (!step.hasCredential) {
        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'failed',
          failureClass: 'configuration',
        });
        throw new TalkExecutorError(
          'provider_request_missing_credentials',
          `Provider ${step.provider.name} is missing credentials.`,
        );
      }

      setTalkRunExecutorProfile({
        runId: input.runId,
        executorAlias: step.provider.id,
        executorModel: step.model.model_id,
      });

      const startedAt = Date.now();
      try {
        const prompt = assembleTalkPromptContext({
          talkId: input.talkId,
          talkTitle: talk.topic_title,
          currentRunId: input.runId,
          currentUserMessageId: input.triggerMessageId,
          currentUserMessage: input.triggerContent,
          agent: {
            id: resolved.agent.id,
            name: resolved.agent.name,
            personaRole: resolved.agent.persona_role,
          },
          modelContextWindowTokens: step.model.context_window_tokens,
          maxOutputTokens: step.model.default_max_output_tokens,
          toolDefinitions: requiresConnectorTools
            ? connectorToolContext.toolDefinitions
            : undefined,
        });

        const secretRecord = getProviderSecretByProviderId(step.provider.id);
        if (!secretRecord) {
          throw new TalkExecutorError(
            'provider_request_missing_credentials',
            `Provider ${step.provider.name} is missing credentials.`,
          );
        }

        const secret = decryptProviderSecret(secretRecord.ciphertext);
        const result = await this.executeProviderAttempt(
          step.provider,
          step.model.model_id,
          step.model.default_max_output_tokens,
          prompt.messages,
          secret,
          attemptContext,
          emit,
          signal,
          requiresConnectorTools ? connectorToolContext : undefined,
        );

        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'success',
          latencyMs: Date.now() - startedAt,
          inputTokens: result.usage?.inputTokens ?? prompt.estimatedInputTokens,
          outputTokens: result.usage?.outputTokens ?? null,
          estimatedCostUsd: result.usage?.estimatedCostUsd ?? null,
        });

        emit?.({
          type: 'talk_response_completed',
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          agentNickname: resolved.agent.name,
          usage: result.usage,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
        });

        return {
          content: result.content,
          metadataJson: JSON.stringify({
            agentId: resolved.agent.id,
            agentNickname: resolved.agent.name,
            personaRole: resolved.agent.persona_role,
            routeId: resolved.route.id,
            providerId: step.provider.id,
            modelId: step.model.model_id,
          }),
          agentId: resolved.agent.id,
          agentNickname: resolved.agent.name,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          usage: result.usage,
          responseSequenceInRun: result.responseSequenceInRun,
        };
      } catch (error) {
        if (signal.aborted) {
          createLlmAttempt({
            runId: input.runId,
            talkId: input.talkId,
            agentId: resolved.agent.id,
            routeId: resolved.route.id,
            routeStepPosition: step.routeStep.position,
            providerId: step.provider.id,
            modelId: step.model.model_id,
            status: 'cancelled',
            latencyMs: Date.now() - startedAt,
          });
          throw abortError(signal.reason);
        }

        const classified = classifyProviderFailure(error);
        createLlmAttempt({
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeId: resolved.route.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          status: 'failed',
          failureClass: classified.failureClass,
          latencyMs: Date.now() - startedAt,
        });

        emit?.({
          type: 'talk_response_failed',
          runId: input.runId,
          talkId: input.talkId,
          agentId: resolved.agent.id,
          routeStepPosition: step.routeStep.position,
          providerId: step.provider.id,
          modelId: step.model.model_id,
          errorCode: classified.code,
          errorMessage: classified.message,
        });

        if (classified.retryable) {
          logger.warn(
            {
              runId: input.runId,
              talkId: input.talkId,
              providerId: step.provider.id,
              modelId: step.model.model_id,
              failureClass: classified.failureClass,
            },
            'Retryable talk-provider failure; falling back to next route step',
          );
          continue;
        }

        throw new TalkExecutorError(classified.code, classified.message);
      }
    }

    if (!sawEligibleStep) {
      if (requiresConnectorTools && !sawToolCapableStep) {
        throw new TalkExecutorError(
          'connector_tools_require_tool_capable_model',
          'Attached data connectors require a tool-capable model on the selected agent route.',
        );
      }
      throw new TalkExecutorError(
        'route_unavailable',
        'No enabled route steps are available for this talk.',
      );
    }

    throw new TalkExecutorError(
      'route_unavailable',
      'All route steps failed before a response could be produced.',
    );
  }

  private async executeMockAttempt(
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput> {
    emit?.({
      type: 'talk_response_started',
      runId: context.input.runId,
      talkId: context.input.talkId,
      agentId: context.agentId,
      agentNickname: context.agentNickname,
      routeStepPosition: context.routeStepPosition,
      providerId: context.providerId,
      modelId: context.modelId,
    });
    await sleep(25, undefined, { signal }).catch(() => {
      throw abortError(signal.reason);
    });
    const content = `Mock assistant response to: ${context.input.triggerContent}`;
    emit?.({
      type: 'talk_response_delta',
      runId: context.input.runId,
      talkId: context.input.talkId,
      agentId: context.agentId,
      agentNickname: context.agentNickname,
      deltaText: content,
      routeStepPosition: context.routeStepPosition,
      providerId: context.providerId,
      modelId: context.modelId,
    });
    return {
      content,
      usage: {
        inputTokens: Math.ceil(context.input.triggerContent.length / 4),
        outputTokens: Math.ceil(content.length / 4),
      },
    };
  }

  private async executeClaudeDefaultAttempt(
    context: AttemptContext,
    talkTitle: string | null,
    personaRole: TalkPersonaRole,
    modelContextWindowTokens: number,
    maxOutputTokens: number,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const settingsService = getActiveExecutorSettingsService();
    const blockedReason = settingsService.getExecutionBlockedReason();
    if (blockedReason) {
      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'failed',
        failureClass: 'configuration',
      });
      emit?.({
        type: 'talk_response_failed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        errorCode: 'executor_not_configured',
        errorMessage: blockedReason,
      });
      throw new TalkExecutorError('executor_not_configured', blockedReason);
    }

    setTalkRunExecutorProfile({
      runId: context.input.runId,
      executorAlias: 'Claude',
      executorModel: context.modelId,
    });

    const startedAt = Date.now();
    try {
      const prompt = assembleTalkPromptContext({
        talkId: context.input.talkId,
        talkTitle,
        currentRunId: context.input.runId,
        currentUserMessageId: context.input.triggerMessageId,
        currentUserMessage: context.input.triggerContent,
        agent: {
          id: context.agentId,
          name: context.agentNickname,
          personaRole,
        },
        modelContextWindowTokens,
        maxOutputTokens,
      });

      emit?.({
        type: 'talk_response_started',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        agentNickname: context.agentNickname,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
      });

      const group = createWebTalkGroup(this.groupFolder);
      const chunks: string[] = [];
      let processRef: ChildProcess | null = null;
      const timeoutController = new AbortController();
      const abortWithTimeout = (reason: string) => {
        if (!timeoutController.signal.aborted) {
          timeoutController.abort(reason);
        }
      };
      const onParentAbort = () => {
        if (!timeoutController.signal.aborted) {
          timeoutController.abort(signal.reason);
        }
      };
      signal.addEventListener('abort', onParentAbort, { once: true });
      const onAbort = () => {
        if (processRef && !processRef.killed) {
          processRef.kill('SIGTERM');
        }
      };
      timeoutController.signal.addEventListener('abort', onAbort, {
        once: true,
      });
      let sawFirstChunk = false;
      let responseStartTimer: ReturnType<typeof setTimeout> | null = setTimeout(
        () => {
          abortWithTimeout('response_start_timeout');
        },
        DEFAULT_RESPONSE_START_TIMEOUT_MS,
      );
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const absoluteTimer = setTimeout(() => {
        abortWithTimeout('absolute_timeout');
      }, DEFAULT_ABSOLUTE_TIMEOUT_MS);
      const resetIdleTimer = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          abortWithTimeout('stream_idle_timeout');
        }, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      };

      try {
        const result = await this.runContainer(
          group,
          {
            prompt: renderPromptTranscript(prompt.messages),
            model: context.modelId,
            toolProfile: 'web_talk',
            groupFolder: this.groupFolder,
            chatJid: `talk:${context.input.talkId}`,
            isMain: false,
            assistantName: context.agentNickname,
            secrets: settingsService.getExecutorSecrets(),
          },
          (proc) => {
            processRef = proc;
            if (signal.aborted && !proc.killed) {
              proc.kill('SIGTERM');
            }
          },
          async (streamOutput: ContainerOutput) => {
            if (!streamOutput.result) return;
            if (!sawFirstChunk) {
              sawFirstChunk = true;
              if (responseStartTimer) {
                clearTimeout(responseStartTimer);
                responseStartTimer = null;
              }
            }
            resetIdleTimer();
            chunks.push(streamOutput.result);
            emit?.({
              type: 'talk_response_delta',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              agentNickname: context.agentNickname,
              deltaText: streamOutput.result,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          },
        );

        if (signal.aborted) {
          throw abortError(signal.reason);
        }
        if (timeoutController.signal.aborted) {
          const timeoutMessage = getClaudeTimeoutMessage(
            timeoutController.signal.reason,
          );
          throw new TalkExecutorError(
            String(timeoutController.signal.reason || 'provider_timeout'),
            timeoutMessage,
            { sourceMessage: timeoutMessage },
          );
        }

        if (result.status === 'error') {
          throw new TalkExecutorError(
            'executor_container_error',
            'Claude execution failed.',
            {
              sourceMessage:
                result.error || 'Claude container execution failed.',
            },
          );
        }

        if (chunks.length === 0 && result.result?.trim()) {
          chunks.push(result.result);
          emit?.({
            type: 'talk_response_delta',
            runId: context.input.runId,
            talkId: context.input.talkId,
            agentId: context.agentId,
            agentNickname: context.agentNickname,
            deltaText: result.result,
            routeStepPosition: context.routeStepPosition,
            providerId: context.providerId,
            modelId: context.modelId,
          });
        }

        const content =
          chunks.join('').trim() ||
          result.result?.trim() ||
          'No response generated.';
        createLlmAttempt({
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          routeId: context.routeId,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
          status: 'success',
          latencyMs: Date.now() - startedAt,
          inputTokens: prompt.estimatedInputTokens,
          outputTokens: null,
          estimatedCostUsd: null,
        });
        emit?.({
          type: 'talk_response_completed',
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          agentNickname: context.agentNickname,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
        });
        return {
          content,
          metadataJson: JSON.stringify({
            agentId: context.agentId,
            agentNickname: context.agentNickname,
            personaRole,
            routeId: context.routeId,
            providerId: context.providerId,
            modelId: context.modelId,
            sourceKind: 'claude_default',
          }),
          agentId: context.agentId,
          agentNickname: context.agentNickname,
          providerId: context.providerId,
          modelId: context.modelId,
        };
      } finally {
        signal.removeEventListener('abort', onParentAbort);
        timeoutController.signal.removeEventListener('abort', onAbort);
        if (responseStartTimer) clearTimeout(responseStartTimer);
        if (idleTimer) clearTimeout(idleTimer);
        clearTimeout(absoluteTimer);
      }
    } catch (error) {
      if (signal.aborted) {
        createLlmAttempt({
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          routeId: context.routeId,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
          status: 'cancelled',
          latencyMs: Date.now() - startedAt,
        });
        throw abortError(signal.reason);
      }
      if (
        error instanceof TalkExecutorError &&
        (error.code === 'response_start_timeout' ||
          error.code === 'stream_idle_timeout' ||
          error.code === 'absolute_timeout')
      ) {
        createLlmAttempt({
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          routeId: context.routeId,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
          status: 'failed',
          failureClass: 'timeout',
          latencyMs: Date.now() - startedAt,
        });
        emit?.({
          type: 'talk_response_failed',
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
          errorCode: error.code,
          errorMessage: error.sourceMessage,
        });
        throw error;
      }

      const classified = classifyClaudeDefaultFailure(error);
      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'failed',
        failureClass: classified.failureClass,
        latencyMs: Date.now() - startedAt,
      });
      emit?.({
        type: 'talk_response_failed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        errorCode: classified.code,
        errorMessage: classified.message,
      });
      throw new TalkExecutorError(classified.code, classified.message, {
        sourceMessage: classified.message,
      });
    }
  }

  private async executeClaudeDefaultWithTools(
    context: AttemptContext,
    talkTitle: string | null,
    personaRole: TalkPersonaRole,
    modelContextWindowTokens: number,
    maxOutputTokens: number,
    connectorToolContext: ConnectorToolContext,
    signal: AbortSignal,
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput> {
    const settingsService = getActiveExecutorSettingsService();
    const blockedReason = settingsService.getExecutionBlockedReason();
    if (blockedReason) {
      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'failed',
        failureClass: 'configuration',
      });
      emit?.({
        type: 'talk_response_failed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        errorCode: 'executor_not_configured',
        errorMessage: blockedReason,
      });
      throw new TalkExecutorError('executor_not_configured', blockedReason);
    }

    const verificationTarget = settingsService.getVerificationTarget();
    const hasRealConnectorTools =
      connectorToolContext.toolDefinitions.length > 0;
    if (
      hasRealConnectorTools &&
      (!verificationTarget || verificationTarget.mode === 'subscription')
    ) {
      const message =
        'Attached data connectors require Anthropic API key or advanced bearer auth. Update the Executor auth mode in Settings.';
      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'failed',
        failureClass: 'configuration',
      });
      emit?.({
        type: 'talk_response_failed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        errorCode: 'connector_auth_mode_unsupported',
        errorMessage: message,
      });
      throw new TalkExecutorError('connector_auth_mode_unsupported', message);
    }
    const supportedVerificationTarget = verificationTarget;

    const provider: LlmProviderRecord = {
      id: 'provider.anthropic',
      name: 'Anthropic',
      provider_kind: 'anthropic',
      api_format: 'anthropic_messages',
      base_url: supportedVerificationTarget?.anthropicBaseUrl || '',
      auth_scheme:
        supportedVerificationTarget?.mode === 'api_key'
          ? 'x_api_key'
          : 'bearer',
      enabled: 1,
      core_compatibility: 'none',
      response_start_timeout_ms: null,
      stream_idle_timeout_ms: null,
      absolute_timeout_ms: null,
      updated_at: new Date().toISOString(),
      updated_by: null,
    };

    setTalkRunExecutorProfile({
      runId: context.input.runId,
      executorAlias: 'Claude',
      executorModel: context.modelId,
    });

    const startedAt = Date.now();
    try {
      const prompt = assembleTalkPromptContext({
        talkId: context.input.talkId,
        talkTitle,
        currentRunId: context.input.runId,
        currentUserMessageId: context.input.triggerMessageId,
        currentUserMessage: context.input.triggerContent,
        agent: {
          id: context.agentId,
          name: context.agentNickname,
          personaRole,
        },
        modelContextWindowTokens,
        maxOutputTokens,
        toolDefinitions: connectorToolContext.toolDefinitions,
      });

      const result = await this.executeProviderAttempt(
        provider,
        context.modelId,
        maxOutputTokens,
        prompt.messages,
        { apiKey: supportedVerificationTarget?.credential || '' },
        context,
        emit,
        signal,
        connectorToolContext,
      );

      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'success',
        latencyMs: Date.now() - startedAt,
        inputTokens: result.usage?.inputTokens ?? prompt.estimatedInputTokens,
        outputTokens: result.usage?.outputTokens ?? null,
        estimatedCostUsd: result.usage?.estimatedCostUsd ?? null,
      });

      emit?.({
        type: 'talk_response_completed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        agentNickname: context.agentNickname,
        usage: result.usage,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
      });

      return {
        content: result.content,
        metadataJson: JSON.stringify({
          agentId: context.agentId,
          agentNickname: context.agentNickname,
          personaRole,
          routeId: context.routeId,
          providerId: context.providerId,
          modelId: context.modelId,
          sourceKind: 'claude_default',
        }),
        agentId: context.agentId,
        agentNickname: context.agentNickname,
        providerId: context.providerId,
        modelId: context.modelId,
        usage: result.usage,
        responseSequenceInRun: result.responseSequenceInRun,
      };
    } catch (error) {
      if (signal.aborted) {
        createLlmAttempt({
          runId: context.input.runId,
          talkId: context.input.talkId,
          agentId: context.agentId,
          routeId: context.routeId,
          routeStepPosition: context.routeStepPosition,
          providerId: context.providerId,
          modelId: context.modelId,
          status: 'cancelled',
          latencyMs: Date.now() - startedAt,
        });
        throw abortError(signal.reason);
      }

      const classified = classifyProviderFailure(error);
      createLlmAttempt({
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeId: context.routeId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        status: 'failed',
        failureClass: classified.failureClass,
        latencyMs: Date.now() - startedAt,
      });
      emit?.({
        type: 'talk_response_failed',
        runId: context.input.runId,
        talkId: context.input.talkId,
        agentId: context.agentId,
        routeStepPosition: context.routeStepPosition,
        providerId: context.providerId,
        modelId: context.modelId,
        errorCode: classified.code,
        errorMessage: classified.message,
      });
      throw new TalkExecutorError(classified.code, classified.message, {
        sourceMessage: classified.message,
      });
    }
  }

  private async executeToolBatch(
    context: AttemptContext,
    connectorToolContext: ConnectorToolContext,
    toolCalls: NormalizedToolCall[],
    sequenceInRun: number,
    signal: AbortSignal,
  ): Promise<{
    sequenceInRun: number;
    results: Array<{
      toolCall: NormalizedToolCall;
      content: string;
      isError: boolean;
    }>;
  }> {
    if (toolCalls.length === 0) {
      return { sequenceInRun, results: [] };
    }

    let nextSequence = sequenceInRun + 1;
    appendRuntimeTalkMessage({
      id: `msg_${randomUUID()}`,
      talkId: context.input.talkId,
      runId: context.input.runId,
      role: 'assistant',
      content: summarizeToolNames(toolCalls),
      metadataJson: buildAssistantToolUseMetadata({
        agentId: context.agentId,
        agentNickname: context.agentNickname,
        toolCalls,
        displaySummary: summarizeToolNames(toolCalls),
      }),
      sequenceInRun: nextSequence,
    });

    const results: Array<{
      toolCall: NormalizedToolCall;
      content: string;
      isError: boolean;
    }> = [];

    for (const toolCall of toolCalls) {
      const parsedToolName = parseConnectorToolName(toolCall.name);
      const connector = parsedToolName
        ? connectorToolContext.connectorsById.get(parsedToolName.connectorId)
        : null;
      const execution: {
        content: string;
        isError: boolean;
        displaySummary: string;
      } = connector
        ? await executeConnectorTool(toolCall.name, toolCall.input, {
            connector,
            signal,
            fetchImpl: this.fetchImpl,
          })
        : {
            content: `Attached connector not found for tool ${toolCall.name}.`,
            isError: true,
            displaySummary: `Tool ${toolCall.name} failed`,
          };
      nextSequence += 1;
      appendRuntimeTalkMessage({
        id: `msg_${randomUUID()}`,
        talkId: context.input.talkId,
        runId: context.input.runId,
        role: 'tool',
        content: execution.content,
        metadataJson: buildToolResultMetadata({
          agentId: context.agentId,
          agentNickname: context.agentNickname,
          toolName: toolCall.name,
          toolCallId: toolCall.id,
          displaySummary: execution.displaySummary,
          isError: execution.isError,
        }),
        sequenceInRun: nextSequence,
      });
      results.push({
        toolCall,
        content: execution.content,
        isError: execution.isError,
      });
    }

    return {
      sequenceInRun: nextSequence,
      results,
    };
  }

  private async executeToolLoop(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
    connectorToolContext: ConnectorToolContext,
  ): Promise<StreamAttemptResult> {
    switch (provider.api_format) {
      case 'anthropic_messages':
        return this.executeAnthropicToolLoop(
          provider,
          modelId,
          maxOutputTokens,
          promptMessages,
          secret,
          context,
          emit,
          signal,
          connectorToolContext,
        );
      case 'openai_chat_completions':
        return this.executeOpenAiToolLoop(
          provider,
          modelId,
          maxOutputTokens,
          promptMessages,
          secret,
          context,
          emit,
          signal,
          connectorToolContext,
        );
      default:
        throw new TalkExecutorError(
          'unsupported_provider_format',
          `Unsupported provider API format: ${provider.api_format}`,
        );
    }
  }

  private async executeAnthropicToolLoop(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
    connectorToolContext: ConnectorToolContext,
  ): Promise<StreamAttemptResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || 'aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const { system, messages } = buildAnthropicMessages(promptMessages);
      const toolDefinitions = buildAnthropicToolDefinitions(
        connectorToolContext.toolDefinitions,
      );
      const conversation = messages.map(
        (message): AnthropicConversationMessage => ({
          role: message.role,
          content: message.content,
        }),
      );
      let totalUsage: TalkExecutionUsage | undefined;
      let sequenceInRun = 0;

      for (let iteration = 0; iteration < 10; iteration += 1) {
        const response = await this.fetchImpl(
          joinUrl(provider.base_url, '/v1/messages'),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'anthropic-version': '2023-06-01',
              ...buildAuthHeaders(provider, secret),
            },
            body: JSON.stringify({
              model: modelId,
              max_tokens: maxOutputTokens,
              system,
              messages: conversation,
              tools: toolDefinitions,
              stream: true,
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const failure = classifyHttpFailure(
            await parseErrorResponse(response),
          );
          throw new TalkExecutorError(failure.code, failure.message);
        }

        let usage: TalkExecutionUsage | undefined;
        const blocks: Array<
          | { type: 'text'; text: string }
          | { type: 'tool_use'; id: string; name: string; inputJson: string }
        > = [];
        let currentBlockIndex = -1;
        let sawToolUse = false;

        await readSseResponse(
          response,
          controller,
          signal,
          buildTimeoutConfig(provider),
          async (event) => {
            if (event.data === '[DONE]' || event.event === 'ping') return;

            const payload = JSON.parse(event.data) as Record<string, unknown>;
            if (payload.type === 'content_block_start') {
              const block =
                typeof payload.content_block === 'object' &&
                payload.content_block
                  ? (payload.content_block as Record<string, unknown>)
                  : null;
              if (block?.type === 'text') {
                blocks.push({
                  type: 'text',
                  text:
                    typeof block.text === 'string' ? String(block.text) : '',
                });
                currentBlockIndex = blocks.length - 1;
              } else if (block?.type === 'tool_use') {
                blocks.push({
                  type: 'tool_use',
                  id:
                    typeof block.id === 'string'
                      ? String(block.id)
                      : randomUUID(),
                  name:
                    typeof block.name === 'string'
                      ? String(block.name)
                      : 'unknown_tool',
                  inputJson: '',
                });
                currentBlockIndex = blocks.length - 1;
              }
              return;
            }

            if (
              payload.type === 'content_block_delta' &&
              currentBlockIndex >= 0
            ) {
              const currentBlock = blocks[currentBlockIndex];
              const delta =
                typeof payload.delta === 'object' && payload.delta
                  ? (payload.delta as Record<string, unknown>)
                  : null;
              if (
                currentBlock.type === 'text' &&
                typeof delta?.text === 'string'
              ) {
                currentBlock.text += delta.text;
                return;
              }
              if (
                currentBlock.type === 'tool_use' &&
                typeof delta?.partial_json === 'string'
              ) {
                currentBlock.inputJson += delta.partial_json;
                return;
              }
            }

            if (
              (payload.type === 'message_start' ||
                payload.type === 'message_delta') &&
              typeof payload.message === 'object' &&
              payload.message &&
              'usage' in payload.message
            ) {
              const rawUsage = (
                payload.message as {
                  usage?: { input_tokens?: number; output_tokens?: number };
                }
              ).usage;
              usage = {
                inputTokens: rawUsage?.input_tokens ?? usage?.inputTokens,
                outputTokens: rawUsage?.output_tokens ?? usage?.outputTokens,
              };
            }

            if (
              payload.type === 'message_delta' &&
              typeof payload.delta === 'object' &&
              payload.delta &&
              'stop_reason' in payload.delta
            ) {
              sawToolUse =
                (payload.delta as { stop_reason?: unknown }).stop_reason ===
                'tool_use';
              return;
            }

            if (payload.type === 'error') {
              const message =
                typeof payload.error === 'object' &&
                payload.error &&
                'message' in payload.error &&
                typeof (payload.error as { message?: unknown }).message ===
                  'string'
                  ? String((payload.error as { message: string }).message)
                  : 'Anthropic streaming request failed.';
              throw new TalkExecutorError('provider_request_failed', message);
            }
          },
        );

        const anthropicBlocks = blocks.map((block): AnthropicContentBlock => {
          if (block.type === 'text') {
            return { type: 'text', text: block.text };
          }

          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.inputJson ? JSON.parse(block.inputJson) : {},
          };
        });
        const text = blocks
          .filter(
            (block): block is Extract<typeof block, { type: 'text' }> =>
              block.type === 'text',
          )
          .map((block) => block.text)
          .join('');
        const toolCalls = anthropicBlocks
          .filter(
            (
              block,
            ): block is Extract<AnthropicContentBlock, { type: 'tool_use' }> =>
              block.type === 'tool_use',
          )
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: block.input,
          }));

        totalUsage = mergeUsageTotals(totalUsage, usage);

        if (sawToolUse && toolCalls.length > 0) {
          const toolBatch = await this.executeToolBatch(
            context,
            connectorToolContext,
            toolCalls,
            sequenceInRun,
            signal,
          );
          sequenceInRun = toolBatch.sequenceInRun;
          conversation.push({
            role: 'assistant',
            content: anthropicBlocks,
          });
          conversation.push({
            role: 'user',
            content: toolBatch.results.map(
              (result): AnthropicContentBlock => ({
                type: 'tool_result',
                tool_use_id: result.toolCall.id,
                content: result.content,
                is_error: result.isError || undefined,
              }),
            ),
          });
          continue;
        }

        const content = text.trim() || 'No response generated.';
        const result: StreamAttemptResult = {
          content,
          usage: totalUsage,
          responseSequenceInRun: sequenceInRun + 1,
        };
        this.emitBufferedTerminalResponse(context, emit, result);
        return result;
      }

      const result: StreamAttemptResult = {
        content:
          'No final answer was produced before the connector tool loop reached its limit.',
        usage: totalUsage,
        responseSequenceInRun: sequenceInRun + 1,
      };
      this.emitBufferedTerminalResponse(context, emit, result);
      return result;
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if (controller.signal.aborted && !signal.aborted) {
        throw new TalkExecutorError(
          String(controller.signal.reason || 'provider_timeout'),
          'Anthropic request timed out.',
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async executeOpenAiToolLoop(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
    connectorToolContext: ConnectorToolContext,
  ): Promise<StreamAttemptResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || 'aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const conversation: OpenAiConversationMessage[] =
        buildOpenAiMessages(promptMessages);
      const toolDefinitions = buildOpenAiToolDefinitions(
        connectorToolContext.toolDefinitions,
      );
      let totalUsage: TalkExecutionUsage | undefined;
      let sequenceInRun = 0;

      for (let iteration = 0; iteration < 10; iteration += 1) {
        const response = await this.fetchImpl(
          joinUrl(provider.base_url, '/chat/completions'),
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...buildAuthHeaders(provider, secret),
            },
            body: JSON.stringify({
              model: modelId,
              max_tokens: maxOutputTokens,
              stream: true,
              stream_options: { include_usage: true },
              tools: toolDefinitions,
              messages: conversation,
            }),
            signal: controller.signal,
          },
        );

        if (!response.ok) {
          const failure = classifyHttpFailure(
            await parseErrorResponse(response),
          );
          throw new TalkExecutorError(failure.code, failure.message);
        }

        let usage: TalkExecutionUsage | undefined;
        let content = '';
        const toolCallsByIndex = new Map<
          number,
          {
            id: string;
            name: string;
            argumentsJson: string;
          }
        >();
        let sawToolCalls = false;

        await readSseResponse(
          response,
          controller,
          signal,
          buildTimeoutConfig(provider),
          async (event) => {
            if (!event.data || event.data === '[DONE]') return;

            const payload = JSON.parse(event.data) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
                finish_reason?: string | null;
              }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
              error?: { message?: string };
            };

            if (payload.error?.message) {
              throw new TalkExecutorError(
                'provider_request_failed',
                payload.error.message,
              );
            }

            const choice = payload.choices?.[0];
            const deltaText = choice?.delta?.content || '';
            if (deltaText) {
              content += deltaText;
            }

            for (const toolDelta of choice?.delta?.tool_calls || []) {
              const index = Number.isFinite(toolDelta.index)
                ? Number(toolDelta.index)
                : 0;
              const current = toolCallsByIndex.get(index) || {
                id: toolDelta.id || randomUUID(),
                name: '',
                argumentsJson: '',
              };
              if (toolDelta.id) {
                current.id = toolDelta.id;
              }
              if (toolDelta.function?.name) {
                current.name = toolDelta.function.name;
              }
              if (toolDelta.function?.arguments) {
                current.argumentsJson += toolDelta.function.arguments;
              }
              sawToolCalls = true;
              toolCallsByIndex.set(index, current);
            }

            if (payload.usage) {
              usage = {
                inputTokens: payload.usage.prompt_tokens,
                outputTokens: payload.usage.completion_tokens,
              };
            }
          },
        );

        const toolCalls = Array.from(toolCallsByIndex.values())
          .filter((toolCall) => Boolean(toolCall.name))
          .map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.argumentsJson
              ? JSON.parse(toolCall.argumentsJson)
              : {},
          }));

        totalUsage = mergeUsageTotals(totalUsage, usage);

        if (sawToolCalls && toolCalls.length > 0) {
          const toolBatch = await this.executeToolBatch(
            context,
            connectorToolContext,
            toolCalls,
            sequenceInRun,
            signal,
          );
          sequenceInRun = toolBatch.sequenceInRun;
          conversation.push({
            role: 'assistant',
            content: content || null,
            tool_calls: toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function',
              function: {
                name: toolCall.name,
                arguments: JSON.stringify(toolCall.input),
              },
            })),
          });
          for (const result of toolBatch.results) {
            conversation.push({
              role: 'tool',
              tool_call_id: result.toolCall.id,
              content: result.content,
            });
          }
          continue;
        }

        const result: StreamAttemptResult = {
          content: content.trim() || 'No response generated.',
          usage: totalUsage,
          responseSequenceInRun: sequenceInRun + 1,
        };
        this.emitBufferedTerminalResponse(context, emit, result);
        return result;
      }

      const result: StreamAttemptResult = {
        content:
          'No final answer was produced before the connector tool loop reached its limit.',
        usage: totalUsage,
        responseSequenceInRun: sequenceInRun + 1,
      };
      this.emitBufferedTerminalResponse(context, emit, result);
      return result;
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if (controller.signal.aborted && !signal.aborted) {
        throw new TalkExecutorError(
          String(controller.signal.reason || 'provider_timeout'),
          'OpenAI-compatible request timed out.',
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async executeProviderAttempt(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
    connectorToolContext?: ConnectorToolContext,
  ): Promise<StreamAttemptResult> {
    if (
      connectorToolContext &&
      connectorToolContext.toolDefinitions.length > 0
    ) {
      return this.executeToolLoop(
        provider,
        modelId,
        maxOutputTokens,
        promptMessages,
        secret,
        context,
        emit,
        signal,
        connectorToolContext,
      );
    }

    switch (provider.api_format) {
      case 'anthropic_messages':
        return this.executeAnthropicAttempt(
          provider,
          modelId,
          maxOutputTokens,
          promptMessages,
          secret,
          context,
          emit,
          signal,
        );
      case 'openai_chat_completions':
        return this.executeOpenAiAttempt(
          provider,
          modelId,
          maxOutputTokens,
          promptMessages,
          secret,
          context,
          emit,
          signal,
        );
      default:
        throw new TalkExecutorError(
          'unsupported_provider_format',
          `Unsupported provider API format: ${provider.api_format}`,
        );
    }
  }

  private async executeAnthropicAttempt(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || 'aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const { system, messages } = buildAnthropicMessages(promptMessages);
      const response = await this.fetchImpl(
        joinUrl(provider.base_url, '/v1/messages'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...buildAuthHeaders(provider, secret),
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: maxOutputTokens,
            system,
            messages,
            stream: true,
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const failure = classifyHttpFailure(await parseErrorResponse(response));
        throw new TalkExecutorError(failure.code, failure.message);
      }

      let started = false;
      let content = '';
      let usage: TalkExecutionUsage | undefined;

      await readSseResponse(
        response,
        controller,
        signal,
        buildTimeoutConfig(provider),
        async (event) => {
          if (event.data === '[DONE]' || event.event === 'ping') return;

          const payload = JSON.parse(event.data) as Record<string, unknown>;
          if (!started) {
            started = true;
            emit?.({
              type: 'talk_response_started',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              agentNickname: context.agentNickname,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          }

          if (payload.type === 'content_block_delta') {
            const deltaText =
              typeof payload.delta === 'object' &&
              payload.delta &&
              'text' in payload.delta &&
              typeof (payload.delta as { text?: unknown }).text === 'string'
                ? String((payload.delta as { text: string }).text)
                : '';
            if (!deltaText) return;
            content += deltaText;
            emit?.({
              type: 'talk_response_delta',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              agentNickname: context.agentNickname,
              deltaText,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
            return;
          }

          if (
            (payload.type === 'message_start' ||
              payload.type === 'message_delta') &&
            typeof payload.message === 'object' &&
            payload.message &&
            'usage' in payload.message
          ) {
            const rawUsage = (
              payload.message as {
                usage?: { input_tokens?: number; output_tokens?: number };
              }
            ).usage;
            usage = {
              inputTokens: rawUsage?.input_tokens ?? usage?.inputTokens,
              outputTokens: rawUsage?.output_tokens ?? usage?.outputTokens,
            };
            emit?.({
              type: 'talk_response_usage',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              usage,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          }

          if (payload.type === 'error') {
            const message =
              typeof payload.error === 'object' &&
              payload.error &&
              'message' in payload.error &&
              typeof (payload.error as { message?: unknown }).message ===
                'string'
                ? String((payload.error as { message: string }).message)
                : 'Anthropic streaming request failed.';
            throw new TalkExecutorError('provider_request_failed', message);
          }
        },
      );

      return { content, usage };
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if (controller.signal.aborted && !signal.aborted) {
        throw new TalkExecutorError(
          String(controller.signal.reason || 'provider_timeout'),
          'Anthropic request timed out.',
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async executeOpenAiAttempt(
    provider: LlmProviderRecord,
    modelId: string,
    maxOutputTokens: number,
    promptMessages: PromptMessage[],
    secret: ProviderSecretPayload,
    context: AttemptContext,
    emit: ((event: TalkExecutionEvent) => void) | undefined,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason || 'aborted');
    signal.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await this.fetchImpl(
        joinUrl(provider.base_url, '/chat/completions'),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...buildAuthHeaders(provider, secret),
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: maxOutputTokens,
            stream: true,
            stream_options: { include_usage: true },
            messages: buildOpenAiMessages(promptMessages),
          }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const failure = classifyHttpFailure(await parseErrorResponse(response));
        throw new TalkExecutorError(failure.code, failure.message);
      }

      let started = false;
      let content = '';
      let usage: TalkExecutionUsage | undefined;

      await readSseResponse(
        response,
        controller,
        signal,
        buildTimeoutConfig(provider),
        async (event) => {
          if (!event.data || event.data === '[DONE]') return;

          const payload = JSON.parse(event.data) as {
            choices?: Array<{
              delta?: { content?: string };
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
            };
            error?: { message?: string };
          };

          if (payload.error?.message) {
            throw new TalkExecutorError(
              'provider_request_failed',
              payload.error.message,
            );
          }

          if (!started) {
            started = true;
            emit?.({
              type: 'talk_response_started',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              agentNickname: context.agentNickname,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          }

          const deltaText = payload.choices?.[0]?.delta?.content || '';
          if (deltaText) {
            content += deltaText;
            emit?.({
              type: 'talk_response_delta',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              agentNickname: context.agentNickname,
              deltaText,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          }

          if (payload.usage) {
            usage = {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
            };
            emit?.({
              type: 'talk_response_usage',
              runId: context.input.runId,
              talkId: context.input.talkId,
              agentId: context.agentId,
              usage,
              routeStepPosition: context.routeStepPosition,
              providerId: context.providerId,
              modelId: context.modelId,
            });
          }
        },
      );

      return { content, usage };
    } catch (error) {
      if (signal.aborted) throw abortError(signal.reason);
      if (controller.signal.aborted && !signal.aborted) {
        throw new TalkExecutorError(
          String(controller.signal.reason || 'provider_timeout'),
          'OpenAI-compatible request timed out.',
        );
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
