import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalk,
  createTalkMessage,
  createTalkRun,
  enqueueTalkTurnAtomic,
  getProviderSecretByProviderId,
  getTalkRunById,
  listLlmAttemptsForRun,
  listTalkLlmSettingsSnapshot,
  replaceTalkAgents,
  replaceTalkLlmSettingsSnapshot,
  upsertUser,
} from '../db/index.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';

import { DirectTalkExecutor } from './direct-executor.js';
import type { TalkExecutionEvent } from './executor.js';

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
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    requested_by: OWNER_ID,
    status: 'completed',
    trigger_message_id: null,
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
    id: `${runId}-user`,
    talkId: TALK_ID,
    role: 'user',
    content: userText,
    createdBy: OWNER_ID,
    runId,
    createdAt,
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
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    requested_by: OWNER_ID,
    status: 'failed',
    trigger_message_id: null,
    target_agent_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: createdAt,
    started_at: createdAt,
    ended_at: createdAt,
    cancel_reason: 'failed',
  });
  createTalkMessage({
    id: `${runId}-user`,
    talkId: TALK_ID,
    role: 'user',
    content: userText,
    createdBy: OWNER_ID,
    runId,
    createdAt,
  });
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

describe('DirectTalkExecutor', () => {
  beforeEach(() => {
    _initTestDatabase();
    seedTalk();
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
});
