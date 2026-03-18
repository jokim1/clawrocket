import fs from 'fs';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runContainerAgentMock = vi.hoisted(() => vi.fn());

vi.mock('../../container-runner.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../container-runner.js')
  >('../../container-runner.js');
  return {
    ...actual,
    runContainerAgent: runContainerAgentMock,
  };
});

import { executeContainerAgentTurn } from './container-turn-executor.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { _initTestDatabase, upsertTalk, upsertUser } from '../db/index.js';

describe('container-turn-executor', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Container Test Talk',
    });
    runContainerAgentMock.mockReset();
    runContainerAgentMock.mockResolvedValue({
      status: 'success',
      result: 'Container response',
    });
  });

  it('routes Talk/Main turns through the web runtime target', async () => {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    const controller = new AbortController();
    const agent: RegisteredAgentRecord = {
      id: 'agent.main',
      name: 'Main Agent',
      provider_id: 'provider.anthropic',
      model_id: 'claude-opus-4-6',
      tool_permissions_json: JSON.stringify({ shell: true }),
      persona_role: 'assistant',
      system_prompt: 'You are helpful.',
      enabled: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const result = await executeContainerAgentTurn({
      runId: 'run-1',
      userId: 'owner-1',
      agent,
      talkId: 'talk-1',
      promptLabel: 'talk',
      userMessage: 'hello',
      signal: controller.signal,
      allowedTools: ['Bash'],
      context: {
        systemPrompt: 'System prompt',
        history: [],
      },
      modelContextWindow: 200_000,
      containerCredential: {
        authMode: 'api_key',
        secrets: {
          ANTHROPIC_API_KEY: 'sk-ant-test',
        },
      },
      threadId: 'thread-1',
    });

    expect(result.content).toBe('Container response');
    expect(runContainerAgentMock).toHaveBeenCalledTimes(1);

    const [target, input] = runContainerAgentMock.mock.calls[0]!;
    expect(target).toMatchObject({
      kind: 'web_runtime',
      folder: 'web-executor',
      jid: 'internal:web-executor',
      name: 'Web Executor',
    });
    expect(input).toMatchObject({
      toolProfile: 'talk_main',
      groupFolder: 'web-executor',
      chatJid: 'internal:web-executor',
      isMain: true,
      enableWebTalkOutputTools: true,
    });
    expect(typeof input.ephemeralContextDir).toBe('string');
    expect(fs.existsSync(input.ephemeralContextDir)).toBe(false);
  });
});
