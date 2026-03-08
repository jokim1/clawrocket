import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import {
  AgentProviderCard,
  AiAgentsPageData,
  ApiError,
  cancelTalkRuns,
  getAiAgents,
  getTalk,
  getTalkAgents,
  getTalkRuns,
  listTalkMessages,
  sendTalkMessage,
  Talk,
  TalkAgent,
  TalkMessage,
  TalkRun,
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

type TabKey = 'talk' | 'agents' | 'runs';

type RunView = TalkRun & {
  updatedAt: number;
};

type LiveResponseView = {
  runId: string;
  text: string;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  errorMessage?: string;
  startedAt: number;
  terminalStatus?: 'failed';
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
  liveResponsesByRunId: Record<string, LiveResponseView>;
  cancelState: {
    status: 'idle' | 'posting' | 'success' | 'error';
    message?: string;
  };
  hasUnreadBelow: boolean;
  initialScrollPending: boolean;
};

type DetailAction =
  | { type: 'BOOTSTRAP_LOADING' }
  | {
      type: 'BOOTSTRAP_READY';
      talk: Talk;
      messages: TalkMessage[];
      runs: TalkRun[];
    }
  | { type: 'BOOTSTRAP_ERROR'; unavailable: boolean; message: string }
  | { type: 'RESET_FROM_RESYNC'; messages: TalkMessage[]; runs: TalkRun[] }
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
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
    }
  | {
      type: 'RUN_QUEUED';
      runId: string;
      triggerMessageId: string | null;
      executorAlias?: string | null;
      executorModel?: string | null;
      createdAt?: string | null;
      targetAgentId?: string | null;
      targetAgentNickname?: string | null;
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
  | { type: 'CLEAR_UNREAD' };

const SCROLL_STICK_THRESHOLD_PX = 120;
const TALK_MESSAGE_MAX_CHARS = 20_000;

const TALK_AGENT_ROLE_OPTIONS: TalkAgent['role'][] = [
  'assistant',
  'analyst',
  'critic',
  'strategist',
  'devils-advocate',
  'synthesizer',
  'editor',
];

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
    liveResponsesByRunId: {},
    cancelState: { status: 'idle' },
    hasUnreadBelow: false,
    initialScrollPending: false,
  };
}

function summarizeMessageForRun(message: TalkMessage | undefined, messageId: string): string {
  if (!message) return messageId;
  const compact = message.content.trim().replace(/\s+/g, ' ');
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  return `${message.role}: ${preview || '(empty)'}`;
}

function toRunView(run: TalkRun): RunView {
  return {
    ...run,
    updatedAt: Date.parse(run.completedAt || run.startedAt || run.createdAt) || Date.now(),
  };
}

