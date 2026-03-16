/**
 * MainRunWorker — polling worker that claims and executes Main channel runs.
 *
 * Mirrors the TalkRunWorker pattern but simplified:
 * - No promotion (Main has no run queue per-thread beyond one-active guard)
 * - No channel delivery
 * - Events publish to `user:${requestedBy}` (not `talk:${talkId}`)
 * - Response content sanitized via TalkResponseStreamSanitizer + stripInternalTalkResponseText
 */

import { randomUUID } from 'crypto';

import { TALK_RUN_MAX_CONCURRENCY, TALK_RUN_POLL_MS } from '../config.js';
import {
  appendOutboxEvent,
  claimQueuedMainRuns,
  completeMainRunAtomic,
  failInterruptedMainRunsOnStartup,
  failMainRunAtomic,
  getTalkMessageById,
  getTalkRunById,
  type TalkRunRecord,
} from '../db/index.js';
import { logger } from '../../logger.js';
import {
  createTalkResponseStreamSanitizer,
  stripInternalTalkResponseText,
} from '../talks/internal-tags.js';
import {
  executeMainChannel,
  type MainExecutionEvent,
} from './main-executor.js';

// ============================================================================
// Types
// ============================================================================

export type MainExecutorFn = typeof executeMainChannel;

export interface MainRunWorkerOptions {
  pollMs?: number;
  maxConcurrency?: number;
  /** Override executor for testing. Defaults to executeMainChannel. */
  executor?: MainExecutorFn;
}

export interface MainRunWorkerControl {
  wake(): void;
}

// ============================================================================
// Worker
// ============================================================================

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unknown main execution failure';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface ActiveRun {
  run: TalkRunRecord;
  controller: AbortController;
}

export class MainRunWorker implements MainRunWorkerControl {
  private readonly pollMs: number;
  private readonly maxConcurrency: number;
  private readonly executor: MainExecutorFn;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolver: (() => void) | null = null;

  private readonly activeRunsById = new Map<string, ActiveRun>();
  private readonly activeRunTasks = new Map<string, Promise<void>>();

  constructor(options: MainRunWorkerOptions = {}) {
    this.pollMs = Math.max(10, Math.floor(options.pollMs ?? TALK_RUN_POLL_MS));
    this.maxConcurrency = Math.max(
      1,
      Math.floor(options.maxConcurrency ?? TALK_RUN_MAX_CONCURRENCY),
    );
    this.executor = options.executor ?? executeMainChannel;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const recovery = failInterruptedMainRunsOnStartup();
    if (recovery.failedRunIds.length > 0) {
      logger.warn(
        { failedRuns: recovery.failedRunIds.length },
        'Recovered interrupted main runs on startup',
      );
    }

    this.running = true;
    this.loopPromise = this.runLoop();
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

  // --------------------------------------------------------------------------
  // Loop
  // --------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        this.processCycle();
      } catch (error) {
        logger.error({ err: error }, 'Main run worker cycle failed');
      }

      await this.waitForNextTick();
    }

    this.clearSleepState();
  }

  private processCycle(): void {
    const availableSlots = this.maxConcurrency - this.activeRunsById.size;
    if (availableSlots <= 0) return;

    const claimedRuns = claimQueuedMainRuns(availableSlots);
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
          { err: error, runId: run.id, threadId: run.thread_id },
          'Main run execution crashed',
        );
      })
      .finally(() => {
        this.activeRunsById.delete(run.id);
        this.activeRunTasks.delete(run.id);
        this.wake();
      });
    this.activeRunTasks.set(run.id, task);
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

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

    const sanitizer = createTalkResponseStreamSanitizer();

    try {
      const output = await this.executor(
        {
          runId: run.id,
          threadId: run.thread_id,
          requestedBy: run.requested_by,
          triggerMessageId: triggerMessage.id,
          triggerContent: triggerMessage.content,
          targetAgentId: run.target_agent_id,
        },
        signal,
        (event: MainExecutionEvent) => {
          // Sanitize streaming deltas before publishing
          if (event.type === 'main_response_delta') {
            const cleaned = sanitizer.push(event.text);
            if (!cleaned) return;
            event = { ...event, text: cleaned };
          }
          appendOutboxEvent({
            topic: `user:${run.requested_by}`,
            eventType: event.type,
            payload: JSON.stringify(event),
          });
        },
      );

      // Sanitize stored content (strip internal tags)
      const sanitizedContent = stripInternalTalkResponseText(output.content);

      // Atomic: run status + assistant message + llm_attempt + terminal event
      const completed = completeMainRunAtomic({
        runId: run.id,
        threadId: run.thread_id,
        requestedBy: run.requested_by,
        responseMessageId: `msg_${randomUUID()}`,
        responseContent: sanitizedContent,
        agentId: output.agentId,
        providerId: output.providerId,
        modelId: output.modelId,
        latencyMs: output.latencyMs,
        usage: output.usage,
      });

      if (!completed.applied) {
        logger.debug(
          { runId: run.id, threadId: run.thread_id },
          'Main run completion skipped due to non-running status',
        );
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (!this.running) return;
        if (this.isCancelled(run.id)) return;
        this.failRun(run, 'execution_aborted', errorMessage(error));
        return;
      }

      this.failRun(run, 'execution_failed', errorMessage(error));
    }
  }

  private failRun(
    run: TalkRunRecord,
    errorCode: string,
    errorMessageText: string,
  ): void {
    const result = failMainRunAtomic({
      runId: run.id,
      threadId: run.thread_id,
      requestedBy: run.requested_by,
      errorCode,
      errorMessage: errorMessageText,
    });
    if (!result.applied) {
      logger.debug(
        { runId: run.id, threadId: run.thread_id },
        'Main run failure skipped due to non-running status',
      );
    }
  }

  private isCancelled(runId: string): boolean {
    return getTalkRunById(runId)?.status === 'cancelled';
  }

  // --------------------------------------------------------------------------
  // Sleep / Wake
  // --------------------------------------------------------------------------

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
