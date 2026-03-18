import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { MainChannelPage } from './MainChannelPage';
import { ApiError } from '../lib/api';

const {
  listMainThreadsMock,
  getMainThreadMock,
  postMainMessageMock,
  updateMainThreadTitleMock,
  openMainStreamMock,
} = vi.hoisted(() => ({
  listMainThreadsMock: vi.fn(),
  getMainThreadMock: vi.fn(),
  postMainMessageMock: vi.fn(),
  updateMainThreadTitleMock: vi.fn(),
  openMainStreamMock: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../lib/api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    listMainThreads: listMainThreadsMock,
    getMainThread: getMainThreadMock,
    postMainMessage: postMainMessageMock,
    updateMainThreadTitle: updateMainThreadTitleMock,
  };
});

vi.mock('../lib/mainStream', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/mainStream')>(
      '../lib/mainStream',
    );
  return {
    ...actual,
    openMainStream: openMainStreamMock,
  };
});

describe('MainChannelPage', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('drops stale route thread ids that are not in the current Main thread list', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        title: 'Morning planning',
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread_stale']}>
        <Routes>
          <Route
            path="/app/main"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
          <Route
            path="/app/main/:threadId"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/main'),
    );
    expect(getMainThreadMock).not.toHaveBeenCalled();
    expect(screen.getByText('Nanoclaw')).toBeTruthy();
  });

  it('navigates away from a Main thread that now returns 404', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        title: 'Morning planning',
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
      },
    ]);
    getMainThreadMock.mockRejectedValue(
      new ApiError(
        "Thread '78fc5d1e-e7e9-4d65-a82d-352c89eba992' not found",
        404,
        'not_found',
      ),
    );

    render(
      <MemoryRouter
        initialEntries={['/app/main/78fc5d1e-e7e9-4d65-a82d-352c89eba992']}
      >
        <Routes>
          <Route
            path="/app/main"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
          <Route
            path="/app/main/:threadId"
            element={
              <>
                <LocationProbe />
                <MainChannelPage onUnauthorized={vi.fn()} />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/app/main'),
    );
    expect(screen.queryByText(/ApiError:/)).toBeNull();
  });

  it('renders inferred thread titles and the shared new-thread affordance', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Cal football recruiting notes',
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Cal football recruiting notes',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: 'Start new thread' });
    expect(screen.getAllByText('Cal football recruiting notes')).toHaveLength(
      2,
    );
    expect(screen.getByRole('button', { name: 'Rename thread' })).toBeTruthy();
  });

  it('strips surrounding quotes when inferring a new Main thread title', async () => {
    listMainThreadsMock.mockResolvedValue([]);
    getMainThreadMock.mockResolvedValue([]);
    postMainMessageMock.mockResolvedValue({
      messageId: 'msg-1',
      threadId: 'thread-main-1',
      runId: 'run-1',
      title: null,
    });

    render(
      <MemoryRouter initialEntries={['/app/main']}>
        <Routes>
          <Route
            path="/app/main"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Main (Nanoclaw)' });
    fireEvent.change(screen.getByPlaceholderText('Message Nanoclaw…'), {
      target: { value: '"Cal football recruiting notes"' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(
        screen.getAllByText('Cal football recruiting notes')[0],
      ).toBeTruthy(),
    );
    expect(screen.queryByText('"Cal football recruiting notes"')).toBeNull();
  });
});

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}
