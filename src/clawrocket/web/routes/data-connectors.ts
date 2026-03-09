import {
  attachDataConnectorToTalk,
  createDataConnector,
  deleteDataConnector,
  deleteDataConnectorCredential,
  detachDataConnectorFromTalk,
  getDataConnectorById,
  getTalkForUser,
  listDataConnectors,
  listTalkDataConnectors,
  patchDataConnector,
  setDataConnectorCredential,
  type DataConnectorSnapshot,
  type TalkDataConnectorSnapshot,
} from '../../db/index.js';
import { encryptConnectorSecret } from '../../connectors/connector-secret-store.js';
import type { ConnectorKind } from '../../connectors/types.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

function canManageDataConnectors(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

function normalizeJsonMap(value: unknown): JsonMap | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonMap;
}

function validateConnectorKind(value: string): ConnectorKind | null {
  if (value === 'google_sheets' || value === 'posthog') {
    return value;
  }
  return null;
}

function forbiddenResponse(message: string): {
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

function notFoundResponse(message: string): {
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

export interface DataConnectorsListRecord {
  connectors: DataConnectorSnapshot[];
}

export interface TalkDataConnectorsListRecord {
  talkId: string;
  connectors: TalkDataConnectorSnapshot[];
}

export function listDataConnectorsRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<DataConnectorsListRecord>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connectors: listDataConnectors(),
      },
    },
  };
}

export function createDataConnectorRoute(input: {
  auth: AuthContext;
  name: string;
  connectorKind: string;
  config?: unknown;
  enabled?: boolean;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const name = input.name.trim();
  if (!name) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_name',
          message: 'A connector name is required.',
        },
      },
    };
  }

  const connectorKind = validateConnectorKind(input.connectorKind);
  if (!connectorKind) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connector_kind',
          message: 'A supported connector kind is required.',
        },
      },
    };
  }

  const connector = createDataConnector({
    name,
    connectorKind,
    config: normalizeJsonMap(input.config) ?? {},
    enabled: input.enabled !== false,
    createdBy: input.auth.userId,
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        connector,
      },
    },
  };
}

export function patchDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
  name?: string;
  config?: unknown;
  enabled?: boolean;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const existing = getDataConnectorById(input.connectorId);
  if (!existing) {
    return notFoundResponse('Data connector not found.');
  }

  const nextName =
    input.name !== undefined ? input.name.trim() : undefined;
  if (input.name !== undefined && !nextName) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_name',
          message: 'A connector name is required.',
        },
      },
    };
  }

  const connector = patchDataConnector({
    connectorId: input.connectorId,
    name: nextName,
    config:
      input.config !== undefined ? normalizeJsonMap(input.config) ?? {} : undefined,
    enabled: input.enabled,
    updatedBy: input.auth.userId,
  });

  if (!connector) {
    return notFoundResponse('Data connector not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connector,
      },
    },
  };
}

export function deleteDataConnectorRoute(input: {
  auth: AuthContext;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const deleted = deleteDataConnector(input.connectorId);
  if (!deleted) {
    return notFoundResponse('Data connector not found.');
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

export function setDataConnectorCredentialRoute(input: {
  auth: AuthContext;
  connectorId: string;
  apiKey?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: DataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage data connectors.',
    );
  }

  const connector = getDataConnectorById(input.connectorId);
  if (!connector) {
    return notFoundResponse('Data connector not found.');
  }

  const apiKey = input.apiKey?.trim() || null;
  let updated: DataConnectorSnapshot | undefined;

  if (connector.connectorKind === 'posthog') {
    updated = apiKey
      ? setDataConnectorCredential({
          connectorId: input.connectorId,
          ciphertext: encryptConnectorSecret({
            kind: 'posthog',
            apiKey,
          }),
          updatedBy: input.auth.userId,
        })
      : deleteDataConnectorCredential(input.connectorId, input.auth.userId);
  } else if (connector.connectorKind === 'google_sheets') {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'oauth_required',
          message:
            'Google Sheets connectors require OAuth. That flow is not wired into this slice yet.',
        },
      },
    };
  } else {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'unsupported_connector_kind',
          message: 'This connector kind does not support direct API key storage.',
        },
      },
    };
  }

  if (!updated) {
    return notFoundResponse('Data connector not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connector: updated,
      },
    },
  };
}

export function listTalkDataConnectorsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkDataConnectorsListRecord>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        talkId: input.talkId,
        connectors: listTalkDataConnectors(input.talkId),
      },
    },
  };
}

export function attachTalkDataConnectorRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ connector: TalkDataConnectorSnapshot }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to attach data connectors to talks.',
    );
  }

  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }
  if (!input.connectorId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_connector_id',
          message: 'A connectorId is required.',
        },
      },
    };
  }

  const connector = getDataConnectorById(input.connectorId);
  if (!connector) {
    return notFoundResponse('Data connector not found.');
  }
  if (!connector.enabled) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'connector_disabled',
          message: 'Only enabled data connectors can be attached to talks.',
        },
      },
    };
  }

  const attached = attachDataConnectorToTalk({
    talkId: input.talkId,
    connectorId: input.connectorId,
    userId: input.auth.userId,
  });
  if (!attached) {
    return notFoundResponse('Data connector not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connector: attached,
      },
    },
  };
}

export function detachTalkDataConnectorRoute(input: {
  auth: AuthContext;
  talkId: string;
  connectorId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  if (!canManageDataConnectors(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to detach data connectors from talks.',
    );
  }

  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  const deleted = detachDataConnectorFromTalk(input.talkId, input.connectorId);
  if (!deleted) {
    return notFoundResponse('Data connector attachment not found.');
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
