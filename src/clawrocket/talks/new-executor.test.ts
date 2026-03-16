import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agents/agent-router.js', () => ({
  executeWithAgent: vi.fn(),
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createMessage,
  createTalkRun,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { executeWithAgent } from '../agents/agent-router.js';
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
  });

  it('executes read_context_source through executeToolCall and persists assistant messages with createdBy null', async () => {
    const now = new Date().toISOString();
    createMessage({
      id: 'msg-user-1',
      talkId: TALK_ID,
      threadId: THREAD_ID,
      role: 'user',
      content: 'Summarize source S1',
      createdBy: 'owner-1',
      createdAt: now,
    });
    createTalkRun({
      id: 'run-talk-1',
      talk_id: TALK_ID,
      thread_id: THREAD_ID,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: 'msg-user-1',
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: now,
      started_at: now,
      ended_at: null,
      cancel_reason: null,
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
        const talkContext = context!;
        expect(agentId).toBe('agent.main');
        expect(userMessage).toBe('Summarize source S1');
        expect(talkContext.systemPrompt).toContain('[S1] Meeting Notes');
        expect(talkContext.contextTools.map((tool) => tool.name)).toContain(
          'read_context_source',
        );
        expect(typeof options.executeToolCall).toBe('function');

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
          providerId: 'builtin.mock',
          modelId: 'mock-default',
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

        return {
          content: `Summary ready. ${toolResult.result}`,
          agentId,
          providerId: 'builtin.mock',
          modelId: 'mock-default',
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

    const messageRow = getDb()
      .prepare(
        `
        SELECT role, content, created_by, agent_id
        FROM talk_messages
        WHERE talk_id = ? AND role = 'assistant'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      )
      .get(TALK_ID) as
      | {
          role: string;
          content: string;
          created_by: string | null;
          agent_id: string | null;
        }
      | undefined;

    expect(messageRow).toBeDefined();
    expect(messageRow?.content).toBe(
      'Summary ready. Revenue grew 20 percent quarter over quarter.',
    );
    expect(messageRow?.created_by).toBeNull();
    expect(messageRow?.agent_id).toBe('agent.main');

    const attemptRow = getDb()
      .prepare(
        `
        SELECT run_id, talk_id, agent_id, provider_id, model_id, status
        FROM llm_attempts
        WHERE run_id = ?
      `,
      )
      .get('run-talk-1') as
      | {
          run_id: string;
          talk_id: string | null;
          agent_id: string | null;
          provider_id: string | null;
          model_id: string;
          status: string;
        }
      | undefined;

    expect(attemptRow).toBeDefined();
    expect(attemptRow?.talk_id).toBe(TALK_ID);
    expect(attemptRow?.agent_id).toBe('agent.main');
    expect(attemptRow?.provider_id).toBe('builtin.mock');
    expect(attemptRow?.model_id).toBe('mock-default');
    expect(attemptRow?.status).toBe('success');
  });
});
