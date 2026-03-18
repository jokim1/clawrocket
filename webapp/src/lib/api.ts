export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
};

export type Talk = {
  id: string;
  ownerId: string;
  title: string;
  projectPath: string | null;
  orchestrationMode: 'ordered' | 'panel';
  agents: string[];
  status: string;
  folderId: string | null;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
};

export type TalkSidebarTalk = {
  type: 'talk';
  id: string;
  title: string;
  status: string;
  sortOrder: number;
};

export type TalkSidebarFolder = {
  type: 'folder';
  id: string;
  title: string;
  sortOrder: number;
  talks: TalkSidebarTalk[];
};

export type TalkSidebarItem = TalkSidebarTalk | TalkSidebarFolder;

export type TalkSidebarTree = {
  items: TalkSidebarItem[];
};

export type DataConnectorVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export type DataConnector = {
  id: string;
  name: string;
  connectorKind: 'google_docs' | 'google_sheets' | 'posthog';
  config: Record<string, unknown> | null;
  discovered: Record<string, unknown> | null;
  enabled: boolean;
  hasCredential: boolean;
  verificationStatus: DataConnectorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  attachedTalkCount: number;
  createdAt: string;
  updatedAt: string;
};

export type TalkDataConnector = DataConnector & {
  attachedAt: string;
  attachedBy: string | null;
};

