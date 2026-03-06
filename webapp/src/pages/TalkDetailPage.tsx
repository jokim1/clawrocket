import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  ApiError,
  cancelTalkRuns,
  getTalk,
  getTalkAgents,
  listTalkMessages,
  sendTalkMessage,
  Talk,
  TalkAgent,
  TalkMessage,
  updateTalkAgents,
  UnauthorizedError,
} from '../lib/api';
import { openTalkStream } from '../lib/talkStream';
import type {
  MessageAppendedEvent,
  TalkResponseDeltaEvent,
  TalkResponseStartedEvent,
  TalkResponseTerminalEvent,
  TalkResponseUsageEvent,
  TalkRunCancelledEvent,
  TalkRunCompletedEvent,
  TalkRunFailedEvent,
  TalkRunStartedEvent,
  TalkStreamState,
} from '../lib/talkStream';

type RunView = {
  id: string;
  status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
  triggerMessageId: string | null;
  responseMessageId?: string;
  errorCode?: string;
  errorMessage?: string;
  executorAlias?: string | null;
  executorModel?: string | null;
  updatedAt: number;
};

type LiveResponseView = {
  runId: string;
  text: string;
  agentId?: string | null;
  agentName?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  errorMessage?: string;
};

function summarizeMessageForRun(message: TalkMessage | undefined, messageId: string): string {
  if (!message) return messageId;
  const compact = message.content.trim().replace(/\s+/g, ' ');
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  return `${message.role}: ${preview || '(empty)'}`;
}

type DetailState = {
  kind: 'loading' | 'ready' | 'unavailable' | 'error';
  talk: Talk | null;
  errorMessage: string | null;
  messages: TalkMessage[];
  messageIds: Set<string>;
  runsById: Record<string, RunView>;
  streamState: TalkStreamState;
  sendState: {
    status: 'idle' | 'posting' | 'error';
    error?: string;
    lastDraft?: string;
  };
  liveResponse: LiveResponseView | null;
  cancelState: {
    status: 'idle' | 'posting' | 'success' | 'error';
    message?: string;
  };
  hasUnreadBelow: boolean;
  initialScrollPending: boolean;
};

type DetailAction =
  | { type: 'BOOTSTRAP_LOADING' }
  | { type: 'BOOTSTRAP_READY'; talk: Talk; messages: TalkMessage[] }
  | { type: 'BOOTSTRAP_ERROR'; unavailable: boolean; message: string }
  | {
      type: 'MESSAGE_APPENDED';
      message: TalkMessage;
      wasNearBottom: boolean;
    }
  | {
      type: 'RUN_STARTED';
      runId: string;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
    }
  | {
      type: 'RUN_QUEUED';
      runId: string;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
    }
  | {
      type: 'RUN_COMPLETED';
      runId: string;
      triggerMessageId: string | null;
      responseMessageId: string;
      executorAlias?: string | null;
      executorModel?: string | null;
    }
  | {
      type: 'RUN_FAILED';
      runId: string;
      triggerMessageId: string | null;
      errorCode: string;
      errorMessage: string;
      executorAlias?: string | null;
      executorModel?: string | null;
    }
  | {
      type: 'RUN_CANCELLED_BATCH';
      runIds: string[];
    }
  | { type: 'RESPONSE_STARTED'; event: TalkResponseStartedEvent }
  | { type: 'RESPONSE_DELTA'; event: TalkResponseDeltaEvent }
  | { type: 'RESPONSE_COMPLETED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_FAILED'; event: TalkResponseTerminalEvent }
  | { type: 'RESPONSE_CANCELLED'; event: TalkResponseTerminalEvent }
  | { type: 'STREAM_CONNECTING' }
  | { type: 'STREAM_LIVE' }
  | { type: 'STREAM_RECONNECTING' }
  | { type: 'STREAM_OFFLINE' }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_FAILED'; message: string; lastDraft: string }
  | { type: 'SEND_CLEARED' }
  | { type: 'CANCEL_STARTED' }
  | { type: 'CANCEL_SUCCEEDED'; message: string }
  | { type: 'CANCEL_FAILED'; message: string }
  | { type: 'CLEAR_UNREAD' }
  | { type: 'RESET_FROM_RESYNC'; messages: TalkMessage[] };

function createInitialDetailState(): DetailState {
  return {
    kind: 'loading',
    talk: null,
    errorMessage: null,
    messages: [],
    messageIds: new Set<string>(),
    runsById: {},
    streamState: 'connecting',
    sendState: { status: 'idle' },
    liveResponse: null,
    cancelState: { status: 'idle' },
    hasUnreadBelow: false,
    initialScrollPending: false,
  };
}

