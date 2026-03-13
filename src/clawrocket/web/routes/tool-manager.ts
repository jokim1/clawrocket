import {
  canUserEditTalk,
  createTalkResourceBinding,
  deleteTalkResourceBinding,
  getTalkActionConfirmationById,
  getTalkForUser,
  getUserById,
  getUserGoogleCredential,
  initializeTalkToolGrants,
  listTalkAgentInstances,
  listTalkAttachments,
  listTalkAuditEntries,
  listTalkContextSources,
  listTalkDataConnectors,
  listTalkResourceBindings,
  listTalkToolGrants,
  listToolRegistryEntries,
  replaceTalkToolGrants,
  resolveTalkAgent,
  resolveTalkActionConfirmation,
  upsertToolRegistryEntry,
  upsertUserGoogleCredential,
  type TalkResourceBindingKind,
  type ToolErrorCategory,
  type ToolRegistryHealthStatus,
  type ToolRegistryInstallStatus,
} from '../../db/index.js';
import { ApiEnvelope, AuthContext } from '../types.js';

type JsonMap = Record<string, unknown>;

type EffectiveAccessState =
  | 'available'
  | 'unavailable_due_to_route'
  | 'unavailable_due_to_identity'
  | 'unavailable_due_to_pending_scopes'
  | 'unavailable_due_to_scope'
  | 'unavailable_due_to_config'
  | 'unavailable_due_to_missing_resource';

