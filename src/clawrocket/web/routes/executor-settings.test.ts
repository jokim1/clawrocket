import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../db.js';
import {
  _initTestDatabase,
  getSettingValue,
  upsertSettingValue,
  upsertUser,
} from '../../db/index.js';
import { ExecutorSubscriptionHostAuthService } from '../../talks/executor-subscription-host-auth.js';
import type { AuthContext } from '../types.js';
import {
  _resetExecutorVerificationSingleFlightForTests,
  getExecutorSettingsRoute,
  importExecutorSubscriptionRoute,
  putExecutorSettingsRoute,
  verifyExecutorRoute,
} from './executor-settings.js';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId: 'owner-1',
  role: 'owner',
  authType: 'bearer',
};

function seedAnthropicSecret(apiKey = 'sk-ant-test'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES ('provider.anthropic', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(JSON.stringify({ apiKey }), now, auth.userId);
}

describe('executor-settings routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetExecutorVerificationSingleFlightForTests();
    upsertUser({
      id: auth.userId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  afterEach(() => {
    _resetExecutorVerificationSingleFlightForTests();
  });

  it('reports stale subscription configs as not_verified until runtime verification runs', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: auth.userId,
    });

    const result = getExecutorSettingsRoute(auth);
    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.verificationStatus).toBe('not_verified');
    }
  });

  it('re-validates api_key mode before reporting verified and stores direct-http verification metadata', async () => {
    seedAnthropicSecret();
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.verificationStatus',
      value: 'verified',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.lastVerificationMethod',
      value: 'subscription_container_runtime',
      updatedBy: auth.userId,
    });

    const staleResult = getExecutorSettingsRoute(auth);
    expect(staleResult.statusCode).toBe(200);
    expect(staleResult.body.ok).toBe(true);
    if (staleResult.body.ok) {
      expect(staleResult.body.data.verificationStatus).toBe('not_verified');
    }

    const verifyResult = await verifyExecutorRoute(auth, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    expect(verifyResult.statusCode).toBe(200);
    expect(verifyResult.body.ok).toBe(true);
    if (verifyResult.body.ok) {
      expect(verifyResult.body.data.code).toBe('verified');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('verified');
    expect(getSettingValue('executor.lastVerificationMode')).toBe('api_key');
    expect(getSettingValue('executor.lastVerificationMethod')).toBe(
      'anthropic_messages_direct_http',
    );
  });

  it('honors null clear semantics for executor credentials', () => {
    seedAnthropicSecret();
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.anthropicAuthToken',
      value: 'auth-token-123',
      updatedBy: auth.userId,
    });

    const result = putExecutorSettingsRoute(auth, {
      executorAuthMode: 'none',
      anthropicApiKey: null,
      claudeOauthToken: null,
      anthropicAuthToken: null,
    });

    expect(result.statusCode).toBe(200);
    expect(getSettingValue('executor.claudeOauthToken')).toBeNull();
    expect(getSettingValue('executor.anthropicAuthToken')).toBeNull();
    expect(
      getDb()
        .prepare(
          `SELECT 1 FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic'`,
        )
        .get(),
    ).toBeUndefined();
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.activeCredentialConfigured).toBe(false);
      expect(result.body.data.verificationStatus).toBe('missing');
    }
  });

  it('imports a host subscription credential only when the fingerprint matches', async () => {
    const hostAuthService = new ExecutorSubscriptionHostAuthService({
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-host-token',
      },
      serviceUser: 'owner',
      serviceHomePath: '/home/owner',
    });
    const probe = await hostAuthService.probeImportSource();
    expect(probe.hostCredentialFingerprint).toBeTruthy();

    const result = await importExecutorSubscriptionRoute(
      auth,
      {
        expectedFingerprint: probe.hostCredentialFingerprint,
      },
      { hostAuthService },
    );

    expect(result.statusCode).toBe(200);
    expect(getSettingValue('executor.authMode')).toBe('subscription');
    expect(getSettingValue('executor.claudeOauthToken')).toBe(
      'oauth-host-token',
    );
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.status).toBe('imported');
      expect(result.body.data.settings.verificationStatus).toBe('not_verified');
    }
  });

  it('verifies subscription runtime and stores verified metadata', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    const result = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'verified',
        code: 'verified',
        message: 'Subscription runtime verified.',
      }),
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(result.body.data.code).toBe('verified');
    }
    expect(getSettingValue('executor.verificationStatus')).toBe('verified');
    expect(getSettingValue('executor.lastVerificationMode')).toBe(
      'subscription',
    );
    expect(getSettingValue('executor.lastVerificationMethod')).toBe(
      'subscription_container_runtime',
    );
  });

  it('deduplicates concurrent verification runs with a process-local lock', async () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: auth.userId,
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: auth.userId,
    });

    let release!: () => void;
    const firstPromise = verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              status: 'verified',
              code: 'verified',
              message: 'Subscription runtime verified.',
            });
        }),
    });

    const second = await verifyExecutorRoute(auth, {
      verifySubscriptionRuntime: async () => ({
        status: 'verified',
        code: 'verified',
        message: 'unexpected',
      }),
    });

    expect(second.statusCode).toBe(200);
    expect(second.body.ok).toBe(true);
    if (second.body.ok) {
      expect(second.body.data.code).toBe('verification_in_progress');
    }

    release();
    await firstPromise;
  });
});
