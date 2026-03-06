import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalk,
  createTalkRun,
  getTalkExecutorSession,
  getTalkRunById,
  upsertTalkExecutorSession,
  upsertTalkLlmPolicy,
  upsertUser,
} from '../db/index.js';

import { TalkExecutorError } from './executor.js';
import {
  RealTalkExecutor,
  type RealTalkExecutorOptions,
} from './real-executor.js';
import {
  computeSessionCompatKey,
  EXECUTOR_COMPATIBILITY_ALIAS_MODEL_SEEDS,
} from './executor-settings.js';

function createRunningRun(runId: string, talkId = 'talk-1'): void {
  createTalkRun({
    id: runId,
    talk_id: talkId,
    requested_by: 'owner-1',
    status: 'running',
    trigger_message_id: null,
    idempotency_key: null,
    executor_alias: null,
    executor_model: null,
    created_at: '2024-01-01T00:00:00.000Z',
    started_at: '2024-01-01T00:00:00.000Z',
    ended_at: null,
    cancel_reason: null,
  });
}

describe('RealTalkExecutor', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    createTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Executor Test Talk',
    });
  });

  it('uses default alias when no policy exists and persists session metadata', async () => {
    createRunningRun('run-1');

    const runContainer: NonNullable<
      RealTalkExecutorOptions['runContainer']
    > = async (_group, input, onProcess, onOutput) => {
      onProcess?.({ killed: false, kill: () => true } as any, 'container-1');
      await onOutput?.({
        status: 'success',
        result: 'chunk one',
        newSessionId: 'session-1',
      });
      await onOutput?.({
        status: 'success',
        result: 'chunk two',
        newSessionId: 'session-1',
      });
      return { status: 'success', result: null, newSessionId: 'session-1' };
    };

    const executor = new RealTalkExecutor({
      aliasModelMap: { Mock: 'default' },
      defaultAlias: 'Mock',
      runContainer,
    });

    const output = await executor.execute(
      {
        runId: 'run-1',
        talkId: 'talk-1',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-trigger-1',
        triggerContent: 'hello world',
      },
      new AbortController().signal,
    );

    expect(output.content).toBe('chunk onechunk two');
    const run = getTalkRunById('run-1');
    expect(run?.executor_alias).toBe('Mock');
    expect(run?.executor_model).toBe('default');
    const session = getTalkExecutorSession('talk-1');
    expect(session?.session_id).toBe('session-1');
    expect(session?.executor_alias).toBe('Mock');
    expect(session?.executor_model).toBe('default');
    expect(session?.session_compat_key).toBe(
      computeSessionCompatKey('Mock', 'default'),
    );
  });

  it('uses first policy alias only and maps compatibility aliases', async () => {
    createRunningRun('run-2');
    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini","Opus4.6"]}',
    });

    const captured: Array<{ model?: string; toolProfile?: string }> = [];
    const runContainer: NonNullable<
      RealTalkExecutorOptions['runContainer']
    > = async (_group, input, onProcess) => {
      captured.push({ model: input.model, toolProfile: input.toolProfile });
      onProcess?.({ killed: false, kill: () => true } as any, 'container-2');
      return { status: 'success', result: null, newSessionId: 'session-2' };
    };

    const executor = new RealTalkExecutor({
      aliasModelMap: {
        Mock: 'default',
        Gemini: 'default',
        'Opus4.6': 'default',
      },
      defaultAlias: 'Mock',
      runContainer,
    });

    await executor.execute(
      {
        runId: 'run-2',
        talkId: 'talk-1',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-trigger-1',
        triggerContent: 'hello again',
      },
      new AbortController().signal,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].model).toBe('default');
    expect(captured[0].toolProfile).toBe('web_talk');
    const run = getTalkRunById('run-2');
    expect(run?.executor_alias).toBe('Gemini');
  });

  it('exposes compatibility seed aliases in default map', () => {
    const aliasMap = EXECUTOR_COMPATIBILITY_ALIAS_MODEL_SEEDS;
    expect(aliasMap.Mock).toBe('default');
    expect(aliasMap.Gemini).toBe('default');
    expect(aliasMap['Opus4.6']).toBe('default');
    expect(aliasMap.Haiku).toBe('default');
    expect(aliasMap['GPT-4o']).toBe('default');
    expect(aliasMap.Opus).toBe('default');
  });

  it('fails with explicit code when alias is unmapped', async () => {
    createRunningRun('run-3');
    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["CustomAlias"]}',
    });

    const executor = new RealTalkExecutor({
      aliasModelMap: { Mock: 'default' },
      defaultAlias: 'Mock',
      runContainer: async () => {
        throw new Error('should not be called');
      },
    });

    await expect(
      executor.execute(
        {
          runId: 'run-3',
          talkId: 'talk-1',
          requestedBy: 'owner-1',
          triggerMessageId: 'msg-trigger-1',
          triggerContent: 'fail me',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'executor_alias_unmapped' });
  });

  it('re-evaluates talk policy before reusing a stored session', async () => {
    createRunningRun('run-4');
    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini"]}',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-existing',
      executorAlias: 'Opus4.6',
      executorModel: 'model-opus',
      sessionCompatKey: computeSessionCompatKey('Opus4.6', 'model-opus'),
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const captured: Array<{ model?: string; sessionId?: string }> = [];
    const runContainer: NonNullable<
      RealTalkExecutorOptions['runContainer']
    > = async (_group, input) => {
      captured.push({ model: input.model, sessionId: input.sessionId });
      return {
        status: 'success',
        result: null,
        newSessionId: 'session-existing',
      };
    };

    const executor = new RealTalkExecutor({
      aliasModelMap: {
        Mock: 'default',
        Gemini: 'model-gemini',
        'Opus4.6': 'model-opus',
      },
      defaultAlias: 'Mock',
      runContainer,
    });

    await executor.execute(
      {
        runId: 'run-4',
        talkId: 'talk-1',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-trigger-1',
        triggerContent: 'session path',
      },
      new AbortController().signal,
    );

    expect(captured).toEqual([
      {
        model: 'model-gemini',
        sessionId: undefined,
      },
    ]);
    const run = getTalkRunById('run-4');
    expect(run?.executor_alias).toBe('Gemini');
    expect(run?.executor_model).toBe('model-gemini');
  });

  it('retries once after invalid session and then succeeds with re-resolved alias', async () => {
    createRunningRun('run-5');
    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini"]}',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-stale',
      executorAlias: 'Gemini',
      executorModel: 'model-gemini',
      sessionCompatKey: computeSessionCompatKey('Gemini', 'model-gemini'),
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    const calls: Array<{ model?: string; sessionId?: string }> = [];
    const runContainer: NonNullable<
      RealTalkExecutorOptions['runContainer']
    > = async (_group, input) => {
      calls.push({ model: input.model, sessionId: input.sessionId });
      if (calls.length === 1) {
        return {
          status: 'error',
          result: null,
          error: 'resume session not found',
        };
      }
      return { status: 'success', result: 'ok', newSessionId: 'session-new' };
    };

    const executor = new RealTalkExecutor({
      aliasModelMap: {
        Mock: 'default',
        Gemini: 'model-gemini',
        'Opus4.6': 'model-opus',
      },
      defaultAlias: 'Mock',
      runContainer,
    });

    const output = await executor.execute(
      {
        runId: 'run-5',
        talkId: 'talk-1',
        requestedBy: 'owner-1',
        triggerMessageId: 'msg-trigger-1',
        triggerContent: 'retry path',
      },
      new AbortController().signal,
    );

    expect(output.content).toBe('ok');
    expect(calls).toEqual([
      { model: 'model-gemini', sessionId: 'session-stale' },
      { model: 'model-gemini', sessionId: undefined },
    ]);
    const session = getTalkExecutorSession('talk-1');
    expect(session?.session_id).toBe('session-new');
    expect(session?.executor_alias).toBe('Gemini');
    expect(session?.executor_model).toBe('model-gemini');
  });

  it('fails when retry after session reset still errors', async () => {
    createRunningRun('run-6');
    upsertTalkLlmPolicy({
      talkId: 'talk-1',
      llmPolicy: '{"agents":["Gemini"]}',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-1',
      sessionId: 'session-stale',
      executorAlias: 'Gemini',
      executorModel: 'model-gemini',
      sessionCompatKey: computeSessionCompatKey('Gemini', 'model-gemini'),
      updatedAt: '2024-01-01T00:00:00.000Z',
    });

    let calls = 0;
    const runContainer: NonNullable<
      RealTalkExecutorOptions['runContainer']
    > = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 'error',
          result: null,
          error: 'invalid session',
        };
      }
      return {
        status: 'error',
        result: null,
        error: 'backend unavailable',
      };
    };

    const executor = new RealTalkExecutor({
      aliasModelMap: {
        Mock: 'default',
        Gemini: 'model-gemini',
        'Opus4.6': 'model-opus',
      },
      defaultAlias: 'Mock',
      runContainer,
    });

    await expect(
      executor.execute(
        {
          runId: 'run-6',
          talkId: 'talk-1',
          requestedBy: 'owner-1',
          triggerMessageId: 'msg-trigger-1',
          triggerContent: 'retry fail',
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(TalkExecutorError);
    expect(calls).toBe(2);
  });
});
