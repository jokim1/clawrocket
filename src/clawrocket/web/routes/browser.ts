import type { ApiEnvelope, AuthContext } from '../types.js';
import {
  getBrowserService,
  type BrowserOpenResult,
  type BrowserSessionStatusSnapshot,
} from '../../browser/service.js';
import {
  checkBrowserProfileConnectionUniqueness,
  ensureBrowserProfile,
  getBrowserProfileById,
  hasNonterminalBrowserSessions,
  listAllBrowserProfiles,
  updateBrowserProfileConnectionMode,
  type BrowserConnectionMode,
  type BrowserProfileSnapshot,
} from '../../db/browser-accessors.js';
import {
  canUserAccessMainThread,
  canUserAccessTalk,
  cancelBrowserBlockedRun,
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
    await service.resumeTakeover({ sessionId, userId: null });
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
        userId: input.auth.userId,
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
      userId: input.auth.userId,
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
      userId: input.auth.userId,
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
        queueState: resumed.queueState,
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
        queueState: resumed.queueState,
      },
    },
    wakeMain: resumed.run?.talk_id == null,
    wakeTalk: resumed.run?.talk_id != null,
  };
}

export async function cancelConflictingBrowserRunRoute(input: {
  auth: AuthContext;
  runId: string;
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
  if (
    !browserBlock ||
    browserBlock.kind !== 'session_conflict' ||
    !browserBlock.conflictingRunId
  ) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'session_conflict_missing',
          message: 'Run is not blocked by a conflicting browser session.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  if (!canAccessRun(input.auth, browserBlock.conflictingRunId)) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'conflicting_run_not_found',
          message: 'The conflicting blocked run could not be found.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const cancelled = cancelBrowserBlockedRun({
    runId: browserBlock.conflictingRunId,
    cancelledBy: input.auth.userId,
    cancelReason: 'browser_session_conflict_cancelled',
  });
  if (!cancelled.applied) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'conflicting_run_cancel_failed',
          message: 'The conflicting browser task could not be cancelled.',
        },
      },
      wakeMain: false,
      wakeTalk: false,
    };
  }

  const updatedRun = getTalkRunById(input.runId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        runId: input.runId,
        conflictingRunId: browserBlock.conflictingRunId,
        queuedCurrentRun: updatedRun?.status === 'queued',
        currentRunStatus: updatedRun?.status ?? null,
      },
    },
    wakeMain: cancelled.run?.talk_id == null,
    wakeTalk: cancelled.run?.talk_id != null,
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

// ---------------------------------------------------------------------------
// Browser profile CRUD routes
// ---------------------------------------------------------------------------

const VALID_CONNECTION_MODES: BrowserConnectionMode[] = [
  'managed',
  'chrome_profile',
  'cdp',
];

function isValidConnectionMode(mode: unknown): mode is BrowserConnectionMode {
  return (
    typeof mode === 'string' &&
    VALID_CONNECTION_MODES.includes(mode as BrowserConnectionMode)
  );
}

function validateConnectionConfig(
  mode: BrowserConnectionMode,
  config: unknown,
): { valid: boolean; error?: string; configJson: string | null } {
  if (mode === 'managed') {
    return { valid: true, configJson: null };
  }

  if (!config || typeof config !== 'object') {
    return {
      valid: false,
      error: `connectionConfig is required for mode '${mode}'.`,
      configJson: null,
    };
  }

  const configObj = config as Record<string, unknown>;

  if (mode === 'chrome_profile') {
    if (
      typeof configObj.chromeProfilePath !== 'string' ||
      !configObj.chromeProfilePath.trim()
    ) {
      return {
        valid: false,
        error:
          'chromeProfilePath is required for chrome_profile mode. Provide the Chrome user data directory (e.g. /home/user/.config/google-chrome), not a profile subdirectory like Default/.',
        configJson: null,
      };
    }
    const chromeProfilePath = configObj.chromeProfilePath.trim();
    if (!chromeProfilePath.startsWith('/')) {
      return {
        valid: false,
        error:
          'chromeProfilePath must be an absolute path to the Chrome user data directory.',
        configJson: null,
      };
    }
    // Warn if user appears to have provided a profile subdirectory instead of user data dir
    const basename = chromeProfilePath.split('/').pop() || '';
    if (/^(Default|Profile \d+)$/i.test(basename)) {
      return {
        valid: false,
        error: `chromeProfilePath should be the Chrome user data directory, not the profile subdirectory. Use "${chromeProfilePath.replace(/\/[^/]+$/, '')}" instead of "${chromeProfilePath}".`,
        configJson: null,
      };
    }
    return {
      valid: true,
      configJson: JSON.stringify({ chromeProfilePath }),
    };
  }

  if (mode === 'cdp') {
    if (
      typeof configObj.endpointUrl !== 'string' ||
      !configObj.endpointUrl.trim()
    ) {
      return {
        valid: false,
        error: 'endpointUrl is required for cdp mode.',
        configJson: null,
      };
    }
    const endpointUrl = configObj.endpointUrl.trim();
    try {
      new URL(endpointUrl);
    } catch {
      return {
        valid: false,
        error: 'endpointUrl must be a valid URL.',
        configJson: null,
      };
    }
    return {
      valid: true,
      configJson: JSON.stringify({ endpointUrl }),
    };
  }

  return { valid: false, error: `Unknown mode '${mode}'.`, configJson: null };
}

