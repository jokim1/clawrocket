import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, type WebServerHandle } from '../server.js';

const BOOTSTRAP_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
] as const;

describe('settings routes', () => {
  let server: WebServerHandle;
  let savedBootstrapEnv: Partial<
    Record<(typeof BOOTSTRAP_ENV_KEYS)[number], string>
  >;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    delete process.env.CLAWROCKET_SELF_RESTART;
    savedBootstrapEnv = {};
    for (const key of BOOTSTRAP_ENV_KEYS) {
      if (process.env[key] !== undefined) {
        savedBootstrapEnv[key] = process.env[key];
      }
      delete process.env[key];
    }

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
    for (const key of BOOTSTRAP_ENV_KEYS) {
      const value = savedBootstrapEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('applies owner/admin RBAC and never returns secret values', async () => {
    const memberRes = await server.request('/api/v1/settings/executor', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(403);

    const initialOwnerRes = await server.request('/api/v1/settings/executor', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(initialOwnerRes.status).toBe(200);
    const initialOwnerBody = (await initialOwnerRes.json()) as any;
    const initialConfigVersion = initialOwnerBody.data.configVersion;

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
    expect(updateBody.data.configVersion).toBe(initialConfigVersion + 1);

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

  it('starts async executor verification for owners and admins', async () => {
    const scheduleVerification = vi.fn(() => ({
      scheduled: true,
      mode: 'subscription',
      code: 'scheduled',
      message: 'Verification started.',
    }));
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      executorVerifier: {
        scheduleVerification,
      } as any,
    });

    const response = await server.request('/api/v1/settings/executor/verify', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Idempotency-Key': 'verify-owner-1',
      },
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.scheduled).toBe(true);
    expect(scheduleVerification).toHaveBeenCalledTimes(1);
  });

  it('returns subscription host status with service-user context', async () => {
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      subscriptionHostAuth: {
        async getStatusView() {
          return {
            serviceUser: 'clawrocket',
            serviceUid: 1001,
            serviceHomePath: '/srv/clawrocket',
            runtimeContext: 'systemd',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: false,
            importAvailable: false,
            hostCredentialFingerprint: null,
            message: 'Host login detected.',
            recommendedCommands: ['sudo -u clawrocket -H claude login'],
          };
        },
      } as any,
    });

    const response = await server.request(
      '/api/v1/settings/executor/subscription-host-status',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.serviceUser).toBe('clawrocket');
    expect(body.data.runtimeContext).toBe('systemd');
    expect(body.data.recommendedCommands[0]).toContain('sudo -u clawrocket');
  });

  it('imports a host subscription credential and persists subscription mode', async () => {
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      subscriptionHostAuth: {
        async getStatusView() {
          return {
            serviceUser: 'clawrocket',
            serviceUid: 1001,
            serviceHomePath: '/srv/clawrocket',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: true,
            importAvailable: true,
            hostCredentialFingerprint: 'fingerprint-1',
            message: 'Ready to import.',
            recommendedCommands: [],
          };
        },
        async probeImportSource() {
          return {
            serviceUser: 'clawrocket',
            serviceUid: 1001,
            serviceHomePath: '/srv/clawrocket',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: true,
            importAvailable: true,
            hostCredentialFingerprint: 'fingerprint-1',
            message: 'Ready to import.',
            recommendedCommands: [],
            importSource: 'service_env',
            importCredential: 'oauth-imported',
          };
        },
      } as any,
    });

    const response = await server.request(
      '/api/v1/settings/executor/subscription/import',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'subscription-import-1',
        },
        body: JSON.stringify({
          expectedFingerprint: 'fingerprint-1',
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('imported');
    expect(body.data.settings.executorAuthMode).toBe('subscription');
    expect(body.data.settings.hasOauthToken).toBe(true);
  });

  it('returns no_change when the imported subscription credential already matches settings', async () => {
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      subscriptionHostAuth: {
        async getStatusView() {
          throw new Error('unused');
        },
        async probeImportSource() {
          return {
            serviceUser: 'clawrocket',
            serviceUid: 1001,
            serviceHomePath: '/srv/clawrocket',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: true,
            importAvailable: true,
            hostCredentialFingerprint: 'fingerprint-1',
            message: 'Ready to import.',
            recommendedCommands: [],
            importSource: 'service_env',
            importCredential: 'oauth-imported',
          };
        },
      } as any,
    });

    const firstResponse = await server.request(
      '/api/v1/settings/executor/subscription/import',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'subscription-import-initial',
        },
        body: JSON.stringify({
          expectedFingerprint: 'fingerprint-1',
        }),
      },
    );
    expect(firstResponse.status).toBe(200);

    const response = await server.request(
      '/api/v1/settings/executor/subscription/import',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'subscription-import-no-change',
        },
        body: JSON.stringify({
          expectedFingerprint: 'fingerprint-1',
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('no_change');
    expect(body.data.settings.executorAuthMode).toBe('subscription');
    expect(body.data.settings.hasOauthToken).toBe(true);
  });

  it('rejects stale host import attempts when the fingerprint changed', async () => {
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      subscriptionHostAuth: {
        async getStatusView() {
          throw new Error('unused');
        },
        async probeImportSource() {
          return {
            serviceUser: 'clawrocket',
            serviceUid: 1001,
            serviceHomePath: '/srv/clawrocket',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: true,
            importAvailable: true,
            hostCredentialFingerprint: 'fresh-fingerprint',
            message: 'Ready to import.',
            recommendedCommands: [],
            importSource: 'service_env',
            importCredential: 'oauth-imported',
          };
        },
      } as any,
    });

    const response = await server.request(
      '/api/v1/settings/executor/subscription/import',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'subscription-import-stale',
        },
        body: JSON.stringify({
          expectedFingerprint: 'stale-fingerprint',
        }),
      },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('host_state_changed');
  });
});