function withRun(
  state: DetailState,
  runId: string,
  patch: Partial<RunView> & Pick<RunView, 'status'>,
): Record<string, RunView> {
  const now = Date.now();
  const current = state.runsById[runId];
  return {
    ...state.runsById,
    [runId]: {
      id: runId,
      status: patch.status,
      triggerMessageId: patch.triggerMessageId ?? current?.triggerMessageId ?? null,
      responseMessageId: patch.responseMessageId ?? current?.responseMessageId,
      errorCode: patch.errorCode ?? current?.errorCode,
      errorMessage: patch.errorMessage ?? current?.errorMessage,
      executorAlias: patch.executorAlias ?? current?.executorAlias,
      executorModel: patch.executorModel ?? current?.executorModel,
      updatedAt: now,
    },
  };
}

function detailReducer(state: DetailState, action: DetailAction): DetailState {
  switch (action.type) {
    case 'BOOTSTRAP_LOADING':
      return {
        ...createInitialDetailState(),
        kind: 'loading',
      };
    case 'BOOTSTRAP_READY':
      return {
        kind: 'ready',
        talk: action.talk,
        errorMessage: null,
        messages: action.messages,
        messageIds: new Set(action.messages.map((message) => message.id)),
        runsById: {},
        streamState: 'connecting',
        sendState: { status: 'idle' },
        liveResponse: null,
        cancelState: { status: 'idle' },
        hasUnreadBelow: false,
        initialScrollPending: true,
      };
    case 'BOOTSTRAP_ERROR':
      return {
        ...createInitialDetailState(),
        kind: action.unavailable ? 'unavailable' : 'error',
        errorMessage: action.message,
        streamState: 'offline',
        liveResponse: null,
      };
    case 'MESSAGE_APPENDED': {
      if (state.kind !== 'ready') return state;
      if (state.messageIds.has(action.message.id)) {
        return state;
      }

      const messages = [...state.messages, action.message];
      const messageIds = new Set(state.messageIds);
      messageIds.add(action.message.id);

      return {
        ...state,
        messages,
        messageIds,
        hasUnreadBelow:
          state.initialScrollPending || action.wasNearBottom
            ? false
            : state.hasUnreadBelow || true,
      };
    }
    case 'RUN_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
          status: 'running',
          triggerMessageId: action.triggerMessageId,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
        }),
      };
    case 'RUN_QUEUED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
          status: 'queued',
          triggerMessageId: action.triggerMessageId,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
        }),
      };
    case 'RUN_COMPLETED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        liveResponse:
          state.liveResponse?.runId === action.runId ? null : state.liveResponse,
        runsById: withRun(state, action.runId, {
          status: 'completed',
          triggerMessageId: action.triggerMessageId,
          responseMessageId: action.responseMessageId,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
        }),
      };
    case 'RUN_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        liveResponse:
          state.liveResponse?.runId === action.runId ? null : state.liveResponse,
        runsById: withRun(state, action.runId, {
          status: 'failed',
          triggerMessageId: action.triggerMessageId,
          errorCode: action.errorCode,
          errorMessage: action.errorMessage,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
        }),
      };
    case 'RUN_CANCELLED_BATCH':
      if (state.kind !== 'ready' || action.runIds.length === 0) return state;
      return {
        ...state,
        liveResponse:
          state.liveResponse && action.runIds.includes(state.liveResponse.runId)
            ? null
            : state.liveResponse,
        runsById: action.runIds.reduce((runsById, runId) => {
          const current = runsById[runId];
          return {
            ...runsById,
            [runId]: {
              id: runId,
              status: 'cancelled',
              triggerMessageId: current?.triggerMessageId ?? null,
              responseMessageId: current?.responseMessageId,
              errorCode: current?.errorCode,
              errorMessage: current?.errorMessage,
              updatedAt: Date.now(),
            },
          };
        }, state.runsById),
      };
    case 'RESPONSE_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        liveResponse: {
          runId: action.event.runId,
          text: '',
          agentId: action.event.agentId,
          agentName: action.event.agentName,
          providerId: action.event.providerId,
          modelId: action.event.modelId,
        },
      };
    case 'RESPONSE_DELTA':
      if (state.kind !== 'ready') return state;
      if (state.liveResponse?.runId !== action.event.runId) {
        return {
          ...state,
          liveResponse: {
            runId: action.event.runId,
            text: action.event.deltaText,
            agentId: action.event.agentId,
            agentName: action.event.agentName,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
          },
        };
      }
      return {
        ...state,
        liveResponse: {
          ...state.liveResponse,
          text: `${state.liveResponse.text}${action.event.deltaText}`,
        },
      };
    case 'RESPONSE_COMPLETED':
      if (state.kind !== 'ready') return state;
      if (state.liveResponse?.runId !== action.event.runId) return state;
      return { ...state, liveResponse: null };
    case 'RESPONSE_FAILED':
      if (state.kind !== 'ready') return state;
      if (state.liveResponse?.runId !== action.event.runId) return state;
      return {
        ...state,
        liveResponse: {
          ...state.liveResponse,
          errorMessage: action.event.errorMessage,
        },
      };
    case 'RESPONSE_CANCELLED':
      if (state.kind !== 'ready') return state;
      if (state.liveResponse?.runId !== action.event.runId) return state;
      return { ...state, liveResponse: null };
    case 'STREAM_CONNECTING':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'connecting' };
    case 'STREAM_LIVE':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'live' };
    case 'STREAM_RECONNECTING':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'reconnecting' };
    case 'STREAM_OFFLINE':
      if (state.kind !== 'ready') return state;
      return { ...state, streamState: 'offline' };
    case 'SEND_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        sendState: {
          status: 'posting',
        },
      };
    case 'SEND_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        sendState: {
          status: 'error',
          error: action.message,
          lastDraft: action.lastDraft,
        },
      };
    case 'SEND_CLEARED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        sendState: {
          status: 'idle',
        },
      };
    case 'CANCEL_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        cancelState: { status: 'posting' },
      };
    case 'CANCEL_SUCCEEDED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        cancelState: { status: 'success', message: action.message },
      };
    case 'CANCEL_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        cancelState: { status: 'error', message: action.message },
      };
    case 'CLEAR_UNREAD':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    case 'RESET_FROM_RESYNC':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        messages: action.messages,
        messageIds: new Set(action.messages.map((message) => message.id)),
        runsById: {},
        liveResponse: null,
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    default:
      return state;
  }
}

