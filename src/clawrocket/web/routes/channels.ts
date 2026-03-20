import {
  clearBindingQuarantine,
  createTalkChannelBinding,
  deleteChannelDeliveryOutboxRow,
  deleteChannelIngressQueueRow,
  deleteTalkChannelBinding,
  getChannelConnectionById,
  getTalkChannelBindingById,
  listChannelConnections,
  listChannelDeliveryFailures,
  listChannelIngressFailures,
  listTalkChannelBindingsForTalk,
  quarantineBinding,
  retryChannelDeliveryFailure,
  retryChannelDeliveryFailuresCapped,
  retryChannelIngressFailure,
  searchChannelTargets,
  updateBindingDeliveryResult,
  updateConnectionProbeResult,
  updateTalkChannelBinding,
} from '../../db/index.js';
import {
  diagnoseBinding,
  type BindingDiagnosis,
} from '../../channels/channel-diagnosis.js';
import { canEditTalk } from '../middleware/acl.js';
import { ApiEnvelope, AuthContext } from '../types.js';
import { getTalkForUser } from '../../db/index.js';

export interface TalkChannelBindingApiRecord {
  id: string;
  talkId: string;
  connectionId: string;
  platform: 'telegram' | 'slack';
  connectionDisplayName: string;
  connectionHealthStatus: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  active: boolean;
  responseMode: 'off' | 'mentions' | 'all';
  responderMode: 'primary' | 'agent';
  responderAgentId: string | null;
  deliveryMode: 'reply' | 'channel';
  channelContextNote: string | null;
  inboundRateLimitPerMinute: number;
  maxPendingEvents: number;
  overflowPolicy: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes: number;
  pendingIngressCount: number;
  deferredIngressCount: number;
  deadLetterCount: number;
  unresolvedIngressCount: number;
  lastIngressAt: string | null;
  lastDeliveryAt: string | null;
  lastIngressReasonCode: string | null;
  lastDeliveryReasonCode: string | null;
  healthQuarantined: boolean;
  healthQuarantineCode: string | null;
  diagnosis: BindingDiagnosis;
}

const manualIngressRetryTimestamps = new Map<string, number[]>();

function canManageConnections(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

function notFound(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 404,
    body: {
      ok: false,
      error: {
        code: 'not_found',
        message,
      },
    },
  };
}

function forbidden(message: string): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 403,
    body: {
      ok: false,
      error: {
        code: 'forbidden',
        message,
      },
    },
  };
}

function trimManualRetryTimestamps(bindingId: string, nowMs: number): number[] {
  const recent =
    manualIngressRetryTimestamps
      .get(bindingId)
      ?.filter((timestamp) => nowMs - timestamp < 60_000) || [];
  if (recent.length === 0) {
    manualIngressRetryTimestamps.delete(bindingId);
    return [];
  }
  manualIngressRetryTimestamps.set(bindingId, recent);
  return recent;
}

function toBindingApiRecord(
  record: ReturnType<typeof listTalkChannelBindingsForTalk>[number],
): TalkChannelBindingApiRecord {
  return {
    id: record.id,
    talkId: record.talk_id,
    connectionId: record.connection_id,
    platform: record.platform,
    connectionDisplayName: record.connection_display_name,
    connectionHealthStatus: record.connection_health_status,
    targetKind: record.target_kind,
    targetId: record.target_id,
    displayName: record.display_name,
    active: record.active === 1,
    responseMode: record.response_mode,
    responderMode: record.responder_mode,
    responderAgentId: record.responder_agent_id,
    deliveryMode: record.delivery_mode,
    channelContextNote: record.channel_context_note,
    inboundRateLimitPerMinute: record.inbound_rate_limit_per_minute,
    maxPendingEvents: record.max_pending_events,
    overflowPolicy: record.overflow_policy,
    maxDeferredAgeMinutes: record.max_deferred_age_minutes,
    pendingIngressCount: record.pending_ingress_count,
    deferredIngressCount: record.deferred_ingress_count,
    deadLetterCount: record.dead_letter_count,
    unresolvedIngressCount: record.unresolved_ingress_count,
    lastIngressAt: record.last_ingress_at,
    lastDeliveryAt: record.last_delivery_at,
    lastIngressReasonCode: record.last_ingress_reason_code,
    lastDeliveryReasonCode: record.last_delivery_reason_code,
    healthQuarantined: record.health_quarantined === 1,
    healthQuarantineCode: record.health_quarantine_code,
    diagnosis: diagnoseBinding({
      active: record.active,
      healthQuarantined: record.health_quarantined,
      healthQuarantineCode: record.health_quarantine_code,
      connectionHealthStatus: record.connection_health_status,
      deadLetterCount: record.dead_letter_count,
      unresolvedIngressCount: record.unresolved_ingress_count,
      responseMode: record.response_mode,
      lastIngressAt: record.last_ingress_at,
      lastDeliveryAt: record.last_delivery_at,
    }),
  };
}

