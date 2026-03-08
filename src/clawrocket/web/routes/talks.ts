import { randomUUID } from 'crypto';

import {
  cancelTalkRunsAtomic,
  createTalk,
  createTalkFolder,
  deleteTalkFolderAndMoveTalksToTopLevel,
  deleteTalkForOwner,
  deleteTalkLlmPolicy,
  enqueueTalkTurnAtomic,
  ensureTalkHasDefaultAgent,
  getPrimaryTalkAgent,
  getTalkById,
  getTalkForUser,
  getTalkRouteById,
  listAdditionalProviderCredentialCards,
  listTalkAgentInstances,
  listTalkAgents,
  listTalkFoldersForOwner,
  listTalkMessages,
  listTalkRunsForTalk,
  listTalkSidebarTreeForUser,
  listTalksForUser,
  normalizeTalkListPage,
  patchTalkMetadata,
  renameTalkFolder,
  reorderTalkSidebarItem,
  replaceTalkAgentInstances,
  replaceTalkAgents,
  type TalkAgentInstanceInput,
  resetTalkAgentsToDefault,
  upsertTalkLlmPolicy,
  type TalkAgentInput,
  type TalkMessageRecord,
  type TalkWithAccessRecord,
} from '../../db/index.js';
import type { TalkPersonaRole } from '../../llm/types.js';
import {
  parsePolicyAgentsForExecution,
  parsePolicyAgentsForUiBadges,
} from '../../talks/policy.js';
import type { ExecutorSettingsService } from '../../talks/executor-settings.js';
import { canEditTalk } from '../middleware/acl.js';
import { AuthContext, ApiEnvelope } from '../types.js';

interface TalkApiRecord {
  id: string;
  ownerId: string;
  folderId: string | null;
  sortOrder: number;
  title: string | null;
  agents: string[];
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
}

interface SidebarTalkApiRecord {
  id: string;
  title: string | null;
  status: 'active' | 'paused' | 'archived';
  sortOrder: number;
}

interface TalkFolderApiRecord {
  id: string;
  title: string;
  sortOrder: number;
  talks: SidebarTalkApiRecord[];
}

type TalkSidebarItemApiRecord =
  | ({
      type: 'talk';
    } & SidebarTalkApiRecord)
  | {
      type: 'folder';
      id: string;
      title: string;
      sortOrder: number;
      talks: SidebarTalkApiRecord[];
    };

