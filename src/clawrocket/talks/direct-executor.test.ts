import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'child_process';

import {
  _initTestDatabase,
  attachDataConnectorToTalk,
  createDataConnector,
  createTalkResourceBinding,
  createTalk,
  createTalkMessage,
  createTalkRun,
  enqueueTalkTurnAtomic as enqueueTalkTurnAtomicRaw,
  getProviderSecretByProviderId,
  getTalkRunById,
  listLlmAttemptsForRun,
  listTalkMessages,
  patchDataConnectorDiscovery,
  listTalkLlmSettingsSnapshot,
  replaceTalkToolGrants,
  replaceTalkAgents,
  replaceTalkLlmSettingsSnapshot,
  resetTalkAgentsToDefault,
  setDataConnectorCredential,
  upsertUserGoogleCredential,
  upsertDataConnectorVerification,
  upsertUser,
} from '../db/index.js';
import { encryptConnectorSecret } from '../connectors/connector-secret-store.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';

import { DirectTalkExecutor } from './direct-executor.js';
import type { TalkExecutionEvent } from './executor.js';
import {
  _resetActiveExecutorSettingsServiceForTests,
  ExecutorSettingsService,
  setActiveExecutorSettingsService,
} from './executor-settings.js';
import type { ContainerOutput } from '../../container-runner.js';

const OWNER_ID = 'owner-1';
const TALK_ID = 'talk-1';

function seedTalk(): void {
  upsertUser({
    id: OWNER_ID,
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
  });
  createTalk({
    id: TALK_ID,
    ownerId: OWNER_ID,
    topicTitle: 'Direct Executor Test Talk',
  });
}

function configureTalkRuntime(input: {
  providers: Array<{
    id: string;
    name: string;
    providerKind:
      | 'anthropic'
      | 'openai'
      | 'gemini'
      | 'deepseek'
      | 'kimi'
      | 'nvidia'
      | 'custom';
    apiFormat: 'anthropic_messages' | 'openai_chat_completions';
    baseUrl: string;
    authScheme: 'x_api_key' | 'bearer';
    enabled: boolean;
    coreCompatibility: 'none' | 'claude_sdk_proxy';
    responseStartTimeoutMs?: number | null;
    streamIdleTimeoutMs?: number | null;
    absoluteTimeoutMs?: number | null;
    models: Array<{
      modelId: string;
      displayName: string;
      contextWindowTokens: number;
      defaultMaxOutputTokens: number;
      enabled: boolean;
      supportsTools?: boolean;
    }>;
    credential?: { apiKey: string; organizationId?: string } | null;
  }>;
  routes: Array<{
    id: string;
    name: string;
    enabled: boolean;
    steps: Array<{ position: number; providerId: string; modelId: string }>;
  }>;
  agentRouteId?: string;
  agentName?: string;
}): void {
  const routeId = input.agentRouteId || input.routes[0]?.id || 'route.primary';
  const selectedRoute =
    input.routes.find((route) => route.id === routeId) || input.routes[0];
  const selectedStep = selectedRoute?.steps[0];
  replaceTalkLlmSettingsSnapshot({
    defaultRouteId: routeId,
    providers: input.providers,
    routes: input.routes,
  });
  replaceTalkAgents(TALK_ID, [
    {
      name: input.agentName || 'Primary Agent',
      sourceKind: 'provider',
      personaRole: 'assistant',
      routeId,
      providerId: selectedStep?.providerId || null,
      modelId: selectedStep?.modelId || null,
      isPrimary: true,
      sortOrder: 0,
    },
  ]);
}

