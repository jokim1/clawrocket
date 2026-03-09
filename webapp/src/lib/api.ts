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
  connectorKind: 'google_sheets' | 'posthog';
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
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type TalkContext = {
  goal: ContextGoal | null;
  rules: ContextRule[];
  sources: ContextSource[];
};

export type TalkMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type TalkRun = {
  id: string;
  status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  triggerMessageId: string | null;
  targetAgentId: string | null;
  targetAgentNickname: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  executorAlias: string | null;
  executorModel: string | null;
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
    | 'verified'
    | 'invalid'
    | 'unavailable';
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
    | 'unavailable';
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
  executorAuthMode: 'subscription' | 'api_key' | 'advanced_bearer' | 'none';
  activeCredentialConfigured: boolean;
  verificationStatus:
    | 'missing'
    | 'not_verified'
    | 'verifying'
    | 'verified'
    | 'invalid'
    | 'unavailable';
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
  const envelope = await apiRequest<{ user: SessionUser }>('/api/v1/session/me');
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

export async function createTalkFolder(title?: string): Promise<TalkSidebarFolder> {
  const envelope = await apiMutationRequest<{
    folder: { id: string; title: string; sortOrder: number; talks: TalkSidebarTalk[] };
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
    folder: { id: string; title: string; sortOrder: number; talks: TalkSidebarTalk[] };
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
}): Promise<Talk> {
  const envelope = await apiMutationRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}`,
    {
      method: 'PATCH',
      includeJson: true,
      body: JSON.stringify({
        title: input.title,
        folderId: input.folderId,
      }),
    },
  );
  return envelope.talk;
}

export async function deleteTalk(talkId: string): Promise<void> {
  await apiMutationRequest<{ deleted: true }>(`/api/v1/talks/${encodeURIComponent(talkId)}`, {
    method: 'DELETE',
  });
}

export async function reorderTalkSidebar(input: {
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): Promise<void> {
  await apiMutationRequest<{ reordered: true }>('/api/v1/talks/sidebar/reorder', {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify(input),
  });
}

export async function getTalk(talkId: string): Promise<Talk> {
  const envelope = await apiRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
  );
  return envelope.talk;
}

export async function getTalkPolicy(talkId: string): Promise<TalkPolicy> {
  return apiRequest<TalkPolicy>(`/api/v1/talks/${encodeURIComponent(talkId)}/policy`);
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

export async function listTalkMessages(talkId: string): Promise<TalkMessage[]> {
  const envelope = await apiRequest<{
    talkId: string;
    messages: TalkMessage[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/messages`);
  return envelope.messages;
}

export async function deleteTalkMessages(input: {
  talkId: string;
  messageIds: string[];
}): Promise<{ talkId: string; deletedCount: number; deletedMessageIds: string[] }> {
  return apiMutationRequest<{
    talkId: string;
    deletedCount: number;
    deletedMessageIds: string[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/messages/delete`, {
    method: 'POST',
    includeJson: true,
    body: JSON.stringify({
      messageIds: input.messageIds,
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
}): Promise<DataConnector> {
  const envelope = await apiMutationRequest<{ connector: DataConnector }>(
    `/api/v1/data-connectors/${encodeURIComponent(input.connectorId)}/credential`,
    {
      method: 'PUT',
      includeJson: true,
      body: JSON.stringify({
        apiKey: input.apiKey ?? null,
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
}): Promise<{ talkId: string; message: TalkMessage; runs: TalkRun[] }> {
  return apiMutationRequest<{ talkId: string; message: TalkMessage; runs: TalkRun[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/chat`,
    {
      method: 'POST',
      includeJson: true,
      body: JSON.stringify({
        content: input.content,
        targetAgentIds: input.targetAgentIds ?? [],
      }),
    },
  );
}

export async function cancelTalkRuns(
  talkId: string,
): Promise<{ talkId: string; cancelledRuns: number }> {
  return apiMutationRequest<{ talkId: string; cancelledRuns: number }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/chat/cancel`,
    {
      method: 'POST',
    },
  );
}

export async function logout(): Promise<void> {
  await apiMutationRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
  });
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
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

      const payload = (await response.json().catch(() => null)) as
        | ApiEnvelope<unknown>
        | null;
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