export type ChannelConnection = {
  id: string;
  platform: 'telegram' | 'slack';
  connectionMode: string;
  accountKey: string;
  displayName: string;
  enabled: boolean;
  healthStatus: 'healthy' | 'degraded' | 'disconnected' | 'error';
  lastHealthCheckAt: string | null;
  lastHealthError: string | null;
  config: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ChannelTarget = {
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
};

export type TalkChannelBinding = {
  id: string;
  talkId: string;
  connectionId: string;
  platform: 'telegram' | 'slack';
  connectionDisplayName: string;
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
  lastIngressReasonCode: string | null;
  lastDeliveryReasonCode: string | null;
};

export type ChannelQueueFailure = {
  id: string;
  bindingId: string;
  talkId: string;
  connectionId?: string;
  targetKind: string;
  targetId: string;
  platformEventId?: string | null;
  externalMessageId?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  runId?: string | null;
  talkMessageId?: string | null;
  payload: Record<string, unknown> | null;
  status: string;
  reasonCode: string | null;
  reasonDetail: string | null;
  dedupeKey: string;
  availableAt: string;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
};

// ---------------------------------------------------------------------------
// Context tab types
// ---------------------------------------------------------------------------

export type ContextGoal = {
  goalText: string;
  updatedAt: string;
};

export type ContextRule = {
  id: string;
  ruleText: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type ContextSource = {
  id: string;
  sourceRef: string;
  sourceType: 'url' | 'file' | 'text';
  title: string;
  note: string | null;
  sourceUrl: string | null;
  status: 'pending' | 'ready' | 'failed';
  extractedTextLength: number | null;
  isTruncated: boolean;
  extractionError: string | null;
  mimeType: string | null;
  lastFetchedAt: string | null;
  fetchStrategy: 'http' | 'browser' | 'managed' | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type TalkContext = {
  goal: ContextGoal | null;
  rules: ContextRule[];
  sources: ContextSource[];
};

export type TalkStateEntry = {
  id: string;
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
};

export type TalkOutputSummary = {
  id: string;
  title: string;
  version: number;
  contentLength: number;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
};

export type TalkOutput = TalkOutputSummary & {
  contentMarkdown: string;
};

export type TalkJobWeekday =
  | 'sun'
  | 'mon'
  | 'tue'
  | 'wed'
  | 'thu'
  | 'fri'
  | 'sat';

export type TalkJobSchedule =
  | {
      kind: 'hourly_interval';
      everyHours: number;
    }
  | {
      kind: 'weekly';
      weekdays: TalkJobWeekday[];
      hour: number;
      minute: number;
    };

export type TalkJobScope = {
  connectorIds: string[];
  channelBindingIds: string[];
  allowWeb: boolean;
};

export type TalkJob = {
  id: string;
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  status: 'active' | 'paused' | 'blocked';
  schedule: TalkJobSchedule;
  timezone: string;
  deliverableKind: 'thread' | 'report';
  reportOutputId: string | null;
  reportOutputTitle: string | null;
  sourceScope: TalkJobScope;
  threadId: string;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextDueAt: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
};

export type TalkJobRunSummary = {
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
  completedAt: string | null;
  triggerMessageId: string | null;
  responseExcerpt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
};

export type TalkThread = {
  id: string;
  talkId: string;
  title: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessageAt: string | null;
};

export type TalkThreadTitleUpdate = {
  id: string;
  talkId: string;
  title: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TalkMessageAttachment = {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  extractionStatus: 'pending' | 'extracted' | 'failed';
};

export type TalkMessage = {
  id: string;
  threadId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
  attachments?: TalkMessageAttachment[];
};

export type TalkMessageSearchResult = {
  messageId: string;
  threadId: string;
  threadTitle: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  preview: string;
};

export type TalkRun = {
  id: string;
  threadId: string;
  responseGroupId: string | null;
  sequenceIndex: number | null;
  status:
    | 'queued'
    | 'running'
    | 'awaiting_confirmation'
    | 'cancelled'
    | 'completed'
    | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  cancelReason: string | null;
  executorAlias: string | null;
  executorModel: string | null;
};

export type TalkRunContextStateEntrySnapshot = {
  key: string;
  value: unknown;
  version: number;
  updatedAt: string;
  reason: 'state_snapshot' | 'retrieved';
};

export type TalkRunContextSourceManifestItem = {
  ref: string;
  title: string;
  sourceType: string;
  sourceUrl: string | null;
  fileName: string | null;
};

export type TalkRunContextInlineSourceSnapshot = {
  ref: string;
  text: string;
};

export type TalkRunContextRetrievedSourceSnapshot = {
  ref: string;
  title: string;
  excerpt: string;
};

export type TalkRunContextOutputManifestItem = {
  id: string;
  title: string;
  version: number;
  updatedAt: string;
  contentLength: number;
};

export type TalkRunContextSnapshot = {
  version: 1;
  threadId: string | null;
  personaRole:
    | 'assistant'
    | 'analyst'
    | 'critic'
    | 'strategist'
    | 'devils-advocate'
    | 'synthesizer'
    | 'editor'
    | null;
  roleHint: string | null;
  goalIncluded: boolean;
  summaryIncluded: boolean;
  activeRules: string[];
  stateSnapshot: {
    totalCount: number;
    omittedCount: number;
    included: TalkRunContextStateEntrySnapshot[];
  };
  sources: {
    totalCount: number;
    manifest: TalkRunContextSourceManifestItem[];
    inline: TalkRunContextInlineSourceSnapshot[];
  };
  outputs: {
    totalCount: number;
    omittedCount: number;
    manifest: TalkRunContextOutputManifestItem[];
  };
  retrieval: {
    query: string | null;
    queryTerms: string[];
    roleTerms: string[];
    state: TalkRunContextStateEntrySnapshot[];
    sources: TalkRunContextRetrievedSourceSnapshot[];
  };
  tools: {
    contextToolNames: string[];
    connectorToolNames: string[];
  };
  history: {
    messageIds: string[];
    turnCount: number;
  };
  estimatedTokens: number;
};

export type ToolRegistryEntry = {
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
  installStatus: 'installed' | 'disabled' | 'unconfigured';
  healthStatus: 'healthy' | 'degraded' | 'unavailable';
  authRequirements: Record<string, unknown> | null;
  mutatesExternalState: boolean;
  requiresBinding: boolean;
  defaultGrant: boolean;
  sortOrder: number;
  updatedAt: string;
  updatedBy: string | null;
};

export type TalkToolGrant = {
  toolId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

export type TalkResourceBinding = {
  id: string;
  kind:
    | 'google_drive_folder'
    | 'google_drive_file'
    | 'data_connector'
    | 'saved_source'
    | 'message_attachment';
  externalId: string;
  displayName: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  createdBy: string | null;
};

export type UserGoogleAccount = {
  connected: boolean;
  email: string | null;
  displayName: string | null;
  scopes: string[];
  accessExpiresAt: string | null;
};

export type GoogleAccountAuthorizationLaunch = {
  authorizationUrl: string;
  expiresInSec: number;
};

export type GooglePickerSession = {
  oauthToken: string;
  developerKey: string;
  appId: string;
};

export type EffectiveToolAccessState =
  | 'available'
  | 'unavailable_due_to_route'
  | 'unavailable_due_to_identity'
  | 'unavailable_due_to_pending_scopes'
  | 'unavailable_due_to_scope'
  | 'unavailable_due_to_config'
  | 'unavailable_due_to_missing_resource';

export type TalkToolAccessByAgent = {
  agentId: string;
  nickname: string;
  sourceKind: 'claude_default' | 'provider';
  providerId: string | null;
  modelId: string | null;
  toolAccess: Array<{
    toolId: string;
    state: EffectiveToolAccessState;
  }>;
};

export type TalkTools = {
  talkId: string;
  registry: ToolRegistryEntry[];
  grants: TalkToolGrant[];
  bindings: TalkResourceBinding[];
  googleAccount: UserGoogleAccount;
  summary: string[];
  warnings: string[];
  effectiveAccess: TalkToolAccessByAgent[];
};

export type TalkAuditEntry = {
  id: string;
  runId: string;
  agentId: string | null;
  toolName: string;
  confirmationId: string | null;
  targetResourceId: string | null;
  summary: Record<string, unknown> | null;
  resultStatus: 'success' | 'failed';
  errorCategory:
    | 'auth'
    | 'permission'
    | 'rate_limit'
    | 'quota'
    | 'validation'
    | 'transient'
    | 'unavailable'
    | 'user_declined'
    | 'revoked_after_confirmation'
    | null;
  errorMessage: string | null;
  createdAt: string;
  createdBy: string | null;
};

export type TalkActionConfirmation = {
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
  proposedArgs: Record<string, unknown> | null;
  modifiedArgs: Record<string, unknown> | null;
  preview: Record<string, unknown> | null;
  toolCallId: string | null;
  requestedBy: string;
  resolvedBy: string | null;
  reason: string | null;
  errorCategory:
    | 'auth'
    | 'permission'
    | 'rate_limit'
    | 'quota'
    | 'validation'
    | 'transient'
    | 'unavailable'
    | 'user_declined'
    | 'revoked_after_confirmation'
    | null;
  errorMessage: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type TalkPolicy = {
  talkId: string;
  agents: string[];
  limits: {
    maxAgents: number;
    maxAgentChars: number;
  };
};

export type TalkAgent = {
  id: string;
  nickname: string;
  nicknameMode: 'auto' | 'custom';
  sourceKind: 'claude_default' | 'provider';
  role:
    | 'assistant'
    | 'analyst'
    | 'critic'
    | 'strategist'
    | 'devils-advocate'
    | 'synthesizer'
    | 'editor';
  isPrimary: boolean;
  displayOrder: number;
  health: 'ready' | 'invalid' | 'unknown';
  providerId: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
};

export type AgentProviderCard = {
  id: string;
  name: string;
  providerKind:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'deepseek'
    | 'kimi'
    | 'nvidia'
    | 'custom';
  apiFormat: 'anthropic_messages' | 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'rate_limited';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  modelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools?: boolean;
  }>;
};

export type AiAgentsPageData = {
  defaultClaudeModelId: string;
  claudeModelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools?: boolean;
  }>;
  additionalProviders: AgentProviderCard[];
};

export type TalkLlmProvider = {
  id: string;
  name: string;
  providerKind:
    | 'anthropic'
    | 'openai'
    | 'gemini'
    | 'deepseek'
    | 'kimi'
    | 'nvidia'
    | 'custom';
  apiFormat: 'anthropic_messages' | 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  enabled: boolean;
  coreCompatibility: 'none' | 'claude_sdk_proxy';
  responseStartTimeoutMs: number | null;
  streamIdleTimeoutMs: number | null;
  absoluteTimeoutMs: number | null;
  hasCredential: boolean;
  models: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    enabled: boolean;
    supportsTools?: boolean;
  }>;
};

export type TalkLlmRoute = {
  id: string;
  name: string;
  enabled: boolean;
  assignedAgentCount: number;
  assignedTalkCount: number;
  steps: Array<{
    position: number;
    providerId: string;
    modelId: string;
  }>;
};

export type TalkLlmSettings = {
  defaultRouteId: string | null;
  providers: TalkLlmProvider[];
  routes: TalkLlmRoute[];
};

export type TalkLlmSettingsUpdate = {
  defaultRouteId: string;
  providers: Array<
    Omit<TalkLlmProvider, 'hasCredential'> & {
      credential?: { apiKey: string; organizationId?: string } | null;
    }
  >;
  routes: Array<Omit<TalkLlmRoute, 'assignedAgentCount' | 'assignedTalkCount'>>;
};

export type SettingsActor = {
  id: string;
  displayName: string;
};

export type ExecutorSettings = {
  configuredAliasMap: Record<string, string>;
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  executorAuthMode: 'subscription' | 'api_key' | 'advanced_bearer' | 'none';
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  apiKeyHint: string | null;
  oauthTokenHint: string | null;
  authTokenHint: string | null;
  activeCredentialConfigured: boolean;
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'rate_limited';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  anthropicBaseUrl: string;
  isConfigured: boolean;
  configVersion: number;
  lastUpdatedAt: string | null;
  lastUpdatedBy: SettingsActor | null;
  configErrors: string[];
};

export type ExecutorSettingsUpdate = {
  executorAuthMode?: 'subscription' | 'api_key' | 'advanced_bearer' | 'none';
  anthropicApiKey?: string | null;
  claudeOauthToken?: string | null;
  anthropicAuthToken?: string | null;
  anthropicBaseUrl?: string | null;
  aliasModelMap?: Record<string, string>;
  defaultAlias?: string;
};

export type ExecutorStatus = {
  mode: 'real' | 'mock';
  restartSupported: boolean;
  pendingRestartReasons: string[];
  activeRunCount: number;
  containerRuntimeAvailability: 'ready' | 'unavailable';
  executorAuthMode: 'subscription' | 'api_key' | 'advanced_bearer' | 'none';
  activeCredentialConfigured: boolean;
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'rate_limited';
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  configVersion: number;
  isConfigured: boolean;
  bootId: string;
  configErrors: string[];
};

export type ExecutorSubscriptionHostStatus = {
  serviceUser: string | null;
  serviceUid: number | null;
  serviceHomePath: string;
  runtimeContext: 'host' | 'systemd' | 'container' | 'unknown';
  claudeCliInstalled: boolean | null;
  hostLoginDetected: boolean;
  serviceEnvOauthPresent: boolean;
  importAvailable: boolean;
  hostCredentialFingerprint: string | null;
  message: string;
  recommendedCommands: string[];
};

export type ExecutorSubscriptionImportResult = {
  status: 'imported' | 'no_change';
  settings: ExecutorSettings;
};

type ApiEnvelope<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export type StartAuthPayload = {
  state: string;
  authorizationUrl: string;
  expiresInSec: number;
};

export type AuthConfigPayload = {
  devMode: boolean;
};

const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';
const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';
let refreshInFlight: Promise<boolean> | null = null;

export async function getAuthConfig(): Promise<AuthConfigPayload> {
  return apiRequest<AuthConfigPayload>('/api/v1/auth/config');
}

export async function getSessionMe(): Promise<SessionUser> {
  const envelope = await apiRequest<{ user: SessionUser }>(
    '/api/v1/session/me',
  );
  return envelope.user;
}

export async function updateSessionMe(input: {
  displayName?: string;
}): Promise<SessionUser> {
  const envelope = await apiMutationRequest<{ user: SessionUser }>(
    '/api/v1/session/me',
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
  return envelope.user;
}

export async function startGoogleAuth(input?: {
  returnTo?: string;
}): Promise<StartAuthPayload> {
  if (input?.returnTo) {
    return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ returnTo: input.returnTo }),
    });
  }

  return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
    method: 'POST',
  });
}