function createCompletedTurn(
  runId: string,
  userText: string,
  assistantText: string,
  createdAt: string,
): void {
  const userMessageId = `${runId}-user`;
  createTalkMessage({
    id: userMessageId,
    talkId: TALK_ID,
    role: 'user',
    content: userText,
    createdBy: OWNER_ID,
    createdAt,
  });
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    requested_by: OWNER_ID,
    status: 'completed',
    trigger_message_id: userMessageId,
    target_agent_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: createdAt,
    started_at: createdAt,
    ended_at: createdAt,
    cancel_reason: null,
  });
  createTalkMessage({
    id: `${runId}-assistant`,
    talkId: TALK_ID,
    role: 'assistant',
    content: assistantText,
    createdBy: null,
    runId,
    createdAt: new Date(new Date(createdAt).getTime() + 1_000).toISOString(),
  });
}

function createOrphanUserTurn(
  runId: string,
  userText: string,
  createdAt: string,
): void {
  const userMessageId = `${runId}-user`;
  createTalkMessage({
    id: userMessageId,
    talkId: TALK_ID,
    role: 'user',
    content: userText,
    createdBy: OWNER_ID,
    createdAt,
  });
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    requested_by: OWNER_ID,
    status: 'failed',
    trigger_message_id: userMessageId,
    target_agent_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: createdAt,
    started_at: createdAt,
    ended_at: createdAt,
    cancel_reason: 'failed',
  });
}

function attachVerifiedPostHogConnector(input?: {
  name?: string;
  hostUrl?: string;
  projectId?: string;
  discovered?: {
    projectName?: string | null;
    eventNames?: string[];
  };
}): string {
  const connector = createDataConnector({
    name: input?.name || 'FTUE PostHog',
    connectorKind: 'posthog',
    config: {
      hostUrl: input?.hostUrl || 'https://posthog.example.test',
      projectId: input?.projectId || '12345',
    },
    createdBy: OWNER_ID,
  });

  setDataConnectorCredential({
    connectorId: connector.id,
    ciphertext: encryptConnectorSecret({
      kind: 'posthog',
      apiKey: 'phc_test_key',
    }),
    updatedBy: OWNER_ID,
  });
  patchDataConnectorDiscovery(connector.id, {
    projectId: input?.projectId || '12345',
    projectName: input?.discovered?.projectName || 'FTUE',
    eventNames: input?.discovered?.eventNames || [
      'session_started',
      'ftue_step_viewed',
    ],
  });
  upsertDataConnectorVerification({
    connectorId: connector.id,
    status: 'verified',
    lastError: null,
    lastVerifiedAt: '2024-01-01T00:00:00.000Z',
  });
  attachDataConnectorToTalk({
    talkId: TALK_ID,
    connectorId: connector.id,
    userId: OWNER_ID,
  });

  return connector.id;
}

function chunkString(value: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += chunkSize) {
    chunks.push(value.slice(index, index + chunkSize));
  }
  return chunks;
}

function createStreamingResponse(
  signal: AbortSignal | null | undefined,
  chunks: string[],
  delayMs = 0,
): Response {
  const encoder = new TextEncoder();

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        let cancelled = false;
        const onAbort = () => {
          cancelled = true;
          controller.error(new Error('aborted'));
        };

        signal?.addEventListener('abort', onAbort, { once: true });

        const emitChunk = (index: number) => {
          if (cancelled) return;
          if (index >= chunks.length) {
            signal?.removeEventListener('abort', onAbort);
            controller.close();
            return;
          }

          controller.enqueue(encoder.encode(chunks[index]));
          if (delayMs > 0) {
            setTimeout(() => emitChunk(index + 1), delayMs);
            return;
          }

          queueMicrotask(() => emitChunk(index + 1));
        };

        emitChunk(0);
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  );
}

function createNeverStartingResponse(
  signal: AbortSignal | null | undefined,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = () => {
          controller.error(new Error('aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
      },
    },
  );
}

function enqueueTalkTurnAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  targetAgentId?: string;
  idempotencyKey?: string | null;
  now?: string;
}) {
  return enqueueTalkTurnAtomicRaw({
    talkId: input.talkId,
    userId: input.userId,
    content: input.content,
    messageId: input.messageId,
    runIds: [input.runId],
    targetAgentIds: [input.targetAgentId || 'agent-default'],
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
}

describe('DirectTalkExecutor', () => {
  beforeEach(() => {
    _initTestDatabase();
    seedTalk();
    _resetActiveExecutorSettingsServiceForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetActiveExecutorSettingsServiceForTests();
  });

  it('stores encrypted provider secrets when replacing the Talk LLM settings snapshot', () => {
    configureTalkRuntime({
      providers: [
        {
          id: 'anthropic.primary',
          name: 'Anthropic Primary',
          providerKind: 'anthropic',
          apiFormat: 'anthropic_messages',
          baseUrl: 'https://anthropic.example.test',
          authScheme: 'x_api_key',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'claude-test',
              displayName: 'Claude Test',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
              supportsTools: true,
            },
          ],
          credential: { apiKey: 'sk-ant-test', organizationId: 'org-test' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'anthropic.primary',
              modelId: 'claude-test',
            },
          ],
        },
      ],
    });

    const secretRecord = getProviderSecretByProviderId('anthropic.primary');
    expect(secretRecord).toBeDefined();
    expect(decryptProviderSecret(secretRecord!.ciphertext)).toEqual({
      apiKey: 'sk-ant-test',
      organizationId: 'org-test',
    });

    const snapshot = listTalkLlmSettingsSnapshot();
    const provider = snapshot.providers.find(
      (entry) => entry.id === 'anthropic.primary',
    );
    expect(provider?.hasCredential).toBe(true);
    expect('credential' in (provider || {})).toBe(false);
  });

  it('streams Anthropic SSE across split chunks, merges usage, and replays only complete historical turns', async () => {
    configureTalkRuntime({
      providers: [
        {
          id: 'anthropic.primary',
          name: 'Anthropic Primary',
          providerKind: 'anthropic',
          apiFormat: 'anthropic_messages',
          baseUrl: 'https://anthropic.example.test',
          authScheme: 'x_api_key',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'claude-test',
              displayName: 'Claude Test',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
            },
          ],
          credential: { apiKey: 'sk-ant-test' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'anthropic.primary',
              modelId: 'claude-test',
            },
          ],
        },
      ],
    });

    createCompletedTurn(
      'run-old',
      'What happened yesterday?',
      'We reviewed the launch checklist.',
      '2024-01-01T00:00:00.000Z',
    );
    createOrphanUserTurn(
      'run-orphan',
      'This incomplete question should be dropped.',
      '2024-01-01T00:10:00.000Z',
    );

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Give me the next step.',
      messageId: 'msg-current',
      runId: 'run-current',
      now: '2024-01-01T00:20:00.000Z',
    });

    let capturedBody: any = null;
    const rawStream = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
      'data: {"type":"message_delta","message":{"usage":{"output_tokens":5}}}\n\n',
    ].join('');

    const executor = new DirectTalkExecutor({
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return createStreamingResponse(
          init?.signal,
          chunkString(rawStream, 17),
        );
      },
    });

    const events: TalkExecutionEvent[] = [];
    const output = await executor.execute(
      {
        runId: 'run-current',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-current',
        triggerContent: 'Give me the next step.',
      },
      new AbortController().signal,
      (event) => {
        events.push(event);
      },
    );

    expect(output.content).toBe('Hello');
    expect(output.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
    });
    expect(capturedBody.messages).toEqual([
      {
        role: 'user',
        content: 'What happened yesterday?',
      },
      {
        role: 'assistant',
        content: 'We reviewed the launch checklist.',
      },
      {
        role: 'user',
        content: 'Give me the next step.',
      },
    ]);
    expect(JSON.stringify(capturedBody.messages)).not.toContain(
      'This incomplete question should be dropped.',
    );
    expect(events.map((event) => event.type)).toEqual([
      'talk_response_started',
      'talk_response_usage',
      'talk_response_delta',
      'talk_response_delta',
      'talk_response_usage',
      'talk_response_completed',
    ]);
    expect(getTalkRunById('run-current')?.executor_alias).toBe(
      'anthropic.primary',
    );
    expect(getTalkRunById('run-current')?.executor_model).toBe('claude-test');
  });

  it('injects tool-context guidance from Talk grants, bindings, and granted scopes', async () => {
    configureTalkRuntime({
      providers: [
        {
          id: 'anthropic.primary',
          name: 'Anthropic Primary',
          providerKind: 'anthropic',
          apiFormat: 'anthropic_messages',
          baseUrl: 'https://anthropic.example.test',
          authScheme: 'x_api_key',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'claude-test',
              displayName: 'Claude Test',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
              supportsTools: true,
            },
          ],
          credential: { apiKey: 'sk-ant-test' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'anthropic.primary',
              modelId: 'claude-test',
            },
          ],
        },
      ],
    });

    replaceTalkToolGrants({
      talkId: TALK_ID,
      grants: [
        { toolId: 'web_search', enabled: true },
        { toolId: 'google_drive_search', enabled: true },
        { toolId: 'gmail_send', enabled: true },
      ],
      updatedBy: OWNER_ID,
    });
    createTalkResourceBinding({
      talkId: TALK_ID,
      bindingKind: 'google_drive_folder',
      externalId: 'folder-123',
      displayName: 'Accounting',
      createdBy: OWNER_ID,
    });
    upsertUserGoogleCredential({
      userId: OWNER_ID,
      googleSubject: 'google-owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      scopes: ['drive.readonly'],
      ciphertext: 'encrypted-google-credential',
      accessExpiresAt: null,
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Find the cap table and prepare an email draft.',
      messageId: 'msg-tool-context',
      runId: 'run-tool-context',
      now: '2024-01-01T00:20:00.000Z',
    });

    let capturedBody: any = null;
    const rawStream = [
      'event: message_start\n',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"text":"Done"}}\n\n',
      'data: {"type":"message_delta","message":{"usage":{"output_tokens":4}}}\n\n',
    ].join('');

    const executor = new DirectTalkExecutor({
      fetchImpl: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return createStreamingResponse(
          init?.signal,
          chunkString(rawStream, 23),
        );
      },
    });

    await executor.execute(
      {
        runId: 'run-tool-context',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-tool-context',
        triggerContent: 'Find the cap table and prepare an email draft.',
      },
      new AbortController().signal,
      () => {},
    );

    expect(capturedBody.system).toContain('## Tool Context');
    expect(capturedBody.system).toContain(
      'Public web search and fetch are available.',
    );
    expect(capturedBody.system).toContain(
      'You may search within bound Google Drive resources: Accounting.',
    );
    expect(capturedBody.system).toContain(
      'Do not assume access outside bound resources.',
    );
    expect(capturedBody.system).toContain(
      'Some granted Google capabilities still require additional Google permissions before they can be used.',
    );
    expect(capturedBody.system).toContain(
      'Email sends require user approval before execution. Compose them as final drafts.',
    );
  });

  it('falls back to the next route step on retryable quota failures', async () => {
    configureTalkRuntime({
      providers: [
        {
          id: 'openai.primary',
          name: 'OpenAI Primary',
          providerKind: 'openai',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://openai-primary.example.test',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'gpt-primary',
              displayName: 'GPT Primary',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
            },
          ],
          credential: { apiKey: 'sk-openai-primary' },
        },
        {
          id: 'openai.fallback',
          name: 'OpenAI Fallback',
          providerKind: 'openai',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://openai-fallback.example.test',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'gpt-fallback',
              displayName: 'GPT Fallback',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
            },
          ],
          credential: { apiKey: 'sk-openai-fallback' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'openai.primary',
              modelId: 'gpt-primary',
            },
            {
              position: 1,
              providerId: 'openai.fallback',
              modelId: 'gpt-fallback',
            },
          ],
        },
      ],
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Fallback please',
      messageId: 'msg-fallback',
      runId: 'run-fallback',
    });

    const executor = new DirectTalkExecutor({
      fetchImpl: async (url, init) => {
        if (String(url).includes('openai-primary')) {
          return new Response(
            JSON.stringify({
              error: { message: 'insufficient_quota' },
            }),
            {
              status: 429,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        return createStreamingResponse(init?.signal, [
          'data: {"choices":[{"delta":{"content":"Fallback "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"worked"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    });

    const output = await executor.execute(
      {
        runId: 'run-fallback',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-fallback',
        triggerContent: 'Fallback please',
      },
      new AbortController().signal,
    );

    expect(output.content).toBe('Fallback worked');
    expect(getTalkRunById('run-fallback')?.executor_alias).toBe(
      'openai.fallback',
    );
    expect(getTalkRunById('run-fallback')?.executor_model).toBe('gpt-fallback');

    const attempts = listLlmAttemptsForRun('run-fallback');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      provider_id: 'openai.primary',
      model_id: 'gpt-primary',
      status: 'failed',
      failure_class: 'quota_exhausted',
    });
    expect(attempts[1]).toMatchObject({
      provider_id: 'openai.fallback',
      model_id: 'gpt-fallback',
      status: 'success',
    });
  });

  it('falls back after a response-start timeout', async () => {
    configureTalkRuntime({
      providers: [
        {
          id: 'anthropic.slow',
          name: 'Anthropic Slow',
          providerKind: 'anthropic',
          apiFormat: 'anthropic_messages',
          baseUrl: 'https://anthropic-slow.example.test',
          authScheme: 'x_api_key',
          enabled: true,
          coreCompatibility: 'none',
          responseStartTimeoutMs: 5,
          streamIdleTimeoutMs: 5,
          absoluteTimeoutMs: 50,
          models: [
            {
              modelId: 'claude-slow',
              displayName: 'Claude Slow',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
            },
          ],
          credential: { apiKey: 'sk-ant-slow' },
        },
        {
          id: 'openai.fast',
          name: 'OpenAI Fast',
          providerKind: 'openai',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://openai-fast.example.test',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'gpt-fast',
              displayName: 'GPT Fast',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
            },
          ],
          credential: { apiKey: 'sk-openai-fast' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'anthropic.slow',
              modelId: 'claude-slow',
            },
            {
              position: 1,
              providerId: 'openai.fast',
              modelId: 'gpt-fast',
            },
          ],
        },
      ],
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Timeout fallback please',
      messageId: 'msg-timeout',
      runId: 'run-timeout',
    });

    const executor = new DirectTalkExecutor({
      fetchImpl: async (url, init) => {
        if (String(url).includes('anthropic-slow')) {
          return createNeverStartingResponse(init?.signal);
        }

        return createStreamingResponse(init?.signal, [
          'data: {"choices":[{"delta":{"content":"Recovered"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":8,"completion_tokens":2}}\n\n',
          'data: [DONE]\n\n',
        ]);
      },
    });

    const output = await executor.execute(
      {
        runId: 'run-timeout',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-timeout',
        triggerContent: 'Timeout fallback please',
      },
      new AbortController().signal,
    );

    expect(output.content).toBe('Recovered');

    const attempts = listLlmAttemptsForRun('run-timeout');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      provider_id: 'anthropic.slow',
      model_id: 'claude-slow',
      status: 'failed',
      failure_class: 'timeout',
    });
    expect(attempts[1]).toMatchObject({
      provider_id: 'openai.fast',
      model_id: 'gpt-fast',
      status: 'success',
    });
  });

  it('executes an Anthropic tool loop for an attached PostHog connector', async () => {
    const connectorId = attachVerifiedPostHogConnector();
    configureTalkRuntime({
      providers: [
        {
          id: 'anthropic.primary',
          name: 'Anthropic Primary',
          providerKind: 'anthropic',
          apiFormat: 'anthropic_messages',
          baseUrl: 'https://anthropic-tools.example.test',
          authScheme: 'x_api_key',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'claude-tools',
              displayName: 'Claude Tools',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
              supportsTools: true,
            },
          ],
          credential: { apiKey: 'sk-ant-tools' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'anthropic.primary',
              modelId: 'claude-tools',
            },
          ],
        },
      ],
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Check PostHog and tell me the biggest FTUE issue.',
      messageId: 'msg-tools-anthropic',
      runId: 'run-tools-anthropic',
    });

    const providerBodies: any[] = [];
    let anthropicCalls = 0;
    const executor = new DirectTalkExecutor({
      fetchImpl: async (url, init) => {
        const targetUrl = String(url);
        if (targetUrl.includes('/v1/messages')) {
          anthropicCalls += 1;
          providerBodies.push(JSON.parse(String(init?.body)));
          if (anthropicCalls === 1) {
            return createStreamingResponse(init?.signal, [
              'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n',
              `data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"toolu_1","name":"connector_${connectorId}__posthog_query"}}\n\n`,
              'data: {"type":"content_block_delta","delta":{"partial_json":"{\\"query\\":\\"SELECT event, count() AS total FROM events GROUP BY event ORDER BY total DESC\\",\\"dateFrom\\":\\"2024-01-01\\",\\"dateTo\\":\\"2024-01-07\\",\\"limit\\":3}"}}\n\n',
              'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"message":{"usage":{"output_tokens":4}}}\n\n',
              'data: [DONE]\n\n',
            ]);
          }

          return createStreamingResponse(init?.signal, [
            'data: {"type":"message_start","message":{"usage":{"input_tokens":8}}}\n\n',
            'data: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
            'data: {"type":"content_block_delta","delta":{"text":"The biggest FTUE issue is tutorial drop-off."}}\n\n',
            'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"message":{"usage":{"output_tokens":9}}}\n\n',
            'data: [DONE]\n\n',
          ]);
        }

        if (targetUrl.includes('/api/projects/12345/query')) {
          return new Response(
            JSON.stringify({
              results: [
                { event: 'tutorial_started', total: 3200 },
                { event: 'tutorial_completed', total: 1900 },
              ],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${targetUrl}`);
      },
    });

    const events: TalkExecutionEvent[] = [];
    const output = await executor.execute(
      {
        runId: 'run-tools-anthropic',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-tools-anthropic',
        triggerContent: 'Check PostHog and tell me the biggest FTUE issue.',
      },
      new AbortController().signal,
      (event) => {
        events.push(event);
      },
    );

    expect(output.content).toBe('The biggest FTUE issue is tutorial drop-off.');
    expect(output.responseSequenceInRun).toBe(3);
    expect(providerBodies[0].tools).toHaveLength(1);
    expect(providerBodies[0].tools[0].name).toBe(
      `connector_${connectorId}__posthog_query`,
    );
    expect(providerBodies[1].messages.at(-1).content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
    });

    const runtimeMessages = listTalkMessages({ talkId: TALK_ID }).filter(
      (message) => message.run_id === 'run-tools-anthropic',
    );
    expect(runtimeMessages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
    ]);
    expect(runtimeMessages[0].sequence_in_run).toBe(1);
    expect(runtimeMessages[1].sequence_in_run).toBe(2);
    expect(JSON.parse(String(runtimeMessages[0].metadata_json)).kind).toBe(
      'assistant_tool_use',
    );
    expect(JSON.parse(String(runtimeMessages[1].metadata_json)).kind).toBe(
      'tool_result',
    );
    expect(events.map((event) => event.type)).toEqual([
      'talk_response_started',
      'talk_response_delta',
      'talk_response_usage',
      'talk_response_completed',
    ]);
  });

  it('detects OpenAI-compatible tool calls from accumulated tool_call deltas', async () => {
    const connectorId = attachVerifiedPostHogConnector();
    configureTalkRuntime({
      providers: [
        {
          id: 'openai.primary',
          name: 'OpenAI Primary',
          providerKind: 'openai',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://openai-tools.example.test',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'gpt-tools',
              displayName: 'GPT Tools',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
              supportsTools: true,
            },
          ],
          credential: { apiKey: 'sk-openai-tools' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'openai.primary',
              modelId: 'gpt-tools',
            },
          ],
        },
      ],
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Use PostHog to inspect retention.',
      messageId: 'msg-tools-openai',
      runId: 'run-tools-openai',
    });

    let completionCalls = 0;
    const executor = new DirectTalkExecutor({
      fetchImpl: async (url, init) => {
        const targetUrl = String(url);
        if (targetUrl.includes('/chat/completions')) {
          completionCalls += 1;
          if (completionCalls === 1) {
            return createStreamingResponse(init?.signal, [
              `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"connector_${connectorId}__posthog_query","arguments":"{\\"query\\":\\"SELECT count() AS total FROM events\\""}}]}}]}\n\n`,
              'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"type":"function","function":{"arguments":",\\"dateFrom\\":\\"2024-01-01\\",\\"dateTo\\":\\"2024-01-07\\",\\"limit\\":1}"}}]}}]}\n\n',
              'data: {"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n',
              'data: [DONE]\n\n',
            ]);
          }

          return createStreamingResponse(init?.signal, [
            'data: {"choices":[{"delta":{"content":"Retention is weakest after the tutorial."}}]}\n\n',
            'data: {"usage":{"prompt_tokens":10,"completion_tokens":6}}\n\n',
            'data: [DONE]\n\n',
          ]);
        }

        if (targetUrl.includes('/api/projects/12345/query')) {
          return new Response(
            JSON.stringify({
              results: [{ total: 412 }],
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' },
            },
          );
        }

        throw new Error(`Unexpected fetch: ${targetUrl}`);
      },
    });

    const output = await executor.execute(
      {
        runId: 'run-tools-openai',
        talkId: TALK_ID,
        requestedBy: OWNER_ID,
        triggerMessageId: 'msg-tools-openai',
        triggerContent: 'Use PostHog to inspect retention.',
      },
      new AbortController().signal,
    );

    expect(output.content).toBe('Retention is weakest after the tutorial.');
    expect(output.responseSequenceInRun).toBe(3);

    const runtimeMessages = listTalkMessages({ talkId: TALK_ID }).filter(
      (message) => message.run_id === 'run-tools-openai',
    );
    expect(runtimeMessages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
    ]);
    expect(JSON.parse(String(runtimeMessages[0].metadata_json))).toMatchObject({
      kind: 'assistant_tool_use',
    });
  });

  it('fails closed when connectors are attached but no route step supports tools', async () => {
    attachVerifiedPostHogConnector();
    configureTalkRuntime({
      providers: [
        {
          id: 'openai.primary',
          name: 'OpenAI Primary',
          providerKind: 'openai',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://openai.example.test',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          models: [
            {
              modelId: 'gpt-no-tools',
              displayName: 'GPT No Tools',
              contextWindowTokens: 32_000,
              defaultMaxOutputTokens: 1_024,
              enabled: true,
              supportsTools: false,
            },
          ],
          credential: { apiKey: 'sk-openai-test' },
        },
      ],
      routes: [
        {
          id: 'route.primary',
          name: 'Primary Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'openai.primary',
              modelId: 'gpt-no-tools',
            },
          ],
        },
      ],
    });

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Use the connector.',
      messageId: 'msg-no-tools',
      runId: 'run-no-tools',
    });

    const executor = new DirectTalkExecutor({
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not run');
      }),
    });

    await expect(
      executor.execute(
        {
          runId: 'run-no-tools',
          talkId: TALK_ID,
          requestedBy: OWNER_ID,
          triggerMessageId: 'msg-no-tools',
          triggerContent: 'Use the connector.',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: 'connector_tools_require_tool_capable_model',
    });

    const attempts = listLlmAttemptsForRun('run-no-tools');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      status: 'skipped',
      failure_class: 'configuration',
    });
  });

  it('routes Claude default connector runs through the container in subscription mode', async () => {
    const settingsService = new ExecutorSettingsService();
    settingsService.saveExecutorConfig(
      {
        executorAuthMode: 'subscription',
        claudeOauthToken: 'oauth-subscription',
      },
      OWNER_ID,
    );
    setActiveExecutorSettingsService(settingsService);
    resetTalkAgentsToDefault(TALK_ID);
    attachVerifiedPostHogConnector();

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Use PostHog please.',
      messageId: 'msg-claude-connectors',
      runId: 'run-claude-connectors',
    });

    const runContainer = vi.fn(
      async (): Promise<ContainerOutput> => ({
        status: 'success',
        result: 'Container connector response',
      }),
    );
    const executor = new DirectTalkExecutor({
      runContainer,
      fetchImpl: vi.fn(async () => {
        throw new Error('fetch should not run');
      }),
    });

    await expect(
      executor.execute(
        {
          runId: 'run-claude-connectors',
          talkId: TALK_ID,
          requestedBy: OWNER_ID,
          triggerMessageId: 'msg-claude-connectors',
          triggerContent: 'Use PostHog please.',
        },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: 'Container connector response',
      providerId: 'provider.anthropic',
    });

    expect(runContainer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toolProfile: 'web_talk',
        webTalkConnectorBundle: expect.objectContaining({
          connectors: [
            expect.objectContaining({
              connectorKind: 'posthog',
              name: 'FTUE PostHog',
              secret: expect.objectContaining({
                kind: 'posthog',
                apiKey: 'phc_test_key',
              }),
            }),
          ],
          toolDefinitions: [
            expect.objectContaining({
              toolName: expect.stringContaining('__posthog_query'),
            }),
          ],
        }),
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('fails the Claude default path after a response-start timeout', async () => {
    vi.useFakeTimers();

    const settingsService = new ExecutorSettingsService();
    settingsService.saveExecutorConfig(
      {
        executorAuthMode: 'api_key',
        anthropicApiKey: 'sk-ant-test',
      },
      OWNER_ID,
    );
    setActiveExecutorSettingsService(settingsService);
    resetTalkAgentsToDefault(TALK_ID);

    enqueueTalkTurnAtomic({
      talkId: TALK_ID,
      userId: OWNER_ID,
      content: 'Please answer eventually',
      messageId: 'msg-claude-timeout',
      runId: 'run-claude-timeout',
    });

    const runContainer = vi.fn(
      async (
        _group: unknown,
        _input: unknown,
        onProcess: (proc: ChildProcess, containerName: string) => void,
      ) => {
        return await new Promise<{
          status: 'success' | 'error';
          result: string | null;
          error?: string;
        }>((resolve) => {
          let killed = false;
          const proc = {
            get killed() {
              return killed;
            },
            kill: vi.fn(() => {
              killed = true;
              resolve({ status: 'success', result: null });
              return true;
            }),
          } as unknown as ChildProcess;

          onProcess(proc, 'test-container');
        });
      },
    );

    const executor = new DirectTalkExecutor({
      runContainer,
    });

    const events: TalkExecutionEvent[] = [];
    const executeErrorPromise = executor
      .execute(
        {
          runId: 'run-claude-timeout',
          talkId: TALK_ID,
          requestedBy: OWNER_ID,
          triggerMessageId: 'msg-claude-timeout',
          triggerContent: 'Please answer eventually',
        },
        new AbortController().signal,
        (event) => {
          events.push(event);
        },
      )
      .then(
        () => null,
        (error) => error,
      );

    await vi.advanceTimersByTimeAsync(60_001);

    await expect(executeErrorPromise).resolves.toMatchObject({
      code: 'response_start_timeout',
    });

    const attempts = listLlmAttemptsForRun('run-claude-timeout');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      provider_id: 'provider.anthropic',
      status: 'failed',
      failure_class: 'timeout',
    });

    expect(events.map((event) => event.type)).toEqual([
      'talk_response_started',
      'talk_response_failed',
    ]);
    expect(events[1]).toMatchObject({
      type: 'talk_response_failed',
      errorCode: 'response_start_timeout',
      errorMessage: 'Claude did not start streaming a response in time.',
    });
    expect(runContainer).toHaveBeenCalledTimes(1);
  });
});
