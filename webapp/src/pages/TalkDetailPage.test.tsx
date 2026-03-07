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
import type { AiAgentsPageData, TalkAgent, TalkMessage } from '../lib/api';

vi.mock('../lib/talkStream', () => ({
  openTalkStream: vi.fn(),
}));

type StreamCallbacks = Parameters<typeof openTalkStream>[0];
type SavedAgentRequest = {
  agents: Array<{
    id: string;
    sourceKind: 'claude_default' | 'provider';
    providerId: string | null;
    modelId: string;
    role: string;
    isLead: boolean;
    displayOrder: number;
  }>;
};

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

  it('hides agent editing for viewers and shows it for editors', async () => {
    installTalkDetailFetch({
      talk: buildTalk({ accessRole: 'viewer' }),
    });

    const { unmount } = renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });
    expect(screen.queryByRole('button', { name: 'Cancel Runs' })).toBeNull();
    expect(
      screen.getByText('You have read-only access to talk agents.'),
    ).toBeTruthy();
    unmount();

    installTalkDetailFetch({
      talk: buildTalk({ accessRole: 'editor' }),
    });
    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });
    expect(screen.getByRole('button', { name: 'Cancel Runs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add Agent' })).toBeTruthy();
  });

  it('renders effective agent badges from the talk payload', async () => {
    installTalkDetailFetch({
      talk: buildTalk({
        accessRole: 'owner',
        agents: ['Claude', 'Gemini 2.5 Flash', 'OpenAI GPT-5 Mini'],
      }),
    });

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    const effectiveAgents = screen.getByRole('list', {
      name: 'Effective agents',
    });
    expect(within(effectiveAgents).getByText('Claude')).toBeTruthy();
    expect(within(effectiveAgents).getByText('Gemini 2.5 Flash')).toBeTruthy();
    expect(within(effectiveAgents).getByText('OpenAI GPT-5 Mini')).toBeTruthy();
  });

  it('updates talk agents from the source, model, and role editor', async () => {
    const user = userEvent.setup();
    let savedRequestBody: SavedAgentRequest | undefined;

    installTalkDetailFetch({
      onPutAgents: (body) => {
        savedRequestBody = body;
        return {
          talkId: 'talk-1',
          agents: [
            buildTalkAgent({
              id: body.agents[0].id,
              name: 'Gemini',
              sourceKind: 'provider',
              role: 'analyst',
              isLead: false,
              displayOrder: 0,
              providerId: 'provider.gemini',
              providerName: 'Google / Gemini',
              modelId: 'gemini-2.5-flash',
              modelDisplayName: 'Gemini 2.5 Flash',
            }),
            buildTalkAgent({
              id: body.agents[1].id,
              name: 'Claude',
              sourceKind: 'claude_default',
              role: 'assistant',
              isLead: true,
              displayOrder: 1,
              providerId: 'provider.anthropic',
              providerName: 'Anthropic',
              modelId: 'claude-sonnet-4-5',
              modelDisplayName: 'Claude Sonnet 4.5',
            }),
          ],
        };
      },
    });

    renderDetailPage();
    await screen.findByRole('heading', { name: /Smoke Talk/i });

    await user.selectOptions(screen.getAllByLabelText('Role')[0], 'analyst');

    const controls = screen
      .getByRole('button', { name: 'Add Agent' })
      .closest('.policy-editor-controls') as HTMLElement | null;
    if (!controls) {
      throw new Error('Expected talk agent controls');
    }

    await user.selectOptions(within(controls).getByLabelText('Source'), 'claude_default');
    await user.selectOptions(
      within(controls).getByLabelText('Model'),
      'claude-sonnet-4-5',
    );
    await user.click(within(controls).getByRole('button', { name: 'Add Agent' }));
    await user.click(screen.getAllByLabelText('Primary Agent')[1]);
    await user.click(screen.getByRole('button', { name: 'Save Agents' }));

    expect(await screen.findByText('Talk agents updated.')).toBeTruthy();
    if (!savedRequestBody) {
      throw new Error('Expected talk agent update request payload');
    }

    expect(savedRequestBody.agents).toHaveLength(2);
    expect(savedRequestBody.agents[0]).toMatchObject({
      sourceKind: 'provider',
      providerId: 'provider.gemini',
      modelId: 'gemini-2.5-flash',
      role: 'analyst',
      isLead: false,
      displayOrder: 0,
    });
    expect(savedRequestBody.agents[1]).toMatchObject({
      sourceKind: 'claude_default',
      providerId: null,
      modelId: 'claude-sonnet-4-5',
      role: 'assistant',
      isLead: true,
      displayOrder: 1,
    });

    const talkAgentsPanel = screen.getByLabelText('Talk agents');
    expect(
      within(talkAgentsPanel).getByText('Gemini 2.5 Flash · Analyst'),
    ).toBeTruthy();
    expect(
      within(talkAgentsPanel).getByText('Claude Sonnet 4.5 · General · Primary'),
    ).toBeTruthy();
  });

  it('shows send and cancel inline error states and clears send error on typing', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      onSendMessage: () => ({
        status: 500,
        body: {
          ok: false,
          error: { code: 'send_failed', message: 'send exploded' },
        },
      }),
      onCancelRuns: () => ({
        status: 500,
        body: {
          ok: false,
          error: { code: 'cancel_failed', message: 'cancel exploded' },
        },
      }),
    });

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
    installTalkDetailFetch({
      messagesResponses: [
        {
          talkId: 'talk-1',
          messages: [
            buildMessage({
              id: 'msg-1',
              role: 'user',
              content: 'first',
              createdAt: '2026-03-04T00:00:00.000Z',
            }),
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
        {
          talkId: 'talk-1',
          messages: [
            buildMessage({
              id: 'msg-1',
              role: 'user',
              content: 'first',
              createdAt: '2026-03-04T00:00:00.000Z',
            }),
            buildMessage({
              id: 'msg-2',
              role: 'assistant',
              content: 'second',
              createdAt: '2026-03-04T00:00:01.000Z',
              runId: 'run-2',
            }),
          ],
          page: { limit: 100, count: 2, beforeCreatedAt: null },
        },
      ],
    });

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

  it('renders run history links and jumps to trigger and response messages', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    installTalkDetailFetch({
      messagesResponses: [
        {
          talkId: 'talk-1',
          messages: [
            buildMessage({
              id: 'msg-1',
              role: 'user',
              content: 'tell me about Gemini models',
              createdAt: '2026-03-04T00:00:00.000Z',
            }),
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
      ],
    });

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

    installTalkDetailFetch({
      messagesResponses: [
        {
          talkId: 'talk-1',
          messages: [
            buildMessage({
              id: 'msg-1',
              role: 'user',
              content: 'hello',
              createdAt: '2026-03-04T00:00:00.000Z',
            }),
          ],
          page: { limit: 100, count: 1, beforeCreatedAt: null },
        },
      ],
    });

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
    agents: input.agents || ['Claude'],
    status: 'active',
    version: 1,
    createdAt: '2026-03-04T00:00:00.000Z',
    updatedAt: '2026-03-04T00:00:00.000Z',
    accessRole: input.accessRole,
  };
}

function buildTalkAgent(
  input: Partial<TalkAgent> & Pick<TalkAgent, 'id' | 'name'>,
): TalkAgent {
  return {
    id: input.id,
    name: input.name,
    sourceKind: input.sourceKind ?? 'provider',
    role: input.role ?? 'assistant',
    isLead: input.isLead ?? false,
    displayOrder: input.displayOrder ?? 0,
    status: input.status ?? 'active',
    providerId: input.providerId ?? null,
    providerName: input.providerName ?? null,
    modelId: input.modelId ?? null,
    modelDisplayName: input.modelDisplayName ?? null,
  };
}

function buildMessage(
  input: Partial<TalkMessage> & Pick<TalkMessage, 'id' | 'role' | 'content' | 'createdAt'>,
): TalkMessage {
  return {
    id: input.id,
    role: input.role,
    content: input.content,
    createdBy: input.createdBy ?? 'owner-1',
    createdAt: input.createdAt,
    runId: input.runId ?? null,
    agentId: input.agentId,
    agentName: input.agentName,
  };
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
    ],
    additionalProviders: [
      {
        id: 'provider.gemini',
        name: 'Google / Gemini',
        providerKind: 'gemini',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://generativelanguage.googleapis.com/openai',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: true,
        credentialHint: '••••FLASH',
        verificationStatus: 'verified',
        lastVerifiedAt: '2026-03-05T12:00:00.000Z',
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
        id: 'provider.openai',
        name: 'OpenAI',
        providerKind: 'openai',
        apiFormat: 'openai_chat_completions',
        baseUrl: 'https://api.openai.com/v1',
        authScheme: 'bearer',
        enabled: true,
        hasCredential: true,
        credentialHint: '••••MINI',
        verificationStatus: 'verified',
        lastVerifiedAt: '2026-03-05T12:00:00.000Z',
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
  };
}

function installTalkDetailFetch(input?: {
  talk?: ReturnType<typeof buildTalk>;
  messagesResponses?: Array<{
    talkId: string;
    messages: TalkMessage[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>;
  talkAgents?: TalkAgent[];
  aiAgents?: AiAgentsPageData;
  onPutAgents?: (body: SavedAgentRequest) => { talkId: string; agents: TalkAgent[] };
  onSendMessage?: () => { status: number; body: unknown };
  onCancelRuns?: () => { status: number; body: unknown };
}) {
  const talk = input?.talk || buildTalk({ accessRole: 'owner' });
  const messagesQueue = [
    ...(input?.messagesResponses || [
      {
        talkId: 'talk-1',
        messages: [],
        page: { limit: 100, count: 0, beforeCreatedAt: null },
      },
    ]),
  ];
  const aiAgents = input?.aiAgents || buildAiAgentsData();
  const initialAgents =
    input?.talkAgents ||
    [
      buildTalkAgent({
        id: 'talk-agent-1',
        name: 'Gemini',
        sourceKind: 'provider',
        role: 'assistant',
        isLead: true,
        displayOrder: 0,
        providerId: 'provider.gemini',
        providerName: 'Google / Gemini',
        modelId: 'gemini-2.5-flash',
        modelDisplayName: 'Gemini 2.5 Flash',
      }),
    ];

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

      if (url.endsWith('/api/v1/talks/talk-1') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (url.endsWith('/api/v1/talks/talk-1/messages') && method === 'GET') {
        const nextMessages = messagesQueue.shift();
        if (!nextMessages) {
          throw new Error('No mocked messages response left for fetch()');
        }
        return jsonResponse(200, { ok: true, data: nextMessages });
      }

      if (url.endsWith('/api/v1/talks/talk-1/agents') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: initialAgents },
        });
      }

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: aiAgents });
      }

      if (url.endsWith('/api/v1/talks/talk-1/agents') && method === 'PUT') {
        const parsed = JSON.parse(String(init?.body || '{}')) as SavedAgentRequest;
        const payload = input?.onPutAgents
          ? input.onPutAgents(parsed)
          : {
              talkId: 'talk-1',
              agents: parsed.agents.map((agent) => {
                if (agent.sourceKind === 'claude_default') {
                  const model =
                    aiAgents.claudeModelSuggestions.find(
                      (entry) => entry.modelId === agent.modelId,
                    ) || null;
                  return buildTalkAgent({
                    id: agent.id,
                    name: 'Claude',
                    sourceKind: 'claude_default',
                    role: agent.role as TalkAgent['role'],
                    isLead: agent.isLead,
                    displayOrder: agent.displayOrder,
                    providerId: 'provider.anthropic',
                    providerName: 'Anthropic',
                    modelId: agent.modelId,
                    modelDisplayName: model?.displayName || agent.modelId,
                  });
                }

                const provider = aiAgents.additionalProviders.find(
                  (entry) => entry.id === agent.providerId,
                );
                const model = provider?.modelSuggestions.find(
                  (entry) => entry.modelId === agent.modelId,
                );
                return buildTalkAgent({
                  id: agent.id,
                  name: provider?.name || 'Provider',
                  sourceKind: 'provider',
                  role: agent.role as TalkAgent['role'],
                  isLead: agent.isLead,
                  displayOrder: agent.displayOrder,
                  providerId: agent.providerId,
                  providerName: provider?.name || null,
                  modelId: agent.modelId,
                  modelDisplayName: model?.displayName || agent.modelId,
                });
              }),
            };
        return jsonResponse(200, { ok: true, data: payload });
      }

      if (url.endsWith('/api/v1/talks/talk-1/chat') && method === 'POST') {
        if (input?.onSendMessage) {
          const result = input.onSendMessage();
          return jsonResponse(result.status, result.body);
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            message: buildMessage({
              id: 'msg-posted',
              role: 'user',
              content: 'posted',
              createdAt: '2026-03-04T00:00:02.000Z',
            }),
            run: {
              id: 'run-posted',
              status: 'queued',
              createdAt: '2026-03-04T00:00:02.000Z',
              startedAt: null,
              targetAgentId: 'talk-agent-1',
            },
          },
        });
      }

      if (url.endsWith('/api/v1/talks/talk-1/chat/cancel') && method === 'POST') {
        if (input?.onCancelRuns) {
          const result = input.onCancelRuns();
          return jsonResponse(result.status, result.body);
        }
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', cancelledRuns: 1 },
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
