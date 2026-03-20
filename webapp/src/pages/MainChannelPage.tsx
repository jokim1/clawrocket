/**
 * MainChannelPage — Primary AI surface for Nanoclaw (Main Agent Channel).
 *
 * Combined view: thread list on the left, active thread detail on the right.
 * Single-agent, context-free execution with web tools (fetch + search).
 * Uses the user-scoped SSE stream for real-time updates.
 */

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  deleteMainThread,
  ApiError,
  getMainThread,
  listMainThreads,
  postMainMessage,
  UnauthorizedError,
  updateMainThread,
  type MainThreadMessage,
  type MainThreadSummary,
} from '../lib/api';
import { stripInternalAssistantText } from '../lib/assistantText';
import { InlineEditableTitle } from '../components/InlineEditableTitle';
import { ThreadContextMenu } from '../components/ThreadContextMenu';
import { ThreadRowTitleEditor } from '../components/ThreadRowTitleEditor';
import { ThreadStartButton } from '../components/ThreadStartButton';
import {
  displayThreadTitle,
  inferThreadTitleFromContent,
} from '../lib/threadTitles';
import {
  openMainStream,
  type MainMessageAppendedEvent,
  type MainResponseDeltaEvent,
  type MainResponseFailedEvent,
  type MainResponseStartedEvent,
  type MainStreamState,
} from '../lib/mainStream';

// ============================================================================
// Types
// ============================================================================

type LiveResponse = {
  runId: string;
  threadId: string;
  rawText: string;
  text: string;
  agentName?: string;
  errorMessage?: string;
  terminalStatus?: 'failed';
  startedAt: number;
};

type MainState = {
  threads: MainThreadSummary[];
  threadsLoading: boolean;
  threadsError: string | null;
  activeThreadId: string | null;
  messages: MainThreadMessage[];
  messagesLoading: boolean;
  messagesError: string | null;
  liveResponses: Record<string, LiveResponse>;
  streamState: MainStreamState;
  sendState: 'idle' | 'posting' | 'error';
  sendError: string | null;
};

type MainAction =
  | { type: 'THREADS_LOADING' }
  | { type: 'THREADS_LOADED'; threads: MainThreadSummary[] }
  | { type: 'THREADS_ERROR'; message: string }
  | { type: 'THREAD_REMOVED'; threadId: string }
  | { type: 'THREAD_SELECTED'; threadId: string }
  | {
      type: 'THREAD_UPDATED';
      threadId: string;
      title: string | null;
      isPinned: boolean;
    }
  | { type: 'MESSAGES_LOADING' }
  | { type: 'MESSAGES_LOADED'; messages: MainThreadMessage[] }
  | { type: 'MESSAGES_ERROR'; message: string }
  | { type: 'MESSAGE_APPENDED'; message: MainThreadMessage }
  | { type: 'RESPONSE_STARTED'; event: MainResponseStartedEvent }
  | { type: 'RESPONSE_DELTA'; event: MainResponseDeltaEvent }
  | { type: 'RESPONSE_COMPLETED'; runId: string; threadId: string }
  | { type: 'RESPONSE_FAILED'; event: MainResponseFailedEvent }
  | { type: 'STREAM_STATE'; state: MainStreamState }
  | { type: 'SEND_STARTED' }
  | { type: 'SEND_FAILED'; message: string }
  | { type: 'SEND_CLEARED' }
  | {
      type: 'NEW_THREAD_CREATED';
      threadId: string;
      threadSummary: MainThreadSummary;
    }
  | { type: 'CLEAR_THREAD' }
  | {
      type: 'MESSAGES_LOADED_FOR_THREAD';
      threadId: string;
      messages: MainThreadMessage[];
    };

function createInitialState(): MainState {
  return {
    threads: [],
    threadsLoading: true,
    threadsError: null,
    activeThreadId: null,
    messages: [],
    messagesLoading: false,
    messagesError: null,
    liveResponses: {},
    streamState: 'connecting',
    sendState: 'idle',
    sendError: null,
  };
}

const SCROLL_STICK_THRESHOLD_PX = 120;
const MAIN_MESSAGE_MAX_CHARS = 20_000;

