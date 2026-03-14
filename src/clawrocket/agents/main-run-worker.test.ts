/**
 * Integration tests for MainRunWorker: claim → execute → sanitize → complete/fail.
 */
import { randomUUID } from 'crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  enqueueMainTurnAtomic,
  getOutboxEventsForTopics,
  getTalkRunById,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import type {
  MainExecutionEvent,
  MainExecutorInput,
  MainExecutorOutput,
} from './main-executor.js';
import { MainRunWorker, type MainExecutorFn } from './main-run-worker.js';

const USER_A = 'user-a';
let AGENT_ID: string;
const PROVIDER_ID = 'builtin.mock';
const MODEL_ID = 'mock-default';

beforeEach(() => {
  _initTestDatabase();
  upsertUser({ id: USER_A, email: 'a@test.com', displayName: 'User A' });
  const agent = createRegisteredAgent({
    name: 'Test Main Agent',
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });
  AGENT_ID = agent.id;
});

/** Creates a mock executor that returns successfully with given content. */
function createMockExecutor(
  responseContent: string,
  opts?: { latencyMs?: number; emitInternalTags?: boolean },
): MainExecutorFn {
  return async (
    input: MainExecutorInput,
    _signal: AbortSignal,
    emit?: (event: MainExecutionEvent) => void,
  ): Promise<MainExecutorOutput> => {
    emit?.({
      type: 'main_response_started',
      runId: input.runId,
      threadId: input.threadId,
      agentId: AGENT_ID,
      agentName: 'Test Agent',
    });

    const content = opts?.emitInternalTags
      ? `<internal>thinking</internal>${responseContent}`
      : responseContent;

    emit?.({
      type: 'main_response_delta',
      runId: input.runId,
      threadId: input.threadId,
      text: content,
    });

    return {
      content,
      agentId: AGENT_ID,
      agentName: 'Test Agent',
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      threadId: input.threadId,
      latencyMs: opts?.latencyMs ?? 42,
      usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
    };
  };
}

/** Creates a mock executor that throws. */
function createFailingExecutor(errorMessage: string): MainExecutorFn {
  return async (): Promise<MainExecutorOutput> => {
    throw new Error(errorMessage);
  };
}

/** Helper to enqueue a turn and return its IDs. */
function enqueueTurn(threadId?: string) {
  const tid = threadId ?? randomUUID();
  const messageId = `msg_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  enqueueMainTurnAtomic({
    threadId: tid,
    userId: USER_A,
    content: 'hello from test',
    messageId,
    runId,
  });
  return { threadId: tid, messageId, runId };
}

/** Wait for a run to reach a terminal status. */
async function waitForRunTerminal(
  runId: string,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = getTalkRunById(runId);
    if (run && (run.status === 'completed' || run.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Run ${runId} did not reach terminal status within ${timeoutMs}ms`);
}

describe('MainRunWorker integration', () => {
  it('claims, executes, and completes a run with sanitized content', async () => {
    const { runId, threadId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('Hello world'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Run should be completed
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('completed');
    expect(run.ended_at).toBeTruthy();

    // Assistant message should be stored
    const msg = getDb()
      .prepare(
        `SELECT * FROM talk_messages
         WHERE thread_id = ? AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as any;
    expect(msg).toBeTruthy();
    expect(msg.content).toBe('Hello world');

    // LLM attempt should record latency and usage
    const attempt = getDb()
      .prepare('SELECT * FROM llm_attempts WHERE run_id = ?')
      .get(runId) as any;
    expect(attempt).toBeTruthy();
    expect(attempt.latency_ms).toBe(42);
    expect(attempt.input_tokens).toBe(10);
    expect(attempt.output_tokens).toBe(20);

    // Terminal outbox event should exist
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const terminal = events.find(
      (e) => e.event_type === 'main_response_completed',
    );
    expect(terminal).toBeTruthy();
  });

  it('sanitizes internal tags from both streamed deltas and stored content', async () => {
    const { runId, threadId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('visible text', { emitInternalTags: true }),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Stored content should have internal tags stripped
    const msg = getDb()
      .prepare(
        `SELECT * FROM talk_messages
         WHERE thread_id = ? AND role = 'assistant'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(threadId) as any;
    expect(msg.content).toBe('visible text');
    expect(msg.content).not.toContain('<internal>');

    // Streamed delta events should also be sanitized
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const deltas = events
      .filter((e) => e.event_type === 'main_response_delta')
      .map((e) => JSON.parse(e.payload));
    for (const delta of deltas) {
      expect(delta.text).not.toContain('<internal>');
    }
  });

  it('fails the run and emits terminal event on executor error', async () => {
    const { runId } = enqueueTurn();

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createFailingExecutor('LLM provider unreachable'),
    });
    await worker.start();

    await waitForRunTerminal(runId);
    await worker.stop();

    // Run should be failed
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.cancel_reason).toContain('LLM provider unreachable');

    // Terminal failure event should exist
    const events = getOutboxEventsForTopics([`user:${USER_A}`], 0);
    const failure = events.find(
      (e) => e.event_type === 'main_response_failed',
    );
    expect(failure).toBeTruthy();
    const payload = JSON.parse(failure!.payload);
    expect(payload.errorCode).toBe('execution_failed');
    expect(payload.errorMessage).toContain('LLM provider unreachable');
  });

  it('recovers interrupted runs on startup', async () => {
    const { runId } = enqueueTurn();
    // Manually transition to running to simulate a crash
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'running', started_at = ? WHERE id = ?`,
      )
      .run(new Date().toISOString(), runId);

    const worker = new MainRunWorker({
      pollMs: 10,
      maxConcurrency: 1,
      executor: createMockExecutor('should not be called'),
    });
    await worker.start();
    // Give it a tick to process
    await new Promise((r) => setTimeout(r, 50));
    await worker.stop();

    // Run should have been failed by startup recovery
    const run = getTalkRunById(runId)!;
    expect(run.status).toBe('failed');
    expect(run.cancel_reason).toContain('interrupted_by_restart');
  });
});
