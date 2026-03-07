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
  AgentProviderCard,
  AiAgentsPageData,
  ApiError,
  cancelTalkRuns,
  getAiAgents,
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

type AgentCreationDraft = {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  role: TalkAgent['role'];
};

type TalkAgentSourceOption = {
  id: string;
  label: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
};

const TALK_AGENT_ROLE_OPTIONS: TalkAgent['role'][] = [
  'assistant',
  'analyst',
  'critic',
  'strategist',
  'devils-advocate',
  'synthesizer',
  'editor',
];

function formatTalkRole(role: TalkAgent['role']): string {
  switch (role) {
    case 'assistant':
      return 'General';
    case 'analyst':
      return 'Analyst';
    case 'critic':
      return 'Critic';
    case 'strategist':
      return 'Strategist';
    case 'devils-advocate':
      return "Devil's Advocate";
    case 'synthesizer':
      return 'Synthesizer';
    case 'editor':
      return 'Editor';
    default:
      return role;
  }
}

function buildAgentDisplayName(agent: Pick<
  TalkAgent,
  'sourceKind' | 'providerName' | 'modelId' | 'modelDisplayName' | 'name'
>): string {
  if (agent.modelDisplayName?.trim()) {
    return agent.modelDisplayName.trim();
  }
  if (agent.modelId?.trim()) {
    return agent.modelId.trim();
  }
  if (agent.sourceKind === 'claude_default') {
    return 'Claude';
  }
  return agent.providerName?.trim() || agent.name || 'Provider';
}

function buildTalkAgentLabels(agents: TalkAgent[]): Record<string, string> {
  const counts = new Map<string, number>();
  const nextIndex = new Map<string, number>();

  for (const agent of agents) {
    const base = `${buildAgentDisplayName(agent)} · ${formatTalkRole(agent.role)}`;
    counts.set(base, (counts.get(base) || 0) + 1);
  }

  const labels: Record<string, string> = {};
  for (const agent of agents) {
    const base = `${buildAgentDisplayName(agent)} · ${formatTalkRole(agent.role)}`;
    if ((counts.get(base) || 0) > 1) {
      const index = (nextIndex.get(base) || 0) + 1;
      nextIndex.set(base, index);
      labels[agent.id] = `${base} #${index}`;
    } else {
      labels[agent.id] = base;
    }
  }

  return labels;
}

function buildAgentCreationDraft(input: {
  claudeModelSuggestions: AiAgentsPageData['claudeModelSuggestions'];
  providers: AgentProviderCard[];
  sourceKind?: 'claude_default' | 'provider';
  providerId?: string | null;
}): AgentCreationDraft {
  if (input.sourceKind === 'provider') {
    const selectedProvider =
      input.providers.find((provider) => provider.id === input.providerId) ||
      input.providers[0] ||
      null;
    const firstSuggestion = selectedProvider?.modelSuggestions[0] || null;
    return {
      sourceKind: 'provider',
      providerId: selectedProvider?.id || null,
      modelId: firstSuggestion?.modelId || '',
      role: 'assistant',
    };
  }

  const firstClaudeModel = input.claudeModelSuggestions[0] || null;
  return {
    sourceKind: 'claude_default',
    providerId: null,
    modelId: firstClaudeModel?.modelId || '',
    role: 'assistant',
  };
}

function buildTalkAgentSourceOptions(input: {
  providers: AgentProviderCard[];
}): TalkAgentSourceOption[] {
  return [
    {
      id: 'claude_default',
      label: 'Claude',
      sourceKind: 'claude_default',
      providerId: null,
    },
    ...input.providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      sourceKind: 'provider' as const,
      providerId: provider.id,
    })),
  ];
}

function getModelSuggestionsForSource(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  aiAgents: AiAgentsPageData | null;
}): Array<{
  modelId: string;
  displayName: string;
}> {
  if (!input.aiAgents) return [];
  if (input.sourceKind === 'claude_default') {
    return input.aiAgents.claudeModelSuggestions.map((model) => ({
      modelId: model.modelId,
      displayName: model.displayName,
    }));
  }

  const provider = input.aiAgents.additionalProviders.find(
    (entry) => entry.id === input.providerId,
  );
  return (provider?.modelSuggestions || []).map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
  }));
}

