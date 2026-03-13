import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createTalkActionConfirmation,
  createTalk,
  createTalkRun,
  listTalkResourceBindings,
  listTalkToolGrants,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

describe('tool manager routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    vi.restoreAllMocks();

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

    createTalk({
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Accounting',
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes default Talk tool grants on talk creation', () => {
    const grants = listTalkToolGrants('talk-owner');
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.find((grant) => grant.toolId === 'web_search')?.enabled).toBe(
      true,
    );
    expect(grants.find((grant) => grant.toolId === 'gmail_send')?.enabled).toBe(
      false,
    );
  });

  it('exposes talk tools, updates grants, and manages Drive bindings', async () => {
    const initialToolsRes = await server.request('/api/v1/talks/talk-owner/tools', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(initialToolsRes.status).toBe(200);
    const initialToolsBody = (await initialToolsRes.json()) as any;
    expect(initialToolsBody.ok).toBe(true);
    expect(initialToolsBody.data.summary).toContain(
      'Google Drive unavailable — bind a file or folder to enable',
    );

    const updateRes = await server.request('/api/v1/talks/talk-owner/tools', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grants: [
          { toolId: 'gmail_send', enabled: true },
          { toolId: 'gmail_read', enabled: true },
          { toolId: 'web_search', enabled: true },
        ],
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as any;
    expect(updateBody.data.grants.find((grant: any) => grant.toolId === 'gmail_send')?.enabled).toBe(
      true,
    );
    expect(updateBody.data.grants.find((grant: any) => grant.toolId === 'web_search')?.enabled).toBe(
      true,
    );

    const bindRes = await server.request(
      '/api/v1/talks/talk-owner/resources/google-drive',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bindingKind: 'google_drive_folder',
          externalId: 'folder-123',
          displayName: 'Accounting',
        }),
      },
    );
    expect(bindRes.status).toBe(201);
    expect(listTalkResourceBindings('talk-owner')).toHaveLength(1);

    const resourcesRes = await server.request('/api/v1/talks/talk-owner/resources', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(resourcesRes.status).toBe(200);
    const resourcesBody = (await resourcesRes.json()) as any;
    expect(resourcesBody.data.bindings[0].displayName).toBe('Accounting');

    const deleteRes = await server.request(
      `/api/v1/talks/talk-owner/resources/${resourcesBody.data.bindings[0].id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(deleteRes.status).toBe(200);
    expect(listTalkResourceBindings('talk-owner')).toHaveLength(0);
  });

  it('connects a placeholder Google account without trusting client credential data', async () => {
    const initialRes = await server.request('/api/v1/me/google-account', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(initialRes.status).toBe(200);
    const initialBody = (await initialRes.json()) as any;
    expect(initialBody.data.googleAccount.connected).toBe(false);

    const connectRes = await server.request('/api/v1/me/google-account/connect', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        googleSubject: 'forged-subject',
        email: 'forged@example.com',
        scopes: ['drive.readonly'],
        ciphertext: 'forged-ciphertext',
      }),
    });
    expect(connectRes.status).toBe(200);
    const connectBody = (await connectRes.json()) as any;
    expect(connectBody.data.googleAccount.connected).toBe(true);
    expect(connectBody.data.googleAccount.email).toBe('owner@example.com');
    expect(connectBody.data.googleAccount.scopes).toEqual([]);

    const expandRes = await server.request(
      '/api/v1/me/google-account/expand-scopes',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          scopes: ['gmail.send'],
        }),
      },
    );
    expect(expandRes.status).toBe(400);
    const expandBody = (await expandRes.json()) as any;
    expect(expandBody.error.code).toBe('oauth_not_configured');
  });

  it('allows the triggering user to approve and reject Talk confirmations', async () => {
    createTalkRun({
      id: 'run-confirm-1',
      talk_id: 'talk-owner',
      requested_by: 'owner-1',
      status: 'awaiting_confirmation',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2026-03-06T00:00:00.000Z',
      started_at: '2026-03-06T00:00:01.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    const confirmation = createTalkActionConfirmation({
      talkId: 'talk-owner',
      runId: 'run-confirm-1',
      toolName: 'gmail_send_email',
      confirmationType: 'mutation',
      proposedArgs: {
        to: ['alice@example.com'],
        subject: 'Q4 Financials',
      },
      requestedBy: 'owner-1',
    });

    const approveRes = await server.request(
      `/api/v1/talks/talk-owner/runs/run-confirm-1/confirmations/${confirmation.id}/approve`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          modifiedArgs: {
            subject: 'Updated Q4 Financials',
          },
        }),
      },
    );
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as any;
    expect(approveBody.data.confirmation.status).toBe(
      'approved_pending_execution',
    );
    expect(approveBody.data.confirmation.modifiedArgs.subject).toBe(
      'Updated Q4 Financials',
    );

    createTalkRun({
      id: 'run-confirm-2',
      talk_id: 'talk-owner',
      requested_by: 'owner-1',
      status: 'awaiting_confirmation',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2026-03-06T00:01:00.000Z',
      started_at: '2026-03-06T00:01:01.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    const pendingRejection = createTalkActionConfirmation({
      talkId: 'talk-owner',
      runId: 'run-confirm-2',
      toolName: 'google_docs_batch_update',
      confirmationType: 'mutation',
      proposedArgs: {
        fileId: 'doc-1',
      },
      requestedBy: 'owner-1',
    });

    const rejectRes = await server.request(
      `/api/v1/talks/talk-owner/runs/run-confirm-2/confirmations/${pendingRejection.id}/reject`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Needs a manual review first.',
        }),
      },
    );
    expect(rejectRes.status).toBe(200);
    const rejectBody = (await rejectRes.json()) as any;
    expect(rejectBody.data.confirmation.status).toBe('rejected');
    expect(rejectBody.data.confirmation.errorCategory).toBe('user_declined');
  });

  it('restricts server tool registry management to owners and admins', async () => {
    const memberRes = await server.request('/api/v1/settings/tools', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(403);

    const ownerRes = await server.request('/api/v1/settings/tools', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    expect(ownerBody.data.registry.some((entry: any) => entry.id === 'web_search')).toBe(
      true,
    );
  });
});