interface TalkMessageApiRecord {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface TalkAgentApiRecord {
  id: string;
  nickname: string;
  nicknameMode: 'auto' | 'custom';
  sourceKind: 'claude_default' | 'provider';
  role: TalkPersonaRole;
  isPrimary: boolean;
  displayOrder: number;
  health: 'ready' | 'invalid' | 'unknown';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
}

export interface TalkRunApiRecord {
  id: string;
  status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  executorAlias: string | null;
  executorModel: string | null;
}

const DEFAULT_TALK_AGENTS = ['Claude'];
const MAX_TALK_AGENT_BADGES = 6;
const MAX_TALK_AGENTS = 12;
const MAX_TALK_AGENT_NAME_CHARS = 80;

function parseFallbackAgentBadges(llmPolicy: string | null): string[] {
  const normalized = parsePolicyAgentsForUiBadges(
    llmPolicy?.trim() || '',
    MAX_TALK_AGENT_BADGES,
  );
  return normalized.length > 0 ? normalized : DEFAULT_TALK_AGENTS;
}

function parseFallbackPolicyAgents(llmPolicy: string | null): string[] {
  return parsePolicyAgentsForExecution(llmPolicy);
}

function toTalkApiRecord(talk: TalkWithAccessRecord): TalkApiRecord {
  const persistedAgents = listTalkAgents(talk.id);
  const agents =
    persistedAgents.length > 0 ? listTalkAgentInstances(talk.id) : [];
  return {
    id: talk.id,
    ownerId: talk.owner_id,
    folderId: talk.folder_id,
    sortOrder: talk.sort_order,
    title: talk.topic_title,
    agents:
      agents.length > 0
        ? agents.slice(0, MAX_TALK_AGENT_BADGES).map((agent) => agent.nickname)
        : parseFallbackAgentBadges(talk.llm_policy),
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
}

function toSidebarTalkApiRecord(
  talk: TalkWithAccessRecord,
): SidebarTalkApiRecord {
  return {
    id: talk.id,
    title: talk.topic_title,
    status: talk.status,
    sortOrder: talk.sort_order,
  };
}

function mapVerificationToHealth(
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | null
    | undefined,
): 'ready' | 'invalid' | 'unknown' {
  if (verificationStatus === 'verified') return 'ready';
  if (
    verificationStatus === 'invalid' ||
    verificationStatus === 'unavailable'
  ) {
    return 'invalid';
  }
  return 'unknown';
}

function buildTalkAgentHealthLookup(
  executorSettings?: ExecutorSettingsService,
): {
  claudeDefaultHealth: 'ready' | 'invalid' | 'unknown';
  providerHealthById: Map<string, 'ready' | 'invalid' | 'unknown'>;
} {
  const providerHealthById = new Map<string, 'ready' | 'invalid' | 'unknown'>(
    listAdditionalProviderCredentialCards().map((provider) => [
      provider.id,
      mapVerificationToHealth(provider.verificationStatus),
    ]),
  );
  const claudeDefaultHealth = executorSettings
    ? mapVerificationToHealth(
        executorSettings.getSettingsView().verificationStatus,
      )
    : 'unknown';
  return { claudeDefaultHealth, providerHealthById };
}

function parseTalkRunError(
  run: Pick<
    ReturnType<typeof listTalkRunsForTalk>[number],
    'status' | 'cancel_reason'
  >,
): { errorCode: string | null; errorMessage: string | null } {
  const raw = run.cancel_reason?.trim() || null;
  if (!raw) {
    return { errorCode: null, errorMessage: null };
  }

  if (run.status === 'cancelled') {
    return { errorCode: 'cancelled', errorMessage: raw };
  }

  const prefixed = /^([a-z0-9_]+):\s*(.+)$/i.exec(raw);
  if (prefixed) {
    return { errorCode: prefixed[1], errorMessage: prefixed[2] };
  }

  if (raw === 'interrupted_by_restart') {
    return {
      errorCode: 'interrupted_by_restart',
      errorMessage: 'Run interrupted by process restart',
    };
  }

  return { errorCode: raw, errorMessage: raw };
}

function toTalkAgentApiRecord(
  agent: {
    id: string;
    nickname: string;
    nicknameMode: 'auto' | 'custom';
    sourceKind: 'claude_default' | 'provider';
    role: TalkPersonaRole;
    isLead: boolean;
    displayOrder: number;
    status: 'active' | 'archived';
    providerId: string | null;
    modelId: string | null;
    modelDisplayName: string | null;
  },
  healthLookup: {
    claudeDefaultHealth: 'ready' | 'invalid' | 'unknown';
    providerHealthById: Map<string, 'ready' | 'invalid' | 'unknown'>;
  },
): TalkAgentApiRecord {
  return {
    id: agent.id,
    nickname: agent.nickname,
    nicknameMode: agent.nicknameMode,
    sourceKind: agent.sourceKind,
    role: agent.role,
    isPrimary: agent.isLead,
    displayOrder: agent.displayOrder,
    health:
      agent.sourceKind === 'claude_default'
        ? healthLookup.claudeDefaultHealth
        : healthLookup.providerHealthById.get(agent.providerId || '') ||
          'unknown',
    providerId: agent.providerId,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
  };
}

function toTalkMessageApiRecord(
  message: TalkMessageRecord,
): TalkMessageApiRecord {
  let agentId: string | null | undefined;
  let agentNickname: string | null | undefined;
  let metadata: Record<string, unknown> | null = null;
  if (message.metadata_json) {
    try {
      const parsed = JSON.parse(message.metadata_json) as {
        agentId?: unknown;
        agentNickname?: unknown;
        agentName?: unknown;
      } & Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
        if (typeof parsed.agentId === 'string') agentId = parsed.agentId;
        if (typeof parsed.agentNickname === 'string') {
          agentNickname = parsed.agentNickname;
        } else if (typeof parsed.agentName === 'string') {
          agentNickname = parsed.agentName;
        }
      }
    } catch {
      // Ignore metadata parse failures for UI response shaping.
    }
  }

  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdBy: message.created_by,
    createdAt: message.created_at,
    runId: message.run_id,
    agentId,
    agentNickname,
    metadata,
  };
}

