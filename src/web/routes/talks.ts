import { randomUUID } from 'crypto';

import {
  appendOutboxEvent,
  createTalk,
  createTalkMessage,
  getTalkForUser,
  listTalkMessages,
  listTalksForUser,
  touchTalkUpdatedAt,
  type TalkMessageRecord,
  type TalkWithAccessRecord,
} from '../../db.js';
import { TalkRunQueue } from '../../talks/run-queue.js';
import { canEditTalk } from '../middleware/acl.js';
import { AuthContext, ApiEnvelope } from '../types.js';

interface TalkApiRecord {
  id: string;
  ownerId: string;
  title: string | null;
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
    status: talk.status,
    version: talk.version,
    createdAt: talk.created_at,
    updatedAt: talk.updated_at,
    accessRole: talk.access_role,
  };
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
  const talks = listTalksForUser({
    userId: input.auth.userId,
    limit: input.limit,
    offset: input.offset,
  });
  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 50;
  const offset =
    typeof input.offset === 'number'
      ? Math.max(0, Math.floor(input.offset))
      : 0;

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talks: talks.map(toTalkApiRecord),
        page: {
          limit,
          offset,
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
  runQueue: TalkRunQueue;
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
  const now = new Date().toISOString();

  createTalkMessage({
    id: messageId,
    talkId: input.talkId,
    role: 'user',
    content,
    createdBy: input.auth.userId,
    createdAt: now,
  });
  touchTalkUpdatedAt(input.talkId, now);
  appendOutboxEvent({
    topic: `talk:${input.talkId}`,
    eventType: 'message_appended',
    payload: JSON.stringify({
      talkId: input.talkId,
      messageId,
      role: 'user',
      createdBy: input.auth.userId,
    }),
  });

  const run = input.runQueue.enqueue({
    runId,
    talkId: input.talkId,
    requestedBy: input.auth.userId,
    idempotencyKey: input.idempotencyKey || undefined,
  });

  return {
    statusCode: 202,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        message: {
          id: messageId,
          role: 'user',
          content,
          createdBy: input.auth.userId,
          createdAt: now,
          runId: null,
        },
        run: {
          id: run.id,
          status: run.status,
          createdAt: run.created_at,
          startedAt: run.started_at,
        },
      },
    },
  };
}

export function cancelTalkChat(input: {
  talkId: string;
  auth: AuthContext;
  runQueue: TalkRunQueue;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; cancelledRuns: number }>;
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
          message: 'You do not have permission to cancel runs for this talk',
        },
      },
    };
  }

  const cancelledRuns = input.runQueue.cancelTalkRuns(
    input.talkId,
    input.auth.userId,
  );

  if (cancelledRuns === 0) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'no_active_run',
          message: 'No running or queued chat exists for this talk',
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
        cancelledRuns,
      },
    },
  };
}