const SCROLL_STICK_THRESHOLD_PX = 120;
const TALK_MESSAGE_MAX_CHARS = 20_000;
function normalizeAgentNames(draft: string): string[] {
  return [
    ...new Set(
      draft
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function coerceAgents(
  input: TalkAgent[] | string[],
  fallbackRouteId: string,
): TalkAgent[] {
  if (!Array.isArray(input)) return [];
  if (input.length === 0) return [];
  if (typeof input[0] !== 'string') {
    return input as TalkAgent[];
  }
  return (input as string[]).map((name, index) => ({
    id: `legacy-${index}`,
    name,
    personaRole: 'assistant',
    routeId: fallbackRouteId,
    isPrimary: index === 0,
    sortOrder: index,
  }));
}

export function TalkDetailPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const [state, dispatch] = useReducer(detailReducer, undefined, createInitialDetailState);
  const [draft, setDraft] = useState('');
  const [agents, setAgents] = useState<TalkAgent[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<TalkAgent[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [agentState, setAgentState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const messageElementRefs = useRef<Map<string, HTMLElement>>(new Map());
  const autoStickToBottomRef = useRef(false);
  const onUnauthorizedRef = useRef(onUnauthorized);

  useEffect(() => {
    onUnauthorizedRef.current = onUnauthorized;
  }, [onUnauthorized]);

  const streamBadgeLabel = useMemo(() => {
    switch (state.streamState) {
      case 'connecting':
        return 'Connecting';
      case 'live':
        return 'Live';
      case 'reconnecting':
        return 'Reconnecting';
      case 'offline':
      default:
        return 'Offline';
    }
  }, [state.streamState]);

  const accessRole = state.kind === 'ready' ? state.talk?.accessRole : null;
  const canCancelRuns =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canEditAgents = canCancelRuns;

  const isNearBottom = useCallback((): boolean => {
    const container = timelineRef.current;
    if (!container) return true;
    const distanceToBottom =
      container.scrollHeight - (container.scrollTop + container.clientHeight);
    return distanceToBottom <= SCROLL_STICK_THRESHOLD_PX;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' });
  }, []);

  const setMessageElementRef = useCallback(
    (messageId: string, element: HTMLElement | null) => {
      if (element) {
        messageElementRefs.current.set(messageId, element);
        return;
      }
      messageElementRefs.current.delete(messageId);
    },
    [],
  );

  const resyncMessages = useCallback(async () => {
    try {
      const messages = await listTalkMessages(talkId);
      dispatch({ type: 'RESET_FROM_RESYNC', messages });
      autoStickToBottomRef.current = true;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorizedRef.current();
        return;
      }
      // Ignore transient sync failures; next stream reconnect/replay can recover.
    }
  }, [talkId]);

  const handleUnauthorized = useCallback(() => {
    onUnauthorizedRef.current();
  }, []);

  const handleMessageAppended = useCallback(
    (event: MessageAppendedEvent) => {
      if (event.talkId !== talkId) return;

      if (!event.content || !event.createdAt) {
        void resyncMessages();
        return;
      }

      const nearBottom = isNearBottom();
      if (nearBottom) {
        autoStickToBottomRef.current = true;
      }

      dispatch({
        type: 'MESSAGE_APPENDED',
        wasNearBottom: nearBottom,
        message: {
          id: event.messageId,
          role: event.role,
          content: event.content,
          createdBy: event.createdBy,
          createdAt: event.createdAt,
          runId: event.runId,
          agentId: event.agentId,
          agentName: event.agentName,
        },
      });
    },
    [isNearBottom, resyncMessages, talkId],
  );

  const handleRunStarted = useCallback(
    (event: TalkRunStartedEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({
        type: event.status === 'queued' ? 'RUN_QUEUED' : 'RUN_STARTED',
        runId: event.runId,
        triggerMessageId: event.triggerMessageId,
        executorAlias: event.executorAlias,
        executorModel: event.executorModel,
      });
    },
    [talkId],
  );

  const handleRunQueued = useCallback(
    (event: TalkRunStartedEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({
        type: 'RUN_QUEUED',
        runId: event.runId,
        triggerMessageId: event.triggerMessageId,
      });
    },
    [talkId],
  );

  const handleRunCompleted = useCallback(
    (event: TalkRunCompletedEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({
        type: 'RUN_COMPLETED',
        runId: event.runId,
        triggerMessageId: event.triggerMessageId,
        responseMessageId: event.responseMessageId,
        executorAlias: event.executorAlias,
        executorModel: event.executorModel,
      });
    },
    [talkId],
  );

  const handleRunFailed = useCallback(
    (event: TalkRunFailedEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({
        type: 'RUN_FAILED',
        runId: event.runId,
        triggerMessageId: event.triggerMessageId,
        errorCode: event.errorCode,
        errorMessage: event.errorMessage,
        executorAlias: event.executorAlias,
        executorModel: event.executorModel,
      });
    },
    [talkId],
  );

  const handleRunCancelled = useCallback(
    (event: TalkRunCancelledEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({
        type: 'RUN_CANCELLED_BATCH',
        runIds: event.runIds,
      });
    },
    [talkId],
  );

  const handleResponseStarted = useCallback(
    (event: TalkResponseStartedEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({ type: 'RESPONSE_STARTED', event });
    },
    [talkId],
  );

  const handleResponseDelta = useCallback(
    (event: TalkResponseDeltaEvent) => {
      if (event.talkId !== talkId) return;
      const nearBottom = isNearBottom();
      if (nearBottom) {
        autoStickToBottomRef.current = true;
      }
      dispatch({ type: 'RESPONSE_DELTA', event });
    },
    [isNearBottom, talkId],
  );

  const handleResponseUsage = useCallback(
    (_event: TalkResponseUsageEvent) => {
      // Reserved for future UI surfacing.
    },
    [],
  );

  const handleResponseCompleted = useCallback(
    (event: TalkResponseTerminalEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({ type: 'RESPONSE_COMPLETED', event });
    },
    [talkId],
  );

  const handleResponseFailed = useCallback(
    (event: TalkResponseTerminalEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({ type: 'RESPONSE_FAILED', event });
    },
    [talkId],
  );

  const handleResponseCancelled = useCallback(
    (event: TalkResponseTerminalEvent) => {
      if (event.talkId !== talkId) return;
      dispatch({ type: 'RESPONSE_CANCELLED', event });
    },
    [talkId],
  );

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'BOOTSTRAP_LOADING' });
    messageElementRefs.current.clear();
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentId(null);
    setAgentState({ status: 'idle' });

    const load = async () => {
      try {
        const [talk, messages, rawAgents] = await Promise.all([
          getTalk(talkId),
          listTalkMessages(talkId),
          getTalkAgents(talkId),
        ]);
        if (!cancelled) {
          const nextAgents = coerceAgents(rawAgents as TalkAgent[] | string[], 'route.default.mock');
          setAgents(nextAgents);
          setAgentDrafts(nextAgents);
          setTargetAgentId(
            nextAgents.find((agent) => agent.isPrimary)?.id || nextAgents[0]?.id || null,
          );
          setAgentState({ status: 'idle' });
          dispatch({ type: 'BOOTSTRAP_READY', talk, messages });
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          if (!cancelled) {
            dispatch({
              type: 'BOOTSTRAP_ERROR',
              unavailable: true,
              message: 'Talk not found',
            });
          }
          return;
        }

        if (!cancelled) {
          dispatch({
            type: 'BOOTSTRAP_ERROR',
            unavailable: false,
            message: err instanceof Error ? err.message : 'Failed to load talk',
          });
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [handleUnauthorized, talkId]);

  useEffect(() => {
    if (state.kind !== 'ready') return;

    const stream = openTalkStream({
      talkId,
      onUnauthorized: handleUnauthorized,
      onMessageAppended: handleMessageAppended,
      onRunStarted: handleRunStarted,
      onRunQueued: handleRunQueued,
      onResponseStarted: handleResponseStarted,
      onResponseDelta: handleResponseDelta,
      onResponseUsage: handleResponseUsage,
      onResponseCompleted: handleResponseCompleted,
      onResponseFailed: handleResponseFailed,
      onResponseCancelled: handleResponseCancelled,
      onRunCompleted: handleRunCompleted,
      onRunFailed: handleRunFailed,
      onRunCancelled: handleRunCancelled,
      onReplayGap: async () => {
        await resyncMessages();
      },
      onStateChange: (streamState) => {
        switch (streamState) {
          case 'connecting':
            dispatch({ type: 'STREAM_CONNECTING' });
            break;
          case 'live':
            dispatch({ type: 'STREAM_LIVE' });
            break;
          case 'reconnecting':
            dispatch({ type: 'STREAM_RECONNECTING' });
            break;
          case 'offline':
            dispatch({ type: 'STREAM_OFFLINE' });
            break;
          default:
            break;
        }
      },
    });

    return () => {
      stream.close();
      dispatch({ type: 'STREAM_OFFLINE' });
    };
  }, [
    handleMessageAppended,
    handleResponseCancelled,
    handleResponseCompleted,
    handleResponseDelta,
    handleResponseFailed,
    handleResponseStarted,
    handleResponseUsage,
    handleRunCancelled,
    handleRunCompleted,
    handleRunFailed,
    handleRunQueued,
    handleRunStarted,
    handleUnauthorized,
    resyncMessages,
    state.kind,
    talkId,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    if (!state.initialScrollPending) return;

    scrollToBottom('auto');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [state.kind, state.initialScrollPending, state.messages.length, scrollToBottom]);

  useEffect(() => {
    if (state.kind !== 'ready' || state.initialScrollPending) return;
    if (!autoStickToBottomRef.current) return;

    autoStickToBottomRef.current = false;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [state.kind, state.initialScrollPending, state.messages.length, scrollToBottom]);

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (state.kind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready') return;
    const talk = state.talk;
    if (!talk) return;

    const content = draft.trim();
    if (!content) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Message content is required.',
        lastDraft: draft,
      });
      return;
    }
    if (content.length > TALK_MESSAGE_MAX_CHARS) {
      dispatch({
        type: 'SEND_FAILED',
        message: `Message exceeds ${TALK_MESSAGE_MAX_CHARS} characters.`,
        lastDraft: content,
      });
      return;
    }

    dispatch({ type: 'SEND_STARTED' });

    try {
      await sendTalkMessage({
        talkId: talk.id,
        content,
        targetAgentId,
      });
      setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }

      dispatch({
        type: 'SEND_FAILED',
        message: err instanceof Error ? err.message : 'Failed to send message',
        lastDraft: content,
      });
    }
  };

  const handleCancelRuns = async () => {
    if (state.kind !== 'ready') return;
    const talk = state.talk;
    if (!talk) return;

    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(talk.id);
      dispatch({
        type: 'CANCEL_SUCCEEDED',
        message: `Cancelled ${result.cancelledRuns} run${result.cancelledRuns === 1 ? '' : 's'}.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }

      dispatch({
        type: 'CANCEL_FAILED',
        message: err instanceof Error ? err.message : 'Failed to cancel runs',
      });
    }
  };

  const handleClearUnread = () => {
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const handleAgentDraftChange = (
    agentId: string,
    patch: Partial<TalkAgent>,
  ) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId ? { ...agent, ...patch } : agent,
      ),
    );
    if (agentState.status === 'error' || agentState.status === 'success') {
      setAgentState({ status: 'idle' });
    }
  };

  const handleAddAgent = () => {
    const fallbackRouteId =
      agentDrafts.find((agent) => agent.isPrimary)?.routeId ||
      agentDrafts[0]?.routeId ||
      'route.default.mock';
    const nextAgent: TalkAgent = {
      id: globalThis.crypto?.randomUUID?.() || `agent-${Date.now()}`,
      name: `Agent ${agentDrafts.length + 1}`,
      personaRole: 'assistant',
      routeId: fallbackRouteId,
      isPrimary: false,
      sortOrder: agentDrafts.length,
    };
    setAgentDrafts((current) => [...current, nextAgent]);
  };

  const handleRemoveAgent = (agentId: string) => {
    setAgentDrafts((current) => {
      const remaining = current.filter((agent) => agent.id !== agentId);
      if (remaining.length === 0) return current;
      if (!remaining.some((agent) => agent.isPrimary)) {
        remaining[0] = { ...remaining[0], isPrimary: true };
      }
      return remaining.map((agent, index) => ({ ...agent, sortOrder: index }));
    });
  };

  const handleSetPrimaryAgent = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isPrimary: agent.id === agentId,
      })),
    );
    setTargetAgentId(agentId);
  };

  const handleSaveAgents = async () => {
    if (state.kind !== 'ready' || !canEditAgents) return;

    setAgentState({ status: 'saving' });
    try {
      const normalized = agentDrafts.map((agent, index) => ({
        ...agent,
        name: agent.name.trim(),
        routeId: agent.routeId.trim(),
        sortOrder: index,
      }));
      const saved = coerceAgents(
        (await updateTalkAgents({
          talkId: state.talk!.id,
          agents: normalized,
        })) as TalkAgent[] | string[],
        normalized.find((agent) => agent.isPrimary)?.routeId ||
          normalized[0]?.routeId ||
          'route.default.mock',
      );
      setAgents(saved);
      setAgentDrafts(saved);
      setTargetAgentId(
        saved.find((agent) => agent.isPrimary)?.id || saved[0]?.id || null,
      );
      setAgentState({
        status: 'success',
        message: 'Talk policy updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setAgentState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to update talk agents',
      });
    }
  };

  const handleTimelineScroll = () => {
    if (state.kind !== 'ready' || !state.hasUnreadBelow) return;
    if (!isNearBottom()) return;
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const messageLookup = useMemo(() => {
    if (state.kind !== 'ready') {
      return new Map<string, TalkMessage>();
    }
    return new Map(state.messages.map((message) => [message.id, message] as const));
  }, [state.kind, state.messages]);

  const runHistory =
    state.kind === 'ready'
      ? Object.values(state.runsById).sort((a, b) => b.updatedAt - a.updatedAt)
      : [];

  const jumpToMessage = (messageId: string) => {
    const element = messageElementRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  if (state.kind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (state.kind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>You no longer have access to this talk, or it does not exist.</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{state.errorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (!state.talk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>Talk details were not available.</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = state.talk;

  return (
    <section className="page-shell talk-detail-shell">
      <header className="page-header">
        <div>
          <h1 className="talk-title">
            {talk.title}
            <span className={`stream-badge stream-${state.streamState}`}>
              {streamBadgeLabel}
            </span>
          </h1>
          <p>Event-authoritative live timeline.</p>
          {talk.agents.length > 0 ? (
            <div
              className="talk-agent-row talk-agent-row-detail"
              role="list"
              aria-label="Effective agents"
            >
              {talk.agents.map((agent) => (
                <span key={agent} className="talk-agent-chip" role="listitem">
                  {agent}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <Link to="/app/talks">Back</Link>
      </header>

      <section className="policy-panel" aria-label="Talk policy">
        <h2>Talk Agents</h2>
        {agents.length > 0 ? (
          <div className="talk-agent-row">
            {agents.map((agent) => (
              <span key={agent.id} className="talk-agent-chip">
                {agent.name}
              </span>
            ))}
          </div>
        ) : null}
        {canEditAgents ? (
          <div className="policy-editor">
            <label htmlFor="talk-policy-input">Comma-separated agents</label>
            <input
              id="talk-policy-input"
              type="text"
              value={agentDrafts.map((agent) => agent.name).join(', ')}
              onChange={(event) => {
                const names = normalizeAgentNames(event.target.value);
                setAgentDrafts((current) => {
                  const primaryId =
                    current.find((agent) => agent.isPrimary)?.id || current[0]?.id || null;
                  return names.map((name, index) => ({
                    id:
                      current[index]?.id ||
                      globalThis.crypto?.randomUUID?.() ||
                      `agent-${Date.now()}-${index}`,
                    name,
                    personaRole: current[index]?.personaRole || 'assistant',
                    routeId:
                      current[index]?.routeId ||
                      current.find((agent) => agent.isPrimary)?.routeId ||
                      current[0]?.routeId ||
                      'route.default.mock',
                    isPrimary:
                      current[index]?.id === primaryId || (!primaryId && index === 0),
                    sortOrder: index,
                  }));
                });
                if (agentState.status === 'error' || agentState.status === 'success') {
                  setAgentState({ status: 'idle' });
                }
              }}
              placeholder="Gemini, Opus4.6"
              disabled={agentState.status === 'saving'}
            />
            {agentDrafts.map((agent) => (
              <div key={agent.id} className="policy-agent-grid">
                <label>
                  <span>Name</span>
                  <input
                    type="text"
                    value={agent.name}
                    onChange={(event) =>
                      handleAgentDraftChange(agent.id, { name: event.target.value })
                    }
                    disabled={agentState.status === 'saving'}
                  />
                </label>
                <label>
                  <span>Persona</span>
                  <select
                    value={agent.personaRole}
                    onChange={(event) =>
                      handleAgentDraftChange(agent.id, {
                        personaRole: event.target.value as TalkAgent['personaRole'],
                      })
                    }
                    disabled={agentState.status === 'saving'}
                  >
                    <option value="assistant">Assistant</option>
                    <option value="analyst">Analyst</option>
                    <option value="critic">Critic</option>
                    <option value="strategist">Strategist</option>
                    <option value="devils-advocate">Devil&apos;s Advocate</option>
                    <option value="synthesizer">Synthesizer</option>
                    <option value="editor">Editor</option>
                  </select>
                </label>
                <label>
                  <span>Route ID</span>
                  <input
                    type="text"
                    value={agent.routeId}
                    onChange={(event) =>
                      handleAgentDraftChange(agent.id, { routeId: event.target.value })
                    }
                    disabled={agentState.status === 'saving'}
                  />
                </label>
                <label className="policy-primary-toggle">
                  <input
                    type="radio"
                    name="primary-talk-agent"
                    checked={agent.isPrimary}
                    onChange={() => handleSetPrimaryAgent(agent.id)}
                    disabled={agentState.status === 'saving'}
                  />
                  <span>Primary</span>
                </label>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => handleRemoveAgent(agent.id)}
                  disabled={agentDrafts.length <= 1 || agentState.status === 'saving'}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="policy-editor-controls">
              <button
                type="button"
                className="secondary-btn"
                onClick={handleAddAgent}
                disabled={agentState.status === 'saving'}
              >
                Add Agent
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={handleSaveAgents}
                disabled={agentState.status === 'saving'}
              >
                {agentState.status === 'saving' ? 'Saving…' : 'Save Agents'}
              </button>
            </div>
            {agentState.status === 'error' ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {agentState.message}
              </div>
            ) : null}
            {agentState.status === 'success' ? (
              <div className="inline-banner inline-banner-success" role="status">
                {agentState.message}
              </div>
            ) : null}
          </div>
        ) : (
          <p className="policy-muted">You have read-only access to talk agents.</p>
        )}
      </section>

      {runHistory.length > 0 ? (
        <section className="run-history-panel" aria-label="Run history">
          <h2>Run History</h2>
          <ul className="run-history-list">
            {runHistory.map((run) => (
              <li key={run.id} className="run-history-item">
                <div className="run-history-main">
                  <span className={`run-history-status run-history-status-${run.status}`}>
                    {run.status}
                  </span>
                  <code>{run.id}</code>
                </div>

                {run.executorAlias || run.executorModel ? (
                  <p className="run-history-meta">
                    Executor:{' '}
                    {run.executorAlias ? <code>{run.executorAlias}</code> : 'unknown'}
                    {run.executorModel ? (
                      <>
                        <span> · </span>
                        <code>{run.executorModel}</code>
                      </>
                    ) : null}
                  </p>
                ) : null}

                <div className="run-history-links">
                  {run.triggerMessageId ? (
                    <button
                      type="button"
                      className="run-history-link"
                      onClick={() => jumpToMessage(run.triggerMessageId!)}
                    >
                      Trigger:{' '}
                      {summarizeMessageForRun(
                        messageLookup.get(run.triggerMessageId),
                        run.triggerMessageId,
                      )}
                    </button>
                  ) : (
                    <span className="run-history-muted">Trigger: not available</span>
                  )}

                  {run.responseMessageId ? (
                    <button
                      type="button"
                      className="run-history-link"
                      onClick={() => jumpToMessage(run.responseMessageId!)}
                    >
                      Response:{' '}
                      {summarizeMessageForRun(
                        messageLookup.get(run.responseMessageId),
                        run.responseMessageId,
                      )}
                    </button>
                  ) : null}
                </div>

                {run.status === 'failed' && run.errorMessage ? (
                  <p className="run-history-error">
                    {run.errorCode ? `${run.errorCode}: ` : ''}
                    {run.errorMessage}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div
        className="timeline"
        aria-label="Talk timeline"
        ref={timelineRef}
        onScroll={handleTimelineScroll}
      >
        {state.messages.length === 0 ? (
          <p className="page-state">No messages yet.</p>
        ) : (
          state.messages.map((message) => (
            <article
              key={message.id}
              id={`message-${message.id}`}
              ref={(element) => setMessageElementRef(message.id, element)}
              className={`message message-${message.role}`}
            >
              <header>
                <strong>
                  {message.agentName ? `${message.agentName} · ` : ''}
                  {message.role}
                </strong>
                <time>{new Date(message.createdAt).toLocaleString()}</time>
              </header>
              <p>{message.content}</p>
            </article>
          ))
        )}

        {state.liveResponse ? (
          <article className="message message-assistant message-live">
            <header>
              <strong>
                {state.liveResponse.agentName
                  ? `${state.liveResponse.agentName} · assistant`
                  : 'assistant'}
              </strong>
              <time>Streaming…</time>
            </header>
            <p>{state.liveResponse.text || 'Thinking…'}</p>
            {state.liveResponse.errorMessage ? (
              <p className="run-history-error">{state.liveResponse.errorMessage}</p>
            ) : null}
          </article>
        ) : null}

        {state.hasUnreadBelow ? (
          <button
            type="button"
            className="timeline-new-indicator"
            onClick={handleClearUnread}
          >
            New messages
          </button>
        ) : null}

        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={handleSend}>
        <label className="composer-target">
          <span>Reply agent</span>
          <select
            value={targetAgentId || ''}
            onChange={(event) => setTargetAgentId(event.target.value || null)}
            disabled={state.sendState.status === 'posting' || agents.length === 0}
          >
            {agentDrafts.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.isPrimary ? ' (Primary)' : ''}
              </option>
            ))}
          </select>
        </label>
        <textarea
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          placeholder="Send a message to this talk"
          rows={3}
          maxLength={TALK_MESSAGE_MAX_CHARS}
          disabled={state.sendState.status === 'posting'}
        />

        <div className="composer-controls">
          <span className="composer-count">{draft.length}/{TALK_MESSAGE_MAX_CHARS}</span>
          <button
            type="submit"
            className="primary-btn"
            disabled={state.sendState.status === 'posting'}
          >
            {state.sendState.status === 'posting' ? 'Sending…' : 'Send'}
          </button>
          {canCancelRuns ? (
            <button
              type="button"
              className="secondary-btn"
              onClick={handleCancelRuns}
              disabled={state.cancelState.status === 'posting'}
            >
              {state.cancelState.status === 'posting' ? 'Cancelling…' : 'Cancel Runs'}
            </button>
          ) : null}
        </div>

        {state.sendState.status === 'error' ? (
          <div className="inline-banner inline-banner-error" role="alert">
            <span>{state.sendState.error || 'Unable to send message.'}</span>
            <button type="button" onClick={() => dispatch({ type: 'SEND_CLEARED' })}>
              Dismiss
            </button>
          </div>
        ) : null}

        {state.cancelState.status === 'success' ? (
          <div className="inline-banner inline-banner-success" role="status">
            {state.cancelState.message}
          </div>
        ) : null}

        {state.cancelState.status === 'error' ? (
          <div className="inline-banner inline-banner-error" role="alert">
            {state.cancelState.message}
          </div>
        ) : null}
      </form>
    </section>
  );
}
