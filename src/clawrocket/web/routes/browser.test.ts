import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '../../../db.js';

const browserServiceMocks = vi.hoisted(() => ({
  service: {
    getSessionStatus: vi.fn(),
    getSessionTouchedRunIds: vi.fn(),
    resumeTakeover: vi.fn(),
  },
}));

vi.mock('../../browser/service.js', () => ({
  getBrowserService: () => browserServiceMocks.service,
}));

import {
  _initTestDatabase,
  enqueueMainTurnAtomic,
  getTalkRunById,
  upsertUser,
  updateTalkRunMetadata,
} from '../../db/index.js';
import {
  cancelConflictingBrowserRunRoute,
  getBrowserSessionStatusRoute,
  resumeBrowserBlockedRunRoute,
} from './browser.js';
import type { AuthContext } from '../types.js';

function makeAuth(userId: string): AuthContext {
  return {
    userId,
    sessionId: `session-${userId}`,
    role: 'owner',
    authType: 'cookie',
  };
}

describe('browser routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'user-a',
      email: 'a@example.com',
      displayName: 'User A',
      role: 'owner',
    });
    upsertUser({
      id: 'user-b',
      email: 'b@example.com',
      displayName: 'User B',
      role: 'owner',
    });

    browserServiceMocks.service.getSessionStatus.mockReset();
    browserServiceMocks.service.getSessionTouchedRunIds.mockReset();
    browserServiceMocks.service.resumeTakeover.mockReset();
    browserServiceMocks.service.resumeTakeover.mockResolvedValue(undefined);
  });

  it('returns browser session status for an authorized Main run owner', async () => {
    const runId = 'run-main-browser';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId,
    });

    browserServiceMocks.service.getSessionStatus.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: false,
      state: 'blocked',
      owner: 'agent',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
      currentTitle: 'Approve sign in',
      lastUpdatedAt: new Date().toISOString(),
    });
    browserServiceMocks.service.getSessionTouchedRunIds.mockReturnValue([
      runId,
    ]);

    const result = await getBrowserSessionStatusRoute({
      auth: makeAuth('user-a'),
      sessionId: 'session-1',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data).toMatchObject({
        sessionId: 'session-1',
        state: 'blocked',
        blockedKind: 'auth_required',
      });
    }
  });

  it('rejects browser session status for a different user', async () => {
    const runId = 'run-main-browser';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId,
    });

    browserServiceMocks.service.getSessionStatus.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: false,
      state: 'blocked',
      owner: 'agent',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/checkpoint/challenge',
      currentTitle: 'Approve sign in',
      lastUpdatedAt: new Date().toISOString(),
    });
    browserServiceMocks.service.getSessionTouchedRunIds.mockReturnValue([
      runId,
    ]);

    const result = await getBrowserSessionStatusRoute({
      auth: makeAuth('user-b'),
      sessionId: 'session-1',
    });

    expect(result.statusCode).toBe(404);
    expect(result.body.ok).toBe(false);
    if (!result.body.ok) {
      expect(result.body.error.code).toBe('browser_session_not_found');
    }
  });

  it('defers resume when another main run is queued', async () => {
    const pausedRunId = 'run-paused';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Check LinkedIn',
      messageId: 'msg-main-browser',
      runId: pausedRunId,
    });
    updateTalkRunMetadata(pausedRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(pausedRunId);

    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Second message',
      messageId: 'msg-main-browser-2',
      runId: 'run-queued',
    });

    const result = await resumeBrowserBlockedRunRoute({
      auth: makeAuth('user-a'),
      runId: pausedRunId,
      note: null,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.queueState).toBe('deferred');
    }
    const pausedRun = getTalkRunById(pausedRunId);
    expect(pausedRun?.status).toBe('awaiting_confirmation');
    const metadata = JSON.parse(pausedRun?.metadata_json || '{}') as {
      browserBlock?: unknown;
      resumeRequestedAt?: string;
    };
    expect(metadata.resumeRequestedAt).toBeTruthy();
    expect(metadata.browserBlock).toBeTruthy();
  });

  it('cancels the conflicting browser run and queues the waiting run', async () => {
    const ownerRunId = 'run-owner';
    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Open LinkedIn',
      messageId: 'msg-main-browser',
      runId: ownerRunId,
    });
    updateTalkRunMetadata(ownerRunId, (current) => ({
      ...current,
      browserBlock: {
        kind: 'auth_required',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message: 'Authenticate to continue.',
        riskReason: null,
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:00:00.000Z',
        updatedAt: '2026-03-21T20:00:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run(ownerRunId);

    enqueueMainTurnAtomic({
      threadId: 'thread-main-browser',
      userId: 'user-a',
      content: 'Try again',
      messageId: 'msg-main-browser-2',
      runId: 'run-waiting',
    });
    updateTalkRunMetadata('run-waiting', (current) => ({
      ...current,
      browserBlock: {
        kind: 'session_conflict',
        sessionId: 'session-1',
        siteKey: 'linkedin',
        accountLabel: null,
        conflictingRunId: ownerRunId,
        conflictingSessionId: 'session-1',
        conflictingRunSummary: 'Open LinkedIn',
        url: 'https://www.linkedin.com/login',
        title: 'LinkedIn Login',
        message:
          'Another paused browser task already owns the LinkedIn session.',
        riskReason: 'session_conflict',
        setupCommand: null,
        artifacts: [],
        confirmationId: null,
        pendingToolCall: null,
        createdAt: '2026-03-21T20:01:00.000Z',
        updatedAt: '2026-03-21T20:01:00.000Z',
      },
    }));
    getDb()
      .prepare(
        `UPDATE talk_runs SET status = 'awaiting_confirmation' WHERE id = ?`,
      )
      .run('run-waiting');

    const result = await cancelConflictingBrowserRunRoute({
      auth: makeAuth('user-a'),
      runId: 'run-waiting',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(getTalkRunById(ownerRunId)?.status).toBe('cancelled');
    expect(getTalkRunById('run-waiting')?.status).toBe('queued');
  });
});