export async function completeDevCallback(callbackUrl: string): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
    },
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Dev callback failed with status ${response.status}`);
  }
}

export async function listTalks(): Promise<Talk[]> {
  const envelope = await apiRequest<{
    talks: Talk[];
    page: { limit: number; offset: number; count: number };
  }>('/api/v1/talks');
  return envelope.talks;
}

export async function createTalk(title: string): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>('/api/v1/talks', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title }),
  });
  return envelope.talk;
}

export async function getTalkSidebar(): Promise<TalkSidebarTree> {
  return apiRequest<TalkSidebarTree>('/api/v1/talks/sidebar');
}

export async function createTalkFolder(
  title?: string,
): Promise<TalkSidebarFolder> {
  const envelope = await apiMutationRequest<{
    folder: {
      id: string;
      title: string;
      sortOrder: number;
      talks: TalkSidebarTalk[];
    };
  }>('/api/v1/talk-folders', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title }),
  });
  return { ...envelope.folder, type: 'folder' };
}

export async function patchTalkFolder(input: {
  folderId: string;
  title: string;
}): Promise<TalkSidebarFolder> {
  const envelope = await apiMutationRequest<{
    folder: {
      id: string;
      title: string;
      sortOrder: number;
      talks: TalkSidebarTalk[];
    };
  }>(`/api/v1/talk-folders/${encodeURIComponent(input.folderId)}`, {
    method: 'PATCH',
    includeJson: true,
    body: JSON.stringify({ title: input.title }),
  });
  return { ...envelope.folder, type: 'folder' };
}

export async function deleteTalkFolder(folderId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talk-folders/${encodeURIComponent(folderId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function patchTalkMetadata(input: {
  talkId: string;
  title?: string;
  folderId?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        title: input.title,
        folderId: input.folderId,
        orchestrationMode: input.orchestrationMode,
      }),
    },
  );
  return envelope.talk;
}

export async function updateTalkProjectMount(input: {
  talkId: string;
  projectPath: string;
}): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/project-mount`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ projectPath: input.projectPath }),
    },
  );
  return envelope.talk;
}

export async function clearTalkProjectMount(talkId: string): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/project-mount`,
    {
      method: 'DELETE',
    },
  );
  return envelope.talk;
}

export async function deleteTalk(talkId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function reorderTalkSidebar(input: {
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<void> {
  await apiMutationRequest<{ reordered: true }>(
    '/api/v1/talks/sidebar/reorder',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
}

export async function getTalk(talkId: string): Promise<Talk> {
  const envelope = await apiRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
  );
  return envelope.talk;
}

export async function getTalkPolicy(talkId: string): Promise<TalkPolicy> {
  return apiRequest<TalkPolicy>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/policy`,
  );
}

export async function updateTalkPolicy(input: {
  talkId: string;
  agents: string[];
}): Promise<TalkPolicy> {
  return apiMutationRequest<TalkPolicy>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/policy`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ agents: input.agents }),
    },
  );
}

export async function listTalkThreads(talkId: string): Promise<TalkThread[]> {
  const envelope = await apiRequest<{
    threads: Array<{
      id: string;
      talk_id: string;
      title: string | null;
      is_default: number;
      created_at: string;
      updated_at: string;
      message_count: number;
      last_message_at: string | null;
    }>;
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/threads`);
  return envelope.threads.map((thread) => ({
    id: thread.id,
    talkId: thread.talk_id,
    title: thread.title,
    isDefault: thread.is_default === 1,
    createdAt: thread.created_at,
    updatedAt: thread.updated_at,
    messageCount: thread.message_count,
    lastMessageAt: thread.last_message_at,
  }));
}

export async function createTalkThread(input: {
  talkId: string;
  title?: string;
}): Promise<TalkThread> {
  const envelope = await apiMutationRequest<{
    thread: {
      id: string;
      talk_id: string;
      title: string | null;
      is_default: number;
      created_at: string;
      updated_at: string;
      message_count?: number;
      last_message_at?: string | null;
    };
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/threads`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({ title: input.title ?? null }),
  });
  if (!envelope.thread || typeof envelope.thread.id !== 'string') {
    throw new Error('Invalid thread response');
  }
  return {
    id: envelope.thread.id,
    talkId: envelope.thread.talk_id,
    title: envelope.thread.title,
    isDefault: envelope.thread.is_default === 1,
    createdAt: envelope.thread.created_at,
    updatedAt: envelope.thread.updated_at,
    messageCount: envelope.thread.message_count ?? 0,
    lastMessageAt: envelope.thread.last_message_at ?? null,
  };
}

export async function updateTalkThreadTitle(input: {
  talkId: string;
  threadId: string;
  title: string;
}): Promise<TalkThreadTitleUpdate> {
  const envelope = await apiMutationRequest<{
    id: string;
    talk_id: string;
    title: string;
    is_default: number;
    created_at: string;
    updated_at: string;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/threads/${encodeURIComponent(input.threadId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({ title: input.title }),
    },
  );
  return {
    id: envelope.id,
    talkId: envelope.talk_id,
    title: envelope.title,
    isDefault: envelope.is_default === 1,
    createdAt: envelope.created_at,
    updatedAt: envelope.updated_at,
  };
}

export async function listTalkMessages(
  talkId: string,
  options?: { threadId?: string | null },
): Promise<TalkMessage[]> {
  const params = new URLSearchParams();
  if (options?.threadId) {
    params.set('threadId', options.threadId);
  }
  const envelope = await apiRequest<{
    talkId: string;
    messages: TalkMessage[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/messages${
      params.size > 0 ? `?${params.toString()}` : ''
    }`,
  );
  return envelope.messages;
}