function mapRunsById(runs: TalkRun[]): Record<string, RunView> {
  return runs.reduce<Record<string, RunView>>((acc, run) => {
    acc[run.id] = toRunView(run);
    return acc;
  }, {});
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
      createdAt: patch.createdAt ?? current?.createdAt ?? new Date(now).toISOString(),
      startedAt:
        patch.startedAt !== undefined ? patch.startedAt : current?.startedAt ?? null,
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : current?.completedAt ?? null,
      triggerMessageId:
        patch.triggerMessageId !== undefined
          ? patch.triggerMessageId
          : current?.triggerMessageId ?? null,
      targetAgentId:
        patch.targetAgentId !== undefined
          ? patch.targetAgentId
          : current?.targetAgentId ?? null,
      targetAgentNickname:
        patch.targetAgentNickname !== undefined
          ? patch.targetAgentNickname
          : current?.targetAgentNickname ?? null,
      errorCode:
        patch.errorCode !== undefined ? patch.errorCode : current?.errorCode ?? null,
      errorMessage:
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : current?.errorMessage ?? null,
      executorAlias:
        patch.executorAlias !== undefined
          ? patch.executorAlias
          : current?.executorAlias ?? null,
      executorModel:
        patch.executorModel !== undefined
          ? patch.executorModel
          : current?.executorModel ?? null,
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
        runsById: mapRunsById(action.runs),
        streamState: 'connecting',
        sendState: { status: 'idle' },
        liveResponsesByRunId: {},
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
    case 'RESET_FROM_RESYNC':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        messages: action.messages,
        messageIds: new Set(action.messages.map((message) => message.id)),
        runsById: mapRunsById(action.runs),
        liveResponsesByRunId: {},
        hasUnreadBelow: false,
        initialScrollPending: false,
      };
    case 'MESSAGE_APPENDED': {
      if (state.kind !== 'ready') return state;
      if (state.messageIds.has(action.message.id)) return state;

      const messages = [...state.messages, action.message];
      const messageIds = new Set(state.messageIds);
      messageIds.add(action.message.id);
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      if (action.message.runId) {
        delete liveResponsesByRunId[action.message.runId];
      }

      return {
        ...state,
        messages,
        messageIds,
        liveResponsesByRunId,
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
          createdAt: action.createdAt || undefined,
          startedAt: new Date().toISOString(),
          targetAgentId: action.targetAgentId,
          targetAgentNickname: action.targetAgentNickname,
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
          createdAt: action.createdAt || undefined,
          targetAgentId: action.targetAgentId,
          targetAgentNickname: action.targetAgentNickname,
        }),
      };
    case 'RUN_COMPLETED': {
      if (state.kind !== 'ready') return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.runId];
      return {
        ...state,
        liveResponsesByRunId,
        runsById: withRun(state, action.runId, {
          status: 'completed',
          triggerMessageId: action.triggerMessageId,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
          completedAt: new Date().toISOString(),
        }),
      };
    }
    case 'RUN_FAILED': {
      if (state.kind !== 'ready') return state;
      const existing = state.liveResponsesByRunId[action.runId];
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.runId]: {
            runId: action.runId,
            text: existing?.text || '',
            agentId: existing?.agentId,
            agentNickname: existing?.agentNickname,
            providerId: existing?.providerId,
            modelId: existing?.modelId,
            errorMessage: action.errorMessage,
            startedAt: existing?.startedAt || Date.now(),
            terminalStatus: 'failed',
          },
        },
        runsById: withRun(state, action.runId, {
          status: 'failed',
          triggerMessageId: action.triggerMessageId,
          errorCode: action.errorCode,
          errorMessage: action.errorMessage,
          executorAlias: action.executorAlias,
          executorModel: action.executorModel,
          completedAt: new Date().toISOString(),
        }),
      };
    }
    case 'RUN_CANCELLED_BATCH': {
      if (state.kind !== 'ready' || action.runIds.length === 0) return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      for (const runId of action.runIds) {
        delete liveResponsesByRunId[runId];
      }
      const runsById = { ...state.runsById };
      for (const runId of action.runIds) {
        runsById[runId] = {
          ...(runsById[runId] || {
            id: runId,
            status: 'cancelled',
            createdAt: new Date().toISOString(),
            startedAt: null,
            completedAt: null,
            triggerMessageId: null,
            targetAgentId: null,
            targetAgentNickname: null,
            errorCode: null,
            errorMessage: null,
            executorAlias: null,
            executorModel: null,
            updatedAt: Date.now(),
          }),
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          updatedAt: Date.now(),
        };
      }
      return { ...state, liveResponsesByRunId, runsById };
    }
    case 'RESPONSE_STARTED':
      if (state.kind !== 'ready') return state;
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            text: '',
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            startedAt: Date.now(),
          },
        },
      };
    case 'RESPONSE_DELTA': {
      if (state.kind !== 'ready') return state;
      const existing = state.liveResponsesByRunId[action.event.runId];
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            text: `${existing?.text || ''}${action.event.deltaText}`,
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: existing?.errorMessage,
            terminalStatus: existing?.terminalStatus,
          },
        },
      };
    }
    case 'RESPONSE_COMPLETED':
      return state;
    case 'RESPONSE_FAILED': {
      if (state.kind !== 'ready') return state;
      const existing = state.liveResponsesByRunId[action.event.runId];
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            text: existing?.text || '',
            agentId: action.event.agentId,
            agentNickname: action.event.agentNickname,
            providerId: action.event.providerId,
            modelId: action.event.modelId,
            startedAt: existing?.startedAt || Date.now(),
            errorMessage: action.event.errorMessage,
            terminalStatus: 'failed',
          },
        },
      };
    }
    case 'RESPONSE_CANCELLED': {
      if (state.kind !== 'ready') return state;
      const liveResponsesByRunId = { ...state.liveResponsesByRunId };
      delete liveResponsesByRunId[action.event.runId];
      return { ...state, liveResponsesByRunId };
    }
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
      return { ...state, sendState: { status: 'posting' } };
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
      return { ...state, sendState: { status: 'idle' } };
    case 'CANCEL_STARTED':
      if (state.kind !== 'ready') return state;
      return { ...state, cancelState: { status: 'posting' } };
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
    default:
      return state;
  }
}

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

function getTabFromPath(pathname: string, talkId: string): TabKey {
  const base = `/app/talks/${talkId}`;
  if (pathname === `${base}/agents`) return 'agents';
  if (pathname === `${base}/runs`) return 'runs';
  return 'talk';
}

function buildAgentLabel(agent: Pick<TalkAgent, 'nickname' | 'role'>): string {
  return `${agent.nickname} (${formatTalkRole(agent.role)})`;
}

function getConfiguredProviders(data: AiAgentsPageData | null): AgentProviderCard[] {
  if (!data) return [];
  return data.additionalProviders.filter((provider) => provider.hasCredential);
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
}): Array<{ modelId: string; displayName: string }> {
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

function buildAutoNicknameBase(input: {
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName?: string | null;
  aiAgents: AiAgentsPageData | null;
}): string {
  if (input.modelDisplayName?.trim()) return input.modelDisplayName.trim();
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents: input.aiAgents,
  });
  const found = suggestions.find((entry) => entry.modelId === input.modelId);
  if (found?.displayName) return found.displayName;
  if (input.modelId?.trim()) return input.modelId.trim();
  return input.sourceKind === 'claude_default' ? 'Claude' : 'Provider';
}