function validateAgentInputs(input: unknown): {
  agents?: TalkAgentInstanceInput[];
  error?: string;
} {
  if (!Array.isArray(input)) {
    return { error: 'agents must be an array' };
  }

  if (input.length === 0) {
    return { error: 'at least one talk agent is required' };
  }
  if (input.length > MAX_TALK_AGENTS) {
    return { error: `at most ${MAX_TALK_AGENTS} talk agents are allowed` };
  }

  const normalized: TalkAgentInstanceInput[] = [];
  let leadCount = 0;
  const ids = new Set<string>();
  for (let index = 0; index < input.length; index += 1) {
    const raw = input[index] as Record<string, unknown>;
    const role =
      typeof raw.role === 'string'
        ? (raw.role as TalkPersonaRole)
        : typeof raw.personaRole === 'string'
          ? (raw.personaRole as TalkPersonaRole)
          : null;
    const id =
      typeof raw.id === 'string' && raw.id.trim()
        ? raw.id.trim()
        : `agent_${randomUUID()}`;
    const isLead = raw.isPrimary === true || raw.isLead === true;
    const displayOrder =
      typeof raw.displayOrder === 'number'
        ? Math.max(0, Math.floor(raw.displayOrder))
        : typeof raw.sortOrder === 'number'
          ? Math.max(0, Math.floor(raw.sortOrder))
          : index;
    const sourceKind =
      raw.sourceKind === 'claude_default' || raw.sourceKind === 'provider'
        ? raw.sourceKind
        : null;
    const providerId =
      typeof raw.providerId === 'string' && raw.providerId.trim()
        ? raw.providerId.trim()
        : null;
    const modelId =
      typeof raw.modelId === 'string' && raw.modelId.trim()
        ? raw.modelId.trim()
        : null;
    const nickname =
      typeof raw.nickname === 'string' && raw.nickname.trim()
        ? raw.nickname.trim()
        : undefined;
    const nicknameMode =
      raw.nicknameMode === 'custom' || raw.nicknameMode === 'auto'
        ? raw.nicknameMode
        : undefined;

    if (
      !role ||
      ![
        'assistant',
        'analyst',
        'critic',
        'strategist',
        'devils-advocate',
        'synthesizer',
        'editor',
      ].includes(role)
    ) {
      return { error: 'each talk agent must have a valid role' };
    }
    if (!sourceKind) {
      return { error: 'each talk agent must have a valid source' };
    }
    if (!modelId) {
      return { error: 'each talk agent must have a model' };
    }
    if (sourceKind === 'provider' && !providerId) {
      return { error: 'provider talk agents must include a provider' };
    }
    if (ids.has(id)) return { error: 'talk agent ids must be unique' };
    ids.add(id);
    if (isLead) leadCount += 1;

    normalized.push({
      id,
      sourceKind,
      providerId,
      modelId,
      nickname,
      nicknameMode,
      role,
      isLead,
      displayOrder,
    });
  }

  if (leadCount !== 1) {
    return { error: 'exactly one talk agent must be marked lead' };
  }

  return { agents: normalized };
}

function listEffectiveTalkAgents(talkId: string): TalkAgentApiRecord[] {
  const healthLookup = buildTalkAgentHealthLookup();
  return listTalkAgentInstances(talkId).map((agent) =>
    toTalkAgentApiRecord(agent, healthLookup),
  );
}

export function listTalksRoute(input: {
  auth: AuthContext;
  limit?: number;
  offset?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talks: TalkApiRecord[];
    page: { limit: number; offset: number; count: number };
  }>;
} {
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });
  const talks = listTalksForUser({
    userId: input.auth.userId,
    limit: page.limit,
    offset: page.offset,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talks: talks.map(toTalkApiRecord),
        page: {
          limit: page.limit,
          offset: page.offset,
          count: talks.length,
        },
      },
    },
  };
}

export function listTalkSidebarRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ items: TalkSidebarItemApiRecord[] }>;
} {
  const tree = listTalkSidebarTreeForUser(input.auth.userId);
  const rootItems: TalkSidebarItemApiRecord[] = [
    ...tree.rootTalks.map((talk) => ({
      type: 'talk' as const,
      ...toSidebarTalkApiRecord(talk),
    })),
    ...tree.folders.map((folder) => ({
      type: 'folder' as const,
      id: folder.id,
      title: folder.title,
      sortOrder: folder.sort_order,
      talks: (tree.talksByFolderId[folder.id] || []).map((talk) =>
        toSidebarTalkApiRecord(talk),
      ),
    })),
  ].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        items: rootItems,
      },
    },
  };
}

