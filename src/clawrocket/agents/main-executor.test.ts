import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-router.js', () => ({
  executeWithAgent: vi.fn(),
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createMessage,
  upsertUser,
} from '../db/index.js';
import {
  executeMainChannel,
  type MainExecutionEvent,
} from './main-executor.js';
import { executeWithAgent } from './agent-router.js';

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
  });

  it('returns output without writing to DB', async () => {
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
      providerId: 'builtin.mock',
      modelId: 'mock-default',
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
    expect(result.providerId).toBe('builtin.mock');
    expect(result.modelId).toBe('mock-default');
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
          providerId: 'builtin.mock',
          modelId: 'mock-default',
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
