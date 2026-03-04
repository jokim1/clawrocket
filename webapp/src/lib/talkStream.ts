export type TalkStreamState =
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'offline';

export type MessageAppendedEvent = {
  talkId: string;
  messageId: string;
  runId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdBy: string | null;
  content?: string;
  createdAt?: string;
};

export type TalkRunStartedEvent = {
  talkId: string;
  runId: string;
  triggerMessageId: string | null;
  status: 'running' | 'queued';
};

export type TalkRunCompletedEvent = {
  talkId: string;
  runId: string;
  triggerMessageId: string | null;
  responseMessageId: string;
};

export type TalkRunFailedEvent = {
  talkId: string;
  runId: string;
  triggerMessageId: string | null;
  errorCode: string;
  errorMessage: string;
};

export type TalkRunCancelledEvent = {
  talkId: string;
  cancelledBy: string;
  runIds: string[];
};

interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ) => void;
  close: () => void;
}

interface TalkStreamCallbacks {
  onMessageAppended: (event: MessageAppendedEvent) => void;
  onRunStarted: (event: TalkRunStartedEvent) => void;
  onRunQueued: (event: TalkRunStartedEvent) => void;
  onRunCompleted: (event: TalkRunCompletedEvent) => void;
  onRunFailed: (event: TalkRunFailedEvent) => void;
  onRunCancelled: (event: TalkRunCancelledEvent) => void;
  onReplayGap: () => void | Promise<void>;
  onStateChange?: (state: TalkStreamState) => void;
  onUnauthorized: () => void;
}

interface OpenTalkStreamInput extends TalkStreamCallbacks {
  talkId: string;
  createEventSource?: (url: string) => EventSourceLike;
  probeSession?: () => Promise<boolean>;
  jitterMs?: (baseMs: number) => number;
}

export interface TalkStreamHandle {
  close: () => void;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 4000, 8000] as const;

export function openTalkStream(input: OpenTalkStreamInput): TalkStreamHandle {
  let source: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let handlingReplayGap = false;

  const createEventSource =
    input.createEventSource ||
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);
  const probeSession = input.probeSession || defaultSessionProbe;
  const jitterMs = input.jitterMs || defaultJitterMs;

  const emitState = (state: TalkStreamState) => {
    input.onStateChange?.(state);
  };

  const clearReconnectTimer = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };

  const closeSource = () => {
    if (!source) return;
    source.close();
    source = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearReconnectTimer();
    closeSource();
    emitState('offline');
  };

  const scheduleReconnect = () => {
    if (stopped) return;
    clearReconnectTimer();
    emitState('reconnecting');

    const baseDelay = BACKOFF_STEPS_MS[Math.min(
      reconnectAttempt,
      BACKOFF_STEPS_MS.length - 1,
    )];
    reconnectAttempt += 1;
    const delay = baseDelay + Math.max(0, jitterMs(baseDelay));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openConnection('reconnecting');
    }, delay);
  };

  const handleUnauthorized = () => {
    stop();
    input.onUnauthorized();
  };

  const handleTransportError = () => {
    if (stopped || handlingReplayGap) return;
    closeSource();

    void probeSession()
      .then((authorized) => {
        if (stopped) return;
        if (!authorized) {
          handleUnauthorized();
          return;
        }
        scheduleReconnect();
      })
      .catch(() => {
        if (!stopped) {
          scheduleReconnect();
        }
      });
  };

  const parse = <T>(event: MessageEvent<string>): T | null => {
    try {
      return JSON.parse(event.data) as T;
    } catch {
      return null;
    }
  };

  const handleReplayGap = () => {
    if (stopped || handlingReplayGap) return;
    handlingReplayGap = true;
    clearReconnectTimer();
    closeSource();
    emitState('reconnecting');

    void Promise.resolve(input.onReplayGap())
      .then(() => {
        if (stopped) return;
        reconnectAttempt = 0;
        handlingReplayGap = false;
        openConnection('connecting');
      })
      .catch(() => {
        handlingReplayGap = false;
        if (!stopped) {
          scheduleReconnect();
        }
      });
  };

  const openConnection = (state: 'connecting' | 'reconnecting') => {
    if (stopped) return;
    clearReconnectTimer();
    closeSource();
    emitState(state);

    const url = `/api/v1/talks/${encodeURIComponent(input.talkId)}/events?stream=1`;
    const next = createEventSource(url);
    source = next;

    next.onopen = () => {
      reconnectAttempt = 0;
      emitState('live');
    };

    next.onerror = () => {
      if (next !== source) return;
      handleTransportError();
    };

    next.addEventListener('message_appended', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<MessageAppendedEvent>(event);
      if (!payload) return;
      input.onMessageAppended(payload);
    });

    next.addEventListener('talk_run_started', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunStartedEvent>(event);
      if (!payload) return;
      input.onRunStarted(payload);
    });

    next.addEventListener('talk_run_queued', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunStartedEvent>(event);
      if (!payload) return;
      input.onRunQueued(payload);
    });

    next.addEventListener('talk_run_completed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunCompletedEvent>(event);
      if (!payload) return;
      input.onRunCompleted(payload);
    });

    next.addEventListener('talk_run_failed', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunFailedEvent>(event);
      if (!payload) return;
      input.onRunFailed(payload);
    });

    next.addEventListener('talk_run_cancelled', (event) => {
      if (next !== source || stopped) return;
      const payload = parse<TalkRunCancelledEvent>(event);
      if (!payload) return;
      input.onRunCancelled(payload);
    });

    next.addEventListener('replay_gap', () => {
      if (next !== source || stopped) return;
      handleReplayGap();
    });
  };

  openConnection('connecting');

  return {
    close: stop,
  };
}

function defaultJitterMs(baseMs: number): number {
  const jitterCap = Math.max(0, Math.floor(baseMs * 0.2));
  if (jitterCap === 0) return 0;
  return Math.floor(Math.random() * (jitterCap + 1));
}

async function defaultSessionProbe(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/session/me', {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
      },
    });
    return response.status !== 401;
  } catch {
    // Treat transport errors as transient and let reconnect backoff handle it.
    return true;
  }
}