export interface ToolRegistryEntryApiRecord {
  id: string;
  family:
    | 'saved_sources'
    | 'attachments'
    | 'web'
    | 'gmail'
    | 'google_drive'
    | 'google_docs'
    | 'google_sheets'
    | 'data_connectors';
  displayName: string;
  description: string | null;
  enabled: boolean;
  installStatus: ToolRegistryInstallStatus;
  healthStatus: ToolRegistryHealthStatus;
  authRequirements: JsonMap | null;
  mutatesExternalState: boolean;
  requiresBinding: boolean;
  defaultGrant: boolean;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkToolGrantApiRecord {
  toolId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkResourceBindingApiRecord {
  id: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UserGoogleAccountApiRecord {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
}

export interface ToolAccessByAgentApiRecord {
  agentId: string;
  nickname: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  toolAccess: Array<{
    toolId: string;
    state: EffectiveAccessState;
  }>;
}

export interface TalkAuditEntryApiRecord {
  id: string;
  runId: string;
  agentId: string | null;
  toolName: string;
  confirmationId: string | null;
  targetResourceId: string | null;
  summary: JsonMap | null;
  resultStatus: 'success' | 'failed';
  errorCategory: ToolErrorCategory | null;
  errorMessage: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface TalkActionConfirmationApiRecord {
  id: string;
  talkId: string;
  runId: string;
  toolName: string;
  confirmationType: 'mutation' | 'scope_expansion';
  status:
    | 'pending'
    | 'approved_pending_execution'
    | 'approved_executed'
    | 'approved_failed'
    | 'rejected'
    | 'superseded';
  proposedArgs: JsonMap | null;
  modifiedArgs: JsonMap | null;
  preview: JsonMap | null;
  toolCallId: string | null;
  requestedBy: string;
  resolvedBy: string | null;
  reason: string | null;
  errorCategory: ToolErrorCategory | null;
  errorMessage: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TalkToolsApiRecord {
  talkId: string;
  registry: ToolRegistryEntryApiRecord[];
  grants: TalkToolGrantApiRecord[];
  bindings: TalkResourceBindingApiRecord[];
  googleAccount: UserGoogleAccountApiRecord;
  summary: string[];
  warnings: string[];
  effectiveAccess: ToolAccessByAgentApiRecord[];
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

function invalidResponse(
  code: string,
  message: string,
): {
  statusCode: number;
  body: ApiEnvelope<never>;
} {
  return {
    statusCode: 400,
    body: {
      ok: false,
      error: {
        code,
        message,
      },
    },
  };
}

function toTalkActionConfirmationApiRecord(
  confirmation: NonNullable<ReturnType<typeof getTalkActionConfirmationById>>,
): TalkActionConfirmationApiRecord {
  return {
    id: confirmation.id,
    talkId: confirmation.talkId,
    runId: confirmation.runId,
    toolName: confirmation.toolName,
    confirmationType: confirmation.confirmationType,
    status: confirmation.status,
    proposedArgs: confirmation.proposedArgs,
    modifiedArgs: confirmation.modifiedArgs,
    preview: confirmation.preview,
    toolCallId: confirmation.toolCallId,
    requestedBy: confirmation.requestedBy,
    resolvedBy: confirmation.resolvedBy,
    reason: confirmation.reason,
    errorCategory: confirmation.errorCategory,
    errorMessage: confirmation.errorMessage,
    createdAt: confirmation.createdAt,
    resolvedAt: confirmation.resolvedAt,
  };
}

function canManageToolRegistry(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

function toGoogleAccountApiRecord(
  userId: string,
): UserGoogleAccountApiRecord {
  const credential = getUserGoogleCredential(userId);
  if (!credential) {
    return {
      connected: false,
      email: null,
      displayName: null,
      scopes: [],
      accessExpiresAt: null,
    };
  }
  return {
    connected: true,
    email: credential.email,
    displayName: credential.displayName,
    scopes: credential.scopes,
    accessExpiresAt: credential.accessExpiresAt,
  };
}

function requiredScopesForTool(toolId: string): string[] {
  switch (toolId) {
    case 'gmail_read':
      return ['gmail.readonly'];
    case 'gmail_send':
      return ['gmail.send'];
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
      return ['drive.readonly'];
    case 'google_docs_read':
      return ['documents.readonly'];
    case 'google_docs_batch_update':
      return ['documents'];
    case 'google_sheets_read_range':
      return ['spreadsheets.readonly'];
    case 'google_sheets_batch_update':
      return ['spreadsheets'];
    default:
      return [];
  }
}

function hasRelevantResources(input: {
  toolId: string;
  bindingsCount: number;
  sourcesCount: number;
  attachmentsCount: number;
  connectorCount: number;
}): boolean {
  switch (input.toolId) {
    case 'saved_sources':
      return input.sourcesCount > 0;
    case 'attachments':
      return input.attachmentsCount > 0;
    case 'data_connectors':
      return input.connectorCount > 0;
    case 'google_drive_search':
    case 'google_drive_read':
    case 'google_drive_list_folder':
    case 'google_docs_read':
    case 'google_docs_batch_update':
    case 'google_sheets_read_range':
    case 'google_sheets_batch_update':
      return input.bindingsCount > 0;
    default:
      return true;
  }
}

function computeToolState(input: {
  toolId: string;
  registryEnabled: boolean;
  installStatus: ToolRegistryInstallStatus;
  healthStatus: ToolRegistryHealthStatus;
  grantEnabled: boolean;
  requiresBinding: boolean;
  bindingsCount: number;
  sourcesCount: number;
  attachmentsCount: number;
  connectorCount: number;
  googleConnected: boolean;
  grantedScopes: Set<string>;
  toolCapable: boolean;
}): EffectiveAccessState {
  if (
    !input.registryEnabled ||
    input.installStatus !== 'installed' ||
    input.healthStatus === 'unavailable'
  ) {
    return 'unavailable_due_to_config';
  }
  if (!input.grantEnabled) {
    return 'unavailable_due_to_config';
  }
  if (!input.toolCapable) {
    return 'unavailable_due_to_route';
  }

  const requiredScopes = requiredScopesForTool(input.toolId);
  if (requiredScopes.length > 0 && !input.googleConnected) {
    return 'unavailable_due_to_identity';
  }
  if (
    requiredScopes.length > 0 &&
    requiredScopes.some((scope) => !input.grantedScopes.has(scope))
  ) {
    return 'unavailable_due_to_pending_scopes';
  }
  if (
    input.requiresBinding &&
    !hasRelevantResources({
      toolId: input.toolId,
      bindingsCount: input.bindingsCount,
      sourcesCount: input.sourcesCount,
      attachmentsCount: input.attachmentsCount,
      connectorCount: input.connectorCount,
    })
  ) {
    return 'unavailable_due_to_missing_resource';
  }

  if (
    !hasRelevantResources({
      toolId: input.toolId,
      bindingsCount: input.bindingsCount,
      sourcesCount: input.sourcesCount,
      attachmentsCount: input.attachmentsCount,
      connectorCount: input.connectorCount,
    })
  ) {
    return 'unavailable_due_to_missing_resource';
  }

  return 'available';
}

function summarizeCapabilities(input: {
  grants: Map<string, boolean>;
  bindingsCount: number;
  googleAccount: UserGoogleAccountApiRecord;
  grantedScopes: Set<string>;
}): string[] {
  const summary: string[] = [];
  const add = (text: string) => {
    if (!summary.includes(text)) summary.push(text);
  };
  const hasAllScopes = (toolIds: string[]): boolean =>
    toolIds.every((toolId) =>
      requiredScopesForTool(toolId).every((scope) =>
        input.grantedScopes.has(scope),
      ),
    );

  if (input.grants.get('web_search') || input.grants.get('web_fetch')) {
    add('This Talk can search the web');
  }
  const usesBoundGoogleResources =
    input.grants.get('google_drive_search') ||
    input.grants.get('google_drive_read') ||
    input.grants.get('google_drive_list_folder') ||
    input.grants.get('google_docs_read') ||
    input.grants.get('google_docs_batch_update') ||
    input.grants.get('google_sheets_read_range') ||
    input.grants.get('google_sheets_batch_update');
  if (usesBoundGoogleResources) {
    if (input.bindingsCount === 0) {
      add('Google Drive unavailable — bind a file or folder to enable');
    } else if (!input.googleAccount.connected) {
      add('Google Drive tools need a connected Google account');
    } else if (
      !hasAllScopes([
        'google_drive_search',
        'google_drive_read',
        'google_drive_list_folder',
        'google_docs_read',
        'google_docs_batch_update',
        'google_sheets_read_range',
        'google_sheets_batch_update',
      ].filter((toolId) => input.grants.get(toolId) === true))
    ) {
      add('Google Drive tools need additional Google permissions');
    } else {
      add('This Talk can use bound Drive files');
    }
  }
  if (input.grants.get('gmail_send')) {
    add(
      input.googleAccount.connected &&
        hasAllScopes(['gmail_send'])
        ? 'Email sends require user approval'
        : 'Gmail send needs additional Google permissions',
    );
  }
  return summary;
}

function buildTalkToolsRecord(input: {
  talkId: string;
  userId: string;
}): TalkToolsApiRecord {
  const talk = getTalkForUser(input.talkId, input.userId);
  if (!talk) {
    throw new Error('talk_not_found');
  }

  initializeTalkToolGrants(input.talkId, talk.owner_id);
  const grants = listTalkToolGrants(input.talkId);

  const bindings = listTalkResourceBindings(input.talkId);
  const registry = listToolRegistryEntries().map((entry) => ({
    id: entry.id,
    family: entry.family,
    displayName: entry.displayName,
    description: entry.description,
    enabled: entry.enabled,
    installStatus: entry.installStatus,
    healthStatus: entry.healthStatus,
    authRequirements: entry.authRequirements,
    mutatesExternalState: entry.mutatesExternalState,
    requiresBinding: entry.requiresBinding,
    defaultGrant: entry.defaultGrant,
    sortOrder: entry.sortOrder,
    updatedAt: entry.updatedAt,
    updatedBy: entry.updatedBy,
  }));
  const googleAccount = toGoogleAccountApiRecord(input.userId);
  const grantedScopes = new Set(googleAccount.scopes);
  const grantMap = new Map(grants.map((grant) => [grant.toolId, grant.enabled]));
  const boundDriveResources = bindings.filter(
    (binding) =>
      binding.bindingKind === 'google_drive_folder' ||
      binding.bindingKind === 'google_drive_file',
  );
  const sourcesCount = listTalkContextSources(input.talkId).length;
  const attachmentsCount = listTalkAttachments(input.talkId).length;
  const connectorCount = listTalkDataConnectors(input.talkId).length;
  const agents = listTalkAgentInstances(input.talkId);
  const effectiveAccess = agents.map((agent) => {
    const resolved = resolveTalkAgent(input.talkId, agent.id);
    const toolCapable = Boolean(
      resolved?.steps.some(
        (step) =>
          step.talkUsable &&
          step.hasCredential &&
          step.model.supports_tools === 1 &&
          step.provider.enabled === 1,
      ),
    );
    return {
      agentId: agent.id,
      nickname: agent.nickname,
      sourceKind: agent.sourceKind,
      providerId: agent.providerId,
      modelId: agent.modelId,
      toolAccess: registry.map((entry) => ({
        toolId: entry.id,
        state: computeToolState({
          toolId: entry.id,
          registryEnabled: entry.enabled,
          installStatus: entry.installStatus,
          healthStatus: entry.healthStatus,
          grantEnabled: grantMap.get(entry.id) === true,
          requiresBinding: entry.requiresBinding,
          bindingsCount: boundDriveResources.length,
          sourcesCount,
          attachmentsCount,
          connectorCount,
          googleConnected: googleAccount.connected,
          grantedScopes,
          toolCapable,
        }),
      })),
    };
  });

  const warnings: string[] = [];
  const anyRouteBlocked = effectiveAccess.some((agent) =>
    agent.toolAccess.some(
      (tool) =>
        tool.state === 'unavailable_due_to_route' &&
        grantMap.get(tool.toolId) === true,
    ),
  );
  if (anyRouteBlocked) {
    warnings.push(
      'Some agents are text-only for one or more granted Talk tools.',
    );
  }
  if (
    boundDriveResources.length > 0 &&
    listTalkAgentInstances(input.talkId).length > 1
  ) {
    warnings.push(
      'Bound file content read by tools becomes visible to all Talk members who can read this Talk.',
    );
  }

  return {
    talkId: input.talkId,
    registry,
    grants: grants.map((grant) => ({
      toolId: grant.toolId,
      enabled: grant.enabled,
      updatedAt: grant.updatedAt,
      updatedBy: grant.updatedBy,
    })),
    bindings: bindings.map((binding) => ({
      id: binding.id,
      bindingKind: binding.bindingKind,
      externalId: binding.externalId,
      displayName: binding.displayName,
      metadata: binding.metadata,
      createdAt: binding.createdAt,
      createdBy: binding.createdBy,
    })),
    googleAccount,
    summary: summarizeCapabilities({
      grants: grantMap,
      bindingsCount: boundDriveResources.length,
      googleAccount,
      grantedScopes,
    }),
    warnings,
    effectiveAccess,
  };
}

export function getToolRegistryRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{ registry: ToolRegistryEntryApiRecord[] }>;
} {
  if (!canManageToolRegistry(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage server tools.',
    );
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        registry: listToolRegistryEntries().map((entry) => ({
          id: entry.id,
          family: entry.family,
          displayName: entry.displayName,
          description: entry.description,
          enabled: entry.enabled,
          installStatus: entry.installStatus,
          healthStatus: entry.healthStatus,
          authRequirements: entry.authRequirements,
          mutatesExternalState: entry.mutatesExternalState,
          requiresBinding: entry.requiresBinding,
          defaultGrant: entry.defaultGrant,
          sortOrder: entry.sortOrder,
          updatedAt: entry.updatedAt,
          updatedBy: entry.updatedBy,
        })),
      },
    },
  };
}

export function updateToolRegistryRoute(input: {
  auth: AuthContext;
  entries: Array<{
    id: string;
    enabled: boolean;
    installStatus: ToolRegistryInstallStatus;
    healthStatus: ToolRegistryHealthStatus;
    authRequirements?: JsonMap | null;
  }>;
}): {
  statusCode: number;
  body: ApiEnvelope<{ registry: ToolRegistryEntryApiRecord[] }>;
} {
  if (!canManageToolRegistry(input.auth)) {
    return forbiddenResponse(
      'You do not have permission to manage server tools.',
    );
  }

  for (const update of input.entries) {
    const existing = listToolRegistryEntries().find((entry) => entry.id === update.id);
    if (!existing) {
      return notFoundResponse(`Tool "${update.id}" was not found.`);
    }
    upsertToolRegistryEntry({
      id: existing.id,
      family: existing.family,
      displayName: existing.displayName,
      description: existing.description,
      enabled: update.enabled,
      installStatus: update.installStatus,
      healthStatus: update.healthStatus,
      authRequirements: update.authRequirements ?? existing.authRequirements,
      mutatesExternalState: existing.mutatesExternalState,
      requiresBinding: existing.requiresBinding,
      defaultGrant: existing.defaultGrant,
      sortOrder: existing.sortOrder,
      updatedBy: input.auth.userId,
    });
  }

  return getToolRegistryRoute({ auth: input.auth });
}

export function getUserGoogleAccountRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{ googleAccount: UserGoogleAccountApiRecord }>;
} {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        googleAccount: toGoogleAccountApiRecord(input.auth.userId),
      },
    },
  };
}