export async function searchTalkMessages(input: {
  talkId: string;
  query: string;
  limit?: number;
}): Promise<TalkMessageSearchResult[]> {
  const params = new URLSearchParams({ q: input.query });
  if (typeof input.limit === 'number') {
    params.set('limit', String(input.limit));
  }
  const envelope = await apiRequest<{
    talkId: string;
    query: string;
    results: TalkMessageSearchResult[];
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/messages/search?${params.toString()}`,
  );
  return envelope.results;
}

export async function deleteTalkMessages(input: {
  talkId: string;
  messageIds: string[];
  threadId: string;
}): Promise<{
  talkId: string;
  deletedCount: number;
  deletedMessageIds: string[];
}> {
  return apiMutationRequest<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/messages/delete`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      messageIds: input.messageIds,
      threadId: input.threadId,
    }),
  });
}

export async function getTalkAgents(talkId: string): Promise<TalkAgent[]> {
  const envelope = await apiRequest<{
    talkId: string;
    agents: TalkAgent[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/agents`);
  return envelope.agents;
}

export async function getTalkRuns(talkId: string): Promise<TalkRun[]> {
  const envelope = await apiRequest<{
    talkId: string;
    runs: TalkRun[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/runs`);
  return envelope.runs;
}

export async function getTalkRunContext(input: {
  talkId: string;
  runId: string;
}): Promise<TalkRunContextSnapshot | null> {
  const envelope = await apiRequest<{
    talkId: string;
    runId: string;
    contextSnapshot: TalkRunContextSnapshot | null;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/context`,
  );
  return envelope.contextSnapshot;
}

export async function getTalkTools(talkId: string): Promise<TalkTools> {
  return apiRequest<TalkTools>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/tools`,
  );
}

export async function updateTalkTools(input: {
  talkId: string;
  grants: Array<{ toolId: string; enabled: boolean }>;
}): Promise<TalkTools> {
  return apiMutationRequest<TalkTools>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/tools/grants`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ grants: input.grants }),
    },
  );
}

export async function getTalkResources(input: {
  talkId: string;
}): Promise<{ talkId: string; bindings: TalkResourceBinding[] }> {
  return apiRequest<{ talkId: string; bindings: TalkResourceBinding[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources`,
  );
}

export async function createTalkGoogleDriveResource(input: {
  talkId: string;
  kind: 'google_drive_folder' | 'google_drive_file';
  externalId: string;
  displayName: string;
  metadata?: Record<string, unknown> | null;
}): Promise<TalkResourceBinding> {
  const envelope = await apiMutationRequest<{ binding: TalkResourceBinding }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        kind: input.kind,
        externalId: input.externalId,
        displayName: input.displayName,
        metadata: input.metadata ?? null,
      }),
    },
  );
  return envelope.binding;
}

export async function deleteTalkResource(input: {
  talkId: string;
  resourceId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/resources/${encodeURIComponent(input.resourceId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getUserGoogleAccount(): Promise<UserGoogleAccount> {
  const envelope = await apiRequest<{ googleAccount: UserGoogleAccount }>(
    '/api/v1/me/google-account',
  );
  return envelope.googleAccount;
}

export async function connectUserGoogleAccount(input?: {
  returnTo?: string;
  scopes?: string[];
}): Promise<GoogleAccountAuthorizationLaunch> {
  const envelope = await apiMutationRequest<GoogleAccountAuthorizationLaunch>(
    '/api/v1/me/google-account/connect',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        returnTo: input?.returnTo,
        scopes: input?.scopes,
      }),
    },
  );
  return envelope;
}

export async function expandUserGoogleScopes(input: {
  scopes: string[];
  returnTo?: string;
}): Promise<GoogleAccountAuthorizationLaunch> {
  const envelope = await apiMutationRequest<GoogleAccountAuthorizationLaunch>(
    '/api/v1/me/google-account/expand-scopes',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        scopes: input.scopes,
        returnTo: input.returnTo,
      }),
    },
  );
  return envelope;
}

export async function getGooglePickerSession(): Promise<GooglePickerSession> {
  return apiRequest<GooglePickerSession>(
    '/api/v1/me/google-account/picker-token',
  );
}

export async function getTalkAudit(input: {
  talkId: string;
  limit?: number;
}): Promise<{ talkId: string; entries: TalkAuditEntry[] }> {
  const query = input.limit
    ? `?limit=${encodeURIComponent(String(input.limit))}`
    : '';
  return apiRequest<{ talkId: string; entries: TalkAuditEntry[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/audit${query}`,
  );
}

export async function approveTalkActionConfirmation(input: {
  talkId: string;
  runId: string;
  confirmationId: string;
  modifiedArgs?: Record<string, unknown> | null;
}): Promise<TalkActionConfirmation> {
  const envelope = await apiMutationRequest<{
    confirmation: TalkActionConfirmation;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/confirmations/${encodeURIComponent(input.confirmationId)}/approve`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ modifiedArgs: input.modifiedArgs ?? null }),
    },
  );
  return envelope.confirmation;
}

export async function rejectTalkActionConfirmation(input: {
  talkId: string;
  runId: string;
  confirmationId: string;
  reason?: string | null;
}): Promise<TalkActionConfirmation> {
  const envelope = await apiMutationRequest<{
    confirmation: TalkActionConfirmation;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/runs/${encodeURIComponent(input.runId)}/confirmations/${encodeURIComponent(input.confirmationId)}/reject`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ reason: input.reason ?? null }),
    },
  );
  return envelope.confirmation;
}

export async function updateTalkAgents(input: {
  talkId: string;
  agents: TalkAgent[];
}): Promise<TalkAgent[]> {
  const envelope = await apiMutationRequest<{
    talkId: string;
    agents: TalkAgent[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/agents`, {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify({ agents: input.agents }),
  });
  return envelope.agents;
}

export async function getAiAgents(): Promise<AiAgentsPageData> {
  return apiRequest<AiAgentsPageData>('/api/v1/agents');
}

// ---------------------------------------------------------------------------
// Registered Agents
// ---------------------------------------------------------------------------

