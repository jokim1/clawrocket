import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  appendOutboxEvent,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('events routes', () => {
  let server: WebServerHandle;

  beforeEach(async () => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
    });

    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
    });

    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'member-1',
      role: 'viewer',
    });

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-member',
      userId: 'member-1',
      accessTokenHash: hashSessionToken('member-token'),
      refreshTokenHash: hashSessionToken('member-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ talkId: 'talk-1', messageId: 'm1' }),
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('returns talk-scoped stream only for authorized users', async () => {
    const ownerRes = await server.request('/api/v1/talks/talk-1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerStream = await ownerRes.text();
    expect(ownerStream).toContain('event: message_appended');

    const memberRes = await server.request(
      '/api/v1/talks/unknown-talk/events',
      {
        headers: {
          Authorization: 'Bearer member-token',
        },
      },
    );
    expect(memberRes.status).toBe(404);
  });

  it('supports Last-Event-ID replay semantics on user stream', async () => {
    const res = await server.request('/api/v1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
        'Last-Event-ID': '0',
      },
    });

    expect(res.status).toBe(200);
    const stream = await res.text();
    expect(stream).toContain('event: message_appended');
  });

  it('rejects malformed percent-encoding in talk id', async () => {
    const res = await server.request('/api/v1/talks/%ZZ/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_talk_id');
  });

  it('includes retry-after when user-scoped events stream is rate limited', async () => {
    await exhaustReadBucket(server, 'owner-token');

    const res = await server.request('/api/v1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });

  it('includes retry-after when talk-scoped events stream is rate limited', async () => {
    await exhaustReadBucket(server, 'owner-token');

    const res = await server.request('/api/v1/talks/talk-1/events', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

async function exhaustReadBucket(
  server: WebServerHandle,
  accessToken: string,
): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const res = await server.request('/api/v1/status', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
    expect(res.status).toBe(200);
  }
}
