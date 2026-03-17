import {
  act,
  cleanup,
  fireEvent,
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
  ChannelConnection,
  ChannelQueueFailure,
  ChannelTarget,
  ContextSource,
  TalkContext,
  DataConnector,
  Talk,
  TalkAgent,
  TalkChannelBinding,
  TalkDataConnector,
  TalkMessage,
  TalkMessageAttachment,
  TalkRun,
  TalkThread,
  TalkTools,
  RegisteredAgent,
} from '../lib/api';

vi.mock('../lib/talkStream', () => ({
  openTalkStream: vi.fn(),
}));

type StreamCallbacks = Parameters<typeof openTalkStream>[0];
type SavedTalkAgentRequest = {
  agents: TalkAgent[];
};

const DEFAULT_THREAD_ID = 'thread-default';

describe('TalkDetailPage', () => {
  const openTalkStreamMock = vi.mocked(openTalkStream);
  let streamInput: StreamCallbacks | null = null;

  beforeEach(() => {
    document.cookie = 'cr_csrf_token=test-csrf-token';
    streamInput = null;
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true),
    );
    openTalkStreamMock.mockImplementation((input) => {
      streamInput = input;
      return {
        close: vi.fn(),
      };
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)'),
    ).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();
    expect(within(statusPills).getByText('Primary')).toBeTruthy();
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)').parentElement
        ?.className,
    ).toContain('talk-status-pill-ready');
    expect(
      within(statusPills).getByText('GPT-5 Mini (Critic)').parentElement
        ?.className,
    ).toContain('talk-status-pill-invalid');
    expect(screen.getByLabelText('Response mode')).toHaveValue('ordered');

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Agents' }));
    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.getByLabelText('Talk agents')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Data Connectors' }));
    await screen.findByRole('heading', { name: 'Data Connectors' });
    expect(screen.getByText('FTUE PostHog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Detach' })).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Run History' }));
    await screen.findByRole('heading', { name: 'Run History' });
    expect(screen.getByText('run-1')).toBeTruthy();
    expect(screen.getByText('Agent: GPT-5 Mini')).toBeTruthy();

    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByPlaceholderText('Send a message to this thread');

    expect(openTalkStreamMock).toHaveBeenCalledTimes(1);
  });

  it('hides the response-mode selector until the talk has at least two assigned agents', async () => {
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

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(screen.queryByLabelText('Response mode')).toBeNull();
  });

  it('lets owners manage the read-only project mount from the Agents tab', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1/agents');

    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.getByRole('heading', { name: 'Project Mount' })).toBeTruthy();

    const input = screen.getByPlaceholderText('/absolute/path/to/project');
    await user.clear(input);
    await user.type(input, '/tmp/project-alpha');
    await user.click(screen.getByRole('button', { name: 'Save Path' }));

    expect(await screen.findByText('Project mount updated.')).toBeTruthy();
    expect(screen.getByText(/Current mount: \/tmp\/project-alpha/i)).toBeTruthy();
  });

  it('hides the project mount editor for non-owner talk editors', async () => {
    installTalkDetailFetch({
      talk: buildTalkWith({ accessRole: 'editor', ownerId: 'owner-2' }),
    });

    renderDetailPage('/app/talks/talk-1/agents');

    await screen.findByRole('heading', { name: 'Agents' });
    expect(screen.queryByRole('heading', { name: 'Project Mount' })).toBeNull();
  });

  it('loads the Tools tab and renders capability summaries and effective access', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1/tools');

    await screen.findByRole('heading', { name: 'Tools' });
    expect(screen.getByText('This Talk can search the web')).toBeTruthy();
    expect(
      screen.getByText(
        'Google Drive unavailable — bind a file or folder to enable',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Claude Sonnet 4.6')).toBeTruthy();
    expect(screen.getByText(/Web Search: Available/i)).toBeTruthy();

    await user.click(screen.getByLabelText('Gmail Send'));
    await user.click(screen.getByRole('button', { name: 'Save Tool Grants' }));
    expect(await screen.findByText('Talk tool grants updated.')).toBeTruthy();
  });

  it('treats awaiting confirmation runs as active rounds on the Talk tab', async () => {
    installTalkDetailFetch({
      runs: [
        buildRun({
          id: 'run-awaiting',
          status: 'awaiting_confirmation',
          createdAt: '2026-03-06T00:00:01.000Z',
          startedAt: '2026-03-06T00:00:02.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(
      screen.getByText(
        'Wait for the current round to finish or cancel it before sending another message.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'disabled',
    );
    expect(
      screen.getByRole('button', { name: 'Cancel Runs' }),
    ).not.toHaveAttribute('disabled');
  });

  it('switches between ordered and parallel response help text', async () => {
    const user = userEvent.setup();
    installTalkDetailFetch({
      messages: [],
      runs: [],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this thread');

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    await user.click(
      within(targetGroup).getByRole('button', {
        name: /GPT-5 Mini \(Critic\)/i,
      }),
    );

    expect(
      screen.getByText(
        'Selected agents will respond in order, with the final response synthesizing earlier perspectives.',
      ),
    ).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('Response mode'), 'panel');
    await waitFor(() =>
      expect(
        screen.getByText('Selected agents will each respond independently.'),
      ).toBeTruthy(),
    );
  });

  it('shows live ordered progress for grouped active runs', async () => {
    installTalkDetailFetch({
      runs: [
        buildRun({
          id: 'run-ordered-1',
          status: 'running',
          createdAt: '2026-03-06T00:00:01.000Z',
          startedAt: '2026-03-06T00:00:02.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 0,
        }),
        buildRun({
          id: 'run-ordered-2',
          status: 'queued',
          createdAt: '2026-03-06T00:00:01.100Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-openai',
          targetAgentNickname: 'GPT-5 Mini',
          responseGroupId: 'group-ordered-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByPlaceholderText('Send a message to this thread');
    expect(
      screen.getByText('Agent 1 of 2 · Claude Sonnet 4.6 responding…'),
    ).toBeTruthy();
  });

  it('loads talk channels, saves binding edits, and manages failure queues from the Channels tab', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      talkChannels: [
        buildTalkChannelBinding({
          id: 'binding-1',
          displayName: 'Cal Football Chat',
          responderMode: 'agent',
          responderAgentId: 'agent-openai',
          deferredIngressCount: 2,
          lastIngressReasonCode: 'expired_while_busy',
          lastDeliveryReasonCode: 'delivery_retries_exhausted',
        }),
      ],
      ingressFailures: [
        buildChannelQueueFailure({
          id: 'ingress-1',
          bindingId: 'binding-1',
          reasonCode: 'expired_while_busy',
          senderName: 'Coach',
        }),
      ],
      deliveryFailures: [
        buildChannelQueueFailure({
          id: 'delivery-1',
          bindingId: 'binding-1',
          reasonCode: 'delivery_retries_exhausted',
          reasonDetail: 'Telegram delivery exhausted retries.',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1/channels');
    await screen.findByRole('heading', { name: 'Channels' });

    expect(screen.getByText('Cal Football Chat')).toBeTruthy();
    expect(
      screen.getByText(
        'Dropped after waiting too long for the talk to become idle',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Delivery retries exhausted')).toBeTruthy();

    const bindingCard = screen
      .getByRole('heading', { name: 'Cal Football Chat' })
      .closest('article');
    if (!bindingCard) {
      throw new Error('Expected binding card');
    }
    const bindingView = within(bindingCard);

    await user.clear(bindingView.getByLabelText('Display Name'));
    await user.type(
      bindingView.getByLabelText('Display Name'),
      'Cal Strategy Room',
    );
    await user.selectOptions(bindingView.getByLabelText('Delivery'), 'channel');
    await user.click(bindingView.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('Saved channel settings for Cal Football Chat.'),
    ).toBeTruthy();
    expect(bindingView.getByDisplayValue('Cal Strategy Room')).toBeTruthy();

    await user.click(bindingView.getByRole('button', { name: 'Test Send' }));
    expect(
      await screen.findByText('Sent a test message to Cal Strategy Room.'),
    ).toBeTruthy();

    await user.click(bindingView.getAllByRole('button', { name: 'Retry' })[0]);
    expect(await screen.findByText('Ingress failure retried.')).toBeTruthy();
    expect(screen.queryByText('Coach')).toBeNull();

    await user.click(
      bindingView.getAllByRole('button', { name: 'Dismiss' })[0],
    );
    expect(await screen.findByText('Delivery failure dismissed.')).toBeTruthy();
    expect(
      screen.queryByText('Telegram delivery exhausted retries.'),
    ).toBeNull();
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

    const getRegisteredAgentSelects = () =>
      screen.getAllByLabelText('Registered Agent');

    await user.selectOptions(getRegisteredAgentSelects()[0], 'agent-claude-opus');

    const getNicknameInputs = () =>
      screen.getAllByLabelText('Nickname') as HTMLInputElement[];

    expect(getNicknameInputs()[0].value).toBe('Claude Opus 4.6');

    await user.clear(getNicknameInputs()[0]);
    await user.type(getNicknameInputs()[0], 'Coach');
    expect(getNicknameInputs()[0].value).toBe('Coach');

    await user.selectOptions(getRegisteredAgentSelects()[0], 'agent-claude');
    expect(getNicknameInputs()[0].value).toBe('Coach');

    await user.click(screen.getAllByRole('button', { name: 'Reset name' })[0]);
    expect(getNicknameInputs()[0].value).toBe('Claude Sonnet 4.6');

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

  it('shows source failures and refreshes URL source status after retry', async () => {
    const user = userEvent.setup();
    let currentContext = buildTalkContext({
      sources: [
        buildContextSource({
          id: 'source-failed',
          title: 'Gamemakers Substack',
          sourceUrl: 'https://example.substack.com/p/post',
          status: 'failed',
          extractionError:
            'fetch_http_error: HTTP 403 from https://example.substack.com/p/post',
        }),
      ],
    });
    let pollCount = 0;

    installTalkDetailFetch({
      context: currentContext,
      onGetContext: () => {
        if (
          currentContext.sources[0]?.status === 'pending' &&
          pollCount++ >= 0
        ) {
          currentContext = buildTalkContext({
            sources: [
              buildContextSource({
                id: 'source-failed',
                title: 'Gamemakers Substack',
                sourceUrl: 'https://example.substack.com/p/post',
                status: 'ready',
                extractionError: null,
                fetchStrategy: 'browser',
                lastFetchedAt: '2026-03-06T00:05:00.000Z',
                extractedTextLength: 1200,
              }),
            ],
          });
        }
        return currentContext;
      },
      onRetryContextSource: (sourceId) => {
        pollCount = 0;
        const updated = buildContextSource({
          id: sourceId,
          title: 'Gamemakers Substack',
          sourceUrl: 'https://example.substack.com/p/post',
          status: 'pending',
          extractionError: null,
        });
        currentContext = buildTalkContext({ sources: [updated] });
        return updated;
      },
    });

    renderDetailPage('/app/talks/talk-1/context');

    expect(await screen.findByText('Gamemakers Substack')).toBeTruthy();
    expect(
      screen.getByText(
        'fetch_http_error: HTTP 403 from https://example.substack.com/p/post',
      ),
    ).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('pending')).toBeTruthy();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 2200));
    });

    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    expect(screen.getByText('via browser')).toBeTruthy();
  }, 10000);

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

    const footerAgentSelect = screen.getByLabelText('Agent');
    await user.selectOptions(footerAgentSelect, 'agent-openai');
    await user.selectOptions(screen.getAllByLabelText('Role')[1], 'critic');
    await user.click(screen.getByRole('button', { name: 'Add Agent' }));

    const tabs = within(
      screen.getByRole('navigation', { name: 'Talk sections' }),
    );
    await user.click(tabs.getByRole('link', { name: 'Talk' }));
    await screen.findByLabelText('Talk timeline');

    const statusPills = screen.getByRole('list', { name: 'Talk agent status' });
    expect(
      within(statusPills).getByText('Claude Sonnet 4.6 (General)'),
    ).toBeTruthy();
    expect(within(statusPills).getByText('GPT-5 Mini (Critic)')).toBeTruthy();

    const targetGroup = screen.getByRole('group', { name: 'Selected agents' });
    expect(
      within(targetGroup).getByRole('button', {
        name: /Claude Sonnet 4\.6 \(General\)/i,
      }),
    ).toBeTruthy();
    expect(
      within(targetGroup).getByRole('button', {
        name: /GPT-5 Mini \(Critic\)/i,
      }),
    ).toBeTruthy();

    expect(
      screen.getByText('Save agent changes before sending a message.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'disabled',
    );
    expect(
      screen.getByPlaceholderText('Send a message to this thread'),
    ).toHaveAttribute('disabled');
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
          runs: body.targetAgentIds.map((agentId, index) =>
            buildRun({
              id: `run-${index + 10}`,
              threadId: body.threadId ?? DEFAULT_THREAD_ID,
              status: 'queued',
              createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
              triggerMessageId: 'msg-posted',
              targetAgentId: agentId,
              targetAgentNickname:
                agentId === 'agent-claude' ? 'Claude Sonnet 4.6' : 'GPT-5 Mini',
            }),
          ),
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByPlaceholderText('Send a message to this thread');

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
      screen.getByPlaceholderText('Send a message to this thread'),
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
    expect(
      screen.getByPlaceholderText('Send a message to this thread'),
    ).toHaveAttribute('disabled');
  });

  it('submits on Enter and keeps Shift+Enter for a newline in the composer', async () => {
    const user = userEvent.setup();
    const sentBodies: Array<{
      content: string;
      targetAgentIds: string[];
    }> = [];

    installTalkDetailFetch({
      messages: [],
      runs: [],
      onSendMessage: (body) => {
        sentBodies.push(body);
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: `msg-posted-${sentBodies.length}`,
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: [],
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, 'Line 1');
    await user.keyboard('{Shift>}{Enter}{/Shift}Line 2');

    expect(composer).toHaveValue('Line 1\nLine 2');
    expect(sentBodies).toHaveLength(0);

    await user.keyboard('{Enter}');

    await waitFor(() => expect(sentBodies).toHaveLength(1));
    expect(sentBodies[0]).toMatchObject({
      content: 'Line 1\nLine 2',
      targetAgentIds: ['agent-claude'],
    });
    await waitFor(() => expect(composer).toHaveValue(''));
  });

  it('attaches dropped files from the talk workspace and sends their attachment ids', async () => {
    const user = userEvent.setup();
    let uploadedFileName: string | null = null;
    let sentBody:
      | {
          content: string;
          targetAgentIds: string[];
          attachmentIds?: string[];
        }
      | undefined;

    installTalkDetailFetch({
      messages: [],
      runs: [],
      onUploadAttachment: (formData) => {
        const file = formData.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file in attachment upload payload');
        }
        uploadedFileName = file.name;
        return buildMessageAttachment({
          id: 'att-1',
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          extractionStatus: 'extracted',
        });
      },
      onSendMessage: (body) => {
        sentBody = body;
        return {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: [],
        };
      },
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );
    const workspace = composer.closest('.talk-workspace');
    if (!workspace) {
      throw new Error('Expected talk workspace wrapper');
    }

    const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
    const dataTransfer = createFileDataTransfer([file]);

    const windowDragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(windowDragOverEvent, 'dataTransfer', {
      value: dataTransfer,
    });
    window.dispatchEvent(windowDragOverEvent);
    expect(windowDragOverEvent.defaultPrevented).toBe(true);

    fireEvent.dragEnter(workspace, { dataTransfer });
    expect(await screen.findByText('Drop files to attach')).toBeTruthy();

    fireEvent.drop(workspace, { dataTransfer });

    expect(await screen.findByText('notes.txt')).toBeTruthy();
    expect(uploadedFileName).toBe('notes.txt');

    await user.type(composer, 'Please review the attachment.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(sentBody).toMatchObject({
        content: 'Please review the attachment.',
        targetAgentIds: ['agent-claude'],
        attachmentIds: ['att-1'],
      }),
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
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Claude reply',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });

      stream.onRunStarted({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-openai',
        triggerMessageId: 'msg-1',
        status: 'running',
      });
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-openai',
        agentId: 'agent-openai',
        agentNickname: 'GPT-5 Mini',
        providerId: 'provider.openai',
        modelId: 'gpt-5-mini',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
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
    expect(
      screen.getAllByText('Claude Sonnet 4.6 (General)').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText('GPT-5 Mini (Critic)').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('marks synthesis messages in the timeline', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Help me decide.',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-synthesis',
          role: 'assistant',
          content: 'Here is the synthesized recommendation.',
          createdAt: '2026-03-06T00:00:03.000Z',
          runId: 'run-synthesis',
          agentId: 'agent-claude',
          agentNickname: 'Claude Sonnet 4.6',
          metadata: { isSynthesis: true },
        }),
      ],
      runs: [
        buildRun({
          id: 'run-synthesis',
          status: 'completed',
          createdAt: '2026-03-06T00:00:01.000Z',
          completedAt: '2026-03-06T00:00:03.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          responseGroupId: 'group-synthesis-1',
          sequenceIndex: 1,
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');

    await screen.findByText('Here is the synthesized recommendation.');
    expect(screen.getByText('Synthesis')).toBeTruthy();
  });

  it('strips internal tags from live streamed assistant responses', async () => {
    installTalkDetailFetch();

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: '<internal>Thinking',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: ' through it</internal>Visible',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-claude',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: ' answer',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
    });

    expect(screen.queryByText(/<internal>/)).toBeNull();
    expect(screen.getByText('Visible answer')).toBeTruthy();
  });

  it('strips internal tags from persisted assistant messages', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'What do you think?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: '<internal>Think first</internal>The visible answer',
          createdAt: '2026-03-06T00:00:10.000Z',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    expect(screen.queryByText(/<internal>/)).toBeNull();
    expect(screen.getByText('The visible answer')).toBeTruthy();
  });

  it('keeps failed live responses in chronological order in the timeline', async () => {
    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Can we pull retention data?',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'Later persisted answer',
          createdAt: '2026-03-06T00:00:10.000Z',
        }),
      ],
      runs: [
        buildRun({
          id: 'run-failed',
          status: 'failed',
          createdAt: '2026-03-06T00:00:05.000Z',
          startedAt: '2026-03-06T00:00:05.000Z',
          completedAt: '2026-03-06T00:00:08.000Z',
          triggerMessageId: 'msg-1',
          targetAgentId: 'agent-claude',
          targetAgentNickname: 'Claude Sonnet 4.6',
          errorCode: 'tool_capability',
          errorMessage:
            'Attached data connectors require a tool-capable model.',
        }),
      ],
    });

    renderDetailPage('/app/talks/talk-1');
    await screen.findByRole('heading', { name: /Cal Football/i });

    if (!streamInput) {
      throw new Error('Expected talk stream input');
    }
    const stream = streamInput;

    await act(async () => {
      stream.onResponseStarted?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onResponseDelta?.({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        agentId: 'agent-claude',
        agentNickname: 'Claude Sonnet 4.6',
        deltaText: 'Failed attempt preview',
        providerId: 'provider.anthropic',
        modelId: 'claude-sonnet-4-6',
      });
      stream.onRunFailed({
        talkId: 'talk-1',
        threadId: DEFAULT_THREAD_ID,
        runId: 'run-failed',
        triggerMessageId: 'msg-1',
        errorCode: 'tool_capability',
        errorMessage: 'Attached data connectors require a tool-capable model.',
      });
    });

    const userArticle = screen
      .getByText('Can we pull retention data?')
      .closest('article');
    const failedArticle = screen
      .getByText('Failed attempt preview')
      .closest('article');
    const persistedArticle = screen
      .getByText('Later persisted answer')
      .closest('article');

    expect(userArticle).toBeTruthy();
    expect(failedArticle).toBeTruthy();
    expect(persistedArticle).toBeTruthy();
    expect(userArticle?.compareDocumentPosition(failedArticle as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      failedArticle?.compareDocumentPosition(persistedArticle as Node),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('detaches and re-attaches connectors from the Data Connectors tab', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch();
    renderDetailPage('/app/talks/talk-1/data-connectors');

    await screen.findByRole('heading', { name: 'Data Connectors' });
    expect(screen.getByText('FTUE PostHog')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Detach' }));
    expect(
      await screen.findByText('FTUE PostHog detached from this talk.'),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'FTUE PostHog' })).toBeNull();

    await user.selectOptions(
      screen.getByLabelText('Connector'),
      'connector-sheet',
    );
    await user.click(screen.getByRole('button', { name: 'Attach Connector' }));
    expect(
      await screen.findByText('Economy Sheet attached to this talk.'),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Economy Sheet' })).toBeTruthy();
  });

  it('opens edit history from /edit and deletes selected messages', async () => {
    const user = userEvent.setup();

    installTalkDetailFetch({
      messages: [
        buildMessage({
          id: 'msg-1',
          role: 'user',
          content: 'Old user prompt',
          createdAt: '2026-03-06T00:00:00.000Z',
        }),
        buildMessage({
          id: 'msg-2',
          role: 'assistant',
          content: 'Old assistant answer',
          createdAt: '2026-03-06T00:00:01.000Z',
        }),
        buildMessage({
          id: 'msg-3',
          role: 'user',
          content: 'Keep this latest note',
          createdAt: '2026-03-06T00:00:02.000Z',
        }),
      ],
      runs: [],
    });

    renderDetailPage('/app/talks/talk-1');
    const composer = await screen.findByPlaceholderText(
      'Send a message to this thread',
    );

    await user.type(composer, '/edit');
    await user.keyboard('{Enter}');

    expect(
      await screen.findByRole('dialog', { name: 'Edit history' }),
    ).toBeTruthy();
    const removeOldUser = screen.getByLabelText(/You.*Old user prompt/i);
    const removeOldAssistant = screen.getByLabelText(
      /Assistant.*Old assistant answer/i,
    );
    await user.click(removeOldUser);
    await user.click(removeOldAssistant);
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit history' })).toBeNull(),
    );
    expect(
      await screen.findByText('Deleted 2 messages from this Talk history.'),
    ).toBeTruthy();
    expect(screen.queryByText('Old user prompt')).toBeNull();
    expect(screen.queryByText('Old assistant answer')).toBeNull();
    expect(screen.getByText('Keep this latest note')).toBeTruthy();
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
    projectPath: null,
    orchestrationMode: 'ordered',
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

function buildTalkWith(overrides: Partial<Talk>): Talk {
  return {
    ...buildTalk(),
    ...overrides,
  };
}

function buildTalkTools(): TalkTools {
  return {
    talkId: 'talk-1',
    registry: [
      {
        id: 'web_search',
        family: 'web',
        displayName: 'Web Search',
        description: 'Search the public web.',
        enabled: true,
        installStatus: 'installed',
        healthStatus: 'healthy',
        authRequirements: null,
        mutatesExternalState: false,
        requiresBinding: false,
        defaultGrant: true,
        sortOrder: 10,
        updatedAt: '2026-03-06T00:00:00.000Z',
        updatedBy: null,
      },
      {
        id: 'gmail_send',
        family: 'gmail',
        displayName: 'Gmail Send',
        description: 'Draft and send email.',
        enabled: true,
        installStatus: 'installed',
        healthStatus: 'healthy',
        authRequirements: null,
        mutatesExternalState: true,
        requiresBinding: false,
        defaultGrant: false,
        sortOrder: 20,
        updatedAt: '2026-03-06T00:00:00.000Z',
        updatedBy: null,
      },
    ],
    grants: [
      {
        toolId: 'web_search',
        enabled: true,
        updatedAt: '2026-03-06T00:00:00.000Z',
        updatedBy: 'owner-1',
      },
      {
        toolId: 'gmail_send',
        enabled: false,
        updatedAt: '2026-03-06T00:00:00.000Z',
        updatedBy: 'owner-1',
      },
    ],
    bindings: [],
    googleAccount: {
      connected: false,
      email: null,
      displayName: null,
      scopes: [],
      accessExpiresAt: null,
    },
    summary: [
      'This Talk can search the web',
      'Google Drive unavailable — bind a file or folder to enable',
    ],
    warnings: [],
    effectiveAccess: [
      {
        agentId: 'agent-claude',
        nickname: 'Claude Sonnet 4.6',
        sourceKind: 'claude_default',
        providerId: null,
        modelId: 'claude-sonnet-4-6',
        toolAccess: [
          { toolId: 'web_search', state: 'available' },
          { toolId: 'gmail_send', state: 'unavailable_due_to_config' },
        ],
      },
    ],
  };
}

function buildTalkAgent(
  input: Partial<TalkAgent> & Pick<TalkAgent, 'id' | 'nickname'>,
): TalkAgent {
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

function buildRegisteredAgent(
  input: Partial<RegisteredAgent> &
    Pick<RegisteredAgent, 'id' | 'name' | 'providerId' | 'modelId'>,
): RegisteredAgent {
  return {
    id: input.id,
    name: input.name,
    providerId: input.providerId,
    modelId: input.modelId,
    toolPermissions: input.toolPermissions ?? { web: true, connectors: true },
    personaRole: input.personaRole ?? 'assistant',
    systemPrompt: input.systemPrompt ?? null,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildThread(
  input: Partial<TalkThread> & Pick<TalkThread, 'id'>,
): TalkThread {
  return {
    id: input.id,
    talkId: input.talkId ?? 'talk-1',
    title: input.title ?? null,
    isDefault: input.isDefault ?? false,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    messageCount: input.messageCount ?? 0,
    lastMessageAt: input.lastMessageAt ?? null,
  };
}

function buildMessage(
  input: Partial<TalkMessage> &
    Pick<TalkMessage, 'id' | 'role' | 'content' | 'createdAt'>,
): TalkMessage {
  return {
    id: input.id,
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
    role: input.role,
    content: input.content,
    createdBy: input.createdBy ?? 'owner-1',
    createdAt: input.createdAt,
    runId: input.runId ?? null,
    agentId: input.agentId ?? null,
    agentNickname: input.agentNickname ?? null,
    metadata: input.metadata ?? null,
    attachments: input.attachments ?? [],
  };
}

function buildMessageAttachment(
  input: Partial<TalkMessageAttachment> &
    Pick<
      TalkMessageAttachment,
      'id' | 'fileName' | 'fileSize' | 'mimeType' | 'extractionStatus'
    >,
): TalkMessageAttachment {
  return {
    id: input.id,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    extractionStatus: input.extractionStatus,
  };
}

function buildRun(
  input: Partial<TalkRun> & Pick<TalkRun, 'id' | 'status' | 'createdAt'>,
): TalkRun {
  return {
    id: input.id,
    threadId: input.threadId ?? DEFAULT_THREAD_ID,
    responseGroupId: input.responseGroupId ?? null,
    sequenceIndex: input.sequenceIndex ?? null,
    status: input.status,
    createdAt: input.createdAt,
    startedAt: input.startedAt ?? null,
    completedAt: input.completedAt ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    targetAgentId: input.targetAgentId ?? null,
    targetAgentNickname: input.targetAgentNickname ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    cancelReason: input.cancelReason ?? null,
    executorAlias: input.executorAlias ?? null,
    executorModel: input.executorModel ?? null,
  };
}

function createFileDataTransfer(files: File[]): DataTransfer {
  return {
    files,
    items: files.map((file) => ({
      kind: 'file',
      type: file.type,
      getAsFile: () => file,
    })),
    types: {
      0: 'Files',
      length: 1,
      contains: (value: string) => value === 'Files',
      item: (index: number) => (index === 0 ? 'Files' : null),
    },
    dropEffect: 'copy',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
}

function buildDataConnector(input: Partial<DataConnector> = {}): DataConnector {
  return {
    id: input.id ?? 'connector-1',
    name: input.name ?? 'FTUE PostHog',
    connectorKind: input.connectorKind ?? 'posthog',
    config: input.config ?? {
      hostUrl: 'https://us.posthog.com',
      projectId: '12345',
    },
    discovered: input.discovered ?? null,
    enabled: input.enabled ?? true,
    hasCredential: input.hasCredential ?? false,
    verificationStatus: input.verificationStatus ?? 'missing',
    lastVerifiedAt: input.lastVerifiedAt ?? null,
    lastVerificationError: input.lastVerificationError ?? null,
    attachedTalkCount: input.attachedTalkCount ?? 0,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function toThreadApiRecord(thread: TalkThread) {
  return {
    id: thread.id,
    talk_id: thread.talkId,
    title: thread.title,
    is_default: thread.isDefault ? 1 : 0,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    message_count: thread.messageCount,
    last_message_at: thread.lastMessageAt,
  };
}

function buildTalkDataConnector(
  input: Partial<TalkDataConnector> = {},
): TalkDataConnector {
  const base = buildDataConnector(input);
  return {
    ...base,
    attachedAt: input.attachedAt ?? '2026-03-06T00:00:10.000Z',
    attachedBy: input.attachedBy ?? 'owner-1',
  };
}

function buildChannelConnection(
  input: Partial<ChannelConnection> = {},
): ChannelConnection {
  return {
    id: input.id ?? 'channel-conn:telegram:system',
    platform: input.platform ?? 'telegram',
    connectionMode: input.connectionMode ?? 'system_managed',
    accountKey: input.accountKey ?? 'telegram:system',
    displayName: input.displayName ?? 'Telegram (System Managed)',
    enabled: input.enabled ?? true,
    healthStatus: input.healthStatus ?? 'healthy',
    lastHealthCheckAt: input.lastHealthCheckAt ?? null,
    lastHealthError: input.lastHealthError ?? null,
    config: input.config ?? { managedBy: 'runtime' },
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildChannelTarget(input: Partial<ChannelTarget> = {}): ChannelTarget {
  return {
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    displayName: input.displayName ?? 'Cal Football Chat',
    metadata: input.metadata ?? null,
    lastSeenAt: input.lastSeenAt ?? '2026-03-06T00:00:00.000Z',
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildTalkChannelBinding(
  input: Partial<TalkChannelBinding> = {},
): TalkChannelBinding {
  return {
    id: input.id ?? 'binding-1',
    talkId: input.talkId ?? 'talk-1',
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    platform: input.platform ?? 'telegram',
    connectionDisplayName:
      input.connectionDisplayName ?? 'Telegram (System Managed)',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    displayName: input.displayName ?? 'Cal Football Chat',
    active: input.active ?? true,
    responseMode: input.responseMode ?? 'mentions',
    responderMode: input.responderMode ?? 'primary',
    responderAgentId: input.responderAgentId ?? null,
    deliveryMode: input.deliveryMode ?? 'reply',
    channelContextNote: input.channelContextNote ?? null,
    inboundRateLimitPerMinute: input.inboundRateLimitPerMinute ?? 10,
    maxPendingEvents: input.maxPendingEvents ?? 20,
    overflowPolicy: input.overflowPolicy ?? 'drop_oldest',
    maxDeferredAgeMinutes: input.maxDeferredAgeMinutes ?? 10,
    pendingIngressCount: input.pendingIngressCount ?? 1,
    deferredIngressCount: input.deferredIngressCount ?? 0,
    lastIngressReasonCode: input.lastIngressReasonCode ?? null,
    lastDeliveryReasonCode: input.lastDeliveryReasonCode ?? null,
  };
}

function buildChannelQueueFailure(
  input: Partial<ChannelQueueFailure> = {},
): ChannelQueueFailure {
  return {
    id: input.id ?? 'failure-1',
    bindingId: input.bindingId ?? 'binding-1',
    talkId: input.talkId ?? 'talk-1',
    connectionId: input.connectionId ?? 'channel-conn:telegram:system',
    targetKind: input.targetKind ?? 'chat',
    targetId: input.targetId ?? 'tg:group:123',
    platformEventId: input.platformEventId ?? 'event-1',
    externalMessageId: input.externalMessageId ?? null,
    senderId: input.senderId ?? 'sender-1',
    senderName: input.senderName ?? 'Joe',
    runId: input.runId ?? null,
    talkMessageId: input.talkMessageId ?? null,
    payload: input.payload ?? { text: 'hello' },
    status: input.status ?? 'dead_letter',
    reasonCode: input.reasonCode ?? 'expired_while_busy',
    reasonDetail: input.reasonDetail ?? 'Talk stayed busy too long.',
    dedupeKey: input.dedupeKey ?? 'dedupe-1',
    availableAt: input.availableAt ?? '2026-03-06T00:00:00.000Z',
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
    attemptCount: input.attemptCount ?? 1,
  };
}

function buildContextSource(input: Partial<ContextSource> = {}): ContextSource {
  return {
    id: input.id ?? 'source-1',
    sourceRef: input.sourceRef ?? 'S1',
    sourceType: input.sourceType ?? 'url',
    title: input.title ?? 'Saved URL',
    note: input.note ?? null,
    sourceUrl: input.sourceUrl ?? 'https://example.com/post',
    status: input.status ?? 'failed',
    extractedTextLength: input.extractedTextLength ?? null,
    isTruncated: input.isTruncated ?? false,
    extractionError: input.extractionError ?? 'fetch_http_error: HTTP 403',
    mimeType: input.mimeType ?? null,
    lastFetchedAt: input.lastFetchedAt ?? null,
    fetchStrategy: input.fetchStrategy ?? null,
    sortOrder: input.sortOrder ?? 0,
    createdAt: input.createdAt ?? '2026-03-06T00:00:00.000Z',
    updatedAt: input.updatedAt ?? '2026-03-06T00:00:00.000Z',
  };
}

function buildTalkContext(input?: Partial<TalkContext>): TalkContext {
  return {
    goal: input?.goal ?? null,
    rules: input?.rules ?? [],
    sources: input?.sources ?? [],
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
  threads?: TalkThread[];
  messages?: TalkMessage[];
  runs?: TalkRun[];
  talkAgents?: TalkAgent[];
  registeredAgents?: RegisteredAgent[];
  context?: TalkContext;
  dataConnectors?: DataConnector[];
  talkDataConnectors?: TalkDataConnector[];
  channelConnections?: ChannelConnection[];
  channelTargets?: ChannelTarget[];
  talkChannels?: TalkChannelBinding[];
  ingressFailures?: ChannelQueueFailure[];
  deliveryFailures?: ChannelQueueFailure[];
  talkTools?: TalkTools;
  aiAgents?: AiAgentsPageData;
  onPutAgents?: (body: SavedTalkAgentRequest) => TalkAgent[];
  onGetContext?: () => TalkContext;
  onRetryContextSource?: (sourceId: string) => ContextSource;
  onUploadAttachment?: (formData: FormData) => TalkMessageAttachment;
  onSendMessage?: (body: {
    content: string;
    targetAgentIds: string[];
    attachmentIds?: string[];
    threadId?: string | null;
  }) => { talkId: string; message: TalkMessage; runs: TalkRun[] };
}) {
  const talk = input?.talk ?? buildTalk();
  let messages = input?.messages ?? [
    buildMessage({
      id: 'msg-1',
      role: 'user',
      content: 'How will Cal do next season?',
      createdAt: '2026-03-06T00:00:00.000Z',
    }),
  ];
  let threads = input?.threads ?? [
    buildThread({
      id: DEFAULT_THREAD_ID,
      talkId: 'talk-1',
      title: null,
      isDefault: true,
      messageCount: messages.filter((message) => message.threadId === DEFAULT_THREAD_ID)
        .length,
      lastMessageAt:
        messages
          .filter((message) => message.threadId === DEFAULT_THREAD_ID)
          .at(-1)?.createdAt ?? null,
    }),
  ];
  const runs = input?.runs ?? [
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
  const talkAgents = input?.talkAgents ?? [
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
  const registeredAgents = input?.registeredAgents ?? [
    buildRegisteredAgent({
      id: 'agent-claude',
      name: 'Claude Sonnet 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
    }),
    buildRegisteredAgent({
      id: 'agent-claude-opus',
      name: 'Claude Opus 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
    }),
    buildRegisteredAgent({
      id: 'agent-openai',
      name: 'GPT-5 Mini',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      personaRole: 'critic',
    }),
  ];
  const dataConnectors = input?.dataConnectors ?? [
    buildDataConnector({
      id: 'connector-posthog',
      name: 'FTUE PostHog',
      connectorKind: 'posthog',
      hasCredential: true,
      verificationStatus: 'not_verified',
      attachedTalkCount: 1,
    }),
    buildDataConnector({
      id: 'connector-sheet',
      name: 'Economy Sheet',
      connectorKind: 'google_sheets',
      hasCredential: true,
      verificationStatus: 'verified',
    }),
  ];
  let talkDataConnectors = input?.talkDataConnectors ?? [
    buildTalkDataConnector({
      ...dataConnectors[0],
      attachedAt: '2026-03-06T00:00:10.000Z',
    }),
  ];
  let context = input?.context ?? buildTalkContext();
  const channelConnections = input?.channelConnections ?? [
    buildChannelConnection(),
  ];
  const channelTargets = input?.channelTargets ?? [buildChannelTarget()];
  let talkChannels = input?.talkChannels ?? [buildTalkChannelBinding()];
  let ingressFailures = input?.ingressFailures ?? [buildChannelQueueFailure()];
  let deliveryFailures = input?.deliveryFailures ?? [
    buildChannelQueueFailure({
      id: 'failure-delivery-1',
      reasonCode: 'delivery_retries_exhausted',
      reasonDetail: 'Telegram delivery exhausted retries.',
    }),
  ];
  let talkTools = input?.talkTools ?? buildTalkTools();
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
      const parsedUrl = new URL(url, 'http://localhost');
      const path = parsedUrl.pathname;

      if (path === '/api/v1/talks/talk-1' && method === 'GET') {
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (path === '/api/v1/talks/talk-1' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          orchestrationMode?: Talk['orchestrationMode'];
        };
        if (body.orchestrationMode) {
          talk.orchestrationMode = body.orchestrationMode;
        }
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (path === '/api/v1/talks/talk-1/project-mount' && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          projectPath?: string;
        };
        talk.projectPath = body.projectPath?.trim() || null;
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (
        path === '/api/v1/talks/talk-1/project-mount' &&
        method === 'DELETE'
      ) {
        talk.projectPath = null;
        return jsonResponse(200, { ok: true, data: { talk } });
      }

      if (path === '/api/v1/talks/talk-1/threads' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            threads: threads.map(toThreadApiRecord),
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/threads' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          title?: string | null;
        };
        const created = buildThread({
          id: `thread-${threads.length + 1}`,
          talkId: 'talk-1',
          title: body.title?.trim() || null,
          isDefault: false,
          createdAt: '2026-03-06T00:00:12.000Z',
          updatedAt: '2026-03-06T00:00:12.000Z',
          messageCount: 0,
          lastMessageAt: null,
        });
        threads = [created, ...threads];
        return jsonResponse(201, {
          ok: true,
          data: {
            thread: toThreadApiRecord(created),
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/messages/search' && method === 'GET') {
        const query = parsedUrl.searchParams.get('q')?.trim() || '';
        const limit = Number(parsedUrl.searchParams.get('limit') || '20');
        const lowered = query.toLowerCase();
        const results =
          query.length === 0
            ? []
            : messages
                .filter((message) =>
                  message.content.toLowerCase().includes(lowered),
                )
                .slice(0, Number.isFinite(limit) ? limit : 20)
                .map((message) => ({
                  messageId: message.id,
                  threadId: message.threadId,
                  threadTitle:
                    threads.find((thread) => thread.id === message.threadId)
                      ?.title ?? null,
                  role: message.role,
                  createdAt: message.createdAt,
                  preview: message.content.slice(0, 140),
                }));
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            query,
            results,
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/messages' && method === 'GET') {
        const threadId = parsedUrl.searchParams.get('threadId');
        const visibleMessages = threadId
          ? messages.filter((message) => message.threadId === threadId)
          : messages;
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            messages: visibleMessages,
            page: {
              limit: 100,
              count: visibleMessages.length,
              beforeCreatedAt: null,
            },
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/messages/delete' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          messageIds?: string[];
          threadId?: string | null;
        };
        const deletedMessageIds = Array.isArray(body.messageIds)
          ? body.messageIds
          : [];
        messages = messages.filter(
          (message) =>
            !(
              deletedMessageIds.includes(message.id) &&
              message.threadId === body.threadId
            ),
        );
        threads = threads.map((thread) => {
          if (thread.id !== body.threadId) return thread;
          const threadMessages = messages.filter(
            (message) => message.threadId === thread.id,
          );
          return {
            ...thread,
            messageCount: threadMessages.length,
            lastMessageAt: threadMessages.at(-1)?.createdAt ?? null,
          };
        });
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            deletedCount: deletedMessageIds.length,
            deletedMessageIds,
          },
        });
      }

      if (
        url.endsWith('/api/v1/talks/talk-1/attachments') &&
        method === 'POST'
      ) {
        if (!(init?.body instanceof FormData)) {
          throw new Error('Expected attachment uploads to use FormData');
        }

        const file = init.body.get('file');
        if (!(file instanceof File)) {
          throw new Error('Expected file payload for attachment upload');
        }

        const attachment =
          input?.onUploadAttachment?.(init.body) ??
          buildMessageAttachment({
            id: 'att-1',
            fileName: file.name,
            fileSize: file.size,
            mimeType: file.type,
            extractionStatus: 'extracted',
          });

        return jsonResponse(201, {
          ok: true,
          data: { attachment },
        });
      }

      if (path === '/api/v1/talks/talk-1/runs' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            runs,
          },
        });
      }

      if (path === '/api/v1/talks/talk-1/agents' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', agents: talkAgents },
        });
      }

      if (path === '/api/v1/registered-agents' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: registeredAgents,
        });
      }

      if (path === '/api/v1/talks/talk-1/context' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: input?.onGetContext?.() ?? context,
        });
      }

      if (path === '/api/v1/talks/talk-1/tools' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: talkTools,
        });
      }

      if (path === '/api/v1/talks/talk-1/tools' && method === 'PUT') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          grants?: Array<{ toolId: string; enabled: boolean }>;
        };
        if (Array.isArray(body.grants)) {
          talkTools = {
            ...talkTools,
            grants: talkTools.grants.map((grant) => {
              const update = body.grants?.find(
                (entry) => entry.toolId === grant.toolId,
              );
              return update ? { ...grant, enabled: update.enabled } : grant;
            }),
          };
        }
        return jsonResponse(200, {
          ok: true,
          data: talkTools,
        });
      }

      if (url.endsWith('/api/v1/me/google-account') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { googleAccount: talkTools.googleAccount },
        });
      }

      if (
        url.endsWith('/api/v1/me/google-account/connect') &&
        method === 'POST'
      ) {
        talkTools = {
          ...talkTools,
          googleAccount: {
            connected: true,
            email: 'owner@example.com',
            displayName: 'Owner',
            scopes: talkTools.googleAccount.scopes,
            accessExpiresAt: null,
          },
        };
        return jsonResponse(200, {
          ok: true,
          data: { googleAccount: talkTools.googleAccount },
        });
      }

      if (
        url.endsWith('/api/v1/me/google-account/expand-scopes') &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          scopes?: string[];
        };
        talkTools = {
          ...talkTools,
          googleAccount: {
            ...talkTools.googleAccount,
            connected: true,
            email: talkTools.googleAccount.email ?? 'owner@example.com',
            displayName: talkTools.googleAccount.displayName ?? 'Owner',
            scopes: Array.from(
              new Set([
                ...talkTools.googleAccount.scopes,
                ...(Array.isArray(body.scopes) ? body.scopes : []),
              ]),
            ),
          },
        };
        return jsonResponse(200, {
          ok: true,
          data: { googleAccount: talkTools.googleAccount },
        });
      }

      if (
        url.endsWith('/api/v1/talks/talk-1/resources/google-drive') &&
        method === 'POST'
      ) {
        const body = JSON.parse(String(init?.body || '{}')) as {
          bindingKind?: TalkTools['bindings'][number]['bindingKind'];
          externalId?: string;
          displayName?: string;
          metadata?: Record<string, unknown> | null;
        };
        const binding = {
          id: `binding-${talkTools.bindings.length + 1}`,
          bindingKind: body.bindingKind ?? 'google_drive_folder',
          externalId: body.externalId ?? 'resource-id',
          displayName: body.displayName ?? 'Resource',
          metadata: body.metadata ?? null,
          createdAt: '2026-03-06T00:00:00.000Z',
          createdBy: 'owner-1',
        };
        talkTools = {
          ...talkTools,
          bindings: [...talkTools.bindings, binding],
        };
        return jsonResponse(201, {
          ok: true,
          data: { binding },
        });
      }

      if (
        url.includes('/api/v1/talks/talk-1/resources/') &&
        method === 'DELETE'
      ) {
        const resourceId = url.split('/').pop() || '';
        talkTools = {
          ...talkTools,
          bindings: talkTools.bindings.filter(
            (binding) => binding.id !== resourceId,
          ),
        };
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (url.endsWith('/api/v1/channel-connections') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { connections: channelConnections },
        });
      }

      if (
        url.includes('/api/v1/channel-connections/') &&
        url.includes('/targets') &&
        method === 'GET'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: { targets: channelTargets },
        });
      }

      if (path === '/api/v1/talks/talk-1/channels' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', bindings: talkChannels },
        });
      }

      if (path === '/api/v1/talks/talk-1/channels' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as Record<
          string,
          unknown
        >;
        const created = buildTalkChannelBinding({
          id: `binding-${talkChannels.length + 1}`,
          talkId: 'talk-1',
          connectionId: String(
            body.connectionId || 'channel-conn:telegram:system',
          ),
          targetKind: String(body.targetKind || 'chat'),
          targetId: String(
            body.targetId || `tg:group:${talkChannels.length + 100}`,
          ),
          displayName: String(body.displayName || 'New Telegram Binding'),
          responseMode:
            (body.responseMode as TalkChannelBinding['responseMode']) ??
            'mentions',
          responderMode:
            (body.responderMode as TalkChannelBinding['responderMode']) ??
            'primary',
          responderAgentId:
            body.responderAgentId == null
              ? null
              : String(body.responderAgentId),
          deliveryMode:
            (body.deliveryMode as TalkChannelBinding['deliveryMode']) ??
            'reply',
          channelContextNote:
            body.channelContextNote == null
              ? null
              : String(body.channelContextNote),
          inboundRateLimitPerMinute: Number(
            body.inboundRateLimitPerMinute || 10,
          ),
          maxPendingEvents: Number(body.maxPendingEvents || 20),
          overflowPolicy:
            (body.overflowPolicy as TalkChannelBinding['overflowPolicy']) ??
            'drop_oldest',
          maxDeferredAgeMinutes: Number(body.maxDeferredAgeMinutes || 10),
        });
        talkChannels = [...talkChannels, created];
        return jsonResponse(201, {
          ok: true,
          data: { binding: created },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+$/.test(url) &&
        method === 'PATCH'
      ) {
        const bindingId = url.split('/api/v1/talks/talk-1/channels/')[1];
        talkChannels = talkChannels.map((binding) =>
          binding.id === bindingId
            ? {
                ...binding,
                ...JSON.parse(String(init?.body || '{}')),
              }
            : binding,
        );
        return jsonResponse(200, {
          ok: true,
          data: {
            binding: talkChannels.find((binding) => binding.id === bindingId),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+$/.test(url) &&
        method === 'DELETE'
      ) {
        const bindingId = url.split('/api/v1/talks/talk-1/channels/')[1];
        talkChannels = talkChannels.filter(
          (binding) => binding.id !== bindingId,
        );
        ingressFailures = ingressFailures.filter(
          (failure) => failure.bindingId !== bindingId,
        );
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.bindingId !== bindingId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/test$/.test(url) &&
        method === 'POST'
      ) {
        return jsonResponse(200, {
          ok: true,
          data: { sent: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures$/.test(
          url,
        ) &&
        method === 'GET'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/')[0];
        return jsonResponse(200, {
          ok: true,
          data: {
            failures: ingressFailures.filter(
              (failure) => failure.bindingId === bindingId,
            ),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures$/.test(
          url,
        ) &&
        method === 'GET'
      ) {
        const bindingId = url
          .split('/api/v1/talks/talk-1/channels/')[1]
          .split('/')[0];
        return jsonResponse(200, {
          ok: true,
          data: {
            failures: deliveryFailures.filter(
              (failure) => failure.bindingId === bindingId,
            ),
          },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures\/[^/]+\/retry$/.test(
          url,
        ) &&
        method === 'POST'
      ) {
        const rowId = url.split('/ingress-failures/')[1].split('/')[0];
        ingressFailures = ingressFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { retried: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures\/[^/]+\/retry$/.test(
          url,
        ) &&
        method === 'POST'
      ) {
        const rowId = url.split('/delivery-failures/')[1].split('/')[0];
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { retried: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/ingress-failures\/[^/]+$/.test(
          url,
        ) &&
        method === 'DELETE'
      ) {
        const rowId = url.split('/ingress-failures/')[1];
        ingressFailures = ingressFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (
        /\/api\/v1\/talks\/talk-1\/channels\/[^/]+\/delivery-failures\/[^/]+$/.test(
          url,
        ) &&
        method === 'DELETE'
      ) {
        const rowId = url.split('/delivery-failures/')[1];
        deliveryFailures = deliveryFailures.filter(
          (failure) => failure.id !== rowId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (path === '/api/v1/talks/talk-1/data-connectors' && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { talkId: 'talk-1', connectors: talkDataConnectors },
        });
      }

      if (path === '/api/v1/talks/talk-1/data-connectors' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          connectorId: string;
        };
        const source = dataConnectors.find(
          (connector) => connector.id === body.connectorId,
        );
        if (!source) {
          return jsonResponse(404, {
            ok: false,
            error: { code: 'not_found', message: 'Data connector not found.' },
          });
        }
        const attached = buildTalkDataConnector({
          ...source,
          attachedAt: '2026-03-06T00:00:12.000Z',
        });
        talkDataConnectors = [...talkDataConnectors, attached];
        return jsonResponse(200, {
          ok: true,
          data: { connector: attached },
        });
      }

      if (
        url.includes('/api/v1/talks/talk-1/data-connectors/') &&
        method === 'DELETE'
      ) {
        const connectorId = url.split(
          '/api/v1/talks/talk-1/data-connectors/',
        )[1];
        talkDataConnectors = talkDataConnectors.filter(
          (connector) => connector.id !== connectorId,
        );
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      if (url.endsWith('/api/v1/data-connectors') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { connectors: dataConnectors },
        });
      }

      if (url.endsWith('/api/v1/agents') && method === 'GET') {
        return jsonResponse(200, { ok: true, data: aiAgents });
      }

      if (path === '/api/v1/talks/talk-1/agents' && method === 'PUT') {
        const body = JSON.parse(
          String(init?.body || '{}'),
        ) as SavedTalkAgentRequest;
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

      if (path === '/api/v1/talks/talk-1/chat' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          content: string;
          targetAgentIds: string[];
          attachmentIds?: string[];
          threadId?: string | null;
        };
        const payload = input?.onSendMessage?.(body) ?? {
          talkId: 'talk-1',
          message: buildMessage({
            id: 'msg-posted',
            threadId: body.threadId ?? DEFAULT_THREAD_ID,
            role: 'user',
            content: body.content,
            createdAt: '2026-03-06T00:00:05.000Z',
          }),
          runs: body.targetAgentIds.map((agentId, index, all) =>
            buildRun({
              id: `run-${index + 10}`,
              threadId: body.threadId ?? DEFAULT_THREAD_ID,
              responseGroupId: all.length > 1 ? 'group-default-send' : null,
              sequenceIndex: all.length > 1 ? index : null,
              status: 'queued',
              createdAt: `2026-03-06T00:00:0${index + 6}.000Z`,
              triggerMessageId: 'msg-posted',
              targetAgentId: agentId,
              targetAgentNickname:
                agentId === 'agent-claude' ? 'Claude Sonnet 4.6' : 'GPT-5 Mini',
            }),
          ),
        };
        const threadId = payload.message.threadId;
        const threadMessages = [...messages, payload.message]
          .filter((message) => message.threadId === threadId)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
        threads = threads.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                title: thread.title,
                messageCount: threadMessages.length,
                lastMessageAt: threadMessages.at(-1)?.createdAt ?? null,
              }
            : thread,
        );
        return jsonResponse(200, { ok: true, data: payload });
      }

      if (path === '/api/v1/talks/talk-1/chat/cancel' && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          threadId?: string | null;
        };
        return jsonResponse(200, {
          ok: true,
          data: {
            talkId: 'talk-1',
            cancelledRuns: body.threadId ? 1 : 2,
          },
        });
      }

      if (
        url.includes('/api/v1/talks/talk-1/context/sources/') &&
        url.endsWith('/retry') &&
        method === 'POST'
      ) {
        const sourceId = url
          .split('/api/v1/talks/talk-1/context/sources/')[1]
          .replace('/retry', '');
        const updated =
          input?.onRetryContextSource?.(sourceId) ??
          buildContextSource({
            id: sourceId,
            status: 'pending',
            extractionError: null,
          });
        context = {
          ...context,
          sources: context.sources.map((source) =>
            source.id === sourceId ? updated : source,
          ),
        };
        return jsonResponse(200, {
          ok: true,
          data: { source: updated },
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
