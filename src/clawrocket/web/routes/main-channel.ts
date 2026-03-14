import { randomUUID } from 'crypto';
import { getDb } from '../../../db.js';
import { createMessage } from '../../db/agent-accessors.js';
import { getMainAgent } from '../../agents/agent-registry.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

// ---------------------------------------------------------------------------
// List Main Threads Route
// ---------------------------------------------------------------------------

interface ThreadSummary {
  threadId: string;
  lastMessageAt: string;
  messageCount: number;
}

export function listMainThreadsRoute(auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<ThreadSummary[]>;
} {
  try {
    const rows = getDb()
      .prepare(
        `
      SELECT
        thread_id,
        MAX(created_at) AS last_message_at,
        COUNT(*) AS message_count
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id IS NOT NULL
      GROUP BY thread_id
      ORDER BY MAX(created_at) DESC
    `,
      )
      .all() as Array<{ thread_id: string; last_message_at: string; message_count: number }>;

    const threads: ThreadSummary[] = rows.map((row) => ({
      threadId: row.thread_id,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count,
    }));

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: threads,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list threads: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Get Main Thread Route
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id: string;
  threadId: string;
  role: string;
  content: string;
  agentId: string | null;
  createdBy: string | null;
  createdAt: string;
}

export function getMainThreadRoute(auth: AuthContext, threadId: string): {
  statusCode: number;
  body: ApiEnvelope<ThreadMessage[]>;
} {
  try {
    const rows = getDb()
      .prepare(
        `
      SELECT
        id,
        thread_id,
        role,
        content,
        agent_id,
        created_by,
        created_at
      FROM talk_messages
      WHERE talk_id IS NULL AND thread_id = ?
      ORDER BY created_at ASC
    `,
      )
      .all(threadId) as Array<{
        id: string;
        thread_id: string;
        role: string;
        content: string;
        agent_id: string | null;
        created_by: string | null;
        created_at: string;
      }>;

    if (rows.length === 0) {
      // Thread does not exist or is empty
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: {
            code: 'not_found',
            message: `Thread '${threadId}' not found`,
          },
        },
      };
    }

    const messages: ThreadMessage[] = rows.map((row) => ({
      id: row.id,
      threadId: row.thread_id,
      role: row.role,
      content: row.content,
      agentId: row.agent_id,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: messages,
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to get thread messages: ${String(err)}`,
        },
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Post Main Message Route
// ---------------------------------------------------------------------------

interface PostMainMessageBody {
  content?: unknown;
  threadId?: unknown;
}

interface PostMainMessageResponse {
  messageId: string;
  threadId: string;
}

export function postMainMessageRoute(
  auth: AuthContext,
  body: PostMainMessageBody,
): {
  statusCode: number;
  body: ApiEnvelope<PostMainMessageResponse>;
} {
  // Validate content
  if (typeof body.content !== 'string' || !body.content.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'content is required and must be a non-empty string',
        },
      },
    };
  }

  const content = body.content.trim();

  // Determine threadId
  let threadId: string;
  if (body.threadId !== undefined) {
    if (typeof body.threadId !== 'string' || !body.threadId.trim()) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'threadId must be a non-empty string if provided',
          },
        },
      };
    }
    threadId = body.threadId.trim();
  } else {
    // Create a new thread
    threadId = randomUUID();
  }

  try {
    const messageId = randomUUID();
    const now = new Date().toISOString();

    createMessage({
      id: messageId,
      talkId: null,
      threadId,
      role: 'user',
      content,
      agentId: null,
      createdBy: auth.userId,
      createdAt: now,
    });

    return {
      statusCode: 201,
      body: {
        ok: true,
        data: {
          messageId,
          threadId,
        },
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to post message: ${String(err)}`,
        },
      },
    };
  }
}
