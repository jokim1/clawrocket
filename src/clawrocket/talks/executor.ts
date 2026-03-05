export interface TalkExecutorInput {
  runId: string;
  talkId: string;
  requestedBy: string;
  triggerMessageId: string;
  triggerContent: string;
}

export interface TalkExecutorOutput {
  content: string;
}

export class TalkExecutorError extends Error {
  readonly code: string;
  readonly sourceMessage: string;

  constructor(
    code: string,
    message: string,
    options?: { sourceMessage?: string },
  ) {
    super(message);
    this.code = code;
    this.sourceMessage = options?.sourceMessage || message;
    this.name = 'TalkExecutorError';
  }
}

export interface TalkExecutor {
  execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput>;
}