export function connectUserGoogleAccountRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<{ googleAccount: UserGoogleAccountApiRecord }>;
} {
  const user = getUserById(input.auth.userId);
  const existing = getUserGoogleCredential(input.auth.userId);
  const googleSubject = existing?.googleSubject || input.auth.userId;
  const email = existing?.email || user?.email || '';
  if (!googleSubject || !email) {
    return invalidResponse(
      'invalid_google_account',
      'Google subject and email are required.',
    );
  }

  upsertUserGoogleCredential({
    userId: input.auth.userId,
    googleSubject,
    email,
    displayName: existing?.displayName || user?.display_name || null,
    scopes: existing?.scopes || [],
    // Placeholder until the server-side Google OAuth exchange persists a real
    // encrypted credential.
    ciphertext: existing?.ciphertext || '__placeholder__',
    accessExpiresAt: existing?.accessExpiresAt ?? null,
  });

  return getUserGoogleAccountRoute({ auth: input.auth });
}

export function expandUserGoogleScopesRoute(input: {
  auth: AuthContext;
  scopes: string[];
}): {
  statusCode: number;
  body: ApiEnvelope<{ googleAccount: UserGoogleAccountApiRecord }>;
} {
  const existing = getUserGoogleCredential(input.auth.userId);
  if (!existing) {
    return notFoundResponse('Google account is not connected.');
  }

  return invalidResponse(
    'oauth_not_configured',
    'Google permission grants are not available until the server-side OAuth flow is configured.',
  );
}

