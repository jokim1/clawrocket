import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalkRun,
  createTalkThread,
  upsertTalk,
  upsertTalkStateEntry,
  upsertUser,
} from './index.js';

const TALK_ID = 'talk-state';

describe('context-accessors state', () => {
  let threadId = '';

  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'State Test Talk',
    });
    threadId = createTalkThread({ talkId: TALK_ID, title: 'Default' }).id;
  });

  function insertRun(runId: string) {
    createTalkRun({
      id: runId,
      talk_id: TALK_ID,
      thread_id: threadId,
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      response_group_id: null,
      sequence_index: null,
      executor_alias: 'direct_http',
      executor_model: 'claude-sonnet-4-6',
      source_binding_id: null,
      source_external_message_id: null,
      source_thread_key: null,
      created_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      ended_at: new Date().toISOString(),
      cancel_reason: null,
    });
  }

  it('creates a new entry when expectedVersion is 0', () => {
    insertRun('run-1');
    const result = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected successful state write');
    }
    expect(result.entry.key).toBe('summary');
    expect(result.entry.value).toEqual({ mood: 'bullish' });
    expect(result.entry.version).toBe(1);
    expect(result.entry.updatedByUserId).toBe('owner-1');
    expect(result.entry.updatedByRunId).toBe('run-1');
  });

  it('updates an existing entry when the version matches', () => {
    insertRun('run-1');
    const created = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });
    if (!created.ok) {
      throw new Error('Expected successful state write');
    }

    insertRun('run-2');
    const updated = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'neutral' },
      expectedVersion: created.entry.version,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-2',
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) {
      throw new Error('Expected successful state update');
    }
    expect(updated.entry.value).toEqual({ mood: 'neutral' });
    expect(updated.entry.version).toBe(2);
    expect(updated.entry.updatedByRunId).toBe('run-2');
  });

  it('returns the current stored entry on version conflict', () => {
    insertRun('run-1');
    const created = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bullish' },
      expectedVersion: 0,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-1',
    });
    if (!created.ok) {
      throw new Error('Expected successful state write');
    }

    insertRun('run-2');
    const updated = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'neutral' },
      expectedVersion: created.entry.version,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-2',
    });
    if (!updated.ok) {
      throw new Error('Expected successful state update');
    }

    insertRun('run-3');
    const conflict = upsertTalkStateEntry({
      talkId: TALK_ID,
      key: 'summary',
      value: { mood: 'bearish' },
      expectedVersion: 1,
      updatedByUserId: 'owner-1',
      updatedByRunId: 'run-3',
    });

    expect(conflict.ok).toBe(false);
    if (conflict.ok) {
      throw new Error('Expected version conflict');
    }
    expect(conflict.current.value).toEqual({ mood: 'neutral' });
    expect(conflict.current.version).toBe(2);
    expect(conflict.current.updatedByRunId).toBe('run-2');
  });

  it('rejects updating a missing key with a nonzero expectedVersion', () => {
    expect(() =>
      upsertTalkStateEntry({
        talkId: TALK_ID,
        key: 'missing',
        value: { note: 'nope' },
        expectedVersion: 1,
        updatedByUserId: 'owner-1',
        updatedByRunId: 'run-1',
      }),
    ).toThrow(/expectedVersion 0/i);
  });
});
