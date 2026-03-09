import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalk,
  createTalkMessage,
  createTalkRun,
  enqueueTalkTurnAtomic as enqueueTalkTurnAtomicRaw,
  upsertUser,
} from '../db/index.js';

import { assembleTalkPromptContext } from './context-assembler.js';

const OWNER_ID = 'owner-1';
const TALK_ID = 'talk-1';

function seedTalk(): void {
  upsertUser({
    id: OWNER_ID,
    email: 'owner@example.com',
    displayName: 'Owner',
    role: 'owner',
  });
  createTalk({
    id: TALK_ID,
    ownerId: OWNER_ID,
    topicTitle: 'Context Assembly Test Talk',
  });
}

function createHistoricalTurn(input: {
  userMessageId: string;
  userText: string;
  userCreatedAt: string;
  assistants: Array<{
    runId: string;
    content: string;
    createdAt: string;
    status?: 'running' | 'completed' | 'failed';
    sequenceInRun?: number | null;
    messageId?: string;
    metadataJson?: string | null;
  }>;
}): void {
  createTalkMessage({
    id: input.userMessageId,
    talkId: TALK_ID,
    role: 'user',
    content: input.userText,
    createdBy: OWNER_ID,
    createdAt: input.userCreatedAt,
  });

  for (const assistant of input.assistants) {
    createTalkRun({
      id: assistant.runId,
      talk_id: TALK_ID,
      requested_by: OWNER_ID,
      status: assistant.status || 'completed',
      trigger_message_id: input.userMessageId,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: assistant.createdAt,
      started_at: assistant.createdAt,
      ended_at: assistant.status === 'running' ? null : assistant.createdAt,
      cancel_reason: assistant.status === 'failed' ? 'failed' : null,
    });
    createTalkMessage({
      id: assistant.messageId || `${assistant.runId}-assistant`,
      talkId: TALK_ID,
      role: 'assistant',
      content: assistant.content,
      createdBy: null,
      runId: assistant.runId,
      metadataJson: assistant.metadataJson || null,
      sequenceInRun: assistant.sequenceInRun ?? null,
      createdAt: assistant.createdAt,
    });
  }
}

function enqueueCurrentTurn(input: {
  messageId: string;
  runId: string;
  content: string;
  createdAt: string;
}): void {
  enqueueTalkTurnAtomicRaw({
    talkId: TALK_ID,
    userId: OWNER_ID,
    content: input.content,
    messageId: input.messageId,
    runIds: [input.runId],
    targetAgentIds: ['agent-default'],
    now: input.createdAt,
  });
}

function createCurrentTurn(input: {
  messageId: string;
  runId: string;
  content: string;
  createdAt: string;
}): void {
  createTalkMessage({
    id: input.messageId,
    talkId: TALK_ID,
    role: 'user',
    content: input.content,
    createdBy: OWNER_ID,
    createdAt: input.createdAt,
  });
  createTalkRun({
    id: input.runId,
    talk_id: TALK_ID,
    requested_by: OWNER_ID,
    status: 'queued',
    trigger_message_id: input.messageId,
    target_agent_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: input.createdAt,
    started_at: null,
    ended_at: null,
    cancel_reason: null,
  });
}

function assembleConversation(input: {
  currentRunId: string;
  currentUserMessageId: string;
  currentUserMessage: string;
  modelContextWindowTokens?: number;
  maxOutputTokens?: number;
}) {
  return assembleTalkPromptContext({
    talkId: TALK_ID,
    talkTitle: 'Context Assembly Test Talk',
    currentRunId: input.currentRunId,
    currentUserMessageId: input.currentUserMessageId,
    currentUserMessage: input.currentUserMessage,
    agent: {
      id: 'agent-default',
      name: 'Opus',
      personaRole: 'analyst',
    },
    modelContextWindowTokens: input.modelContextWindowTokens ?? 32_000,
    maxOutputTokens: input.maxOutputTokens ?? 1_024,
  });
}

function conversationMessages(result: ReturnType<typeof assembleConversation>) {
  return result.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role,
      text: message.text,
    }));
}

