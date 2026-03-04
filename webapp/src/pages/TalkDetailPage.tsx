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
  listTalkMessages,
  sendTalkMessage,
  Talk,
  TalkMessage,
  UnauthorizedError,
} from '../lib/api';
import { openTalkStream } from '../lib/talkStream';
import type {
  MessageAppendedEvent,
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
  updatedAt: number;
};

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
    }
  | {
      type: 'RUN_QUEUED';
      runId: string;
      triggerMessageId: string | null;
    }
  | {
      type: 'RUN_COMPLETED';
      runId: string;
      triggerMessageId: string | null;
      responseMessageId: string;
    }
  | {
      type: 'RUN_FAILED';
      runId: string;
      triggerMessageId: string | null;
      errorCode: string;
      errorMessage: string;
    }
  | {
      type: 'RUN_CANCELLED_BATCH';
      runIds: string[];
    }
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
        }),
      };
    case 'RUN_QUEUED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
          status: 'queued',
          triggerMessageId: action.triggerMessageId,
        }),
      };
    case 'RUN_COMPLETED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
          status: 'completed',
          triggerMessageId: action.triggerMessageId,
          responseMessageId: action.responseMessageId,
        }),
      };
    case 'RUN_FAILED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        runsById: withRun(state, action.runId, {
          status: 'failed',
          triggerMessageId: action.triggerMessageId,
          errorCode: action.errorCode,
          errorMessage: action.errorMessage,
        }),
      };
    case 'RUN_CANCELLED_BATCH':
      if (state.kind !== 'ready' || action.runIds.length === 0) return state;
      return {
        ...state,
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
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    default:
      return state;
  }
}

const SCROLL_STICK_THRESHOLD_PX = 120;
const TALK_MESSAGE_MAX_CHARS = 20_000;

export function TalkDetailPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const [state, dispatch] = useReducer(detailReducer, undefined, createInitialDetailState);
  const [draft, setDraft] = useState('');

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const autoStickToBottomRef = useRef(false);

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

  const resyncMessages = useCallback(async () => {
    try {
      const messages = await listTalkMessages(talkId);
      dispatch({ type: 'RESET_FROM_RESYNC', messages });
      autoStickToBottomRef.current = true;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      // Ignore transient sync failures; next stream reconnect/replay can recover.
    }
  }, [onUnauthorized, talkId]);

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

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'BOOTSTRAP_LOADING' });

    const load = async () => {
      try {
        const [talk, messages] = await Promise.all([
          getTalk(talkId),
          listTalkMessages(talkId),
        ]);
        if (!cancelled) {
          dispatch({ type: 'BOOTSTRAP_READY', talk, messages });
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
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
  }, [onUnauthorized, talkId]);

  useEffect(() => {
    if (state.kind !== 'ready') return;

    const stream = openTalkStream({
      talkId,
      onUnauthorized,
      onMessageAppended: handleMessageAppended,
      onRunStarted: handleRunStarted,
      onRunQueued: handleRunQueued,
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
    handleRunCancelled,
    handleRunCompleted,
    handleRunFailed,
    handleRunQueued,
    handleRunStarted,
    onUnauthorized,
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
      await sendTalkMessage({ talkId: talk.id, content });
      setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
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
        onUnauthorized();
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

  const handleTimelineScroll = () => {
    if (state.kind !== 'ready' || !state.hasUnreadBelow) return;
    if (!isNearBottom()) return;
    dispatch({ type: 'CLEAR_UNREAD' });
  };

  const runChips =
    state.kind === 'ready'
      ? Object.values(state.runsById).sort((a, b) => b.updatedAt - a.updatedAt)
      : [];

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
        </div>
        <Link to="/app/talks">Back</Link>
      </header>

      {runChips.length > 0 ? (
        <div className="run-chip-row" aria-label="Run status">
          {runChips.map((run) => (
            <span key={run.id} className={`run-chip run-chip-${run.status}`}>
              <strong>{run.status}</strong>
              <span>{run.id}</span>
            </span>
          ))}
        </div>
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
            <article key={message.id} className={`message message-${message.role}`}>
              <header>
                <strong>{message.role}</strong>
                <time>{new Date(message.createdAt).toLocaleString()}</time>
              </header>
              <p>{message.content}</p>
            </article>
          ))
        )}

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
