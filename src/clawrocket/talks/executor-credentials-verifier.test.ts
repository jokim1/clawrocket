import { beforeEach, describe, expect, it, vi } from 'vitest';

import { _initTestDatabase, upsertUser } from '../db/index.js';

import { ExecutorCredentialVerifier } from './executor-credentials-verifier.js';
import { ExecutorSettingsService } from './executor-settings.js';

function createService(): ExecutorSettingsService {
  return new ExecutorSettingsService();
}

describe('ExecutorCredentialVerifier', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.restoreAllMocks();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('passes only the selected subscription credential and chosen model into verification', async () => {
    const service = createService();
    service.saveExecutorConfig(
      {
        executorAuthMode: 'subscription',
        claudeOauthToken: 'oauth-subscription',
        anthropicApiKey: 'sk-standby',
        aliasModelMap: { Gemini: 'claude-subscription-model' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    const runContainer = vi.fn(
      async (
        _group: unknown,
        _input: { model?: string; secrets?: Record<string, string> },
      ) => ({
        status: 'success' as const,
        result: 'OK',
      }),
    );

    const verifier = new ExecutorCredentialVerifier({
      executorSettings: service,
      runContainer,
    });

    const scheduled = verifier.scheduleVerification('subscription');
    expect(scheduled.scheduled).toBe(true);

    await vi.waitFor(() => {
      expect(runContainer).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(service.getSettingsView().verificationStatus).toBe('verified');
    });

    const containerInput = runContainer.mock.calls[0]?.[1];
    expect(containerInput).toBeDefined();
    if (!containerInput) {
      throw new Error(
        'Expected subscription verification to call runContainer',
      );
    }
    expect(containerInput.model).toBe('claude-subscription-model');
    expect(containerInput.secrets).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-subscription',
    });
  });

  it('classifies token-budget failures as unavailable instead of invalid auth', async () => {
    const service = createService();
    service.saveExecutorConfig(
      {
        executorAuthMode: 'subscription',
        claudeOauthToken: 'oauth-subscription',
      },
      'owner-1',
    );

    const verifier = new ExecutorCredentialVerifier({
      executorSettings: service,
      runContainer: vi.fn(async () => ({
        status: 'error' as const,
        result: null,
        error: 'Context token limit exceeded during verification.',
      })),
    });

    verifier.scheduleVerification('subscription');

    await vi.waitFor(() => {
      expect(service.getSettingsView().verificationStatus).toBe('unavailable');
    });

    expect(service.getSettingsView().lastVerificationError).toBe(
      'Context token limit exceeded during verification.',
    );
  });
});
