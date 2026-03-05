import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

describe('App', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows sign-in and hides dev quick login when dev mode is disabled', async () => {
    mockFetch([
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
      }),
      jsonResponse(200, {
        ok: true,
        data: { devMode: false },
      }),
    ]);

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawRocket' });
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { name: 'Developer Quick Login' }),
      ).toBeNull(),
    );
  });

  it('shows dev quick login when dev mode is enabled', async () => {
    mockFetch([
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
      }),
      jsonResponse(200, {
        ok: true,
        data: { devMode: true },
      }),
    ]);

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'ClawRocket' });
    await screen.findByRole('heading', { name: 'Developer Quick Login' });
  });

  it('renders talks list when session is authenticated', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [
            {
              id: 'talk-1',
              ownerId: 'u1',
              title: 'Family Planning',
              status: 'active',
              version: 1,
              createdAt: '2026-03-04T00:00:00.000Z',
              updatedAt: '2026-03-04T00:00:00.000Z',
              accessRole: 'owner',
            },
          ],
          page: { limit: 50, offset: 0, count: 1 },
        },
      }),
    ]);

    renderWithRouter('/app/talks');
    await screen.findByRole('heading', { name: 'Talks' });
    expect(screen.getByRole('link', { name: /Family Planning/i })).toBeTruthy();
  });

  it('returns to sign-in when a later API call returns 401', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Refresh failed' },
      }),
      jsonResponse(200, {
        ok: true,
        data: { devMode: false },
      }),
    ]);

    renderWithRouter('/app/talks');
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'ClawRocket' })).toBeTruthy(),
    );
  });

  it('shows sign-in after clicking sign out from authenticated shell', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: { loggedOut: true },
      }),
      jsonResponse(200, {
        ok: true,
        data: { devMode: false },
      }),
    ]);

    renderWithRouter('/app/talks');
    const signOutButton = await screen.findByRole('button', {
      name: 'Sign out',
    });
    signOutButton.click();

    await screen.findByRole('heading', { name: 'ClawRocket' });
  });

  it('shows unavailable talk state for 404 detail fetch', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(404, {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-missing',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
    ]);

    renderWithRouter('/app/talks/talk-missing');
    await screen.findByRole('heading', { name: 'Talk Unavailable' });
  });
});

function renderWithRouter(initialEntry: string): void {
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>,
  );
}

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
