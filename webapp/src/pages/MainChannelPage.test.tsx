import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
  updateMainThreadMock,
  deleteMainThreadMock,
  openMainStreamMock,
} = vi.hoisted(() => ({
  listMainThreadsMock: vi.fn(),
  getMainThreadMock: vi.fn(),
  postMainMessageMock: vi.fn(),
  updateMainThreadMock: vi.fn(),
  deleteMainThreadMock: vi.fn(),
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
    updateMainThread: updateMainThreadMock,
    deleteMainThread: deleteMainThreadMock,
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
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('drops stale route thread ids that are not in the current Main thread list', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: '78fc5d1e-e7e9-4d65-a82d-352c89eba992',
        title: 'Morning planning',
        isPinned: false,
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
        isPinned: false,
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
        isPinned: false,
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

  it('opens a right-click menu and renames a thread inline', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Capabilities',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    updateMainThreadMock.mockResolvedValue({
      threadId: 'thread-main-1',
      title: 'Planning',
      isPinned: false,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-1']}>
        <Routes>
          <Route path="/app/main" element={<MainChannelPage onUnauthorized={vi.fn()} />} />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Capabilities');
    fireEvent.contextMenu(within(threadRail).getByText('Capabilities'));

    await user.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Rename thread' });
    await user.clear(input);
    await user.type(input, 'Planning{Enter}');

    await waitFor(() => {
      expect(screen.getAllByText('Planning').length).toBeGreaterThan(0);
    });
    expect(updateMainThreadMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      title: 'Planning',
    });
  });

  it('pins a thread and reorders pinned threads first', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Older',
        isPinned: false,
        lastMessageAt: '2026-03-18T11:00:00.000Z',
        messageCount: 2,
      },
      {
        threadId: 'thread-main-2',
        title: 'Newer',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 3,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    updateMainThreadMock.mockResolvedValue({
      threadId: 'thread-main-1',
      title: 'Older',
      isPinned: true,
    });

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-2']}>
        <Routes>
          <Route path="/app/main" element={<MainChannelPage onUnauthorized={vi.fn()} />} />
          <Route
            path="/app/main/:threadId"
            element={<MainChannelPage onUnauthorized={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByText('Older');
    fireEvent.contextMenu(screen.getByText('Older'));
    await user.click(screen.getByRole('menuitem', { name: 'Pin' }));

    await waitFor(() => {
      const items = screen
        .getAllByRole('button')
        .filter((button) =>
          button.className.includes('main-thread-item'),
        );
      expect(within(items[0]!).getByText('Older')).toBeTruthy();
    });
    expect(updateMainThreadMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      pinned: true,
    });
  });

  it('deletes a thread after confirmation and navigates to the next thread', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Keep me',
        isPinned: false,
        lastMessageAt: '2026-03-18T11:00:00.000Z',
        messageCount: 1,
      },
      {
        threadId: 'thread-main-2',
        title: 'Delete me',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    deleteMainThreadMock.mockResolvedValue(undefined);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-2']}>
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

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Delete me');
    fireEvent.contextMenu(within(threadRail).getByText('Delete me'));
    await user.click(screen.getByRole('menuitem', { name: 'Delete thread' }));

    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/app/main/thread-main-1',
      ),
    );
    expect(deleteMainThreadMock).toHaveBeenCalledWith('thread-main-2');
    expect(
      within(threadRail).queryByText('Delete me'),
    ).toBeNull();
  });
});

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}