function normalizeAgentSelection(input: {
  agent: TalkAgent;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string;
  aiAgents: AiAgentsPageData | null;
}): Partial<TalkAgent> {
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents: input.aiAgents,
  });
  const selectedModel =
    suggestions.find((entry) => entry.modelId === input.modelId) ||
    suggestions[0] ||
    null;
  const providerName =
    input.sourceKind === 'provider'
      ? input.aiAgents?.additionalProviders.find(
          (provider) => provider.id === input.providerId,
        )?.name || null
      : 'Anthropic';

  return {
    sourceKind: input.sourceKind,
    providerId: input.sourceKind === 'provider' ? input.providerId : null,
    providerName,
    modelId: selectedModel?.modelId || input.modelId || null,
    modelDisplayName:
      selectedModel?.displayName ||
      (input.modelId ? input.modelId : input.agent.modelDisplayName),
    status: input.agent.status,
    name:
      input.sourceKind === 'claude_default'
        ? 'Claude'
        : providerName || input.agent.name,
  };
}

function isTalkAgentRole(value: unknown): value is TalkAgent['role'] {
  return (
    typeof value === 'string' &&
    TALK_AGENT_ROLE_OPTIONS.includes(value as TalkAgent['role'])
  );
}

function normalizeTalkAgent(
  input: Partial<TalkAgent> & {
    personaRole?: unknown;
    isPrimary?: unknown;
    sortOrder?: unknown;
  },
  index: number,
): TalkAgent {
  const sourceKind =
    input.sourceKind === 'claude_default' || input.sourceKind === 'provider'
      ? input.sourceKind
      : 'claude_default';
  return {
    id:
      typeof input.id === 'string' && input.id.trim()
        ? input.id
        : `agent-${index}`,
    name:
      typeof input.name === 'string' && input.name.trim()
        ? input.name
        : sourceKind === 'claude_default'
          ? 'Claude'
          : 'Provider',
    sourceKind,
    role: isTalkAgentRole(input.role)
      ? input.role
      : isTalkAgentRole(input.personaRole)
        ? input.personaRole
        : 'assistant',
    isLead:
      input.isLead === true ||
      input.isPrimary === true ||
      (index === 0 && input.isLead !== false && input.isPrimary !== false),
    displayOrder:
      typeof input.displayOrder === 'number'
        ? input.displayOrder
        : typeof input.sortOrder === 'number'
          ? input.sortOrder
          : index,
    status:
      input.status === 'active' || input.status === 'archived'
        ? input.status
        : 'active',
    providerId: typeof input.providerId === 'string' ? input.providerId : null,
    providerName:
      typeof input.providerName === 'string' ? input.providerName : null,
    modelId: typeof input.modelId === 'string' ? input.modelId : null,
    modelDisplayName:
      typeof input.modelDisplayName === 'string' ? input.modelDisplayName : null,
  };
}

