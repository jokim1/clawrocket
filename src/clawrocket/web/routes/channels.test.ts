import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
  };
}

describe('talk channel routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Channels Route Test',
    });
    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'viewer-1',
      role: 'viewer',
    });

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('lists talk channel bindings for authenticated talk members', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.talkId).toBe('talk-1');
    expect(body.data.bindings).toEqual([]);
  });

  it('returns 401 for unauthenticated channel list requests', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
    });

    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
  });
});
