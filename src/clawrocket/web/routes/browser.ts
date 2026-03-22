import type { ApiEnvelope, AuthContext } from '../types.js';
import {
  getBrowserService,
  type BrowserOpenResult,
  type BrowserSessionStatusSnapshot,
} from '../../browser/service.js';
import {
  canUserAccessMainThread,
  canUserAccessTalk,
  getBrowserBlockForRun,
  getPendingRunConfirmationById,
  getTalkRunById,
  rejectBrowserBlockedRun,
  resolveRunConfirmation,
  resumeBrowserBlockedRun,
} from '../../db/index.js';
import type {
  BrowserBlockMetadata,
  BrowserResumeMetadata,
} from '../../browser/metadata.js';

function parseObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function canAccessRun(auth: AuthContext, runId: string): boolean {
  const run = getTalkRunById(runId);
  if (!run) return false;
  if (run.talk_id) {
    return canUserAccessTalk(run.talk_id, auth.userId);
  }
  return canUserAccessMainThread(run.thread_id, auth.userId);
}

async function canAccessSession(
  auth: AuthContext,
  sessionId: string,
): Promise<boolean> {
  const service = getBrowserService();
  const snapshot = await service.getSessionStatus(sessionId);
  if (!snapshot) {
    return false;
  }

  const touchedRunIds = service.getSessionTouchedRunIds(sessionId);
  if (touchedRunIds.length === 0) {
    // Single-user self-hosted default: setup/takeover sessions can exist before
    // they are attached to a run.
    return true;
  }

  return touchedRunIds.some((runId) => canAccessRun(auth, runId));
}

async function maybeResumeTakeover(
  sessionId: string | null | undefined,
): Promise<void> {
  if (!sessionId) return;
  const service = getBrowserService();
  const snapshot = await service.getSessionStatus(sessionId);
  if (snapshot?.state === 'takeover') {
    await service.resumeTakeover({ sessionId });
  }
}

export async function startBrowserSetupSessionRoute(input: {
  auth: AuthContext;
  siteKey?: unknown;
  accountLabel?: unknown;
  url?: unknown;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserOpenResult>;
}> {
  if (typeof input.siteKey !== 'string' || !input.siteKey.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_site_key',
          message: 'siteKey is required.',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: await getBrowserService().openSetupSession({
        siteKey: input.siteKey.trim(),
        accountLabel:
          typeof input.accountLabel === 'string'
            ? input.accountLabel.trim() || null
            : null,
        url: typeof input.url === 'string' ? input.url.trim() || null : null,
      }),
    },
  };
}

export async function startBrowserTakeoverRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  try {
    const snapshot = await getBrowserService().startTakeover({
      sessionId: input.sessionId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: snapshot,
      },
    };
  } catch (error) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function getBrowserSessionStatusRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  const snapshot = await getBrowserService().getSessionStatus(input.sessionId);
  if (!snapshot) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: snapshot,
    },
  };
}

export async function resumeBrowserSessionRoute(input: {
  auth: AuthContext;
  sessionId: string;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<BrowserSessionStatusSnapshot>;
}> {
  if (!(await canAccessSession(input.auth, input.sessionId))) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: 'Browser session not found.',
        },
      },
    };
  }

  try {
    const snapshot = await getBrowserService().resumeTakeover({
      sessionId: input.sessionId,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: snapshot,
      },
    };
  } catch (error) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'browser_session_not_found',
          message: error instanceof Error ? error.message : String(error),
        },
      },
    };
  }
}

