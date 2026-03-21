/**
 * Tests for the Main channel wiring:
 * - DB accessors (ownership, enqueue, claim, complete, fail, startup recovery)
 * - Route behavior (ownership enforcement, 202, 409 busy guard)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  canUserAccessMainThread,
  claimQueuedMainRuns,
  completeMainRunAtomic,
  deleteMainThread,
  enqueueMainTurnAtomic,
  failInterruptedMainRunsOnStartup,
  failMainRunAtomic,
  getMainThreadOwner,
  getOrCreateDefaultThread,
  listMainThreadsForUser,
  MainThreadBusyError,
  updateMainThreadMetadata,
  getTalkRunById,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import {
  deleteMainThreadRoute,
  listMainThreadsRoute,
  getMainThreadRoute,
  patchMainThreadRoute,
  postMainMessageRoute,
} from '../web/routes/main-channel.js';
import { ThreadTitleValidationError } from '../db/thread-title-utils.js';
import type { AuthContext } from '../web/types.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

// Will be set in beforeEach after agent registration
let AGENT_ID: string;
const PROVIDER_ID = 'builtin.mock';
const MODEL_ID = 'mock-default';

function makeAuth(userId: string): AuthContext {
  return {
    userId,
    sessionId: `session-${userId}`,
    role: 'owner' as const,
    authType: 'cookie' as const,
  };
}

function setupUsers() {
  upsertUser({ id: USER_A, email: 'a@test.com', displayName: 'User A' });
  upsertUser({ id: USER_B, email: 'b@test.com', displayName: 'User B' });
}

beforeEach(() => {
  _initTestDatabase();
  setupUsers();
  const agent = createRegisteredAgent({
    name: 'Test Main Agent',
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
  });
  AGENT_ID = agent.id;
});

// ============================================================================
// DB Accessor Tests
// ============================================================================

describe('Main channel DB accessors', () => {
  describe('getMainThreadOwner', () => {
    it('returns null for non-existent thread', () => {
      expect(getMainThreadOwner('no-such-thread')).toBeNull();
    });

    it('returns created_by of the first user message', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });
      expect(getMainThreadOwner(threadId)).toBe(USER_A);
    });
  });

  describe('canUserAccessMainThread', () => {
    it('allows access to a new thread with no messages', () => {
      expect(canUserAccessMainThread('brand-new', USER_A)).toBe(true);
    });

    it('allows the owner', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });
      expect(canUserAccessMainThread(threadId, USER_A)).toBe(true);
    });

    it('denies a non-owner', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });
      expect(canUserAccessMainThread(threadId, USER_B)).toBe(false);
    });
  });

  describe('listMainThreadsForUser', () => {
    it('returns only threads owned by the user', () => {
      const threadA = randomUUID();
      const threadB = randomUUID();
      enqueueMainTurnAtomic({
        threadId: threadA,
        userId: USER_A,
        content: 'a thread',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });
      enqueueMainTurnAtomic({
        threadId: threadB,
        userId: USER_B,
        content: 'b thread',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const listA = listMainThreadsForUser(USER_A);
      expect(listA).toHaveLength(1);
      expect(listA[0].thread_id).toBe(threadA);

      const listB = listMainThreadsForUser(USER_B);
      expect(listB).toHaveLength(1);
      expect(listB[0].thread_id).toBe(threadB);
    });

    it('does NOT list thread if user has a message but is not the first author', () => {
      const threadId = randomUUID();
      // USER_A creates the thread
      const runId1 = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'first message from A',
        messageId: `msg_${randomUUID()}`,
        runId: runId1,
      });
      // Complete the run so USER_B can post
      const claimed = claimQueuedMainRuns(1);
      completeMainRunAtomic({
        runId: claimed[0].id,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'response',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        usage: { inputTokens: 10, outputTokens: 20 },
      });
      // USER_B directly inserts a user message into the thread (simulating a hypothetical future multi-user scenario)
      getDb()
        .prepare(
          `INSERT INTO talk_messages (id, talk_id, thread_id, role, content, created_by, created_at)
           VALUES (?, NULL, ?, 'user', ?, ?, ?)`,
        )
        .run(
          `msg_${randomUUID()}`,
          threadId,
          'message from B',
          USER_B,
          new Date().toISOString(),
        );

      // USER_B should NOT see this thread — they're not the first author
      const listB = listMainThreadsForUser(USER_B);
      expect(listB).toHaveLength(0);
    });

    it('does not backfill thread titles on list reads', () => {
      const threadId = randomUUID();
      getDb()
        .prepare(
          `INSERT INTO talk_messages (id, talk_id, thread_id, role, content, created_by, created_at)
           VALUES (?, NULL, ?, 'user', ?, ?, ?)`,
        )
        .run(
          `msg_${randomUUID()}`,
          threadId,
          'Quoted thread title should stay unset on read',
          USER_A,
          new Date().toISOString(),
        );

      const result = listMainThreadsRoute(makeAuth(USER_A));
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data[0].threadId).toBe(threadId);
        expect(result.body.data[0].title).toBeNull();
      }
    });

    it('coalesces missing metadata rows to is_pinned = 0', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'thread without manual metadata update',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      getDb()
        .prepare(`DELETE FROM main_threads WHERE thread_id = ?`)
        .run(threadId);

      const rows = listMainThreadsForUser(USER_A);
      expect(rows).toHaveLength(1);
      expect(rows[0].thread_id).toBe(threadId);
      expect(rows[0].is_pinned).toBe(0);
    });

    it('pins a thread even when the metadata row must be recreated', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'pin me',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      getDb()
        .prepare(`DELETE FROM main_threads WHERE thread_id = ?`)
        .run(threadId);

      const updated = updateMainThreadMetadata({
        threadId,
        userId: USER_A,
        pinned: true,
      });
      expect(updated?.is_pinned).toBe(1);

      const rows = listMainThreadsForUser(USER_A);
      expect(rows[0].thread_id).toBe(threadId);
      expect(rows[0].is_pinned).toBe(1);
    });

    it('deletes a main thread and removes runs, messages, and metadata', () => {
      const threadId = randomUUID();
      const messageId = `msg_${randomUUID()}`;
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'delete me',
        messageId,
        runId,
      });
      const claimed = claimQueuedMainRuns(1);
      completeMainRunAtomic({
        runId: claimed[0].id,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'done',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const deleted = deleteMainThread({
        threadId,
        userId: USER_A,
      });

      expect(deleted).toBe(true);
      expect(
        getDb()
          .prepare(
            `SELECT COUNT(*) AS count FROM talk_messages WHERE talk_id IS NULL AND thread_id = ?`,
          )
          .get(threadId),
      ).toMatchObject({ count: 0 });
      expect(getTalkRunById(runId)).toBeNull();
      expect(
        getDb()
          .prepare(`SELECT title FROM main_threads WHERE thread_id = ?`)
          .get(threadId),
      ).toBeUndefined();
    });

    it('rejects deleting a main thread with an awaiting-confirmation run', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'needs approval',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      getDb()
        .prepare(
          `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
        )
        .run(runId);

      expect(() =>
        deleteMainThread({
          threadId,
          userId: USER_A,
        }),
      ).toThrow(/active work/i);
    });
  });

  describe('enqueueMainTurnAtomic', () => {
    it('creates a user message and a queued run atomically', () => {
      const threadId = randomUUID();
      const messageId = `msg_${randomUUID()}`;
      const runId = `run_${randomUUID()}`;

      const result = enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'test content',
        messageId,
        runId,
      });

      expect(result.message.id).toBe(messageId);
      expect(result.message.role).toBe('user');
      expect(result.run.id).toBe(runId);
      expect(result.run.status).toBe('queued');
      expect(result.run.thread_id).toBe(threadId);
      expect(result.run.talk_id).toBeNull();
    });

    it('throws MainThreadBusyError when thread already has an active run', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'first',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      expect(() =>
        enqueueMainTurnAtomic({
          threadId,
          userId: USER_A,
          content: 'second',
          messageId: `msg_${randomUUID()}`,
          runId: `run_${randomUUID()}`,
        }),
      ).toThrow(MainThreadBusyError);
    });

    it('allows enqueue after previous run completes', () => {
      const threadId = randomUUID();
      const runId1 = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'first',
        messageId: `msg_${randomUUID()}`,
        runId: runId1,
      });

      // Claim and complete
      const claimed = claimQueuedMainRuns(1);
      completeMainRunAtomic({
        runId: claimed[0].id,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'response',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        usage: { inputTokens: 10, outputTokens: 20 },
      });

      // Now should succeed
      expect(() =>
        enqueueMainTurnAtomic({
          threadId,
          userId: USER_A,
          content: 'second',
          messageId: `msg_${randomUUID()}`,
          runId: `run_${randomUUID()}`,
        }),
      ).not.toThrow();
    });
  });

  describe('claimQueuedMainRuns', () => {
    it('claims queued runs and transitions them to running', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });

      const claimed = claimQueuedMainRuns(5);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(runId);
      expect(claimed[0].status).toBe('running');
      expect(claimed[0].started_at).toBeTruthy();
    });

    it('does not claim Talk runs (talk_id IS NOT NULL)', () => {
      // Create a talk so the FK is satisfied
      upsertTalk({ id: 'talk-1', ownerId: USER_A, topicTitle: 'Test Talk' });
      const talkThreadId = getOrCreateDefaultThread('talk-1');
      // Insert a Talk run directly
      getDb()
        .prepare(
          `INSERT INTO talk_runs (id, talk_id, thread_id, requested_by, status, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?)`,
        )
        .run(
          'talk-run-1',
          'talk-1',
          talkThreadId,
          USER_A,
          new Date().toISOString(),
        );

      const claimed = claimQueuedMainRuns(5);
      expect(claimed).toHaveLength(0);
    });
  });

  describe('completeMainRunAtomic', () => {
    it('persists assistant message and llm_attempt on completion', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      claimQueuedMainRuns(1);

      const responseMsgId = `msg_${randomUUID()}`;
      const result = completeMainRunAtomic({
        runId,
        threadId,
        requestedBy: USER_A,
        responseMessageId: responseMsgId,
        responseContent: 'bot reply',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        latencyMs: 150,
        usage: { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.001 },
      });

      expect(result.applied).toBe(true);

      // Run should be completed
      const run = getTalkRunById(runId);
      expect(run?.status).toBe('completed');

      // Assistant message should exist
      const msg = getDb()
        .prepare('SELECT * FROM talk_messages WHERE id = ?')
        .get(responseMsgId) as any;
      expect(msg).toBeTruthy();
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('bot reply');
      expect(msg.thread_id).toBe(threadId);
      expect(msg.talk_id).toBeNull();

      // LLM attempt should exist with correct metrics
      const attempt = getDb()
        .prepare('SELECT * FROM llm_attempts WHERE run_id = ?')
        .get(runId) as any;
      expect(attempt).toBeTruthy();
      expect(attempt.latency_ms).toBe(150);
      expect(attempt.input_tokens).toBe(10);
      expect(attempt.output_tokens).toBe(20);
      expect(attempt.estimated_cost_usd).toBe(0.001);
    });

    it('preserves zero-valued metrics without coercing to null', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      claimQueuedMainRuns(1);

      completeMainRunAtomic({
        runId,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'reply',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        latencyMs: 0,
        usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      });

      const attempt = getDb()
        .prepare('SELECT * FROM llm_attempts WHERE run_id = ?')
        .get(runId) as any;
      expect(attempt.latency_ms).toBe(0);
      expect(attempt.input_tokens).toBe(0);
      expect(attempt.output_tokens).toBe(0);
      expect(attempt.estimated_cost_usd).toBe(0);
    });

    it('returns applied=false if run is not running', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      // Don't claim — run is still queued

      const result = completeMainRunAtomic({
        runId,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'reply',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
      });
      expect(result.applied).toBe(false);
    });
  });

  describe('failMainRunAtomic', () => {
    it('fails a running run and emits terminal event', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      claimQueuedMainRuns(1);

      const result = failMainRunAtomic({
        runId,
        threadId,
        requestedBy: USER_A,
        errorCode: 'execution_failed',
        errorMessage: 'something went wrong',
      });

      expect(result.applied).toBe(true);

      const run = getTalkRunById(runId);
      expect(run?.status).toBe('failed');

      // Terminal event should be in outbox
      const event = getDb()
        .prepare(
          `SELECT * FROM event_outbox WHERE event_type = 'main_response_failed' AND topic = ?`,
        )
        .get(`user:${USER_A}`) as any;
      expect(event).toBeTruthy();
      const payload = JSON.parse(event.payload);
      expect(payload.runId).toBe(runId);
      expect(payload.errorCode).toBe('execution_failed');
    });
  });

  describe('failInterruptedMainRunsOnStartup', () => {
    it('fails running Main runs but not Talk runs', () => {
      const threadId = randomUUID();
      const runId = `run_${randomUUID()}`;
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId,
      });
      claimQueuedMainRuns(1);

      // Also insert a Talk run in running state
      upsertTalk({ id: 'talk-x', ownerId: USER_A, topicTitle: 'Test Talk' });
      const talkThreadId = getOrCreateDefaultThread('talk-x');
      getDb()
        .prepare(
          `INSERT INTO talk_runs (id, talk_id, thread_id, requested_by, status, started_at, created_at)
           VALUES (?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(
          'talk-run-x',
          'talk-x',
          talkThreadId,
          USER_A,
          new Date().toISOString(),
          new Date().toISOString(),
        );

      const result = failInterruptedMainRunsOnStartup();
      expect(result.failedRunIds).toContain(runId);
      expect(result.failedRunIds).not.toContain('talk-run-x');

      // Talk run should still be running
      const talkRun = getTalkRunById('talk-run-x');
      expect(talkRun?.status).toBe('running');
    });
  });
});

// ============================================================================
// Route Tests
// ============================================================================

describe('Main channel routes', () => {
  describe('listMainThreadsRoute', () => {
    it('returns 200 with user-scoped threads', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = listMainThreadsRoute(makeAuth(USER_A));
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data).toHaveLength(1);
        expect(result.body.data[0].threadId).toBe(threadId);
        expect(result.body.data[0].title).toBe('hello');
        expect(result.body.data[0].hasActiveRun).toBe(true);
      }
    });

    it('does not return threads owned by another user', () => {
      enqueueMainTurnAtomic({
        threadId: randomUUID(),
        userId: USER_A,
        content: 'a thread',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = listMainThreadsRoute(makeAuth(USER_B));
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data).toHaveLength(0);
      }
    });
  });

  describe('getMainThreadRoute', () => {
    it('returns 404 for thread owned by another user', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = getMainThreadRoute(makeAuth(USER_B), threadId);
      expect(result.statusCode).toBe(404);
    });

    it('returns 200 with messages for the owner', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'hello',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = getMainThreadRoute(makeAuth(USER_A), threadId);
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data.length).toBeGreaterThanOrEqual(1);
        expect(result.body.data[0].role).toBe('user');
        expect(result.body.data[0].content).toBe('hello');
      }
    });
  });

  describe('postMainMessageRoute', () => {
    it('returns 202 with messageId, threadId, runId', () => {
      const result = postMainMessageRoute(makeAuth(USER_A), {
        content: 'hello',
      });
      expect(result.statusCode).toBe(202);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data.messageId).toBeTruthy();
        expect(result.body.data.threadId).toBeTruthy();
        expect(result.body.data.runId).toBeTruthy();
        expect(result.body.data.title).toBe('hello');
      }
    });

    it('returns 400 for empty content', () => {
      const result = postMainMessageRoute(makeAuth(USER_A), { content: '' });
      expect(result.statusCode).toBe(400);
    });

    it('returns 409 with setup guidance when browser execution is not configured', () => {
      getDb()
        .prepare(
          `UPDATE registered_agents
           SET tool_permissions_json = ?
           WHERE id = 'agent.main'`,
        )
        .run(JSON.stringify({ web: true, browser: true }));

      const result = postMainMessageRoute(makeAuth(USER_A), {
        content: 'check my linkedin',
      });

      expect(result.statusCode).toBe(409);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) {
        expect(result.body.error.code).toBe('browser_execution_not_configured');
        expect(result.body.error.message).toContain(
          'Browser access is not configured',
        );
        expect(result.body.error.message).toContain('claude login');
      }
    });

    it('returns 404 when posting to thread owned by another user', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'first',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = postMainMessageRoute(makeAuth(USER_B), {
        content: 'intruder',
        threadId,
      });
      expect(result.statusCode).toBe(404);
    });

    it('returns 409 when thread is busy', () => {
      const threadId = randomUUID();
      // First message succeeds
      const r1 = postMainMessageRoute(makeAuth(USER_A), {
        content: 'first',
        threadId,
      });
      expect(r1.statusCode).toBe(202);

      // Second should get 409
      const r2 = postMainMessageRoute(makeAuth(USER_A), {
        content: 'second',
        threadId,
      });
      expect(r2.statusCode).toBe(409);
      expect(r2.body.ok).toBe(false);
      if (!r2.body.ok) {
        expect(r2.body.error.code).toBe('thread_busy');
      }
    });
  });

  describe('patchMainThreadRoute', () => {
    it('renames an owned thread and persists the title', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(makeAuth(USER_A), threadId, {
        title: 'Daily planning',
      });
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data.threadId).toBe(threadId);
        expect(result.body.data.title).toBe('Daily planning');
      }

      const listed = listMainThreadsRoute(makeAuth(USER_A));
      expect(listed.statusCode).toBe(200);
      expect(listed.body.ok).toBe(true);
      if (listed.body.ok) {
        expect(listed.body.data[0].title).toBe('Daily planning');
      }
    });

    it('updates pinned-only metadata on an owned thread', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(makeAuth(USER_A), threadId, {
        pinned: true,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data.isPinned).toBe(true);
      }
    });

    it('updates title and pinned together', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(makeAuth(USER_A), threadId, {
        title: 'Daily planning',
        pinned: true,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
      if (result.body.ok) {
        expect(result.body.data.title).toBe('Daily planning');
        expect(result.body.data.isPinned).toBe(true);
      }
    });

    it('rejects overlong thread titles with invalid_input', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(makeAuth(USER_A), threadId, {
        title: 'x'.repeat(121),
      });
      expect(result.statusCode).toBe(400);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) {
        expect(result.body.error.code).toBe('invalid_input');
      }
    });

    it('rejects patch bodies without title or pinned', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(makeAuth(USER_A), threadId, {});
      expect(result.statusCode).toBe(400);
      expect(result.body.ok).toBe(false);
    });

    it('maps accessor validation errors to invalid_input', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'draft agenda',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = patchMainThreadRoute(
        makeAuth(USER_A),
        threadId,
        { title: 'Valid title' },
        {
          updateMainThreadMetadata: () => {
            throw new ThreadTitleValidationError(
              'Thread title must be at most 120 characters',
            );
          },
        },
      );
      expect(result.statusCode).toBe(400);
      expect(result.body.ok).toBe(false);
      if (!result.body.ok) {
        expect(result.body.error.code).toBe('invalid_input');
      }
    });
  });

  describe('deleteMainThreadRoute', () => {
    it('deletes an owned thread', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'delete me',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });
      const claimed = claimQueuedMainRuns(1);
      completeMainRunAtomic({
        runId: claimed[0].id,
        threadId,
        requestedBy: USER_A,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: 'done',
        agentId: AGENT_ID,
        providerId: PROVIDER_ID,
        modelId: MODEL_ID,
        usage: { inputTokens: 1, outputTokens: 1 },
      });

      const result = deleteMainThreadRoute(makeAuth(USER_A), threadId);
      expect(result.statusCode).toBe(200);
      expect(result.body.ok).toBe(true);
    });

    it('returns 409 when deleting a busy thread', () => {
      const threadId = randomUUID();
      enqueueMainTurnAtomic({
        threadId,
        userId: USER_A,
        content: 'busy',
        messageId: `msg_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
      });

      const result = deleteMainThreadRoute(makeAuth(USER_A), threadId);
      expect(result.statusCode).toBe(409);
      expect(result.body.ok).toBe(false);
    });
  });
});
