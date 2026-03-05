import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';

import { TalkListPage } from './TalkListPage';

describe('TalkListPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.cookie = 'cr_csrf_token=; Max-Age=0; path=/';
  });

  it('creates a talk and navigates to talk detail', async () => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
      jsonResponse(201, {
        ok: true,
        data: {
          talk: {
            id: 'talk-created-1',
            ownerId: 'owner-1',
            title: 'Created Talk',
            agents: ['Mock'],
            status: 'active',
            version: 1,
            createdAt: '2026-03-04T00:00:00.000Z',
            updatedAt: '2026-03-04T00:00:00.000Z',
            accessRole: 'owner',
          },
        },
      }),
    ]);

    const user = userEvent.setup();
    renderWithRouter();

    const titleInput = await screen.findByPlaceholderText('New Talk title');
    await user.type(titleInput, 'Created Talk');
    await user.click(screen.getByRole('button', { name: 'New Talk' }));

    await screen.findByText('Detail: talk-created-1');
  });

  it('shows inline error when talk creation fails', async () => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
      jsonResponse(500, {
        ok: false,
        error: {
          code: 'internal_error',
          message: 'Talk creation failed',
        },
      }),
    ]);

    const user = userEvent.setup();
    renderWithRouter();

    const titleInput = await screen.findByPlaceholderText('New Talk title');
    await user.type(titleInput, 'Will Fail');
    await user.click(screen.getByRole('button', { name: 'New Talk' }));

    await screen.findByRole('alert');
    expect(screen.getByText('Talk creation failed')).toBeTruthy();
  });

  it('renders agent chips for each talk row', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [
            {
              id: 'talk-1',
              ownerId: 'owner-1',
              title: 'Smoke Talk',
              agents: ['Gemini', 'Opus4.6'],
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

    renderWithRouter();
    await screen.findByRole('link', { name: /Smoke Talk/i });

    expect(screen.getByText('Gemini')).toBeTruthy();
    expect(screen.getByText('Opus4.6')).toBeTruthy();
  });
});

function renderWithRouter(): void {
  render(
    <MemoryRouter initialEntries={['/app/talks']}>
      <Routes>
        <Route
          path="/app/talks"
          element={<TalkListPage onUnauthorized={vi.fn()} />}
        />
        <Route path="/app/talks/:talkId" element={<TalkDetailMarker />} />
      </Routes>
    </MemoryRouter>,
  );
}

function TalkDetailMarker(): JSX.Element {
  const { talkId } = useParams<{ talkId: string }>();
  return <p>{`Detail: ${talkId}`}</p>;
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
