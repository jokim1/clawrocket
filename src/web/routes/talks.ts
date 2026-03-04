import { TalkRunQueue } from '../../talks/run-queue.js';
import { canEditTalk } from '../middleware/acl.js';
import { AuthContext, ApiEnvelope } from '../types.js';

export function cancelTalkChat(input: {
  talkId: string;
  auth: AuthContext;
  runQueue: TalkRunQueue;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; cancelledRuns: number }>;
} {
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
