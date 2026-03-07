import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

    render(
      <SettingsPage onUnauthorized={vi.fn()} userRole="owner" />,
    );

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      await screen.findByText('Configuration errors detected.'),
    ).toBeTruthy();
    expect(await screen.findByText('Alias model map changed')).toBeTruthy();
    expect((await screen.findAllByText('Active auth mode')).length).toBeGreaterThan(0);
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

    render(
      <SettingsPage onUnauthorized={vi.fn()} userRole="admin" />,
    );

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      (await screen.findAllByText(
        'Only the account owner can restart the service.',
      )).length,
    ).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: 'Restart ClawRocket Service' }),
    ).toBeNull();
  });

  it('links admins to the AI Agents page for provider and agent management', async () => {
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
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-3',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="admin" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(await screen.findByRole('heading', { name: 'AI Agents' })).toBeTruthy();
    const link = await screen.findByRole('link', { name: 'Open AI Agents' });
    expect(link.getAttribute('href')).toBe('/app/agents');
  });

  it('shows pending subscription activation clearly before save', async () => {
    const user = userEvent.setup();
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'none',
          hasApiKey: true,
          hasOauthToken: true,
          hasAuthToken: false,
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: true,
          configVersion: 2,
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
          executorAuthMode: 'none',
          activeCredentialConfigured: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: false,
          hasValidAliasMap: true,
          configVersion: 2,
          isConfigured: true,
          bootId: 'boot-pending',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    await user.selectOptions(
      screen.getByLabelText('Active auth mode'),
      'subscription',
    );

    expect(await screen.findByText('Ready to save')).toBeTruthy();
    expect(
      await screen.findByText(
        /saving will switch the active Anthropic auth mode from/i,
      ),
    ).toBeTruthy();
    expect(
      await screen.findByText(/A credential is already stored in settings\./i),
    ).toBeTruthy();
  });

  it('preserves explicit credential clears when switching auth modes before save', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn();
    const responses = [
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'api_key',
          hasApiKey: true,
          hasOauthToken: true,
          hasAuthToken: false,
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: true,
          configVersion: 3,
          lastUpdatedAt: '2026-03-05T12:00:00.000Z',
          lastUpdatedBy: { id: 'owner-1', displayName: 'Owner' },
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: true,
          pendingRestartReasons: [],
          activeRunCount: 0,
          executorAuthMode: 'api_key',
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 3,
          isConfigured: true,
          bootId: 'boot-4',
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'subscription',
          hasApiKey: false,
          hasOauthToken: true,
          hasAuthToken: false,
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          anthropicBaseUrl: '',
          isConfigured: true,
          configVersion: 4,
          lastUpdatedAt: '2026-03-06T12:00:00.000Z',
          lastUpdatedBy: { id: 'owner-1', displayName: 'Owner' },
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: true,
          pendingRestartReasons: [],
          activeRunCount: 0,
          executorAuthMode: 'subscription',
          activeCredentialConfigured: true,
          verificationStatus: 'verified',
          lastVerifiedAt: '2026-03-05T12:00:00.000Z',
          lastVerificationError: null,
          hasProviderAuth: true,
          hasValidAliasMap: true,
          configVersion: 4,
          isConfigured: true,
          bootId: 'boot-5',
          configErrors: [],
        },
      }),
    ];

    fetchMock.mockImplementation(async (_input, init) => {
      const next = responses.shift();
      if (!next) {
        throw new Error('No mocked response left for fetch()');
      }
      return next;
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    await user.click(screen.getByRole('button', { name: 'Clear API Key' }));
    await user.selectOptions(
      screen.getByLabelText('Active auth mode'),
      'subscription',
    );
    await user.click(
      screen.getByRole('button', { name: 'Save Credential Settings' }),
    );

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    const saveCall = fetchMock.mock.calls[2];
    const body = JSON.parse(String(saveCall?.[1]?.body ?? '{}')) as Record<
      string,
      string | null
    >;

    expect(body.executorAuthMode).toBe('subscription');
    expect(body.anthropicApiKey).toBeNull();
  });

  it('guides subscription users through host check and import', async () => {
    const user = userEvent.setup();
    let imported = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input, init) => {
        const url = String(input);
        const method = init?.method || 'GET';

        if (url.endsWith('/api/v1/settings/executor') && method === 'GET') {
          return jsonResponse(200, {
            ok: true,
            data: {
              configuredAliasMap: {},
              effectiveAliasMap: { Mock: 'default' },
              defaultAlias: 'Mock',
              executorAuthMode: imported ? 'subscription' : 'none',
              hasApiKey: false,
              hasOauthToken: imported,
              hasAuthToken: false,
              activeCredentialConfigured: imported,
              verificationStatus: imported ? 'not_verified' : 'missing',
              lastVerifiedAt: null,
              lastVerificationError: null,
              anthropicBaseUrl: '',
              isConfigured: imported,
              configVersion: imported ? 2 : 1,
              lastUpdatedAt: null,
              lastUpdatedBy: null,
              configErrors: [],
            },
          });
        }

        if (url.endsWith('/api/v1/settings/executor-status') && method === 'GET') {
          return jsonResponse(200, {
            ok: true,
            data: {
              mode: imported ? 'real' : 'mock',
              restartSupported: false,
              pendingRestartReasons: [],
              activeRunCount: 0,
              executorAuthMode: imported ? 'subscription' : 'none',
              activeCredentialConfigured: imported,
              verificationStatus: imported ? 'not_verified' : 'missing',
              lastVerifiedAt: null,
              lastVerificationError: null,
              hasProviderAuth: imported,
              hasValidAliasMap: true,
              configVersion: imported ? 2 : 1,
              isConfigured: imported,
              bootId: imported ? 'boot-imported' : 'boot-initial',
              configErrors: [],
            },
          });
        }

        if (
          url.endsWith('/api/v1/settings/executor/subscription-host-status') &&
          method === 'GET'
        ) {
          return jsonResponse(200, {
            ok: true,
            data: {
              serviceUser: 'clawrocket',
              serviceUid: 1001,
              serviceHomePath: '/srv/clawrocket',
              runtimeContext: 'systemd',
              claudeCliInstalled: true,
              hostLoginDetected: true,
              serviceEnvOauthPresent: true,
              importAvailable: true,
              hostCredentialFingerprint: 'fingerprint-1',
              message:
                'A Claude Code OAuth token is already present in the ClawRocket service environment and can be imported into settings.',
              recommendedCommands: ['sudo -u clawrocket -H claude login'],
            },
          });
        }

        if (
          url.endsWith('/api/v1/settings/executor/subscription/import') &&
          method === 'POST'
        ) {
          imported = true;
          return jsonResponse(200, {
            ok: true,
            data: {
              status: 'imported',
              settings: {
                configuredAliasMap: {},
                effectiveAliasMap: { Mock: 'default' },
                defaultAlias: 'Mock',
                executorAuthMode: 'subscription',
                hasApiKey: false,
                hasOauthToken: true,
                hasAuthToken: false,
                activeCredentialConfigured: true,
                verificationStatus: 'not_verified',
                lastVerifiedAt: null,
                lastVerificationError: null,
                anthropicBaseUrl: '',
                isConfigured: true,
                configVersion: 2,
                lastUpdatedAt: null,
                lastUpdatedBy: null,
                configErrors: [],
              },
            },
          });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }),
    );

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    await user.selectOptions(
      screen.getByLabelText('Active auth mode'),
      'subscription',
    );
    await user.click(
      screen.getByRole('button', { name: 'Check host Claude login' }),
    );

    expect(await screen.findByText('Checked as user')).toBeTruthy();
    expect(await screen.findByText('clawrocket')).toBeTruthy();
    expect(
      (
        await screen.findAllByText(
          /already present in the ClawRocket service environment/i,
        )
      ).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Import from host' }));

    expect(
      await screen.findByText(
        /Subscription credential imported from the service host/i,
      ),
    ).toBeTruthy();
    const selectedModeLabel = (await screen.findAllByText('Active auth mode'))[0];
    expect(
      within(selectedModeLabel.parentElement as HTMLElement).getByText(
        'Subscription (Claude Pro/Max)',
      ),
    ).toBeTruthy();
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
