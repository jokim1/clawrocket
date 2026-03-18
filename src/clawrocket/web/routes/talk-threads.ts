import { getTalkForUser, updateTalkThreadTitle } from '../../db/index.js';
import {
  ThreadTitleValidationError,
  validateEditableThreadTitle,
} from '../../db/thread-title-utils.js';
import { canEditTalk } from '../middleware/acl.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

interface PatchTalkThreadBody {
  title?: unknown;
}

type PatchTalkThreadResult = {
  id: string;
  talk_id: string;
  title: string;
  is_default: number;
  is_internal: number;
  created_at: string;
  updated_at: string;
} | null;

interface PatchTalkThreadDeps {
  getTalkForUser?: typeof getTalkForUser;
  updateTalkThreadTitle?: typeof updateTalkThreadTitle;
}

export function patchTalkThreadRoute(input: {
  auth: AuthContext;
  talkId: string;
  threadId: string;
  body: PatchTalkThreadBody;
  deps?: PatchTalkThreadDeps;
}): {
  statusCode: number;
  body: ApiEnvelope<PatchTalkThreadResult>;
} {
  let title: string;
  try {
    title = validateEditableThreadTitle(
      typeof input.body.title === 'string' ? input.body.title : null,
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

  const talk = (input.deps?.getTalkForUser ?? getTalkForUser)(
    input.talkId,
    input.auth.userId,
  );
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

  try {
    const thread = (input.deps?.updateTalkThreadTitle ?? updateTalkThreadTitle)(
      {
        talkId: input.talkId,
        threadId: input.threadId,
        title,
      },
    );
    if (!thread) {
      return {
        statusCode: 404,
        body: {
          ok: false,
          error: { code: 'thread_not_found', message: 'Thread not found' },
        },
      };
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: thread,
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
        error: { code: 'internal_error', message: String(err) },
      },
    };
  }
}
