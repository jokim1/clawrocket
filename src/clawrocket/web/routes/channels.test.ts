import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  ensureSystemManagedTelegramConnection,
  upsertChannelTarget,
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

    upsertWebSession({
      id: 's-viewer',
      userId: 'viewer-1',
      accessTokenHash: hashSessionToken('viewer-token'),
      refreshTokenHash: hashSessionToken('viewer-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    ensureSystemManagedTelegramConnection();
    upsertChannelTarget({
      connectionId: 'channel-conn:telegram:system',
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Gamemakers Chat',
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

  it('lists channel connections for owners', async () => {
    const res = await server.request('/api/v1/channel-connections', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'channel-conn:telegram:system',
          platform: 'telegram',
        }),
      ]),
    );
  });

  it('forbids channel connection listing for non-admin talk members', async () => {
    const res = await server.request('/api/v1/channel-connections', {
      method: 'GET',
      headers: authHeaders('viewer-token'),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('forbidden');
  });

  it('lists cached channel targets for owners', async () => {
    const res = await server.request(
      '/api/v1/channel-connections/channel-conn%3Atelegram%3Asystem/targets?query=game',
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.targets).toEqual([
      expect.objectContaining({
        connection_id: 'channel-conn:telegram:system',
        target_id: 'tg:chat:123',
        display_name: 'Gamemakers Chat',
      }),
    ]);
  });
});
