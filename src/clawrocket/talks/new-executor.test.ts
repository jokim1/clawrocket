import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-router.js', () => ({
  executeWithAgent: vi.fn(),
}));
vi.mock('../agents/execution-planner.js', () => ({
  planExecution: vi.fn(),
  getContainerAllowedTools: vi.fn(() => ['Bash']),
}));
vi.mock('../agents/container-turn-executor.js', () => ({
  executeContainerAgentTurn: vi.fn(),
}));
vi.mock('../agents/project-mounts.js', () => ({
  resolveValidatedProjectMountPath: vi.fn(),
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createTalkMessage,
  createTalkRun,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { executeWithAgent } from '../agents/agent-router.js';
import { planExecution } from '../agents/execution-planner.js';
import { executeContainerAgentTurn } from '../agents/container-turn-executor.js';
import { resolveValidatedProjectMountPath } from '../agents/project-mounts.js';
import { CleanTalkExecutor } from './new-executor.js';
import type { TalkExecutionEvent } from './executor.js';

const TALK_ID = 'talk-clean-exec';
const THREAD_ID = 'thread-clean-exec';

function insertSource(input: {
  id: string;
  sourceRef: string;
  title: string;
  extractedText: string;
}) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, status,
        extracted_text, created_at, updated_at, created_by
      ) VALUES (?, ?, ?, 'text', ?, 'ready', ?, ?, ?, ?)
    `,
    )
    .run(
      input.id,
      TALK_ID,
      input.sourceRef,
      input.title,
      input.extractedText,
      now,
      now,
      'owner-1',
    );
}

describe('CleanTalkExecutor', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'Executor Contract Test Talk',
    });
    vi.mocked(executeWithAgent).mockReset();
    vi.mocked(planExecution).mockReset();
    vi.mocked(executeContainerAgentTurn).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockReset();
    vi.mocked(resolveValidatedProjectMountPath).mockImplementation((path) =>
      path ? String(path) : null,
    );
    vi.mocked(planExecution).mockReturnValue({
      backend: 'direct_http',
      routeReason: 'normal',
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
    });
  });

  it('executes context tools but does not persist assistant messages or llm attempts directly', async () => {
    const now = new Date().toISOString();
    createTalkMessage({
      id: 'msg-user-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Summarize source S1',
      createdBy: 'owner-1',
      createdAt: now,
    });
    insertSource({
      id: 'src-1',
      sourceRef: 'S1',
      title: 'Meeting Notes',
      extractedText: 'Revenue grew 20 percent quarter over quarter.',
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (agentId, context, userMessage, options) => {
        expect(context).not.toBeNull();
        expect(agentId).toBe('agent.main');
        expect(userMessage).toBe('Summarize source S1');
        expect(context!.systemPrompt).toContain('[S1] Meeting Notes');
        expect(context!.contextTools.map((tool) => tool.name)).toContain(
          'read_context_source',
        );

        const toolResult = await options.executeToolCall!(
          'read_context_source',
          { sourceRef: 'S1' },
        );
        expect(toolResult).toEqual({
          result: 'Revenue grew 20 percent quarter over quarter.',
        });

        options.emit?.({
          type: 'started',
          runId: options.runId,
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        });
        options.emit?.({
          type: 'text_delta',
          text: 'Summary ready.',
        });
        options.emit?.({
          type: 'usage',
          inputTokens: 12,
          outputTokens: 34,
          estimatedCostUsd: 0,
        });
        options.emit?.({
          type: 'completed',
          content: 'Summary ready.',
        });

        return {
          content: `Summary ready. ${toolResult.result}`,
          agentId,
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
          usage: {
            inputTokens: 12,
            outputTokens: 34,
            estimatedCostUsd: 0,
          },
        };
      },
    );

    const events: TalkExecutionEvent[] = [];
    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-1',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-1',
        triggerContent: 'Summarize source S1',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(result.content).toBe(
      'Summary ready. Revenue grew 20 percent quarter over quarter.',
    );
    expect(result.agentId).toBe('agent.main');
    expect(result.providerId).toBe('provider.anthropic');
    expect(result.modelId).toBe('claude-sonnet-4-6');
    expect(result.responseSequenceInRun).toBe(1);
    expect(result.metadataJson).toBeTruthy();
    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      runId: 'run-talk-1',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseGroupId: null,
      sequenceIndex: null,
    });

    expect(events.some((event) => event.type === 'talk_response_started')).toBe(
      true,
    );
    expect(events.some((event) => event.type === 'talk_response_delta')).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === 'talk_response_completed' &&
          event.agentId === 'agent.main',
      ),
    ).toBe(true);

    const assistantMessages = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM talk_messages
        WHERE talk_id = ? AND role = 'assistant'
      `,
      )
      .get(TALK_ID) as { count: number };
    expect(assistantMessages.count).toBe(0);

    const llmAttempts = getDb()
      .prepare(
        `
        SELECT COUNT(*) AS count
        FROM llm_attempts
        WHERE run_id = ?
      `,
      )
      .get('run-talk-1') as { count: number };
    expect(llmAttempts.count).toBe(0);
  });

  it('routes container-backed talk turns through the stateless adapter', async () => {
    createTalkMessage({
      id: 'msg-user-container',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Open the mounted project',
      createdBy: 'owner-1',
      createdAt: '2026-03-16T00:00:00.000Z',
    });
    getDb()
      .prepare(
        `
        UPDATE talks
        SET project_path = ?
        WHERE id = ?
      `,
      )
      .run('/tmp/talk-project', TALK_ID);
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
        'Follow Talk execution rules.',
        'provider.anthropic',
        'claude-sonnet-4-6',
        'agent.main',
      );

    vi.mocked(planExecution).mockReturnValue({
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
        secrets: {
          ANTHROPIC_API_KEY: 'sk-container-test',
        },
      },
    });
    vi.mocked(resolveValidatedProjectMountPath).mockReturnValue(
      '/resolved/talk-project',
    );
    vi.mocked(executeContainerAgentTurn).mockResolvedValue({
      content: 'Container talk reply',
    });

    const events: TalkExecutionEvent[] = [];
    const executor = new CleanTalkExecutor();
    const result = await executor.execute(
      {
        runId: 'run-talk-container',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-container',
        triggerContent: 'Open the mounted project',
      },
      new AbortController().signal,
      (event) => events.push(event),
    );

    expect(resolveValidatedProjectMountPath).toHaveBeenCalledWith(
      '/tmp/talk-project',
      false,
    );
    expect(executeContainerAgentTurn).toHaveBeenCalledTimes(1);
    expect(executeContainerAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-talk-container',
        userId: 'owner-1',
        promptLabel: 'talk',
        userMessage: 'Open the mounted project',
        allowedTools: ['Bash'],
        talkId: TALK_ID,
        threadId: THREAD_ID,
        triggerMessageId: 'msg-user-container',
        projectMountHostPath: '/resolved/talk-project',
      }),
    );

    const containerInput = vi.mocked(executeContainerAgentTurn).mock
      .calls[0]![0];
    expect(containerInput.context.systemPrompt).toContain(
      'Follow Talk execution rules.',
    );
    expect(containerInput.context.history).toEqual([
      { role: 'user', content: 'Open the mounted project' },
    ]);
    expect(containerInput.historyMessageIds).toContain('msg-user-container');

    expect(result).toMatchObject({
      content: 'Container talk reply',
      agentId: 'agent.main',
      agentNickname: 'Nanoclaw',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseSequenceInRun: 1,
    });
    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      runId: 'run-talk-container',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      responseGroupId: null,
      sequenceIndex: null,
    });
    expect(events.map((event) => event.type)).toEqual([
      'talk_response_started',
      'talk_response_completed',
    ]);
  });

  it('injects prior ordered outputs into later phases as attributed user context', async () => {
    createTalkMessage({
      id: 'msg-user-ordered',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Compare the go-to-market options.',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-ordered-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:00.100Z',
      started_at: '2024-01-01T00:00:00.100Z',
      ended_at: '2024-01-01T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-assistant-ordered-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'Agent A thinks partnerships are the fastest path.',
      createdBy: null,
      runId: 'run-ordered-1',
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    createTalkRun({
      id: 'run-ordered-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:01.100Z',
      started_at: '2024-01-01T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-ordered-3',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: 'msg-user-ordered',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-ordered',
      sequence_index: 2,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:01.200Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, context, userMessage) => {
        expect(context).not.toBeNull();
        expect(
          context!.history.some((message) =>
            typeof message.content === 'string'
              ? message.content.includes('partnerships are the fastest path')
              : false,
          ),
        ).toBe(false);
        expect(userMessage).toContain(
          'Original user request:\nCompare the go-to-market options.',
        );
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent A thinks partnerships are the fastest path.',
        );
        expect(userMessage).toContain(
          'Provide your own analysis from your role and perspective.',
        );
        expect(userMessage).not.toContain('Synthesize these perspectives.');

        return {
          content: 'Agent B prefers direct sales.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-ordered-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-ordered',
        triggerContent: 'Compare the go-to-market options.',
        responseGroupId: 'group-ordered',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      responseGroupId: 'group-ordered',
      sequenceIndex: 1,
    });
    expect(JSON.parse(result.metadataJson!)).not.toHaveProperty('isSynthesis');
  });

  it('marks the final ordered phase as synthesis and injects synthesis instructions', async () => {
    createTalkMessage({
      id: 'msg-user-synth',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Recommend a pricing strategy.',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });

    for (const [runId, sequenceIndex, content] of [
      ['run-synth-1', 0, 'Agent A recommends premium positioning.'],
      ['run-synth-2', 1, 'Agent B warns about market share risk.'],
    ] as const) {
      createTalkRun({
        id: runId,
        talk_id: TALK_ID,
        thread_id: THREAD_ID,
        requested_by: 'owner-1',
        status: 'completed',
        trigger_message_id: 'msg-user-synth',
        target_agent_id: 'agent.main',
        idempotency_key: null,
        response_group_id: 'group-synth',
        sequence_index: sequenceIndex,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: `2024-01-01T00:00:0${sequenceIndex + 1}.000Z`,
        started_at: `2024-01-01T00:00:0${sequenceIndex + 1}.000Z`,
        ended_at: `2024-01-01T00:00:0${sequenceIndex + 1}.500Z`,
        cancel_reason: null,
      });
      createTalkMessage({
        id: `msg-${runId}`,
        talkId: TALK_ID,
        threadId: THREAD_ID,
        role: 'assistant',
        content,
        createdBy: null,
        runId,
        createdAt: `2024-01-01T00:00:0${sequenceIndex + 1}.500Z`,
      });
    }
    createTalkRun({
      id: 'run-synth-3',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-synth',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-synth',
      sequence_index: 2,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-01T00:00:03.000Z',
      started_at: '2024-01-01T00:00:03.000Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent A recommends premium positioning.',
        );
        expect(userMessage).toContain(
          '[Nanoclaw]\nAgent B warns about market share risk.',
        );
        expect(userMessage).toContain('Synthesize these perspectives.');

        return {
          content: 'Synthesis: pursue premium entry pricing with guardrails.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    const result = await new CleanTalkExecutor().execute(
      {
        runId: 'run-synth-3',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-synth',
        triggerContent: 'Recommend a pricing strategy.',
        responseGroupId: 'group-synth',
        sequenceIndex: 2,
      },
      new AbortController().signal,
    );

    expect(JSON.parse(result.metadataJson!)).toMatchObject({
      responseGroupId: 'group-synth',
      sequenceIndex: 2,
      isSynthesis: true,
    });
  });

  it('coalesces multiple assistant messages from one prior run into a single attributed block', async () => {
    createTalkMessage({
      id: 'msg-user-multi-output',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Evaluate the trade-offs.',
      createdBy: 'owner-1',
      createdAt: '2024-01-02T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-multi-output-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-multi-output',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-multi-output',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-02T00:00:00.100Z',
      started_at: '2024-01-02T00:00:00.100Z',
      ended_at: '2024-01-02T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-multi-output-1a',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'First supporting point.',
      createdBy: null,
      runId: 'run-multi-output-1',
      sequenceInRun: 1,
      createdAt: '2024-01-02T00:00:00.500Z',
    });
    createTalkMessage({
      id: 'msg-multi-output-1b',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'Second supporting point.',
      createdBy: null,
      runId: 'run-multi-output-1',
      sequenceInRun: 2,
      createdAt: '2024-01-02T00:00:00.700Z',
    });
    createTalkRun({
      id: 'run-multi-output-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-multi-output',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-multi-output',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-02T00:00:01.100Z',
      started_at: '2024-01-02T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage).toContain(
          '[Nanoclaw]\nFirst supporting point.\n\nSecond supporting point.',
        );
        expect(userMessage.match(/\[Nanoclaw\]/g)).toHaveLength(1);

        return {
          content: 'Independent second-pass analysis.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-multi-output-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-multi-output',
        triggerContent: 'Evaluate the trade-offs.',
        responseGroupId: 'group-multi-output',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );
  });

  it('caps injected prior outputs to the remaining prompt budget', async () => {
    getDb()
      .prepare(
        `
        UPDATE llm_provider_models
        SET context_window_tokens = 4096
        WHERE provider_id = 'provider.anthropic' AND model_id = 'claude-sonnet-4-6'
      `,
      )
      .run();

    createTalkMessage({
      id: 'msg-user-budgeted',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Recommend a launch plan.',
      createdBy: 'owner-1',
      createdAt: '2024-01-03T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-budgeted-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: 'msg-user-budgeted',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-budgeted',
      sequence_index: 0,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-03T00:00:00.100Z',
      started_at: '2024-01-03T00:00:00.100Z',
      ended_at: '2024-01-03T00:00:01.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-budgeted-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'assistant',
      content: 'A'.repeat(8000),
      createdBy: null,
      runId: 'run-budgeted-1',
      createdAt: '2024-01-03T00:00:01.000Z',
    });
    createTalkRun({
      id: 'run-budgeted-2',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-budgeted',
      target_agent_id: 'agent.main',
      idempotency_key: null,
      response_group_id: 'group-budgeted',
      sequence_index: 1,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: '2024-01-03T00:00:01.100Z',
      started_at: '2024-01-03T00:00:01.100Z',
      ended_at: null,
      cancel_reason: null,
    });

    vi.mocked(executeWithAgent).mockImplementation(
      async (_agentId, _context, userMessage) => {
        expect(userMessage.length).toBeLessThan(3500);
        expect(userMessage).toContain('[truncated for context window]');

        return {
          content: 'Budget-aware analysis.',
          agentId: 'agent.main',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        };
      },
    );

    await new CleanTalkExecutor().execute(
      {
        runId: 'run-budgeted-2',
        talkId: TALK_ID,
        threadId: THREAD_ID,
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-user-budgeted',
        triggerContent: 'Recommend a launch plan.',
        responseGroupId: 'group-budgeted',
        sequenceIndex: 1,
      },
      new AbortController().signal,
    );
  });
});
