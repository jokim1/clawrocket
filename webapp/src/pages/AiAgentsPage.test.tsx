import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { AiAgentsPage } from './AiAgentsPage';
import type { AiAgentsPageData } from '../lib/api';

describe('AiAgentsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
    await user.click(screen.getByRole('button', { name: 'Configure' }));
    await user.type(screen.getByLabelText('Token'), 'bad-token');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('OpenAI credential saved. Verification status: invalid.'),
    ).toBeTruthy();
  });
});

function installAiAgentsFetch() {
  let snapshot = buildAiAgentsData();

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

      if (url.endsWith('/api/v1/agents/providers/provider.openai') && method === 'PUT') {
        snapshot = {
          ...snapshot,
          providers: snapshot.providers.map((provider) =>
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
        const provider = snapshot.providers.find(
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
    defaultRegisteredAgentId: null,
    onboardingRequired: true,
    providers: [
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
    ],
    registeredAgents: [],
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
