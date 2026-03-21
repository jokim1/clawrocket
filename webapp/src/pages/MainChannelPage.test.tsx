import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { MainChannelPage } from './MainChannelPage';
import { ApiError } from '../lib/api';
import type { openMainStream } from '../lib/mainStream';

type MainStreamCallbacks = Parameters<typeof openMainStream>[0];

const {
  deleteMainMessagesMock,
  listMainThreadsMock,
  getMainThreadMock,
  listMainRunsMock,
  postMainRunVisibleMock,
  postMainMessageMock,
  startBrowserSetupSessionMock,
  startBrowserTakeoverMock,
  resumeBrowserBlockedRunMock,
  approveBrowserConfirmationMock,
  rejectBrowserConfirmationMock,
  updateMainThreadMock,
  deleteMainThreadMock,
  openMainStreamMock,
} = vi.hoisted(() => ({
  deleteMainMessagesMock: vi.fn(),
  listMainThreadsMock: vi.fn(),
  getMainThreadMock: vi.fn(),
  listMainRunsMock: vi.fn(),
  postMainRunVisibleMock: vi.fn(),
  postMainMessageMock: vi.fn(),
  startBrowserSetupSessionMock: vi.fn(),
  startBrowserTakeoverMock: vi.fn(),
  resumeBrowserBlockedRunMock: vi.fn(),
  approveBrowserConfirmationMock: vi.fn(),
  rejectBrowserConfirmationMock: vi.fn(),
  updateMainThreadMock: vi.fn(),
  deleteMainThreadMock: vi.fn(),
  openMainStreamMock: vi.fn(() => ({ close: vi.fn() })),
}));

