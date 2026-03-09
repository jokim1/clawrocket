import { randomUUID } from 'crypto';

import { TALK_RUN_MAX_CONCURRENCY, TALK_RUN_POLL_MS } from '../config.js';
import {
  claimQueuedTalkRuns,
  appendOutboxEvent,
  completeRunAndPromoteNextAtomic,
  failInterruptedRunsOnStartup,
  failRunAndPromoteNextAtomic,
  getTalkMessageById,
  getTalkRunById,
  type TalkRunRecord,
} from '../db/index.js';
import { logger } from '../../logger.js';

import {
  TalkExecutorError,
  type TalkExecutionEvent,
  type TalkExecutor,
} from './executor.js';
import { MockTalkExecutor } from './mock-executor.js';

export interface TalkRunWorkerOptions {
  executor?: TalkExecutor;
  pollMs?: number;
  maxConcurrency?: number;
}

export interface TalkRunWorkerControl {
  wake(): void;
  abortTalk(talkId: string): void;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown talk execution failure';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface ActiveRun {
  run: TalkRunRecord;
  controller: AbortController;
}

export class TalkRunWorker implements TalkRunWorkerControl {
  private readonly executor: TalkExecutor;
  private readonly pollMs: number;
  private readonly maxConcurrency: number;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;

  private readonly activeRunsById = new Map<string, ActiveRun>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();

  constructor(options: TalkRunWorkerOptions = {}) {
    this.executor = options.executor || new MockTalkExecutor();
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? TALK_RUN_POLL_MS));
    this.maxConcurrency = Math.max(
      1,
      Math.floor(options.maxConcurrency ?? TALK_RUN_MAX_CONCURRENCY),
    );
  }

  async start(): Promise<void> {
    if (this.running) return;

    const recovery = failInterruptedRunsOnStartup();
    if (
      recovery.failedRunIds.length > 0 ||
      recovery.promotedRunIds.length > 0
    ) {
      logger.warn(
        {
          failedRuns: recovery.failedRunIds.length,
          promotedRuns: recovery.promotedRunIds.length,
        },
        'Recovered interrupted talk runs on startup',
      );
    }

    this.running = true;
    this.loopPromise = this.runLoop();

    if (recovery.promotedRunIds.length > 0) {
      this.wake();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) {
      if (this.loopPromise) await this.loopPromise;
      return;
    }

    this.running = false;
    this.wake();

    for (const active of this.activeRunsById.values()) {
      active.controller.abort('worker_stopping');
    }

    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }

    if (this.activeRunTasks.size > 0) {
      await Promise.allSettled(this.activeRunTasks.values());
    }
  }

  wake(): void {
    const resolver = this.sleepResolver;
    if (!resolver) return;
    this.clearSleepState();
    resolver();
  }

  abortTalk(talkId: string): void {
    for (const active of this.activeRunsById.values()) {
      if (active.run.talk_id !== talkId) continue;
      active.controller.abort(`talk_cancelled:${talkId}`);
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.processCycle();
      } catch (error) {
        logger.error({ err: error }, 'Talk run worker cycle failed');
      }

      await this.waitForNextTick();
    }

    this.clearSleepState();
  }

  private processCycle(): void {
    const availableSlots = this.maxConcurrency - this.activeRunsById.size;
    if (availableSlots <= 0) return;

    const claimedRuns = claimQueuedTalkRuns(availableSlots);
    for (const run of claimedRuns) {
      if (this.activeRunsById.size >= this.maxConcurrency) break;
      this.startRun(run);
    }
  }

  private startRun(run: TalkRunRecord): void {
    const controller = new AbortController();
    this.activeRunsById.set(run.id, { run, controller });

    const task = this.executeRun(run, controller.signal)
      .catch((error) => {
        logger.error(
          {
            err: error,
            talkId: run.talk_id,
            runId: run.id,
          },
          'Talk run execution crashed',
        );
      })
      .finally(() => {
        this.activeRunsById.delete(run.id);
        this.activeRunTasks.delete(run.id);
        this.wake();
      });
    this.activeRunTasks.set(run.id, task);
  }

  private async executeRun(
    run: TalkRunRecord,
    signal: AbortSignal,
  ): Promise<void> {
    if (!run.trigger_message_id) {
      this.failRun(
        run,
        'trigger_message_missing',
        'Run missing trigger message reference',
      );
      return;
    }

    const triggerMessage = getTalkMessageById(run.trigger_message_id);
    if (!triggerMessage) {
      this.failRun(
        run,
        'trigger_message_not_found',
        `Trigger message not found: ${run.trigger_message_id}`,
      );
      return;
    }

    try {
      const output = await this.executor.execute(
        {
          runId: run.id,
          talkId: run.talk_id,
          requestedBy: run.requested_by,
          triggerMessageId: triggerMessage.id,
          triggerContent: triggerMessage.content,
          targetAgentId: run.target_agent_id,
        },
        signal,
        (event) => this.emitExecutionEvent(event),
      );

      const completed = completeRunAndPromoteNextAtomic({
        runId: run.id,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: output.content,
        responseMetadataJson: output.metadataJson,
        agentId: output.agentId,
        agentNickname: output.agentNickname,
        responseSequenceInRun: output.responseSequenceInRun,
      });
      if (!completed.applied) {
        logger.debug(
          { runId: run.id, talkId: run.talk_id },
          'Run completion skipped due to non-running status',
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (!this.running) return;
        if (this.isCancelled(run.id)) return;
        this.failRun(run, 'execution_aborted', errorMessage(error));
        return;
      }

      this.failRun(
        run,
        error instanceof TalkExecutorError ? error.code : 'execution_failed',
        errorMessage(error),
      );
    }
  }

  private emitExecutionEvent(event: TalkExecutionEvent): void {
    appendOutboxEvent({
      topic: `talk:${event.talkId}`,
      eventType: event.type,
      payload: JSON.stringify(event),
    });
  }

  private failRun(
    run: TalkRunRecord,
    errorCode: string,
    errorMessageText: string,
  ): void {
    const result = failRunAndPromoteNextAtomic({
      runId: run.id,
      errorCode,
      errorMessage: errorMessageText,
    });
    if (!result.applied) {
      logger.debug(
        { runId: run.id, talkId: run.talk_id },
        'Run failure skipped due to non-running status',
      );
    }
  }

  private isCancelled(runId: string): boolean {
    return getTalkRunById(runId)?.status === 'cancelled';
  }

  private waitForNextTick(): Promise<void> {
    if (!this.running) return Promise.resolve();

    return new Promise((resolve) => {
      this.sleepResolver = resolve;
      this.sleepTimer = setTimeout(() => {
        this.clearSleepState();
        resolve();
      }, this.pollMs);
    });
  }

  private clearSleepState(): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolver = null;
  }
}
