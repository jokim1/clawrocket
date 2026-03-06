import type { ChildProcess } from 'child_process';

import {
  runContainerAgent,
  type ContainerOutput,
} from '../../container-runner.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import {
  deleteTalkExecutorSession,
  getTalkExecutorSession,
  getTalkLlmPolicyByTalkId,
  setTalkRunExecutorProfile,
  upsertTalkExecutorSession,
} from '../db/index.js';
import { TALK_EXECUTOR_WEB_GROUP_FOLDER } from '../config.js';

import {
  TalkExecutor,
  TalkExecutorError,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';
import { computeSessionCompatKey } from './executor-settings.js';
import { parsePolicyAgentsForExecution } from './policy.js';

const INVALID_SESSION_ERROR_HINTS = [
  'invalid session',
  'session not found',
  'resume session not found',
  'unknown session',
  'session expired',
  'invalid resume',
];

function abortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === 'string' ? reason : 'Talk execution aborted',
  );
  err.name = 'AbortError';
  return err;
}

function isSessionInvalidError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes('session') && !normalized.includes('resume')) {
    return false;
  }
  return INVALID_SESSION_ERROR_HINTS.some((hint) => normalized.includes(hint));
}

interface ExecutionProfile {
  alias: string;
  model: string;
  sessionId?: string;
}

export interface RealTalkExecutorOptions {
  aliasModelMap: Record<string, string>;
  defaultAlias: string;
  groupFolder?: string;
  runContainer?: typeof runContainerAgent;
}

export class RealTalkExecutor implements TalkExecutor {
  private readonly aliasModelMap: Record<string, string>;
  private readonly defaultAlias: string;
  private readonly groupFolder: string;
  private readonly runContainer: typeof runContainerAgent;

  constructor(options: RealTalkExecutorOptions) {
    this.aliasModelMap = options.aliasModelMap;
    this.defaultAlias = options.defaultAlias;
    this.groupFolder = options.groupFolder || TALK_EXECUTOR_WEB_GROUP_FOLDER;
    this.runContainer = options.runContainer || runContainerAgent;
  }

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput> {
    const candidate = this.resolveExecutionProfile(input.talkId);
    const session = getTalkExecutorSession(input.talkId);
    const fromSession = this.resolveReusableProfile(candidate, session);
    return this.executeWithRetry(
      input,
      signal,
      fromSession,
      Boolean(fromSession.sessionId),
    );
  }

  private resolveExecutionProfile(talkId: string): ExecutionProfile {
    const llmPolicy = getTalkLlmPolicyByTalkId(talkId);
    const parsedAliases = parsePolicyAgentsForExecution(llmPolicy);
    const alias = parsedAliases[0] || this.defaultAlias;
    const model = this.aliasModelMap[alias];
    if (!model) {
      throw new TalkExecutorError(
        'executor_alias_unmapped',
        `No model mapping found for talk alias "${alias}"`,
      );
    }

    return { alias, model };
  }

  private resolveReusableProfile(
    candidate: ExecutionProfile,
    session:
      | {
          session_id: string;
          session_compat_key: string;
        }
      | undefined,
  ): ExecutionProfile {
    if (!session) {
      return candidate;
    }

    const expectedCompatKey = computeSessionCompatKey(
      candidate.alias,
      candidate.model,
    );
    if (session.session_compat_key !== expectedCompatKey) {
      return candidate;
    }

    return {
      ...candidate,
      sessionId: session.session_id,
    };
  }

  private async executeWithRetry(
    input: TalkExecutorInput,
    signal: AbortSignal,
    profile: ExecutionProfile,
    sessionExists: boolean,
  ): Promise<TalkExecutorOutput> {
    try {
      return await this.executeOnce(input, signal, profile);
    } catch (error) {
      if (!sessionExists) throw error;
      if (
        !(error instanceof TalkExecutorError) ||
        error.code !== 'executor_container_error' ||
        !isSessionInvalidError(error.sourceMessage)
      ) {
        throw error;
      }

      logger.warn(
        {
          talkId: input.talkId,
          runId: input.runId,
          alias: profile.alias,
          model: profile.model,
        },
        'Clearing invalid talk executor session and retrying once',
      );

      deleteTalkExecutorSession(input.talkId);
      const retryProfile = this.resolveExecutionProfile(input.talkId);
      return this.executeOnce(input, signal, retryProfile);
    }
  }

  private async executeOnce(
    input: TalkExecutorInput,
    signal: AbortSignal,
    profile: ExecutionProfile,
  ): Promise<TalkExecutorOutput> {
    setTalkRunExecutorProfile({
      runId: input.runId,
      executorAlias: profile.alias,
      executorModel: profile.model,
    });

    const output = await this.executeContainer(input, signal, profile);

    if (output.sessionId) {
      upsertTalkExecutorSession({
        talkId: input.talkId,
        sessionId: output.sessionId,
        executorAlias: profile.alias,
        executorModel: profile.model,
        sessionCompatKey: computeSessionCompatKey(profile.alias, profile.model),
      });
    }

    return {
      content: output.content.trim() || 'No response generated.',
    };
  }

  private async executeContainer(
    input: TalkExecutorInput,
    signal: AbortSignal,
    profile: ExecutionProfile,
  ): Promise<{ content: string; sessionId?: string }> {
    if (signal.aborted) {
      throw abortError(signal.reason);
    }

    const group: RegisteredGroup = {
      name: 'Web Talk Executor',
      folder: this.groupFolder,
      trigger: '@web',
      added_at: '1970-01-01T00:00:00.000Z',
      requiresTrigger: false,
      isMain: false,
    };

    const chunks: string[] = [];
    let lastSessionId = profile.sessionId;
    let processRef: ChildProcess | null = null;
    const onAbort = () => {
      if (processRef && !processRef.killed) {
        processRef.kill('SIGTERM');
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await this.runContainer(
        group,
        {
          prompt: input.triggerContent,
          sessionId: profile.sessionId,
          model: profile.model,
          toolProfile: 'web_talk',
          groupFolder: this.groupFolder,
          chatJid: `talk:${input.talkId}`,
          isMain: false,
          assistantName: 'ClawRocket',
        },
        (proc) => {
          processRef = proc;
          if (signal.aborted && !proc.killed) {
            proc.kill('SIGTERM');
          }
        },
        async (streamOutput: ContainerOutput) => {
          if (streamOutput.newSessionId) {
            lastSessionId = streamOutput.newSessionId;
          }
          if (streamOutput.result) {
            chunks.push(streamOutput.result);
          }
        },
      );

      if (signal.aborted) {
        throw abortError(signal.reason);
      }

      if (result.newSessionId) {
        lastSessionId = result.newSessionId;
      }

      if (result.status === 'error') {
        const sourceMessage =
          result.error || 'Unknown container execution error';
        throw new TalkExecutorError(
          'executor_container_error',
          'Container execution failed',
          { sourceMessage },
        );
      }

      const aggregatedContent = chunks.join('').trim();

      return {
        content: aggregatedContent || result.result || '',
        sessionId: lastSessionId,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
