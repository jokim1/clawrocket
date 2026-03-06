import { cleanup, render, screen } from '@testing-library/react';
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
          hasApiKey: true,
          hasOauthToken: false,
          hasAuthToken: false,
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
          hasProviderAuth: true,
          hasValidAliasMap: false,
          detectedAuthMethod: 'api_key',
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
    expect(await screen.findByText('Detected auth')).toBeTruthy();
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
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
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
          hasProviderAuth: false,
          hasValidAliasMap: true,
          detectedAuthMethod: 'none',
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

  it('loads structured Talk LLM settings for admin users', async () => {
    const user = userEvent.setup();
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          configuredAliasMap: {},
          effectiveAliasMap: { Mock: 'default' },
          defaultAlias: 'Mock',
          hasApiKey: false,
          hasOauthToken: false,
          hasAuthToken: false,
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
          hasProviderAuth: false,
          hasValidAliasMap: true,
          detectedAuthMethod: 'none',
          configVersion: 0,
          isConfigured: false,
          bootId: 'boot-3',
          configErrors: [],
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          defaultRouteId: 'route.primary',
          providers: [
            {
              id: 'provider.anthropic',
              name: 'Anthropic Prod',
              providerKind: 'anthropic',
              apiFormat: 'anthropic_messages',
              baseUrl: 'https://api.anthropic.com',
              authScheme: 'x_api_key',
              enabled: true,
              coreCompatibility: 'claude_sdk_proxy',
              responseStartTimeoutMs: 60000,
              streamIdleTimeoutMs: 20000,
              absoluteTimeoutMs: 300000,
              hasCredential: true,
              models: [
                {
                  modelId: 'claude-sonnet-4-5',
                  displayName: 'Sonnet 4.5',
                  contextWindowTokens: 200000,
                  defaultMaxOutputTokens: 4096,
                  enabled: true,
                },
              ],
            },
          ],
          routes: [
            {
              id: 'route.primary',
              name: 'Primary Route',
              enabled: true,
              assignedAgentCount: 2,
              assignedTalkCount: 1,
              steps: [
                {
                  position: 0,
                  providerId: 'provider.anthropic',
                  modelId: 'claude-sonnet-4-5',
                },
              ],
            },
          ],
        },
      }),
    ]);

    render(<SettingsPage onUnauthorized={vi.fn()} userRole="admin" />);

    const loadButton = await screen.findByRole('button', {
      name: 'Load Talk LLM Settings',
    });
    await user.click(loadButton);

    expect(await screen.findByRole('heading', { name: 'Providers' })).toBeTruthy();
    expect((await screen.findAllByText('Anthropic Prod')).length).toBeGreaterThan(0);
    expect(await screen.findByRole('heading', { name: 'Routes' })).toBeTruthy();
    expect(await screen.findByDisplayValue('route.primary')).toBeTruthy();
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
