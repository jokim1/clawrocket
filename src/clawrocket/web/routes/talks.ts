import { randomUUID } from 'crypto';

import { logger } from '../../../logger.js';
import {
  appendOutboxEvent,
  cancelTalkRunsAtomic,
  createTalk,
  deleteTalkLlmPolicy,
  enqueueTalkTurnAtomic,
  getTalkForUser,
  listTalkMessages,
  listTalksForUser,
  normalizeTalkListPage,
  upsertTalkLlmPolicy,
  type TalkMessageRecord,
  type TalkWithAccessRecord,
} from '../../db/index.js';
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
}

const DEFAULT_TALK_AGENTS = ['Mock'];
const MAX_TALK_AGENT_BADGES = 6;
const MAX_POLICY_AGENTS = 12;
const MAX_POLICY_AGENT_LABEL_CHARS = 80;

function toTalkApiRecord(talk: TalkWithAccessRecord): TalkApiRecord {
  return {
    id: talk.id,
    ownerId: talk.owner_id,
    title: talk.topic_title,
    agents: parseTalkAgents(talk.id, talk.llm_policy),
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
}

/**
 * Supported llm_policy shapes:
 * - JSON array of strings
 * - JSON object with agents/models arrays
 * - JSON object with agent/model string
 * - JSON string
 * - non-JSON text split by | or ,
 */
function parseTalkAgents(talkId: string, llmPolicy: string | null): string[] {
  const raw = llmPolicy?.trim();
  if (!raw) return DEFAULT_TALK_AGENTS;

  const normalized = parsePolicyAgentCandidates(raw, MAX_TALK_AGENT_BADGES);

  if (normalized.length > 0) {
    return normalized;
  }

  const llmPolicyPreview = raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
  logger.warn(
    { talkId, llmPolicyPreview },
    'Unsupported llm_policy shape; defaulting to Mock agent badge',
  );

  return DEFAULT_TALK_AGENTS;
}

function parseTalkPolicyAgents(llmPolicy: string | null): string[] {
  const raw = llmPolicy?.trim();
  if (!raw) return [];
  return parsePolicyAgentCandidates(raw, MAX_POLICY_AGENTS);
}

function parsePolicyAgentCandidates(
  rawPolicy: string,
  maxItems: number,
): string[] {
  let candidates: unknown[] = [];
  try {
    const parsed = JSON.parse(rawPolicy) as unknown;
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const asRecord = parsed as Record<string, unknown>;
      if (Array.isArray(asRecord.agents)) {
        candidates = asRecord.agents;
      } else if (Array.isArray(asRecord.models)) {
        candidates = asRecord.models;
      } else {
        candidates = [asRecord.agent, asRecord.model];
      }
    } else if (typeof parsed === 'string') {
      candidates = [parsed];
    }
  } catch {
    candidates = rawPolicy.split(/[|,]/);
  }

  return [
    ...new Set(
      candidates
        .map((candidate) =>
          typeof candidate === 'string' ? candidate.trim() : '',
        )
        .filter(Boolean),
    ),
  ].slice(0, maxItems);
}

function normalizePolicyAgents(input: unknown): { agents?: string[]; error?: string } {
  if (!Array.isArray(input)) {
    return { error: 'agents must be an array of strings' };
  }

  const normalized = [
    ...new Set(
      input
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter(Boolean),
    ),
  ];

  if (normalized.some((agent) => agent.length > MAX_POLICY_AGENT_LABEL_CHARS)) {
    return {
      error: `each agent label must be ${MAX_POLICY_AGENT_LABEL_CHARS} characters or less`,
    };
  }
  if (normalized.length > MAX_POLICY_AGENTS) {
    return { error: `at most ${MAX_POLICY_AGENTS} agents are allowed` };
  }

  return { agents: normalized };
}

function toTalkMessageApiRecord(
  message: TalkMessageRecord,
): TalkMessageApiRecord {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdBy: message.created_by,
    createdAt: message.created_at,
    runId: message.run_id,
  };
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

  appendOutboxEvent({
    topic: `user:${input.auth.userId}`,
    eventType: 'talk_created',
    payload: JSON.stringify({
      talkId,
      ownerId: input.auth.userId,
      title,
      status: 'active',
    }),
  });

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

export function getTalkPolicyRoute(input: { talkId: string; auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; agents: string[] }>;
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
        agents: parseTalkPolicyAgents(talk.llm_policy),
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
  body: ApiEnvelope<{ talkId: string; agents: string[] }>;
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
          message: 'You do not have permission to edit talk policy',
        },
      },
    };
  }

  const normalized = normalizePolicyAgents(input.agents);
  if (!normalized.agents) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_agents',
          message: normalized.error || 'agents are invalid',
        },
      },
    };
  }

  if (normalized.agents.length === 0) {
    deleteTalkLlmPolicy(input.talkId);
  } else {
    upsertTalkLlmPolicy({
      talkId: input.talkId,
      llmPolicy: JSON.stringify({ agents: normalized.agents }),
    });
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        agents: normalized.agents,
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

  const messageId = `msg_${randomUUID()}`;
  const runId = `run_${randomUUID()}`;
  const persisted = enqueueTalkTurnAtomic({
    talkId: input.talkId,
    userId: input.auth.userId,
    content,
    messageId,
    runId,
    idempotencyKey: input.idempotencyKey,
  });

  return {
    statusCode: 202,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        message: {
          id: persisted.message.id,
          role: persisted.message.role,
          content: persisted.message.content,
          createdBy: persisted.message.created_by,
          createdAt: persisted.message.created_at,
          runId: persisted.message.run_id,
        },
        run: {
          id: persisted.run.id,
          status: persisted.run.status,
          createdAt: persisted.run.created_at,
          startedAt: persisted.run.started_at,
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
