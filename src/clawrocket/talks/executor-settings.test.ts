import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';
import { _initTestDatabase, upsertUser } from '../db/index.js';

import {
  ExecutorSettingsService,
  ExecutorSettingsValidationError,
} from './executor-settings.js';

function createService(
  bootstrapConfig?: Partial<{
    aliasModelMapJson: string;
    defaultAlias: string;
    baseUrl: string;
    apiKey: string;
    oauthToken: string;
    authToken: string;
  }>,
): ExecutorSettingsService {
  return new ExecutorSettingsService({ bootstrapConfig });
}

describe('ExecutorSettingsService', () => {
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

  it('saves executor settings, takes ownership, and resolves metadata', () => {
    const service = createService();

    const saved = service.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-test',
        anthropicBaseUrl: 'https://api.example.test',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    expect(saved.isConfigured).toBe(true);
    expect(saved.hasApiKey).toBe(true);
    expect(saved.hasOauthToken).toBe(false);
    expect(saved.hasAuthToken).toBe(false);
    expect(saved.executorAuthMode).toBe('api_key');
    expect(saved.activeCredentialConfigured).toBe(true);
    expect(saved.verificationStatus).toBe('not_verified');
    expect(saved.anthropicBaseUrl).toBe('https://api.example.test');
    expect(saved.defaultAlias).toBe('Gemini');
    expect(saved.configVersion).toBe(1);
    expect(saved.lastUpdatedBy).toEqual({
      id: 'owner-1',
      displayName: 'Owner',
    });
    expect(saved.lastUpdatedAt).not.toBeNull();

    expect(service.getExecutorSecrets()).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://api.example.test',
    });
  });

  it('bootstraps from injected env config before ownership and reports source resolution', () => {
    const service = createService({
      aliasModelMapJson: '{"Gemini":"gemini-pro"}',
      defaultAlias: 'Gemini',
      baseUrl: 'https://bootstrap.example.test',
    });

    const resolved = service.resolveEffectiveConfig();

    expect(resolved.configOwned).toBe(false);
    expect(resolved.configuredAliasMap).toEqual({ Gemini: 'gemini-pro' });
    expect(resolved.defaultAlias).toBe('Gemini');
    expect(resolved.anthropicBaseUrl).toBe('https://bootstrap.example.test');
    expect(resolved.sources.configuredAliasMap).toBe('bootstrap');
    expect(resolved.sources.defaultAlias).toBe('bootstrap');
    expect(resolved.sources.anthropicBaseUrl).toBe('bootstrap');
  });

  it('reports none source when no DB or bootstrap values exist', () => {
    const service = createService({
      aliasModelMapJson: '',
      defaultAlias: '',
      baseUrl: '',
    });

    const resolved = service.resolveEffectiveConfig();

    expect(resolved.configuredAliasMap).toEqual({});
    expect(resolved.defaultAlias).toBe('Mock');
    expect(resolved.sources.configuredAliasMap).toBe('none');
    expect(resolved.sources.defaultAlias).toBe('none');
    expect(resolved.sources.anthropicBaseUrl).toBe('none');
  });

  it('runs bootstrap migration once and persists the full effective config', () => {
    const service = createService({
      aliasModelMapJson: '{"Gemini":"gemini-pro"}',
      defaultAlias: 'Gemini',
      baseUrl: 'https://bootstrap.example.test',
      apiKey: 'sk-bootstrap',
    });

    service.runBootstrapMigration();

    const view = service.getSettingsView();
    expect(view.isConfigured).toBe(true);
    expect(view.defaultAlias).toBe('Gemini');
    expect(view.effectiveAliasMap.Gemini).toBe('gemini-pro');
    expect(view.anthropicBaseUrl).toBe('https://bootstrap.example.test');
    expect(view.hasApiKey).toBe(true);
    expect(view.executorAuthMode).toBe('api_key');
    expect(view.configVersion).toBe(1);
    expect(view.lastUpdatedBy).toBeNull();
  });

  it('skips bootstrap migration when settings are already owned', () => {
    const service = createService({
      aliasModelMapJson: '{"Gemini":"bootstrap-model"}',
      defaultAlias: 'Gemini',
      apiKey: 'sk-bootstrap',
    });

    service.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-owned',
        aliasModelMap: { Gemini: 'owned-model' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    service.runBootstrapMigration();

    const view = service.getSettingsView();
    expect(view.configVersion).toBe(1);
    expect(view.effectiveAliasMap.Gemini).toBe('owned-model');
    expect(service.getExecutorSecrets().ANTHROPIC_API_KEY).toBe('sk-owned');
  });

  it('deletes optional rows when values are cleared with null', () => {
    const service = createService();
    service.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-test',
        anthropicBaseUrl: 'https://api.example.test',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    const cleared = service.saveExecutorConfig(
      {
        anthropicApiKey: null,
        anthropicBaseUrl: null,
      },
      'owner-1',
    );

    expect(cleared.hasApiKey).toBe(false);
    expect(cleared.anthropicBaseUrl).toBe('');

    const remainingKeys = (
      getDb()
        .prepare(
          `
          SELECT key
          FROM settings_kv
          WHERE key IN ('executor.anthropicApiKey', 'executor.anthropicBaseUrl')
        `,
        )
        .all() as Array<{ key: string }>
    ).map((row) => row.key);
    expect(remainingKeys).toEqual([]);
  });

  it('computes restart reasons from the running snapshot and handles missing snapshot', () => {
    const service = createService({
      aliasModelMapJson: '{"Gemini":"gemini-pro"}',
      defaultAlias: 'Gemini',
    });

    expect(service.computeRestartReasons()).toEqual([]);

    const initialConfig = service.resolveEffectiveConfig();
    service.captureRunningSnapshot(initialConfig, service.getConfigVersion());
    service.saveExecutorConfig(
      {
        aliasModelMap: { Gemini: 'gemini-pro-v2' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    expect(service.computeRestartReasons()).toEqual([
      'Alias model map changed',
    ]);
  });

  it('detects executor mode changes in both directions', () => {
    const mockToReal = createService({
      aliasModelMapJson: '{"Gemini":"gemini-pro"}',
      defaultAlias: 'Gemini',
    });
    mockToReal.captureRunningSnapshot(
      mockToReal.resolveEffectiveConfig(),
      mockToReal.getConfigVersion(),
    );
    mockToReal.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-test',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );
    expect(mockToReal.computeRestartReasons()).toContain(
      'Executor mode would change from mock to real',
    );

    const realToMock = createService();
    realToMock.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-test',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );
    realToMock.captureRunningSnapshot(
      realToMock.resolveEffectiveConfig(),
      realToMock.getConfigVersion(),
    );
    realToMock.saveExecutorConfig(
      {
        anthropicApiKey: null,
      },
      'owner-1',
    );
    expect(realToMock.computeRestartReasons()).toContain(
      'Executor mode would change from real to mock',
    );
  });

  it('validates base URL, secrets, and default alias edge cases', () => {
    const service = createService();

    expect(() =>
      service.saveExecutorConfig(
        {
          anthropicBaseUrl: 'not-a-url',
          aliasModelMap: { Gemini: 'gemini-pro' },
          defaultAlias: 'Gemini',
        },
        'owner-1',
      ),
    ).toThrowError(ExecutorSettingsValidationError);

    expect(() =>
      service.saveExecutorConfig(
        {
          anthropicApiKey: '   ',
          aliasModelMap: { Gemini: 'gemini-pro' },
          defaultAlias: 'Gemini',
        },
        'owner-1',
      ),
    ).toThrowError(ExecutorSettingsValidationError);

    expect(() =>
      service.saveExecutorConfig(
        {
          aliasModelMap: { Gemini: 'gemini-pro' },
          defaultAlias: '   ',
        },
        'owner-1',
      ),
    ).toThrowError(ExecutorSettingsValidationError);
  });

  it('exports only the selected Anthropic auth mode when standby credentials are stored', () => {
    const service = createService();

    service.saveExecutorConfig(
      {
        claudeOauthToken: 'oauth-test',
        anthropicApiKey: 'sk-test',
        executorAuthMode: 'subscription',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );

    expect(service.getExecutorSecrets()).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
    });

    service.saveExecutorConfig(
      {
        executorAuthMode: 'api_key',
      },
      'owner-1',
    );

    expect(service.getExecutorSecrets()).toEqual({
      ANTHROPIC_API_KEY: 'sk-test',
    });
  });

  it('makes imported subscription credentials immediately available to verification', () => {
    const service = createService();

    const imported = service.importSubscriptionCredential(
      'oauth-imported',
      'owner-1',
    );

    expect(imported.status).toBe('imported');
    expect(imported.settings.executorAuthMode).toBe('subscription');
    expect(service.getExecutorSecrets()).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-imported',
    });

    const target = service.getVerificationTarget('subscription');
    expect(target?.mode).toBe('subscription');
    expect(target?.credential).toBe('oauth-imported');
  });

  it('requires explicit selection when auth token is mixed with another credential', () => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.anthropicApiKey', 'sk-test', now, null);
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.anthropicAuthToken', 'bearer-test', now, null);
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.configOwned', 'true', now, null);

    const service = createService();
    const view = service.getSettingsView();

    expect(view.executorAuthMode).toBe('none');
    expect(view.activeCredentialConfigured).toBe(false);
    expect(view.configErrors).toContain(
      'Multiple Anthropic credential types are stored. Select an active auth mode before running the core executor.',
    );
  });

  it('resets stale verifying state on read', () => {
    const service = createService();
    service.saveExecutorConfig(
      {
        anthropicApiKey: 'sk-test',
        executorAuthMode: 'api_key',
        aliasModelMap: { Gemini: 'gemini-pro' },
        defaultAlias: 'Gemini',
      },
      'owner-1',
    );
    const target = service.getVerificationTarget('api_key');
    expect(target).not.toBeNull();

    const staleStartedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    getDb()
      .prepare(
        `
        UPDATE settings_kv
        SET value = ?, updated_at = ?
        WHERE key = 'executor.authVerification'
      `,
      )
      .run(
        JSON.stringify({
          api_key: {
            status: 'verifying',
            fingerprint: target!.fingerprint,
            verificationStartedAt: staleStartedAt,
            lastVerifiedAt: null,
            lastVerificationError: null,
          },
        }),
        staleStartedAt,
      );

    const view = service.getSettingsView();

    expect(view.verificationStatus).toBe('not_verified');
    expect(view.lastVerificationError).toBe(
      'Previous verification attempt expired before completion.',
    );
  });

  it('surfaces config errors for corrupted owned config and metadata without user FK', () => {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.aliasModelMap', '{"Gemini":', now, null);
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.defaultAlias', 'Gemini', now, null);
    getDb()
      .prepare(
        `
        INSERT INTO settings_kv (key, value, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run('executor.configOwned', 'true', now, null);

    const service = createService();
    const resolved = service.resolveEffectiveConfig();
    const view = service.getSettingsView();

    expect(resolved.configErrors).toContain('Alias map must be valid JSON');
    expect(resolved.hasValidAliasMap).toBe(false);
    expect(view.configErrors).toContain('Alias map must be valid JSON');
    expect(view.lastUpdatedBy).toBeNull();
    expect(view.lastUpdatedAt).toBe(now);
  });

  it('logs and returns empty secrets when stored rows cannot be loaded', () => {
    const service = createService();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    const serviceWithPrivateMethods = service as unknown as {
      readStoredRows: () => unknown;
    };
    vi.spyOn(serviceWithPrivateMethods, 'readStoredRows').mockImplementation(
      () => {
        throw new Error('db read failed');
      },
    );

    expect(service.getExecutorSecrets()).toEqual({});
    expect(warnSpy).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'Failed to load executor secrets from settings DB',
    );
  });
});
