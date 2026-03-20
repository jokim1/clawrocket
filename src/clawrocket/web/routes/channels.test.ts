import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as telegramConnector from '../../channels/telegram-connector.js';
import { setTalkAgents } from '../../agents/agent-registry.js';
import {
  _initTestDatabase,
  createRegisteredAgent,
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
import { saveTelegramChannelConnectorTokenRoute } from './channels.js';

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
    const registeredAgent = createRegisteredAgent({
      name: 'Default Agent',
      providerId: 'openai',
      modelId: 'gpt-5-mini',
    });
    setTalkAgents('talk-1', [
      {
        id: registeredAgent.id,
        sourceKind: 'provider',
        providerId: 'openai',
        modelId: 'gpt-5-mini',
        nickname: 'Default Agent',
        nicknameMode: 'auto',
        personaRole: 'General',
        isPrimary: true,
        sortOrder: 0,
      },
    ]);

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

  it('lists the Telegram connector state for owners', async () => {
    const res = await server.request('/api/v1/channel-connectors/telegram', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.connection).toEqual(
      expect.objectContaining({
        id: 'channel-conn:telegram:system',
        platform: 'telegram',
        token_source: 'missing',
      }),
    );
    expect(body.data.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target_id: 'tg:chat:123',
          approved: 0,
        }),
      ]),
    );
  });

  it('approves discovered telegram destinations through the connector route', async () => {
    const res = await server.request(
      '/api/v1/channel-connectors/telegram/targets/approve',
      {
        method: 'POST',
        headers: {
          ...authHeaders('owner-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetKind: 'chat',
          targetId: 'tg:chat:123',
          displayName: 'Gamemakers Chat',
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.target).toEqual(
      expect.objectContaining({
        target_id: 'tg:chat:123',
        approved: 1,
        registered_by: 'owner-1',
      }),
    );

    const filtered = await server.request(
      '/api/v1/channel-connections/channel-conn%3Atelegram%3Asystem/targets?approval=approved',
      {
        method: 'GET',
        headers: authHeaders('owner-token'),
      },
    );
    expect(filtered.status).toBe(200);
    const filteredBody = (await filtered.json()) as any;
    expect(filteredBody.data.targets).toEqual([
      expect.objectContaining({
        target_id: 'tg:chat:123',
        approved: 1,
      }),
    ]);
  });

  it('rejects talk channel bindings for unapproved targets', async () => {
    const res = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: 'channel-conn:telegram:system',
        targetKind: 'chat',
        targetId: 'tg:chat:123',
        displayName: 'Gamemakers Chat',
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('target_not_approved');
  });

  it('deactivates existing bindings when a telegram target is unapproved', async () => {
    await server.request(
      '/api/v1/channel-connectors/telegram/targets/approve',
      {
        method: 'POST',
        headers: {
          ...authHeaders('owner-token'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          targetKind: 'chat',
          targetId: 'tg:chat:123',
          displayName: 'Gamemakers Chat',
        }),
      },
    );

    const created = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'POST',
      headers: {
        ...authHeaders('owner-token'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        connectionId: 'channel-conn:telegram:system',
        targetKind: 'chat',
        targetId: 'tg:chat:123',
        displayName: 'Gamemakers Chat',
      }),
    });
    expect(created.status).toBe(201);

    const removed = await server.request(
      '/api/v1/channel-connectors/telegram/targets/chat/tg%3Achat%3A123/approval',
      {
        method: 'DELETE',
        headers: authHeaders('owner-token'),
      },
    );
    expect(removed.status).toBe(200);
    const removedBody = (await removed.json()) as any;
    expect(removedBody.data.deactivatedBindingCount).toBe(1);

    const bindings = await server.request('/api/v1/talks/talk-1/channels', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });
    expect(bindings.status).toBe(200);
    const bindingsBody = (await bindings.json()) as any;
    expect(bindingsBody.data.bindings).toEqual([
      expect.objectContaining({
        targetId: 'tg:chat:123',
        active: false,
      }),
    ]);
  });

  it('passes the validated bot identity through to the reload callback when saving a token', async () => {
    const validatedBot = {
      botUserId: 12345,
      botUsername: 'clawtalk_bot',
      botDisplayName: 'ClawTalk',
      canJoinGroups: true,
    };
    const probeSpy = vi
      .spyOn(telegramConnector, 'probeTelegramBotToken')
      .mockResolvedValue(validatedBot);
    const reloadConnector = vi.fn().mockResolvedValue(undefined);

    const result = await saveTelegramChannelConnectorTokenRoute({
      auth: {
        sessionId: 's-owner',
        userId: 'owner-1',
        role: 'owner',
        authType: 'bearer',
      },
      botToken: '12345:AAATESTTOKEN',
      reloadConnector,
    });

    expect(result.statusCode).toBe(200);
    expect(probeSpy).toHaveBeenCalledTimes(1);
    expect(reloadConnector).toHaveBeenCalledWith({
      validatedBot,
    });
  });
});
