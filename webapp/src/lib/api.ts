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
};

export type Talk = {
  id: string;
  ownerId: string;
  title: string;
  agents: string[];
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
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
  }>;
};

export type AiAgentsPageData = {
  defaultClaudeModelId: string;
  claudeModelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
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
  const envelope = await apiRequest<{ talk: Talk }>('/api/v1/talks', {
    method: 'POST',
    headers: buildMutationHeaders({ includeJson: true }),
    body: JSON.stringify({ title }),
  });
  return envelope.talk;
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
  return apiRequest<TalkPolicy>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/policy`,
    {
      method: 'PUT',
      headers: buildMutationHeaders({ includeJson: true }),
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
  const envelope = await apiRequest<{
    talkId: string;
    agents: TalkAgent[];
  }>(`/api/v1/talks/${encodeURIComponent(input.talkId)}/agents`, {
    method: 'PUT',
    headers: buildMutationHeaders({ includeJson: true }),
    body: JSON.stringify({ agents: input.agents }),
  });
  return envelope.agents;
}

export async function getAiAgents(): Promise<AiAgentsPageData> {
  return apiRequest<AiAgentsPageData>('/api/v1/agents');
}

export async function updateDefaultClaudeModel(
  modelId: string,
): Promise<AiAgentsPageData> {
  return apiRequest<AiAgentsPageData>('/api/v1/agents/default-claude', {
    method: 'PUT',
    headers: buildMutationHeaders({ includeJson: true }),
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
  const envelope = await apiRequest<{ provider: AgentProviderCard }>(
    `/api/v1/agents/providers/${encodeURIComponent(input.providerId)}`,
    {
      method: 'PUT',
      headers: buildMutationHeaders({ includeJson: true }),
      body: JSON.stringify(input),
    },
  );
  return envelope.provider;
}

export async function verifyAiProviderCredential(
  providerId: string,
): Promise<AgentProviderCard> {
  const envelope = await apiRequest<{ provider: AgentProviderCard }>(
    `/api/v1/agents/providers/${encodeURIComponent(providerId)}/verify`,
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: false }),
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
  return apiRequest<TalkLlmSettings>('/api/v1/settings/talk-llm', {
    method: 'PUT',
    headers: buildMutationHeaders({ includeJson: true }),
    body: JSON.stringify(update),
  });
}

export async function getExecutorSettings(): Promise<ExecutorSettings> {
  return apiRequest<ExecutorSettings>('/api/v1/settings/executor');
}

export async function updateExecutorSettings(
  update: ExecutorSettingsUpdate,
): Promise<ExecutorSettings> {
  return apiRequest<ExecutorSettings>('/api/v1/settings/executor', {
    method: 'PUT',
    headers: buildMutationHeaders({ includeJson: true }),
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
  return apiRequest<{
    scheduled: boolean;
    code: string;
    message: string;
  }>('/api/v1/settings/executor/verify', {
    method: 'POST',
    headers: buildMutationHeaders({ includeJson: false }),
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
  return apiRequest<ExecutorSubscriptionImportResult>(
    '/api/v1/settings/executor/subscription/import',
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: true }),
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
  return apiRequest<{ status: string; activeRunCount: number }>(
    '/api/v1/settings/restart',
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: false }),
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
  return apiRequest<{ talkId: string; message: TalkMessage; runs: TalkRun[] }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/chat`,
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: true }),
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
  return apiRequest<{ talkId: string; cancelledRuns: number }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/chat/cancel`,
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: false }),
    },
  );
}

export async function logout(): Promise<void> {
  await apiRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
    headers: buildMutationHeaders({ includeJson: false }),
  });
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequestWithRefresh<T>(path, init, true);
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

function shouldSkipRefresh(path: string): boolean {
  const normalizedPath = path.split('?')[0];
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

function buildMutationHeaders(input: { includeJson: boolean }): HeadersInit {
  const headers: Record<string, string> = {
    'x-csrf-token': getCsrfTokenFromCookie() || '',
    'idempotency-key': buildIdempotencyKey(),
  };
  if (input.includeJson) {
    headers['content-type'] = 'application/json';
  }
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
