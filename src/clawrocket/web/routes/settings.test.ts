import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

describe('settings routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    delete process.env.CLAWROCKET_SELF_RESTART;

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'admin-1',
      email: 'admin@example.com',
      displayName: 'Admin',
      role: 'admin',
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
      id: 's-admin',
      userId: 'admin-1',
      accessTokenHash: hashSessionToken('admin-token'),
      refreshTokenHash: hashSessionToken('admin-refresh'),
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

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.CLAWROCKET_SELF_RESTART;
  });

  it('applies owner/admin RBAC and never returns secret values', async () => {
    const memberRes = await server.request('/api/v1/settings/executor', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(403);

    const updateRes = await server.request('/api/v1/settings/executor', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'settings-save-1',
      },
      body: JSON.stringify({
        anthropicApiKey: 'sk-test',
        anthropicBaseUrl: 'https://api.example.test',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      }),
    });
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as any;
    expect(updateBody.ok).toBe(true);
    expect(updateBody.data.hasApiKey).toBe(true);
    expect(updateBody.data.anthropicApiKey).toBeUndefined();
    expect(updateBody.data.configVersion).toBe(1);

    const ownerRes = await server.request('/api/v1/settings/executor', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    expect(ownerBody.data.hasApiKey).toBe(true);
    expect(ownerBody.data.anthropicBaseUrl).toBe('https://api.example.test');
    expect(ownerBody.data.defaultAlias).toBe('Gemini');
    expect(ownerBody.data.configErrors).toEqual([]);

    const statusRes = await server.request('/api/v1/settings/executor-status', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as any;
    expect(statusBody.data.pendingRestartReasons).toContain(
      'Alias model map changed',
    );
    expect(statusBody.data.pendingRestartReasons).toContain(
      'Default alias changed from Mock to Gemini',
    );
  });

  it('gates restart to owners and explicit self-restart support', async () => {
    const adminRes = await server.request('/api/v1/settings/restart', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Idempotency-Key': 'restart-admin-1',
      },
    });
    expect(adminRes.status).toBe(403);

    const unsupportedRes = await server.request('/api/v1/settings/restart', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Idempotency-Key': 'restart-owner-unsupported',
      },
    });
    expect(unsupportedRes.status).toBe(409);

    process.env.CLAWROCKET_SELF_RESTART = '1';
    vi.useFakeTimers();
    vi.advanceTimersByTime(11_000);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const supportedRes = await server.request('/api/v1/settings/restart', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Idempotency-Key': 'restart-owner-supported',
      },
    });
    expect(supportedRes.status).toBe(200);
    const supportedBody = (await supportedRes.json()) as any;
    expect(supportedBody.ok).toBe(true);
    expect(supportedBody.data.status).toBe('restarting');

    await vi.runAllTimersAsync();
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });
});
