import { randomUUID } from 'crypto';
import {
  canUserAccessMainThread,
  deleteMainThread,
  enqueueMainTurnAtomic,
  getMainThreadTitle,
  getTalkRunById,
  listMainThreadsForUser,
  listMainRunsForThread,
  MainThreadBusyError,
  recordMainRunFirstVisibleAt,
  ThreadDeleteConflictError,
  updateMainThreadMetadata,
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
  isPinned: boolean;
  lastMessageAt: string;
  messageCount: number;
  hasActiveRun: boolean;
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
      isPinned: row.is_pinned === 1,
      lastMessageAt: row.last_message_at,
      messageCount: row.message_count,
      hasActiveRun: row.has_active_run === 1,
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
  run: MainRunApiRecord;
}

export interface MainRunApiRecord {
  id: string;
  threadId: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  cancelReason: string | null;
  kind: string | null;
  parentRunId: string | null;
  promotionState: 'pending' | 'superseded' | null;
  promotionChildRunId: string | null;
  requestedToolFamilies: string[];
  userVisibleSummary: string | null;
}

function parseRunMetadata(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function toMainRunApiRecord(run: {
  id: string;
  thread_id: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  trigger_message_id: string | null;
  target_agent_id?: string | null;
  cancel_reason: string | null;
  metadata_json?: string | null;
}): MainRunApiRecord {
  const metadata = parseRunMetadata(run.metadata_json);
  return {
    id: run.id,
    threadId: run.thread_id,
    status: run.status,
    createdAt: run.created_at,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    triggerMessageId: run.trigger_message_id,
    targetAgentId: run.target_agent_id ?? null,
    cancelReason: run.cancel_reason,
    kind: typeof metadata.kind === 'string' ? metadata.kind : null,
    parentRunId:
      typeof metadata.parentRunId === 'string' ? metadata.parentRunId : null,
    promotionState:
      metadata.promotionState === 'pending' ||
      metadata.promotionState === 'superseded'
        ? metadata.promotionState
        : null,
    promotionChildRunId:
      typeof metadata.promotionChildRunId === 'string'
        ? metadata.promotionChildRunId
        : null,
    requestedToolFamilies: Array.isArray(metadata.requestedToolFamilies)
      ? metadata.requestedToolFamilies.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    userVisibleSummary:
      typeof metadata.userVisibleSummary === 'string'
        ? metadata.userVisibleSummary
        : null,
  };
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
          run: toMainRunApiRecord(result.run),
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

export function listMainRunsRoute(
  auth: AuthContext,
  threadId: string,
): {
  statusCode: number;
  body: ApiEnvelope<MainRunApiRecord[]>;
} {
  try {
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

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: listMainRunsForThread(threadId).map(toMainRunApiRecord),
      },
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: {
          code: 'internal_error',
          message: `Failed to list main runs: ${String(err)}`,
        },
      },
    };
  }
}

export function postMainRunVisibleRoute(
  auth: AuthContext,
  runId: string,
  body: { firstVisibleAt?: unknown },
): {
  statusCode: number;
  body: ApiEnvelope<{ recorded: boolean }>;
} {
  const run = getTalkRunById(runId);
  if (
    !run ||
    run.talk_id !== null ||
    !canUserAccessMainThread(run.thread_id, auth.userId)
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Run '${runId}' not found`,
        },
      },
    };
  }

  if (
    typeof body.firstVisibleAt !== 'string' ||
    !body.firstVisibleAt.trim() ||
    Number.isNaN(Date.parse(body.firstVisibleAt))
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'firstVisibleAt must be an ISO timestamp string',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        recorded: recordMainRunFirstVisibleAt({
          runId,
          firstVisibleAt: body.firstVisibleAt,
        }),
      },
    },
  };
}

interface PatchMainThreadBody {
  title?: unknown;
  pinned?: unknown;
}

interface PatchMainThreadResponse {
  threadId: string;
  title: string | null;
  isPinned: boolean;
}

interface PatchMainThreadDeps {
  updateMainThreadMetadata?: typeof updateMainThreadMetadata;
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
  if (body.title === undefined && body.pinned === undefined) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_input',
          message: 'At least one of title or pinned is required',
        },
      },
    };
  }

  let title: string | undefined;
  if (body.title !== undefined) {
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
  }

  let pinned: boolean | undefined;
  if (body.pinned !== undefined) {
    if (typeof body.pinned !== 'boolean') {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_input',
            message: 'pinned must be a boolean',
          },
        },
      };
    }
    pinned = body.pinned;
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
    const updated = (
      deps?.updateMainThreadMetadata ?? updateMainThreadMetadata
    )({
      threadId,
      userId: auth.userId,
      ...(title !== undefined ? { title } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
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
          isPinned: updated.is_pinned === 1,
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

interface DeleteMainThreadResponse {
  deleted: true;
}

interface DeleteMainThreadDeps {
  deleteMainThread?: typeof deleteMainThread;
}

export function deleteMainThreadRoute(
  auth: AuthContext,
  threadId: string,
  deps?: DeleteMainThreadDeps,
): {
  statusCode: number;
  body: ApiEnvelope<DeleteMainThreadResponse>;
} {
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
    const deleted = (deps?.deleteMainThread ?? deleteMainThread)({
      threadId,
      userId: auth.userId,
    });
    if (!deleted) {
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
        data: { deleted: true },
      },
    };
  } catch (err) {
    if (err instanceof ThreadDeleteConflictError) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: err.code,
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
          message: `Failed to delete thread: ${String(err)}`,
        },
      },
    };
  }
}
