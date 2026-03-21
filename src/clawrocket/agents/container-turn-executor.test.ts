import fs from 'fs';
import path from 'path';
import type { ChildProcess } from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const runContainerAgentMock = vi.hoisted(() => vi.fn());
const ensureBrowserBridgeServerMock = vi.hoisted(() => vi.fn());
const registerBrowserBridgeRunAbortMock = vi.hoisted(() => vi.fn());
const unregisterBrowserBridgeRunAbortMock = vi.hoisted(() => vi.fn());

vi.mock('../../container-runner.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../container-runner.js')
  >('../../container-runner.js');
  return {
    ...actual,
    runContainerAgent: runContainerAgentMock,
  };
});

vi.mock('../browser/bridge.js', async () => {
  const actual = await vi.importActual<typeof import('../browser/bridge.js')>(
    '../browser/bridge.js',
  );
  return {
    ...actual,
    ensureBrowserBridgeServer: ensureBrowserBridgeServerMock,
    registerBrowserBridgeRunAbort: registerBrowserBridgeRunAbortMock,
    unregisterBrowserBridgeRunAbort: unregisterBrowserBridgeRunAbortMock,
  };
});

import { executeContainerAgentTurn } from './container-turn-executor.js';
import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import {
  _initTestDatabase,
  createTalkRun,
  pauseRunForBrowserBlock,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { BrowserRunPausedError } from '../browser/run-paused-error.js';

function createRun(runId: string): void {
  const now = new Date().toISOString();
  createTalkRun({
    id: runId,
    talk_id: 'talk-1',
    thread_id: 'thread-1',
    requested_by: 'owner-1',
    status: 'running',
    trigger_message_id: null,
    target_agent_id: null,
    idempotency_key: null,
    response_group_id: null,
    sequence_index: null,
    executor_alias: null,
    executor_model: null,
    source_binding_id: null,
    source_external_message_id: null,
    source_thread_key: null,
    created_at: now,
    started_at: now,
    ended_at: null,
    cancel_reason: null,
  });
}

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
    ensureBrowserBridgeServerMock.mockReset();
    ensureBrowserBridgeServerMock.mockResolvedValue('/tmp/browser.sock');
    registerBrowserBridgeRunAbortMock.mockReset();
    unregisterBrowserBridgeRunAbortMock.mockReset();
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
        credentialSource: 'env',
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

  it('does not emit Main HISTORY.md guidance when running a Main turn', async () => {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    const controller = new AbortController();
    const agent: RegisteredAgentRecord = {
      id: 'agent.main',
      name: 'Main Agent',
      provider_id: 'provider.anthropic',
      model_id: 'claude-opus-4-6',
      tool_permissions_json: JSON.stringify({ shell: true }),
      persona_role: 'assistant',
      system_prompt: 'Follow the repository instructions.',
      enabled: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    runContainerAgentMock.mockImplementation(async (_target, input) => {
      const claudeMdPath = path.join(input.ephemeralContextDir, 'CLAUDE.md');
      const historyPath = path.join(input.ephemeralContextDir, 'HISTORY.md');
      expect(fs.existsSync(claudeMdPath)).toBe(true);
      expect(fs.existsSync(historyPath)).toBe(false);

      const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(claudeMd).toContain(
        'thread memory is already included inline in the prompt payload',
      );
      expect(claudeMd).not.toContain('Use `HISTORY.md`');

      return {
        status: 'success',
        result: 'Main container response',
      };
    });

    const result = await executeContainerAgentTurn({
      runId: 'run-main-1',
      userId: 'owner-1',
      agent,
      promptLabel: 'main',
      userMessage: '## Current User Message\n\nhello',
      signal: controller.signal,
      allowedTools: ['Bash'],
      context: {
        systemPrompt: 'Stable behavior instructions.',
        history: [
          {
            role: 'user',
            content: 'Prior conversation that should stay inline.',
          },
        ],
      },
      modelContextWindow: 200_000,
      containerCredential: {
        authMode: 'api_key',
        credentialSource: 'env',
        secrets: {
          ANTHROPIC_API_KEY: 'sk-ant-test',
        },
      },
      threadId: 'thread-main-1',
    });

    expect(result.content).toBe('Main container response');
  });

  it('treats a paused browser run as BrowserRunPausedError even if the container exits with an error', async () => {
    fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
    createRun('run-paused');
    const controller = new AbortController();
    const agent: RegisteredAgentRecord = {
      id: 'agent.main',
      name: 'Main Agent',
      provider_id: 'provider.anthropic',
      model_id: 'claude-opus-4-6',
      tool_permissions_json: JSON.stringify({ browser: true, shell: true }),
      persona_role: 'assistant',
      system_prompt: 'You are helpful.',
      enabled: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    runContainerAgentMock.mockImplementation(async (_target, _input, onProcess) => {
      onProcess({ kill: vi.fn() } as unknown as ChildProcess, 'browser-container');
      pauseRunForBrowserBlock({
        runId: 'run-paused',
        browserBlock: {
          kind: 'auth_required',
          sessionId: 'bs_linkedin',
          siteKey: 'linkedin',
          accountLabel: null,
          url: 'https://www.linkedin.com/checkpoint/challenge',
          title: 'LinkedIn Login',
          message: 'This site requires interactive authentication.',
          riskReason: null,
          setupCommand:
            "npx tsx src/clawrocket/browser/setup.ts --site 'linkedin'",
          artifacts: [],
          confirmationId: null,
          pendingToolCall: {
            toolName: 'browser_open',
            args: {
              siteKey: 'linkedin',
              url: 'https://www.linkedin.com/messaging/',
            },
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return {
        status: 'error',
        result: null,
        error: 'Container exited with code 137',
      };
    });

    await expect(
      executeContainerAgentTurn({
        runId: 'run-paused',
        userId: 'owner-1',
        agent,
        talkId: 'talk-1',
        promptLabel: 'talk',
        userMessage: 'check linkedin',
        signal: controller.signal,
        allowedTools: ['mcp__nanoclaw__browser_open', 'Bash'],
        context: {
          systemPrompt: 'System prompt',
          history: [],
        },
        modelContextWindow: 200_000,
        containerCredential: {
          authMode: 'subscription',
          credentialSource: 'oauth_token',
          secrets: {
            CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
          },
        },
        threadId: 'thread-1',
        enableBrowserTools: true,
      }),
    ).rejects.toBeInstanceOf(BrowserRunPausedError);

    expect(ensureBrowserBridgeServerMock).toHaveBeenCalledTimes(1);
    expect(registerBrowserBridgeRunAbortMock).toHaveBeenCalledWith(
      'run-paused',
      expect.any(Function),
    );
    expect(unregisterBrowserBridgeRunAbortMock).toHaveBeenCalledWith(
      'run-paused',
    );
  });
});
