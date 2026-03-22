import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-router.js', () => ({
  ALWAYS_ALLOWED_CONTEXT_TOOLS: new Set<string>(),
  executeWithAgent: vi.fn(),
}));
vi.mock('./execution-planner.js', () => ({
  planMainExecution: vi.fn(),
  getContainerAllowedTools: vi.fn(() => ['Bash']),
  EXECUTOR_MAIN_PROJECT_PATH_KEY: 'executor.mainProjectPath',
}));
vi.mock('./container-turn-executor.js', () => ({
  executeContainerAgentTurn: vi.fn(),
}));
vi.mock('./project-mounts.js', () => ({
  resolveValidatedProjectMountPath: vi.fn(),
}));
vi.mock('../tools/browser-tools.js', () => ({
  BROWSER_TOOL_DEFINITIONS: [
    {
      name: 'browser_open',
      description: 'Open a persistent browser session.',
      inputSchema: {
        type: 'object',
        properties: {
          siteKey: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['siteKey', 'url'],
      },
    },
  ],
  executeBrowserTool: vi.fn(),
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createMessage,
  enqueueMainTurnAtomic,
  upsertUser,
} from '../db/index.js';
import {
  executeMainChannel,
  type MainExecutionEvent,
} from './main-executor.js';
import { executeWithAgent } from './agent-router.js';
import { planMainExecution } from './execution-planner.js';
import { executeContainerAgentTurn } from './container-turn-executor.js';
import { resolveValidatedProjectMountPath } from './project-mounts.js';
import { executeBrowserTool } from '../tools/browser-tools.js';

describe('main-executor (pure)', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    vi.mocked(executeWithAgent).mockReset();
    vi.mocked(planMainExecution).mockReset();
    vi.mocked(executeContainerAgentTurn).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockReset();
    vi.mocked(executeBrowserTool).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockImplementation((path) =>
      path ? String(path) : null,
    );
    vi.mocked(planMainExecution).mockReturnValue({
      policy: 'direct_only',
      effectiveTools: [],
      heavyToolFamilies: [],
      directPlan: {
        backend: 'direct_http',
        routeReason: 'normal',
        authPath: 'api_key',
        credentialSource: 'env',
        effectiveTools: [],
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
        binding: {
          providerConfig: {
            providerId: 'provider.anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiFormat: 'anthropic_messages',
            authScheme: 'x_api_key',
          },
          secret: { apiKey: 'sk-ant-test' },
        },
      },
      containerPlan: null,
      hostCodexPlan: null,
    });
  });

  it('returns output without writing assistant messages or llm attempts', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-user-1',
      talkId: null,
      threadId: 'thread-1',
      role: 'user',
      content: 'Hello from main',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(executeWithAgent).mockResolvedValue({
      content: 'Main channel reply',
      agentId: 'agent.main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      usage: {
        inputTokens: 12,
        outputTokens: 34,
        estimatedCostUsd: 0,
      },
    });

    const result = await executeMainChannel(
      {
        runId: 'run-main-1',
        threadId: 'thread-1',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-1',
        triggerContent: 'Hello from main',
      },
      new AbortController().signal,
    );

    // Verify output shape
    expect(result.content).toBe('Main channel reply');
    expect(result.agentId).toBe('agent.main');
    expect(result.providerId).toBe('provider.anthropic');
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.threadId).toBe('thread-1');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.usage).toEqual({
      inputTokens: 12,
      outputTokens: 34,
      estimatedCostUsd: 0,
    });

    // Verify NO assistant message was written (worker's responsibility)
    const assistantRow = getDb()
      .prepare(
        `SELECT id FROM talk_messages WHERE thread_id = ? AND role = 'assistant'`,
      )
      .get('thread-1');
    expect(assistantRow).toBeUndefined();

    // Verify NO llm_attempt was written (worker's responsibility)
    const attemptRow = getDb()
      .prepare(`SELECT id FROM llm_attempts WHERE run_id = ?`)
      .get('run-main-1');
    expect(attemptRow).toBeUndefined();
  });

  it('emits streaming events but NO terminal events', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-user-2',
      talkId: null,
      threadId: 'thread-2',
      role: 'user',
      content: 'Test streaming',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, _content, options) => {
        // Simulate streaming events
        options?.emit?.({ type: 'text_delta', text: 'Hello' });
        options?.emit?.({
          type: 'usage',
          inputTokens: 10,
          outputTokens: 20,
          estimatedCostUsd: 0.001,
        });
        return {
          content: 'Hello world',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
        };
      },
    );

    const events: MainExecutionEvent[] = [];
    await executeMainChannel(
      {
        runId: 'run-main-2',
        threadId: 'thread-2',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-2',
        triggerContent: 'Test streaming',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    // Should have started, delta, usage — no completed, no failed
    const types = events.map((e) => e.type);
    expect(types).toContain('main_response_started');
    expect(types).toContain('main_response_delta');
    expect(types).toContain('main_response_usage');
    expect(types).not.toContain('main_response_completed');
    expect(types).not.toContain('main_response_failed');
  });

  it('throws on failure without emitting terminal events', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-user-3',
      talkId: null,
      threadId: 'thread-3',
      role: 'user',
      content: 'Will fail',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(executeWithAgent).mockRejectedValue(
      new Error('Provider unavailable'),
    );

    const events: MainExecutionEvent[] = [];
    await expect(
      executeMainChannel(
        {
          runId: 'run-main-3',
          threadId: 'thread-3',
          requestedBy: 'owner-1',
          triggerMessageId: 'msg-user-3',
          triggerContent: 'Will fail',
        },
        new AbortController().signal,
        (event) => events.push(event),
      ),
    ).rejects.toThrow('Provider unavailable');

    // Should have started event only — no terminal events
    const types = events.map((e) => e.type);
    expect(types).toContain('main_response_started');
    expect(types).not.toContain('main_response_failed');
    expect(types).not.toContain('main_response_completed');
  });

  it('routes container-backed main turns through the stateless adapter', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-user-container',
      talkId: null,
      threadId: 'thread-container',
      role: 'user',
      content: 'Inspect the project',
      createdBy: 'owner-1',
      createdAt: now,
    });
    getDb()
      .prepare(
        `
        UPDATE registered_agents
        SET system_prompt = ?,
            provider_id = ?,
            model_id = ?
        WHERE id = ?
      `,
      )
      .run(
        'Keep filesystem changes isolated.',
        'provider.anthropic',
        'claude-sonnet-4-6',
        'agent.main',
      );
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        'executor.mainProjectPath',
        '/tmp/main-project',
        new Date().toISOString(),
      );

    vi.mocked(planMainExecution).mockReturnValue({
      policy: 'container_only',
      effectiveTools: [
        {
          toolFamily: 'shell',
          runtimeTools: ['Bash'],
          enabled: true,
          requiresApproval: false,
        },
      ],
      heavyToolFamilies: ['shell'],
      directPlan: null,
      containerPlan: {
        backend: 'container',
        routeReason: 'normal',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
        effectiveTools: [
          {
            toolFamily: 'shell',
            runtimeTools: ['Bash'],
            enabled: true,
            requiresApproval: false,
          },
        ],
        heavyToolFamilies: ['shell'],
        containerCredential: {
          authMode: 'api_key',
          credentialSource: 'env',
          secrets: {
            ANTHROPIC_API_KEY: 'sk-container-test',
          },
        },
      },
      hostCodexPlan: null,
    });
    vi.mocked(resolveValidatedProjectMountPath).mockReturnValue(
      '/resolved/main-project',
    );
    vi.mocked(executeContainerAgentTurn).mockResolvedValue({
      content: 'Container main reply',
    });

    const events: MainExecutionEvent[] = [];
    const result = await executeMainChannel(
      {
        runId: 'run-main-container',
        threadId: 'thread-container',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-container',
        triggerContent: 'Inspect the project',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(resolveValidatedProjectMountPath).toHaveBeenCalledWith(
      '/tmp/main-project',
      true,
    );
    expect(executeContainerAgentTurn).toHaveBeenCalledTimes(1);
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-main-container',
        userId: 'owner-1',
        promptLabel: 'main',
        userMessage: expect.stringContaining('## Current User Message'),
        allowedTools: ['Bash'],
        projectMountHostPath: '/resolved/main-project',
        context: expect.objectContaining({
          systemPrompt: 'Keep filesystem changes isolated.',
          history: [],
        }),
      }),
    );

    expect(result).toMatchObject({
      content: 'Container main reply',
      agentId: 'agent.main',
      agentName: 'Nanoclaw',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      threadId: 'thread-container',
    });
    expect(result.usage).toBeUndefined();
    expect(events.map((event) => event.type)).toEqual([
      'main_response_started',
    ]);
  });

  it('injects older Main thread facts into the direct backend context package', async () => {
    for (let index = 1; index <= 13; index += 1) {
      createMessage({
        id: `msg-direct-${index}`,
        talkId: null,
        threadId: 'thread-direct-memory',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content:
          index === 1
            ? 'Important earlier fact: the launch code is Orion.'
            : `Direct thread message ${index}`,
        createdBy: index % 2 === 0 ? null : 'owner-1',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      });
    }
    createMessage({
      id: 'msg-direct-14',
      talkId: null,
      threadId: 'thread-direct-memory',
      role: 'user',
      content: 'What is the launch code?',
      createdBy: 'owner-1',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 14)).toISOString(),
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context) => {
        const combinedContext = [
          context?.systemPrompt ?? '',
          ...(context?.history ?? []).map((message) =>
            typeof message.content === 'string'
              ? message.content
              : JSON.stringify(message.content),
          ),
        ].join('\n');

        return {
          content: combinedContext.includes('Orion')
            ? 'The launch code is Orion.'
            : 'I do not know.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: {
            inputTokens: 20,
            outputTokens: 10,
            estimatedCostUsd: 0,
          },
        };
      },
    );

    const result = await executeMainChannel(
      {
        runId: 'run-main-direct-memory',
        threadId: 'thread-direct-memory',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-direct-14',
        triggerContent: 'What is the launch code?',
      },
      new AbortController().signal,
    );

    expect(result.content).toBe('The launch code is Orion.');
    expect(vi.mocked(executeWithAgent)).toHaveBeenCalledWith(
      'agent.main',
      expect.objectContaining({
        systemPrompt: expect.stringContaining('Orion'),
      }),
      'What is the launch code?',
      expect.any(Object),
    );
  });

  it('exposes browser tools to direct Main agents when browser is enabled', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-browser-tools',
      talkId: null,
      threadId: 'thread-browser-tools',
      role: 'user',
      content: 'Open LinkedIn',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(planMainExecution).mockReturnValue({
      policy: 'direct_only',
      effectiveTools: [
        {
          toolFamily: 'browser',
          runtimeTools: ['browser_open'],
          enabled: true,
          requiresApproval: false,
        },
      ],
      heavyToolFamilies: [],
      directPlan: {
        backend: 'direct_http',
        routeReason: 'normal',
        authPath: 'api_key',
        credentialSource: 'env',
        effectiveTools: [
          {
            toolFamily: 'browser',
            runtimeTools: ['browser_open'],
            enabled: true,
            requiresApproval: false,
          },
        ],
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
        binding: {
          providerConfig: {
            providerId: 'provider.anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiFormat: 'anthropic_messages',
            authScheme: 'x_api_key',
          },
          secret: { apiKey: 'sk-ant-test' },
        },
      },
      containerPlan: null,
      hostCodexPlan: null,
    });

    let toolNames: string[] = [];
    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context) => {
        toolNames = (context?.contextTools ?? []).map((tool) => tool.name);
        return {
          content: 'Browser-ready',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await executeMainChannel(
      {
        runId: 'run-main-browser-tools',
        threadId: 'thread-browser-tools',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-browser-tools',
        triggerContent: 'Open LinkedIn',
      },
      new AbortController().signal,
    );

    expect(toolNames).toContain('browser_open');
  });

  it('dispatches browser tool calls from Main through executeBrowserTool', async () => {
    const now = new Date().toISOString();
    const events: MainExecutionEvent[] = [];
    createMessage({
      id: 'msg-browser-dispatch',
      talkId: null,
      threadId: 'thread-browser-dispatch',
      role: 'user',
      content: 'Use browser tools',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(planMainExecution).mockReturnValue({
      policy: 'direct_only',
      effectiveTools: [
        {
          toolFamily: 'browser',
          runtimeTools: ['browser_open'],
          enabled: true,
          requiresApproval: false,
        },
      ],
      heavyToolFamilies: [],
      directPlan: {
        backend: 'direct_http',
        routeReason: 'normal',
        authPath: 'api_key',
        credentialSource: 'env',
        effectiveTools: [
          {
            toolFamily: 'browser',
            runtimeTools: ['browser_open'],
            enabled: true,
            requiresApproval: false,
          },
        ],
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
        binding: {
          providerConfig: {
            providerId: 'provider.anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiFormat: 'anthropic_messages',
            authScheme: 'x_api_key',
          },
          secret: { apiKey: 'sk-ant-test' },
        },
      },
      containerPlan: null,
      hostCodexPlan: null,
    });
    vi.mocked(executeBrowserTool).mockImplementation(async ({ context }) => {
      context.onProgress?.('Opening linkedin…');
      return {
        result: '{"status":"ok"}',
      };
    });
    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, _content, options) => {
        const toolResult = await options!.executeToolCall!('browser_open', {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        });
        expect(toolResult).toEqual({
          result: '{"status":"ok"}',
        });
        return {
          content: 'Browser tool executed',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await executeMainChannel(
      {
        runId: 'run-main-browser-dispatch',
        threadId: 'thread-browser-dispatch',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-browser-dispatch',
        triggerContent: 'Use browser tools',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(executeBrowserTool).toHaveBeenCalledWith({
      toolName: 'browser_open',
      args: {
        siteKey: 'linkedin',
        url: 'https://www.linkedin.com/messaging/',
      },
      context: {
        signal: expect.any(AbortSignal),
        userId: 'owner-1',
        runId: 'run-main-browser-dispatch',
        onProgress: expect.any(Function),
      },
    });
    expect(events).toContainEqual({
      type: 'main_progress_update',
      runId: 'run-main-browser-dispatch',
      threadId: 'thread-browser-dispatch',
      message: 'Opening linkedin…',
    });
  });

  it('rejects browser tool calls in Main when browser is not enabled', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-browser-disabled',
      talkId: null,
      threadId: 'thread-browser-disabled',
      role: 'user',
      content: 'Try browser anyway',
      createdBy: 'owner-1',
      createdAt: now,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, _content, options) => {
        const toolResult = await options!.executeToolCall!('browser_open', {
          siteKey: 'linkedin',
          url: 'https://www.linkedin.com/messaging/',
        });
        expect(toolResult).toEqual({
          result: "Tool 'browser_open' is not enabled for this Main agent",
          isError: true,
        });
        return {
          content: 'Rejected hidden browser tool',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await executeMainChannel(
      {
        runId: 'run-main-browser-disabled',
        threadId: 'thread-browser-disabled',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-browser-disabled',
        triggerContent: 'Try browser anyway',
      },
      new AbortController().signal,
    );

    expect(executeBrowserTool).not.toHaveBeenCalled();
  });

  it('persists a Main run context snapshot on the talk_runs row', async () => {
    for (let index = 1; index <= 13; index += 1) {
      createMessage({
        id: `msg-snapshot-${index}`,
        talkId: null,
        threadId: 'thread-main-snapshot',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content:
          index === 1
            ? 'Important earlier fact: the launch code is Atlas.'
            : `Snapshot thread message ${index}`,
        createdBy: index % 2 === 0 ? null : 'owner-1',
        createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString(),
      });
    }

    enqueueMainTurnAtomic({
      threadId: 'thread-main-snapshot',
      userId: 'owner-1',
      content: 'What is the launch code?',
      messageId: 'msg-snapshot-14',
      runId: 'run-main-snapshot',
    });

    vi.mocked(executeWithAgent).mockResolvedValue({
      content: 'The launch code is Atlas.',
      agentId: 'agent.main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
        estimatedCostUsd: 0,
      },
    });

    await executeMainChannel(
      {
        runId: 'run-main-snapshot',
        threadId: 'thread-main-snapshot',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-snapshot-14',
        triggerContent: 'What is the launch code?',
      },
      new AbortController().signal,
    );

    const persistedRun = getDb()
      .prepare(
        `
        SELECT metadata_json
        FROM talk_runs
        WHERE id = ?
      `,
      )
      .get('run-main-snapshot') as { metadata_json: string | null } | undefined;

    expect(persistedRun?.metadata_json).toBeTruthy();
    expect(JSON.parse(persistedRun!.metadata_json!)).toMatchObject({
      version: 1,
      threadId: 'thread-main-snapshot',
      renderer: 'direct_http',
      summary: {
        included: true,
        source: expect.any(String),
        coversThroughMessageId: 'msg-snapshot-1',
        text: expect.stringContaining('Atlas'),
      },
      history: {
        messageCount: 12,
      },
    });
    expect(
      JSON.parse(persistedRun!.metadata_json!).history.messageIds,
    ).not.toContain('msg-snapshot-14');
  });

  it('builds the container prompt payload with thread context and recent conversation inline', async () => {
    for (let index = 1; index <= 13; index += 1) {
      createMessage({
        id: `msg-container-${index}`,
        talkId: null,
        threadId: 'thread-container-memory',
        role: index % 2 === 0 ? 'assistant' : 'user',
        content:
          index === 1
            ? 'Important earlier fact: the launch code is Orion.'
            : `Container thread message ${index}`,
        createdBy: index % 2 === 0 ? null : 'owner-1',
        createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      });
    }
    createMessage({
      id: 'msg-container-14',
      talkId: null,
      threadId: 'thread-container-memory',
      role: 'user',
      content: 'What is the launch code?',
      createdBy: 'owner-1',
      createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, 14)).toISOString(),
    });

    getDb()
      .prepare(
        `
        UPDATE registered_agents
        SET system_prompt = ?,
            provider_id = ?,
            model_id = ?
        WHERE id = ?
      `,
      )
      .run(
        'Keep filesystem changes isolated.',
        'provider.anthropic',
        'claude-sonnet-4-6',
        'agent.main',
      );

    vi.mocked(planMainExecution).mockReturnValue({
      policy: 'container_only',
      effectiveTools: [],
      heavyToolFamilies: [],
      directPlan: null,
      containerPlan: {
        backend: 'container',
        routeReason: 'normal',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
        effectiveTools: [],
        heavyToolFamilies: [],
        containerCredential: {
          authMode: 'api_key',
          credentialSource: 'env',
          secrets: {
            ANTHROPIC_API_KEY: 'sk-container-test',
          },
        },
      },
      hostCodexPlan: null,
    });
    vi.mocked(executeContainerAgentTurn).mockImplementation(async (input) => ({
      content: input.userMessage.includes('Orion')
        ? 'The launch code is Orion.'
        : 'I do not know.',
    }));

    const result = await executeMainChannel(
      {
        runId: 'run-main-container-memory',
        threadId: 'thread-container-memory',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-container-14',
        triggerContent: 'What is the launch code?',
      },
      new AbortController().signal,
    );

    expect(result.content).toBe('The launch code is Orion.');
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('## Thread Context'),
        context: expect.objectContaining({
          systemPrompt: expect.stringContaining(
            'Keep filesystem changes isolated.',
          ),
          history: expect.arrayContaining([
            expect.objectContaining({
              content: 'Container thread message 13',
            }),
          ]),
        }),
      }),
    );
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('## Recent Conversation'),
      }),
    );
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining('## Current User Message'),
      }),
    );
  });

  it('throws when no agent is available', async () => {
    // No agents seeded, getMainAgent() returns undefined
    // Clear the seeded main agent
    getDb().prepare('DELETE FROM registered_agents').run();

    await expect(
      executeMainChannel(
        {
          runId: 'run-main-4',
          threadId: 'thread-4',
          requestedBy: 'owner-1',
          triggerMessageId: 'msg-user-4',
          triggerContent: 'No agent',
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not found in registered_agents/);
  });
});