describe('assembleTalkPromptContext', () => {
  beforeEach(() => {
    _initTestDatabase();
    seedTalk();
  });

  it('replays shared multi-agent history from trigger_message_id linkage', () => {
    createHistoricalTurn({
      userMessageId: 'msg-prev',
      userText: "Can you both evaluate Lila's fit?",
      userCreatedAt: '2024-01-01T00:00:00.000Z',
      assistants: [
        {
          runId: 'run-kimi',
          content: 'Kimi: strong operator, weak game-economy depth.',
          createdAt: '2024-01-01T00:00:01.000Z',
        },
        {
          runId: 'run-opus-prev',
          content: 'Opus: hire for AI tooling, not core game economy.',
          createdAt: '2024-01-01T00:00:02.000Z',
        },
      ],
    });
    enqueueCurrentTurn({
      messageId: 'msg-current',
      runId: 'run-current',
      content: 'Can you synthesize the parts you both agree with?',
      createdAt: '2024-01-01T00:10:00.000Z',
    });

    const result = assembleConversation({
      currentRunId: 'run-current',
      currentUserMessageId: 'msg-current',
      currentUserMessage: 'Can you synthesize the parts you both agree with?',
    });

    expect(conversationMessages(result)).toEqual([
      {
        role: 'user',
        text: "Can you both evaluate Lila's fit?",
      },
      {
        role: 'assistant',
        text: 'Kimi: strong operator, weak game-economy depth.',
      },
      {
        role: 'assistant',
        text: 'Opus: hire for AI tooling, not core game economy.',
      },
      {
        role: 'user',
        text: 'Can you synthesize the parts you both agree with?',
      },
    ]);
  });

  it('drops orphan user turns and orphan assistant replies', () => {
    createHistoricalTurn({
      userMessageId: 'msg-complete',
      userText: 'What happened yesterday?',
      userCreatedAt: '2024-01-01T00:00:00.000Z',
      assistants: [
        {
          runId: 'run-complete',
          content: 'We reviewed the launch checklist.',
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      ],
    });
    createTalkMessage({
      id: 'msg-orphan-user',
      talkId: TALK_ID,
      role: 'user',
      content: 'This incomplete question should be dropped.',
      createdBy: OWNER_ID,
      createdAt: '2024-01-01T00:05:00.000Z',
    });
    createTalkRun({
      id: 'run-orphan-assistant',
      talk_id: TALK_ID,
      requested_by: OWNER_ID,
      status: 'completed',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:06:00.000Z',
      started_at: '2024-01-01T00:06:00.000Z',
      ended_at: '2024-01-01T00:06:00.000Z',
      cancel_reason: null,
    });
    createTalkMessage({
      id: 'msg-orphan-assistant',
      talkId: TALK_ID,
      role: 'assistant',
      content: 'Ghost assistant reply',
      createdBy: null,
      runId: 'run-orphan-assistant',
      createdAt: '2024-01-01T00:06:01.000Z',
    });
    enqueueCurrentTurn({
      messageId: 'msg-current',
      runId: 'run-current',
      content: 'What is the next step?',
      createdAt: '2024-01-01T00:10:00.000Z',
    });

    const result = assembleConversation({
      currentRunId: 'run-current',
      currentUserMessageId: 'msg-current',
      currentUserMessage: 'What is the next step?',
    });
    const joined = JSON.stringify(conversationMessages(result));

    expect(joined).toContain('What happened yesterday?');
    expect(joined).toContain('We reviewed the launch checklist.');
    expect(joined).not.toContain('This incomplete question should be dropped.');
    expect(joined).not.toContain('Ghost assistant reply');
  });

  it('excludes only the exact current run and not other running assistant replies', () => {
    createHistoricalTurn({
      userMessageId: 'msg-prev',
      userText: 'Give both perspectives.',
      userCreatedAt: '2024-01-01T00:00:00.000Z',
      assistants: [
        {
          runId: 'run-peer-running',
          content: 'Kimi is already drafting a response.',
          createdAt: '2024-01-01T00:00:01.000Z',
          status: 'running',
        },
        {
          runId: 'run-peer-complete',
          content: 'Opus already delivered a final answer.',
          createdAt: '2024-01-01T00:00:02.000Z',
          status: 'completed',
        },
      ],
    });
    createCurrentTurn({
      messageId: 'msg-current',
      runId: 'run-current',
      content: 'Now tell me what they agree on.',
      createdAt: '2024-01-01T00:10:00.000Z',
    });

    const result = assembleConversation({
      currentRunId: 'run-current',
      currentUserMessageId: 'msg-current',
      currentUserMessage: 'Now tell me what they agree on.',
    });
    const texts = conversationMessages(result).map((message) => message.text);

    expect(texts).toContain('Kimi is already drafting a response.');
    expect(texts).toContain('Opus already delivered a final answer.');
  });

  it('excludes tool-use noise and preserves deterministic assistant order', () => {
    createHistoricalTurn({
      userMessageId: 'msg-prev',
      userText: 'Summarize the evidence.',
      userCreatedAt: '2024-01-01T00:00:00.000Z',
      assistants: [
        {
          runId: 'run-tool',
          content: 'Tool call details',
          createdAt: '2024-01-01T00:00:01.000Z',
          messageId: 'msg-tool',
          metadataJson: JSON.stringify({ kind: 'assistant_tool_use' }),
        },
        {
          runId: 'run-b',
          content: 'Second persisted reply',
          createdAt: '2024-01-01T00:00:02.000Z',
          messageId: 'msg-b',
        },
        {
          runId: 'run-a',
          content: 'First persisted reply',
          createdAt: '2024-01-01T00:00:02.000Z',
          messageId: 'msg-a',
        },
      ],
    });
    enqueueCurrentTurn({
      messageId: 'msg-current',
      runId: 'run-current',
      content: 'What matters most?',
      createdAt: '2024-01-01T00:10:00.000Z',
    });

    const result = assembleConversation({
      currentRunId: 'run-current',
      currentUserMessageId: 'msg-current',
      currentUserMessage: 'What matters most?',
    });

    expect(conversationMessages(result)).toEqual([
      {
        role: 'user',
        text: 'Summarize the evidence.',
      },
      {
        role: 'assistant',
        text: 'First persisted reply',
      },
      {
        role: 'assistant',
        text: 'Second persisted reply',
      },
      {
        role: 'user',
        text: 'What matters most?',
      },
    ]);
  });

  it('keeps the newest contiguous fitting turns only', () => {
    createHistoricalTurn({
      userMessageId: 'msg-old',
      userText: 'Old request that should be dropped.',
      userCreatedAt: '2024-01-01T00:00:00.000Z',
      assistants: [
        {
          runId: 'run-old',
          content: 'x'.repeat(900),
          createdAt: '2024-01-01T00:00:01.000Z',
        },
      ],
    });
    createHistoricalTurn({
      userMessageId: 'msg-recent',
      userText: 'Recent request to keep.',
      userCreatedAt: '2024-01-01T00:05:00.000Z',
      assistants: [
        {
          runId: 'run-recent',
          content: 'Recent answer to keep.',
          createdAt: '2024-01-01T00:05:01.000Z',
        },
      ],
    });
    enqueueCurrentTurn({
      messageId: 'msg-current',
      runId: 'run-current',
      content: 'Current question.',
      createdAt: '2024-01-01T00:10:00.000Z',
    });

    const result = assembleConversation({
      currentRunId: 'run-current',
      currentUserMessageId: 'msg-current',
      currentUserMessage: 'Current question.',
      modelContextWindowTokens: 700,
      maxOutputTokens: 100,
    });
    const joined = JSON.stringify(conversationMessages(result));

    expect(joined).toContain('Recent request to keep.');
    expect(joined).toContain('Recent answer to keep.');
    expect(joined).not.toContain('Old request that should be dropped.');
    expect(joined).not.toContain('x'.repeat(100));
  });
});
