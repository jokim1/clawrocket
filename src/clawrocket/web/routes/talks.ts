import { randomUUID } from 'crypto';

import {
  appendOutboxEvent,
  cancelTalkRunsAtomic,
  createTalk,
  enqueueTalkTurnAtomic,
  getTalkForUser,
  listTalkMessages,
  listTalksForUser,
  normalizeTalkListPage,
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

function toTalkApiRecord(talk: TalkWithAccessRecord): TalkApiRecord {
  return {
    id: talk.id,
    ownerId: talk.owner_id,
    title: talk.topic_title,
    agents: parseTalkAgents(talk.llm_policy),
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
}

function parseTalkAgents(llmPolicy: string | null): string[] {
  const DEFAULT_AGENTS = ['Mock'];
  const raw = llmPolicy?.trim();
  if (!raw) return DEFAULT_AGENTS;

  let candidates: unknown[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
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
    candidates = raw.split(/[|,]/);
  }

  const normalized = [
    ...new Set(
      candidates
        .map((candidate) =>
          typeof candidate === 'string' ? candidate.trim() : '',
        )
        .filter(Boolean),
    ),
  ].slice(0, 6);

  return normalized.length > 0 ? normalized : DEFAULT_AGENTS;
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