export function createTalkFolderRoute(input: {
  auth: AuthContext;
  title?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title must be 160 characters or less',
        },
      },
    };
  }

  const folder = createTalkFolder({
    id: `folder_${randomUUID()}`,
    ownerId: input.auth.userId,
    title: rawTitle || 'Untitled Folder',
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        folder: {
          id: folder.id,
          title: folder.title,
          sortOrder: folder.sort_order,
          talks: [],
        },
      },
    },
  };
}

export function patchTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
  title?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ folder: TalkFolderApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (!rawTitle) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title is required',
        },
      },
    };
  }
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_folder_title',
          message: 'Folder title must be 160 characters or less',
        },
      },
    };
  }

  const folder = renameTalkFolder({
    id: input.folderId,
    ownerId: input.auth.userId,
    title: rawTitle,
  });
  if (!folder) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'folder_not_found',
          message: 'Folder not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        folder: {
          id: folder.id,
          title: folder.title,
          sortOrder: folder.sort_order,
          talks: [],
        },
      },
    },
  };
}

export function deleteTalkFolderRoute(input: {
  auth: AuthContext;
  folderId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const deleted = deleteTalkFolderAndMoveTalksToTopLevel({
    id: input.folderId,
    ownerId: input.auth.userId,
  });
  if (!deleted) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'folder_not_found',
          message: 'Folder not found',
        },
      },
    };
  }
  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

export function createTalkRoute(input: { auth: AuthContext; title?: string }): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const rawTitle = input.title?.trim() || '';
  if (rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title must be 160 characters or less',
        },
      },
    };
  }

  const talkId = `talk_${randomUUID()}`;
  const title = rawTitle || 'Untitled Talk';
  createTalk({
    id: talkId,
    ownerId: input.auth.userId,
    topicTitle: title,
    status: 'active',
  });
  ensureTalkHasDefaultAgent(talkId);

  const talk = getTalkForUser(talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'talk_create_failed',
          message: 'Talk created but failed to load persisted record',
        },
      },
    };
  }

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(talk),
      },
    },
  };
}

export function patchTalkRoute(input: {
  auth: AuthContext;
  talkId: string;
  title?: string;
  folderId?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }

  const rawTitle = input.title?.trim();
  if (rawTitle !== undefined && rawTitle.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title is required',
        },
      },
    };
  }
  if (rawTitle && rawTitle.length > 160) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_title',
          message: 'Talk title must be 160 characters or less',
        },
      },
    };
  }

  const updated = patchTalkMetadata({
    talkId: input.talkId,
    ownerId: talk.owner_id,
    title: rawTitle,
    folderId: input.folderId,
  });
  const reloaded = updated
    ? getTalkForUser(updated.id, input.auth.userId)
    : undefined;
  if (!reloaded) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(reloaded),
      },
    },
  };
}

export function deleteTalkRoute(input: { auth: AuthContext; talkId: string }): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Talk is read-only' },
      },
    };
  }
  const deleted = deleteTalkForOwner({
    talkId: input.talkId,
    ownerId: talk.owner_id,
  });
  if (!deleted) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'talk_not_found', message: 'Talk not found' },
      },
    };
  }
  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

export function reorderTalkSidebarRoute(input: {
  auth: AuthContext;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{ reordered: true }>;
} {
  const destinationIndex = Math.max(0, Math.floor(input.destinationIndex));
  let ownerId = input.auth.userId;
  if (input.itemType === 'talk') {
    const talk = getTalkForUser(input.itemId, input.auth.userId);
    if (!talk) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'talk_not_found', message: 'Talk not found' },
        },
      };
    }
    if (!canEditTalk(talk.id, input.auth.userId, input.auth.role)) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: { code: 'forbidden', message: 'Talk is read-only' },
        },
      };
    }
    ownerId = talk.owner_id;
  }

  if (
    input.destinationFolderId !== null &&
    !listTalkFoldersForOwner(ownerId).some(
      (folder) => folder.id === input.destinationFolderId,
    )
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'folder_not_found', message: 'Folder not found' },
      },
    };
  }

  const reordered = reorderTalkSidebarItem({
    ownerId,
    itemType: input.itemType,
    itemId: input.itemId,
    destinationFolderId: input.destinationFolderId,
    destinationIndex,
  });
  if (!reordered) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_reorder',
          message: 'Reorder target is not valid',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: { ok: true, data: { reordered: true } },
  };
}

