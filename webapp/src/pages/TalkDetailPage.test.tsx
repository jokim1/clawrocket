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
import type {
  AiAgentsPageData,
  Talk,
  TalkAgent,
  TalkMessage,
  TalkRun,
} from '../lib/api';

vi.mock('../lib/talkStream', () => ({
  openTalkStream: vi.fn(),
}));

type StreamCallbacks = Parameters<typeof openTalkStream>[0];
type SavedTalkAgentRequest = {
  agents: TalkAgent[];
};

describe('TalkDetailPage', () => {
  const openTalkStreamMock = vi.mocked(openTalkStream);
  let streamInput: StreamCallbacks | null = null;

  beforeEach(() => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    streamInput = null;
    openTalkStreamMock.mockImplementation((input) => {
      streamInput = input;
      return {
        close: vi.fn(),
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.cookie = 'cr_csrf_token=; Max-Age=0; path=/';
  });

  it('defaults to the Talk tab, shows the status strip, and preserves the stream across tab switches', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');

    await screen.findByRole('heading', { name: /Cal Football/i });
    expect(screen.getByLabelText('Talk timeline')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Agents' })).toBeNull();
    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(within(statusPills).getByText('Claude Sonnet 4.6 (General)')).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();
    expect(within(statusPills).getByText('Primary')).toBeTruthy();
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)').parentElement?.className,
    ).toContain('talk-status-pill-ready');
    expect(
      within(statusPills).getByText('GPT-5 Mini (Critic)').parentElement?.className,
    ).toContain('talk-status-pill-invalid');

    const tabs = within(screen.getByRole('navigation', { name: 'Talk sections' }));
    await user.click(tabs.getByRole('link', { name: 'Agents' }));
    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.getByLabelText('Talk agents')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Run History' }));
    await screen.findByRole('heading', { name: 'Run History' });
    expect(screen.getByText('run-1')).toBeTruthy();
    expect(screen.getByText('Agent: GPT-5 Mini')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByPlaceholderText('Send a message to this talk');

    expect(openTalkStreamMock).toHaveBeenCalledTimes(1);
  });

  it('updates nicknames in auto and custom modes and saves talk agents from the Agents tab', async () => {
    const user = userEvent.setup();
    let savedRequest: SavedTalkAgentRequest | undefined;

    installTalkDetailFetch({
      onPutAgents: (body) => {
        savedRequest = body;
        return body.agents.map((agent, index) => ({
          ...agent,
          displayOrder: index,
          health: index === 0 ? 'ready' : 'unknown',
        }));
      },
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    const modelSelects = screen.getAllByLabelText('Model');
    await user.selectOptions(modelSelects[0], 'claude-opus-4-6');

    const nicknameInputs = screen.getAllByLabelText('Nickname') as HTMLInputElement[];
    expect(nicknameInputs[0].value).toBe('Claude Opus 4.6');

    await user.clear(nicknameInputs[0]);
    await user.type(nicknameInputs[0], 'Coach');
    expect(nicknameInputs[0].value).toBe('Coach');

    await user.selectOptions(modelSelects[0], 'claude-sonnet-4-6');
    expect(nicknameInputs[0].value).toBe('Coach');

    await user.click(screen.getAllByRole('button', { name: 'Reset name' })[0]);
    expect(nicknameInputs[0].value).toBe('Claude Sonnet 4.6');

    const roleSelects = screen.getAllByLabelText('Role');
    await user.selectOptions(roleSelects[1], 'strategist');
    await user.click(screen.getAllByLabelText('Primary Agent')[1]);
    await user.click(screen.getByRole('button', { name: 'Save Agents' }));

    expect(await screen.findByText('Talk agents updated.')).toBeTruthy();
    if (!savedRequest) {
      throw new Error('Expected talk agents save payload');
    }

    expect(savedRequest.agents).toHaveLength(2);
    expect(savedRequest.agents[0]).toMatchObject({
      nickname: 'Claude Sonnet 4.6',
      nicknameMode: 'auto',
      modelId: 'claude-sonnet-4-6',
      isPrimary: false,
    });
    expect(savedRequest.agents[1]).toMatchObject({
      nickname: 'GPT-5 Mini',
      role: 'strategist',
      isPrimary: true,
    });
  });

  it('shows unsaved draft agents in the Talk tab and blocks send until agent changes are saved', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      messages: [],
      runs: [],
      talkAgents: [
        buildTalkAgent({
          id: 'agent-claude',
          nickname: 'Claude Sonnet 4.6',
          sourceKind: 'claude_default',
          role: 'assistant',
          isPrimary: true,
          displayOrder: 0,
          health: 'ready',
          providerId: null,
          modelId: 'claude-sonnet-4-6',
          modelDisplayName: 'Claude Sonnet 4.6',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/agents');
    await screen.findByRole('heading', { name: 'Agents' });

    const footerSourceSelect = screen.getAllByLabelText('Source')[0];
    await user.selectOptions(footerSourceSelect, 'provider.openai');
    await user.selectOptions(screen.getAllByLabelText('Role')[1], 'critic');
    await user.click(screen.getByRole('button', { name: 'Add Agent' }));

    const tabs = within(screen.getByRole('navigation', { name: 'Talk sections' }));
    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByLabelText('Talk timeline');

    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(within(statusPills).getByText('Claude Sonnet 4.6 (General)')).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    expect(
      within(targetGroup).getByRole('button', { name: /Claude Sonnet 4\.6 \(General\)/i }),
    ).toBeTruthy();
    expect(
      within(targetGroup).getByRole('button', { name: /GPT-5 Mini \(Critic\)/i }),
    ).toBeTruthy();

    expect(
      screen.getByText('Save agent changes before sending a message.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('disabled');
    expect(screen.getByPlaceholderText('Send a message to this talk')).toHaveAttribute(
      'disabled',
    );
  });

  it('uses primary-target chips by default and sends plural targetAgentIds', async () => {
    const user = userEvent.setup();
    let sendBody:
      | {
          content: string;
          targetAgentIds: string[];
        }
      | undefined;

    installTalkDetailFetch({
      onSendMessage: (body) => {
        sendBody = body;
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: body.targetAgentIds.map((agentId, index) => ({
            id: `run-${index + 10}`,
            status: 'queued',
            createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
            startedAt: null,
            completedAt: null,
            triggerMessageId: 'msg-posted',
            targetAgentId: agentId,
            targetAgentNickname:
              agentId === 'agent-claude'
                ? 'Claude Sonnet 4.6'
                : 'GPT-5 Mini',
            errorCode: null,
            errorMessage: null,
            executorAlias: null,
            executorModel: null,
          })),
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this talk');

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    const claudeChip = within(targetGroup).getByRole('button', {
      name: /Claude Sonnet 4\.6 \(General\).*Primary/i,
    });
    const openAiChip = within(targetGroup).getByRole('button', {
      name: /GPT-5 Mini \(Critic\)/i,
    });

    expect(claudeChip.getAttribute('aria-pressed')).toBe('true');
    expect(openAiChip.getAttribute('aria-pressed')).toBe('false');

    await user.click(claudeChip);
    expect(claudeChip.getAttribute('aria-pressed')).toBe('true');

    await user.click(openAiChip);
    expect(openAiChip.getAttribute('aria-pressed')).toBe('true');

    await user.type(
      screen.getByPlaceholderText('Send a message to this talk'),
      'Give me the latest take.',
    );
    await user.click(screen.getByRole('button', { name: 'Send' }));

    if (!sendBody) {
      throw new Error('Expected send payload');
    }
    expect(sendBody.content).toBe('Give me the latest take.');
    expect(sendBody.targetAgentIds).toEqual(['agent-claude', 'agent-openai']);

    expect(
      await screen.findByText(
        'Wait for the current round to finish or cancel it before sending another message.',
      ),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText('Send a message to this talk')).toHaveAttribute(
      'disabled',
    );
  });

  it('renders concurrent live responses as separate streaming bubbles', async () => {
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onRunStarted({
        talkId: 'talk-1',
        runId: 'run-claude',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Claude reply',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });

      stream.onRunStarted({
        talkId: 'talk-1',
        runId: 'run-openai',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        runId: 'run-openai',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        runId: 'run-openai',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
        deltaText: 'OpenAI reply',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
    });

    expect(screen.getByText('Claude reply')).toBeTruthy();
    expect(screen.getByText('OpenAI reply')).toBeTruthy();
    expect(screen.getAllByText('Claude Sonnet 4.6 (General)').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('GPT-5 Mini (Critic)').length).toBeGreaterThanOrEqual(2);
  });
});

function renderDetailPage(initialEntry: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/app/talks/:talkId/*"
          element={
            <TalkDetailPage
              onUnauthorized={vi.fn()}
              renameDraft={null}
              onRenameDraftChange={vi.fn()}
              onRenameDraftCancel={vi.fn()}
              onRenameDraftCommit={vi.fn().mockResolvedValue(undefined)}
            />
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

function buildTalk(): Talk {
  return {
    id: 'talk-1',
    ownerId: 'owner-1',
    title: 'Cal Football',
    agents: ['Claude'],
    status: 'active',
    folderId: null,
    sortOrder: 0,
    version: 1,
    createdAt: '2026-03-06T00:00:00.000Z',
    updatedAt: '2026-03-06T00:00:00.000Z',
    accessRole: 'owner',
  };
}

function buildTalkAgent(input: Partial<TalkAgent> & Pick<TalkAgent, 'id' | 'nickname'>): TalkAgent {
  return {
    id: input.id,
    nickname: input.nickname,
    nicknameMode: input.nicknameMode ?? 'auto',
    sourceKind: input.sourceKind ?? 'provider',
    role: input.role ?? 'assistant',
    isPrimary: input.isPrimary ?? false,
    displayOrder: input.displayOrder ?? 0,
    health: input.health ?? 'unknown',
    providerId: input.providerId ?? null,
    modelId: input.modelId ?? null,
    modelDisplayName: input.modelDisplayName ?? null,
  };
}

function buildMessage(
  input: Partial<TalkMessage> &
    Pick<TalkMessage, 'id' | 'role' | 'content' | 'createdAt'>,
): TalkMessage {
  return {
    id: input.id,
    role: input.role,
    content: input.content,
    createdBy: input.createdBy ?? 'owner-1',
    createdAt: input.createdAt,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    agentNickname: input.agentNickname ?? null,
  };
}

function buildRun(
  input: Partial<TalkRun> & Pick<TalkRun, 'id' | 'status' | 'createdAt'>,
): TalkRun {
  return {
    id: input.id,
    status: input.status,
    createdAt: input.createdAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    targetAgentNickname: input.targetAgentNickname ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    executorAlias: input.executorAlias ?? null,
    executorModel: input.executorModel ?? null,
  };
}

function buildAiAgentsData(): AiAgentsPageData {
  return {
    defaultClaudeModelId: 'claude-sonnet-4-6',
    claudeModelSuggestions: [
      {
        modelId: 'claude-sonnet-4-6',
        displayName: 'Claude Sonnet 4.6',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-opus-4-6',
        displayName: 'Claude Opus 4.6',
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
        hasCredential: true,
        credentialHint: '••••MINI',
        verificationStatus: 'verified',
        lastVerifiedAt: '2026-03-06T00:00:00.000Z',
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
  talk?: Talk;
  messages?: TalkMessage[];
  runs?: TalkRun[];
  talkAgents?: TalkAgent[];
  aiAgents?: AiAgentsPageData;
  onPutAgents?: (body: SavedTalkAgentRequest) => TalkAgent[];
  onSendMessage?: (body: {
    content: string;
    targetAgentIds: string[];
  }) => { talkId: string; message: TalkMessage; runs: TalkRun[] };
}) {
  const talk = input?.talk ?? buildTalk();
  const messages =
    input?.messages ??
    [
      buildMessage({
        id: 'msg-1',
        role: 'user',
        content: 'How will Cal do next season?',
        createdAt: '2026-03-06T00:00:00.000Z',
      }),
    ];
  const runs =
    input?.runs ??
    [
      buildRun({
        id: 'run-1',
        status: 'completed',
        createdAt: '2026-03-06T00:00:01.000Z',
        completedAt: '2026-03-06T00:00:03.000Z',
        triggerMessageId: 'msg-1',
        targetAgentId: 'agent-openai',
        targetAgentNickname: 'GPT-5 Mini',
      }),
    ];
  const talkAgents =
    input?.talkAgents ??
    [
      buildTalkAgent({
        id: 'agent-claude',
        nickname: 'Claude Sonnet 4.6',
        sourceKind: 'claude_default',
        role: 'assistant',
        isPrimary: true,
        displayOrder: 0,
        health: 'ready',
        providerId: null,
        modelId: 'claude-sonnet-4-6',
        modelDisplayName: 'Claude Sonnet 4.6',
      }),
      buildTalkAgent({
        id: 'agent-openai',
        nickname: 'GPT-5 Mini',
        sourceKind: 'provider',
        role: 'critic',
        isPrimary: false,
        displayOrder: 1,
        health: 'invalid',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
        modelDisplayName: 'GPT-5 Mini',
      }),
    ];
  const aiAgents = input?.aiAgents ?? buildAiAgentsData();

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
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            messages,
            page: { limit: 100, count: messages.length, beforeCreatedAt: null },
          },
        });
      }

      if (url.endsWith('/api/v1/talks/talk-1/runs') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            runs,
          },
        });
      }

      if (url.endsWith('/api/v1/talks/talk-1/agents') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: talkAgents },
        });
      }

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: aiAgents });
      }

      if (url.endsWith('/api/v1/talks/talk-1/agents') && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as SavedTalkAgentRequest;
        const saved =
          input?.onPutAgents?.(body) ??
          body.agents.map((agent, index) => ({
            ...agent,
            displayOrder: index,
            health:
              agent.sourceKind === 'claude_default'
                ? 'ready'
                : agent.providerId === 'provider.openai'
                  ? 'invalid'
                  : 'unknown',
          }));
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: saved },
        });
      }

      if (url.endsWith('/api/v1/talks/talk-1/chat') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          content: string;
          targetAgentIds: string[];
        };
        const payload =
          input?.onSendMessage?.(body) ??
          ({
            talkId: 'talk-1',
            message: buildMessage({
              id: 'msg-posted',
              role: 'user',
              content: body.content,
              createdAt: '2026-03-06T00:00:05.000Z',
            }),
            runs: body.targetAgentIds.map((agentId, index) =>
              buildRun({
                id: `run-${index + 10}`,
                status: 'queued',
                createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
                triggerMessageId: 'msg-posted',
                targetAgentId: agentId,
                targetAgentNickname:
                  agentId === 'agent-claude'
                    ? 'Claude Sonnet 4.6'
                    : 'GPT-5 Mini',
              }),
            ),
          });
        return jsonResponse(200, { ok: true, data: payload });
      }

      if (url.endsWith('/api/v1/talks/talk-1/chat/cancel') && method === 'POST') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', cancelledRuns: 2 },
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