export type RegisteredAgent = {
  id: string;
  name: string;
  providerId: string;
  modelId: string;
  toolPermissions: Record<string, boolean>;
  personaRole: string | null;
  systemPrompt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  executionPreview: {
    surface: 'main';
    backend: 'direct_http' | 'container' | null;
    authPath: 'api_key' | 'subscription' | null;
    routeReason: 'normal' | 'subscription_fallback' | 'no_valid_path';
    ready: boolean;
    message: string;
  };
};

export async function listRegisteredAgents(): Promise<RegisteredAgent[]> {
  return apiRequest<RegisteredAgent[]>('/api/v1/registered-agents');
}

export async function getRegisteredAgent(
  agentId: string,
): Promise<RegisteredAgent> {
  return apiRequest<RegisteredAgent>(
    `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
  );
}

export async function getMainRegisteredAgent(): Promise<RegisteredAgent> {
  return apiRequest<RegisteredAgent>('/api/v1/registered-agents/main');
}

export async function updateMainRegisteredAgent(
  agentId: string,
): Promise<RegisteredAgent> {
  return apiMutationRequest<RegisteredAgent>('/api/v1/registered-agents/main', {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify({ agentId }),
  });
}

export async function createRegisteredAgent(input: {
  name: string;
  providerId: string;
  modelId: string;
  toolPermissionsJson?: string;
  personaRole?: string;
  systemPrompt?: string;
}): Promise<RegisteredAgent> {
  return apiMutationRequest<RegisteredAgent>('/api/v1/registered-agents', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify(input),
  });
}

export async function updateRegisteredAgent(input: {
  agentId: string;
  name?: string;
  providerId?: string;
  modelId?: string;
  toolPermissionsJson?: string;
  personaRole?: string | null;
  systemPrompt?: string | null;
  enabled?: boolean;
}): Promise<RegisteredAgent> {
  const { agentId, ...body } = input;
  return apiMutationRequest<RegisteredAgent>(
    `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify(body),
    },
  );
}