function sortMainThreads(threads: MainThreadSummary[]): MainThreadSummary[] {
  return [...threads].sort((left, right) => {
    if (left.isPinned !== right.isPinned) {
      return Number(right.isPinned) - Number(left.isPinned);
    }
    const delta =
      new Date(right.lastMessageAt).getTime() -
      new Date(left.lastMessageAt).getTime();
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return right.lastMessageAt.localeCompare(left.lastMessageAt);
  });
}

function ThreadPinIcon(): JSX.Element {
  return (
    <span className="thread-pin-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" focusable="false">
        <path
          d="M10.9 1.8a.75.75 0 0 1 1.06 0l2.24 2.24a.75.75 0 0 1 0 1.06L12.7 6.6v2.02a.75.75 0 0 1-.22.53L9.9 11.73v2.77a.75.75 0 0 1-1.28.53l-1.8-1.8a.75.75 0 0 1-.22-.53v-.97H5.6a.75.75 0 0 1-.53-.22l-1.8-1.8a.75.75 0 0 1 .53-1.28h2.77l2.58-2.58a.75.75 0 0 1 .53-.22h2.02l1.2-1.2-1.18-1.18-1.2 1.2H8.5a.75.75 0 0 1-.53-.22L6.3 2.56a.75.75 0 0 1 0-1.06l1.8-1.8a.75.75 0 0 1 1.06 0l1.74 1.74h.02Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

// ============================================================================
// Reducer
// ============================================================================

function mainReducer(state: MainState, action: MainAction): MainState {
  switch (action.type) {
    case 'THREADS_LOADING':
      return { ...state, threadsLoading: true, threadsError: null };
    case 'THREADS_LOADED':
      return {
        ...state,
        threads: action.threads,
        threadsLoading: false,
        threadsError: null,
      };
    case 'THREADS_ERROR':
      return { ...state, threadsLoading: false, threadsError: action.message };
    case 'THREAD_REMOVED':
      return {
        ...state,
        threads: state.threads.filter(
          (thread) => thread.threadId !== action.threadId,
        ),
        activeThreadId:
          state.activeThreadId === action.threadId
            ? null
            : state.activeThreadId,
        messages:
          state.activeThreadId === action.threadId ? [] : state.messages,
        messagesLoading:
          state.activeThreadId === action.threadId
            ? false
            : state.messagesLoading,
        messagesError:
          state.activeThreadId === action.threadId ? null : state.messagesError,
        liveResponses:
          state.activeThreadId === action.threadId ? {} : state.liveResponses,
      };
    case 'THREAD_SELECTED':
      return {
        ...state,
        activeThreadId: action.threadId,
        messages: [],
        messagesLoading: true,
        messagesError: null,
        liveResponses: {},
      };
    case 'THREAD_UPDATED':
      return {
        ...state,
        threads: state.threads.map((thread) =>
          thread.threadId === action.threadId
            ? {
                ...thread,
                title: action.title,
                isPinned: action.isPinned,
              }
            : thread,
        ),
      };
    case 'MESSAGES_LOADING':
      return { ...state, messagesLoading: true, messagesError: null };
    case 'MESSAGES_LOADED':
      return {
        ...state,
        messages: action.messages,
        messagesLoading: false,
        messagesError: null,
      };
    case 'MESSAGES_ERROR':
      return {
        ...state,
        messagesLoading: false,
        messagesError: action.message,
      };
    case 'MESSAGES_LOADED_FOR_THREAD':
      // Only apply if the user hasn't navigated away — drop stale results
      if (action.threadId !== state.activeThreadId) return state;
      return {
        ...state,
        messages: action.messages,
        messagesLoading: false,
        messagesError: null,
      };
    case 'MESSAGE_APPENDED': {
      // Deduplicate
      if (state.messages.some((m) => m.id === action.message.id)) return state;

      const tid = action.message.threadId;
      const ts = action.message.createdAt;

      // Update thread list: bump existing entry or insert new one
      const knownThread = state.threads.some((t) => t.threadId === tid);
      const threads = knownThread
        ? state.threads.map((t) =>
            t.threadId === tid
              ? {
                  ...t,
                  title:
                    t.title ||
                    (action.message.role === 'user'
                      ? inferThreadTitleFromContent(action.message.content)
                      : t.title),
                  lastMessageAt: ts,
                  messageCount: t.messageCount + 1,
                }
              : t,
          )
        : [
            {
              threadId: tid,
              title:
                action.message.role === 'user'
                  ? inferThreadTitleFromContent(action.message.content)
                  : null,
              isPinned: false,
              lastMessageAt: ts,
              messageCount: 1,
            },
            ...state.threads,
          ];

      // Not the active thread — only update thread list
      if (tid !== state.activeThreadId) {
        return { ...state, threads };
      }

      // Active thread — also append message and clear matching live response
      const messages = [...state.messages, action.message];
      const liveResponses = { ...state.liveResponses };
      for (const [runId, lr] of Object.entries(liveResponses)) {
        if (lr.threadId === tid && action.message.role === 'assistant') {
          delete liveResponses[runId];
        }
      }
      return { ...state, threads, messages, liveResponses };
    }
    case 'RESPONSE_STARTED':
      if (action.event.threadId !== state.activeThreadId) return state;
      return {
        ...state,
        liveResponses: {
          ...state.liveResponses,
          [action.event.runId]: {
            runId: action.event.runId,
            threadId: action.event.threadId,
            rawText: '',
            text: '',
            agentName: action.event.agentName,
            startedAt: Date.now(),
          },
        },
      };
    case 'RESPONSE_DELTA': {
      if (action.event.threadId !== state.activeThreadId) return state;
      const existing = state.liveResponses[action.event.runId];
      const rawText = `${existing?.rawText || ''}${action.event.text}`;
      return {
        ...state,
        liveResponses: {
          ...state.liveResponses,
          [action.event.runId]: {
            runId: action.event.runId,
            threadId: action.event.threadId,
            rawText,
            text: stripInternalAssistantText(rawText),
            agentName: existing?.agentName,
            startedAt: existing?.startedAt || Date.now(),
          },
        },
      };
    }
    case 'RESPONSE_COMPLETED': {
      const liveResponses = { ...state.liveResponses };
      delete liveResponses[action.runId];
      return { ...state, liveResponses };
    }
    case 'RESPONSE_FAILED': {
      if (action.event.threadId !== state.activeThreadId) return state;
      const existing = state.liveResponses[action.event.runId];
      return {
        ...state,
        liveResponses: {
          ...state.liveResponses,
          [action.event.runId]: {
            runId: action.event.runId,
            threadId: action.event.threadId,
            rawText: existing?.rawText || '',
            text: existing?.text || '',
            agentName: existing?.agentName,
            errorMessage: action.event.errorMessage,
            terminalStatus: 'failed',
            startedAt: existing?.startedAt || Date.now(),
          },
        },
      };
    }
    case 'STREAM_STATE':
      return { ...state, streamState: action.state };
    case 'SEND_STARTED':
      return { ...state, sendState: 'posting', sendError: null };
    case 'SEND_FAILED':
      return { ...state, sendState: 'error', sendError: action.message };
    case 'SEND_CLEARED':
      return { ...state, sendState: 'idle', sendError: null };
    case 'NEW_THREAD_CREATED': {
      // Merge-or-insert: if SSE already inserted this thread via MESSAGE_APPENDED, update it; otherwise prepend.
      const alreadyExists = state.threads.some(
        (t) => t.threadId === action.threadId,
      );
      const threads = alreadyExists
        ? state.threads.map((t) =>
            t.threadId === action.threadId
              ? {
                  ...t,
                  title: action.threadSummary.title,
                  lastMessageAt: action.threadSummary.lastMessageAt,
                  messageCount: Math.max(
                    t.messageCount,
                    action.threadSummary.messageCount,
                  ),
                }
              : t,
          )
        : [action.threadSummary, ...state.threads];
      return {
        ...state,
        threads,
        activeThreadId: action.threadId,
        messages: [],
        messagesLoading: false,
        messagesError: null,
        liveResponses: {},
      };
    }
    case 'CLEAR_THREAD':
      return {
        ...state,
        activeThreadId: null,
        messages: [],
        messagesLoading: false,
        messagesError: null,
        liveResponses: {},
      };
    default:
      return state;
  }
}

// ============================================================================
// Component
// ============================================================================

export function MainChannelPage({
  onUnauthorized,
}: {
  onUnauthorized: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const { threadId: routeThreadId } = useParams<{ threadId?: string }>();
  const [state, dispatch] = useReducer(mainReducer, createInitialState());
  const [draft, setDraft] = useState('');
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [threadMenu, setThreadMenu] = useState<{
    threadId: string;
    x: number;
    y: number;
  } | null>(null);

  // ── Auto-scroll ──
  const isNearBottom = useCallback(() => {
    const container = timelineRef.current;
    if (!container) return true;
    return (
      container.scrollHeight - container.scrollTop - container.clientHeight <
      SCROLL_STICK_THRESHOLD_PX
    );
  }, []);

  const scrollToBottom = useCallback(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  // ── Load threads ──
  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'THREADS_LOADING' });
    listMainThreads()
      .then((threads) => {
        if (cancelled) return;
        dispatch({ type: 'THREADS_LOADED', threads });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        dispatch({ type: 'THREADS_ERROR', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  // ── Sync route threadId ──
  useEffect(() => {
    if (state.threadsLoading) return;
    if (!routeThreadId) {
      if (state.activeThreadId) {
        dispatch({ type: 'CLEAR_THREAD' });
      }
      return;
    }

    const isKnownThread = state.threads.some(
      (thread) => thread.threadId === routeThreadId,
    );
    if (!isKnownThread) {
      if (state.activeThreadId) {
        dispatch({ type: 'CLEAR_THREAD' });
      }
      navigate('/app/main', { replace: true });
      return;
    }

    if (routeThreadId !== state.activeThreadId) {
      dispatch({ type: 'THREAD_SELECTED', threadId: routeThreadId });
    }
  }, [
    navigate,
    routeThreadId,
    state.activeThreadId,
    state.threads,
    state.threadsLoading,
  ]);

  // Keep ref in sync for use in SSE callbacks (avoids SSE effect depending on activeThreadId)
  activeThreadIdRef.current = state.activeThreadId;

  // ── Load messages when activeThreadId changes ──
  useEffect(() => {
    if (!state.activeThreadId) return;
    const threadId = state.activeThreadId;
    let cancelled = false;
    dispatch({ type: 'MESSAGES_LOADING' });
    getMainThread(threadId)
      .then((messages) => {
        if (cancelled) return;
        dispatch({ type: 'MESSAGES_LOADED', messages });
        // Scroll to bottom after messages load
        requestAnimationFrame(() => scrollToBottom());
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          dispatch({ type: 'THREAD_REMOVED', threadId });
          navigate('/app/main', { replace: true });
          return;
        }
        dispatch({ type: 'MESSAGES_ERROR', message: String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate, onUnauthorized, scrollToBottom, state.activeThreadId]);

  // ── SSE Stream ──
  useEffect(() => {
    const handle = openMainStream({
      onMessageAppended: (event: MainMessageAppendedEvent) => {
        const message: MainThreadMessage = {
          id: event.messageId,
          threadId: event.threadId,
          role: event.role,
          content: event.content || '',
          agentId: event.agentId || null,
          createdBy: event.createdBy,
          createdAt: event.createdAt || new Date().toISOString(),
        };
        dispatch({ type: 'MESSAGE_APPENDED', message });
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
        }
      },
      onResponseStarted: (event) => {
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onResponseDelta: (event) => {
        dispatch({ type: 'RESPONSE_DELTA', event });
        if (isNearBottom()) {
          requestAnimationFrame(() => scrollToBottom());
        }
      },
      onResponseCompleted: (event) => {
        dispatch({
          type: 'RESPONSE_COMPLETED',
          runId: event.runId,
          threadId: event.threadId,
        });
      },
      onResponseFailed: (event) => {
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onStateChange: (streamState) => {
        dispatch({ type: 'STREAM_STATE', state: streamState });
      },
      onReplayGap: () => {
        // Re-fetch messages for active thread on replay gap (read from ref to avoid dep on activeThreadId).
        // Dispatch with threadId so the reducer drops stale results if the user navigated away.
        const tid = activeThreadIdRef.current;
        if (tid) {
          getMainThread(tid)
            .then((messages) =>
              dispatch({
                type: 'MESSAGES_LOADED_FOR_THREAD',
                threadId: tid,
                messages,
              }),
            )
            .catch(() => {});
        }
      },
      onUnauthorized,
    });

    return () => handle.close();
  }, [onUnauthorized, isNearBottom, scrollToBottom]);

  // ── Send message ──
  const handleSend = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const content = draft.trim();
      if (!content || state.sendState === 'posting') return;

      dispatch({ type: 'SEND_STARTED' });
      setDraft('');

      try {
        const result = await postMainMessage({
          content,
          threadId: state.activeThreadId || undefined,
        });

        if (!state.activeThreadId) {
          // New thread — add to thread list and navigate
          dispatch({
            type: 'NEW_THREAD_CREATED',
            threadId: result.threadId,
            threadSummary: {
              threadId: result.threadId,
              title: result.title || inferThreadTitleFromContent(content),
              isPinned: false,
              lastMessageAt: new Date().toISOString(),
              messageCount: 1,
            },
          });
          navigate(`/app/main/${result.threadId}`, { replace: true });
        }

        dispatch({ type: 'SEND_CLEARED' });
        requestAnimationFrame(() => scrollToBottom());
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        const msg =
          err instanceof ApiError && err.code === 'thread_busy'
            ? 'Thread is busy — wait for the current response to finish.'
            : err instanceof Error
              ? err.message
              : 'Failed to send message';
        dispatch({ type: 'SEND_FAILED', message: msg });
        setDraft(content); // Restore draft
      }
    },
    [
      draft,
      state.sendState,
      state.activeThreadId,
      navigate,
      onUnauthorized,
      scrollToBottom,
    ],
  );

  // ── Thread selection ──
  const selectThread = useCallback(
    (threadId: string) => {
      navigate(`/app/main/${threadId}`);
    },
    [navigate],
  );

  const openThreadMenu = useCallback(
    (threadId: string, x: number, y: number) => {
      setThreadMenu({ threadId, x, y });
    },
    [],
  );

  const handleThreadContextMenu = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const threadId = event.currentTarget.dataset.threadId;
      if (!threadId) return;
      event.preventDefault();
      openThreadMenu(threadId, event.clientX, event.clientY);
    },
    [openThreadMenu],
  );

  const startNewThread = useCallback(() => {
    navigate('/app/main');
    dispatch({ type: 'CLEAR_THREAD' });
    setDraft('');
  }, [navigate]);

  // ── Build timeline entries ──
  const timeline = useMemo(() => {
    const entries: Array<
      | { kind: 'message'; message: MainThreadMessage }
      | { kind: 'live'; response: LiveResponse }
    > = [];
    for (const message of state.messages) {
      entries.push({ kind: 'message', message });
    }
    for (const response of Object.values(state.liveResponses)) {
      entries.push({ kind: 'live', response });
    }
    return entries;
  }, [state.messages, state.liveResponses]);

  // ── Stream badge ──
  const streamBadgeClass = `stream-badge stream-${state.streamState}`;
  const streamBadgeLabel =
    state.streamState === 'live'
      ? 'Connected'
      : state.streamState === 'connecting'
        ? 'Connecting…'
        : state.streamState === 'reconnecting'
          ? 'Reconnecting…'
          : 'Offline';

  // ── Textarea auto-resize ──
  const handleDraftChange = useCallback((value: string) => {
    if (value.length <= MAIN_MESSAGE_MAX_CHARS) {
      setDraft(value);
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, []);

  // ── Keyboard submit (Enter without Shift) ──
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (draft.trim() && state.sendState !== 'posting') {
          void handleSend(event as unknown as FormEvent);
        }
      }
    },
    [draft, state.sendState, handleSend],
  );

  // ── Sorted threads (most recent first) ──
  const sortedThreads = useMemo(
    () => sortMainThreads(state.threads),
    [state.threads],
  );
  const activeThread = useMemo(
    () =>
      sortedThreads.find(
        (thread) => thread.threadId === state.activeThreadId,
      ) || null,
    [sortedThreads, state.activeThreadId],
  );
  const menuThread = useMemo(
    () =>
      threadMenu
        ? state.threads.find((thread) => thread.threadId === threadMenu.threadId) ||
          null
        : null,
    [state.threads, threadMenu],
  );

  const updateThreadMetadata = useCallback(
    async (
      threadId: string,
      patch: {
        title?: string;
        pinned?: boolean;
      },
    ) => {
      try {
        const updated = await updateMainThread({
          threadId,
          ...patch,
        });
        dispatch({
          type: 'THREAD_UPDATED',
          threadId: updated.threadId,
          title: updated.title,
          isPinned: updated.isPinned,
        });
        dispatch({ type: 'SEND_CLEARED' });
        return updated;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        throw err;
      }
    },
    [onUnauthorized],
  );

  const handleRenameThread = useCallback(
    async (threadId: string, title: string) => {
      await updateThreadMetadata(threadId, { title });
      setEditingThreadId((current) => (current === threadId ? null : current));
    },
    [updateThreadMetadata],
  );

  const handleDeleteThread = useCallback(
    async (thread: MainThreadSummary) => {
      const confirmed = window.confirm(
        `Delete "${displayThreadTitle(thread.title)}"? This will permanently remove the thread and its messages.`,
      );
      if (!confirmed) return;
      try {
        await deleteMainThread(thread.threadId);
        const remaining = sortMainThreads(
          state.threads.filter(
            (candidate) => candidate.threadId !== thread.threadId,
          ),
        );
        dispatch({ type: 'THREAD_REMOVED', threadId: thread.threadId });
        setEditingThreadId((current) =>
          current === thread.threadId ? null : current,
        );
        if (state.activeThreadId === thread.threadId) {
          navigate(
            remaining[0] ? `/app/main/${remaining[0].threadId}` : '/app/main',
          );
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        dispatch({
          type: 'THREADS_ERROR',
          message:
            err instanceof Error ? err.message : 'Failed to delete thread.',
        });
      }
    },
    [navigate, onUnauthorized, state.activeThreadId, state.threads],
  );

  const hasActiveThread = !!routeThreadId;

  return (
    <div className="main-channel-shell">
      {/* Thread List Sidebar */}
      <aside className="main-thread-list" aria-label="Threads">
        <div className="main-thread-list-header">
          <h2>Main (Nanoclaw)</h2>
          <ThreadStartButton onClick={startNewThread} />
        </div>

        {state.threadsLoading ? (
          <p className="main-thread-list-empty">Loading threads…</p>
        ) : state.threadsError ? (
          <p className="main-thread-list-empty">{state.threadsError}</p>
        ) : sortedThreads.length === 0 ? (
          <p className="main-thread-list-empty">
            No threads yet. Start a conversation below.
          </p>
        ) : (
          <ul className="main-thread-items">
            {sortedThreads.map((thread) => (
              <li key={thread.threadId}>
                {editingThreadId === thread.threadId ? (
                  <div
                    className={`main-thread-item${
                      thread.threadId === state.activeThreadId
                        ? ' main-thread-item-active'
                        : ''
                    } main-thread-item-editing`}
                    data-thread-id={thread.threadId}
                    onContextMenu={handleThreadContextMenu}
                  >
                    <ThreadRowTitleEditor
                      title={displayThreadTitle(thread.title)}
                      isEditing={true}
                      onSave={(title) =>
                        handleRenameThread(thread.threadId, title)
                      }
                      onCancel={() => setEditingThreadId(null)}
                      staticClassName="main-thread-item-title"
                      inputClassName="thread-row-title-input"
                      errorClassName="thread-row-title-error"
                      leadingVisual={
                        thread.isPinned ? <ThreadPinIcon /> : undefined
                      }
                    />
                    <span className="main-thread-item-meta">
                      {thread.messageCount} msg ·{' '}
                      {formatRelativeTime(thread.lastMessageAt)}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    className={`main-thread-item${
                      thread.threadId === state.activeThreadId
                        ? ' main-thread-item-active'
                        : ''
                    }`}
                    data-thread-id={thread.threadId}
                    onClick={() => selectThread(thread.threadId)}
                    onContextMenu={handleThreadContextMenu}
                  >
                    <ThreadRowTitleEditor
                      title={displayThreadTitle(thread.title)}
                      isEditing={false}
                      onSave={() => undefined}
                      onCancel={() => undefined}
                      staticClassName="main-thread-item-title"
                      inputClassName="thread-row-title-input"
                      errorClassName="thread-row-title-error"
                      leadingVisual={
                        thread.isPinned ? <ThreadPinIcon /> : undefined
                      }
                    />
                    <span className="main-thread-item-meta">
                      {thread.messageCount} msg ·{' '}
                      {formatRelativeTime(thread.lastMessageAt)}
                    </span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>

      {/* Thread Detail */}
      <div className="main-thread-detail">
        <header className="main-thread-detail-header">
          <div className="main-thread-detail-title">
            {hasActiveThread ? (
              activeThread ? (
                <InlineEditableTitle
                  title={displayThreadTitle(activeThread.title)}
                  onSave={(title) =>
                    handleRenameThread(activeThread.threadId, title)
                  }
                  buttonClassName="thread-detail-title-button"
                  inputClassName="thread-detail-title-input"
                  errorClassName="thread-detail-title-error"
                />
              ) : (
                <span>{displayThreadTitle(null)}</span>
              )
            ) : (
              <span>New thread</span>
            )}
          </div>
          <span className={streamBadgeClass}>{streamBadgeLabel}</span>
        </header>

        <div className="main-thread-timeline" ref={timelineRef}>
          {state.messagesLoading ? (
            <p className="page-state">Loading messages…</p>
          ) : state.messagesError ? (
            <p className="page-state">{state.messagesError}</p>
          ) : !hasActiveThread && timeline.length === 0 ? (
            <div className="main-empty-state">
              <h3>Nanoclaw</h3>
              <p>
                Your primary everyday AI surface. Ask anything — Nanoclaw has
                web search and web fetch tools available.
              </p>
            </div>
          ) : timeline.length === 0 ? (
            <p className="page-state">No messages yet.</p>
          ) : (
            timeline.map((entry) => {
              if (entry.kind === 'message') {
                const { message } = entry;
                return (
                  <article
                    key={message.id}
                    className={`message message-${message.role}`}
                  >
                    <header>
                      <strong>{message.role}</strong>
                      <time>
                        {new Date(message.createdAt).toLocaleString()}
                      </time>
                    </header>
                    <p>
                      {message.role === 'assistant'
                        ? stripInternalAssistantText(message.content)
                        : message.content}
                    </p>
                  </article>
                );
              }

              const { response } = entry;
              return (
                <article
                  key={`live-${response.runId}`}
                  className={`message message-assistant message-live${
                    response.terminalStatus === 'failed' ? ' message-error' : ''
                  }`}
                >
                  <header>
                    <strong>{response.agentName || 'Nanoclaw'}</strong>
                    <time>
                      {response.terminalStatus === 'failed'
                        ? 'Failed'
                        : 'Streaming…'}
                    </time>
                  </header>
                  <p>{response.text || 'Thinking…'}</p>
                  {response.errorMessage ? (
                    <p className="run-history-error">{response.errorMessage}</p>
                  ) : null}
                </article>
              );
            })
          )}
          <div ref={endRef} />
        </div>

        {/* Composer */}
        <form className="main-composer" onSubmit={handleSend}>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => handleDraftChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Nanoclaw…"
            rows={1}
            disabled={state.sendState === 'posting'}
          />
          <button
            type="submit"
            className="main-send-btn"
            disabled={!draft.trim() || state.sendState === 'posting'}
          >
            {state.sendState === 'posting' ? 'Sending…' : 'Send'}
          </button>
        </form>
        {state.sendState === 'error' && state.sendError ? (
          <p className="main-send-error">{state.sendError}</p>
        ) : null}
        {threadMenu && menuThread ? (
          <ThreadContextMenu
            x={threadMenu.x}
            y={threadMenu.y}
            isPinned={menuThread.isPinned}
            onClose={() => setThreadMenu(null)}
            onRename={() => setEditingThreadId(menuThread.threadId)}
            onTogglePin={() => {
              void updateThreadMetadata(menuThread.threadId, {
                pinned: !menuThread.isPinned,
              }).catch((err) => {
                dispatch({
                  type: 'THREADS_ERROR',
                  message:
                    err instanceof Error
                      ? err.message
                      : 'Failed to update thread.',
                });
              });
            }}
            onDelete={() => void handleDeleteThread(menuThread)}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Helpers ──

function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
