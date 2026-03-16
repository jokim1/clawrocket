export interface TalkExecutorInput {
  runId: string;
  talkId: string;
  threadId?: string | null;
  requestedBy: string;
  triggerMessageId: string;
  triggerContent: string;
  targetAgentId?: string | null;
}

export interface TalkExecutionUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export type TalkExecutionEvent =
  | {
      type: 'talk_response_started';
      runId: string;
      talkId: string;
      agentId?: string | null;
      agentNickname?: string | null;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_delta';
      runId: string;
      talkId: string;
      agentId?: string | null;
      agentNickname?: string | null;
      deltaText: string;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_usage';
      runId: string;
      talkId: string;
      agentId?: string | null;
      usage: TalkExecutionUsage;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_completed';
      runId: string;
      talkId: string;
      agentId?: string | null;
      agentNickname?: string | null;
      usage?: TalkExecutionUsage;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
    }
  | {
      type: 'talk_response_failed';
      runId: string;
      talkId: string;
      agentId?: string | null;
      routeStepPosition?: number | null;
      providerId?: string | null;
      modelId?: string | null;
      errorCode: string;
      errorMessage: string;
    }
  | {
      type: 'talk_response_cancelled';
      runId: string;
      talkId: string;
      agentId?: string | null;
    };

export interface TalkExecutorOutput {
  content: string;
  metadataJson?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  usage?: TalkExecutionUsage;
  responseSequenceInRun?: number | null;
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
    emit?: (event: TalkExecutionEvent) => void,
  ): Promise<TalkExecutorOutput>;
}
