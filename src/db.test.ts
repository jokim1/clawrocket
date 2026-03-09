import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getAllRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  isDatabaseHealthy,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';
import {
  _initClawrocketTestSchema,
  appendRuntimeTalkMessage,
  appendOutboxEvent,
  canUserEditTalk,
  claimNextChannelDeliveryRow,
  cancelTalkRunsAtomic,
  completeRunAndPromoteNextAtomic,
  consumeOAuthStateByHash,
  createTalkChannelBinding,
  createOAuthState,
  createTalk,
  createTalkMessage,
  createTalkRun,
  deleteTalkMessagesAtomic,
  enqueueChannelTurnAtomic,
  enqueueTalkTurnAtomic as enqueueTalkTurnAtomicRaw,
  ensureSystemManagedTelegramConnection,
  failInterruptedRunsOnStartup,
  failRunAndPromoteNextAtomic,
  deleteTalkExecutorSession,
  getIdempotencyCache,
  getOutboxEventsForTopics,
  getQueuedTalkRuns,
  getRunningTalkRun,
  getTalkById,
  getTalkExecutorSession,
  getTalkForUser,
  getTalkLlmPolicyByTalkId,
  getTalkRunById,
  searchChannelTargets,
  getUserById,
  listTalkMessages,
  listTalksForUser,
  markTalkRunStatus,
  normalizeTalkListPage,
  pruneEventOutbox,
  pruneIdempotencyCache,
  resetTalkAgentsToDefault,
  saveIdempotencyCache,
  setTalkRunExecutorProfile,
  upsertTalk,
  upsertChannelTarget,
  upsertTalkExecutorSession,
  upsertTalkLlmPolicy,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from './clawrocket/db/index.js';
import { computeSessionCompatKey } from './clawrocket/talks/executor-settings.js';

function enqueueTalkTurnAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  targetAgentId?: string;
  idempotencyKey?: string | null;
  now?: string;
}) {
  const result = enqueueTalkTurnAtomicRaw({
    talkId: input.talkId,
    userId: input.userId,
    content: input.content,
    messageId: input.messageId,
    runIds: [input.runId],
    targetAgentIds: [input.targetAgentId || 'agent-default'],
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  });
  return {
    ...result,
    run: result.runs[0],
  };
}