export async function resumeBrowserBlockedRunRoute(input: {
  auth: AuthContext;
  runId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const run = getTalkRunById(input.runId);
  if (
    !run ||
    run.status !== 'awaiting_confirmation' ||
    !canAccessRun(input.auth, input.runId)
  ) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'blocked_run_not_found',
          message: 'Blocked run not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(input.runId);
  if (!browserBlock) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'browser_block_missing',
          message: 'Run has no browser block metadata.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  if (browserBlock.kind === 'confirmation_required') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'confirmation_required',
          message:
            'This blocked run requires explicit approval or rejection, not a generic resume.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  await maybeResumeTakeover(browserBlock.sessionId);
  const browserResume: BrowserResumeMetadata = {
    kind:
      browserBlock.kind === 'auth_required'
        ? 'auth_completed'
        : 'human_step_completed',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock.sessionId,
    confirmationId: browserBlock.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock.pendingToolCall,
  };
  const resumed = resumeBrowserBlockedRun({
    runId: input.runId,
    resumedBy: input.auth.userId,
    browserResume,
  });
  if (!resumed.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_resume_failed',
          message: 'The blocked run could not be resumed.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        runId: input.runId,
        resumed: true,
        browserResume,
      },
    },
    wakeMain: resumed.run?.talk_id == null,
    wakeTalk: resumed.run?.talk_id != null,
  };
}

export async function approveBrowserConfirmationRoute(input: {
  auth: AuthContext;
  confirmationId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const confirmation = getPendingRunConfirmationById(input.confirmationId);
  if (!confirmation || !canAccessRun(input.auth, confirmation.run_id)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'confirmation_not_found',
          message: 'Pending browser confirmation not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(confirmation.run_id);
  if (!browserBlock) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'browser_block_missing',
          message: 'Run has no browser block metadata.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const resolved = resolveRunConfirmation({
    confirmationId: input.confirmationId,
    status: 'approved',
    resolvedBy: input.auth.userId,
  });
  if (!resolved) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_already_resolved',
          message: 'This confirmation has already been resolved.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  await maybeResumeTakeover(browserBlock.sessionId);
  const browserResume: BrowserResumeMetadata = {
    kind: 'confirmation_approved',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock.sessionId,
    confirmationId: input.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock.pendingToolCall,
  };
  const resumed = resumeBrowserBlockedRun({
    runId: confirmation.run_id,
    resumedBy: input.auth.userId,
    browserResume,
  });
  if (!resumed.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_resume_failed',
          message: 'The blocked run could not be resumed.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmationId: input.confirmationId,
        runId: confirmation.run_id,
        approved: true,
        browserResume,
      },
    },
    wakeMain: resumed.run?.talk_id == null,
    wakeTalk: resumed.run?.talk_id != null,
  };
}

export async function rejectBrowserConfirmationRoute(input: {
  auth: AuthContext;
  confirmationId: string;
  note?: string | null;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<Record<string, unknown>>;
  wakeMain: boolean;
  wakeTalk: boolean;
}> {
  const confirmation = getPendingRunConfirmationById(input.confirmationId);
  if (!confirmation || !canAccessRun(input.auth, confirmation.run_id)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'confirmation_not_found',
          message: 'Pending browser confirmation not found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserBlock = getBrowserBlockForRun(confirmation.run_id);
  const resolved = resolveRunConfirmation({
    confirmationId: input.confirmationId,
    status: 'rejected',
    resolvedBy: input.auth.userId,
  });
  if (!resolved) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'confirmation_already_resolved',
          message: 'This confirmation has already been resolved.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const browserResume: BrowserResumeMetadata = {
    kind: 'confirmation_rejected',
    resumedAt: new Date().toISOString(),
    resumedBy: input.auth.userId,
    sessionId: browserBlock?.sessionId ?? null,
    confirmationId: input.confirmationId,
    note: input.note ?? null,
    pendingToolCall: browserBlock?.pendingToolCall ?? null,
  };
  const rejected = rejectBrowserBlockedRun({
    runId: confirmation.run_id,
    rejectedBy: input.auth.userId,
    browserResume,
  });
  if (!rejected.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'browser_reject_failed',
          message: 'The blocked run could not be rejected.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmationId: input.confirmationId,
        runId: confirmation.run_id,
        rejected: true,
      },
    },
    wakeMain: false,
    wakeTalk: false,
  };
}
