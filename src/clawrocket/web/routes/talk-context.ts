import {
  createTalkContextRule,
  createTalkContextSource,
  deleteTalkContextRule,
  deleteTalkContextSource,
  getTalkContext,
  getTalkContextSourceById,
  getTalkForUser,
  markTalkContextSourcePending,
  listTalkContextRules,
  patchTalkContextRule,
  patchTalkContextSource,
  setTalkGoal,
  type ContextRuleSnapshot,
  type ContextSourceSnapshot,
  type TalkContextSnapshot,
} from '../../db/index.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFoundResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: { ok: false, error: { code: 'not_found', message } },
  };
}

function forbiddenResponse(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: { ok: false, error: { code: 'forbidden', message } },
  };
}

function badRequest(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: { ok: false, error: { code, message } },
  };
}

function talkOrNull(talkId: string, userId: string) {
  return getTalkForUser(talkId, userId);
}

/** Returns a 403 response if the user cannot edit the talk; null if allowed. */
function requireEditAccess(
  talkId: string,
  auth: AuthContext,
): ReturnType<typeof forbiddenResponse> | null {
  if (!canEditTalk(talkId, auth.userId, auth.role)) {
    return forbiddenResponse('You do not have permission to edit this talk.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/context
// ---------------------------------------------------------------------------

export function getTalkContextRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkContextSnapshot>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: getTalkContext(input.talkId) },
  };
}

// ---------------------------------------------------------------------------
// PUT /talks/:talkId/context/goal
// ---------------------------------------------------------------------------

export function setTalkGoalRoute(input: {
  auth: AuthContext;
  talkId: string;
  goalText: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ goal: TalkContextSnapshot['goal'] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const text = input.goalText.replace(/[\r\n]/g, '').trim();
  if (text.length > 160) {
    return badRequest('goal_too_long', 'Goal must be 160 characters or fewer.');
  }

  const goal = setTalkGoal({
    talkId: input.talkId,
    goalText: text,
    updatedBy: input.auth.userId,
  });

  return {
    statusCode: 200,
    body: { ok: true, data: { goal } },
  };
}

// ---------------------------------------------------------------------------
// GET /talks/:talkId/context/rules
// ---------------------------------------------------------------------------

export function listTalkContextRulesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rules: ContextRuleSnapshot[] }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { rules: listTalkContextRules(input.talkId) } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/rules
// ---------------------------------------------------------------------------

export function createTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleText: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rule: ContextRuleSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const text = input.ruleText.trim();
  if (!text) {
    return badRequest('rule_text_required', 'Rule text is required.');
  }
  if (text.length > 240) {
    return badRequest('rule_too_long', 'Rule must be 240 characters or fewer.');
  }

  try {
    const rule = createTalkContextRule({
      talkId: input.talkId,
      ruleText: text,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { rule } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create rule.';
    if (message.includes('Maximum 8 active rules')) {
      return badRequest('active_rule_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PATCH /talks/:talkId/context/rules/:ruleId
// ---------------------------------------------------------------------------

export function patchTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{ rule: ContextRuleSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (input.ruleText !== undefined) {
    const text = input.ruleText.trim();
    if (!text)
      return badRequest('rule_text_required', 'Rule text is required.');
    if (text.length > 240)
      return badRequest(
        'rule_too_long',
        'Rule must be 240 characters or fewer.',
      );
  }

  try {
    const rule = patchTalkContextRule({
      ruleId: input.ruleId,
      talkId: input.talkId,
      ruleText: input.ruleText,
      isActive: input.isActive,
      sortOrder: input.sortOrder,
    });
    if (!rule) return notFoundResponse('Rule not found.');

    return {
      statusCode: 200,
      body: { ok: true, data: { rule } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to update rule.';
    if (message.includes('Maximum 8 active rules')) {
      return badRequest('active_rule_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// DELETE /talks/:talkId/context/rules/:ruleId
// ---------------------------------------------------------------------------

export function deleteTalkContextRuleRoute(input: {
  auth: AuthContext;
  talkId: string;
  ruleId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const deleted = deleteTalkContextRule(input.ruleId, input.talkId);
  if (!deleted) return notFoundResponse('Rule not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/sources
// ---------------------------------------------------------------------------

export function createTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceType: string;
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  extractedText?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const sourceType = input.sourceType;
  if (sourceType !== 'url' && sourceType !== 'text') {
    return badRequest(
      'invalid_source_type',
      'Source type must be url or text.',
    );
  }

  const title = input.title.trim();
  if (!title) {
    return badRequest('title_required', 'Source title is required.');
  }

  if (sourceType === 'text' && !input.extractedText?.trim()) {
    return badRequest(
      'text_content_required',
      'Text content is required for text sources.',
    );
  }

  if (sourceType === 'url' && !input.sourceUrl?.trim()) {
    return badRequest('url_required', 'A URL is required for URL sources.');
  }

  try {
    const source = createTalkContextSource({
      talkId: input.talkId,
      sourceType,
      title,
      note: input.note,
      sourceUrl: input.sourceUrl,
      extractedText: input.extractedText,
      createdBy: input.auth.userId,
    });
    return {
      statusCode: 201,
      body: { ok: true, data: { source } },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to create source.';
    if (message.includes('Maximum 20')) {
      return badRequest('source_limit', message);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// PATCH /talks/:talkId/context/sources/:sourceId
// ---------------------------------------------------------------------------

export function patchTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  if (input.title !== undefined && !input.title.trim()) {
    return badRequest('title_required', 'Source title is required.');
  }

  const source = patchTalkContextSource({
    sourceId: input.sourceId,
    talkId: input.talkId,
    title: input.title,
    note: input.note,
    sortOrder: input.sortOrder,
    extractedText: input.extractedText,
  });
  if (!source) return notFoundResponse('Source not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { source } },
  };
}

// ---------------------------------------------------------------------------
// DELETE /talks/:talkId/context/sources/:sourceId
// ---------------------------------------------------------------------------

export function deleteTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const deleted = deleteTalkContextSource(input.sourceId, input.talkId);
  if (!deleted) return notFoundResponse('Source not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { deleted: true } },
  };
}

// ---------------------------------------------------------------------------
// POST /talks/:talkId/context/sources/:sourceId/retry
// ---------------------------------------------------------------------------

export function retryTalkContextSourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  sourceId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ source: ContextSourceSnapshot }>;
} {
  const talk = talkOrNull(input.talkId, input.auth.userId);
  if (!talk) return notFoundResponse('Talk not found.');
  const denied = requireEditAccess(input.talkId, input.auth);
  if (denied) return denied;

  const existing = getTalkContextSourceById(input.sourceId, input.talkId);
  if (!existing) return notFoundResponse('Source not found.');
  if (existing.sourceType !== 'url' || !existing.sourceUrl) {
    return badRequest(
      'source_not_retryable',
      'Only URL sources can be retried.',
    );
  }

  const source = markTalkContextSourcePending(input.sourceId, input.talkId);
  if (!source) return notFoundResponse('Source not found.');

  return {
    statusCode: 200,
    body: { ok: true, data: { source } },
  };
}