function normalizeTalkAgents(input: TalkAgent[]): TalkAgent[] {
  return input
    .map((agent, index) => normalizeTalkAgent(agent, index))
    .sort((left, right) => left.displayOrder - right.displayOrder);
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
  const [aiAgentsData, setAiAgentsData] = useState<AiAgentsPageData | null>(null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderCard[]>([]);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [agentsCatalogError, setAgentsCatalogError] = useState<string | null>(null);
  const [newAgentDraft, setNewAgentDraft] = useState<AgentCreationDraft>({
    sourceKind: 'claude_default',
    providerId: null,
    modelId: '',
    role: 'assistant',
  });
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
    setAiAgentsData(null);
    setAgentProviders([]);
    setAgentsCatalogError(null);
    setTargetAgentId(null);
    setNewAgentDraft({
      sourceKind: 'claude_default',
      providerId: null,
      modelId: '',
      role: 'assistant',
    });
    setAgentState({ status: 'idle' });

    const load = async () => {
      try {
        const [talk, messages, rawAgents] = await Promise.all([
          getTalk(talkId),
          listTalkMessages(talkId),
          getTalkAgents(talkId),
        ]);
        if (!cancelled) {
          const nextAgents = normalizeTalkAgents(rawAgents);
          setAgents(nextAgents);
          setAgentDrafts(nextAgents);
          setTargetAgentId(null);
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
    let cancelled = false;

    const loadAiAgents = async () => {
      try {
        const next = await getAiAgents();
        if (cancelled) return;
        const nextProviders = next.additionalProviders.filter(
          (provider) => provider.hasCredential,
        );
        setAiAgentsData(next);
        setAgentProviders(nextProviders);
        setAgentsCatalogError(null);
        setNewAgentDraft((current) =>
          current.modelId
            ? current
            : buildAgentCreationDraft({
                claudeModelSuggestions: next.claudeModelSuggestions,
                providers: nextProviders,
                sourceKind: current.sourceKind,
                providerId: current.providerId,
              }),
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setAiAgentsData(null);
          setAgentProviders([]);
          setAgentsCatalogError(
            err instanceof Error ? err.message : 'Failed to load AI agents.',
          );
        }
      }
    };

    void loadAiAgents();

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

  const applyAgentSourceSelection = (
    agentId: string,
    input: {
      sourceKind: 'claude_default' | 'provider';
      providerId: string | null;
      modelId: string;
    },
  ) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              ...normalizeAgentSelection({
                agent,
                sourceKind: input.sourceKind,
                providerId: input.providerId,
                modelId: input.modelId,
                aiAgents: aiAgentsData,
              }),
            }
          : agent,
      ),
    );
    if (agentState.status === 'error' || agentState.status === 'success') {
      setAgentState({ status: 'idle' });
    }
  };

  const handleAddAgent = () => {
    const nextAgent: TalkAgent = normalizeTalkAgent(
      {
        id: globalThis.crypto?.randomUUID?.() || `agent-${Date.now()}`,
        name: newAgentDraft.sourceKind === 'claude_default' ? 'Claude' : 'Provider',
        sourceKind: newAgentDraft.sourceKind,
        providerId: newAgentDraft.providerId,
        modelId: newAgentDraft.modelId,
        role: newAgentDraft.role,
        isLead: false,
        displayOrder: agentDrafts.length,
        status: 'active',
        ...normalizeAgentSelection({
          agent: {
            id: '',
            name: '',
            sourceKind: newAgentDraft.sourceKind,
            role: newAgentDraft.role,
            isLead: false,
            displayOrder: agentDrafts.length,
            status: 'active',
            providerId: newAgentDraft.providerId,
            providerName: null,
            modelId: newAgentDraft.modelId,
            modelDisplayName: null,
          },
          sourceKind: newAgentDraft.sourceKind,
          providerId: newAgentDraft.providerId,
          modelId: newAgentDraft.modelId,
          aiAgents: aiAgentsData,
        }),
      },
      agentDrafts.length,
    );
    if (!nextAgent.modelId) return;
    setAgentDrafts((current) => [...current, nextAgent]);
    setTargetAgentId(null);
    setAgentState({ status: 'idle' });
  };

  const handleRemoveAgent = (agentId: string) => {
    setAgentDrafts((current) => {
      const remaining = current.filter((agent) => agent.id !== agentId);
      if (remaining.length === 0) return current;
      if (!remaining.some((agent) => agent.isLead)) {
        remaining[0] = { ...remaining[0], isLead: true };
      }
      return remaining.map((agent, index) => ({
        ...agent,
        displayOrder: index,
      }));
    });
    setTargetAgentId((current) => (current === agentId ? null : current));
  };

  const handleSetLeadAgent = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isLead: agent.id === agentId,
      })),
    );
    setTargetAgentId(null);
  };

  const handleSaveAgents = async () => {
    if (state.kind !== 'ready' || !canEditAgents) return;

    setAgentState({ status: 'saving' });
    try {
      const normalized = agentDrafts.map((agent, index) => ({
        id: agent.id,
        sourceKind:
          agent.sourceKind === 'claude_default' || agent.sourceKind === 'provider'
            ? agent.sourceKind
            : 'claude_default',
        providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
        modelId: agent.modelId,
        role: agent.role,
        isLead: agent.isLead,
        displayOrder: index,
      }));
      const saved = normalizeTalkAgents(
        await updateTalkAgents({
          talkId: state.talk!.id,
          agents: normalized as TalkAgent[],
        }),
      );
      setAgents(saved);
      setAgentDrafts(saved);
      setTargetAgentId(null);
      setAgentState({
        status: 'success',
        message: 'Talk agents updated.',
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
  const savedAgentLabels = useMemo(() => buildTalkAgentLabels(agents), [agents]);
  const draftAgentLabels = useMemo(
    () => buildTalkAgentLabels(agentDrafts),
    [agentDrafts],
  );
  const sourceOptions = useMemo(
    () => buildTalkAgentSourceOptions({ providers: agentProviders }),
    [agentProviders],
  );
  const newAgentModelOptions = useMemo(
    () =>
      getModelSuggestionsForSource({
        sourceKind: newAgentDraft.sourceKind,
        providerId: newAgentDraft.providerId,
        aiAgents: aiAgentsData,
      }),
    [aiAgentsData, newAgentDraft.modelId, newAgentDraft.providerId, newAgentDraft.sourceKind],
  );
  const manageAgentsHref = `/app/agents?returnTo=${encodeURIComponent(
    `/app/talks/${talkId}`,
  )}&focus=providers`;

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
              {talk.agents.map((agent, index) => (
                <span
                  key={`${agent}-${index}`}
                  className="talk-agent-chip"
                  role="listitem"
                >
                  {agent}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <Link to="/app/talks">Back</Link>
      </header>

      <section className="policy-panel" aria-label="Talk agents">
        <h2>Talk Agents</h2>
        {agents.length > 0 ? (
          <div className="talk-agent-row">
            {agents.map((agent) => (
              <span key={agent.id} className="talk-agent-chip">
                {savedAgentLabels[agent.id] || agent.name}
                {agent.isLead ? ' · Primary' : ''}
                {agent.status !== 'active' ? ` · ${agent.status}` : ''}
              </span>
            ))}
          </div>
        ) : null}
        {canEditAgents ? (
          <div className="policy-editor">
            <p className="policy-muted">
              The primary agent responds to normal user messages. Any other
              agents are only used when you explicitly call them.
            </p>
            {agentDrafts.map((agent) => (
              <div key={agent.id} className="policy-agent-grid">
                <>
                  <label>
                    <span>Agent source</span>
                    <select
                      value={
                        agent.sourceKind === 'claude_default'
                          ? 'claude_default'
                          : agent.providerId || ''
                      }
                      onChange={(event) => {
                        const selected = sourceOptions.find(
                          (option) => option.id === event.target.value,
                        );
                        if (!selected) return;
                        const suggestions = getModelSuggestionsForSource({
                          sourceKind: selected.sourceKind,
                          providerId: selected.providerId,
                          aiAgents: aiAgentsData,
                        });
                        applyAgentSourceSelection(agent.id, {
                          sourceKind: selected.sourceKind,
                          providerId: selected.providerId,
                          modelId:
                            suggestions.find(
                              (entry) => entry.modelId === agent.modelId,
                            )?.modelId ||
                            suggestions[0]?.modelId ||
                            '',
                        });
                      }}
                      disabled={agentState.status === 'saving'}
                    >
                      {sourceOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Model</span>
                    <select
                      value={agent.modelId || ''}
                      onChange={(event) =>
                        applyAgentSourceSelection(agent.id, {
                          sourceKind:
                            agent.sourceKind === 'provider'
                              ? 'provider'
                              : 'claude_default',
                          providerId:
                            agent.sourceKind === 'provider'
                              ? agent.providerId
                              : null,
                          modelId: event.target.value,
                        })
                      }
                      disabled={agentState.status === 'saving'}
                    >
                      {getModelSuggestionsForSource({
                        sourceKind:
                          agent.sourceKind === 'provider'
                            ? 'provider'
                            : 'claude_default',
                        providerId:
                          agent.sourceKind === 'provider'
                            ? agent.providerId
                            : null,
                        aiAgents: aiAgentsData,
                      }).map((model) => (
                        <option key={model.modelId} value={model.modelId}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
                <label>
                  <span>Role</span>
                  <select
                    value={agent.role}
                    onChange={(event) =>
                      handleAgentDraftChange(agent.id, {
                        role: event.target.value as TalkAgent['role'],
                      })
                    }
                    disabled={agentState.status === 'saving'}
                  >
                    {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {formatTalkRole(role)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Preview</span>
                  <input
                    type="text"
                    value={draftAgentLabels[agent.id] || agent.name}
                    disabled
                  />
                </label>
                <label className="policy-primary-toggle">
                  <input
                    type="radio"
                    name="primary-talk-agent"
                    checked={agent.isLead}
                    onChange={() => handleSetLeadAgent(agent.id)}
                    disabled={agentState.status === 'saving'}
                  />
                  <span>Primary Agent</span>
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
              <label className="policy-add-agent">
                <span>Source</span>
                <select
                  value={
                    newAgentDraft.sourceKind === 'claude_default'
                      ? 'claude_default'
                      : newAgentDraft.providerId || ''
                  }
                  onChange={(event) => {
                    const selected = sourceOptions.find(
                      (option) => option.id === event.target.value,
                    );
                    if (!selected) return;
                    setNewAgentDraft(
                      buildAgentCreationDraft({
                        claudeModelSuggestions:
                          aiAgentsData?.claudeModelSuggestions || [],
                        providers: agentProviders,
                        sourceKind: selected.sourceKind,
                        providerId: selected.providerId,
                      }),
                    );
                  }}
                  disabled={agentState.status === 'saving'}
                >
                  {sourceOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="policy-add-agent">
                <span>Model</span>
                <select
                  value={newAgentDraft.modelId}
                  onChange={(event) =>
                    setNewAgentDraft((current) => ({
                      ...current,
                      modelId: event.target.value,
                    }))
                  }
                  disabled={agentState.status === 'saving'}
                >
                  {newAgentModelOptions.map((model) => (
                    <option key={model.modelId} value={model.modelId}>
                      {model.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label className="policy-add-agent">
                <span>Role</span>
                <select
                  value={newAgentDraft.role}
                  onChange={(event) =>
                    setNewAgentDraft((current) => ({
                      ...current,
                      role: event.target.value as TalkAgent['role'],
                    }))
                  }
                  disabled={agentState.status === 'saving'}
                >
                  {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                    <option key={role} value={role}>
                      {formatTalkRole(role)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-btn"
                onClick={handleAddAgent}
                disabled={
                  agentState.status === 'saving' || !newAgentDraft.modelId
                }
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
              <Link className="secondary-btn" to={manageAgentsHref}>
                Manage AI Agents
              </Link>
            </div>
            {agentsCatalogError ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {agentsCatalogError}
              </div>
            ) : null}
            {sourceOptions.length <= 1 ? (
              <div className="inline-banner inline-banner-warning" role="status">
                <span>
                  Claude is ready, but no additional provider keys are
                  configured yet.
                </span>
                <Link to={manageAgentsHref}>Open AI Agents</Link>
              </div>
            ) : null}
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
          <span>Called agent</span>
          <select
            value={targetAgentId || ''}
            onChange={(event) => setTargetAgentId(event.target.value || null)}
            disabled={state.sendState.status === 'posting' || agents.length === 0}
          >
            <option value="">Primary Agent (default)</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {savedAgentLabels[agent.id] || agent.name}
                {agent.isLead ? ' (Primary)' : ''}
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
