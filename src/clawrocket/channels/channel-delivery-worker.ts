import {
  claimNextChannelDeliveryRow,
  getChannelDeliveryBindingState,
  markChannelDeliveryRetryOrDeadLetter,
  markChannelDeliverySent,
  resetChannelDeliverySendingOnStartup,
} from '../db/index.js';
import { logger } from '../../logger.js';
import { WakeablePollLoop } from './wakeable-poll-loop.js';

const RETRY_BACKOFF_MS = [2_000, 10_000, 30_000, 120_000, 600_000] as const;

export interface ChannelDeliveryWorkerOptions {
  sendText: (targetId: string, text: string) => Promise<void>;
  pollMs?: number;
}

export class ChannelDeliveryWorker {
  private readonly pollMs: number;
  private readonly loop: WakeablePollLoop;

  constructor(private readonly options: ChannelDeliveryWorkerOptions) {
    this.pollMs = Math.max(100, Math.floor(options.pollMs ?? 5000));
    this.loop = new WakeablePollLoop({
      label: 'Channel delivery worker',
      pollMs: this.pollMs,
      onCycle: async () => this.processCycle(),
    });
  }

  async start(): Promise<void> {
    resetChannelDeliverySendingOnStartup();
    await this.loop.start();
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }

  wake(): void {
    this.loop.wake();
  }

  private async processCycle(): Promise<boolean> {
    let didWork = false;
    while (this.loop.isRunning()) {
      const row = claimNextChannelDeliveryRow();
      if (!row) break;
      didWork = true;
      await this.processRow(row);
    }
    return didWork;
  }

  private async processRow(row: {
    id: string;
    binding_id: string;
    target_id: string;
    payload_json: string;
    attempt_count: number;
  }): Promise<void> {
    const bindingState = getChannelDeliveryBindingState(row.binding_id);
    if (
      !bindingState ||
      bindingState.active !== 1 ||
      bindingState.connection_enabled !== 1
    ) {
      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter: true,
        reasonCode: 'binding_deactivated',
        reasonDetail: 'Binding is inactive or unavailable for delivery',
      });
      return;
    }

    const payload = JSON.parse(row.payload_json) as { content: string };
    try {
      await this.options.sendText(row.target_id, payload.content);
      markChannelDeliverySent(row.id);
    } catch (error) {
      const backoff =
        RETRY_BACKOFF_MS[
          Math.max(
            0,
            Math.min(RETRY_BACKOFF_MS.length - 1, row.attempt_count - 1),
          )
        ];
      const deadLetter = row.attempt_count >= RETRY_BACKOFF_MS.length;
      markChannelDeliveryRetryOrDeadLetter({
        rowId: row.id,
        deadLetter,
        reasonCode: deadLetter
          ? 'delivery_retries_exhausted'
          : 'delivery_transient_failure',
        reasonDetail:
          error instanceof Error ? error.message : 'Channel delivery failed',
        availableAt: new Date(Date.now() + backoff).toISOString(),
      });
      if (!deadLetter) {
        logger.warn(
          {
            rowId: row.id,
            bindingId: row.binding_id,
            attempt: row.attempt_count,
          },
          'Scheduled channel delivery retry',
        );
      }
    }
  }
}
