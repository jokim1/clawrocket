import { cleanup, render, screen, within } from '@testing-library/react';
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

  it('shows Claude setup status as a read-only handoff to AI Agents', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'subscription',
          hasApiKey: true,
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
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          mode: 'real',
          restartSupported: false,
          pendingRestartReasons: [],
          activeRunCount: 0,
          executorAuthMode: 'subscription',
          activeCredentialConfigured: true,
          verificationStatus: 'not_verified',
          lastVerifiedAt: null,
          lastVerificationError: null,
          hasProviderAuth: true,
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
    const agentsSection = await screen.findByRole('heading', { name: 'AI Agents' });
    const agentsCard = agentsSection.closest('section');
    expect(agentsCard).not.toBeNull();
    const card = within(agentsCard as HTMLElement);
    expect(agentsSection).toBeTruthy();
    expect(await card.findByText('Current Claude mode')).toBeTruthy();
    expect(await card.findByText('Subscription (Claude Pro/Max)')).toBeTruthy();
    expect(await card.findByText('Not verified')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Save Credential Settings/i }),
    ).toBeNull();
    expect(screen.queryByLabelText('Active auth mode')).toBeNull();
  });

  it('keeps Anthropic credential editing off the settings page', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          executorAuthMode: 'api_key',
          hasApiKey: true,
          hasOauthToken: false,
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
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    const agentsSection = await screen.findByRole('heading', { name: 'AI Agents' });
    const agentsCard = agentsSection.closest('section');
    expect(agentsCard).not.toBeNull();
    const card = within(agentsCard as HTMLElement);
    expect(await card.findByText('API Key (Anthropic Console)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Clear API Key/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Check host Claude login/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import from host/i })).toBeNull();
    expect(await screen.findByRole('link', { name: 'Open AI Agents' })).toBeTruthy();
  });

  it('uses AI Agents as the place for subscription setup guidance', async () => {
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
          bootId: 'boot-initial',
          configErrors: [],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="owner" />);

    await screen.findByRole('heading', { name: 'Executor Settings' });
    expect(
      await screen.findByText(
        /Configure the default Claude agent and any additional provider keys on the AI Agents page/i,
      ),
    ).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'Open AI Agents' })).toBeTruthy();
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
