import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders config errors and pending restart reasons from the settings endpoints', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: { Gemini: 'gemini-pro' },
          effectiveAliasMap: { Mock: 'default', Gemini: 'gemini-pro' },
          defaultAlias: 'Gemini',
          executorAuthMode: 'api_key',
          hasApiKey: true,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          anthropicBaseUrl: 'https://api.example.test',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: '2026-03-05T12:00:00.000Z',
          lastUpdatedBy: { id: 'owner-1', displayName: 'Owner' },
          configErrors: ['Alias map must be valid JSON'],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: true,
          pendingRestartReasons: ['Alias model map changed'],
          activeRunCount: 2,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'api_key',
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          hasProviderAuth: true,
          hasValidAliasMap: false,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-1',
          configErrors: ['Alias map must be valid JSON'],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      await screen.findByText('Configuration errors detected.'),
    ).toBeTruthy();
    expect(await screen.findByText('Alias model map changed')).toBeTruthy();
    expect(
      (await screen.findAllByText('Active auth mode')).length,
    ).toBeGreaterThan(0);
    expect(
      await screen.findByRole('button', {
        name: 'Restart ClawRocket Service',
      }),
    ).toBeTruthy();
  });

  it('shows owner-only restart guidance for admin users', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: false,
          configVersion: 0,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'mock',
          restartSupported: true,
          pendingRestartReasons: ['Default alias changed from Mock to Gemini'],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-2',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="admin" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      (
        await screen.findAllByText(
          'Only the account owner can restart the service.',
        )
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Restart ClawRocket Service' }),
    ).toBeNull();
  });

  it('surfaces environment-managed executor credentials honestly', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'api_key',
          authModeSource: 'inferred',
          hasApiKey: true,
          hasOauthToken: false,
          hasAuthToken: false,
          apiKeySource: 'env',
          oauthTokenSource: null,
          authTokenSource: null,
          apiKeyHint: 'Environment variable (ANTHROPIC_API_KEY)',
          oauthTokenHint: null,
          authTokenHint: null,
          activeCredentialConfigured: true,
          verificationStatus: 'invalid',
          lastVerifiedAt: null,
          lastVerificationError: 'Anthropic API error: Unauthorized',
          anthropicBaseUrl: 'https://api.anthropic.com',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'ready',
          executorAuthMode: 'api_key',
          activeCredentialConfigured: true,
          verificationStatus: 'invalid',
          lastVerifiedAt: null,
          lastVerificationError: 'Anthropic API error: Unauthorized',
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-env',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(await screen.findByText('Environment-managed')).toBeTruthy();
    expect(
      await screen.findByText('Environment variable (ANTHROPIC_API_KEY)'),
    ).toBeTruthy();
    expect(
      await screen.findByText(/active claude auth mode is being inferred/i),
    ).toBeTruthy();
  });

  it('shows container runtime health separately from subscription verification status', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: {},
          defaultAlias: 'Mock',
          executorAuthMode: 'subscription',
          authModeSource: 'settings',
          hasApiKey: false,
          hasOauthToken: true,
          hasAuthToken: false,
          apiKeySource: null,
          oauthTokenSource: 'stored',
          authTokenSource: null,
          apiKeyHint: null,
          oauthTokenHint: 'Stored in settings',
          authTokenHint: null,
          activeCredentialConfigured: true,
          verificationStatus: 'not_verified',
          lastVerifiedAt: null,
          lastVerificationError:
            'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          anthropicBaseUrl: 'https://api.anthropic.com',
          isConfigured: true,
          configVersion: 1,
          lastUpdatedAt: null,
          lastUpdatedBy: null,
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          containerRuntimeAvailability: 'unavailable',
          executorAuthMode: 'subscription',
          activeCredentialConfigured: true,
          verificationStatus: 'not_verified',
          lastVerifiedAt: null,
          lastVerificationError:
            'Claude subscription verification could not run because the container runtime is unavailable or unhealthy. Check Docker and try again.',
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 1,
          isConfigured: true,
          bootId: 'boot-subscription-runtime',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(await screen.findByText('Container runtime')).toBeTruthy();
    expect(await screen.findByText('Not verified')).toBeTruthy();
    expect(await screen.findByText(/Runtime note:/i)).toBeTruthy();
    expect(
      await screen.findByText(
        /Docker \/ the container runtime is currently unavailable/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Verification note:/i)).toBeNull();
  });
});

function mockFetch(responses: Response[]): void {
  const queue = [...responses];
  vi.stubGlobal('fetch', async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error('No mocked response left for fetch()');
    }
    return next;
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