export function getTalkToolsRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkToolsApiRecord>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildTalkToolsRecord({
        talkId: talk.id,
        userId: input.auth.userId,
      }),
    },
  };
}

export function updateTalkToolsRoute(input: {
  auth: AuthContext;
  talkId: string;
  grants: Array<{ toolId: string; enabled: boolean }>;
}): {
  statusCode: number;
  body: ApiEnvelope<TalkToolsApiRecord>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse('You do not have permission to update Talk tools.');
  }

  const registryIds = new Set(listToolRegistryEntries().map((entry) => entry.id));
  for (const grant of input.grants) {
    if (!registryIds.has(grant.toolId)) {
      return invalidResponse(
        'invalid_tool_id',
        `Tool "${grant.toolId}" is not registered.`,
      );
    }
  }

  initializeTalkToolGrants(input.talkId, talk.owner_id);
  const existingGrants = new Map(
    listTalkToolGrants(input.talkId).map((grant) => [grant.toolId, grant.enabled]),
  );
  const requestedGrants = new Map(
    input.grants.map((grant) => [grant.toolId, grant.enabled]),
  );
  replaceTalkToolGrants({
    talkId: input.talkId,
    grants: listToolRegistryEntries().map((entry) => ({
      toolId: entry.id,
      enabled: requestedGrants.get(entry.id) ?? existingGrants.get(entry.id) ?? false,
    })),
    updatedBy: input.auth.userId,
  });

  return getTalkToolsRoute({
    auth: input.auth,
    talkId: input.talkId,
  });
}

