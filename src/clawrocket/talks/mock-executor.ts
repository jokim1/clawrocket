import { TALK_MOCK_EXECUTION_MS } from '../config.js';

import type {
  TalkExecutor,
  TalkExecutorInput,
  TalkExecutorOutput,
} from './executor.js';

function abortError(reason?: unknown): Error {
  const err = new Error(
    typeof reason === 'string' ? reason : 'Talk execution aborted',
  );
  err.name = 'AbortError';
  return err;
}

function waitFor(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0) {
    if (signal.aborted) return Promise.reject(abortError(signal.reason));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal.reason));
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export interface MockTalkExecutorOptions {
  executionMs?: number;
}

export class MockTalkExecutor implements TalkExecutor {
  private readonly executionMs: number;

  constructor(options: MockTalkExecutorOptions = {}) {
    this.executionMs = Math.max(
      0,
      Math.floor(options.executionMs ?? TALK_MOCK_EXECUTION_MS),
    );
  }

  async execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput> {
    await waitFor(this.executionMs, signal);

    return {
      content: `Mock assistant response to: ${input.triggerContent}`,
    };
  }
}
