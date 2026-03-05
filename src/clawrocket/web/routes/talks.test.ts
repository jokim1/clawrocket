import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getQueuedTalkRuns,
  getRunningTalkRun,
  upsertTalk,
  upsertTalkLlmPolicy,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('talk routes', () => {
  let server: WebServerHandle;
  let wakeCalls = 0;
  let abortCalls: string[] = [];

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
    upsertUser({
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'member',
    });
    upsertUser({
      id: 'outsider-1',
      email: 'outsider@example.com',
      displayName: 'Outsider',
      role: 'member',
    });

    upsertTalk({
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
    });
    upsertTalk({
      id: 'talk-member',
      ownerId: 'member-1',
      topicTitle: 'Member Talk',
    });
    upsertTalk({
      id: 'talk-private',
      ownerId: 'owner-1',
      topicTitle: 'Private Talk',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-owner',
      llmPolicy: '{"agents":["Gemini","Opus4.6"]}',
    });

    upsertTalkMember({
      talkId: 'talk-owner',
      userId: 'member-1',
      role: 'editor',
    });
    upsertTalkMember({
      talkId: 'talk-owner',
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
    upsertWebSession({
      id: 's-member',
      userId: 'member-1',
      accessTokenHash: hashSessionToken('member-token'),
      refreshTokenHash: hashSessionToken('member-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-viewer',
      userId: 'viewer-1',
      accessTokenHash: hashSessionToken('viewer-token'),
      refreshTokenHash: hashSessionToken('viewer-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-outsider',
      userId: 'outsider-1',
      accessTokenHash: hashSessionToken('outsider-token'),
      refreshTokenHash: hashSessionToken('outsider-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    wakeCalls = 0;
    abortCalls = [];
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      runWorker: {
        wake: () => {
          wakeCalls += 1;
        },
        abortTalk: (talkId: string) => {
          abortCalls.push(talkId);
        },
      },
    });
  });

  it('lists talks scoped to the authenticated user', async () => {
    const memberRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as any;
    expect(memberBody.ok).toBe(true);
    expect(memberBody.data.talks.map((talk: any) => talk.id).sort()).toEqual([
      'talk-member',
      'talk-owner',
    ]);
    const sharedTalk = memberBody.data.talks.find(
      (talk: any) => talk.id === 'talk-owner',
    );
    expect(sharedTalk.agents).toEqual(['Gemini', 'Opus4.6']);

    const ownerRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    expect(ownerBody.data.talks).toHaveLength(3);
  });

  it('normalizes talk list pagination in query and response metadata', async () => {
    const res = await server.request('/api/v1/talks?limit=500&offset=1', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.page.limit).toBe(200);
    expect(body.data.page.offset).toBe(1);
    expect(body.data.page.count).toBe(2);
  });

  it('creates a talk and supports idempotent replay', async () => {
    const first = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-1',
      },
      body: JSON.stringify({ title: 'Roadmap' }),
    });

    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.talk.title).toBe('Roadmap');
    const talkId = firstBody.data.talk.id as string;

    const replay = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-1',
      },
      body: JSON.stringify({ title: 'Roadmap' }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    const replayBody = (await replay.json()) as any;
    expect(replayBody.data.talk.id).toBe(talkId);

    const detail = await server.request(`/api/v1/talks/${talkId}`, {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(detail.status).toBe(200);
  });

  it('requires csrf for cookie-authenticated create talk', async () => {
    const res = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Cookie: 'cr_access_token=owner-token; cr_csrf_token=csrf-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Cookie Talk' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('csrf_failed');
  });

  it('returns talk detail only for authorized users', async () => {
    const memberRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(200);

    const outsiderRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer outsider-token',
      },
    });
    expect(outsiderRes.status).toBe(404);
  });

  it('enqueues chat runs and persists user messages', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'First message' }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.run.status).toBe('running');

    const second = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Second message' }),
    });
    expect(second.status).toBe(202);
    const secondBody = (await second.json()) as any;
    expect(secondBody.data.run.status).toBe('queued');

    const messagesRes = await server.request(
      '/api/v1/talks/talk-owner/messages',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as any;
    expect(messagesBody.data.messages.map((m: any) => m.content)).toEqual([
      'First message',
      'Second message',
    ]);

    expect(getRunningTalkRun('talk-owner')?.id).toBe(firstBody.data.run.id);
    expect(getQueuedTalkRuns('talk-owner').map((row) => row.id)).toEqual([
      secondBody.data.run.id,
    ]);
    expect(wakeCalls).toBe(2);
  });

  it('requires editor permission to enqueue chat', async () => {
    const viewerRes = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'viewer message' }),
    });
    expect(viewerRes.status).toBe(403);
    const viewerBody = (await viewerRes.json()) as any;
    expect(viewerBody.ok).toBe(false);
    expect(viewerBody.error.code).toBe('forbidden');

    const editorRes = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'editor message' }),
    });
    expect(editorRes.status).toBe(202);
  });

  it('supports chat idempotent replay', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-chat-1',
      },
      body: JSON.stringify({ content: 'Hello idempotent world' }),
    });
    expect(first.status).toBe(202);

    const replay = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-chat-1',
      },
      body: JSON.stringify({ content: 'Hello idempotent world' }),
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');

    const messagesRes = await server.request(
      '/api/v1/talks/talk-owner/messages',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    const messagesBody = (await messagesRes.json()) as any;
    expect(
      messagesBody.data.messages.filter(
        (message: any) => message.content === 'Hello idempotent world',
      ),
    ).toHaveLength(1);
    expect(wakeCalls).toBe(1);
  });

  it('rejects oversized chat content with message_too_large', async () => {
    const oversized = 'x'.repeat(20_001);
    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: oversized }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('message_too_large');
  });

  it('supports cancel on existing talk and validates talk id encoding', async () => {
    const queued = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Cancelable message' }),
    });
    expect(queued.status).toBe(202);

    const cancelRes = await server.request(
      '/api/v1/talks/talk-owner/chat/cancel',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(cancelRes.status).toBe(200);
    expect(abortCalls).toEqual(['talk-owner']);

    const badTalkRes = await server.request('/api/v1/talks/%ZZ/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'bad path' }),
    });
    expect(badTalkRes.status).toBe(400);
    const badTalkBody = (await badTalkRes.json()) as any;
    expect(badTalkBody.error.code).toBe('invalid_talk_id');
  });
});
