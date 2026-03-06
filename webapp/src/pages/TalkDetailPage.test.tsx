import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { TalkDetailPage } from './TalkDetailPage';
import { openTalkStream } from '../lib/talkStream';

vi.mock('../lib/talkStream', () => ({
  openTalkStream: vi.fn(),
}));

type StreamCallbacks = Parameters<typeof openTalkStream>[0];

describe('TalkDetailPage', () => {
  const openTalkStreamMock = vi.mocked(openTalkStream);
  let streamInput: StreamCallbacks | null = null;
  let closeStreamSpy: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    streamInput = null;
    closeStreamSpy = vi.fn();
    openTalkStreamMock.mockImplementation((input) => {
      streamInput = input;
      return {
        close: () => {
          closeStreamSpy();
        },
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.cookie = 'cr_csrf_token=; Max-Age=0; path=/';
  });

  it('hides cancel button for viewer and shows it for editor', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'viewer' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    const { unmount } = renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });
    expect(
      screen.queryByRole('button', { name: 'Cancel Runs' }),
    ).toBeNull();
    expect(screen.queryByLabelText('Comma-separated agents')).toBeNull();

    unmount();

    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'editor' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });
    expect(screen.getByRole('button', { name: 'Cancel Runs' })).toBeTruthy();
    expect(screen.getByLabelText('Comma-separated agents')).toBeTruthy();
  });

  it('renders effective agent badges from talk payload', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({
            accessRole: 'owner',
            agents: ['Gemini', 'Opus4.6', 'Haiku'],
          }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    const effectiveAgents = screen.getByRole('list', {
      name: 'Effective agents',
    });
    expect(within(effectiveAgents).getByText('Gemini')).toBeTruthy();
    expect(within(effectiveAgents).getByText('Opus4.6')).toBeTruthy();
    expect(within(effectiveAgents).getByText('Haiku')).toBeTruthy();
  });

  it('updates talk policy from detail editor', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner', agents: ['Gemini'] }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini', 'Opus4.6'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini', 'Opus4.6'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });
    const input = screen.getByLabelText('Comma-separated agents');
    await user.clear(input);
    await user.type(input, 'Gemini, Opus4.6');
    await user.click(screen.getByRole('button', { name: 'Save Agents' }));

    await screen.findByText('Talk policy updated.');
    const policyPanel = screen.getByLabelText('Talk policy');
    expect(within(policyPanel).getByText('Gemini')).toBeTruthy();
    expect(within(policyPanel).getByText('Opus4.6')).toBeTruthy();
  });

  it('initializes policy editor from raw policy endpoint when talk badges show fallback', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner', agents: ['Mock'] }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: [],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    const input = screen.getByLabelText(
      'Comma-separated agents',
    ) as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('preserves full policy agent list on save beyond badge-cap display', async () => {
    const fullPolicyAgents = [
      'Gemini',
      'Opus4.6',
      'Haiku',
      'GPT-4o',
      'Sonnet',
      'Mistral',
      'Llama',
      'Qwen',
    ];
    const badgeAgents = fullPolicyAgents.slice(0, 6);
    const responses = [
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner', agents: badgeAgents }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: fullPolicyAgents,
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: fullPolicyAgents,
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ];
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        const next = responses.shift();
        if (!next) {
          throw new Error('No mocked response left for fetch()');
        }
        return next;
      },
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    const input = screen.getByLabelText(
      'Comma-separated agents',
    ) as HTMLInputElement;
    expect(input.value).toBe(fullPolicyAgents.join(', '));

    await user.click(screen.getByRole('button', { name: 'Save Agents' }));
    await screen.findByText('Talk policy updated.');

    expect(fetchMock.mock.calls).toHaveLength(4);
    const putCall = fetchMock.mock.calls[3];
    expect(putCall).toBeTruthy();
    const putInit = putCall?.[1] as RequestInit | undefined;
    const body = putInit?.body;
    expect(typeof body).toBe('string');
    const parsed = JSON.parse(body as string) as { agents: Array<{ name: string }> };
    expect(parsed.agents.map((agent) => agent.name)).toEqual(fullPolicyAgents);
  });

  it('shows send and cancel inline error states and clears send error on typing', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [],
          page: { limit: 100, count: 0, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
      jsonResponse(500, {
        ok: false,
        error: { code: 'send_failed', message: 'send exploded' },
      }),
      jsonResponse(500, {
        ok: false,
        error: { code: 'cancel_failed', message: 'cancel exploded' },
      }),
    ]);

    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    await user.type(screen.getByPlaceholderText('Send a message to this talk'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('send exploded');

    await user.type(screen.getByPlaceholderText('Send a message to this talk'), '!');
    await waitFor(() => {
      expect(screen.queryByText('send exploded')).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'Cancel Runs' }));
    await screen.findByText('cancel exploded');
  });

  it('replay-gap resync clears runs and rebuilds from subsequent events', async () => {
    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'first',
              createdBy: 'owner-1',
              createdAt: '2026-03-04T00:00:00.000Z',
              runId: null,
            },
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'first',
              createdBy: 'owner-1',
              createdAt: '2026-03-04T00:00:00.000Z',
              runId: null,
            },
            {
              id: 'msg-2',
              role: 'assistant',
              content: 'second',
              createdBy: null,
              createdAt: '2026-03-04T00:00:01.000Z',
              runId: 'run-2',
            },
          ],
          page: { limit: 100, count: 2, beforeCreatedAt: null },
        },
      }),
    ]);

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    expect(streamInput).toBeTruthy();
    await act(async () => {
      streamInput?.onRunStarted({
        talkId: 'talk-1',
        runId: 'run-1',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
    });
    expect(screen.getByText('run-1')).toBeTruthy();

    await act(async () => {
      await streamInput?.onReplayGap();
    });

    expect(screen.queryByText('run-1')).toBeNull();
    expect(screen.getByText('second')).toBeTruthy();

    await act(async () => {
      streamInput?.onRunQueued({
        talkId: 'talk-1',
        runId: 'run-2',
        triggerMessageId: 'msg-1',
        status: 'queued',
      });
    });
    expect(screen.getByText('run-2')).toBeTruthy();
  });

  it('renders run history links and jumps to trigger/response messages', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'tell me about Gemini models',
              createdBy: 'owner-1',
              createdAt: '2026-03-04T00:00:00.000Z',
              runId: null,
            },
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    await act(async () => {
      streamInput?.onRunStarted({
        talkId: 'talk-1',
        runId: 'run-5',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
    });

    await act(async () => {
      streamInput?.onMessageAppended({
        talkId: 'talk-1',
        messageId: 'msg-2',
        role: 'assistant',
        runId: 'run-5',
        createdBy: null,
        content: 'Here is a comparison.',
        createdAt: '2026-03-04T00:00:01.000Z',
      });
    });

    await act(async () => {
      streamInput?.onRunCompleted({
        talkId: 'talk-1',
        runId: 'run-5',
        triggerMessageId: 'msg-1',
        responseMessageId: 'msg-2',
        executorAlias: 'Gemini',
        executorModel: 'default',
      });
    });

    const runHistory = screen.getByLabelText('Run history');
    expect(within(runHistory).getByText('run-5')).toBeTruthy();
    expect(within(runHistory).getByText('completed')).toBeTruthy();
    expect(within(runHistory).getByText('Executor:')).toBeTruthy();
    expect(within(runHistory).getByText('Gemini')).toBeTruthy();
    expect(within(runHistory).getByText('default')).toBeTruthy();

    const triggerLink = within(runHistory).getByRole('button', {
      name: /Trigger:/i,
    });
    const responseLink = within(runHistory).getByRole('button', {
      name: /Response:/i,
    });
    const baselineCalls = scrollIntoView.mock.calls.length;

    await user.click(triggerLink);
    await user.click(responseLink);

    expect(scrollIntoView.mock.calls.length).toBeGreaterThanOrEqual(
      baselineCalls + 2,
    );
  });

  it('forces initial scroll and shows unread indicator when new events arrive below viewport', async () => {
    const scrollIntoView = vi.fn();
    vi.stubGlobal('IntersectionObserver', vi.fn());
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    mockFetch([
      jsonResponse(200, {
        ok: true,
        data: {
          talk: buildTalk({ accessRole: 'owner' }),
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          messages: [
            {
              id: 'msg-1',
              role: 'user',
              content: 'hello',
              createdBy: 'owner-1',
              createdAt: '2026-03-04T00:00:00.000Z',
              runId: null,
            },
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talkId: 'talk-1',
          agents: ['Gemini'],
          limits: { maxAgents: 12, maxAgentChars: 80 },
        },
      }),
    ]);

    const user = userEvent.setup();
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    expect(scrollIntoView).toHaveBeenCalled();

    const timeline = screen.getByLabelText('Talk timeline');
    Object.defineProperty(timeline, 'scrollHeight', {
      configurable: true,
      get: () => 1000,
    });
    Object.defineProperty(timeline, 'clientHeight', {
      configurable: true,
      get: () => 300,
    });
    Object.defineProperty(timeline, 'scrollTop', {
      configurable: true,
      get: () => 100,
      set: () => undefined,
    });

    await act(async () => {
      streamInput?.onMessageAppended({
        talkId: 'talk-1',
        messageId: 'msg-2',
        role: 'assistant',
        runId: 'run-2',
        createdBy: null,
        content: 'new message',
        createdAt: '2026-03-04T00:00:01.000Z',
      });
    });

    const indicator = await screen.findByRole('button', { name: 'New messages' });
    await user.click(indicator);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'New messages' })).toBeNull();
    });
  });
});

function renderDetailPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={['/app/talks/talk-1']}>
      <Routes>
        <Route
          path="/app/talks/:talkId"
          element={<TalkDetailPage onUnauthorized={vi.fn()} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

function buildTalk(input: {
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
  agents?: string[];
}) {
  return {
    id: 'talk-1',
    ownerId: 'owner-1',
    title: 'Smoke Talk',
    agents: input.agents || ['Gemini'],
    status: 'active',
    version: 1,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    accessRole: input.accessRole,
  };
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