export function listTalkResourcesRoute(input: {
  auth: AuthContext;
  talkId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; bindings: TalkResourceBindingApiRecord[] }>;
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
        bindings: listTalkResourceBindings(input.talkId).map((binding) => ({
          id: binding.id,
          bindingKind: binding.bindingKind,
          externalId: binding.externalId,
          displayName: binding.displayName,
          metadata: binding.metadata,
          createdAt: binding.createdAt,
          createdBy: binding.createdBy,
        })),
      },
    },
  };
}

export function createTalkGoogleDriveResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ binding: TalkResourceBindingApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse(
      'You do not have permission to bind Talk resources.',
    );
  }

  if (
    input.bindingKind !== 'google_drive_folder' &&
    input.bindingKind !== 'google_drive_file'
  ) {
    return invalidResponse(
      'invalid_binding_kind',
      'Only Google Drive folder and file bindings are supported here.',
    );
  }

  const externalId = input.externalId.trim();
  const displayName = input.displayName.trim();
  if (!externalId || !displayName) {
    return invalidResponse(
      'invalid_binding',
      'Drive bindings require both an external id and display name.',
    );
  }

  const binding = createTalkResourceBinding({
    talkId: input.talkId,
    bindingKind: input.bindingKind,
    externalId,
    displayName,
    metadata: input.metadata ?? null,
    createdBy: input.auth.userId,
  });

  return {
    statusCode: 201,
    body: {
      ok: true,
      data: {
        binding: {
          id: binding.id,
          bindingKind: binding.bindingKind,
          externalId: binding.externalId,
          displayName: binding.displayName,
          metadata: binding.metadata,
          createdAt: binding.createdAt,
          createdBy: binding.createdBy,
        },
      },
    },
  };
}

