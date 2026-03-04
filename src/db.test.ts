import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  appendOutboxEvent,
  canUserEditTalk,
  createTalk,
  createTalkMessage,
  consumeOAuthStateByHash,
  createTask,
  createOAuthState,
  deleteTask,
  getTalkById,
  getTalkForUser,
  getIdempotencyCache,
  getOutboxEventsForTopics,
  getQueuedTalkRuns,
  getRunningTalkRun,
  getAllChats,
  getAllRegisteredGroups,
  listTalkMessages,
  listTalksForUser,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  getTalkRunById,
  getUserById,
  isDatabaseHealthy,
  markTalkRunStatus,
  normalizeTalkListPage,
  pruneEventOutbox,
  pruneIdempotencyCache,
  saveIdempotencyCache,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
  createTalkRun,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
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
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const first = consumeOAuthStateByHash('state-hash-1');
    expect(first?.id).toBe('oauth-1');
    expect(first?.used_at).toBeTruthy();

    const second = consumeOAuthStateByHash('state-hash-1');
    expect(second).toBeUndefined();
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
      idempotency_key: null,
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
      idempotency_key: null,
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
