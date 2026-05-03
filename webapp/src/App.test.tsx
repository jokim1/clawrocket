import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

// PR-1 of the PURGE deleted the ClawTalk shell, sidebar, talks/main-channel
// pages, and AvatarMenu. App.tsx now renders only the editorial product:
// loading → sign-in → editorial routes.

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows sign-in when the session call returns 401', async () => {
    mockFetchByPath({
      '/api/v1/session/me': [
        jsonResponse(401, {
          ok: false,
          error: {
            code: 'unauthorized',
            message: 'Authentication is required',
          },
        }),
      ],
      '/api/v1/auth/refresh': [
        jsonResponse(401, {
          ok: false,
          error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
        }),
      ],
      '/api/v1/auth/config': [
        jsonResponse(200, {
          ok: true,
          data: { devMode: false },
        }),
      ],
    });

    renderWithRouter('/');

    expect(
      await screen.findByRole('heading', { name: /editorialboard/i }),
    ).toBeInTheDocument();
  });

  it('redirects authenticated users from / into /editorial/setup', async () => {
    mockFetchByPath(authenticatedRoutes());

    renderWithRouter('/');

    await waitFor(
      () => {
        expect(screen.getByText(/editorial room/i)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });

  it('redirects unknown routes to /editorial/setup when authenticated', async () => {
    mockFetchByPath(authenticatedRoutes());

    renderWithRouter('/some/unknown/path');

    await waitFor(
      () => {
        expect(screen.getByText(/editorial room/i)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
  });
});

// ─── Test helpers ───────────────────────────────────────────────────────────

function renderWithRouter(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <App />
    </MemoryRouter>,
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ResponseQueue = Response[];

function mockFetchByPath(routes: Record<string, ResponseQueue>): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = url.startsWith('http')
      ? new URL(url).pathname
      : url.split('?')[0];
    const queue = routes[path];
    if (!queue || queue.length === 0) {
      // Default 404 for any path the test didn't mock — keeps page renders
      // from blowing up on background data fetches we don't care about.
      return jsonResponse(404, {
        ok: false,
        error: { code: 'unmocked_path', message: `No mock for ${path}` },
      });
    }
    const next = queue.shift()!;
    return next.clone();
  });
  vi.stubGlobal('fetch', fetchMock);
}

function authenticatedRoutes(): Record<string, ResponseQueue> {
  return {
    '/api/v1/session/me': [
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u_test',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
            createdAt: new Date().toISOString(),
          },
        },
      }),
    ],
    // Editorial Setup polls /api/v1/agents and the OAuth status endpoints
    // for the LLM Room provider list — return empty so the page renders.
    '/api/v1/agents': [
      jsonResponse(200, {
        ok: true,
        data: { additionalProviders: [] },
      }),
    ],
    '/api/v1/agents/providers/anthropic/oauth/status': [
      jsonResponse(200, {
        ok: true,
        data: { connected: false },
      }),
    ],
    '/api/v1/agents/providers/openai/oauth/status': [
      jsonResponse(200, {
        ok: true,
        data: { connected: false },
      }),
    ],
  };
}