export function deleteTalkResourceRoute(input: {
  auth: AuthContext;
  talkId: string;
  bindingId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<{ deleted: true }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }
  if (!canUserEditTalk(input.talkId, input.auth.userId)) {
    return forbiddenResponse(
      'You do not have permission to remove Talk resources.',
    );
  }

  const deleted = deleteTalkResourceBinding(input.talkId, input.bindingId);
  if (!deleted) {
    return notFoundResponse('Talk resource binding not found.');
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

export function listTalkAuditRoute(input: {
  auth: AuthContext;
  talkId: string;
  limit?: number;
}): {
  statusCode: number;
  body: ApiEnvelope<{ talkId: string; entries: TalkAuditEntryApiRecord[] }>;
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
        entries: listTalkAuditEntries(input.talkId, input.limit ?? 50).map(
          (entry) => ({
            id: entry.id,
            runId: entry.runId,
            agentId: entry.agentId,
            toolName: entry.toolName,
            confirmationId: entry.confirmationId,
            targetResourceId: entry.targetResourceId,
            summary: entry.summary,
            resultStatus: entry.resultStatus,
            errorCategory: entry.errorCategory,
            errorMessage: entry.errorMessage,
            createdAt: entry.createdAt,
            createdBy: entry.createdBy,
          }),
        ),
      },
    },
  };
}

export function approveTalkActionConfirmationRoute(input: {
  auth: AuthContext;
  talkId: string;
  runId: string;
  confirmationId: string;
  modifiedArgs?: JsonMap | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ confirmation: TalkActionConfirmationApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  const confirmation = getTalkActionConfirmationById(input.confirmationId);
  if (
    !confirmation ||
    confirmation.talkId !== input.talkId ||
    confirmation.runId !== input.runId
  ) {
    return notFoundResponse('Talk confirmation not found.');
  }
  if (confirmation.requestedBy !== input.auth.userId) {
    return forbiddenResponse(
      'Only the triggering user may approve this confirmation.',
    );
  }
  if (confirmation.status !== 'pending') {
    return invalidResponse(
      'confirmation_not_pending',
      'This confirmation is no longer pending.',
    );
  }

  const resolved = resolveTalkActionConfirmation({
    confirmationId: input.confirmationId,
    status: 'approved_pending_execution',
    modifiedArgs: input.modifiedArgs ?? null,
    resolvedBy: input.auth.userId,
  });
  if (!resolved) {
    return notFoundResponse('Talk confirmation not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmation: toTalkActionConfirmationApiRecord(resolved),
      },
    },
  };
}

export function rejectTalkActionConfirmationRoute(input: {
  auth: AuthContext;
  talkId: string;
  runId: string;
  confirmationId: string;
  reason?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ confirmation: TalkActionConfirmationApiRecord }>;
} {
  const talk = getTalkForUser(input.talkId, input.auth.userId);
  if (!talk) {
    return notFoundResponse('Talk not found.');
  }

  const confirmation = getTalkActionConfirmationById(input.confirmationId);
  if (
    !confirmation ||
    confirmation.talkId !== input.talkId ||
    confirmation.runId !== input.runId
  ) {
    return notFoundResponse('Talk confirmation not found.');
  }
  if (confirmation.requestedBy !== input.auth.userId) {
    return forbiddenResponse(
      'Only the triggering user may reject this confirmation.',
    );
  }
  if (confirmation.status !== 'pending') {
    return invalidResponse(
      'confirmation_not_pending',
      'This confirmation is no longer pending.',
    );
  }

  const resolved = resolveTalkActionConfirmation({
    confirmationId: input.confirmationId,
    status: 'rejected',
    resolvedBy: input.auth.userId,
    reason: input.reason ?? null,
    errorCategory: 'user_declined',
    errorMessage: input.reason?.trim() || 'User declined this action.',
  });
  if (!resolved) {
    return notFoundResponse('Talk confirmation not found.');
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        confirmation: toTalkActionConfirmationApiRecord(resolved),
      },
    },
  };
}