export function listChannelConnectionsRoute(input: { auth: AuthContext }) {
  if (!canManageConnections(input.auth)) {
    return forbidden(
      'You do not have permission to manage channel connections.',
    );
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connections: listChannelConnections(),
      },
    } satisfies ApiEnvelope<{
      connections: ReturnType<typeof listChannelConnections>;
    }>,
  };
}

export function listChannelTargetsRoute(input: {
  auth: AuthContext;
  connectionId: string;
  query?: string;
  limit?: number;
}) {
  if (!canManageConnections(input.auth)) {
    return forbidden('You do not have permission to browse channel targets.');
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connection,
        targets: searchChannelTargets({
          connectionId: input.connectionId,
          query: input.query,
          limit: input.limit,
        }),
      },
    },
  };
}

export function listTalkChannelsRoute(input: {
  auth: AuthContext;
  talkId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        bindings: listTalkChannelBindingsForTalk(input.talkId).map(
          toBindingApiRecord,
        ),
      },
    },
  };
}

export function createTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  responseMode?: 'off' | 'mentions' | 'all';
  responderMode?: 'primary' | 'agent';
  responderAgentId?: string | null;
  deliveryMode?: 'reply' | 'channel';
  channelContextNote?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const connection = getChannelConnectionById(input.connectionId);
  if (!connection) {
    return notFound('Channel connection not found.');
  }

  const binding = createTalkChannelBinding({
    talkId: input.talkId,
    connectionId: input.connectionId,
    targetKind: input.targetKind,
    targetId: input.targetId,
    displayName: input.displayName.trim() || input.targetId,
    createdBy: input.auth.userId,
    responseMode: input.responseMode,
    responderMode: input.responderMode,
    responderAgentId: input.responderAgentId,
    deliveryMode: input.deliveryMode,
    channelContextNote: input.channelContextNote,
    inboundRateLimitPerMinute: input.inboundRateLimitPerMinute,
    maxPendingEvents: input.maxPendingEvents,
    overflowPolicy: input.overflowPolicy,
    maxDeferredAgeMinutes: input.maxDeferredAgeMinutes,
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        binding: toBindingApiRecord(binding),
      },
    },
  };
}

export function patchTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  active?: boolean;
  displayName?: string;
  responseMode?: 'off' | 'mentions' | 'all';
  responderMode?: 'primary' | 'agent';
  responderAgentId?: string | null;
  deliveryMode?: 'reply' | 'channel';
  channelContextNote?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: 'drop_oldest' | 'drop_newest';
  maxDeferredAgeMinutes?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const updated = updateTalkChannelBinding({
    bindingId: input.bindingId,
    updatedBy: input.auth.userId,
    active: input.active,
    displayName: input.displayName,
    responseMode: input.responseMode,
    responderMode: input.responderMode,
    responderAgentId: input.responderAgentId,
    deliveryMode: input.deliveryMode,
    channelContextNote: input.channelContextNote,
    inboundRateLimitPerMinute: input.inboundRateLimitPerMinute,
    maxPendingEvents: input.maxPendingEvents,
    overflowPolicy: input.overflowPolicy,
    maxDeferredAgeMinutes: input.maxDeferredAgeMinutes,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        binding: toBindingApiRecord(updated),
      },
    },
  };
}

export function deleteTalkChannelRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to edit channels for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  deleteTalkChannelBinding(input.bindingId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function listTalkChannelIngressFailuresRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to view channel failures for this talk.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        failures: listChannelIngressFailures(input.bindingId),
      },
    },
  };
}

export function retryTalkChannelIngressFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to retry channel ingress failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const now = Date.now();
  const recent = trimManualRetryTimestamps(input.bindingId, now);
  if (recent.length >= 5) {
    return {
      statusCode: 429,
      body: {
        ok: false,
        error: {
          code: 'retry_rate_limited',
          message:
            'Too many manual retries for this binding. Try again shortly.',
        },
      },
    };
  }
  const retried = retryChannelIngressFailure(input.rowId);
  if (!retried) {
    return notFound('Channel ingress failure not found.');
  }
  recent.push(now);
  manualIngressRetryTimestamps.set(input.bindingId, recent);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        retried: true,
      },
    },
  };
}

export function deleteTalkChannelIngressFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to dismiss channel ingress failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const deleted = deleteChannelIngressQueueRow(input.rowId);
  if (!deleted) {
    return notFound('Channel ingress failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function listTalkChannelDeliveryFailuresRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to view channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        failures: listChannelDeliveryFailures(input.bindingId),
      },
    },
  };
}

export function retryTalkChannelDeliveryFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to retry channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const retried = retryChannelDeliveryFailure(input.rowId);
  if (!retried) {
    return notFound('Channel delivery failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        retried: true,
      },
    },
  };
}

export function deleteTalkChannelDeliveryFailureRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  rowId: string;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to dismiss channel delivery failures.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const deleted = deleteChannelDeliveryOutboxRow(input.rowId);
  if (!deleted) {
    return notFound('Channel delivery failure not found.');
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        deleted: true,
      },
    },
  };
}

export function testTalkChannelBindingRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  sendTestMessage?: (bindingId: string, text: string) => Promise<void>;
}) {
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to test this talk channel binding.',
    );
  }
  if (!input.sendTestMessage) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        error: {
          code: 'channel_test_unavailable',
          message: 'Test-send is not available in this runtime.',
        },
      },
    };
  }
  return input
    .sendTestMessage(input.bindingId, 'This is a test from ClawRocket.')
    .then(() => {
      // A successful test send proves the binding and connection work.
      // Update last_delivery_at so diagnosis moves out of "No activity yet",
      // and reset the connection probe state so the delivery worker stops
      // deferring for connection_unreachable.
      updateBindingDeliveryResult(input.bindingId, {
        lastDeliveryAt: new Date().toISOString(),
      });
      updateConnectionProbeResult(binding.connection_id, true);
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            sent: true,
          },
        },
      };
    })
    .catch((error: unknown) => ({
      statusCode: 502,
      body: {
        ok: false,
        error: {
          code: 'channel_test_failed',
          message:
            error instanceof Error ? error.message : 'Channel test send failed',
        },
      },
    }));
}

export async function unquarantineTalkChannelBindingRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  sendTestMessage?: (bindingId: string, text: string) => Promise<void>;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden(
      'You do not have permission to unquarantine this binding.',
    );
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  if (!input.sendTestMessage) {
    return {
      statusCode: 501,
      body: {
        ok: false,
        error: {
          code: 'channel_test_unavailable',
          message: 'Test-send is not available in this runtime.',
        },
      },
    };
  }

  try {
    await input.sendTestMessage(
      input.bindingId,
      'This is a test from ClawRocket — reconnecting channel.',
    );
    clearBindingQuarantine(input.bindingId);
    updateBindingDeliveryResult(input.bindingId, {
      lastDeliveryAt: new Date().toISOString(),
    });
    // A successful send proves the connection is reachable — reset probe state
    // so the delivery worker stops deferring and diagnosis shows healthy.
    updateConnectionProbeResult(binding.connection_id, true);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { unquarantined: true },
      },
    };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: string }).code)
        : 'test_failed';
    const message =
      error instanceof Error ? error.message : 'Channel test send failed';
    const errorAt = new Date().toISOString();
    quarantineBinding(input.bindingId, code);
    updateBindingDeliveryResult(input.bindingId, {
      errorCode: code,
      errorDetail: message,
      errorAt,
    });
    return {
      statusCode: 502,
      body: {
        ok: false,
        error: { code, message },
      },
    };
  }
}

export function retryTalkChannelDeliveryFailuresCappedRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
  maxAgeMins?: number;
  maxCount?: number;
}) {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFound('Talk not found.');
  }
  if (!canEditTalk(input.talkId, input.auth.userId, input.auth.role)) {
    return forbidden('You do not have permission to retry delivery failures.');
  }
  const binding = getTalkChannelBindingById(input.bindingId);
  if (!binding || binding.talk_id !== input.talkId) {
    return notFound('Talk channel binding not found.');
  }
  const result = retryChannelDeliveryFailuresCapped({
    bindingId: input.bindingId,
    maxAgeMins: input.maxAgeMins,
    maxCount: input.maxCount,
  });
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: result,
    },
  };
}
