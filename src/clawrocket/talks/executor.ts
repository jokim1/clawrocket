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

export interface TalkExecutor {
  execute(
    input: TalkExecutorInput,
    signal: AbortSignal,
  ): Promise<TalkExecutorOutput>;
}