beforeEach(() => {
  _initTestDatabase();
  _initClawrocketTestSchema();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('123@s.whatsapp.net');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('filters out empty content', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'group@g.us',
      sender: '111@s.whatsapp.net',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(0);
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'group@g.us',
      sender: 'me@s.whatsapp.net',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'group@g.us',
      sender: '123@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'm1',
      chat_jid: 'group@g.us',
      sender: 'Alice@s.whatsapp.net',
      sender_name: 'Alice',
      content: 'first',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'm2',
      chat_jid: 'group@g.us',
      sender: 'Bob@s.whatsapp.net',
      sender_name: 'Bob',
      content: 'second',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'm3',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'm4',
      chat_jid: 'group@g.us',
      sender: 'Carol@s.whatsapp.net',
      sender_name: 'Carol',
      content: 'third',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes bot messages via is_bot_message flag', () => {
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    const botMsgs = msgs.filter((m) => m.content === 'bot reply');
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all non-bot messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('group@g.us', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });

  it('filters pre-migration bot messages via content prefix backstop', () => {
    // Simulate a message written before migration: has prefix but is_bot_message = 0
    store({
      id: 'm5',
      chat_jid: 'group@g.us',
      sender: 'Bot@s.whatsapp.net',
      sender_name: 'Bot',
      content: 'Andy: old bot reply',
      timestamp: '2024-01-01T00:00:05.000Z',
    });
    const msgs = getMessagesSince(
      'group@g.us',
      '2024-01-01T00:00:04.000Z',
      'Andy',
    );
    expect(msgs).toHaveLength(0);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('group1@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group2@g.us', '2024-01-01T00:00:00.000Z');

    store({
      id: 'a1',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg1',
      timestamp: '2024-01-01T00:00:01.000Z',
    });
    store({
      id: 'a2',
      chat_jid: 'group2@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g2 msg1',
      timestamp: '2024-01-01T00:00:02.000Z',
    });
    storeMessage({
      id: 'a3',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'bot reply',
      timestamp: '2024-01-01T00:00:03.000Z',
      is_bot_message: true,
    });
    store({
      id: 'a4',
      chat_jid: 'group1@g.us',
      sender: 'user@s.whatsapp.net',
      sender_name: 'User',
      content: 'g1 msg2',
      timestamp: '2024-01-01T00:00:04.000Z',
    });
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes bot message, returns 3 user messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['group1@g.us', 'group2@g.us'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('group@g.us');
    expect(chats[0].name).toBe('group@g.us');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('group@g.us', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'group@g.us',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});

// --- RegisteredGroup isMain round-trip ---

describe('registered group isMain', () => {
  it('persists isMain=true through set/get round-trip', () => {
    setRegisteredGroup('main@s.whatsapp.net', {
      name: 'Main Chat',
      folder: 'whatsapp_main',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
      isMain: true,
    });

    const groups = getAllRegisteredGroups();
    const group = groups['main@s.whatsapp.net'];
    expect(group).toBeDefined();
    expect(group.isMain).toBe(true);
    expect(group.folder).toBe('whatsapp_main');
  });

  it('omits isMain for non-main groups', () => {
    setRegisteredGroup('group@g.us', {
      name: 'Family Chat',
      folder: 'whatsapp_family-chat',
      trigger: '@Andy',
      added_at: '2024-01-01T00:00:00.000Z',
    });

    const groups = getAllRegisteredGroups();
    const group = groups['group@g.us'];
    expect(group).toBeDefined();
    expect(group.isMain).toBeUndefined();
  });
});

describe('phase 0 schema and reliability tables', () => {
  beforeEach(() => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Test Talk',
    });
    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'member-1',
      role: 'editor',
    });
  });

  it('creates and reads users and sessions', () => {
    upsertWebSession({
      id: 'session-1',
      userId: 'owner-1',
      accessTokenHash: 'hash-a',
      refreshTokenHash: 'hash-r',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const owner = getUserById('owner-1');
    expect(owner?.role).toBe('owner');
    expect(isDatabaseHealthy()).toBe(true);
  });

  it('stores and replays outbox events', () => {
    const eventId = appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'message_appended',
      payload: JSON.stringify({ messageId: 'm1' }),
    });
    expect(eventId).toBeGreaterThan(0);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0);
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('message_appended');
  });

  it('consumes oauth state only once', () => {
    createOAuthState({
      id: 'oauth-1',
      provider: 'google',
      stateHash: 'state-hash-1',
      nonceHash: 'nonce-hash-1',
      codeVerifierHash: 'verifier-hash-1',
      redirectUri: 'http://127.0.0.1:3210/api/v1/auth/google/callback',
      returnTo: '/app/talks/talk-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = consumeOAuthStateByHash('state-hash-1');
    expect(first?.id).toBe('oauth-1');
    expect(first?.return_to).toBe('/app/talks/talk-1');
    expect(first?.used_at).toBeTruthy();

    const second = consumeOAuthStateByHash('state-hash-1');
    expect(second).toBeUndefined();
  });

  it('stores and reads talk policy by talk id', () => {
    expect(getTalkLlmPolicyByTalkId('talk-1')).toBeNull();

    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini","Opus4.6"]}',
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    expect(getTalkLlmPolicyByTalkId('talk-1')).toBe(
      '{"agents":["Gemini","Opus4.6"]}',
    );
  });

  it('upserts and deletes talk executor sessions', () => {
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();

    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
      sessionCompatKey: computeSessionCompatKey('Gemini', 'default'),
      updatedAt: '2024-01-01T00:00:00.000Z',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-2',
      executorAlias: 'Opus4.6',
      executorModel: 'default',
      sessionCompatKey: computeSessionCompatKey('Opus4.6', 'default'),
      updatedAt: '2024-01-01T00:00:01.000Z',
    });

    const session = getTalkExecutorSession('talk-1');
    expect(session).toBeDefined();
    expect(session?.session_id).toBe('session-2');
    expect(session?.executor_alias).toBe('Opus4.6');
    expect(session?.executor_model).toBe('default');
    expect(session?.session_compat_key).toBe(
      computeSessionCompatKey('Opus4.6', 'default'),
    );
    expect(session?.updated_at).toBe('2024-01-01T00:00:01.000Z');

    deleteTalkExecutorSession('talk-1');
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();
  });

  it('does not change talk owner when upserting existing talk id', () => {
    upsertUser({
      id: 'owner-2',
      email: 'owner2@example.com',
      displayName: 'Owner 2',
      role: 'member',
    });

    expect(canUserEditTalk('talk-1', 'owner-1')).toBe(true);
    expect(canUserEditTalk('talk-1', 'owner-2')).toBe(false);

    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-2',
      topicTitle: 'Updated title',
    });

    expect(canUserEditTalk('talk-1', 'owner-1')).toBe(true);
    expect(canUserEditTalk('talk-1', 'owner-2')).toBe(false);
  });

  it('creates talk rows and resolves talk access for shared members', () => {
    createTalk({
      id: 'talk-2',
      ownerId: 'owner-1',
      topicTitle: 'Shared',
    });
    upsertTalkMember({
      talkId: 'talk-2',
      userId: 'member-1',
      role: 'viewer',
    });

    const talk = getTalkById('talk-2');
    expect(talk?.topic_title).toBe('Shared');

    const ownerView = getTalkForUser('talk-2', 'owner-1');
    expect(ownerView?.access_role).toBe('owner');

    const memberView = getTalkForUser('talk-2', 'member-1');
    expect(memberView?.access_role).toBe('viewer');

    const memberList = listTalksForUser({ userId: 'member-1' });
    expect(memberList.some((entry) => entry.id === 'talk-2')).toBe(true);
  });

  it('stores and paginates talk messages', () => {
    createTalkMessage({
      id: 'tm-1',
      talkId: 'talk-1',
      role: 'user',
      content: 'hello',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkMessage({
      id: 'tm-2',
      talkId: 'talk-1',
      role: 'assistant',
      content: 'world',
      createdBy: null,
      createdAt: '2024-01-01T00:00:01.000Z',
    });

    const all = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(all.map((message) => message.id)).toEqual(['tm-1', 'tm-2']);

    const before = listTalkMessages({
      talkId: 'talk-1',
      limit: 10,
      beforeCreatedAt: '2024-01-01T00:00:01.000Z',
    });
    expect(before.map((message) => message.id)).toEqual(['tm-1']);
  });

  it('deletes selected talk messages, clears executor session, and emits a history-edited event', () => {
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-edit-1',
      executorAlias: 'Claude',
      executorModel: 'claude-sonnet-4-6',
      sessionCompatKey: computeSessionCompatKey('Claude', 'claude-sonnet-4-6'),
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    createTalkMessage({
      id: 'tm-edit-1',
      talkId: 'talk-1',
      role: 'user',
      content: 'old question',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    createTalkMessage({
      id: 'tm-edit-2',
      talkId: 'talk-1',
      role: 'assistant',
      content: 'old answer',
      createdAt: '2024-01-01T00:00:01.000Z',
    });
    createTalkMessage({
      id: 'tm-edit-3',
      talkId: 'talk-1',
      role: 'user',
      content: 'keep me',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    const result = deleteTalkMessagesAtomic({
      talkId: 'talk-1',
      messageIds: ['tm-edit-1', 'tm-edit-2'],
      now: '2024-01-01T00:00:03.000Z',
    });

    expect(result).toEqual({
      deletedCount: 2,
      deletedMessageIds: ['tm-edit-1', 'tm-edit-2'],
    });
    expect(
      listTalkMessages({ talkId: 'talk-1', limit: 10 }).map(
        (message) => message.id,
      ),
    ).toEqual(['tm-edit-3']);
    expect(getTalkExecutorSession('talk-1')).toBeUndefined();

    const historyEvent = getOutboxEventsForTopics(['talk:talk-1'], 0, 20).find(
      (event) => event.event_type === 'talk_history_edited',
    );
    expect(historyEvent).toBeDefined();
    expect(JSON.parse(historyEvent!.payload)).toMatchObject({
      talkId: 'talk-1',
      deletedCount: 2,
      deletedMessageIds: ['tm-edit-1', 'tm-edit-2'],
      editedAt: '2024-01-01T00:00:03.000Z',
    });
  });

  it('orders same-timestamp talk messages by sequence_in_run and includes runtime metadata in outbox events', () => {
    createTalkRun({
      id: 'run-seq-1',
      talk_id: 'talk-1',
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      target_agent_id: 'agent-default',
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:01.000Z',
      started_at: '2024-01-01T00:00:01.500Z',
      ended_at: null,
      cancel_reason: null,
    });

    createTalkMessage({
      id: 'tm-seq-user',
      talkId: 'talk-1',
      role: 'user',
      content: 'trigger',
      createdBy: 'owner-1',
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    appendRuntimeTalkMessage({
      id: 'tm-seq-assistant',
      talkId: 'talk-1',
      runId: 'run-seq-1',
      role: 'assistant',
      content: 'Checking connector data',
      sequenceInRun: 1,
      metadataJson: JSON.stringify({
        kind: 'assistant_tool_use',
        agentId: 'agent-1',
        agentNickname: 'Opus',
      }),
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    appendRuntimeTalkMessage({
      id: 'tm-seq-tool',
      talkId: 'talk-1',
      runId: 'run-seq-1',
      role: 'tool',
      content: 'Returned 12 rows',
      sequenceInRun: 2,
      metadataJson: JSON.stringify({
        kind: 'tool_result',
        toolName: 'connector_posthog__query',
      }),
      createdAt: '2024-01-01T00:00:02.000Z',
    });

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(messages.map((message) => message.id)).toEqual([
      'tm-seq-user',
      'tm-seq-assistant',
      'tm-seq-tool',
    ]);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 20)
      .filter((event) => event.event_type === 'message_appended')
      .map((event) => JSON.parse(event.payload) as Record<string, unknown>);
    const assistantEvent = events.find(
      (event) => event.messageId === 'tm-seq-assistant',
    );
    const toolEvent = events.find((event) => event.messageId === 'tm-seq-tool');

    expect(assistantEvent?.metadata).toMatchObject({
      kind: 'assistant_tool_use',
      agentId: 'agent-1',
      agentNickname: 'Opus',
    });
    expect(assistantEvent).toMatchObject({
      agentId: 'agent-1',
      agentNickname: 'Opus',
    });
    expect(toolEvent?.metadata).toMatchObject({
      kind: 'tool_result',
      toolName: 'connector_posthog__query',
    });
  });

  it('atomically enqueues talk turn with message, run, and outbox events', () => {
    const result = enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'atomic hello',
      messageId: 'msg-atomic-1',
      runId: 'run-atomic-1',
      idempotencyKey: 'idem-atomic-1',
      now: '2024-01-01T00:00:10.000Z',
    });

    expect(result.message.id).toBe('msg-atomic-1');
    expect(result.message.created_at).toBe('2024-01-01T00:00:10.000Z');
    expect(result.run.id).toBe('run-atomic-1');
    expect(result.run.status).toBe('queued');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 10 });
    expect(messages.map((message) => message.id)).toContain('msg-atomic-1');

    const run = getTalkRunById('run-atomic-1');
    expect(run?.status).toBe('queued');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 10);
    const messageEvent = events.find(
      (event) => event.event_type === 'message_appended',
    );
    const runEvent = events.find(
      (event) => event.event_type === 'talk_run_queued',
    );

    expect(messageEvent).toBeDefined();
    expect(runEvent).toBeDefined();

    const messagePayload = JSON.parse(messageEvent!.payload) as {
      talkId: string;
      messageId: string;
      runId: string;
    };
    const runPayload = JSON.parse(runEvent!.payload) as {
      talkId: string;
      runId: string;
      triggerMessageId: string;
      status: string;
    };

    expect(messagePayload).toMatchObject({
      talkId: 'talk-1',
      messageId: 'msg-atomic-1',
      runId: null,
    });
    expect(runPayload).toMatchObject({
      talkId: 'talk-1',
      runId: 'run-atomic-1',
      triggerMessageId: 'msg-atomic-1',
      status: 'queued',
    });
  });

  it('rolls back message writes when run insert fails inside atomic enqueue', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'first',
      messageId: 'msg-atomic-2a',
      runId: 'run-atomic-2',
      now: '2024-01-01T00:00:20.000Z',
    });

    expect(() =>
      enqueueTalkTurnAtomic({
        talkId: 'talk-1',
        userId: 'owner-1',
        content: 'second should rollback',
        messageId: 'msg-atomic-2b',
        runId: 'run-atomic-2', // duplicate PK to force failure
        now: '2024-01-01T00:00:21.000Z',
      }),
    ).toThrow();

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    expect(
      messages.some((message) => message.id === 'msg-atomic-2b'),
    ).toBeFalsy();

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some((event) => event.payload.includes('msg-atomic-2b')),
    ).toBeFalsy();
  });

  it('does not create orphan talk messages when a channel enqueue hits an active round', () => {
    resetTalkAgentsToDefault('talk-1', '2024-01-01T00:00:21.500Z');
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:21.600Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:21.700Z',
    });

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'busy run',
      messageId: 'msg-busy-1',
      runId: 'run-busy-1',
      now: '2024-01-01T00:00:22.000Z',
    });
    markTalkRunStatus(
      'run-busy-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:22.100Z',
    );

    const beforeIds = listTalkMessages({ talkId: 'talk-1', limit: 20 }).map(
      (message) => message.id,
    );
    const result = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-busy-1',
      runId: 'run-channel-busy-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'hello from telegram',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:22.200Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-1',
      now: '2024-01-01T00:00:22.300Z',
    });

    expect(result).toEqual({ status: 'talk_busy' });
    const afterIds = listTalkMessages({ talkId: 'talk-1', limit: 20 }).map(
      (message) => message.id,
    );
    expect(afterIds).toEqual(beforeIds);
    expect(getTalkRunById('run-channel-busy-1')).toBeNull();
  });

  it('completes a running run and appends the assistant message', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'run one',
      messageId: 'msg-atomic-3a',
      runId: 'run-atomic-3a',
      now: '2024-01-01T00:00:30.000Z',
    });
    markTalkRunStatus(
      'run-atomic-3a',
      'running',
      null,
      null,
      '2024-01-01T00:00:30.500Z',
    );

    const completion = completeRunAndPromoteNextAtomic({
      runId: 'run-atomic-3a',
      responseMessageId: 'msg-atomic-3r',
      responseContent: 'assistant reply',
      now: '2024-01-01T00:00:32.000Z',
    });

    expect(completion.applied).toBe(true);
    expect(completion.talkId).toBe('talk-1');

    expect(getTalkRunById('run-atomic-3a')?.status).toBe('completed');

    const messages = listTalkMessages({ talkId: 'talk-1', limit: 20 });
    const responseMessage = messages.find(
      (message) => message.id === 'msg-atomic-3r',
    );
    expect(responseMessage?.role).toBe('assistant');
    expect(responseMessage?.run_id).toBe('run-atomic-3a');

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    const completed = events.find(
      (event) =>
        event.event_type === 'talk_run_completed' &&
        event.payload.includes('\"runId\":\"run-atomic-3a\"'),
    );
    expect(completed).toBeDefined();
  });

  it('queues a delivery row when a channel-originated run completes successfully', () => {
    resetTalkAgentsToDefault('talk-1', '2024-01-01T00:00:32.100Z');
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:32.200Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:456',
      displayName: 'Telegram Delivery Chat',
      createdBy: 'owner-1',
      now: '2024-01-01T00:00:32.300Z',
    });

    const enqueueResult = enqueueChannelTurnAtomic({
      talkId: 'talk-1',
      messageId: 'msg-channel-1',
      runId: 'run-channel-1',
      targetAgentId: binding.responder_agent_id!,
      content: 'Need the latest update',
      metadataJson: JSON.stringify({ platform: 'telegram' }),
      externalCreatedAt: '2024-01-01T00:00:32.400Z',
      sourceBindingId: binding.id,
      sourceExternalMessageId: 'tg-msg-99',
      now: '2024-01-01T00:00:32.500Z',
    });
    expect(enqueueResult).toEqual({
      status: 'enqueued',
      messageId: 'msg-channel-1',
      runId: 'run-channel-1',
    });

    markTalkRunStatus(
      'run-channel-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:32.600Z',
    );
    const completion = completeRunAndPromoteNextAtomic({
      runId: 'run-channel-1',
      responseMessageId: 'msg-channel-1-response',
      responseContent: 'Here is the channel reply',
      now: '2024-01-01T00:00:33.000Z',
    });

    expect(completion.applied).toBe(true);
    expect(completion.deliveryQueued).toBe(true);

    const delivery = claimNextChannelDeliveryRow('2024-01-01T00:00:33.100Z');
    expect(delivery).toBeTruthy();
    expect(delivery?.binding_id).toBe(binding.id);
    expect(delivery?.run_id).toBe('run-channel-1');
    expect(delivery?.talk_message_id).toBe('msg-channel-1-response');
    expect(delivery?.status).toBe('sending');
    expect(delivery?.payload_json).toContain('Here is the channel reply');
  });

  it('escapes LIKE wildcards when searching channel targets', () => {
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:33.200Z',
    );
    upsertChannelTarget({
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:percent',
      displayName: '100% Coverage',
      lastSeenAt: '2024-01-01T00:00:33.300Z',
    });
    upsertChannelTarget({
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:plain',
      displayName: 'Regular Chat',
      lastSeenAt: '2024-01-01T00:00:33.400Z',
    });

    const matches = searchChannelTargets({
      connectionId: connection.id,
      query: '%',
      limit: 10,
    });
    expect(matches.map((row) => row.display_name)).toEqual(['100% Coverage']);
  });

  it('enforces first-writer-wins between cancel and fail transitions', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'cancel vs fail',
      messageId: 'msg-atomic-4',
      runId: 'run-atomic-4',
      now: '2024-01-01T00:00:40.000Z',
    });

    const cancelled = cancelTalkRunsAtomic({
      talkId: 'talk-1',
      cancelledBy: 'owner-1',
      now: '2024-01-01T00:00:41.000Z',
    });
    expect(cancelled.cancelledRuns).toBe(1);

    const failed = failRunAndPromoteNextAtomic({
      runId: 'run-atomic-4',
      errorCode: 'execution_failed',
      errorMessage: 'should not override cancellation',
      now: '2024-01-01T00:00:42.000Z',
    });
    expect(failed.applied).toBe(false);

    expect(getTalkRunById('run-atomic-4')?.status).toBe('cancelled');
    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 50);
    expect(
      events.some(
        (event) =>
          event.event_type === 'talk_run_failed' &&
          event.payload.includes('\"runId\":\"run-atomic-4\"'),
      ),
    ).toBe(false);
  });

  it('fails interrupted running runs on startup and leaves queued runs queued', () => {
    createTalkRun({
      id: 'run-atomic-5a',
      talk_id: 'talk-1',
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:50.000Z',
      started_at: '2024-01-01T00:00:50.000Z',
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-atomic-5b',
      talk_id: 'talk-1',
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2024-01-01T00:00:51.000Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    const recovered = failInterruptedRunsOnStartup('2024-01-01T00:00:52.000Z');
    expect(recovered.failedRunIds).toEqual(['run-atomic-5a']);
    expect(recovered.promotedRunIds).toEqual([]);

    expect(getTalkRunById('run-atomic-5a')?.status).toBe('failed');
    expect(getTalkRunById('run-atomic-5a')?.cancel_reason).toBe(
      'interrupted_by_restart',
    );
    expect(getTalkRunById('run-atomic-5b')?.status).toBe('queued');
  });

  it('normalizes talk list pagination consistently', () => {
    expect(normalizeTalkListPage({ limit: 500, offset: -10 })).toEqual({
      limit: 200,
      offset: 0,
    });
    expect(normalizeTalkListPage({ limit: 0, offset: 3.7 })).toEqual({
      limit: 1,
      offset: 3,
    });
    expect(normalizeTalkListPage()).toEqual({
      limit: 50,
      offset: 0,
    });
  });

  it('prunes old idempotency cache records', () => {
    const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000);
    saveIdempotencyCache({
      idempotency_key: 'idem-old',
      user_id: 'owner-1',
      method: 'POST',
      path: '/api/v1/talks/talk-1/chat/cancel',
      request_hash: 'abc',
      status_code: 200,
      response_body: '{}',
      created_at: createdAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });

    const pruned = pruneIdempotencyCache();
    expect(pruned).toBe(1);

    const existing = getIdempotencyCache({
      userId: 'owner-1',
      idempotencyKey: 'idem-old',
      method: 'POST',
      path: '/api/v1/talks/talk-1/chat/cancel',
    });
    expect(existing).toBeUndefined();
  });

  it('maintains one running talk run and queued follow-ups', () => {
    createTalkRun({
      id: 'run-1',
      talk_id: 'talk-1',
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: null,
      cancel_reason: null,
    });
    createTalkRun({
      id: 'run-2',
      talk_id: 'talk-1',
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: new Date().toISOString(),
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    expect(getRunningTalkRun('talk-1')?.id).toBe('run-1');
    expect(getQueuedTalkRuns('talk-1').map((row) => row.id)).toEqual(['run-2']);

    markTalkRunStatus(
      'run-1',
      'completed',
      new Date().toISOString(),
      null,
      new Date().toISOString(),
    );
    expect(getTalkRunById('run-1')?.status).toBe('completed');
  });

  it('persists executor alias/model metadata on talk runs', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'metadata check',
      messageId: 'msg-meta-1',
      runId: 'run-meta-1',
      now: '2024-01-01T00:00:55.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
    });

    const run = getTalkRunById('run-meta-1');
    expect(run?.executor_alias).toBe('Gemini');
    expect(run?.executor_model).toBe('default');
  });

  it('includes executor alias/model in terminal run lifecycle events', () => {
    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'terminal metadata complete',
      messageId: 'msg-meta-term-1',
      runId: 'run-meta-term-1',
      now: '2024-01-01T00:00:56.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-term-1',
      executorAlias: 'Gemini',
      executorModel: 'default',
    });

    markTalkRunStatus(
      'run-meta-term-1',
      'running',
      null,
      null,
      '2024-01-01T00:00:56.500Z',
    );
    const completionApplied = completeRunAndPromoteNextAtomic({
      runId: 'run-meta-term-1',
      responseMessageId: 'msg-meta-term-1r',
      responseContent: 'done',
      now: '2024-01-01T00:00:57.000Z',
    });
    expect(completionApplied.applied).toBe(true);

    enqueueTalkTurnAtomic({
      talkId: 'talk-1',
      userId: 'owner-1',
      content: 'terminal metadata fail',
      messageId: 'msg-meta-term-2',
      runId: 'run-meta-term-2',
      now: '2024-01-01T00:00:58.000Z',
    });

    setTalkRunExecutorProfile({
      runId: 'run-meta-term-2',
      executorAlias: 'Opus4.6',
      executorModel: 'default',
    });
    markTalkRunStatus(
      'run-meta-term-2',
      'running',
      null,
      null,
      '2024-01-01T00:00:58.500Z',
    );

    const failure = failRunAndPromoteNextAtomic({
      runId: 'run-meta-term-2',
      errorCode: 'execution_failed',
      errorMessage: 'boom',
      now: '2024-01-01T00:00:59.000Z',
    });
    expect(failure.applied).toBe(true);

    const events = getOutboxEventsForTopics(['talk:talk-1'], 0, 100);
    const completedEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_completed' &&
        event.payload.includes('"runId":"run-meta-term-1"'),
    );
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.payload).toContain('"executorAlias":"Gemini"');
    expect(completedEvent?.payload).toContain('"executorModel":"default"');

    const failedEvent = events.find(
      (event) =>
        event.event_type === 'talk_run_failed' &&
        event.payload.includes('"runId":"run-meta-term-2"'),
    );
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.payload).toContain('"executorAlias":"Opus4.6"');
    expect(failedEvent?.payload).toContain('"executorModel":"default"');
  });

  it('preserves hot events while pruning old outbox rows', () => {
    appendOutboxEvent({
      topic: 'talk:talk-1',
      eventType: 'keep',
      payload: '{}',
    });
    const deleted = pruneEventOutbox({
      nowMs: Date.now() + 1000,
      retentionHours: 0,
      keepRecentPerTopic: 1,
    });
    expect(deleted).toBe(0);
  });
});
