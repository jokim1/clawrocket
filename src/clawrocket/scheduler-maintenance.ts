import { logger } from '../logger.js';
import { registerSchedulerMaintenanceHook } from '../task-scheduler.js';

import {
  pruneEventOutbox,
  pruneIdempotencyCache,
  scanDeadLetterQueue,
} from './db/index.js';

let registered = false;

export function registerClawrocketSchedulerMaintenanceHook(): void {
  if (registered) return;
  registered = true;

  registerSchedulerMaintenanceHook(() => {
    const prunedOutbox = pruneEventOutbox();
    const prunedIdempotency = pruneIdempotencyCache();
    const deadLetters = scanDeadLetterQueue(10);

    if (prunedOutbox > 0 || prunedIdempotency > 0 || deadLetters.length > 0) {
      logger.info(
        {
          prunedOutbox,
          prunedIdempotency,
          deadLetters: deadLetters.length,
        },
        'Scheduler maintenance pass complete',
      );
    }
  });
}

/** @internal - for tests only. */
export function _resetClawrocketSchedulerMaintenanceHookForTests(): void {
  registered = false;
}