export async function deleteRegisteredAgent(agentId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/registered-agents/${encodeURIComponent(agentId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getDataConnectors(): Promise<DataConnector[]> {
  const envelope = await apiRequest<{ connectors: DataConnector[] }>(
    '/api/v1/data-connectors',
  );
  return envelope.connectors;
}

export async function createDataConnector(input: {
  name: string;
  connectorKind: DataConnector['connectorKind'];
  config?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<DataConnector> {
  const envelope = await apiMutationRequest<{ connector: DataConnector }>(
    '/api/v1/data-connectors',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
  return envelope.connector;
}

export async function patchDataConnector(input: {
  connectorId: string;
  name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}): Promise<DataConnector> {
  const envelope = await apiMutationRequest<{ connector: DataConnector }>(
    `/api/v1/data-connectors/${encodeURIComponent(input.connectorId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        name: input.name,
        config: input.config,
        enabled: input.enabled,
      }),
    },
  );
  return envelope.connector;
}

export async function deleteDataConnector(connectorId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/data-connectors/${encodeURIComponent(connectorId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function setDataConnectorCredential(input: {
  connectorId: string;
  apiKey?: string | null;
  useGoogleAccount?: boolean;
  clearCredential?: boolean;
}): Promise<DataConnector> {
  const envelope = await apiMutationRequest<{ connector: DataConnector }>(
    `/api/v1/data-connectors/${encodeURIComponent(input.connectorId)}/credential`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({
        apiKey: input.apiKey ?? null,
        useGoogleAccount: input.useGoogleAccount ?? false,
        clearCredential: input.clearCredential ?? false,
      }),
    },
  );
  return envelope.connector;
}

export async function getTalkDataConnectors(
  talkId: string,
): Promise<TalkDataConnector[]> {
  const envelope = await apiRequest<{
    talkId: string;
    connectors: TalkDataConnector[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/data-connectors`);
  return envelope.connectors;
}

export async function attachTalkDataConnector(input: {
  talkId: string;
  connectorId: string;
}): Promise<TalkDataConnector> {
  const envelope = await apiMutationRequest<{ connector: TalkDataConnector }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/data-connectors`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        connectorId: input.connectorId,
      }),
    },
  );
  return envelope.connector;
}

export async function detachTalkDataConnector(input: {
  talkId: string;
  connectorId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/data-connectors/${encodeURIComponent(input.connectorId)}`,
    {
      method: 'DELETE',
    },
  );
}

type ChannelConnectionApiRecord = {
  id: string;
  platform: 'telegram' | 'slack';
  connection_mode: string;
  account_key: string;
  display_name: string;
  enabled: number;
  health_status: 'healthy' | 'degraded' | 'disconnected' | 'error';
  last_health_check_at: string | null;
  last_health_error: string | null;
  config_json: string | null;
  created_at: string;
  updated_at: string;
};

type ChannelTargetApiRecord = {
  connection_id: string;
  target_kind: string;
  target_id: string;
  display_name: string;
  metadata_json: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
};

type ChannelQueueFailureApiRecord = {
  id: string;
  binding_id: string;
  talk_id: string;
  connection_id?: string;
  target_kind: string;
  target_id: string;
  platform_event_id?: string | null;
  external_message_id?: string | null;
  sender_id?: string | null;
  sender_name?: string | null;
  run_id?: string | null;
  talk_message_id?: string | null;
  payload_json: string | null;
  status: string;
  reason_code: string | null;
  reason_detail: string | null;
  dedupe_key: string;
  available_at: string;
  created_at: string;
  updated_at: string;
  attempt_count: number;
};

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapChannelConnection(
  record: ChannelConnectionApiRecord,
): ChannelConnection {
  return {
    id: record.id,
    platform: record.platform,
    connectionMode: record.connection_mode,
    accountKey: record.account_key,
    displayName: record.display_name,
    enabled: record.enabled === 1,
    healthStatus: record.health_status,
    lastHealthCheckAt: record.last_health_check_at,
    lastHealthError: record.last_health_error,
    config: parseJsonObject(record.config_json),
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapChannelTarget(record: ChannelTargetApiRecord): ChannelTarget {
  return {
    connectionId: record.connection_id,
    targetKind: record.target_kind,
    targetId: record.target_id,
    displayName: record.display_name,
    metadata: parseJsonObject(record.metadata_json),
    lastSeenAt: record.last_seen_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function mapChannelQueueFailure(
  record: ChannelQueueFailureApiRecord,
): ChannelQueueFailure {
  return {
    id: record.id,
    bindingId: record.binding_id,
    talkId: record.talk_id,
    connectionId: record.connection_id,
    targetKind: record.target_kind,
    targetId: record.target_id,
    platformEventId: record.platform_event_id,
    externalMessageId: record.external_message_id,
    senderId: record.sender_id,
    senderName: record.sender_name,
    runId: record.run_id,
    talkMessageId: record.talk_message_id,
    payload: parseJsonObject(record.payload_json),
    status: record.status,
    reasonCode: record.reason_code,
    reasonDetail: record.reason_detail,
    dedupeKey: record.dedupe_key,
    availableAt: record.available_at,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    attemptCount: record.attempt_count,
  };
}

export async function listChannelConnections(): Promise<ChannelConnection[]> {
  const envelope = await apiRequest<{
    connections: ChannelConnectionApiRecord[];
  }>('/api/v1/channel-connections');
  return envelope.connections.map(mapChannelConnection);
}

export async function listChannelTargets(input: {
  connectionId: string;
  query?: string;
  limit?: number;
}): Promise<ChannelTarget[]> {
  const params = new URLSearchParams();
  if (input.query?.trim()) {
    params.set('query', input.query.trim());
  }
  if (typeof input.limit === 'number') {
    params.set('limit', String(input.limit));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const envelope = await apiRequest<{
    targets: ChannelTargetApiRecord[];
  }>(
    `/api/v1/channel-connections/${encodeURIComponent(input.connectionId)}/targets${suffix}`,
  );
  return envelope.targets.map(mapChannelTarget);
}

export async function listTalkChannels(
  talkId: string,
): Promise<TalkChannelBinding[]> {
  const envelope = await apiRequest<{
    talkId: string;
    bindings: TalkChannelBinding[];
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/channels`);
  return envelope.bindings;
}

export async function createTalkChannel(input: {
  talkId: string;
  connectionId: string;
  targetKind: string;
  targetId: string;
  displayName: string;
  responseMode?: TalkChannelBinding['responseMode'];
  responderMode?: TalkChannelBinding['responderMode'];
  responderAgentId?: string | null;
  deliveryMode?: TalkChannelBinding['deliveryMode'];
  channelContextNote?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes?: number;
}): Promise<TalkChannelBinding> {
  const envelope = await apiMutationRequest<{ binding: TalkChannelBinding }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
  return envelope.binding;
}

export async function patchTalkChannel(input: {
  talkId: string;
  bindingId: string;
  active?: boolean;
  displayName?: string;
  responseMode?: TalkChannelBinding['responseMode'];
  responderMode?: TalkChannelBinding['responderMode'];
  responderAgentId?: string | null;
  deliveryMode?: TalkChannelBinding['deliveryMode'];
  channelContextNote?: string | null;
  inboundRateLimitPerMinute?: number;
  maxPendingEvents?: number;
  overflowPolicy?: TalkChannelBinding['overflowPolicy'];
  maxDeferredAgeMinutes?: number;
}): Promise<TalkChannelBinding> {
  const { talkId, bindingId, ...patch } = input;
  const envelope = await apiMutationRequest<{ binding: TalkChannelBinding }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/channels/${encodeURIComponent(bindingId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.binding;
}

export async function deleteTalkChannel(input: {
  talkId: string;
  bindingId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function testTalkChannelBinding(input: {
  talkId: string;
  bindingId: string;
}): Promise<void> {
  await apiMutationRequest<{ sent: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/test`,
    {
      method: 'POST',
    },
  );
}

export async function listTalkChannelIngressFailures(input: {
  talkId: string;
  bindingId: string;
}): Promise<ChannelQueueFailure[]> {
  const envelope = await apiRequest<{
    failures: ChannelQueueFailureApiRecord[];
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/ingress-failures`,
  );
  return envelope.failures.map(mapChannelQueueFailure);
}

export async function retryTalkChannelIngressFailure(input: {
  talkId: string;
  bindingId: string;
  rowId: string;
}): Promise<void> {
  await apiMutationRequest<{ retried: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/ingress-failures/${encodeURIComponent(input.rowId)}/retry`,
    {
      method: 'POST',
    },
  );
}

export async function deleteTalkChannelIngressFailure(input: {
  talkId: string;
  bindingId: string;
  rowId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/ingress-failures/${encodeURIComponent(input.rowId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function listTalkChannelDeliveryFailures(input: {
  talkId: string;
  bindingId: string;
}): Promise<ChannelQueueFailure[]> {
  const envelope = await apiRequest<{
    failures: ChannelQueueFailureApiRecord[];
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/delivery-failures`,
  );
  return envelope.failures.map(mapChannelQueueFailure);
}

export async function retryTalkChannelDeliveryFailure(input: {
  talkId: string;
  bindingId: string;
  rowId: string;
}): Promise<void> {
  await apiMutationRequest<{ retried: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/delivery-failures/${encodeURIComponent(input.rowId)}/retry`,
    {
      method: 'POST',
    },
  );
}

export async function deleteTalkChannelDeliveryFailure(input: {
  talkId: string;
  bindingId: string;
  rowId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/channels/${encodeURIComponent(input.bindingId)}/delivery-failures/${encodeURIComponent(input.rowId)}`,
    {
      method: 'DELETE',
    },
  );
}

// ---------------------------------------------------------------------------
// Context tab API functions
// ---------------------------------------------------------------------------

export async function getTalkContext(talkId: string): Promise<TalkContext> {
  return apiRequest<TalkContext>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context`,
  );
}

export async function setTalkGoal(input: {
  talkId: string;
  goalText: string;
}): Promise<{ goal: ContextGoal | null }> {
  return apiMutationRequest<{ goal: ContextGoal | null }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/goal`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({ goalText: input.goalText }),
    },
  );
}

export async function createTalkContextRule(input: {
  talkId: string;
  ruleText: string;
}): Promise<ContextRule> {
  const envelope = await apiMutationRequest<{ rule: ContextRule }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/rules`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({ ruleText: input.ruleText }),
    },
  );
  return envelope.rule;
}

export async function patchTalkContextRule(input: {
  talkId: string;
  ruleId: string;
  ruleText?: string;
  isActive?: boolean;
  sortOrder?: number;
}): Promise<ContextRule> {
  const { talkId, ruleId, ...patch } = input;
  const envelope = await apiMutationRequest<{ rule: ContextRule }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context/rules/${encodeURIComponent(ruleId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.rule;
}

export async function deleteTalkContextRule(input: {
  talkId: string;
  ruleId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/rules/${encodeURIComponent(input.ruleId)}`,
    { method: 'DELETE' },
  );
}

export async function getTalkState(talkId: string): Promise<TalkStateEntry[]> {
  const envelope = await apiRequest<{ entries: TalkStateEntry[] }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/state`,
  );
  return envelope.entries;
}

export async function listTalkOutputs(
  talkId: string,
): Promise<TalkOutputSummary[]> {
  const envelope = await apiRequest<{ outputs: TalkOutputSummary[] }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/outputs`,
  );
  return envelope.outputs;
}

export async function getTalkOutput(input: {
  talkId: string;
  outputId: string;
}): Promise<TalkOutput> {
  const envelope = await apiRequest<{ output: TalkOutput }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/outputs/${encodeURIComponent(input.outputId)}`,
  );
  return envelope.output;
}

export async function createTalkOutput(input: {
  talkId: string;
  title: string;
  contentMarkdown: string;
}): Promise<TalkOutput> {
  const envelope = await apiMutationRequest<{ output: TalkOutput }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/outputs`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        title: input.title,
        contentMarkdown: input.contentMarkdown,
      }),
    },
  );
  return envelope.output;
}

export async function patchTalkOutput(input: {
  talkId: string;
  outputId: string;
  expectedVersion: number;
  title?: string;
  contentMarkdown?: string;
}): Promise<TalkOutput> {
  const { talkId, outputId, ...patch } = input;
  const envelope = await apiMutationRequest<{ output: TalkOutput }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/outputs/${encodeURIComponent(outputId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.output;
}

export async function deleteTalkOutput(input: {
  talkId: string;
  outputId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/outputs/${encodeURIComponent(input.outputId)}`,
    { method: 'DELETE' },
  );
}

export async function listTalkJobs(talkId: string): Promise<TalkJob[]> {
  const envelope = await apiRequest<{ jobs: TalkJob[] }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/jobs`,
  );
  return envelope.jobs;
}

export async function getTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}`,
  );
  return envelope.job;
}

export async function listTalkJobRuns(input: {
  talkId: string;
  jobId: string;
  limit?: number;
}): Promise<TalkJobRunSummary[]> {
  const params = new URLSearchParams();
  if (typeof input.limit === 'number' && input.limit > 0) {
    params.set('limit', String(Math.floor(input.limit)));
  }
  const query = params.toString();
  const envelope = await apiRequest<{ runs: TalkJobRunSummary[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/runs${query ? `?${query}` : ''}`,
  );
  return envelope.runs;
}

export async function createTalkJob(input: {
  talkId: string;
  title: string;
  prompt: string;
  targetAgentId: string;
  schedule: TalkJobSchedule;
  timezone: string;
  deliverableKind: 'thread' | 'report';
  reportOutputId?: string | null;
  createReport?: { title: string; contentMarkdown?: string } | null;
  sourceScope: TalkJobScope;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
  return envelope.job;
}

export async function patchTalkJob(input: {
  talkId: string;
  jobId: string;
  title?: string;
  prompt?: string;
  targetAgentId?: string;
  schedule?: TalkJobSchedule;
  timezone?: string;
  deliverableKind?: 'thread' | 'report';
  reportOutputId?: string | null;
  createReport?: { title: string; contentMarkdown?: string } | null;
  sourceScope?: TalkJobScope;
}): Promise<TalkJob> {
  const { talkId, jobId, ...patch } = input;
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.job;
}

export async function deleteTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}`,
    { method: 'DELETE' },
  );
}

export async function pauseTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/pause`,
    { method: 'POST' },
  );
  return envelope.job;
}

export async function resumeTalkJob(input: {
  talkId: string;
  jobId: string;
}): Promise<TalkJob> {
  const envelope = await apiMutationRequest<{ job: TalkJob }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/resume`,
    { method: 'POST' },
  );
  return envelope.job;
}

export async function runTalkJobNow(input: {
  talkId: string;
  jobId: string;
}): Promise<{ job: TalkJob; runId: string; triggerMessageId: string }> {
  return apiMutationRequest<{
    job: TalkJob;
    runId: string;
    triggerMessageId: string;
  }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/jobs/${encodeURIComponent(input.jobId)}/run-now`,
    { method: 'POST' },
  );
}

export async function createTalkContextSource(input: {
  talkId: string;
  sourceType: 'url' | 'file' | 'text';
  title: string;
  note?: string | null;
  sourceUrl?: string | null;
  extractedText?: string | null;
}): Promise<ContextSource> {
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        sourceType: input.sourceType,
        title: input.title,
        note: input.note,
        sourceUrl: input.sourceUrl,
        extractedText: input.extractedText,
      }),
    },
  );
  return envelope.source;
}

export async function patchTalkContextSource(input: {
  talkId: string;
  sourceId: string;
  title?: string;
  note?: string | null;
  sortOrder?: number;
  extractedText?: string | null;
}): Promise<ContextSource> {
  const { talkId, sourceId, ...patch } = input;
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/context/sources/${encodeURIComponent(sourceId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify(patch),
    },
  );
  return envelope.source;
}

export async function deleteTalkContextSource(input: {
  talkId: string;
  sourceId: string;
}): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources/${encodeURIComponent(input.sourceId)}`,
    { method: 'DELETE' },
  );
}

export async function retryTalkContextSource(input: {
  talkId: string;
  sourceId: string;
}): Promise<ContextSource> {
  const envelope = await apiMutationRequest<{ source: ContextSource }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/context/sources/${encodeURIComponent(input.sourceId)}/retry`,
    {
      method: 'POST',
    },
  );
  return envelope.source;
}

export async function updateDefaultClaudeModel(
  modelId: string,
): Promise<AiAgentsPageData> {
  return apiMutationRequest<AiAgentsPageData>('/api/v1/agents/default-claude', {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify({ modelId }),
  });
}

export async function saveAiProviderCredential(input: {
  providerId: string;
  apiKey?: string | null;
  organizationId?: string | null;
  baseUrl?: string | null;
  authScheme?: 'x_api_key' | 'bearer';
}): Promise<AgentProviderCard> {
  const envelope = await apiMutationRequest<{ provider: AgentProviderCard }>(
    `/api/v1/agents/providers/${encodeURIComponent(input.providerId)}`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify(input),
    },
  );
  return envelope.provider;
}

export async function verifyAiProviderCredential(
  providerId: string,
): Promise<AgentProviderCard> {
  const envelope = await apiMutationRequest<{ provider: AgentProviderCard }>(
    `/api/v1/agents/providers/${encodeURIComponent(providerId)}/verify`,
    {
      method: 'POST',
    },
  );
  return envelope.provider;
}

export async function getTalkLlmSettings(): Promise<TalkLlmSettings> {
  return apiRequest<TalkLlmSettings>('/api/v1/settings/talk-llm');
}

export async function updateTalkLlmSettings(
  update: TalkLlmSettingsUpdate,
): Promise<TalkLlmSettings> {
  return apiMutationRequest<TalkLlmSettings>('/api/v1/settings/talk-llm', {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify(update),
  });
}

export async function getExecutorSettings(): Promise<ExecutorSettings> {
  return apiRequest<ExecutorSettings>('/api/v1/settings/executor');
}

export async function updateExecutorSettings(
  update: ExecutorSettingsUpdate,
): Promise<ExecutorSettings> {
  return apiMutationRequest<ExecutorSettings>('/api/v1/settings/executor', {
    method: 'PUT',
    includeJson: true,
    body: JSON.stringify(update),
  });
}

export async function getExecutorStatus(): Promise<ExecutorStatus> {
  return apiRequest<ExecutorStatus>('/api/v1/settings/executor-status');
}

export async function verifyExecutorCredentials(): Promise<{
  scheduled: boolean;
  code: string;
  message: string;
}> {
  return apiMutationRequest<{
    scheduled: boolean;
    code: string;
    message: string;
  }>('/api/v1/settings/executor/verify', {
    method: 'POST',
  });
}

export async function getExecutorSubscriptionHostStatus(): Promise<ExecutorSubscriptionHostStatus> {
  return apiRequest<ExecutorSubscriptionHostStatus>(
    '/api/v1/settings/executor/subscription-host-status',
  );
}

export async function importExecutorSubscriptionFromHost(
  expectedFingerprint: string,
): Promise<ExecutorSubscriptionImportResult> {
  return apiMutationRequest<ExecutorSubscriptionImportResult>(
    '/api/v1/settings/executor/subscription/import',
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        expectedFingerprint,
      }),
    },
  );
}

export async function restartService(): Promise<{
  status: string;
  activeRunCount: number;
}> {
  return apiMutationRequest<{ status: string; activeRunCount: number }>(
    '/api/v1/settings/restart',
    {
      method: 'POST',
    },
  );
}

// ---------------------------------------------------------------------------
// Main Channel (Nanoclaw)
// ---------------------------------------------------------------------------

export type MainThreadSummary = {
  threadId: string;
  title: string | null;
  lastMessageAt: string;
  messageCount: number;
};

export type MainThreadMessage = {
  id: string;
  threadId: string;
  role: string;
  content: string;
  agentId: string | null;
  createdBy: string | null;
  createdAt: string;
};

export async function listMainThreads(): Promise<MainThreadSummary[]> {
  return apiRequest<MainThreadSummary[]>('/api/v1/main/threads');
}

export async function getMainThread(
  threadId: string,
): Promise<MainThreadMessage[]> {
  return apiRequest<MainThreadMessage[]>(
    `/api/v1/main/threads/${encodeURIComponent(threadId)}`,
  );
}

export async function postMainMessage(input: {
  content: string;
  threadId?: string;
}): Promise<{
  messageId: string;
  threadId: string;
  runId: string;
  title: string | null;
}> {
  return apiMutationRequest<{
    messageId: string;
    threadId: string;
    runId: string;
    title: string | null;
  }>('/api/v1/main/messages', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      content: input.content,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    }),
  });
}

export async function updateMainThreadTitle(input: {
  threadId: string;
  title: string;
}): Promise<{ threadId: string; title: string }> {
  return apiMutationRequest<{ threadId: string; title: string }>(
    `/api/v1/main/threads/${encodeURIComponent(input.threadId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({ title: input.title }),
    },
  );
}

export async function getHealthStatus(): Promise<boolean> {
  try {
    const response = await fetch('/api/v1/health', {
      method: 'GET',
      credentials: 'include',
      headers: {
        accept: 'application/json',
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTalkMessage(input: {
  talkId: string;
  content: string;
  targetAgentIds?: string[];
  attachmentIds?: string[];
  threadId?: string | null;
}): Promise<{ talkId: string; message: TalkMessage; runs: TalkRun[] }> {
  return apiMutationRequest<{
    talkId: string;
    message: TalkMessage;
    runs: TalkRun[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/chat`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      content: input.content,
      targetAgentIds: input.targetAgentIds ?? [],
      attachmentIds: input.attachmentIds ?? [],
      threadId: input.threadId ?? null,
    }),
  });
}

export async function uploadTalkAttachment(
  talkId: string,
  file: File,
): Promise<{ attachment: TalkMessageAttachment }> {
  const formData = new FormData();
  formData.append('file', file);
  return apiMutationRequest<{ attachment: TalkMessageAttachment }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/attachments`,
    {
      method: 'POST',
      body: formData,
      // Do NOT set includeJson — this is multipart, not JSON
    },
  );
}

export async function deleteTalkAttachment(
  talkId: string,
  attachmentId: string,
): Promise<void> {
  await apiMutationRequest<{ ok: boolean }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
}

export async function cancelTalkRuns(
  talkId: string,
  threadId?: string | null,
): Promise<{ talkId: string; cancelledRuns: number }> {
  return apiMutationRequest<{ talkId: string; cancelledRuns: number }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/chat/cancel`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify(threadId ? { threadId } : {}),
    },
  );
}

export async function logout(): Promise<void> {
  await apiMutationRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
  });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return apiRequestWithRefresh<T>(path, init, true);
}

type MutationRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: HeadersInit;
  includeJson?: boolean;
};

type MutationRetryState = {
  allowAuthRetry: boolean;
  allowCsrfRetry: boolean;
  idempotencyKey: string;
};

async function apiMutationRequest<T>(
  path: string,
  init?: MutationRequestInit,
): Promise<T> {
  return apiMutationRequestWithRefresh<T>(path, init, {
    allowAuthRetry: true,
    allowCsrfRetry: true,
    idempotencyKey: buildIdempotencyKey(),
  });
}

async function apiRequestWithRefresh<T>(
  path: string,
  init: RequestInit | undefined,
  allowRefreshRetry: boolean,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    if (allowRefreshRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiRequestWithRefresh<T>(path, init, false);
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

async function apiMutationRequestWithRefresh<T>(
  path: string,
  init: MutationRequestInit | undefined,
  retryState: MutationRetryState,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: buildMutationAttemptHeaders({
      includeJson: init?.includeJson === true,
      explicitHeaders: init?.headers,
      idempotencyKey: retryState.idempotencyKey,
    }),
  });

  if (response.status === 401) {
    if (retryState.allowAuthRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiMutationRequestWithRefresh<T>(path, init, {
          ...retryState,
          allowAuthRetry: false,
        });
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;

  if (
    response.status === 403 &&
    !payload.ok &&
    payload.error?.code === 'csrf_failed' &&
    retryState.allowCsrfRetry &&
    !shouldSkipRefresh(path)
  ) {
    const refreshed = await ensureRefreshedSession();
    if (refreshed) {
      return apiMutationRequestWithRefresh<T>(path, init, {
        ...retryState,
        allowAuthRetry: false,
        allowCsrfRetry: false,
      });
    }
  }

  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

function shouldSkipRefresh(path: string): boolean {
  const normalizedPath = path.split('?')[0];
  // Logout intentionally skips refresh-based recovery so we never revive the
  // same session the user is actively trying to end.
  return (
    normalizedPath === AUTH_REFRESH_PATH || normalizedPath === AUTH_LOGOUT_PATH
  );
}

async function ensureRefreshedSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(AUTH_REFRESH_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
        },
      });
      if (response.status === 401 || !response.ok) return false;

      const payload = (await response
        .json()
        .catch(() => null)) as ApiEnvelope<unknown> | null;
      return Boolean(payload?.ok);
    } catch {
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function buildMutationAttemptHeaders(input: {
  includeJson: boolean;
  explicitHeaders?: HeadersInit;
  idempotencyKey: string;
}): HeadersInit {
  const headers = new Headers();
  headers.set('accept', 'application/json');

  if (input.explicitHeaders) {
    const explicitHeaders = new Headers(input.explicitHeaders);
    explicitHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (input.includeJson && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  // Caller headers may supply generic metadata, but CSRF and idempotency are
  // always owned by this wrapper and written last from current cookie state.
  const csrfToken = getCsrfTokenFromCookie();
  if (csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  } else {
    headers.delete('x-csrf-token');
  }

  headers.set('idempotency-key', input.idempotencyKey);
  return headers;
}

function getCsrfTokenFromCookie(): string | null {
  if (!globalThis.document?.cookie) return null;
  const tokenPair = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('cr_csrf_token='));
  if (!tokenPair) return null;

  const [, value = ''] = tokenPair.split('=', 2);
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
