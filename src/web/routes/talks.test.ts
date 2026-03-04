import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  upsertTalk,
  upsertUser,
  upsertWebSession,
} from '../../db.js';
import { hashSessionToken } from '../../identity/session.js';
import { TalkRunQueue } from '../../talks/run-queue.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('talk routes', () => {
  let server: WebServerHandle;
  let runQueue: TalkRunQueue;

  beforeEach(async () => {
    _initTestDatabase();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Main Talk',
    });

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    runQueue = new TalkRunQueue();
    runQueue.enqueue({
      runId: 'run-1',
      talkId: 'talk-1',
      requestedBy: 'owner-1',
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      runQueue,
    });
  });

  it('allows cancel without Idempotency-Key header', async () => {
    const res = await server.request('/api/v1/talks/talk-1/chat/cancel', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('x-idempotent-replay')).toBeNull();
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
  });

  it('cancels active talk run and supports idempotent replay', async () => {
    const first = await server.request('/api/v1/talks/talk-1/chat/cancel', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Idempotency-Key': 'idem-cancel-1',
      },
    });

    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.cancelledRuns).toBe(1);

    const replay = await server.request('/api/v1/talks/talk-1/chat/cancel', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Idempotency-Key': 'idem-cancel-1',
      },
    });

    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
  });

  it('requires csrf for cookie-authenticated writes', async () => {
    const res = await server.request('/api/v1/talks/talk-1/chat/cancel', {
      method: 'POST',
      headers: {
        Cookie: 'cr_access_token=owner-token; cr_csrf_token=csrf-a',
        'Idempotency-Key': 'idem-cookie-1',
      },
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('csrf_failed');
  });

  it('rejects oversized request bodies', async () => {
    const hugeBody = 'x'.repeat(10 * 1024 * 1024 + 1);
    const res = await server.request('/api/v1/talks/talk-1/chat/cancel', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
      },
      body: hugeBody,
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('rejects malformed percent-encoding in talk id', async () => {
    const res = await server.request('/api/v1/talks/%ZZ/chat/cancel', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('invalid_talk_id');
  });
});
