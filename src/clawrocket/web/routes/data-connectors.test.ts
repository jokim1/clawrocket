import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  upsertTalk,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('data connector routes', () => {
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
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
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

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('creates connectors, stores credentials, and attaches them to talks', async () => {
    const createRes = await server.request('/api/v1/data-connectors', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'FTUE PostHog',
        connectorKind: 'posthog',
        config: {
          hostUrl: 'https://us.posthog.com',
          projectId: '12345',
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const createBody = (await createRes.json()) as any;
    expect(createBody.ok).toBe(true);
    expect(createBody.data.connector.name).toBe('FTUE PostHog');
    expect(createBody.data.connector.verificationStatus).toBe('missing');
    expect(createBody.data.connector.hasCredential).toBe(false);

    const connectorId = createBody.data.connector.id as string;

    const credentialRes = await server.request(
      `/api/v1/data-connectors/${encodeURIComponent(connectorId)}/credential`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: 'phc_test_key',
        }),
      },
    );
    expect(credentialRes.status).toBe(200);
    const credentialBody = (await credentialRes.json()) as any;
    expect(credentialBody.data.connector.hasCredential).toBe(true);
    expect(credentialBody.data.connector.verificationStatus).toBe(
      'not_verified',
    );

    const attachRes = await server.request(
      '/api/v1/talks/talk-owner/data-connectors',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectorId,
        }),
      },
    );
    expect(attachRes.status).toBe(200);
    const attachBody = (await attachRes.json()) as any;
    expect(attachBody.data.connector.id).toBe(connectorId);
    expect(attachBody.data.connector.attachedAt).toBeTruthy();

    const talkListRes = await server.request(
      '/api/v1/talks/talk-owner/data-connectors',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(talkListRes.status).toBe(200);
    const talkListBody = (await talkListRes.json()) as any;
    expect(talkListBody.data.connectors).toHaveLength(1);
    expect(talkListBody.data.connectors[0].name).toBe('FTUE PostHog');

    const listRes = await server.request('/api/v1/data-connectors', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.data.connectors).toHaveLength(1);
    expect(listBody.data.connectors[0].attachedTalkCount).toBe(1);
  });

  it('blocks members from managing org-level data connectors', async () => {
    const listRes = await server.request('/api/v1/data-connectors', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(listRes.status).toBe(403);

    const createRes = await server.request('/api/v1/data-connectors', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Blocked',
        connectorKind: 'posthog',
      }),
    });
    expect(createRes.status).toBe(403);
  });

  it('rejects empty talk attachment ids and direct Google credential saves', async () => {
    const createGoogleRes = await server.request('/api/v1/data-connectors', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Economy Sheet',
        connectorKind: 'google_sheets',
      }),
    });
    expect(createGoogleRes.status).toBe(201);
    const googleBody = (await createGoogleRes.json()) as any;
    const googleConnectorId = googleBody.data.connector.id as string;

    const credentialRes = await server.request(
      `/api/v1/data-connectors/${encodeURIComponent(googleConnectorId)}/credential`,
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          apiKey: 'should-not-work',
        }),
      },
    );
    expect(credentialRes.status).toBe(400);
    const credentialBody = (await credentialRes.json()) as any;
    expect(credentialBody.error.code).toBe('oauth_required');

    const attachRes = await server.request(
      '/api/v1/talks/talk-owner/data-connectors',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connectorId: '',
        }),
      },
    );
    expect(attachRes.status).toBe(400);
    const attachBody = (await attachRes.json()) as any;
    expect(attachBody.error.code).toBe('invalid_connector_id');
  });
});
