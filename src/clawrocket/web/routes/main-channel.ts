import { randomUUID } from 'crypto';
import {
  canUserAccessMainThread,
  enqueueMainTurnAtomic,
  getMainThreadTitle,
  listMainThreadsForUser,
  MainThreadBusyError,
  updateMainThreadTitle,
} from '../../db/index.js';
import {
  ThreadTitleValidationError,
  validateEditableThreadTitle,
} from '../../db/thread-title-utils.js';
import { getDb } from '../../../db.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

// ---------------------------------------------------------------------------
// List Main Threads Route
// ---------------------------------------------------------------------------

interface ThreadSummary {
  threadId: string;
  title: string | null;
  lastMessageAt: string;
  messageCount: number;
}

export function listMainThreadsRoute(auth: AuthContext): {
  statusCode: number;
  body: ApiEnvelope<ThreadSummary[]>;
} {
  try {
    const rows = listMainThreadsForUser(auth.userId);

    const threads: ThreadSummary[] = rows.map((row) => ({
      threadId: row.thread_id,
      title: row.title,
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

export function getMainThreadRoute(
  auth: AuthContext,
  threadId: string,
): {
  statusCode: number;
  body: ApiEnvelope<ThreadMessage[]>;
} {
  try {
    // Ownership check
    if (!canUserAccessMainThread(threadId, auth.userId)) {
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
  runId: string;
  title: string | null;
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

    // Ownership check for existing threads
    if (!canUserAccessMainThread(threadId, auth.userId)) {
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
  } else {
    threadId = randomUUID();
  }

  try {
    const messageId = `msg_${randomUUID()}`;
    const runId = `run_${randomUUID()}`;

    const result = enqueueMainTurnAtomic({
      threadId,
      userId: auth.userId,
      content,
      messageId,
      runId,
    });

    return {
      statusCode: 202,
      body: {
        ok: true,
        data: {
          messageId: result.message.id,
          threadId,
          runId: result.run.id,
          title: getMainThreadTitle(threadId, auth.userId),
        },
      },
    };
  } catch (err) {
    if (err instanceof MainThreadBusyError) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'thread_busy',
            message: 'Thread already has an active run',
          },
        },
      };
    }

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

interface PatchMainThreadBody {
  title?: unknown;
}

interface PatchMainThreadResponse {
  threadId: string;
  title: string;
}

interface PatchMainThreadDeps {
  updateMainThreadTitle?: typeof updateMainThreadTitle;
}

export function patchMainThreadRoute(
  auth: AuthContext,
  threadId: string,
  body: PatchMainThreadBody,
  deps?: PatchMainThreadDeps,
): {
  statusCode: number;
  body: ApiEnvelope<PatchMainThreadResponse>;
} {
  let title: string;
  try {
    title = validateEditableThreadTitle(
      typeof body.title === 'string' ? body.title : null,
    );
  } catch (err) {
    if (err instanceof ThreadTitleValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: err.message,
          },
        },
      };
    }
    throw err;
  }

  if (!canUserAccessMainThread(threadId, auth.userId)) {
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

  try {
    const updated = (deps?.updateMainThreadTitle ?? updateMainThreadTitle)({
      threadId,
      userId: auth.userId,
      title,
    });
    if (!updated) {
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

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          threadId: updated.thread_id,
          title: updated.title,
        },
      },
    };
  } catch (err) {
    if (err instanceof ThreadTitleValidationError) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: err.message,
          },
        },
      };
    }
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to update thread title: ${String(err)}`,
        },
      },
    };
  }
}