export function getTalkRoute(input: { talkId: string; auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ talk: TalkApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talk: toTalkApiRecord(talk),
      },
    },
  };
}

export function listTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
  executorSettings?: ExecutorSettingsService;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: listTalkAgentInstances(input.talkId).map((agent) =>
          toTalkAgentApiRecord(
            agent,
            buildTalkAgentHealthLookup(input.executorSettings),
          ),
        ),
      },
    },
  };
}

export function updateTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
  executorSettings?: ExecutorSettingsService;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: TalkAgentApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to edit talk agents',
        },
      },
    };
  }

  const normalized = validateAgentInputs(input.agents);
  if (!normalized.agents) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_agents',
          message: normalized.error || 'talk agents are invalid',
        },
      },
    };
  }

  replaceTalkAgentInstances(input.talkId, normalized.agents);
  const healthLookup = buildTalkAgentHealthLookup(input.executorSettings);
  const agents = listTalkAgentInstances(input.talkId).map((agent) =>
    toTalkAgentApiRecord(agent, healthLookup),
  );
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents,
      },
    },
  };
}

export function getTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  const configuredAgents = listTalkAgents(input.talkId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents:
          configuredAgents.length > 0
            ? configuredAgents.map((agent) => agent.name)
            : parseFallbackPolicyAgents(talk.llm_policy),
        limits: {
          maxAgents: MAX_TALK_AGENTS,
          maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
        },
      },
    },
  };
}

export function updateTalkPolicyRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    agents: string[];
    limits: { maxAgents: number; maxAgentChars: number };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to edit talk agents',
        },
      },
    };
  }

  if (!Array.isArray(input.agents)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_agents',
          message: 'agents must be an array of strings',
        },
      },
    };
  }

  const currentAgents = ensureTalkHasDefaultAgent(input.talkId);
  const primary =
    currentAgents.find((agent) => agent.is_primary === 1) || currentAgents[0];
  const normalizedNames = [
    ...new Set(
      input.agents
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  ];

  if (normalizedNames.length === 0) {
    deleteTalkLlmPolicy(input.talkId);
    const resetAgents = resetTalkAgentsToDefault(input.talkId);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          talkId: input.talkId,
          agents: resetAgents.map((agent) => agent.name),
          limits: {
            maxAgents: MAX_TALK_AGENTS,
            maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
          },
        },
      },
    };
  }

  if (normalizedNames.length > MAX_TALK_AGENTS) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_agents',
          message: `at most ${MAX_TALK_AGENTS} agents are allowed`,
        },
      },
    };
  }

  // Legacy compatibility only: typed talk_agents are the execution source of truth,
  // but we still mirror the simple names list for older policy readers.
  upsertTalkLlmPolicy({
    talkId: input.talkId,
    llmPolicy: JSON.stringify({ agents: normalizedNames }),
  });

  const agentInputs: TalkAgentInput[] = normalizedNames.map((name, index) => ({
    id: currentAgents[index]?.id || `agent_${randomUUID()}`,
    name,
    sourceKind:
      currentAgents[index]?.source_kind === 'claude_default'
        ? 'claude_default'
        : 'provider',
    personaRole: currentAgents[index]?.persona_role || 'assistant',
    routeId: currentAgents[index]?.route_id || primary.route_id,
    providerId:
      currentAgents[index]?.provider_id ||
      primary.provider_id ||
      'provider.anthropic',
    modelId: currentAgents[index]?.model_id || primary.model_id || null,
    isPrimary: index === 0,
    sortOrder: index,
  }));

  const agents = replaceTalkAgents(input.talkId, agentInputs);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: agents.map((agent) => agent.name),
        limits: {
          maxAgents: MAX_TALK_AGENTS,
          maxAgentChars: MAX_TALK_AGENT_NAME_CHARS,
        },
      },
    },
  };
}

