import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { SettingsPage } from './SettingsPage';
import type {
  AgentProviderCard,
  AiAgentsPageData,
  RegisteredAgent,
  SessionUser,
} from '../lib/api';

describe('SettingsPage', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to the Profile tab and shows the display-name editor', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    expect(
      screen.getByRole('heading', { name: 'Personal Information' }),
    ).toBeTruthy();
    const profileTab = screen.getByRole('tab', { name: 'Profile' });
    expect(profileTab).toHaveAttribute('aria-selected', 'true');
  });

  it('hides API Keys + Agents tabs for member users', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings']}>
        <SettingsPage
          user={buildSessionUser({ role: 'member' })}
          userRole="member"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    expect(screen.getByRole('tab', { name: 'Profile' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'API Keys' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Agents' })).toBeNull();
  });

  it('opens the API Keys tab via ?tab=api-keys and renders provider cards', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Provider API Keys' });
    expect(
      screen.getByRole('heading', { name: 'Claude (Anthropic)' }),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'OpenAI' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Google / Gemini' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'NVIDIA Kimi2.5' }),
    ).toBeTruthy();

    const anthropicCard = screen
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');
    expect(
      within(anthropicCard).getByPlaceholderText('sk-ant-...'),
    ).toBeTruthy();
    expect(
      within(anthropicCard).getByRole('link', {
        name: /Get key from Anthropic Console/i,
      }),
    ).toBeTruthy();
  });

  it('saves an API key by calling PUT /api/v1/agents/providers/:id', async () => {
    const user = userEvent.setup();
    const helpers = installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=api-keys']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Claude (Anthropic)' });
    const anthropicCard = screen
      .getByRole('heading', { name: 'Claude (Anthropic)' })
      .closest('article');
    if (!anthropicCard) throw new Error('Anthropic card not found');

    const input = within(anthropicCard).getByPlaceholderText('sk-ant-...');
    await user.type(input, 'sk-ant-test-key');
    await user.click(
      within(anthropicCard).getByRole('button', { name: 'Save' }),
    );

    expect(
      await screen.findByText(/Claude \(Anthropic\) credential saved\./),
    ).toBeTruthy();
    const calls = helpers.getProviderSaveCalls('provider.anthropic');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      providerId: 'provider.anthropic',
      apiKey: 'sk-ant-test-key',
    });
  });

  it('opens the Agents tab and lists registered agents from the panel', async () => {
    installSettingsFetch();

    render(
      <MemoryRouter initialEntries={['/app/settings?tab=agents']}>
        <SettingsPage
          user={buildSessionUser()}
          userRole="owner"
          onUnauthorized={vi.fn()}
          onUserUpdated={vi.fn()}
        />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Registered Agents' });
    expect(screen.getByText('Claude Main')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Main Agent' })).toBeTruthy();
  });
});

function installSettingsFetch() {
  let snapshot = buildAiAgentsData();
  let registeredAgents = buildRegisteredAgents();
  let mainAgent: RegisteredAgent | null = registeredAgents[0] ?? null;
  const providerSaveCalls: Record<
    string,
    Array<{ providerId: string; apiKey: string | null }>
  > = {};

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: snapshot });
      }

      if (url.endsWith('/api/v1/registered-agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: registeredAgents });
      }

      if (url.endsWith('/api/v1/registered-agents/main') && method === 'GET') {
        if (!mainAgent) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'No main agent' },
          });
        }
        return jsonResponse(200, { ok: true, data: mainAgent });
      }

      const providerSaveMatch = url.match(
        /\/api\/v1\/agents\/providers\/([^/?]+)$/,
      );
      if (providerSaveMatch && method === 'PUT') {
        const providerId = decodeURIComponent(providerSaveMatch[1]);
        const body = JSON.parse(String(init?.body || '{}')) as {
          providerId: string;
          apiKey: string | null;
        };
        providerSaveCalls[providerId] = providerSaveCalls[providerId] || [];
        providerSaveCalls[providerId].push({
          providerId: body.providerId,
          apiKey: body.apiKey,
        });

        let next: AgentProviderCard | null = null;
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((entry) => {
            if (entry.id !== providerId) return entry;
            next = {
              ...entry,
              hasCredential: body.apiKey !== null,
              credentialHint: body.apiKey ? '••••test' : null,
              verificationStatus: body.apiKey ? 'verified' : 'missing',
              lastVerifiedAt: body.apiKey ? '2026-05-16T12:00:00.000Z' : null,
              lastVerificationError: null,
            };
            return next;
          }),
        };
        return jsonResponse(200, { ok: true, data: { provider: next } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );

  return {
    getProviderSaveCalls: (providerId: string) =>
      providerSaveCalls[providerId] || [],
  };
}

function buildSessionUser(overrides?: Partial<SessionUser>): SessionUser {
  return {
    id: 'user-1',
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-6',
    claudeModelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 8192,
      },
    ],
    additionalProviders: [
      {
        id: 'provider.anthropic',
        name: 'Claude (Anthropic)',
        providerKind: 'anthropic',
        credentialMode: 'api_key',
        apiFormat: 'anthropic_messages',
        baseUrl: 'https://api.anthropic.com',
        authScheme: 'x_api_key',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        modelSuggestions: [
          {
            modelId: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            contextWindowTokens: 200000,
            defaultMaxOutputTokens: 8192,
          },
        ],
      },
      {
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        modelSuggestions: [
          {
            modelId: 'gpt-5-mini',
            displayName: 'GPT-5 Mini',
            contextWindowTokens: 128000,
            defaultMaxOutputTokens: 4096,
          },
        ],
      },
      {
        id: 'provider.gemini',
        name: 'Google / Gemini',
        providerKind: 'gemini',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        modelSuggestions: [
          {
            modelId: 'gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            contextWindowTokens: 1000000,
            defaultMaxOutputTokens: 8192,
          },
        ],
      },
      {
        id: 'provider.nvidia',
        name: 'NVIDIA Kimi2.5',
        providerKind: 'nvidia',
        credentialMode: 'api_key',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: false,
        credentialHint: null,
        verificationStatus: 'missing',
        lastVerifiedAt: null,
        lastVerificationError: null,
        modelSuggestions: [
          {
            modelId: 'moonshotai/kimi-k2.5',
            displayName: 'Kimi 2.5 (NVIDIA)',
            contextWindowTokens: 262144,
            defaultMaxOutputTokens: 16384,
          },
        ],
      },
    ],
  };
}

function buildRegisteredAgents(): RegisteredAgent[] {
  return [
    {
      id: 'agent-main',
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissions: { web: true },
      personaRole: 'assistant',
      systemPrompt: null,
      description: null,
      enabled: true,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
      executionPreview: {
        surface: 'main',
        backend: 'direct_http',
        authPath: 'api_key',
        selectedMode: 'api',
        transport: 'direct',
        reasonCode: null,
        routeReason: 'normal',
        ready: true,
        message: 'Main will use Anthropic direct HTTP with an API key.',
      },
    },
  ];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