function buildUniqueNickname(
  base: string,
  agents: TalkAgent[],
  excludeId?: string,
): string {
  const used = new Set(
    agents
      .filter((agent) => agent.id !== excludeId)
      .map((agent) => agent.nickname.trim())
      .filter(Boolean),
  );
  if (!used.has(base)) return base;
  let index = 2;
  while (used.has(`${base} ${index}`)) {
    index += 1;
  }
  return `${base} ${index}`;
}

function applySourceModelSelection(
  agent: TalkAgent,
  input: {
    sourceKind: 'claude_default' | 'provider';
    providerId: string | null;
    modelId: string;
  },
  allAgents: TalkAgent[],
  aiAgents: AiAgentsPageData | null,
): TalkAgent {
  const suggestions = getModelSuggestionsForSource({
    sourceKind: input.sourceKind,
    providerId: input.providerId,
    aiAgents,
  });
  const selectedModel =
    suggestions.find((entry) => entry.modelId === input.modelId) || suggestions[0] || null;
  const modelId = selectedModel?.modelId || input.modelId || null;
  const modelDisplayName = selectedModel?.displayName || input.modelId || null;
  const nickname =
    agent.nicknameMode === 'custom'
      ? agent.nickname
      : buildUniqueNickname(
          buildAutoNicknameBase({
            sourceKind: input.sourceKind,
            providerId: input.providerId,
            modelId,
            modelDisplayName,
            aiAgents,
          }),
          allAgents,
          agent.id,
        );
  return {
    ...agent,
    sourceKind: input.sourceKind,
    providerId: input.sourceKind === 'provider' ? input.providerId : null,
    modelId,
    modelDisplayName,
    nickname,
  };
}

function buildNewAgentDraft(aiAgents: AiAgentsPageData | null): AgentCreationDraft {
  const claudeModel = aiAgents?.claudeModelSuggestions[0];
  return {
    sourceKind: 'claude_default',
    providerId: null,
    modelId: claudeModel?.modelId || '',
    role: 'assistant',
  };
}

function buildTargetSelection(agents: TalkAgent[], current: string[]): string[] {
  const valid = current.filter((id) => agents.some((agent) => agent.id === id));
  if (valid.length > 0) return valid;
  const primary = agents.find((agent) => agent.isPrimary);
  return primary ? [primary.id] : agents[0] ? [agents[0].id] : [];
}

function serializeTalkAgentForDraftCompare(agent: TalkAgent): string {
  return JSON.stringify({
    id: agent.id,
    nickname: agent.nickname,
    nicknameMode: agent.nicknameMode,
    sourceKind: agent.sourceKind,
    providerId: agent.providerId,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
    role: agent.role,
    isPrimary: agent.isPrimary,
    displayOrder: agent.displayOrder,
  });
}

function haveSameTalkAgentDraftState(left: TalkAgent[], right: TalkAgent[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      serializeTalkAgentForDraftCompare(left[index]) !==
      serializeTalkAgentForDraftCompare(right[index])
    ) {
      return false;
    }
  }
  return true;
}

