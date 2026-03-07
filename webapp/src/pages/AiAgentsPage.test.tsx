import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AiAgentsPage } from './AiAgentsPage';
import type {
  AiAgentsPageData,
  ExecutorSettings,
  ExecutorStatus,
} from '../lib/api';

describe('AiAgentsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the simplified Claude plus additional providers layout', async () => {
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });
    expect(
      screen.getByRole('heading', { name: 'Default Claude Agent' }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Additional Providers' }),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Every new talk starts with Claude as the default agent/i,
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText('Subscription')).toBeChecked();
    expect(screen.getByLabelText('API')).not.toBeChecked();
    expect(screen.getByText('Model for new talks')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Check host Claude login/i }),
    ).toBeNull();
    expect(screen.getByLabelText('Claude Code OAuth token')).toBeTruthy();
    expect(
      await screen.findByText(/Checked as user k1min8r/i),
    ).toBeTruthy();

    const openAiCard = screen.getByRole('heading', { name: 'OpenAI' }).closest('article');
    if (!openAiCard) {
      throw new Error('Expected OpenAI provider card');
    }
    expect(
      within(openAiCard).getByRole('link', { name: 'Get key from OpenAI' }),
    ).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
  });

  it('reports saved provider credentials honestly when verification does not pass', async () => {
    const user = userEvent.setup();
    installAiAgentsFetch();

    render(
      <MemoryRouter initialEntries={['/app/agents']}>
        <AiAgentsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'AI Agents' });

    const openAiCard = screen.getByRole('heading', { name: 'OpenAI' }).closest('article');
    if (!openAiCard) {
      throw new Error('Expected OpenAI provider card');
    }

    await user.type(within(openAiCard).getByLabelText('API key'), 'bad-token');
    await user.click(within(openAiCard).getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('OpenAI credential saved. Verification status: invalid.'),
    ).toBeTruthy();
  });
});

function installAiAgentsFetch() {
  let snapshot = buildAiAgentsData();
  let settings = buildExecutorSettings();
  let status = buildExecutorStatus();

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

      if (url.endsWith('/api/v1/settings/executor') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: settings });
      }

      if (url.endsWith('/api/v1/settings/executor-status') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: status });
      }

      if (
        url.endsWith('/api/v1/settings/executor/subscription-host-status') &&
        method === 'GET'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: {
            serviceUser: 'k1min8r',
            serviceUid: 1000,
            serviceHomePath: '/home/k1min8r',
            runtimeContext: 'host',
            claudeCliInstalled: true,
            hostLoginDetected: true,
            serviceEnvOauthPresent: false,
            importAvailable: false,
            hostCredentialFingerprint: null,
            message:
              'Claude Code login was detected for this service user, but the current authenticated state could not be imported automatically. Use the advanced manual token flow with `claude setup-token`.',
            recommendedCommands: [
              'claude config set -g forceLoginMethod claudeai',
              'claude login',
            ],
          },
        });
      }

      if (url.endsWith('/api/v1/agents/providers/provider.openai') && method === 'PUT') {
        snapshot = {
          ...snapshot,
          additionalProviders: snapshot.additionalProviders.map((provider) =>
            provider.id === 'provider.openai'
              ? {
                  ...provider,
                  hasCredential: true,
                  credentialHint: '••••bad',
                  verificationStatus: 'invalid',
                  lastVerificationError: 'Invalid API key.',
                }
              : provider,
          ),
        };
        const provider = snapshot.additionalProviders.find(
          (entry) => entry.id === 'provider.openai',
        );
        return jsonResponse(200, { ok: true, data: { provider } });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-5',
    claudeModelSuggestions: [
      {
        modelId: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-opus-4-1',
        displayName: 'Claude Opus 4.1',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
    ],
    additionalProviders: [
      {
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
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
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/openai',
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
    ],
  };
}

function buildExecutorSettings(): ExecutorSettings {
  return {
    configuredAliasMap: {},
    effectiveAliasMap: { Mock: 'mock' },
    defaultAlias: 'Mock',
    executorAuthMode: 'subscription',
    hasApiKey: false,
    hasOauthToken: false,
    hasAuthToken: false,
    apiKeyHint: null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: false,
    verificationStatus: 'missing',
    lastVerifiedAt: null,
    lastVerificationError: null,
    anthropicBaseUrl: 'https://api.anthropic.com',
    isConfigured: true,
    configVersion: 1,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    configErrors: [],
  };
}

function buildExecutorStatus(): ExecutorStatus {
  return {
    mode: 'real',
    restartSupported: false,
    pendingRestartReasons: [],
    activeRunCount: 0,
    executorAuthMode: 'subscription',
    activeCredentialConfigured: false,
    verificationStatus: 'missing',
    lastVerifiedAt: null,
    lastVerificationError: null,
    hasProviderAuth: false,
    hasValidAliasMap: true,
    configVersion: 1,
    isConfigured: true,
    bootId: 'boot-test',
    configErrors: [],
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
