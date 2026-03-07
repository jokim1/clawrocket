import { randomUUID } from 'crypto';

import {
  cancelTalkRunsAtomic,
  createTalk,
  deleteTalkLlmPolicy,
  enqueueTalkTurnAtomic,
  ensureTalkHasDefaultAgent,
  getPrimaryTalkAgent,
  getTalkForUser,
  getTalkRouteById,
  listTalkAgentInstances,
  listTalkAgents,
  listTalkMessages,
  listTalksForUser,
  normalizeTalkListPage,
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
import { canEditTalk } from '../middleware/acl.js';
import { AuthContext, ApiEnvelope } from '../types.js';

interface TalkApiRecord {
  id: string;
  ownerId: string;
  title: string | null;
  agents: string[];
  status: 'active' | 'paused' | 'archived';
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
}

interface TalkMessageApiRecord {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentName?: string | null;
}

export interface TalkAgentApiRecord {
  id: string;
  registeredAgentId: string | null;
  name: string;
  role: TalkPersonaRole;
  isLead: boolean;
  displayOrder: number;
  status: 'active' | 'archived' | 'legacy';
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
}

const DEFAULT_TALK_AGENTS = ['Mock'];
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
    title: talk.topic_title,
    agents:
      agents.length > 0
        ? agents.slice(0, MAX_TALK_AGENT_BADGES).map((agent) => agent.name)
        : parseFallbackAgentBadges(talk.llm_policy),
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
}

function toTalkAgentApiRecord(agent: {
  id: string;
  registeredAgentId: string | null;
  name: string;
  role: TalkPersonaRole;
  isLead: boolean;
  displayOrder: number;
  status: 'active' | 'archived' | 'legacy';
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
}): TalkAgentApiRecord {
  return {
    id: agent.id,
    registeredAgentId: agent.registeredAgentId,
    name: agent.name,
    role: agent.role,
    isLead: agent.isLead,
    displayOrder: agent.displayOrder,
    status: agent.status,
    providerId: agent.providerId,
    providerName: agent.providerName,
    modelId: agent.modelId,
    modelDisplayName: agent.modelDisplayName,
  };
}

function toTalkMessageApiRecord(
  message: TalkMessageRecord,
): TalkMessageApiRecord {
  let agentId: string | null | undefined;
  let agentName: string | null | undefined;
  if (message.metadata_json) {
    try {
      const parsed = JSON.parse(message.metadata_json) as {
        agentId?: unknown;
        agentName?: unknown;
      };
      if (typeof parsed.agentId === 'string') agentId = parsed.agentId;
      if (typeof parsed.agentName === 'string') agentName = parsed.agentName;
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
    agentName,
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
    const isLead = raw.isLead === true || raw.isPrimary === true;
    const displayOrder =
      typeof raw.displayOrder === 'number'
        ? Math.max(0, Math.floor(raw.displayOrder))
        : typeof raw.sortOrder === 'number'
          ? Math.max(0, Math.floor(raw.sortOrder))
          : index;
    const registeredAgentId =
      typeof raw.registeredAgentId === 'string' && raw.registeredAgentId.trim()
        ? raw.registeredAgentId.trim()
        : null;

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
    if (ids.has(id)) return { error: 'talk agent ids must be unique' };
    ids.add(id);
    if (isLead) leadCount += 1;

    normalized.push({
      id,
      registeredAgentId,
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
  return listTalkAgentInstances(talkId).map(toTalkAgentApiRecord);
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
        agents: listEffectiveTalkAgents(input.talkId),
      },
    },
  };
}

export function updateTalkAgentsRoute(input: {
  talkId: string;
  auth: AuthContext;
  agents: unknown;
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
  const agents = listTalkAgentInstances(input.talkId).map(toTalkAgentApiRecord);
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
    personaRole: currentAgents[index]?.persona_role || 'assistant',
    routeId: currentAgents[index]?.route_id || primary.route_id,
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
  targetAgentId?: string | null;
  idempotencyKey?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    talkId: string;
    message: TalkMessageApiRecord;
    run: {
      id: string;
      status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
      createdAt: string;
      startedAt: string | null;
      targetAgentId: string | null;
    };
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
  const selectedAgent =
    (input.targetAgentId
      ? agents.find((agent) => agent.id === input.targetAgentId)
      : undefined) || agents.find((agent) => agent.is_primary === 1);

  if (!selectedAgent) {
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
  const runId = `run_${randomUUID()}`;
  const persisted = enqueueTalkTurnAtomic({
    talkId: input.talkId,
    userId: input.auth.userId,
    content,
    messageId,
    runId,
    targetAgentId: selectedAgent.id,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    statusCode: 202,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        message: toTalkMessageApiRecord(persisted.message),
        run: {
          id: persisted.run.id,
          status: persisted.run.status,
          createdAt: persisted.run.created_at,
          startedAt: persisted.run.started_at,
          targetAgentId: persisted.run.target_agent_id || null,
        },
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