export function TalkDetailPage({
  onUnauthorized,
  titleOverride,
  renameDraft,
  onRenameDraftChange,
  onRenameDraftCancel,
  onRenameDraftCommit,
}: {
  onUnauthorized: () => void;
  titleOverride?: string | null;
  renameDraft: { talkId: string; draft: string } | null;
  onRenameDraftChange: (talkId: string, draft: string) => void;
  onRenameDraftCancel: (talkId: string) => void;
  onRenameDraftCommit: (talkId: string, draft: string) => Promise<void>;
}): JSX.Element {
  const { talkId = '' } = useParams<{ talkId: string }>();
  const location = useLocation();
  const currentTab = getTabFromPath(location.pathname, talkId);
  const [state, dispatch] = useReducer(detailReducer, undefined, createInitialDetailState);
  const [draft, setDraft] = useState('');
  const [agents, setAgents] = useState<TalkAgent[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<TalkAgent[]>([]);
  const [aiAgentsData, setAiAgentsData] = useState<AiAgentsPageData | null>(null);
  const [agentsCatalogError, setAgentsCatalogError] = useState<string | null>(null);
  const [targetAgentIds, setTargetAgentIds] = useState<string[]>([]);
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
  const titleInputRef = useRef<HTMLInputElement | null>(null);
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

  const handleUnauthorized = useCallback(() => {
    onUnauthorizedRef.current();
  }, []);

  const resyncTalkState = useCallback(async () => {
    try {
      const [messages, runs] = await Promise.all([
        listTalkMessages(talkId),
        getTalkRuns(talkId),
      ]);
      dispatch({ type: 'RESET_FROM_RESYNC', messages, runs });
      autoStickToBottomRef.current = true;
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
      }
    }
  }, [handleUnauthorized, talkId]);

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'BOOTSTRAP_LOADING' });
    messageElementRefs.current.clear();
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentIds([]);
    setAgentsCatalogError(null);
    setAgentState({ status: 'idle' });

    const load = async () => {
      try {
        const [talk, messages, runs, talkAgents] = await Promise.all([
          getTalk(talkId),
          listTalkMessages(talkId),
          getTalkRuns(talkId),
          getTalkAgents(talkId),
        ]);
        if (cancelled) return;
        setAgents(talkAgents);
        setAgentDrafts(talkAgents);
        setTargetAgentIds(buildTargetSelection(talkAgents, []));
        dispatch({ type: 'BOOTSTRAP_READY', talk, messages, runs });
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
        setAiAgentsData(next);
        setAgentsCatalogError(null);
        setNewAgentDraft((current) =>
          current.modelId ? current : buildNewAgentDraft(next),
        );
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setAiAgentsData(null);
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
  }, [handleUnauthorized]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const stream = openTalkStream({
      talkId,
      onUnauthorized: handleUnauthorized,
      onMessageAppended: (event: MessageAppendedEvent) => {
        if (event.talkId !== talkId) return;
        if (!event.content || !event.createdAt) {
          void resyncTalkState();
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
            agentNickname: event.agentNickname,
            metadata: event.metadata,
          },
        });
      },
      onRunStarted: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: event.status === 'queued' ? 'RUN_QUEUED' : 'RUN_STARTED',
          runId: event.runId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
        });
      },
      onRunQueued: (event: TalkRunStartedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({
          type: 'RUN_QUEUED',
          runId: event.runId,
          triggerMessageId: event.triggerMessageId,
          executorAlias: event.executorAlias,
          executorModel: event.executorModel,
        });
      },
      onResponseStarted: (event: TalkResponseStartedEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_STARTED', event });
      },
      onResponseDelta: (event: TalkResponseDeltaEvent) => {
        if (event.talkId !== talkId) return;
        const nearBottom = isNearBottom();
        if (nearBottom) autoStickToBottomRef.current = true;
        dispatch({ type: 'RESPONSE_DELTA', event });
      },
      onResponseUsage: (_event: TalkResponseUsageEvent) => {
        // Reserved for later usage surfacing.
      },
      onResponseCompleted: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_COMPLETED', event });
      },
      onResponseFailed: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_FAILED', event });
      },
      onResponseCancelled: (event: TalkResponseTerminalEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RESPONSE_CANCELLED', event });
      },
      onRunCompleted: (event: TalkRunCompletedEvent) => {
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
      onRunFailed: (event: TalkRunFailedEvent) => {
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
      onRunCancelled: (event: TalkRunCancelledEvent) => {
        if (event.talkId !== talkId) return;
        dispatch({ type: 'RUN_CANCELLED_BATCH', runIds: event.runIds });
      },
      onReplayGap: async () => {
        await resyncTalkState();
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
  }, [handleUnauthorized, isNearBottom, resyncTalkState, state.kind, talkId]);

  useEffect(() => {
    if (state.kind !== 'ready' || !state.initialScrollPending) return;
    scrollToBottom('auto');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [scrollToBottom, state.initialScrollPending, state.kind]);

  useEffect(() => {
    if (state.kind !== 'ready' || state.initialScrollPending) return;
    if (!autoStickToBottomRef.current) return;
    autoStickToBottomRef.current = false;
    scrollToBottom('smooth');
    dispatch({ type: 'CLEAR_UNREAD' });
  }, [scrollToBottom, state.initialScrollPending, state.kind, state.messages.length]);

  const accessRole = state.kind === 'ready' ? state.talk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';

  const configuredProviders = useMemo(
    () => getConfiguredProviders(aiAgentsData),
    [aiAgentsData],
  );
  const sourceOptions = useMemo(
    () => buildTalkAgentSourceOptions({ providers: configuredProviders }),
    [configuredProviders],
  );
  const newAgentModelOptions = useMemo(
    () =>
      getModelSuggestionsForSource({
        sourceKind: newAgentDraft.sourceKind,
        providerId: newAgentDraft.providerId,
        aiAgents: aiAgentsData,
      }),
    [aiAgentsData, newAgentDraft.providerId, newAgentDraft.sourceKind],
  );
  const hasUnsavedAgentChanges = useMemo(
    () => !haveSameTalkAgentDraftState(agents, agentDrafts),
    [agentDrafts, agents],
  );
  const effectiveAgents = hasUnsavedAgentChanges ? agentDrafts : agents;
  useEffect(() => {
    setTargetAgentIds((current) => buildTargetSelection(effectiveAgents, current));
  }, [effectiveAgents]);
  const agentLabelById = useMemo(
    () =>
      effectiveAgents.reduce<Record<string, string>>((acc, agent) => {
        acc[agent.id] = buildAgentLabel(agent);
        return acc;
      }, {}),
    [effectiveAgents],
  );
  const messageLookup = useMemo(
    () => new Map(state.messages.map((message) => [message.id, message] as const)),
    [state.messages],
  );
  const runHistory = useMemo(
    () =>
      Object.values(state.runsById).sort((left, right) => right.updatedAt - left.updatedAt),
    [state.runsById],
  );
  const liveResponses = useMemo(
    () =>
      Object.values(state.liveResponsesByRunId).sort(
        (left, right) => left.startedAt - right.startedAt,
      ),
    [state.liveResponsesByRunId],
  );
  const activeRound = useMemo(
    () =>
      Object.values(state.runsById).some(
        (run) => run.status === 'queued' || run.status === 'running',
      ),
    [state.runsById],
  );

  const talkTabHref = `/app/talks/${talkId}`;
  const agentsTabHref = `/app/talks/${talkId}/agents`;
  const runsTabHref = `/app/talks/${talkId}/runs`;
  const manageAgentsHref = `/app/agents?returnTo=${encodeURIComponent(
    talkTabHref,
  )}&focus=providers`;
  const isRenaming = renameDraft?.talkId === talkId;

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (state.kind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const handleToggleTarget = (agentId: string) => {
    setTargetAgentIds((current) => {
      const selected = current.includes(agentId);
      if (selected) {
        if (current.length === 1) return current;
        return current.filter((id) => id !== agentId);
      }
      return [...current, agentId];
    });
  };

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    if (state.kind !== 'ready' || !state.talk) return;

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
    if (activeRound) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for the current round to finish or cancel it first.',
        lastDraft: content,
      });
      return;
    }
    if (hasUnsavedAgentChanges) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Save agent changes before sending a message.',
        lastDraft: content,
      });
      return;
    }

    dispatch({ type: 'SEND_STARTED' });
    try {
      const result = await sendTalkMessage({
        talkId: state.talk.id,
        content,
        targetAgentIds,
      });
      const nearBottom = isNearBottom();
      dispatch({
        type: 'MESSAGE_APPENDED',
        wasNearBottom: nearBottom,
        message: result.message,
      });
      for (const run of result.runs) {
        dispatch({
          type: 'RUN_QUEUED',
          runId: run.id,
          triggerMessageId: run.triggerMessageId,
          createdAt: run.createdAt,
          targetAgentId: run.targetAgentId,
          targetAgentNickname: run.targetAgentNickname,
          executorAlias: run.executorAlias,
          executorModel: run.executorModel,
        });
      }
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
    if (state.kind !== 'ready' || !state.talk) return;
    dispatch({ type: 'CANCEL_STARTED' });
    try {
      const result = await cancelTalkRuns(state.talk.id);
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

  const handleAgentSourceChange = (
    agentId: string,
    sourceKind: 'claude_default' | 'provider',
    providerId: string | null,
  ) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        const suggestions = getModelSuggestionsForSource({
          sourceKind,
          providerId,
          aiAgents: aiAgentsData,
        });
        const nextModelId =
          suggestions.find((entry) => entry.modelId === agent.modelId)?.modelId ||
          suggestions[0]?.modelId ||
          '';
        return applySourceModelSelection(
          agent,
          { sourceKind, providerId, modelId: nextModelId },
          current,
          aiAgentsData,
        );
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentModelChange = (agentId: string, modelId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? applySourceModelSelection(
              agent,
              {
                sourceKind: agent.sourceKind,
                providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
                modelId,
              },
              current,
              aiAgentsData,
            )
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentNicknameChange = (agentId: string, nickname: string) => {
    setAgentDrafts((current) =>
      current.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              nickname,
              nicknameMode: 'custom',
            }
          : agent,
      ),
    );
    setAgentState({ status: 'idle' });
  };

  const handleResetNickname = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => {
        if (agent.id !== agentId) return agent;
        const base = buildAutoNicknameBase({
          sourceKind: agent.sourceKind,
          providerId: agent.providerId,
          modelId: agent.modelId,
          modelDisplayName: agent.modelDisplayName,
          aiAgents: aiAgentsData,
        });
        return {
          ...agent,
          nickname: buildUniqueNickname(base, current, agent.id),
          nicknameMode: 'auto',
        };
      }),
    );
    setAgentState({ status: 'idle' });
  };

  const handleAgentRoleChange = (agentId: string, role: TalkAgent['role']) => {
    setAgentDrafts((current) =>
      current.map((agent) => (agent.id === agentId ? { ...agent, role } : agent)),
    );
    setAgentState({ status: 'idle' });
  };

  const handleSetPrimaryAgent = (agentId: string) => {
    setAgentDrafts((current) =>
      current.map((agent) => ({
        ...agent,
        isPrimary: agent.id === agentId,
      })),
    );
    setAgentState({ status: 'idle' });
  };

  const handleRemoveAgent = (agentId: string) => {
    setAgentDrafts((current) => {
      const remaining = current.filter((agent) => agent.id !== agentId);
      if (remaining.length === 0) return current;
      if (!remaining.some((agent) => agent.isPrimary)) {
        remaining[0] = { ...remaining[0], isPrimary: true };
      }
      return remaining.map((agent, index) => ({
        ...agent,
        displayOrder: index,
      }));
    });
    setTargetAgentIds((current) => {
      const next = current.filter((id) => id !== agentId);
      return next.length > 0 ? next : [];
    });
    setAgentState({ status: 'idle' });
  };

  const handleAddAgent = () => {
    const base = buildAutoNicknameBase({
      sourceKind: newAgentDraft.sourceKind,
      providerId: newAgentDraft.providerId,
      modelId: newAgentDraft.modelId,
      aiAgents: aiAgentsData,
    });
    const suggestions = getModelSuggestionsForSource({
      sourceKind: newAgentDraft.sourceKind,
      providerId: newAgentDraft.providerId,
      aiAgents: aiAgentsData,
    });
    const selectedModel =
      suggestions.find((entry) => entry.modelId === newAgentDraft.modelId) || suggestions[0];
    if (!selectedModel) return;
    setAgentDrafts((current) => [
      ...current,
      {
        id: globalThis.crypto?.randomUUID?.() || `agent-${Date.now()}`,
        nickname: buildUniqueNickname(base, current),
        nicknameMode: 'auto',
        sourceKind: newAgentDraft.sourceKind,
        role: newAgentDraft.role,
        isPrimary: false,
        displayOrder: current.length,
        health: 'unknown',
        providerId:
          newAgentDraft.sourceKind === 'provider' ? newAgentDraft.providerId : null,
        modelId: selectedModel.modelId,
        modelDisplayName: selectedModel.displayName,
      },
    ]);
    setAgentState({ status: 'idle' });
  };

  const handleSaveAgents = async () => {
    if (state.kind !== 'ready' || !state.talk || !canEditAgents) return;
    setAgentState({ status: 'saving' });
    try {
      const saved = await updateTalkAgents({
        talkId: state.talk.id,
        agents: agentDrafts.map((agent, index) => ({
          id: agent.id,
          nickname: agent.nickname.trim(),
          nicknameMode: agent.nicknameMode,
          sourceKind: agent.sourceKind,
          providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
          modelId: agent.modelId,
          modelDisplayName: agent.modelDisplayName,
          role: agent.role,
          isPrimary: agent.isPrimary,
          displayOrder: index,
          health: agent.health,
        })),
      });
      setAgents(saved);
      setAgentDrafts(saved);
      setTargetAgentIds((current) => buildTargetSelection(saved, current));
      setAgentState({ status: 'success', message: 'Talk agents updated.' });
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

  const jumpToMessage = (messageId: string) => {
    const element = messageElementRefs.current.get(messageId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  useEffect(() => {
    if (!isRenaming) return;
    titleInputRef.current?.focus();
    titleInputRef.current?.select();
  }, [isRenaming]);

  if (state.kind === 'loading') {
    return <p className="page-state">Loading talk…</p>;
  }

  if (state.kind === 'unavailable') {
    return (
      <section className="page-state">
        <h2>Talk Unavailable</h2>
        <p>{state.errorMessage || 'Talk not found.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  if (state.kind === 'error' || !state.talk) {
    return (
      <section className="page-state">
        <h2>Talk Error</h2>
        <p>{state.errorMessage || 'Failed to load talk.'}</p>
        <Link to="/app/talks">Back to talks</Link>
      </section>
    );
  }

  const talk = state.talk;
  const displayedTitle =
    isRenaming ? renameDraft?.draft ?? '' : titleOverride || talk.title;

  return (
    <section className="page-shell talk-detail-shell">
      <div className="talk-workspace">
        <div className="talk-workspace-header">
          <header className="page-header talk-page-header">
            <div className="talk-page-heading">
              {isRenaming ? (
                <input
                  ref={titleInputRef}
                  className="talk-title-input"
                  type="text"
                  value={renameDraft?.draft ?? ''}
                  onChange={(event) =>
                    onRenameDraftChange(talkId, event.target.value)
                  }
                  onKeyDown={async (event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      await onRenameDraftCommit(talkId, renameDraft?.draft ?? '');
                    }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      onRenameDraftCancel(talkId);
                    }
                  }}
                  onBlur={() => {
                    void onRenameDraftCommit(talkId, renameDraft?.draft ?? '');
                  }}
                  aria-label="Talk title"
                />
              ) : (
                <h1 className="talk-title">
                  {displayedTitle}
                  <span className={`stream-badge stream-${state.streamState}`}>
                    {streamBadgeLabel}
                  </span>
                </h1>
              )}
              <p>Event-authoritative live timeline.</p>
              {effectiveAgents.length > 0 ? (
                <div className="talk-status-strip" role="list" aria-label="Talk agent status">
                  {effectiveAgents.map((agent) => (
                    <span
                      key={agent.id}
                      className={`talk-status-pill talk-status-pill-${agent.health}`}
                      role="listitem"
                    >
                      <span
                        className={`talk-status-dot talk-status-dot-${agent.health}`}
                        aria-hidden="true"
                      />
                      <span>{buildAgentLabel(agent)}</span>
                      {agent.isPrimary ? (
                        <span className="talk-status-primary">Primary</span>
                      ) : null}
                    </span>
                  ))}
                </div>
              ) : null}
              <nav className="talk-tabs" aria-label="Talk sections">
                <Link
                  to={talkTabHref}
                  className={`talk-tab ${currentTab === 'talk' ? 'talk-tab-active' : ''}`}
                >
                  Talk
                </Link>
                <Link
                  to={agentsTabHref}
                  className={`talk-tab ${currentTab === 'agents' ? 'talk-tab-active' : ''}`}
                >
                  Agents
                </Link>
                <Link
                  to={runsTabHref}
                  className={`talk-tab ${currentTab === 'runs' ? 'talk-tab-active' : ''}`}
                >
                  Run History
                </Link>
              </nav>
            </div>
            <Link to="/app/talks">Back</Link>
          </header>
        </div>

        <div className="talk-workspace-scroll" ref={timelineRef}>
          {currentTab === 'agents' ? (
            <section className="talk-tab-panel" aria-label="Talk agents">
          <div className="agents-panel-header">
            <h2>Agents</h2>
            <Link className="secondary-btn" to={manageAgentsHref}>
              Manage AI Agents
            </Link>
          </div>
          <p className="policy-muted">
            Nicknames are local to this talk. The primary agent responds to normal user
            messages by default.
          </p>
          {agentDrafts.map((agent) => {
            const modelOptions = getModelSuggestionsForSource({
              sourceKind: agent.sourceKind,
              providerId: agent.sourceKind === 'provider' ? agent.providerId : null,
              aiAgents: aiAgentsData,
            });
            return (
              <div key={agent.id} className="agent-editor-card">
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
                      handleAgentSourceChange(
                        agent.id,
                        selected.sourceKind,
                        selected.providerId,
                      );
                    }}
                    disabled={!canEditAgents || agentState.status === 'saving'}
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
                      handleAgentModelChange(agent.id, event.target.value)
                    }
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    {modelOptions.map((model) => (
                      <option key={model.modelId} value={model.modelId}>
                        {model.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Nickname</span>
                  <input
                    type="text"
                    value={agent.nickname}
                    onChange={(event) =>
                      handleAgentNicknameChange(agent.id, event.target.value)
                    }
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select
                    value={agent.role}
                    onChange={(event) =>
                      handleAgentRoleChange(agent.id, event.target.value as TalkAgent['role'])
                    }
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    {TALK_AGENT_ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {formatTalkRole(role)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="agent-editor-actions">
                  <label className="policy-primary-toggle">
                    <input
                      type="radio"
                      name="primary-talk-agent"
                      checked={agent.isPrimary}
                      onChange={() => handleSetPrimaryAgent(agent.id)}
                      disabled={!canEditAgents || agentState.status === 'saving'}
                    />
                    <span>Primary Agent</span>
                  </label>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleResetNickname(agent.id)}
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    Reset name
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => handleRemoveAgent(agent.id)}
                    disabled={
                      !canEditAgents ||
                      agentState.status === 'saving' ||
                      agentDrafts.length <= 1
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
            );
          })}

          <div className="agent-editor-footer">
            <label>
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
                  const suggestions = getModelSuggestionsForSource({
                    sourceKind: selected.sourceKind,
                    providerId: selected.providerId,
                    aiAgents: aiAgentsData,
                  });
                  setNewAgentDraft({
                    sourceKind: selected.sourceKind,
                    providerId: selected.providerId,
                    modelId: suggestions[0]?.modelId || '',
                    role: 'assistant',
                  });
                }}
                disabled={!canEditAgents || agentState.status === 'saving'}
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
                value={newAgentDraft.modelId}
                onChange={(event) =>
                  setNewAgentDraft((current) => ({
                    ...current,
                    modelId: event.target.value,
                  }))
                }
                disabled={!canEditAgents || agentState.status === 'saving'}
              >
                {newAgentModelOptions.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Role</span>
              <select
                value={newAgentDraft.role}
                onChange={(event) =>
                  setNewAgentDraft((current) => ({
                    ...current,
                    role: event.target.value as TalkAgent['role'],
                  }))
                }
                disabled={!canEditAgents || agentState.status === 'saving'}
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
              disabled={!canEditAgents || agentState.status === 'saving' || !newAgentDraft.modelId}
            >
              Add Agent
            </button>
            <button
              type="button"
              className="secondary-btn"
              onClick={handleSaveAgents}
              disabled={!canEditAgents || agentState.status === 'saving'}
            >
              {agentState.status === 'saving' ? 'Saving…' : 'Save Agents'}
            </button>
          </div>
          {agentsCatalogError ? (
            <div className="inline-banner inline-banner-error" role="alert">
              {agentsCatalogError}
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
            </section>
          ) : null}

          {currentTab === 'runs' ? (
            <section className="talk-tab-panel run-history-panel" aria-label="Run history">
          <h2>Run History</h2>
          {runHistory.length === 0 ? (
            <p className="page-state">No runs yet.</p>
          ) : (
            <ul className="run-history-list">
              {runHistory.map((run) => (
                <li key={run.id} className="run-history-item">
                  <div className="run-history-main">
                    <span className={`run-history-status run-history-status-${run.status}`}>
                      {run.status}
                    </span>
                    <code>{run.id}</code>
                  </div>
                  {run.targetAgentNickname ? (
                    <p className="run-history-meta">Agent: {run.targetAgentNickname}</p>
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
          )}
            </section>
          ) : null}

          {currentTab === 'talk' ? (
            <div className="timeline" aria-label="Talk timeline">
            {state.messages.length === 0 ? (
              <p className="page-state">No messages yet.</p>
            ) : (
              state.messages.map((message) => {
                const agentLabel =
                  (message.agentId && agentLabelById[message.agentId]) ||
                  message.agentNickname ||
                  null;
                return (
                  <article
                    key={message.id}
                    id={`message-${message.id}`}
                    ref={(element) => setMessageElementRef(message.id, element)}
                    className={`message message-${message.role}`}
                  >
                    <header>
                      <strong>
                        {agentLabel ? `${agentLabel} · ` : ''}
                        {message.role}
                      </strong>
                      <time>{new Date(message.createdAt).toLocaleString()}</time>
                    </header>
                    <p>{message.content}</p>
                  </article>
                );
              })
            )}

            {liveResponses.map((response) => {
              const label =
                (response.agentId && agentLabelById[response.agentId]) ||
                response.agentNickname ||
                'Assistant';
              return (
                <article
                  key={response.runId}
                  className={`message message-assistant message-live${
                    response.terminalStatus === 'failed' ? ' message-error' : ''
                  }`}
                >
                  <header>
                    <strong>{label}</strong>
                    <time>
                      {response.terminalStatus === 'failed' ? 'Failed' : 'Streaming…'}
                    </time>
                  </header>
                  <p>{response.text || 'Thinking…'}</p>
                  {response.errorMessage ? (
                    <p className="run-history-error">{response.errorMessage}</p>
                  ) : null}
                </article>
              );
            })}

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
          ) : null}
        </div>

        {currentTab === 'talk' ? (
          <form className="composer talk-workspace-composer" onSubmit={handleSend}>
            <div className="composer-targets" role="group" aria-label="Selected agents">
              {effectiveAgents.map((agent) => {
                const selected = targetAgentIds.includes(agent.id);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`composer-target-chip${
                      selected ? ' composer-target-chip-selected' : ''
                    }`}
                    onClick={() => handleToggleTarget(agent.id)}
                    disabled={state.sendState.status === 'posting'}
                    aria-pressed={selected}
                  >
                    <span
                      className={`talk-status-dot talk-status-dot-${agent.health}`}
                      aria-hidden="true"
                    />
                    <span>{buildAgentLabel(agent)}</span>
                    {agent.isPrimary ? (
                      <span className="talk-status-primary">Primary</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
            <p className="composer-target-help">Selected agents will respond.</p>

            <textarea
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              placeholder="Send a message to this talk"
              rows={3}
              maxLength={TALK_MESSAGE_MAX_CHARS}
              disabled={
                state.sendState.status === 'posting' || activeRound || hasUnsavedAgentChanges
              }
            />

            <div className="composer-controls">
              <span className="composer-count">
                {draft.length}/{TALK_MESSAGE_MAX_CHARS}
              </span>
              <button
                type="submit"
                className="primary-btn"
                disabled={
                  state.sendState.status === 'posting' || activeRound || hasUnsavedAgentChanges
                }
              >
                {state.sendState.status === 'posting' ? 'Sending…' : 'Send'}
              </button>
              {canEditAgents ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleCancelRuns}
                  disabled={state.cancelState.status === 'posting' || !activeRound}
                >
                  {state.cancelState.status === 'posting' ? 'Cancelling…' : 'Cancel Runs'}
                </button>
              ) : null}
            </div>

            {activeRound ? (
              <div className="inline-banner inline-banner-warning" role="status">
                Wait for the current round to finish or cancel it before sending another
                message.
              </div>
            ) : null}

            {!activeRound && hasUnsavedAgentChanges ? (
              <div className="inline-banner inline-banner-warning" role="status">
                Save agent changes before sending a message.
              </div>
            ) : null}

            {state.sendState.status === 'error' ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {state.sendState.error || 'Unable to send message.'}
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
        ) : null}
      </div>
    </section>
  );
}