export function listTalkMessagesRoute(input: {
  talkId: string;
  auth: AuthContext;
  limit?: number;
  beforeCreatedAt?: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    messages: TalkMessageApiRecord[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 100;
  const beforeCreatedAt = input.beforeCreatedAt || null;
  const messages = listTalkMessages({
    talkId: input.talkId,
    limit,
    beforeCreatedAt: beforeCreatedAt || undefined,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        messages: messages.map(toTalkMessageApiRecord),
        page: {
          limit,
          count: messages.length,
          beforeCreatedAt,
        },
      },
    },
  };
}

export function enqueueTalkChat(input: {
  talkId: string;
  auth: AuthContext;
  content: string;
  targetAgentIds?: string[] | null;
  idempotencyKey?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    message: TalkMessageApiRecord;
    runs: Array<{
      id: string;
      status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
      createdAt: string;
      startedAt: string | null;
      completedAt: string | null;
      triggerMessageId: string | null;
      targetAgentId: string | null;
      targetAgentNickname: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      executorAlias: string | null;
      executorModel: string | null;
    }>;
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to post messages to this talk',
        },
      },
    };
  }

  const content = input.content.trim();
  if (!content) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'message_required',
          message: 'Message content is required',
        },
      },
    };
  }
  if (content.length > 20_000) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'message_too_large',
          message: 'Message content exceeds 20000 characters',
        },
      },
    };
  }

  const agents = ensureTalkHasDefaultAgent(input.talkId);
  const requestedTargetIds = Array.isArray(input.targetAgentIds)
    ? [...new Set(input.targetAgentIds.map((id) => id.trim()).filter(Boolean))]
    : [];
  const selectedAgents =
    requestedTargetIds.length > 0
      ? requestedTargetIds
          .map((targetId) => agents.find((agent) => agent.id === targetId))
          .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent))
      : (() => {
          const primary = agents.find((agent) => agent.is_primary === 1);
          return primary ? [primary] : [];
        })();

  if (selectedAgents.length === 0) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'talk_agent_not_found',
          message: 'No valid talk agent is available for this talk',
        },
      },
    };
  }

  const messageId = `msg_${randomUUID()}`;
  const runIds = selectedAgents.map(() => `run_${randomUUID()}`);
  let persisted: ReturnType<typeof enqueueTalkTurnAtomic>;
  try {
    persisted = enqueueTalkTurnAtomic({
      talkId: input.talkId,
      userId: input.auth.userId,
      content,
      messageId,
      runIds,
      targetAgentIds: selectedAgents.map((agent) => agent.id),
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'talk already has an active round'
    ) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'talk_round_active',
            message:
              'Wait for the current round to finish or cancel it before sending another message',
          },
        },
      };
    }
    throw error;
  }

  const agentNicknameById = new Map(
    selectedAgents.map((agent) => [agent.id, agent.name]),
  );

  return {
    statusCode: 202,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        message: toTalkMessageApiRecord(persisted.message),
        runs: persisted.runs.map((run) => ({
          id: run.id,
          status: run.status,
          createdAt: run.created_at,
          startedAt: run.started_at,
          completedAt: run.ended_at,
          triggerMessageId: run.trigger_message_id,
          targetAgentId: run.target_agent_id || null,
          targetAgentNickname:
            (run.target_agent_id &&
              agentNicknameById.get(run.target_agent_id)) ||
            null,
          errorCode: null,
          errorMessage: null,
          executorAlias: run.executor_alias,
          executorModel: run.executor_model,
        })),
      },
    },
  };
}

function toTalkRunApiRecord(
  run: ReturnType<typeof listTalkRunsForTalk>[number],
): TalkRunApiRecord {
  const parsedError = parseTalkRunError(run);
  return {
    id: run.id,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    completedAt: run.ended_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id || null,
    targetAgentNickname: run.target_agent_nickname,
    errorCode: parsedError.errorCode,
    errorMessage: parsedError.errorMessage,
    executorAlias: run.executor_alias,
    executorModel: run.executor_model,
  };
}

export function listTalkRunsRoute(input: {
  talkId: string;
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    runs: TalkRunApiRecord[];
  }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        runs: listTalkRunsForTalk(input.talkId, 50).map(toTalkRunApiRecord),
      },
    },
  };
}

export function cancelTalkChat(input: { talkId: string; auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; cancelledRuns: number }>;
  cancelledRunning: boolean;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      },
      cancelledRunning: false,
    };
  }

  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to cancel runs for this talk',
        },
      },
      cancelledRunning: false,
    };
  }

  const cancellation = cancelTalkRunsAtomic({
    talkId: input.talkId,
    cancelledBy: input.auth.userId,
  });

  if (cancellation.cancelledRuns === 0) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'no_active_run',
          message: 'No running or queued chat exists for this talk',
        },
      },
      cancelledRunning: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        cancelledRuns: cancellation.cancelledRuns,
      },
    },
    cancelledRunning: cancellation.cancelledRunning,
  };
}