export function listBrowserProfilesRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<{ profiles: BrowserProfileSnapshot[] }>;
} {
  const profiles = listAllBrowserProfiles();
  return {
    statusCode: 200,
    body: { ok: true, data: { profiles } },
  };
}

export function createBrowserProfileRoute(input: {
  auth: AuthContext;
  siteKey?: unknown;
  accountLabel?: unknown;
  connectionMode?: unknown;
  connectionConfig?: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{ profile: BrowserProfileSnapshot; created: boolean }>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  if (typeof input.siteKey !== 'string' || !input.siteKey.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: { code: 'invalid_site_key', message: 'siteKey is required.' },
      },
    };
  }

  // Validate connection config BEFORE creating the profile row to avoid
  // leaving behind a managed profile when validation fails.
  const mode = isValidConnectionMode(input.connectionMode)
    ? input.connectionMode
    : null;
  let validatedConfigJson: string | null = null;
  if (mode && mode !== 'managed') {
    const validation = validateConnectionConfig(mode, input.connectionConfig);
    if (!validation.valid) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: {
            code: 'invalid_connection_config',
            message: validation.error!,
          },
        },
      };
    }
    validatedConfigJson = validation.configJson;

    // Pre-flight uniqueness check (excludeProfileId=null since profile may not exist yet)
    const uniqueness = checkBrowserProfileConnectionUniqueness({
      mode,
      configJson: validatedConfigJson,
      excludeProfileId: null,
    });
    if (uniqueness.conflict) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'connection_config_conflict',
            message: `Another profile (${uniqueness.conflictSiteKey}) already uses this ${mode === 'chrome_profile' ? 'Chrome user data directory' : 'CDP endpoint'}.`,
          },
        },
      };
    }
  }

  const { profile, created } = ensureBrowserProfile({
    siteKey: input.siteKey.trim(),
    accountLabel:
      typeof input.accountLabel === 'string'
        ? input.accountLabel.trim() || null
        : null,
  });

  // Apply connection mode if specified
  if (mode && mode !== 'managed') {
    // Block mode change on existing profiles with active sessions
    if (!created && hasNonterminalBrowserSessions(profile.id)) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: {
            code: 'active_session_exists',
            message:
              'Cannot change connection mode while active, blocked, or takeover sessions exist for this profile.',
          },
        },
      };
    }

    const updated = updateBrowserProfileConnectionMode(
      profile.id,
      mode,
      validatedConfigJson,
    );
    if (updated) {
      return {
        statusCode: 200,
        body: { ok: true, data: { profile: updated, created } },
      };
    }
  }

  return { statusCode: 200, body: { ok: true, data: { profile, created } } };
}

export function updateBrowserProfileConnectionModeRoute(input: {
  auth: AuthContext;
  profileId: string;
  connectionMode?: unknown;
  connectionConfig?: unknown;
}): {
  statusCode: number;
  body: ApiEnvelope<{ profile: BrowserProfileSnapshot }>;
} {
  if (input.auth.role !== 'owner') {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Owner role required.' },
      },
    };
  }

  const existing = getBrowserProfileById(input.profileId);
  if (!existing) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: {
          code: 'profile_not_found',
          message: 'Browser profile not found.',
        },
      },
    };
  }

  if (!isValidConnectionMode(input.connectionMode)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connection_mode',
          message: `connectionMode must be one of: ${VALID_CONNECTION_MODES.join(', ')}.`,
        },
      },
    };
  }

  const mode = input.connectionMode;
  const validation = validateConnectionConfig(mode, input.connectionConfig);
  if (!validation.valid) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connection_config',
          message: validation.error!,
        },
      },
    };
  }

  // Block mode change if any nonterminal session exists
  if (hasNonterminalBrowserSessions(input.profileId)) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'active_session_exists',
          message:
            'Cannot change connection mode while active, blocked, or takeover sessions exist for this profile.',
        },
      },
    };
  }

  // Uniqueness check
  const uniqueness = checkBrowserProfileConnectionUniqueness({
    mode,
    configJson: validation.configJson,
    excludeProfileId: input.profileId,
  });
  if (uniqueness.conflict) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: {
          code: 'connection_config_conflict',
          message: `Another profile (${uniqueness.conflictSiteKey}) already uses this ${mode === 'chrome_profile' ? 'Chrome profile path' : 'CDP endpoint'}.`,
        },
      },
    };
  }

  const updated = updateBrowserProfileConnectionMode(
    input.profileId,
    mode,
    validation.configJson,
  );
  if (!updated) {
    return {
      statusCode: 500,
      body: {
        ok: false,
        error: { code: 'update_failed', message: 'Failed to update profile.' },
      },
    };
  }

  return { statusCode: 200, body: { ok: true, data: { profile: updated } } };
}