vi.mock('../lib/api', async () => {
  const actual =
    await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    deleteMainMessages: deleteMainMessagesMock,
    listMainThreads: listMainThreadsMock,
    getMainThread: getMainThreadMock,
    listMainRuns: listMainRunsMock,
    postMainRunVisible: postMainRunVisibleMock,
    postMainMessage: postMainMessageMock,
    startBrowserSetupSession: startBrowserSetupSessionMock,
    startBrowserTakeover: startBrowserTakeoverMock,
    resumeBrowserBlockedRun: resumeBrowserBlockedRunMock,
    approveBrowserConfirmation: approveBrowserConfirmationMock,
    rejectBrowserConfirmation: rejectBrowserConfirmationMock,
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
  beforeEach(() => {
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 2,
      deletedMessageIds: ['msg-1', 'msg-2'],
      threadDeleted: false,
    });
    listMainRunsMock.mockResolvedValue([]);
    postMainRunVisibleMock.mockResolvedValue({ recorded: true });
    startBrowserSetupSessionMock.mockResolvedValue({
      status: 'ok',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'session-1',
      url: 'https://www.linkedin.com/feed/',
      title: 'LinkedIn',
      reusedSession: false,
      createdProfile: false,
      message: 'Browser setup session opened.',
    });
    startBrowserTakeoverMock.mockResolvedValue({
      sessionId: 'session-1',
      siteKey: 'linkedin',
      accountLabel: null,
      headed: true,
      state: 'takeover',
      owner: 'user',
      blockedKind: 'auth_required',
      blockedMessage: 'Authenticate to continue.',
      currentUrl: 'https://www.linkedin.com/login',
      currentTitle: 'LinkedIn',
      lastUpdatedAt: '2026-03-20T20:24:00.000Z',
    });
    resumeBrowserBlockedRunMock.mockResolvedValue({
      runId: 'run-main-browser',
      resumed: true,
      browserResume: {
        kind: 'auth_completed',
        resumedAt: '2026-03-20T20:25:00.000Z',
        resumedBy: 'user-1',
        sessionId: 'session-1',
        confirmationId: null,
        note: null,
        pendingToolCall: null,
      },
    });
    approveBrowserConfirmationMock.mockResolvedValue({
      confirmationId: 'confirmation-1',
      runId: 'run-main-browser',
      approved: true,
      browserResume: {
        kind: 'confirmation_approved',
        resumedAt: '2026-03-20T20:25:00.000Z',
        resumedBy: 'user-1',
        sessionId: 'session-1',
        confirmationId: 'confirmation-1',
        note: null,
        pendingToolCall: null,
      },
    });
    rejectBrowserConfirmationMock.mockResolvedValue({
      confirmationId: 'confirmation-1',
      runId: 'run-main-browser',
      rejected: true,
    });
  });

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
        hasActiveRun: false,
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
        hasActiveRun: false,
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
        hasActiveRun: false,
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
      run: {
        id: 'run-1',
        threadId: 'thread-main-1',
        status: 'queued',
        createdAt: '2026-03-18T12:00:00.000Z',
        startedAt: null,
        endedAt: null,
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
      },
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

  it('opens edit history from /edit and deletes selected Main thread messages', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('confirm', vi.fn(() => true));
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:02.000Z',
        messageCount: 3,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Old main prompt',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:00.000Z',
      },
      {
        id: 'msg-2',
        threadId: 'thread-main-1',
        role: 'assistant',
        content: 'Old main answer',
        agentId: null,
        createdBy: null,
        createdAt: '2026-03-18T12:00:01.000Z',
      },
      {
        id: 'msg-3',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Keep this latest main note',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-18T12:00:02.000Z',
      },
    ]);
    deleteMainMessagesMock.mockResolvedValue({
      threadId: 'thread-main-1',
      deletedCount: 2,
      deletedMessageIds: ['msg-1', 'msg-2'],
      threadDeleted: false,
    });

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

    const composer = await screen.findByPlaceholderText('Message Nanoclaw…');
    const streamCallbacks = (
      openMainStreamMock.mock.calls as unknown as Array<[MainStreamCallbacks]>
    )[0]?.[0];
    expect(streamCallbacks).toBeTruthy();
    streamCallbacks?.onResponseStarted?.({
      runId: 'run-failed-1',
      threadId: 'thread-main-1',
      agentId: 'agent-1',
      agentName: 'Sonnet Heavy',
    });
    streamCallbacks?.onResponseFailed?.({
      runId: 'run-failed-1',
      threadId: 'thread-main-1',
      errorCode: 'unauthorized',
      errorMessage: 'Anthropic API error: Unauthorized',
    });
    expect(
      await screen.findByText('Anthropic API error: Unauthorized'),
    ).toBeTruthy();
    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();
    await user.click(screen.getByLabelText(/You.*Old main prompt/i));
    await user.click(screen.getByLabelText(/Nanoclaw.*Old main answer/i));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(deleteMainMessagesMock).toHaveBeenCalledWith({
      threadId: 'thread-main-1',
      messageIds: ['msg-1', 'msg-2'],
    });
    expect(
      await screen.findByText('Deleted 2 messages from this Main thread history.'),
    ).toBeTruthy();
    expect(screen.queryByText('Old main prompt')).toBeNull();
    expect(screen.queryByText('Old main answer')).toBeNull();
    expect(screen.queryByText('Anthropic API error: Unauthorized')).toBeNull();
    expect(screen.getByText('Keep this latest main note')).toBeTruthy();
  });

  it('clears stale failed live responses when a new user message arrives on the active Main thread', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Planning',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 1,
        hasActiveRun: false,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-1',
        threadId: 'thread-main-1',
        role: 'user',
        content: 'Old main prompt',
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

    await screen.findByText('Old main prompt');
    const streamCallbacks = (
      openMainStreamMock.mock.calls as unknown as Array<[MainStreamCallbacks]>
    )[0]?.[0];
    expect(streamCallbacks).toBeTruthy();
    streamCallbacks?.onResponseStarted?.({
      runId: 'run-failed-1',
      threadId: 'thread-main-1',
      agentId: 'agent-1',
      agentName: 'Sonnet Heavy',
    });
    streamCallbacks?.onResponseFailed?.({
      runId: 'run-failed-1',
      threadId: 'thread-main-1',
      errorCode: 'unauthorized',
      errorMessage: 'Anthropic API error: Unauthorized',
    });
    expect(
      await screen.findByText('Anthropic API error: Unauthorized'),
    ).toBeTruthy();

    streamCallbacks?.onMessageAppended({
      talkId: null,
      threadId: 'thread-main-1',
      messageId: 'msg-2',
      runId: null,
      role: 'user',
      createdBy: 'user-1',
      content: 'Try LinkedIn again',
      createdAt: '2026-03-18T12:05:00.000Z',
      agentId: null,
    });

    await waitFor(() =>
      expect(screen.queryByText('Anthropic API error: Unauthorized')).toBeNull(),
    );
    expect(screen.getByText('Try LinkedIn again')).toBeTruthy();
  });

  it('shows pending copy in the thread sidebar when a thread is still responding', async () => {
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-1',
        title: 'Capabilities',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-1',
        threadId: 'thread-main-1',
        status: 'running',
        createdAt: '2026-03-18T12:00:00.000Z',
        startedAt: '2026-03-18T12:00:01.000Z',
        endedAt: null,
        triggerMessageId: 'msg-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: [],
        userVisibleSummary: null,
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

    const threadRail = screen.getByLabelText('Threads');
    await within(threadRail).findByText('Capabilities');
    expect(within(threadRail).getByText('* Thinking…')).toBeTruthy();
  });

  it('renders blocked browser runs in the Main timeline and starts setup from the inline card', async () => {
    const user = userEvent.setup();
    listMainThreadsMock.mockResolvedValue([
      {
        threadId: 'thread-main-browser',
        title: 'LinkedIn Messaging',
        isPinned: false,
        lastMessageAt: '2026-03-20T20:20:00.000Z',
        messageCount: 1,
        hasActiveRun: true,
      },
    ]);
    getMainThreadMock.mockResolvedValue([
      {
        id: 'msg-main-1',
        threadId: 'thread-main-browser',
        role: 'user',
        content: 'Check my LinkedIn inbox',
        agentId: null,
        createdBy: 'user-1',
        createdAt: '2026-03-20T20:20:00.000Z',
      },
    ]);
    listMainRunsMock.mockResolvedValue([
      {
        id: 'run-main-browser',
        threadId: 'thread-main-browser',
        status: 'awaiting_confirmation',
        createdAt: '2026-03-20T20:20:01.000Z',
        startedAt: '2026-03-20T20:20:03.000Z',
        endedAt: null,
        triggerMessageId: 'msg-main-1',
        targetAgentId: null,
        cancelReason: null,
        kind: null,
        parentRunId: null,
        promotionState: null,
        promotionChildRunId: null,
        requestedToolFamilies: ['browser'],
        userVisibleSummary: 'LinkedIn needs you to sign in.',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'session-1',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/login',
          title: 'LinkedIn Login',
          message: 'LinkedIn needs interactive login before the run can continue.',
          riskReason: null,
          setupCommand: 'npx tsx src/clawrocket/browser/setup.ts --site linkedin',
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_open',
            args: {},
          },
          createdAt: '2026-03-20T20:20:04.000Z',
          updatedAt: '2026-03-20T20:20:04.000Z',
        },
        browserResume: null,
        carriedBrowserSessions: [],
        executionDecision: {
          backend: 'direct_http',
          authPath: 'subscription',
          credentialSource: 'oauth_token',
          plannerReason: 'Browser stayed in the direct Main parent.',
          providerId: 'provider.anthropic',
          modelId: 'claude-sonnet-4-6',
        },
      },
    ]);

    render(
      <MemoryRouter initialEntries={['/app/main/thread-main-browser']}>
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

    await screen.findByText('Browser authentication required');
    expect(screen.getByText('LinkedIn needs interactive login before the run can continue.')).toBeTruthy();

    await user.click(
      screen.getByRole('button', { name: 'Authenticate browser' }),
    );

    await waitFor(() =>
      expect(startBrowserSetupSessionMock).toHaveBeenCalledWith({
        siteKey: 'linkedin',
        accountLabel: null,
        url: 'https://www.linkedin.com/login',
      }),
    );
    expect(screen.getByText('Browser setup session opened.')).toBeTruthy();
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
        hasActiveRun: false,
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
        hasActiveRun: false,
      },
      {
        threadId: 'thread-main-2',
        title: 'Newer',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 3,
        hasActiveRun: false,
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
    const olderThread = screen
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('main-thread-item') &&
          within(button).queryByText('Older'),
      );
    expect(olderThread).toBeTruthy();
    fireEvent.contextMenu(olderThread!, { clientX: 24, clientY: 36 });
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
        hasActiveRun: false,
      },
      {
        threadId: 'thread-main-2',
        title: 'Delete me',
        isPinned: false,
        lastMessageAt: '2026-03-18T12:00:00.000Z',
        messageCount: 2,
        hasActiveRun: false,
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
    const deleteThreadButton = within(threadRail)
      .getAllByRole('button')
      .find(
        (button) =>
          button.className.includes('main-thread-item') &&
          within(button).queryByText('Delete me'),
      );
    expect(deleteThreadButton).toBeTruthy();
    fireEvent.contextMenu(deleteThreadButton!, { clientX: 24, clientY: 36 });
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
