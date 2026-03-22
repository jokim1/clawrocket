import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserServiceMocks = vi.hoisted(() => ({
  service: {
    getSessionStatus: vi.fn(),
    getSessionTouchedRunIds: vi.fn(),
  },
}));

vi.mock('../../browser/service.js', () => ({
  getBrowserService: () => browserServiceMocks.service,
}));

import {
  _initTestDatabase,
  enqueueMainTurnAtomic,
  upsertUser,
} from '../../db/index.js';
import { getBrowserSessionStatusRoute } from './browser.js';
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
});
