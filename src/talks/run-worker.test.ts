import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  cancelTalkRunsAtomic,
  createTalk,
  enqueueTalkTurnAtomic,
  getOutboxEventsForTopics,
  getTalkRunById,
  listTalkMessages,
  upsertUser,
} from '../db.js';

import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';
import { MockTalkExecutor } from './mock-executor.js';
import { TalkRunWorker } from './run-worker.js';

class BlockingExecutor implements TalkExecutor {
  startedRuns: string[] = [];

  private resolveStarted!: () => void;

  readonly started = new Promise<void>((resolve) => {
    this.resolveStarted = resolve;
  });

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput> {
    this.startedRuns.push(input.runId);
    this.resolveStarted();

    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(createAbortError(signal.reason));
        return;
      }

      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(createAbortError(signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function createAbortError(reason?: unknown): Error {
  const error = new Error(typeof reason === 'string' ? reason : 'aborted');
  error.name = 'AbortError';
  return error;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

describe('TalkRunWorker', () => {
  beforeEach(() => {
    _initTestDatabase();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });

    createTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Test Talk',
    });
  });

  it('processes queued work immediately when wake() is called', async () => {
    const worker = new TalkRunWorker({
      executor: new MockTalkExecutor({ executionMs: 5 }),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'wake me now',
      messageId: 'msg-1',
      runId: 'run-1',
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getTalkRunById('run-1')?.status).toBe('running');

    const startedAt = Date.now();
    worker.wake();

    await waitFor(() => getTalkRunById('run-1')?.status === 'completed');
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    await worker.stop();
  });

  it('does not emit terminal failure when a running talk is cancelled and aborted', async () => {
    const executor = new BlockingExecutor();
    const worker = new TalkRunWorker({
      executor,
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'cancel me',
      messageId: 'msg-2',
      runId: 'run-2',
    });

    worker.wake();
    await executor.started;

    const cancellation = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      cancelledBy: 'owner-1',
    });
    expect(cancellation.cancelledRuns).toBe(1);
    expect(cancellation.cancelledRunning).toBe(true);

    worker.abortTalk('talk-1');

    await waitFor(() => getTalkRunById('run-2')?.status === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some((event) => {
        if (
          event.event_type !== 'talk_run_failed' &&
          event.event_type !== 'talk_run_completed'
        ) {
          return false;
        }
        const payload = JSON.parse(event.payload) as { runId?: string };
        return payload.runId === 'run-2';
      }),
    ).toBe(false);

    await worker.stop();
  });

  it('completes runs sequentially and preserves run/message correlation fields', async () => {
    const worker = new TalkRunWorker({
      executor: new MockTalkExecutor({ executionMs: 5 }),
      pollMs: 10_000,
      maxConcurrency: 1,
    });
    await worker.start();

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'first user prompt',
      messageId: 'msg-3',
      runId: 'run-3',
    });
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'second user prompt',
      messageId: 'msg-4',
      runId: 'run-4',
    });

    worker.wake();

    await waitFor(() => getTalkRunById('run-3')?.status === 'completed');
    await waitFor(() => getTalkRunById('run-4')?.status === 'completed');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    const userMessages = messages.filter((message) => message.role === 'user');
    const assistantMessages = messages.filter(
      (message) => message.role === 'assistant',
    );

    expect(userMessages).toHaveLength(2);
    expect(userMessages.every((message) => message.run_id === null)).toBe(true);
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages.every((message) => message.run_id !== null)).toBe(
      true,
    );

    const outbox = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const queuedEvent = outbox.find(
      (event) =>
        event.event_type === 'talk_run_queued' &&
        event.payload.includes('"runId":"run-4"'),
    );
    const startedEvent = outbox.find(
      (event) =>
        event.event_type === 'talk_run_started' &&
        event.payload.includes('"runId":"run-4"'),
    );

    expect(queuedEvent).toBeDefined();
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.payload).toContain('"triggerMessageId":"msg-4"');

    await worker.stop();
  });

  it('fails interrupted running work on startup and promotes queued runs', async () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'stale running work',
      messageId: 'msg-5',
      runId: 'run-5',
      now: '2024-01-01T00:00:01.000Z',
    });
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'queued recovery work',
      messageId: 'msg-6',
      runId: 'run-6',
      now: '2024-01-01T00:00:02.000Z',
    });

    const worker = new TalkRunWorker({
      executor: new BlockingExecutor(),
      pollMs: 10_000,
      maxConcurrency: 1,
    });

    await worker.start();

    await waitFor(() => getTalkRunById('run-5')?.status === 'failed');
    await waitFor(() => getTalkRunById('run-6')?.status === 'running');

    const staleRun = getTalkRunById('run-5');
    expect(staleRun?.cancel_reason).toBe('interrupted_by_restart');

    await worker.stop();
  });
});
