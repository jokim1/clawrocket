import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
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
  attachTalkDataConnector,
  ApiError,
  cancelTalkRuns,
  ChannelConnection,
  ChannelQueueFailure,
  ChannelTarget,
  connectUserGoogleAccount,
  ContextGoal,
  ContextRule,
  ContextSource,
  createTalkGoogleDriveResource,
  createTalkChannel,
  createTalkContextRule,
  createTalkContextSource,
  DataConnector,
  deleteTalkResource,
  deleteTalkChannel,
  deleteTalkChannelDeliveryFailure,
  deleteTalkChannelIngressFailure,
  deleteTalkMessages,
  deleteTalkContextRule,
  deleteTalkContextSource,
  detachTalkDataConnector,
  expandUserGoogleScopes,
  getAiAgents,
  getDataConnectors,
  getTalk,
  getTalkAgents,
  getTalkTools,
  getTalkContext,
  getTalkDataConnectors,
  getTalkRuns,
  listChannelConnections,
  listChannelTargets,
  listTalkChannelDeliveryFailures,
  listTalkChannelIngressFailures,
  listTalkChannels,
  listTalkMessages,
  patchTalkChannel,
  patchTalkContextRule,
  retryTalkChannelDeliveryFailure,
  retryTalkChannelIngressFailure,
  retryTalkContextSource,
  sendTalkMessage,
  setTalkGoal,
  Talk,
  TalkAgent,
  TalkTools,
  TalkChannelBinding,
  TalkDataConnector,
  TalkMessage,
  TalkMessageAttachment,
  TalkRun,
  uploadTalkAttachment,
  testTalkChannelBinding,
  updateTalkTools,
  updateTalkAgents,
  listRegisteredAgents,
  type RegisteredAgent,
  UnauthorizedError,
} from '../lib/api';
import { TalkHistoryEditor } from '../components/TalkHistoryEditor';
import { stripInternalAssistantText } from '../lib/assistantText';
import { openTalkStream } from '../lib/talkStream';
import type {
  MessageAppendedEvent,
  TalkHistoryEditedEvent,
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

type TabKey =
  | 'talk'
  | 'agents'
  | 'tools'
  | 'context'
  | 'channels'
  | 'data-connectors'
  | 'runs';

type RunView = TalkRun & {
  updatedAt: number;
};

type LiveResponseView = {
  runId: string;
  rawText: string;
  text: string;
  agentId?: string | null;
  agentNickname?: string | null;
  providerId?: string | null;
  modelId?: string | null;
  errorMessage?: string;
  startedAt: number;
  terminalStatus?: 'failed';
};

type TalkTimelineEntry =
  | {
      kind: 'message';
      key: string;
      timestamp: number;
      sortOrder: number;
      message: TalkMessage;
    }
  | {
      kind: 'live-response';
      key: string;
      timestamp: number;
      sortOrder: number;
      response: LiveResponseView;
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

type ChannelBindingDraft = {
  displayName: string;
  active: boolean;
  responseMode: TalkChannelBinding['responseMode'];
  responderMode: TalkChannelBinding['responderMode'];
  responderAgentId: string;
  deliveryMode: TalkChannelBinding['deliveryMode'];
  channelContextNote: string;
  inboundRateLimitPerMinute: string;
  maxPendingEvents: string;
  overflowPolicy: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes: string;
};

type ChannelCreateDraft = {
  connectionId: string;
  targetKey: string;
  displayName: string;
  responseMode: TalkChannelBinding['responseMode'];
  responderMode: TalkChannelBinding['responderMode'];
  responderAgentId: string;
  deliveryMode: TalkChannelBinding['deliveryMode'];
  channelContextNote: string;
  inboundRateLimitPerMinute: string;
  maxPendingEvents: string;
  overflowPolicy: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes: string;
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

function summarizeMessageForRun(
  message: TalkMessage | undefined,
  messageId: string,
): string {
  if (!message) return messageId;
  const compact = message.content.trim().replace(/\s+/g, ' ');
  const preview = compact.length > 42 ? `${compact.slice(0, 42)}…` : compact;
  return `${message.role}: ${preview || '(empty)'}`;
}

function toRunView(run: TalkRun): RunView {
  return {
    ...run,
    updatedAt:
      Date.parse(run.completedAt || run.startedAt || run.createdAt) ||
      Date.now(),
  };
}

function mapRunsById(runs: TalkRun[]): Record<string, RunView> {
  return runs.reduce<Record<string, RunView>>((acc, run) => {
    acc[run.id] = toRunView(run);
    return acc;
  }, {});
}

function hasFileTransfer(
  dataTransfer: DataTransfer | null | undefined,
): boolean {
  if (!dataTransfer) return false;
  if (dataTransfer.files.length > 0) return true;

  const { types } = dataTransfer;
  if (!types) return false;

  const domTypes = types as unknown as DOMStringList;
  if (typeof domTypes.contains === 'function') {
    return domTypes.contains('Files');
  }

  return Array.from(types as ArrayLike<string>).includes('Files');
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
      createdAt:
        patch.createdAt ?? current?.createdAt ?? new Date(now).toISOString(),
      startedAt:
        patch.startedAt !== undefined
          ? patch.startedAt
          : (current?.startedAt ?? null),
      completedAt:
        patch.completedAt !== undefined
          ? patch.completedAt
          : (current?.completedAt ?? null),
      triggerMessageId:
        patch.triggerMessageId !== undefined
          ? patch.triggerMessageId
          : (current?.triggerMessageId ?? null),
      targetAgentId:
        patch.targetAgentId !== undefined
          ? patch.targetAgentId
          : (current?.targetAgentId ?? null),
      targetAgentNickname:
        patch.targetAgentNickname !== undefined
          ? patch.targetAgentNickname
          : (current?.targetAgentNickname ?? null),
      errorCode:
        patch.errorCode !== undefined
          ? patch.errorCode
          : (current?.errorCode ?? null),
      errorMessage:
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : (current?.errorMessage ?? null),
      executorAlias:
        patch.executorAlias !== undefined
          ? patch.executorAlias
          : (current?.executorAlias ?? null),
      executorModel:
        patch.executorModel !== undefined
          ? patch.executorModel
          : (current?.executorModel ?? null),
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
            rawText: existing?.rawText || '',
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
            rawText: '',
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
      const rawText = `${existing?.rawText || ''}${action.event.deltaText}`;
      return {
        ...state,
        liveResponsesByRunId: {
          ...state.liveResponsesByRunId,
          [action.event.runId]: {
            runId: action.event.runId,
            rawText,
            text: stripInternalAssistantText(rawText),
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
            rawText: existing?.rawText || '',
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
  if (pathname === `${base}/tools`) return 'tools';
  if (pathname === `${base}/context`) return 'context';
  if (pathname === `${base}/channels`) return 'channels';
  if (pathname === `${base}/data-connectors`) return 'data-connectors';
  if (pathname === `${base}/runs`) return 'runs';
  return 'talk';
}

function formatToolAccessState(state: string): string {
  switch (state) {
    case 'available':
      return 'Available';
    case 'unavailable_due_to_route':
      return 'Route blocked';
    case 'unavailable_due_to_identity':
      return 'Needs Google account';
    case 'unavailable_due_to_pending_scopes':
      return 'Needs Google permissions';
    case 'unavailable_due_to_scope':
      return 'Scope expansion required';
    case 'unavailable_due_to_missing_resource':
      return 'Missing resource';
    case 'unavailable_due_to_config':
    default:
      return 'Disabled';
  }
}

function requiredScopesForTool(toolId: string): string[] {
  switch (toolId) {
    case 'gmail_read':
      return ['gmail.readonly'];
    case 'gmail_send':
      return ['gmail.send'];
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
      return ['drive.readonly'];
    case 'google_docs_read':
      return ['documents.readonly'];
    case 'google_docs_batch_update':
      return ['documents'];
    case 'google_sheets_read_range':
      return ['spreadsheets.readonly'];
    case 'google_sheets_batch_update':
      return ['spreadsheets'];
    default:
      return [];
  }
}

function formatConnectorKind(kind: DataConnector['connectorKind']): string {
  return kind === 'posthog' ? 'PostHog' : 'Google Sheets';
}

function formatConnectorStatus(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing credential';
    case 'not_verified':
      return 'Needs verification';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Configured';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
}

function connectorStatusClass(
  status: DataConnector['verificationStatus'],
): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

function formatChannelPlatform(
  platform: ChannelConnection['platform'],
): string {
  return platform === 'telegram' ? 'Telegram' : 'Slack';
}

function formatChannelReasonCode(value: string | null): string {
  if (!value) return 'None';
  switch (value) {
    case 'overflow_drop_oldest':
      return 'Dropped oldest queued message';
    case 'overflow_drop_newest':
      return 'Dropped newest queued message';
    case 'overflow_no_evictable_row':
      return 'Queue full while another item was processing';
    case 'expired_while_busy':
      return 'Dropped after waiting too long for the talk to become idle';
    case 'binding_deactivated':
      return 'Binding was deactivated';
    case 'enqueue_invalid_state':
      return 'Talk state prevented channel enqueue';
    case 'delivery_retries_exhausted':
      return 'Delivery retries exhausted';
    case 'delivery_transient_failure':
      return 'Delivery failed and will retry';
    default:
      return value.replace(/_/g, ' ');
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function buildChannelBindingDraft(
  binding: TalkChannelBinding,
): ChannelBindingDraft {
  return {
    displayName: binding.displayName,
    active: binding.active,
    responseMode: binding.responseMode,
    responderMode: binding.responderMode,
    responderAgentId: binding.responderAgentId || '',
    deliveryMode: binding.deliveryMode,
    channelContextNote: binding.channelContextNote || '',
    inboundRateLimitPerMinute: String(binding.inboundRateLimitPerMinute),
    maxPendingEvents: String(binding.maxPendingEvents),
    overflowPolicy: binding.overflowPolicy,
    maxDeferredAgeMinutes: String(binding.maxDeferredAgeMinutes),
  };
}

function buildDefaultChannelCreateDraft(): ChannelCreateDraft {
  return {
    connectionId: '',
    targetKey: '',
    displayName: '',
    responseMode: 'mentions',
    responderMode: 'primary',
    responderAgentId: '',
    deliveryMode: 'reply',
    channelContextNote: '',
    inboundRateLimitPerMinute: '10',
    maxPendingEvents: '20',
    overflowPolicy: 'drop_oldest',
    maxDeferredAgeMinutes: '10',
  };
}

function buildChannelTargetKey(
  target: Pick<ChannelTarget, 'targetKind' | 'targetId'>,
): string {
  return `${target.targetKind}::${target.targetId}`;
}

function parseChannelTargetKey(
  value: string,
): { targetKind: string; targetId: string } | null {
  const separatorIndex = value.indexOf('::');
  if (separatorIndex <= 0) return null;
  return {
    targetKind: value.slice(0, separatorIndex),
    targetId: value.slice(separatorIndex + 2),
  };
}

function buildAgentLabel(agent: Pick<TalkAgent, 'nickname' | 'role'>): string {
  return `${agent.nickname} (${formatTalkRole(agent.role)})`;
}

function getConfiguredProviders(
  data: AiAgentsPageData | null,
): AgentProviderCard[] {
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
    suggestions.find((entry) => entry.modelId === input.modelId) ||
    suggestions[0] ||
    null;
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

function buildNewAgentDraft(
  _aiAgents: AiAgentsPageData | null,
): AgentCreationDraft {
  // modelId is overloaded to store the selected registered agent ID.
  // Start empty so the dropdown shows the "Choose a registered agent…" placeholder
  // and the Add button is disabled until the user selects one.
  return {
    sourceKind: 'provider',
    providerId: null,
    modelId: '',
    role: 'assistant',
  };
}

function buildTargetSelection(
  agents: TalkAgent[],
  current: string[],
): string[] {
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

function haveSameTalkAgentDraftState(
  left: TalkAgent[],
  right: TalkAgent[],
): boolean {
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
  const [state, dispatch] = useReducer(
    detailReducer,
    undefined,
    createInitialDetailState,
  );
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<
    Array<{
      localId: string;
      file: File;
      fileName: string;
      fileSize: number;
      status: 'uploading' | 'ready' | 'error';
      attachmentId?: string;
      errorMessage?: string;
    }>
  >([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [agents, setAgents] = useState<TalkAgent[]>([]);
  const [agentDrafts, setAgentDrafts] = useState<TalkAgent[]>([]);
  const [aiAgentsData, setAiAgentsData] = useState<AiAgentsPageData | null>(
    null,
  );
  const [registeredAgentsCatalog, setRegisteredAgentsCatalog] = useState<
    RegisteredAgent[]
  >([]);
  const [agentsCatalogError, setAgentsCatalogError] = useState<string | null>(
    null,
  );
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
  const [talkConnectors, setTalkConnectors] = useState<TalkDataConnector[]>([]);
  const [orgConnectors, setOrgConnectors] = useState<DataConnector[]>([]);
  const [attachConnectorId, setAttachConnectorId] = useState('');
  const [connectorState, setConnectorState] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [talkTools, setTalkTools] = useState<TalkTools | null>(null);
  const [toolGrantDrafts, setToolGrantDrafts] = useState<
    Record<string, boolean>
  >({});
  const [toolStatus, setToolStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [driveBindingDraft, setDriveBindingDraft] = useState<{
    bindingKind: 'google_drive_folder' | 'google_drive_file';
    externalId: string;
    displayName: string;
  }>({
    bindingKind: 'google_drive_folder',
    externalId: '',
    displayName: '',
  });
  const [historyEditorOpen, setHistoryEditorOpen] = useState(false);
  const [historyEditState, setHistoryEditState] = useState<{
    status: 'idle' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });

  // Context tab state
  const [contextGoal, setContextGoal] = useState<ContextGoal | null>(null);
  const [contextRules, setContextRules] = useState<ContextRule[]>([]);
  const [contextSources, setContextSources] = useState<ContextSource[]>([]);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [contextStatus, setContextStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
    message?: string;
  }>({ status: 'idle' });
  const [goalDraft, setGoalDraft] = useState('');
  const [newRuleText, setNewRuleText] = useState('');
  const [addSourceType, setAddSourceType] = useState<'text' | 'url'>('text');
  const [addSourceTitle, setAddSourceTitle] = useState('');
  const [addSourceUrl, setAddSourceUrl] = useState('');
  const [addSourceText, setAddSourceText] = useState('');
  const [channelBindings, setChannelBindings] = useState<TalkChannelBinding[]>(
    [],
  );
  const [channelConnections, setChannelConnections] = useState<
    ChannelConnection[]
  >([]);
  const [channelTargets, setChannelTargets] = useState<ChannelTarget[]>([]);
  const [channelDrafts, setChannelDrafts] = useState<
    Record<string, ChannelBindingDraft>
  >({});
  const [channelFailuresByBindingId, setChannelFailuresByBindingId] = useState<
    Record<
      string,
      { ingress: ChannelQueueFailure[]; delivery: ChannelQueueFailure[] }
    >
  >({});
  const [channelCreateDraft, setChannelCreateDraft] =
    useState<ChannelCreateDraft>(buildDefaultChannelCreateDraft());
  const [channelTargetsLoading, setChannelTargetsLoading] = useState(false);
  const [channelStatus, setChannelStatus] = useState<{
    status: 'idle' | 'loading' | 'saving' | 'error' | 'success';
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

  const refreshContext = useCallback(
    async (options?: { hydrateGoalDraft?: boolean; showLoading?: boolean }) => {
      if (options?.showLoading) {
        setContextStatus({ status: 'loading' });
      }
      const ctx = await getTalkContext(talkId);
      setContextGoal(ctx.goal);
      if (options?.hydrateGoalDraft) {
        setGoalDraft(ctx.goal?.goalText ?? '');
      }
      setContextRules(ctx.rules);
      setContextSources(ctx.sources);
      setContextLoaded(true);
      setContextStatus({ status: 'idle' });
    },
    [talkId],
  );

  const refreshTalkTools = useCallback(
    async (options?: { showLoading?: boolean }) => {
      if (options?.showLoading) {
        setToolStatus({ status: 'loading' });
      }
      const next = await getTalkTools(talkId);
      setTalkTools(next);
      setToolGrantDrafts(
        next.grants.reduce<Record<string, boolean>>((acc, grant) => {
          acc[grant.toolId] = grant.enabled;
          return acc;
        }, {}),
      );
      setToolStatus({ status: 'idle' });
    },
    [talkId],
  );

  useEffect(() => {
    let cancelled = false;
    dispatch({ type: 'BOOTSTRAP_LOADING' });
    messageElementRefs.current.clear();
    setAgents([]);
    setAgentDrafts([]);
    setTargetAgentIds([]);
    setAgentsCatalogError(null);
    setAgentState({ status: 'idle' });
    setTalkConnectors([]);
    setOrgConnectors([]);
    setAttachConnectorId('');
    setConnectorState({ status: 'idle' });
    setHistoryEditorOpen(false);
    setHistoryEditState({ status: 'idle' });
    setContextLoaded(false);
    setContextGoal(null);
    setContextRules([]);
    setContextSources([]);
    setContextStatus({ status: 'idle' });
    setGoalDraft('');
    setNewRuleText('');
    setAddSourceType('text');
    setAddSourceTitle('');
    setAddSourceUrl('');
    setAddSourceText('');
    setChannelBindings([]);
    setChannelConnections([]);
    setChannelTargets([]);
    setChannelDrafts({});
    setChannelFailuresByBindingId({});
    setChannelCreateDraft(buildDefaultChannelCreateDraft());
    setChannelTargetsLoading(false);
    setChannelStatus({ status: 'idle' });

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
        const [next, regAgents] = await Promise.all([
          getAiAgents(),
          listRegisteredAgents(),
        ]);
        if (cancelled) return;
        setAiAgentsData(next);
        setRegisteredAgentsCatalog(regAgents);
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
          setRegisteredAgentsCatalog([]);
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
      onHistoryEdited: (event: TalkHistoryEditedEvent) => {
        if (event.talkId !== talkId) return;
        void resyncTalkState();
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
  }, [
    scrollToBottom,
    state.initialScrollPending,
    state.kind,
    state.messages.length,
  ]);

  const accessRole = state.kind === 'ready' ? state.talk?.accessRole : null;
  const canEditAgents =
    accessRole === 'owner' || accessRole === 'admin' || accessRole === 'editor';
  const canManageTalkConnectors =
    accessRole === 'owner' || accessRole === 'admin';
  const canEditChannels = canEditAgents;
  const canBrowseChannelConnections = canManageTalkConnectors;

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
    setTargetAgentIds((current) =>
      buildTargetSelection(effectiveAgents, current),
    );
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
    () =>
      new Map(state.messages.map((message) => [message.id, message] as const)),
    [state.messages],
  );
  const runHistory = useMemo(
    () =>
      Object.values(state.runsById).sort(
        (left, right) => right.updatedAt - left.updatedAt,
      ),
    [state.runsById],
  );
  const liveResponses = useMemo(
    () =>
      Object.values(state.liveResponsesByRunId).sort(
        (left, right) => left.startedAt - right.startedAt,
      ),
    [state.liveResponsesByRunId],
  );
  const talkTimeline = useMemo<TalkTimelineEntry[]>(
    () =>
      [
        ...state.messages.map((message, index) => ({
          kind: 'message' as const,
          key: message.id,
          timestamp: Date.parse(message.createdAt) || 0,
          sortOrder: index,
          message,
        })),
        ...liveResponses.map((response, index) => {
          const run = state.runsById[response.runId];
          const runTimestamp = Date.parse(
            run?.startedAt || run?.createdAt || '',
          );
          return {
            kind: 'live-response' as const,
            key: response.runId,
            timestamp:
              Number.isFinite(runTimestamp) && runTimestamp > 0
                ? runTimestamp
                : response.startedAt,
            sortOrder: state.messages.length + index,
            response,
          };
        }),
      ].sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.sortOrder - right.sortOrder,
      ),
    [liveResponses, state.messages, state.runsById],
  );
  const activeRound = useMemo(
    () =>
      Object.values(state.runsById).some(
        (run) =>
          run.status === 'queued' ||
          run.status === 'running' ||
          run.status === 'awaiting_confirmation',
      ),
    [state.runsById],
  );
  const canEditHistory = useMemo(
    () =>
      state.kind === 'ready' &&
      !activeRound &&
      state.messages.some((message) => message.role !== 'system'),
    [activeRound, state],
  );
  const resolveMessageActorLabel = useCallback(
    (message: TalkMessage): string | null => {
      return (
        (message.agentId ? agentLabelById[message.agentId] : null) ||
        message.agentNickname ||
        null
      );
    },
    [agentLabelById],
  );
  const availableConnectors = useMemo(
    () =>
      orgConnectors.filter(
        (connector) =>
          connector.enabled &&
          connector.verificationStatus === 'verified' &&
          !talkConnectors.some((attached) => attached.id === connector.id),
      ),
    [orgConnectors, talkConnectors],
  );
  const selectedChannelTarget = useMemo(
    () =>
      channelTargets.find(
        (target) =>
          buildChannelTargetKey(target) === channelCreateDraft.targetKey,
      ) || null,
    [channelCreateDraft.targetKey, channelTargets],
  );
  const missingGoogleScopes = useMemo(() => {
    if (!talkTools) return [] as string[];
    const currentScopes = new Set(talkTools.googleAccount.scopes);
    return Array.from(
      new Set(
        talkTools.grants
          .filter((grant) => grant.enabled)
          .flatMap((grant) => requiredScopesForTool(grant.toolId))
          .filter((scope) => !currentScopes.has(scope)),
      ),
    );
  }, [talkTools]);
  const hasUnsavedToolChanges = useMemo(() => {
    if (!talkTools) return false;
    return talkTools.grants.some(
      (grant) => (toolGrantDrafts[grant.toolId] ?? false) !== grant.enabled,
    );
  }, [talkTools, toolGrantDrafts]);

  const talkTabHref = `/app/talks/${talkId}`;
  const agentsTabHref = `/app/talks/${talkId}/agents`;
  const toolsTabHref = `/app/talks/${talkId}/tools`;
  const contextTabHref = `/app/talks/${talkId}/context`;
  const channelsTabHref = `/app/talks/${talkId}/channels`;
  const connectorsTabHref = `/app/talks/${talkId}/data-connectors`;
  const runsTabHref = `/app/talks/${talkId}/runs`;
  const manageAgentsHref = `/app/agents?returnTo=${encodeURIComponent(
    talkTabHref,
  )}&focus=providers`;
  const manageConnectorsHref = '/app/connectors';
  const isRenaming = renameDraft?.talkId === talkId;

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'tools') return;

    let cancelled = false;
    setToolStatus((current) =>
      current.status === 'saving' ? current : { status: 'loading' },
    );

    const loadTools = async () => {
      try {
        const next = await getTalkTools(talkId);
        if (cancelled) return;
        setTalkTools(next);
        setToolGrantDrafts(
          next.grants.reduce<Record<string, boolean>>((acc, grant) => {
            acc[grant.toolId] = grant.enabled;
            return acc;
          }, {}),
        );
        setToolStatus({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setToolStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load Talk tools.',
          });
        }
      }
    };

    void loadTools();
    return () => {
      cancelled = true;
    };
  }, [currentTab, handleUnauthorized, state.kind, talkId]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'data-connectors') return;

    let cancelled = false;
    setConnectorState((current) =>
      current.status === 'saving' ? current : { status: 'loading' },
    );

    const loadConnectors = async () => {
      try {
        const [attached, allConnectors] = await Promise.all([
          getTalkDataConnectors(talkId),
          canManageTalkConnectors ? getDataConnectors() : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setTalkConnectors(attached);
        setOrgConnectors(allConnectors);
        setConnectorState({ status: 'idle' });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setConnectorState({
            status: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load data connectors.',
          });
        }
      }
    };

    void loadConnectors();
    return () => {
      cancelled = true;
    };
  }, [
    canManageTalkConnectors,
    currentTab,
    handleUnauthorized,
    state.kind,
    talkId,
  ]);

  useEffect(() => {
    if (currentTab !== 'data-connectors') return;
    if (
      availableConnectors.some(
        (connector) => connector.id === attachConnectorId,
      )
    ) {
      return;
    }
    setAttachConnectorId(availableConnectors[0]?.id || '');
  }, [attachConnectorId, availableConnectors, currentTab]);

  const reloadTalkChannels = useCallback(
    async (options?: { quiet?: boolean }) => {
      if (state.kind !== 'ready') return;
      if (!options?.quiet) {
        setChannelStatus((current) =>
          current.status === 'saving' ? current : { status: 'loading' },
        );
      }
      try {
        const [bindings, connections] = await Promise.all([
          listTalkChannels(talkId),
          canBrowseChannelConnections
            ? listChannelConnections()
            : Promise.resolve([] as ChannelConnection[]),
        ]);
        const failureEntries = await Promise.all(
          bindings.map(async (binding) => {
            const [ingress, delivery] = await Promise.all([
              listTalkChannelIngressFailures({
                talkId,
                bindingId: binding.id,
              }),
              listTalkChannelDeliveryFailures({
                talkId,
                bindingId: binding.id,
              }),
            ]);
            return [binding.id, { ingress, delivery }] as const;
          }),
        );
        setChannelBindings(bindings);
        setChannelDrafts(
          bindings.reduce<Record<string, ChannelBindingDraft>>(
            (acc, binding) => {
              acc[binding.id] = buildChannelBindingDraft(binding);
              return acc;
            },
            {},
          ),
        );
        setChannelFailuresByBindingId(Object.fromEntries(failureEntries));
        setChannelConnections(connections);
        setChannelCreateDraft((current) => {
          const nextConnectionId =
            connections.find(
              (connection) => connection.id === current.connectionId,
            )?.id ||
            connections[0]?.id ||
            current.connectionId;
          return {
            ...current,
            connectionId: nextConnectionId,
          };
        });
        if (!options?.quiet) {
          setChannelStatus({ status: 'idle' });
        }
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to load talk channels.',
        });
      }
    },
    [canBrowseChannelConnections, handleUnauthorized, state.kind, talkId],
  );

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'channels') return;
    void reloadTalkChannels();
  }, [currentTab, reloadTalkChannels, state.kind]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'channels') return;
    if (!canBrowseChannelConnections || !channelCreateDraft.connectionId) {
      setChannelTargets([]);
      return;
    }

    let cancelled = false;
    setChannelTargetsLoading(true);

    const loadTargets = async () => {
      try {
        const targets = await listChannelTargets({
          connectionId: channelCreateDraft.connectionId,
          limit: 50,
        });
        if (cancelled) return;
        setChannelTargets(targets);
        setChannelCreateDraft((current) => {
          if (current.connectionId !== channelCreateDraft.connectionId) {
            return current;
          }
          const existingTarget = targets.find(
            (target) => buildChannelTargetKey(target) === current.targetKey,
          );
          const nextTarget = existingTarget || targets[0] || null;
          return {
            ...current,
            targetKey: nextTarget ? buildChannelTargetKey(nextTarget) : '',
            displayName:
              current.displayName || !nextTarget
                ? current.displayName
                : nextTarget.displayName,
          };
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setChannelStatus({
            status: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'Failed to load channel targets.',
          });
        }
      } finally {
        if (!cancelled) {
          setChannelTargetsLoading(false);
        }
      }
    };

    void loadTargets();
    return () => {
      cancelled = true;
    };
  }, [
    canBrowseChannelConnections,
    channelCreateDraft.connectionId,
    currentTab,
    handleUnauthorized,
    state.kind,
  ]);

  // Load context data when context tab is selected
  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'context') return;
    if (contextLoaded) return;

    let cancelled = false;

    const loadContext = async () => {
      try {
        await refreshContext({ hydrateGoalDraft: true, showLoading: true });
        if (cancelled) return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        if (!cancelled) {
          setContextStatus({
            status: 'error',
            message:
              err instanceof Error ? err.message : 'Failed to load context.',
          });
        }
      }
    };

    void loadContext();
    return () => {
      cancelled = true;
    };
  }, [
    contextLoaded,
    currentTab,
    handleUnauthorized,
    refreshContext,
    state.kind,
  ]);

  useEffect(() => {
    if (state.kind !== 'ready' || currentTab !== 'context' || !contextLoaded) {
      return;
    }
    if (!contextSources.some((source) => source.status === 'pending')) {
      return;
    }

    let cancelled = false;
    const interval = window.setInterval(() => {
      void refreshContext().catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setContextStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to refresh saved source status.',
        });
      });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [
    contextLoaded,
    contextSources,
    currentTab,
    handleUnauthorized,
    refreshContext,
    state.kind,
  ]);

  // Context handlers
  const handleSaveGoal = async () => {
    setContextStatus({ status: 'saving' });
    try {
      const result = await setTalkGoal({ talkId, goalText: goalDraft });
      setContextGoal(result.goal);
      setContextStatus({ status: 'success', message: 'Goal saved.' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save goal.',
      });
    }
  };

  const handleAddRule = async () => {
    if (!newRuleText.trim()) return;
    setContextStatus({ status: 'saving' });
    try {
      const rule = await createTalkContextRule({
        talkId,
        ruleText: newRuleText.trim(),
      });
      setContextRules((prev) => [...prev, rule]);
      setNewRuleText('');
      setContextStatus({ status: 'idle' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to add rule.',
      });
    }
  };

  const handleToggleRule = async (rule: ContextRule) => {
    try {
      const updated = await patchTalkContextRule({
        talkId,
        ruleId: rule.id,
        isActive: !rule.isActive,
      });
      setContextRules((prev) =>
        prev.map((r) => (r.id === updated.id ? updated : r)),
      );
    } catch {
      // silent
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await deleteTalkContextRule({ talkId, ruleId });
      setContextRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch {
      // silent
    }
  };

  const handleAddSource = async () => {
    if (!addSourceTitle.trim()) return;
    setContextStatus({ status: 'saving' });
    try {
      const source = await createTalkContextSource({
        talkId,
        sourceType: addSourceType,
        title: addSourceTitle.trim(),
        sourceUrl: addSourceType === 'url' ? addSourceUrl.trim() : undefined,
        extractedText:
          addSourceType === 'text' ? addSourceText.trim() : undefined,
      });
      setContextSources((prev) => [...prev, source]);
      setAddSourceTitle('');
      setAddSourceUrl('');
      setAddSourceText('');
      setContextStatus({ status: 'idle' });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to add source.',
      });
    }
  };

  const handleDeleteSource = async (sourceId: string) => {
    try {
      await deleteTalkContextSource({ talkId, sourceId });
      setContextSources((prev) => prev.filter((s) => s.id !== sourceId));
    } catch {
      // silent
    }
  };

  const handleRetrySource = async (sourceId: string) => {
    try {
      const updated = await retryTalkContextSource({ talkId, sourceId });
      setContextSources((prev) =>
        prev.map((source) => (source.id === updated.id ? updated : source)),
      );
      setContextStatus({
        status: 'success',
        message: 'Retrying saved source fetch.',
      });
    } catch (err) {
      setContextStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to retry saved source.',
      });
    }
  };

  const handleChannelDraftChange = useCallback(
    (bindingId: string, patch: Partial<ChannelBindingDraft>) => {
      setChannelDrafts((current) => ({
        ...current,
        [bindingId]: {
          ...current[bindingId],
          ...patch,
        },
      }));
    },
    [],
  );

  const handleCreateChannel = useCallback(async () => {
    if (!canEditChannels) return;
    const parsedTarget = parseChannelTargetKey(channelCreateDraft.targetKey);
    if (!channelCreateDraft.connectionId || !parsedTarget) {
      setChannelStatus({
        status: 'error',
        message:
          'Select a connection and target before creating a channel binding.',
      });
      return;
    }
    setChannelStatus({ status: 'saving' });
    try {
      await createTalkChannel({
        talkId,
        connectionId: channelCreateDraft.connectionId,
        targetKind: parsedTarget.targetKind,
        targetId: parsedTarget.targetId,
        displayName:
          channelCreateDraft.displayName.trim() ||
          selectedChannelTarget?.displayName ||
          parsedTarget.targetId,
        responseMode: channelCreateDraft.responseMode,
        responderMode: channelCreateDraft.responderMode,
        responderAgentId:
          channelCreateDraft.responderMode === 'agent'
            ? channelCreateDraft.responderAgentId || null
            : null,
        deliveryMode: channelCreateDraft.deliveryMode,
        channelContextNote:
          channelCreateDraft.channelContextNote.trim() || null,
        inboundRateLimitPerMinute:
          Number.parseInt(channelCreateDraft.inboundRateLimitPerMinute, 10) ||
          10,
        maxPendingEvents:
          Number.parseInt(channelCreateDraft.maxPendingEvents, 10) || 20,
        overflowPolicy: channelCreateDraft.overflowPolicy,
        maxDeferredAgeMinutes:
          Number.parseInt(channelCreateDraft.maxDeferredAgeMinutes, 10) || 10,
      });
      await reloadTalkChannels({ quiet: true });
      setChannelCreateDraft((current) => ({
        ...buildDefaultChannelCreateDraft(),
        connectionId: current.connectionId,
      }));
      setChannelStatus({
        status: 'success',
        message: 'Talk channel binding created.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setChannelStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to create talk channel binding.',
      });
    }
  }, [
    canEditChannels,
    channelCreateDraft,
    handleUnauthorized,
    reloadTalkChannels,
    selectedChannelTarget?.displayName,
    talkId,
  ]);

  const handleSaveChannelBinding = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      const draft = channelDrafts[binding.id];
      if (!draft) return;
      setChannelStatus({ status: 'saving' });
      try {
        await patchTalkChannel({
          talkId,
          bindingId: binding.id,
          active: draft.active,
          displayName: draft.displayName.trim() || binding.displayName,
          responseMode: draft.responseMode,
          responderMode: draft.responderMode,
          responderAgentId:
            draft.responderMode === 'agent'
              ? draft.responderAgentId || null
              : null,
          deliveryMode: draft.deliveryMode,
          channelContextNote: draft.channelContextNote.trim() || null,
          inboundRateLimitPerMinute:
            Number.parseInt(draft.inboundRateLimitPerMinute, 10) ||
            binding.inboundRateLimitPerMinute,
          maxPendingEvents:
            Number.parseInt(draft.maxPendingEvents, 10) ||
            binding.maxPendingEvents,
          overflowPolicy: draft.overflowPolicy,
          maxDeferredAgeMinutes:
            Number.parseInt(draft.maxDeferredAgeMinutes, 10) ||
            binding.maxDeferredAgeMinutes,
        });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: `Saved channel settings for ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to save talk channel settings.',
        });
      }
    },
    [
      canEditChannels,
      channelDrafts,
      handleUnauthorized,
      reloadTalkChannels,
      talkId,
    ],
  );

  const handleDeleteChannelBinding = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      const confirmed = window.confirm(
        `Delete the channel binding for ${binding.displayName}?`,
      );
      if (!confirmed) return;
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannel({
          talkId,
          bindingId: binding.id,
        });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: `Deleted channel binding for ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to delete talk channel binding.',
        });
      }
    },
    [canEditChannels, handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleTestChannel = useCallback(
    async (binding: TalkChannelBinding) => {
      if (!canEditChannels) return;
      setChannelStatus({ status: 'saving' });
      try {
        await testTalkChannelBinding({
          talkId,
          bindingId: binding.id,
        });
        setChannelStatus({
          status: 'success',
          message: `Sent a test message to ${binding.displayName}.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to send test channel message.',
        });
      }
    },
    [canEditChannels, handleUnauthorized, talkId],
  );

  const handleRetryIngressFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await retryTalkChannelIngressFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Ingress failure retried.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to retry ingress failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleDismissIngressFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannelIngressFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Ingress failure dismissed.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to dismiss ingress failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleRetryDeliveryFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await retryTalkChannelDeliveryFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Delivery failure retried.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to retry delivery failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const handleDismissDeliveryFailure = useCallback(
    async (bindingId: string, rowId: string) => {
      setChannelStatus({ status: 'saving' });
      try {
        await deleteTalkChannelDeliveryFailure({ talkId, bindingId, rowId });
        await reloadTalkChannels({ quiet: true });
        setChannelStatus({
          status: 'success',
          message: 'Delivery failure dismissed.',
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setChannelStatus({
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Failed to dismiss delivery failure.',
        });
      }
    },
    [handleUnauthorized, reloadTalkChannels, talkId],
  );

  const openHistoryEditor = useCallback(() => {
    if (state.kind !== 'ready') return;
    if (activeRound) {
      setHistoryEditState({
        status: 'error',
        message:
          'Wait for the current round to finish or cancel it before editing history.',
      });
      return;
    }
    if (!state.messages.some((message) => message.role !== 'system')) {
      setHistoryEditState({
        status: 'error',
        message: 'There are no editable messages in this Talk yet.',
      });
      return;
    }
    setHistoryEditState({ status: 'idle' });
    setHistoryEditorOpen(true);
  }, [activeRound, state]);

  const handleCloseHistoryEditor = useCallback(() => {
    if (historyEditState.status === 'saving') return;
    setHistoryEditorOpen(false);
    setHistoryEditState((current) =>
      current.status === 'success' ? current : { status: 'idle' },
    );
  }, [historyEditState.status]);

  const handleDeleteHistoryMessages = useCallback(
    async (messageIds: string[]) => {
      if (state.kind !== 'ready' || !state.talk) return;
      if (messageIds.length === 0) {
        setHistoryEditState({
          status: 'error',
          message: 'Select at least one message to delete.',
        });
        return;
      }
      const confirmed = window.confirm(
        `Delete ${messageIds.length} selected message${
          messageIds.length === 1 ? '' : 's'
        } from this Talk history?`,
      );
      if (!confirmed) return;

      setHistoryEditState({ status: 'saving' });
      try {
        const result = await deleteTalkMessages({
          talkId: state.talk.id,
          messageIds,
        });
        await resyncTalkState();
        setHistoryEditorOpen(false);
        setHistoryEditState({
          status: 'success',
          message: `Deleted ${result.deletedCount} message${
            result.deletedCount === 1 ? '' : 's'
          } from this Talk history.`,
        });
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          handleUnauthorized();
          return;
        }
        setHistoryEditState({
          status: 'error',
          message:
            err instanceof Error ? err.message : 'Unable to edit Talk history.',
        });
      }
    },
    [handleUnauthorized, resyncTalkState, state],
  );

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (state.kind === 'ready' && state.sendState.status === 'error') {
      dispatch({ type: 'SEND_CLEARED' });
    }
  };

  const ALLOWED_ATTACHMENT_EXTENSIONS =
    '.txt,.md,.csv,.html,.rtf,' +
    '.json,.xml,.yaml,.yml,.py,.js,.ts,.jsx,.tsx,.java,.c,.h,.cpp,.hpp,.go,.rs,.sh,.bash,.sql,.rb,.php,.swift,.kt,.lua,.r,.toml,.ini,.cfg,.env,.log,' +
    '.pdf,.docx,.xlsx,.pptx';
  const ALLOWED_ATTACHMENT_MIMES = new Set([
    // Text-based (existing)
    'text/plain',
    'text/markdown',
    'text/csv',
    'text/html',
    // NEW: RTF
    'text/rtf',
    'application/rtf',
    // NEW: Code / structured data (treated as plain text)
    'text/xml',
    'application/json',
    'application/xml',
    'text/yaml',
    'text/x-yaml',
    'application/x-yaml',
    'text/x-python',
    'text/x-java',
    'text/javascript',
    'application/javascript',
    'text/typescript',
    'text/x-c',
    'text/x-c++',
    'text/x-go',
    'text/x-rust',
    'text/x-shellscript',
    'text/x-sql',
    // Documents (existing + PPTX)
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ]);
  const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
  const MAX_ATTACHMENTS_PER_MESSAGE = 5;

  const handleFilesSelected = async (files: FileList | File[]) => {
    if (!state.talk) return;
    const fileArray = Array.from(files);
    const currentCount = pendingAttachments.length;
    if (currentCount + fileArray.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      dispatch({
        type: 'SEND_FAILED',
        message: `You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`,
        lastDraft: draft,
      });
      return;
    }

    for (const file of fileArray) {
      if (!ALLOWED_ATTACHMENT_MIMES.has(file.type) && file.type !== '') {
        dispatch({
          type: 'SEND_FAILED',
          message: `File type "${file.type}" is not supported. Supported: text, markdown, CSV, HTML, RTF, PDF, DOCX, XLSX, PPTX, and common code/config files.`,
          lastDraft: draft,
        });
        continue;
      }
      if (file.size > MAX_ATTACHMENT_SIZE) {
        dispatch({
          type: 'SEND_FAILED',
          message: `"${file.name}" exceeds the 10 MB size limit.`,
          lastDraft: draft,
        });
        continue;
      }

      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPendingAttachments((prev) => [
        ...prev,
        {
          localId,
          file,
          fileName: file.name,
          fileSize: file.size,
          status: 'uploading',
        },
      ]);

      try {
        const result = await uploadTalkAttachment(state.talk!.id, file);
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'ready' as const,
                  attachmentId: result.attachment.id,
                }
              : a,
          ),
        );
      } catch (err) {
        setPendingAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? {
                  ...a,
                  status: 'error' as const,
                  errorMessage:
                    err instanceof Error ? err.message : 'Upload failed',
                }
              : a,
          ),
        );
      }
    }
  };

  const handleRemoveAttachment = (localId: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  const handleAttachButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    if (event.target.files && event.target.files.length > 0) {
      void handleFilesSelected(event.target.files);
      event.target.value = '';
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (hasFileTransfer(event.dataTransfer)) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragOver(false);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (hasFileTransfer(event.dataTransfer)) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (event.dataTransfer.files.length > 0) {
      void handleFilesSelected(event.dataTransfer.files);
    }
  };

  useEffect(() => {
    if (currentTab !== 'talk') {
      dragCounterRef.current = 0;
      setIsDragOver(false);
      return;
    }

    const preventWindowFileNavigation = (event: DragEvent) => {
      if (!hasFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      if (event.type === 'drop') {
        dragCounterRef.current = 0;
        setIsDragOver(false);
      }
    };

    window.addEventListener('dragenter', preventWindowFileNavigation, true);
    window.addEventListener('dragover', preventWindowFileNavigation, true);
    window.addEventListener('drop', preventWindowFileNavigation, true);

    return () => {
      window.removeEventListener(
        'dragenter',
        preventWindowFileNavigation,
        true,
      );
      window.removeEventListener('dragover', preventWindowFileNavigation, true);
      window.removeEventListener('drop', preventWindowFileNavigation, true);
    };
  }, [currentTab]);

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

  const submitDraft = async () => {
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
    if (content === '/edit') {
      setDraft('');
      dispatch({ type: 'SEND_CLEARED' });
      openHistoryEditor();
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

    // Collect ready attachment IDs
    const readyAttachments = pendingAttachments.filter(
      (a) => a.status === 'ready' && a.attachmentId,
    );
    const stillUploading = pendingAttachments.some(
      (a) => a.status === 'uploading',
    );
    if (stillUploading) {
      dispatch({
        type: 'SEND_FAILED',
        message: 'Wait for file uploads to finish before sending.',
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
        attachmentIds: readyAttachments.map((a) => a.attachmentId!),
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
      setPendingAttachments([]);
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

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    void submitDraft();
  };

  const handleComposerKeyDown = (
    event: ReactKeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    event.preventDefault();
    void submitDraft();
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

  const handleAttachConnector = async () => {
    if (!canManageTalkConnectors || !attachConnectorId) return;

    setConnectorState({ status: 'saving' });
    try {
      const attached = await attachTalkDataConnector({
        talkId,
        connectorId: attachConnectorId,
      });
      setTalkConnectors((current) =>
        current.some((connector) => connector.id === attached.id)
          ? current
          : [...current, attached],
      );
      setOrgConnectors((current) =>
        current.map((connector) =>
          connector.id === attached.id
            ? {
                ...connector,
                attachedTalkCount: connector.attachedTalkCount + 1,
              }
            : connector,
        ),
      );
      setConnectorState({
        status: 'success',
        message: `${attached.name} attached to this talk.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setConnectorState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to attach data connector.',
      });
    }
  };

  const handleDetachConnector = async (connector: TalkDataConnector) => {
    if (!canManageTalkConnectors) return;

    setConnectorState({ status: 'saving' });
    try {
      await detachTalkDataConnector({
        talkId,
        connectorId: connector.id,
      });
      setTalkConnectors((current) =>
        current.filter((item) => item.id !== connector.id),
      );
      setOrgConnectors((current) =>
        current.map((item) =>
          item.id === connector.id
            ? {
                ...item,
                attachedTalkCount: Math.max(0, item.attachedTalkCount - 1),
              }
            : item,
        ),
      );
      setConnectorState({
        status: 'success',
        message: `${connector.name} detached from this talk.`,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setConnectorState({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to detach data connector.',
      });
    }
  };

  const handleSaveTalkTools = async () => {
    if (!canEditAgents || !talkTools) return;

    setToolStatus({ status: 'saving' });
    try {
      const next = await updateTalkTools({
        talkId,
        grants: talkTools.registry.map((entry) => ({
          toolId: entry.id,
          enabled: toolGrantDrafts[entry.id] ?? false,
        })),
      });
      setTalkTools(next);
      setToolGrantDrafts(
        next.grants.reduce<Record<string, boolean>>((acc, grant) => {
          acc[grant.toolId] = grant.enabled;
          return acc;
        }, {}),
      );
      setToolStatus({
        status: 'success',
        message: 'Talk tool grants updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to save Talk tools.',
      });
    }
  };

  const handleConnectGoogleAccount = async () => {
    setToolStatus({ status: 'saving' });
    try {
      await connectUserGoogleAccount();
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Google account connected for this user.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to connect Google account.',
      });
    }
  };

  const handleGrantGoogleScopes = async () => {
    if (!talkTools) return;
    const currentScopes = new Set(talkTools.googleAccount.scopes);
    const missingScopes = Array.from(
      new Set(
        talkTools.grants
          .filter((grant) => grant.enabled)
          .flatMap((grant) => requiredScopesForTool(grant.toolId))
          .filter((scope) => !currentScopes.has(scope)),
      ),
    );
    if (missingScopes.length === 0) return;

    setToolStatus({ status: 'saving' });
    try {
      await expandUserGoogleScopes(missingScopes);
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Google permissions updated.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to update Google permissions.',
      });
    }
  };

  const handleAddDriveBinding = async () => {
    if (!canEditAgents) return;
    if (
      !driveBindingDraft.externalId.trim() ||
      !driveBindingDraft.displayName.trim()
    ) {
      setToolStatus({
        status: 'error',
        message: 'Drive bindings require both a display name and resource id.',
      });
      return;
    }

    setToolStatus({ status: 'saving' });
    try {
      await createTalkGoogleDriveResource({
        talkId,
        bindingKind: driveBindingDraft.bindingKind,
        externalId: driveBindingDraft.externalId.trim(),
        displayName: driveBindingDraft.displayName.trim(),
      });
      setDriveBindingDraft({
        bindingKind: 'google_drive_folder',
        externalId: '',
        displayName: '',
      });
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Drive binding added to this Talk.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error ? err.message : 'Failed to add Drive binding.',
      });
    }
  };

  const handleDeleteDriveBinding = async (bindingId: string) => {
    if (!canEditAgents) return;

    setToolStatus({ status: 'saving' });
    try {
      await deleteTalkResource({ talkId, resourceId: bindingId });
      await refreshTalkTools();
      setToolStatus({
        status: 'success',
        message: 'Drive binding removed from this Talk.',
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        handleUnauthorized();
        return;
      }
      setToolStatus({
        status: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Failed to remove Drive binding.',
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
          suggestions.find((entry) => entry.modelId === agent.modelId)
            ?.modelId ||
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
                providerId:
                  agent.sourceKind === 'provider' ? agent.providerId : null,
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
        // Use registered agent name if available, otherwise fall back to
        // the old source-based nickname builder.
        const regAgent = registeredAgentsCatalog.find(
          (ra) => ra.id === agent.id,
        );
        const base = regAgent
          ? regAgent.name
          : buildAutoNicknameBase({
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
      current.map((agent) =>
        agent.id === agentId ? { ...agent, role } : agent,
      ),
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
    // newAgentDraft.modelId is overloaded to store the registered agent ID
    // (set by the "Agent" dropdown in the add-agent footer).
    const regAgent = registeredAgentsCatalog.find(
      (ra) => ra.id === newAgentDraft.modelId,
    );
    if (!regAgent) return;
    setAgentDrafts((current) => {
      const nickname = buildUniqueNickname(regAgent.name, current);
      return [
        ...current,
        {
          id: regAgent.id,
          nickname,
          nicknameMode: 'auto',
          sourceKind: 'provider',
          role: newAgentDraft.role,
          isPrimary: false,
          displayOrder: current.length,
          health: 'ready',
          providerId: regAgent.providerId,
          modelId: regAgent.modelId,
          modelDisplayName: null,
        },
      ];
    });
    // Reset the draft so the dropdown goes back to placeholder
    // (the just-added agent is now filtered out of the options).
    setNewAgentDraft((current) => ({ ...current, modelId: '' }));
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
        message:
          err instanceof Error ? err.message : 'Failed to update talk agents',
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
  const displayedTitle = isRenaming
    ? (renameDraft?.draft ?? '')
    : titleOverride || talk.title;

  return (
    <section className="page-shell talk-detail-shell">
      <div
        className={`talk-workspace${isDragOver ? ' talk-workspace-drag-over' : ''}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {isDragOver ? (
          <div className="talk-workspace-drop-overlay">
            Drop files to attach
          </div>
        ) : null}
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
                      await onRenameDraftCommit(
                        talkId,
                        renameDraft?.draft ?? '',
                      );
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
                <div
                  className="talk-status-strip"
                  role="list"
                  aria-label="Talk agent status"
                >
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
                  to={toolsTabHref}
                  className={`talk-tab ${currentTab === 'tools' ? 'talk-tab-active' : ''}`}
                >
                  Tools
                </Link>
                <Link
                  to={contextTabHref}
                  className={`talk-tab ${currentTab === 'context' ? 'talk-tab-active' : ''}`}
                >
                  Context
                </Link>
                <Link
                  to={channelsTabHref}
                  className={`talk-tab ${currentTab === 'channels' ? 'talk-tab-active' : ''}`}
                >
                  Channels
                </Link>
                <Link
                  to={connectorsTabHref}
                  className={`talk-tab ${currentTab === 'data-connectors' ? 'talk-tab-active' : ''}`}
                >
                  Data Connectors
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
                Nicknames are local to this talk. The primary agent responds to
                normal user messages by default.
              </p>
              {agentDrafts.map((agent) => (
                  <div key={agent.id} className="agent-editor-card">
                    <label>
                      <span>Registered Agent</span>
                      <select
                        value={agent.id}
                        onChange={(event) => {
                          const regAgent = registeredAgentsCatalog.find(
                            (ra) => ra.id === event.target.value,
                          );
                          if (!regAgent) return;
                          setAgentDrafts((current) =>
                            current.map((a) =>
                              a.id === agent.id
                                ? {
                                    ...a,
                                    id: regAgent.id,
                                    sourceKind: 'provider',
                                    providerId: regAgent.providerId,
                                    modelId: regAgent.modelId,
                                    modelDisplayName: null,
                                    nickname:
                                      a.nicknameMode === 'auto'
                                        ? regAgent.name
                                        : a.nickname,
                                    health: 'ready',
                                  }
                                : a,
                            ),
                          );
                          setAgentState({ status: 'idle' });
                        }}
                        disabled={
                          !canEditAgents || agentState.status === 'saving'
                        }
                      >
                        <option value={agent.id} disabled={!registeredAgentsCatalog.some((ra) => ra.id === agent.id)}>
                          {registeredAgentsCatalog.find((ra) => ra.id === agent.id)?.name || agent.nickname || 'Unknown agent'}
                        </option>
                        {registeredAgentsCatalog
                          .filter((ra) => ra.enabled && ra.id !== agent.id && !agentDrafts.some((d) => d.id === ra.id))
                          .map((ra) => (
                            <option key={ra.id} value={ra.id}>
                              {ra.name} ({ra.modelId})
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
                          handleAgentNicknameChange(
                            agent.id,
                            event.target.value,
                          )
                        }
                        disabled={
                          !canEditAgents || agentState.status === 'saving'
                        }
                      />
                    </label>
                    <label>
                      <span>Role</span>
                      <select
                        value={agent.role}
                        onChange={(event) =>
                          handleAgentRoleChange(
                            agent.id,
                            event.target.value as TalkAgent['role'],
                          )
                        }
                        disabled={
                          !canEditAgents || agentState.status === 'saving'
                        }
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
                          disabled={
                            !canEditAgents || agentState.status === 'saving'
                          }
                        />
                        <span>Primary Agent</span>
                      </label>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => handleResetNickname(agent.id)}
                        disabled={
                          !canEditAgents || agentState.status === 'saving'
                        }
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
              ))}

              <div className="agent-editor-footer">
                <label>
                  <span>Agent</span>
                  <select
                    value={newAgentDraft.modelId}
                    onChange={(event) => {
                      const ra = registeredAgentsCatalog.find(
                        (a) => a.id === event.target.value,
                      );
                      if (!ra) return;
                      setNewAgentDraft({
                        sourceKind: 'provider',
                        providerId: ra.providerId,
                        modelId: ra.id,
                        role: (ra.personaRole as TalkAgent['role']) || 'assistant',
                      });
                    }}
                    disabled={!canEditAgents || agentState.status === 'saving'}
                  >
                    <option value="" disabled>
                      Choose a registered agent…
                    </option>
                    {registeredAgentsCatalog
                      .filter((ra) => ra.enabled && !agentDrafts.some((d) => d.id === ra.id))
                      .map((ra) => (
                        <option key={ra.id} value={ra.id}>
                          {ra.name} ({ra.modelId})
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
                  disabled={
                    !canEditAgents ||
                    agentState.status === 'saving' ||
                    !newAgentDraft.modelId
                  }
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
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {agentState.message}
                </div>
              ) : null}
            </section>
          ) : null}

          {currentTab === 'context' ? (
            <section className="talk-tab-panel" aria-label="Talk context">
              {contextStatus.status === 'loading' ? (
                <p className="page-state">Loading context…</p>
              ) : contextStatus.status === 'error' ? (
                <p className="page-state error">{contextStatus.message}</p>
              ) : (
                <>
                  {/* Goal */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Goal</h3>
                        <p className="talk-llm-meta">
                          A single-line goal for what this talk is about. Agents
                          see this every turn.
                        </p>
                      </div>
                    </div>
                    {canEditAgents ? (
                      <>
                        <div className="connector-attach-row">
                          <label style={{ flex: 1 }}>
                            <input
                              type="text"
                              maxLength={160}
                              value={goalDraft}
                              onChange={(e) => setGoalDraft(e.target.value)}
                              placeholder="e.g. Summarize Q4 earnings calls"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleSaveGoal()}
                            disabled={contextStatus.status === 'saving'}
                          >
                            Save
                          </button>
                        </div>
                        <p className="talk-llm-meta">{goalDraft.length}/160</p>
                      </>
                    ) : (
                      <p className="talk-llm-meta">
                        {contextGoal?.goalText || <em>No goal set.</em>}
                      </p>
                    )}
                  </div>

                  {/* Rules */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Rules</h3>
                        <p className="talk-llm-meta">
                          Instructions agents must follow every turn. Up to 8
                          active rules.
                        </p>
                      </div>
                    </div>
                    {contextRules.length > 0 ? (
                      <ul
                        className="context-rules-list"
                        style={{ listStyle: 'none', padding: 0 }}
                      >
                        {contextRules.map((rule) => (
                          <li
                            key={rule.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.5rem',
                              padding: '0.25rem 0',
                              opacity: rule.isActive ? 1 : 0.5,
                            }}
                          >
                            {canEditAgents ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleToggleRule(rule)}
                                title={
                                  rule.isActive ? 'Pause rule' : 'Activate rule'
                                }
                                style={{
                                  minWidth: '2rem',
                                  padding: '0.2rem 0.4rem',
                                }}
                              >
                                {rule.isActive ? '✓' : '—'}
                              </button>
                            ) : null}
                            <span style={{ flex: 1 }}>{rule.ruleText}</span>
                            {canEditAgents ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() => void handleDeleteRule(rule.id)}
                                title="Delete rule"
                                style={{
                                  minWidth: '2rem',
                                  padding: '0.2rem 0.4rem',
                                }}
                              >
                                ×
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">No rules yet.</p>
                    )}
                    {canEditAgents ? (
                      <div
                        className="connector-attach-row"
                        style={{ marginTop: '0.5rem' }}
                      >
                        <label style={{ flex: 1 }}>
                          <input
                            type="text"
                            maxLength={240}
                            value={newRuleText}
                            onChange={(e) => setNewRuleText(e.target.value)}
                            placeholder="Add a rule…"
                            disabled={contextStatus.status === 'saving'}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void handleAddRule();
                            }}
                            style={{ width: '100%' }}
                          />
                        </label>
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleAddRule()}
                          disabled={
                            contextStatus.status === 'saving' ||
                            !newRuleText.trim()
                          }
                        >
                          Add Rule
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {/* Saved Sources */}
                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Saved Sources</h3>
                        <p className="talk-llm-meta">
                          Files, URLs, and text snippets agents can reference.
                          Up to 20 sources.
                        </p>
                      </div>
                    </div>
                    {contextSources.length > 0 ? (
                      <ul style={{ listStyle: 'none', padding: 0 }}>
                        {contextSources.map((source) => (
                          <li
                            key={source.id}
                            style={{
                              padding: '0.35rem 0',
                              borderBottom: '1px solid var(--border, #eee)',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                              }}
                            >
                              <span
                                style={{
                                  fontFamily: 'monospace',
                                  fontSize: '0.75rem',
                                  opacity: 0.6,
                                }}
                              >
                                {source.sourceRef}
                              </span>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  textTransform: 'uppercase',
                                  opacity: 0.5,
                                }}
                              >
                                [{source.sourceType}]
                              </span>
                              <span style={{ flex: 1 }}>{source.title}</span>
                              {source.fetchStrategy ? (
                                <span
                                  style={{
                                    fontSize: '0.7rem',
                                    textTransform: 'uppercase',
                                    opacity: 0.6,
                                  }}
                                >
                                  via {source.fetchStrategy}
                                </span>
                              ) : null}
                              <span
                                style={{
                                  fontSize: '0.75rem',
                                  color:
                                    source.status === 'ready'
                                      ? 'green'
                                      : source.status === 'failed'
                                        ? 'red'
                                        : 'orange',
                                }}
                              >
                                {source.status}
                              </span>
                              {canEditAgents &&
                              source.sourceType === 'url' &&
                              source.status === 'failed' ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() =>
                                    void handleRetrySource(source.id)
                                  }
                                >
                                  Retry
                                </button>
                              ) : null}
                              {canEditAgents ? (
                                <button
                                  type="button"
                                  className="secondary-btn"
                                  onClick={() =>
                                    void handleDeleteSource(source.id)
                                  }
                                  title="Remove source"
                                  style={{
                                    minWidth: '2rem',
                                    padding: '0.2rem 0.4rem',
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                            </div>
                            {source.extractionError ? (
                              <p
                                style={{
                                  margin: '0.35rem 0 0 0',
                                  fontSize: '0.85rem',
                                  color: 'var(--danger-text, #a61b1b)',
                                }}
                              >
                                {source.extractionError}
                              </p>
                            ) : null}
                            {source.lastFetchedAt ? (
                              <p
                                style={{
                                  margin: '0.2rem 0 0 0',
                                  fontSize: '0.75rem',
                                  opacity: 0.65,
                                }}
                              >
                                Last fetched{' '}
                                {new Date(
                                  source.lastFetchedAt,
                                ).toLocaleString()}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">No sources yet.</p>
                    )}

                    {/* Add source form (editors only) */}
                    {canEditAgents ? (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div
                          className="connector-attach-row"
                          style={{ marginBottom: '0.5rem' }}
                        >
                          <label>
                            <span className="settings-label">Type</span>
                            <select
                              value={addSourceType}
                              onChange={(e) =>
                                setAddSourceType(
                                  e.target.value as 'text' | 'url',
                                )
                              }
                              disabled={contextStatus.status === 'saving'}
                            >
                              <option value="text">Text</option>
                              <option value="url">URL</option>
                            </select>
                          </label>
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Title</span>
                            <input
                              type="text"
                              value={addSourceTitle}
                              onChange={(e) =>
                                setAddSourceTitle(e.target.value)
                              }
                              placeholder="Source title"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                        </div>
                        {addSourceType === 'url' ? (
                          <label
                            style={{ display: 'block', marginBottom: '0.5rem' }}
                          >
                            <span className="settings-label">URL</span>
                            <input
                              type="url"
                              value={addSourceUrl}
                              onChange={(e) => setAddSourceUrl(e.target.value)}
                              placeholder="https://example.com/docs"
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%' }}
                            />
                          </label>
                        ) : (
                          <label
                            style={{ display: 'block', marginBottom: '0.5rem' }}
                          >
                            <span className="settings-label">Content</span>
                            <textarea
                              value={addSourceText}
                              onChange={(e) => setAddSourceText(e.target.value)}
                              placeholder="Paste text content here…"
                              rows={4}
                              disabled={contextStatus.status === 'saving'}
                              style={{ width: '100%', resize: 'vertical' }}
                            />
                          </label>
                        )}
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleAddSource()}
                          disabled={
                            contextStatus.status === 'saving' ||
                            !addSourceTitle.trim()
                          }
                        >
                          Add Source
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {contextStatus.status === 'success' &&
                  contextStatus.message ? (
                    <p className="page-state">{contextStatus.message}</p>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {currentTab === 'tools' ? (
            <section className="talk-tab-panel" aria-label="Talk tools">
              {toolStatus.status === 'loading' ? (
                <p className="page-state">Loading Talk tools…</p>
              ) : toolStatus.status === 'error' ? (
                <p className="page-state error">{toolStatus.message}</p>
              ) : talkTools ? (
                <>
                  <div className="agents-panel-header">
                    <h2>Tools</h2>
                  </div>
                  <p className="policy-muted">
                    Bind bounded resources, grant tool access for this Talk, and
                    inspect which agents can actually use those tools.
                  </p>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Capability Summary</h3>
                        <p className="talk-llm-meta">
                          Effective Talk-wide capability summary for the current
                          bindings and user identity.
                        </p>
                      </div>
                    </div>
                    {talkTools.summary.length > 0 ? (
                      <ul style={{ margin: 0, paddingLeft: '1.25rem' }}>
                        {talkTools.summary.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">
                        No Talk tools are enabled yet.
                      </p>
                    )}
                    {talkTools.warnings.map((warning) => (
                      <div
                        key={warning}
                        className="inline-banner inline-banner-warning"
                        role="status"
                        style={{ marginTop: '0.75rem' }}
                      >
                        {warning}
                      </div>
                    ))}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Google Account</h3>
                        <p className="talk-llm-meta">
                          Google-scoped tools run as the triggering user.
                        </p>
                      </div>
                    </div>
                    <p className="talk-llm-meta">
                      {talkTools.googleAccount.connected
                        ? `Connected as ${talkTools.googleAccount.email || 'Unknown account'}`
                        : 'No Google account connected for this user.'}
                    </p>
                    {talkTools.googleAccount.scopes.length > 0 ? (
                      <p className="talk-llm-meta">
                        Scopes: {talkTools.googleAccount.scopes.join(', ')}
                      </p>
                    ) : null}
                    <div className="settings-button-row">
                      {canEditAgents && !talkTools.googleAccount.connected ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleConnectGoogleAccount()}
                          disabled={toolStatus.status === 'saving'}
                        >
                          Connect Google
                        </button>
                      ) : null}
                      {canEditAgents && missingGoogleScopes.length > 0 ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleGrantGoogleScopes()}
                          disabled={toolStatus.status === 'saving'}
                        >
                          Grant Google permissions
                        </button>
                      ) : null}
                    </div>
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Talk Grants</h3>
                        <p className="talk-llm-meta">
                          Enable or restrict built-in tool capabilities for this
                          Talk.
                        </p>
                      </div>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns:
                          'repeat(auto-fit, minmax(220px, 1fr))',
                        gap: '0.75rem',
                      }}
                    >
                      {talkTools.registry.map((entry) => (
                        <label
                          key={entry.id}
                          className="talk-llm-card"
                          style={{ margin: 0 }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '0.75rem',
                            }}
                          >
                            <strong>{entry.displayName}</strong>
                            <input
                              type="checkbox"
                              aria-label={entry.displayName}
                              checked={toolGrantDrafts[entry.id] ?? false}
                              disabled={
                                !canEditAgents || toolStatus.status === 'saving'
                              }
                              onChange={(event) =>
                                setToolGrantDrafts((current) => ({
                                  ...current,
                                  [entry.id]: event.target.checked,
                                }))
                              }
                            />
                          </div>
                          <p
                            className="talk-llm-meta"
                            style={{ marginBottom: 0 }}
                          >
                            {entry.description}
                          </p>
                        </label>
                      ))}
                    </div>
                    {canEditAgents ? (
                      <div
                        className="settings-button-row"
                        style={{ marginTop: '0.75rem' }}
                      >
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleSaveTalkTools()}
                          disabled={
                            toolStatus.status === 'saving' ||
                            !hasUnsavedToolChanges
                          }
                        >
                          {toolStatus.status === 'saving'
                            ? 'Saving…'
                            : 'Save Tool Grants'}
                        </button>
                      </div>
                    ) : null}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Bound Drive Resources</h3>
                        <p className="talk-llm-meta">
                          Agents may only search/read Drive, Docs, and Sheets
                          inside these bounds.
                        </p>
                      </div>
                    </div>
                    {talkTools.bindings.length > 0 ? (
                      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                        {talkTools.bindings.map((binding) => (
                          <li
                            key={binding.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.45rem 0',
                              borderBottom: '1px solid var(--border, #e6e9ef)',
                            }}
                          >
                            <span
                              style={{
                                fontSize: '0.72rem',
                                textTransform: 'uppercase',
                                opacity: 0.6,
                              }}
                            >
                              {binding.bindingKind === 'google_drive_folder'
                                ? 'Folder'
                                : binding.bindingKind === 'google_drive_file'
                                  ? 'File'
                                  : binding.bindingKind}
                            </span>
                            <strong style={{ flex: 1 }}>
                              {binding.displayName}
                            </strong>
                            <code>{binding.externalId}</code>
                            {canEditAgents ? (
                              <button
                                type="button"
                                className="secondary-btn"
                                onClick={() =>
                                  void handleDeleteDriveBinding(binding.id)
                                }
                                disabled={toolStatus.status === 'saving'}
                              >
                                Remove
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="page-state">
                        No Drive files or folders are bound to this Talk yet.
                      </p>
                    )}
                    {canEditAgents ? (
                      <div style={{ marginTop: '0.75rem' }}>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Kind</span>
                            <select
                              value={driveBindingDraft.bindingKind}
                              onChange={(event) =>
                                setDriveBindingDraft((current) => ({
                                  ...current,
                                  bindingKind: event.target.value as
                                    | 'google_drive_folder'
                                    | 'google_drive_file',
                                }))
                              }
                              disabled={toolStatus.status === 'saving'}
                            >
                              <option value="google_drive_folder">
                                Folder
                              </option>
                              <option value="google_drive_file">File</option>
                            </select>
                          </label>
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Display Name</span>
                            <input
                              type="text"
                              value={driveBindingDraft.displayName}
                              onChange={(event) =>
                                setDriveBindingDraft((current) => ({
                                  ...current,
                                  displayName: event.target.value,
                                }))
                              }
                              placeholder="Accounting"
                              style={{ width: '100%' }}
                              disabled={toolStatus.status === 'saving'}
                            />
                          </label>
                        </div>
                        <label
                          style={{ display: 'block', marginTop: '0.5rem' }}
                        >
                          <span className="settings-label">Resource ID</span>
                          <input
                            type="text"
                            value={driveBindingDraft.externalId}
                            onChange={(event) =>
                              setDriveBindingDraft((current) => ({
                                ...current,
                                externalId: event.target.value,
                              }))
                            }
                            placeholder="drive-folder-id-or-file-id"
                            style={{ width: '100%' }}
                            disabled={toolStatus.status === 'saving'}
                          />
                        </label>
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleAddDriveBinding()}
                            disabled={toolStatus.status === 'saving'}
                          >
                            Add Drive Binding
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  <div className="talk-llm-card">
                    <div className="connector-card-header">
                      <div>
                        <h3>Effective Agent Access</h3>
                        <p className="talk-llm-meta">
                          Which agents can actually use the currently granted
                          tools on this Talk.
                        </p>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: '0.75rem' }}>
                      {talkTools.effectiveAccess.map((agent) => (
                        <article key={agent.agentId} className="talk-llm-card">
                          <div className="connector-card-header">
                            <div>
                              <h3>{agent.nickname}</h3>
                              <p className="talk-llm-meta">
                                {agent.modelId || 'No model selected'}
                              </p>
                            </div>
                          </div>
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '0.5rem',
                            }}
                          >
                            {agent.toolAccess.map((tool) => {
                              const entry = talkTools.registry.find(
                                (candidate) => candidate.id === tool.toolId,
                              );
                              if (!entry) return null;
                              return (
                                <span
                                  key={`${agent.agentId}:${tool.toolId}`}
                                  className="talk-agent-chip"
                                  title={tool.toolId}
                                >
                                  {entry.displayName}:{' '}
                                  {formatToolAccessState(tool.state)}
                                </span>
                              );
                            })}
                          </div>
                        </article>
                      ))}
                    </div>
                  </div>

                  {toolStatus.status === 'success' ? (
                    <div
                      className="inline-banner inline-banner-success"
                      role="status"
                    >
                      {toolStatus.message}
                    </div>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : null}

          {currentTab === 'channels' ? (
            <section className="talk-tab-panel" aria-label="Talk channels">
              <div className="agents-panel-header">
                <h2>Channels</h2>
              </div>
              <p className="policy-muted">
                Bind this talk to external channels so inbound Telegram messages
                can create Talk turns and completed replies can be delivered
                back out.
              </p>

              {channelStatus.status === 'error' ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {channelStatus.message}
                </div>
              ) : null}
              {channelStatus.status === 'success' ? (
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {channelStatus.message}
                </div>
              ) : null}

              {canBrowseChannelConnections ? (
                <div className="talk-llm-card connector-attach-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>Add Channel Binding</h3>
                      <p className="talk-llm-meta">
                        V1 uses your system-managed Telegram connection and
                        cached chat targets discovered by inbound traffic.
                      </p>
                    </div>
                  </div>
                  {channelConnections.length === 0 ? (
                    <p className="page-state">
                      No channel connections are available in this runtime.
                    </p>
                  ) : (
                    <>
                      <div className="connector-attach-row">
                        <label>
                          <span className="settings-label">Connection</span>
                          <select
                            value={channelCreateDraft.connectionId ?? ''}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                connectionId: event.target.value,
                                targetKey: '',
                                displayName: '',
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            {channelConnections.map((connection) => (
                              <option key={connection.id} value={connection.id}>
                                {connection.displayName} (
                                {formatChannelPlatform(connection.platform)})
                              </option>
                            ))}
                          </select>
                        </label>
                        <label style={{ flex: 1 }}>
                          <span className="settings-label">Target</span>
                          <select
                            value={channelCreateDraft.targetKey ?? ''}
                            onChange={(event) => {
                              const nextTarget =
                                channelTargets.find(
                                  (target) =>
                                    buildChannelTargetKey(target) ===
                                    event.target.value,
                                ) || null;
                              setChannelCreateDraft((current) => ({
                                ...current,
                                targetKey: event.target.value,
                                displayName:
                                  current.displayName || !nextTarget
                                    ? current.displayName
                                    : nextTarget.displayName,
                              }));
                            }}
                            disabled={
                              channelStatus.status === 'saving' ||
                              channelTargetsLoading
                            }
                          >
                            <option value="">
                              {channelTargetsLoading
                                ? 'Loading targets…'
                                : channelTargets.length === 0
                                  ? 'No targets discovered yet'
                                  : 'Select a Telegram chat'}
                            </option>
                            {channelTargets.map((target) => (
                              <option
                                key={buildChannelTargetKey(target)}
                                value={buildChannelTargetKey(target)}
                              >
                                {target.displayName} [{target.targetKind}]
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <div className="connector-attach-row">
                        <label style={{ flex: 1 }}>
                          <span className="settings-label">Display Name</span>
                          <input
                            type="text"
                            value={channelCreateDraft.displayName ?? ''}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                displayName: event.target.value,
                              }))
                            }
                            placeholder={
                              selectedChannelTarget?.displayName ||
                              'Telegram channel'
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">Response Mode</span>
                          <select
                            value={
                              channelCreateDraft.responseMode ?? 'mentions'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                responseMode: event.target
                                  .value as TalkChannelBinding['responseMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="off">Off</option>
                            <option value="mentions">Mentions</option>
                            <option value="all">All messages</option>
                          </select>
                        </label>
                        <label>
                          <span className="settings-label">Delivery</span>
                          <select
                            value={channelCreateDraft.deliveryMode ?? 'reply'}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                deliveryMode: event.target
                                  .value as TalkChannelBinding['deliveryMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="reply">Reply</option>
                            <option value="channel">Channel</option>
                          </select>
                        </label>
                      </div>
                      <div className="connector-attach-row">
                        <label>
                          <span className="settings-label">Responder</span>
                          <select
                            value={
                              channelCreateDraft.responderMode ?? 'primary'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                responderMode: event.target
                                  .value as TalkChannelBinding['responderMode'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="primary">Primary agent</option>
                            <option value="agent">Specific agent</option>
                          </select>
                        </label>
                        {channelCreateDraft.responderMode === 'agent' ? (
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Agent</span>
                            <select
                              value={channelCreateDraft.responderAgentId ?? ''}
                              onChange={(event) =>
                                setChannelCreateDraft((current) => ({
                                  ...current,
                                  responderAgentId: event.target.value,
                                }))
                              }
                              disabled={channelStatus.status === 'saving'}
                            >
                              <option value="">Select an agent</option>
                              {effectiveAgents.map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {buildAgentLabel(agent)}
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                      <div className="connector-attach-row">
                        <label>
                          <span className="settings-label">Rate / min</span>
                          <input
                            type="number"
                            min={1}
                            value={
                              channelCreateDraft.inboundRateLimitPerMinute ?? ''
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                inboundRateLimitPerMinute: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">Queue Limit</span>
                          <input
                            type="number"
                            min={1}
                            value={channelCreateDraft.maxPendingEvents ?? ''}
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                maxPendingEvents: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                        <label>
                          <span className="settings-label">Overflow</span>
                          <select
                            value={
                              channelCreateDraft.overflowPolicy ?? 'drop_oldest'
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                overflowPolicy: event.target
                                  .value as TalkChannelBinding['overflowPolicy'],
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          >
                            <option value="drop_oldest">Drop oldest</option>
                            <option value="drop_newest">Drop newest</option>
                          </select>
                        </label>
                        <label>
                          <span className="settings-label">
                            Busy timeout (min)
                          </span>
                          <input
                            type="number"
                            min={1}
                            value={
                              channelCreateDraft.maxDeferredAgeMinutes ?? ''
                            }
                            onChange={(event) =>
                              setChannelCreateDraft((current) => ({
                                ...current,
                                maxDeferredAgeMinutes: event.target.value,
                              }))
                            }
                            disabled={channelStatus.status === 'saving'}
                          />
                        </label>
                      </div>
                      <label style={{ display: 'block', marginTop: '0.75rem' }}>
                        <span className="settings-label">
                          Channel Context Note
                        </span>
                        <textarea
                          value={channelCreateDraft.channelContextNote ?? ''}
                          onChange={(event) =>
                            setChannelCreateDraft((current) => ({
                              ...current,
                              channelContextNote: event.target.value,
                            }))
                          }
                          placeholder="Optional note appended to the Talk prompt for this channel."
                          rows={3}
                          style={{ width: '100%', resize: 'vertical' }}
                          disabled={channelStatus.status === 'saving'}
                        />
                      </label>
                      <div
                        className="settings-button-row"
                        style={{ marginTop: '0.75rem' }}
                      >
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleCreateChannel()}
                          disabled={
                            channelStatus.status === 'saving' ||
                            !channelCreateDraft.connectionId ||
                            !channelCreateDraft.targetKey
                          }
                        >
                          {channelStatus.status === 'saving'
                            ? 'Saving…'
                            : 'Create Binding'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : canEditChannels ? (
                <div
                  className="inline-banner inline-banner-warning"
                  role="status"
                >
                  Only owners and admins can add new channel bindings. You can
                  still manage existing bindings below.
                </div>
              ) : null}

              {channelStatus.status === 'loading' ? (
                <p className="page-state">Loading channels…</p>
              ) : channelBindings.length === 0 ? (
                <p className="page-state">
                  No external channels are bound to this talk yet.
                </p>
              ) : (
                <div className="connector-card-list">
                  {channelBindings.map((binding) => {
                    const draft =
                      channelDrafts[binding.id] ||
                      buildChannelBindingDraft(binding);
                    const failures = channelFailuresByBindingId[binding.id] || {
                      ingress: [],
                      delivery: [],
                    };
                    return (
                      <article
                        key={binding.id}
                        className="talk-llm-card connector-card"
                      >
                        <div className="connector-card-header">
                          <div>
                            <h3>{binding.displayName}</h3>
                            <p className="talk-llm-meta">
                              {formatChannelPlatform(binding.platform)} ·{' '}
                              {binding.targetKind} ·{' '}
                              <code>{binding.targetId}</code>
                            </p>
                          </div>
                          <span
                            className={
                              binding.active
                                ? 'talk-agent-chip talk-agent-chip-success'
                                : 'talk-agent-chip'
                            }
                          >
                            {binding.active ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <div className="connector-meta-grid">
                          <div>
                            <strong>Connection</strong>
                            <p>{binding.connectionDisplayName}</p>
                          </div>
                          <div>
                            <strong>Pending ingress</strong>
                            <p>{binding.pendingIngressCount}</p>
                          </div>
                          <div>
                            <strong>Deferred ingress</strong>
                            <p>{binding.deferredIngressCount}</p>
                          </div>
                          <div>
                            <strong>Last ingress issue</strong>
                            <p>
                              {formatChannelReasonCode(
                                binding.lastIngressReasonCode,
                              )}
                            </p>
                          </div>
                          <div>
                            <strong>Last delivery issue</strong>
                            <p>
                              {formatChannelReasonCode(
                                binding.lastDeliveryReasonCode,
                              )}
                            </p>
                          </div>
                        </div>
                        <div className="connector-attach-row">
                          <label style={{ flex: 1 }}>
                            <span className="settings-label">Display Name</span>
                            <input
                              type="text"
                              value={draft.displayName ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  displayName: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">
                              Response Mode
                            </span>
                            <select
                              value={draft.responseMode ?? 'mentions'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  responseMode: event.target
                                    .value as TalkChannelBinding['responseMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="off">Off</option>
                              <option value="mentions">Mentions</option>
                              <option value="all">All messages</option>
                            </select>
                          </label>
                          <label>
                            <span className="settings-label">Delivery</span>
                            <select
                              value={draft.deliveryMode ?? 'reply'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  deliveryMode: event.target
                                    .value as TalkChannelBinding['deliveryMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="reply">Reply</option>
                              <option value="channel">Channel</option>
                            </select>
                          </label>
                        </div>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Responder</span>
                            <select
                              value={draft.responderMode ?? 'primary'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  responderMode: event.target
                                    .value as TalkChannelBinding['responderMode'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="primary">Primary agent</option>
                              <option value="agent">Specific agent</option>
                            </select>
                          </label>
                          {draft.responderMode === 'agent' ? (
                            <label style={{ flex: 1 }}>
                              <span className="settings-label">Agent</span>
                              <select
                                value={draft.responderAgentId ?? ''}
                                onChange={(event) =>
                                  handleChannelDraftChange(binding.id, {
                                    responderAgentId: event.target.value,
                                  })
                                }
                                disabled={
                                  !canEditChannels ||
                                  channelStatus.status === 'saving'
                                }
                              >
                                <option value="">Select an agent</option>
                                {effectiveAgents.map((agent) => (
                                  <option key={agent.id} value={agent.id}>
                                    {buildAgentLabel(agent)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : null}
                          <label>
                            <span className="settings-label">Enabled</span>
                            <select
                              value={draft.active ? 'active' : 'inactive'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  active: event.target.value === 'active',
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="active">Active</option>
                              <option value="inactive">Inactive</option>
                            </select>
                          </label>
                        </div>
                        <div className="connector-attach-row">
                          <label>
                            <span className="settings-label">Rate / min</span>
                            <input
                              type="number"
                              min={1}
                              value={draft.inboundRateLimitPerMinute ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  inboundRateLimitPerMinute: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">Queue Limit</span>
                            <input
                              type="number"
                              min={1}
                              value={draft.maxPendingEvents ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  maxPendingEvents: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                          <label>
                            <span className="settings-label">Overflow</span>
                            <select
                              value={draft.overflowPolicy ?? 'drop_oldest'}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  overflowPolicy: event.target
                                    .value as TalkChannelBinding['overflowPolicy'],
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            >
                              <option value="drop_oldest">Drop oldest</option>
                              <option value="drop_newest">Drop newest</option>
                            </select>
                          </label>
                          <label>
                            <span className="settings-label">
                              Busy timeout (min)
                            </span>
                            <input
                              type="number"
                              min={1}
                              value={draft.maxDeferredAgeMinutes ?? ''}
                              onChange={(event) =>
                                handleChannelDraftChange(binding.id, {
                                  maxDeferredAgeMinutes: event.target.value,
                                })
                              }
                              disabled={
                                !canEditChannels ||
                                channelStatus.status === 'saving'
                              }
                            />
                          </label>
                        </div>
                        <label
                          style={{ display: 'block', marginTop: '0.75rem' }}
                        >
                          <span className="settings-label">
                            Channel Context Note
                          </span>
                          <textarea
                            value={draft.channelContextNote ?? ''}
                            onChange={(event) =>
                              handleChannelDraftChange(binding.id, {
                                channelContextNote: event.target.value,
                              })
                            }
                            rows={3}
                            style={{ width: '100%', resize: 'vertical' }}
                            disabled={
                              !canEditChannels ||
                              channelStatus.status === 'saving'
                            }
                          />
                        </label>
                        <div
                          className="settings-button-row"
                          style={{ marginTop: '0.75rem' }}
                        >
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleSaveChannelBinding(binding)
                            }
                            disabled={
                              !canEditChannels ||
                              channelStatus.status === 'saving'
                            }
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() => void handleTestChannel(binding)}
                            disabled={channelStatus.status === 'saving'}
                          >
                            Test Send
                          </button>
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleDeleteChannelBinding(binding)
                            }
                            disabled={
                              !canEditChannels ||
                              channelStatus.status === 'saving'
                            }
                          >
                            Delete
                          </button>
                        </div>

                        {failures.ingress.length > 0 ? (
                          <div style={{ marginTop: '1rem' }}>
                            <h4>Ingress Failures</h4>
                            <ul
                              style={{
                                listStyle: 'none',
                                padding: 0,
                                margin: '0.5rem 0 0 0',
                              }}
                            >
                              {failures.ingress.map((failure) => (
                                <li
                                  key={failure.id}
                                  style={{
                                    padding: '0.5rem 0',
                                    borderTop:
                                      '1px solid var(--border, #e6e9ef)',
                                  }}
                                >
                                  <p style={{ margin: 0, fontWeight: 600 }}>
                                    {formatChannelReasonCode(
                                      failure.reasonCode,
                                    )}
                                  </p>
                                  <p
                                    style={{
                                      margin: '0.25rem 0',
                                      opacity: 0.75,
                                    }}
                                  >
                                    {failure.senderName ||
                                      failure.senderId ||
                                      'Unknown sender'}{' '}
                                    · {formatDateTime(failure.createdAt)}
                                  </p>
                                  {failure.reasonDetail ? (
                                    <p style={{ margin: '0.25rem 0' }}>
                                      {failure.reasonDetail}
                                    </p>
                                  ) : null}
                                  <div className="settings-button-row">
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleRetryIngressFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Retry
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleDismissIngressFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {failures.delivery.length > 0 ? (
                          <div style={{ marginTop: '1rem' }}>
                            <h4>Delivery Failures</h4>
                            <ul
                              style={{
                                listStyle: 'none',
                                padding: 0,
                                margin: '0.5rem 0 0 0',
                              }}
                            >
                              {failures.delivery.map((failure) => (
                                <li
                                  key={failure.id}
                                  style={{
                                    padding: '0.5rem 0',
                                    borderTop:
                                      '1px solid var(--border, #e6e9ef)',
                                  }}
                                >
                                  <p style={{ margin: 0, fontWeight: 600 }}>
                                    {formatChannelReasonCode(
                                      failure.reasonCode,
                                    )}
                                  </p>
                                  <p
                                    style={{
                                      margin: '0.25rem 0',
                                      opacity: 0.75,
                                    }}
                                  >
                                    {formatDateTime(failure.createdAt)}
                                  </p>
                                  {failure.reasonDetail ? (
                                    <p style={{ margin: '0.25rem 0' }}>
                                      {failure.reasonDetail}
                                    </p>
                                  ) : null}
                                  <div className="settings-button-row">
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleRetryDeliveryFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Retry
                                    </button>
                                    <button
                                      type="button"
                                      className="secondary-btn"
                                      onClick={() =>
                                        void handleDismissDeliveryFailure(
                                          binding.id,
                                          failure.id,
                                        )
                                      }
                                      disabled={
                                        channelStatus.status === 'saving'
                                      }
                                    >
                                      Dismiss
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          ) : null}

          {currentTab === 'data-connectors' ? (
            <section
              className="talk-tab-panel"
              aria-label="Talk data connectors"
            >
              <div className="agents-panel-header">
                <h2>Data Connectors</h2>
                {canManageTalkConnectors ? (
                  <Link className="secondary-btn" to={manageConnectorsHref}>
                    Manage Data Connectors
                  </Link>
                ) : null}
              </div>
              <p className="policy-muted">
                Attach org-level data sources to this talk. Attached connectors
                are available as query tools during talk execution.
              </p>

              {canManageTalkConnectors ? (
                <div className="talk-llm-card connector-attach-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>Attach Connector</h3>
                      <p className="talk-llm-meta">
                        Only verified org-level connectors can be attached.
                      </p>
                    </div>
                  </div>
                  {availableConnectors.length === 0 ? (
                    <p className="page-state">
                      No verified connectors are available to attach. Connectors
                      must be enabled and have verified credentials.
                    </p>
                  ) : (
                    <div className="connector-attach-row">
                      <label>
                        <span className="settings-label">Connector</span>
                        <select
                          value={attachConnectorId}
                          onChange={(event) =>
                            setAttachConnectorId(event.target.value)
                          }
                          disabled={connectorState.status === 'saving'}
                        >
                          {availableConnectors.map((connector) => (
                            <option key={connector.id} value={connector.id}>
                              {connector.name} (
                              {formatConnectorKind(connector.connectorKind)})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleAttachConnector()}
                        disabled={
                          connectorState.status === 'saving' ||
                          !attachConnectorId
                        }
                      >
                        {connectorState.status === 'saving'
                          ? 'Saving…'
                          : 'Attach Connector'}
                      </button>
                    </div>
                  )}
                </div>
              ) : null}

              {connectorState.status === 'error' ? (
                <div className="inline-banner inline-banner-error" role="alert">
                  {connectorState.message}
                </div>
              ) : null}
              {connectorState.status === 'success' ? (
                <div
                  className="inline-banner inline-banner-success"
                  role="status"
                >
                  {connectorState.message}
                </div>
              ) : null}

              {talkConnectors.length === 0 ? (
                <p className="page-state">
                  No data connectors attached to this talk.
                </p>
              ) : (
                <div className="connector-card-list">
                  {talkConnectors.map((connector) => (
                    <article
                      key={connector.id}
                      className="talk-llm-card connector-card"
                    >
                      <div className="connector-card-header">
                        <div>
                          <h3>{connector.name}</h3>
                          <p className="talk-llm-meta">
                            {formatConnectorKind(connector.connectorKind)}
                          </p>
                        </div>
                        <span
                          className={connectorStatusClass(
                            connector.verificationStatus,
                          )}
                        >
                          {formatConnectorStatus(connector.verificationStatus)}
                        </span>
                      </div>
                      <div className="connector-meta-grid">
                        <div>
                          <strong>Credential</strong>
                          <p>
                            {connector.hasCredential ? 'Stored' : 'Missing'}
                          </p>
                        </div>
                        <div>
                          <strong>Attached</strong>
                          <p>{formatDateTime(connector.attachedAt)}</p>
                        </div>
                        <div>
                          <strong>Last verified</strong>
                          <p>{formatDateTime(connector.lastVerifiedAt)}</p>
                        </div>
                      </div>
                      {connector.lastVerificationError ? (
                        <div
                          className="inline-banner inline-banner-warning"
                          role="status"
                        >
                          {connector.lastVerificationError}
                        </div>
                      ) : null}
                      {canManageTalkConnectors ? (
                        <div className="settings-button-row">
                          <button
                            type="button"
                            className="secondary-btn"
                            onClick={() =>
                              void handleDetachConnector(connector)
                            }
                            disabled={connectorState.status === 'saving'}
                          >
                            Detach
                          </button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {currentTab === 'runs' ? (
            <section
              className="talk-tab-panel run-history-panel"
              aria-label="Run history"
            >
              <h2>Run History</h2>
              {runHistory.length === 0 ? (
                <p className="page-state">No runs yet.</p>
              ) : (
                <ul className="run-history-list">
                  {runHistory.map((run) => (
                    <li key={run.id} className="run-history-item">
                      <div className="run-history-main">
                        <span
                          className={`run-history-status run-history-status-${run.status}`}
                        >
                          {run.status}
                        </span>
                        <code>{run.id}</code>
                      </div>
                      {run.targetAgentNickname ? (
                        <p className="run-history-meta">
                          Agent: {run.targetAgentNickname}
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
                          <span className="run-history-muted">
                            Trigger: not available
                          </span>
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
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  marginBottom: '12px',
                  flexWrap: 'wrap',
                }}
              >
                <p
                  style={{
                    margin: 0,
                    color: '#475569',
                    fontSize: '0.94rem',
                  }}
                >
                  Use <code>/edit</code> or the button here to remove old Talk
                  messages.
                </p>
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={openHistoryEditor}
                  disabled={!canEditHistory}
                >
                  Edit history
                </button>
              </div>
              {talkTimeline.length === 0 ? (
                <div className="talk-onboarding-banner">
                  <p>
                    This Talk is using the default agent with all tools enabled.{' '}
                    <Link
                      to={`/app/talks/${talkId}/agents`}
                      className="talk-onboarding-link"
                    >
                      Customize →
                    </Link>
                  </p>
                  <p className="page-state">No messages yet.</p>
                </div>
              ) : (
                talkTimeline.map((entry) => {
                  if (entry.kind === 'message') {
                    const { message } = entry;
                    const agentLabel =
                      (message.agentId && agentLabelById[message.agentId]) ||
                      message.agentNickname ||
                      null;
                    return (
                      <article
                        key={entry.key}
                        id={`message-${message.id}`}
                        ref={(element) =>
                          setMessageElementRef(message.id, element)
                        }
                        className={`message message-${message.role}`}
                      >
                        <header>
                          <strong>
                            {agentLabel ? `${agentLabel} · ` : ''}
                            {message.role}
                          </strong>
                          <time>
                            {new Date(message.createdAt).toLocaleString()}
                          </time>
                        </header>
                        <p>
                          {message.role === 'assistant'
                            ? stripInternalAssistantText(message.content)
                            : message.content}
                        </p>
                        {message.attachments &&
                        message.attachments.length > 0 ? (
                          <div className="message-attachments">
                            {message.attachments.map((att) => (
                              <span
                                key={att.id}
                                className="message-attachment-chip"
                                title={att.mimeType}
                              >
                                {att.fileName}
                                <span className="message-attachment-size">
                                  {' '}
                                  {att.fileSize < 1024
                                    ? `${att.fileSize} B`
                                    : att.fileSize < 1048576
                                      ? `${(att.fileSize / 1024).toFixed(1)} KB`
                                      : `${(att.fileSize / 1048576).toFixed(1)} MB`}
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    );
                  }

                  const { response } = entry;
                  const label =
                    (response.agentId && agentLabelById[response.agentId]) ||
                    response.agentNickname ||
                    'Assistant';
                  return (
                    <article
                      key={entry.key}
                      className={`message message-assistant message-live${
                        response.terminalStatus === 'failed'
                          ? ' message-error'
                          : ''
                      }`}
                    >
                      <header>
                        <strong>{label}</strong>
                        <time>
                          {response.terminalStatus === 'failed'
                            ? 'Failed'
                            : 'Streaming…'}
                        </time>
                      </header>
                      <p>{response.text || 'Thinking…'}</p>
                      {response.errorMessage ? (
                        <p className="run-history-error">
                          {response.errorMessage}
                        </p>
                      ) : null}
                    </article>
                  );
                })
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
          ) : null}
        </div>

        {currentTab === 'talk' ? (
          <form
            className="composer talk-workspace-composer"
            onSubmit={handleSend}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ALLOWED_ATTACHMENT_EXTENSIONS}
              onChange={handleFileInputChange}
              style={{ display: 'none' }}
            />
            <div
              className="composer-targets"
              role="group"
              aria-label="Selected agents"
            >
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
            <p className="composer-target-help">
              Selected agents will each respond independently.
            </p>

            <textarea
              value={draft}
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Send a message to this talk"
              rows={3}
              maxLength={TALK_MESSAGE_MAX_CHARS}
              disabled={
                state.sendState.status === 'posting' ||
                activeRound ||
                hasUnsavedAgentChanges
              }
            />

            {pendingAttachments.length > 0 ? (
              <div className="composer-attachments">
                {pendingAttachments.map((att) => (
                  <span
                    key={att.localId}
                    className={`composer-attachment-chip composer-attachment-${att.status}`}
                    title={
                      att.status === 'error' ? att.errorMessage : att.fileName
                    }
                  >
                    <span className="composer-attachment-name">
                      {att.fileName}
                    </span>
                    {att.status === 'uploading' ? (
                      <span className="composer-attachment-status">
                        {' '}
                        uploading…
                      </span>
                    ) : null}
                    {att.status === 'error' ? (
                      <span className="composer-attachment-status">
                        {' '}
                        failed
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="composer-attachment-remove"
                      onClick={() => handleRemoveAttachment(att.localId)}
                      aria-label={`Remove ${att.fileName}`}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div className="composer-controls">
              <span className="composer-count">
                {draft.length}/{TALK_MESSAGE_MAX_CHARS}
              </span>
              <button
                type="button"
                className="secondary-btn composer-attach-btn"
                onClick={handleAttachButtonClick}
                disabled={
                  state.sendState.status === 'posting' ||
                  activeRound ||
                  hasUnsavedAgentChanges
                }
                title="Attach files"
              >
                Attach
              </button>
              <button
                type="submit"
                className="primary-btn"
                disabled={
                  state.sendState.status === 'posting' ||
                  activeRound ||
                  hasUnsavedAgentChanges
                }
              >
                {state.sendState.status === 'posting' ? 'Sending…' : 'Send'}
              </button>
              {canEditAgents ? (
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={handleCancelRuns}
                  disabled={
                    state.cancelState.status === 'posting' || !activeRound
                  }
                >
                  {state.cancelState.status === 'posting'
                    ? 'Cancelling…'
                    : 'Cancel Runs'}
                </button>
              ) : null}
            </div>

            {activeRound ? (
              <div
                className="inline-banner inline-banner-warning"
                role="status"
              >
                Wait for the current round to finish or cancel it before sending
                another message.
              </div>
            ) : null}

            {!activeRound && hasUnsavedAgentChanges ? (
              <div
                className="inline-banner inline-banner-warning"
                role="status"
              >
                Save agent changes before sending a message.
              </div>
            ) : null}

            {state.sendState.status === 'error' ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {state.sendState.error || 'Unable to send message.'}
              </div>
            ) : null}

            {historyEditState.status === 'success' ? (
              <div
                className="inline-banner inline-banner-success"
                role="status"
              >
                {historyEditState.message}
              </div>
            ) : null}

            {historyEditState.status === 'error' ? (
              <div className="inline-banner inline-banner-error" role="alert">
                {historyEditState.message}
              </div>
            ) : null}

            {state.cancelState.status === 'success' ? (
              <div
                className="inline-banner inline-banner-success"
                role="status"
              >
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
      <TalkHistoryEditor
        isOpen={historyEditorOpen}
        messages={state.messages}
        busy={historyEditState.status === 'saving'}
        errorMessage={
          historyEditorOpen && historyEditState.status === 'error'
            ? historyEditState.message || null
            : null
        }
        onClose={handleCloseHistoryEditor}
        onConfirm={handleDeleteHistoryMessages}
        resolveActorLabel={resolveMessageActorLabel}
      />
    </section>
  );
}
