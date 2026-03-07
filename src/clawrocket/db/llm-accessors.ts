import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../llm/provider-secret-store.js';
import type {
  LlmApiFormat,
  LlmAttemptRecord,
  LlmAttemptStatus,
  LlmAuthScheme,
  LlmCoreCompatibility,
  LlmFailureClass,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmProviderRecord,
  LlmProviderSecretRecord,
  LlmProviderVerificationRecord,
  LlmProviderVerificationStatus,
  ProviderSecretPayload,
  RegisteredAgentRecord,
  TalkAgentRecord,
  TalkPersonaRole,
  TalkRouteRecord,
  TalkRouteStepRecord,
  TalkRouteUsageCounts,
} from '../llm/types.js';

const TALK_DEFAULT_ROUTE_KEY = 'talkLlm.defaultRouteId';
const DEFAULT_REGISTERED_AGENT_KEY = 'agents.defaultRegisteredAgentId';
const BUILTIN_MOCK_PROVIDER_ID = 'builtin.mock';
const BUILTIN_MOCK_ROUTE_ID = 'route.default.mock';

export interface LlmProviderSnapshot {
  id: string;
  name: string;
  providerKind: LlmProviderKind;
  apiFormat: LlmApiFormat;
  baseUrl: string;
  authScheme: LlmAuthScheme;
  enabled: boolean;
  coreCompatibility: LlmCoreCompatibility;
  responseStartTimeoutMs?: number | null;
  streamIdleTimeoutMs?: number | null;
  absoluteTimeoutMs?: number | null;
  hasCredential: boolean;
  models: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    enabled: boolean;
  }>;
}

export interface TalkRouteSnapshot {
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
}

export interface TalkLlmSettingsSnapshot {
  defaultRouteId: string | null;
  providers: LlmProviderSnapshot[];
  routes: TalkRouteSnapshot[];
}

export interface TalkAgentInput {
  id?: string;
  name: string;
  personaRole: TalkPersonaRole;
  routeId: string;
  registeredAgentId?: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface ProviderModelSuggestion {
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  defaultMaxOutputTokens: number;
}

export interface AgentProviderCardSnapshot {
  id: string;
  name: string;
  providerKind: LlmProviderKind;
  apiFormat: LlmApiFormat;
  baseUrl: string;
  authScheme: LlmAuthScheme;
  enabled: boolean;
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: LlmProviderVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  modelSuggestions: ProviderModelSuggestion[];
}

export interface RegisteredAgentSnapshot {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  providerKind: LlmProviderKind;
  modelId: string;
  modelDisplayName: string;
  routeId: string;
  enabled: boolean;
  usageCount: number;
}

export interface TalkAgentInstanceSnapshot {
  id: string;
  registeredAgentId: string | null;
  name: string;
  role: TalkPersonaRole;
  isLead: boolean;
  displayOrder: number;
  status: 'active' | 'archived' | 'legacy';
  providerId: string | null;
  providerName: string | null;
  modelId: string | null;
  modelDisplayName: string | null;
}

export interface TalkAgentInstanceInput {
  id?: string;
  registeredAgentId?: string | null;
  role: TalkPersonaRole;
  isLead: boolean;
  displayOrder: number;
}

export interface ResolvedTalkRouteStep {
  routeStep: TalkRouteStepRecord;
  provider: LlmProviderRecord;
  model: LlmProviderModelRecord;
  hasCredential: boolean;
  talkUsable: boolean;
}

export interface ResolvedTalkAgent {
  agent: TalkAgentRecord;
  route: TalkRouteRecord;
  steps: ResolvedTalkRouteStep[];
}

const KNOWN_PROVIDER_CATALOG: Array<{
  id: string;
  name: string;
  providerKind: LlmProviderKind;
  apiFormat: LlmApiFormat;
  authScheme: LlmAuthScheme;
  baseUrl: string;
  modelSuggestions: ProviderModelSuggestion[];
}> = [
  {
    id: 'provider.anthropic',
    name: 'Anthropic',
    providerKind: 'anthropic',
    apiFormat: 'anthropic_messages',
    authScheme: 'x_api_key',
    baseUrl: 'https://api.anthropic.com',
    modelSuggestions: [
      {
        modelId: 'claude-opus-4-1',
        displayName: 'Claude Opus 4.1',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-sonnet-4-5',
        displayName: 'Claude Sonnet 4.5',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'claude-haiku-4-5',
        displayName: 'Claude Haiku 4.5',
        contextWindowTokens: 200000,
        defaultMaxOutputTokens: 4096,
      },
    ],
  },
  {
    id: 'provider.openai',
    name: 'OpenAI',
    providerKind: 'openai',
    apiFormat: 'openai_chat_completions',
    authScheme: 'bearer',
    baseUrl: 'https://api.openai.com/v1',
    modelSuggestions: [
      {
        modelId: 'gpt-5-mini',
        displayName: 'GPT-5 Mini',
        contextWindowTokens: 128000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'gpt-4.1',
        displayName: 'GPT-4.1',
        contextWindowTokens: 128000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'gpt-4o-mini',
        displayName: 'GPT-4o Mini',
        contextWindowTokens: 128000,
        defaultMaxOutputTokens: 4096,
      },
    ],
  },
  {
    id: 'provider.gemini',
    name: 'Google / Gemini',
    providerKind: 'gemini',
    apiFormat: 'openai_chat_completions',
    authScheme: 'bearer',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelSuggestions: [
      {
        modelId: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        contextWindowTokens: 1048576,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        contextWindowTokens: 1048576,
        defaultMaxOutputTokens: 4096,
      },
    ],
  },
  {
    id: 'provider.deepseek',
    name: 'DeepSeek',
    providerKind: 'deepseek',
    apiFormat: 'openai_chat_completions',
    authScheme: 'bearer',
    baseUrl: 'https://api.deepseek.com',
    modelSuggestions: [
      {
        modelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        contextWindowTokens: 128000,
        defaultMaxOutputTokens: 4096,
      },
      {
        modelId: 'deepseek-reasoner',
        displayName: 'DeepSeek Reasoner',
        contextWindowTokens: 128000,
        defaultMaxOutputTokens: 4096,
      },
    ],
  },
  {
    id: 'provider.kimi',
    name: 'Kimi',
    providerKind: 'kimi',
    apiFormat: 'openai_chat_completions',
    authScheme: 'bearer',
    baseUrl: 'https://api.moonshot.cn/v1',
    modelSuggestions: [],
  },
  {
    id: 'provider.custom',
    name: 'Custom',
    providerKind: 'custom',
    apiFormat: 'openai_chat_completions',
    authScheme: 'bearer',
    baseUrl: '',
    modelSuggestions: [],
  },
];

function asBoolean(value: number): boolean {
  return value === 1;
}

function normalizeTimestamp(value?: string): string {
  return value || new Date().toISOString();
}

function normalizeSortOrder(index: number, explicit?: number): number {
  if (Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit!));
  }
  return index;
}

function providerNeedsCredential(provider: LlmProviderRecord): boolean {
  return !provider.base_url.startsWith('mock://');
}

function getRoutePrimaryStep(routeId: string): TalkRouteStepRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_route_steps
      WHERE route_id = ?
      ORDER BY position ASC
      LIMIT 1
    `,
    )
    .get(routeId) as TalkRouteStepRecord | undefined;
}

function buildDefaultTalkAgentName(routeId: string): string {
  const primaryStep = getRoutePrimaryStep(routeId);
  if (primaryStep) {
    const model = getLlmProviderModel(
      primaryStep.provider_id,
      primaryStep.model_id,
    );
    if (model?.display_name?.trim()) {
      return model.display_name.trim();
    }
  }

  const route = getTalkRouteById(routeId);
  if (route?.name?.trim()) {
    return route.name.trim();
  }

  return 'Main Agent';
}

function isTalkUsableProvider(provider: LlmProviderRecord): boolean {
  return (
    provider.enabled === 1 &&
    (provider.api_format === 'anthropic_messages' ||
      provider.api_format === 'openai_chat_completions')
  );
}

function maskCredentialSuffix(secret: ProviderSecretPayload): string {
  const value =
    secret.organizationId?.trim() || secret.apiKey.replace(/\s+/g, '').trim();
  if (!value) return 'Configured';
  const suffix = value.slice(-4);
  return `••••${suffix || 'set'}`;
}

function normalizeProviderBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, '');
}

function getKnownProviderTemplate(
  providerId: string,
): (typeof KNOWN_PROVIDER_CATALOG)[number] | undefined {
  return KNOWN_PROVIDER_CATALOG.find((provider) => provider.id === providerId);
}

function getFallbackModelMetadata(
  providerId: string,
  modelId: string,
  displayName?: string,
): ProviderModelSuggestion {
  const suggested =
    getKnownProviderTemplate(providerId)?.modelSuggestions.find(
      (model) => model.modelId === modelId,
    ) || null;
  return {
    modelId,
    displayName: displayName?.trim() || suggested?.displayName || modelId,
    contextWindowTokens: suggested?.contextWindowTokens || 128000,
    defaultMaxOutputTokens: suggested?.defaultMaxOutputTokens || 4096,
  };
}

export function upsertLlmProvider(input: {
  id: string;
  name: string;
  providerKind: LlmProviderKind;
  apiFormat: LlmProviderRecord['api_format'];
  baseUrl: string;
  authScheme: LlmAuthScheme;
  enabled: boolean;
  coreCompatibility: LlmCoreCompatibility;
  responseStartTimeoutMs?: number | null;
  streamIdleTimeoutMs?: number | null;
  absoluteTimeoutMs?: number | null;
  updatedBy?: string | null;
  updatedAt?: string;
}): void {
  const updatedAt = normalizeTimestamp(input.updatedAt);
  getDb()
    .prepare(
      `
      INSERT INTO llm_providers (
        id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
        core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
        absolute_timeout_ms, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        provider_kind = excluded.provider_kind,
        api_format = excluded.api_format,
        base_url = excluded.base_url,
        auth_scheme = excluded.auth_scheme,
        enabled = excluded.enabled,
        core_compatibility = excluded.core_compatibility,
        response_start_timeout_ms = excluded.response_start_timeout_ms,
        stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
        absolute_timeout_ms = excluded.absolute_timeout_ms,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      input.id,
      input.name,
      input.providerKind,
      input.apiFormat,
      input.baseUrl,
      input.authScheme,
      input.enabled ? 1 : 0,
      input.coreCompatibility,
      input.responseStartTimeoutMs ?? null,
      input.streamIdleTimeoutMs ?? null,
      input.absoluteTimeoutMs ?? null,
      updatedAt,
      input.updatedBy || null,
    );
}

export function replaceProviderModels(
  providerId: string,
  models: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    enabled: boolean;
  }>,
  updatedBy?: string | null,
  updatedAt?: string,
): void {
  const now = normalizeTimestamp(updatedAt);
  const tx = getDb().transaction(() => {
    getDb()
      .prepare('DELETE FROM llm_provider_models WHERE provider_id = ?')
      .run(providerId);
    const stmt = getDb().prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, enabled, updated_at, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    for (const model of models) {
      stmt.run(
        providerId,
        model.modelId,
        model.displayName,
        model.contextWindowTokens,
        model.defaultMaxOutputTokens,
        model.enabled ? 1 : 0,
        now,
        updatedBy || null,
      );
    }
  });
  tx();
}

export function upsertProviderSecret(input: {
  providerId: string;
  ciphertext: string;
  updatedBy?: string | null;
  updatedAt?: string;
}): void {
  const updatedAt = normalizeTimestamp(input.updatedAt);
  getDb()
    .prepare(
      `
      INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        ciphertext = excluded.ciphertext,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      input.providerId,
      input.ciphertext,
      updatedAt,
      input.updatedBy || null,
    );
}

export function deleteProviderSecret(providerId: string): void {
  getDb()
    .prepare('DELETE FROM llm_provider_secrets WHERE provider_id = ?')
    .run(providerId);
}

export function getProviderVerificationByProviderId(
  providerId: string,
): LlmProviderVerificationRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_provider_verifications
      WHERE provider_id = ?
      LIMIT 1
    `,
    )
    .get(providerId) as LlmProviderVerificationRecord | undefined;
}

export function upsertProviderVerification(input: {
  providerId: string;
  status: LlmProviderVerificationStatus;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
  updatedAt?: string;
}): void {
  const updatedAt = normalizeTimestamp(input.updatedAt);
  getDb()
    .prepare(
      `
      INSERT INTO llm_provider_verifications (
        provider_id,
        status,
        last_verified_at,
        last_error,
        updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider_id) DO UPDATE SET
        status = excluded.status,
        last_verified_at = excluded.last_verified_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.providerId,
      input.status,
      input.lastVerifiedAt ?? null,
      input.lastError ?? null,
      updatedAt,
    );
}

export function clearProviderVerification(providerId: string): void {
  getDb()
    .prepare('DELETE FROM llm_provider_verifications WHERE provider_id = ?')
    .run(providerId);
}

export function listKnownProviderCredentialCards(): AgentProviderCardSnapshot[] {
  const providersById = new Map(
    listLlmProviders().map((provider) => [provider.id, provider]),
  );
  const modelsByProvider = new Map<string, LlmProviderModelRecord[]>();
  for (const model of listLlmProviderModels()) {
    const current = modelsByProvider.get(model.provider_id) || [];
    current.push(model);
    modelsByProvider.set(model.provider_id, current);
  }

  return KNOWN_PROVIDER_CATALOG.map((template) => {
    const provider = providersById.get(template.id);
    const secretRecord = provider
      ? getProviderSecretByProviderId(provider.id)
      : undefined;
    const verification = provider
      ? getProviderVerificationByProviderId(provider.id)
      : undefined;
    const storedModels = provider
      ? modelsByProvider.get(provider.id) || []
      : [];
    const suggestionMap = new Map<string, ProviderModelSuggestion>();
    for (const suggestion of template.modelSuggestions) {
      suggestionMap.set(suggestion.modelId, suggestion);
    }
    for (const model of storedModels) {
      suggestionMap.set(model.model_id, {
        modelId: model.model_id,
        displayName: model.display_name,
        contextWindowTokens: model.context_window_tokens,
        defaultMaxOutputTokens: model.default_max_output_tokens,
      });
    }

    return {
      id: template.id,
      name: provider?.name || template.name,
      providerKind: provider?.provider_kind || template.providerKind,
      apiFormat: provider?.api_format || template.apiFormat,
      baseUrl: provider?.base_url || template.baseUrl,
      authScheme: provider?.auth_scheme || template.authScheme,
      enabled: provider ? asBoolean(provider.enabled) : false,
      hasCredential: Boolean(secretRecord),
      credentialHint: secretRecord
        ? maskCredentialSuffix(decryptProviderSecret(secretRecord.ciphertext))
        : null,
      verificationStatus: secretRecord
        ? verification?.status || 'not_verified'
        : 'missing',
      lastVerifiedAt: verification?.last_verified_at || null,
      lastVerificationError: verification?.last_error || null,
      modelSuggestions: Array.from(suggestionMap.values()),
    };
  });
}

export function upsertKnownProviderCredential(input: {
  providerId: string;
  credential: ProviderSecretPayload | null;
  baseUrl?: string | null;
  authScheme?: LlmAuthScheme;
  updatedBy?: string | null;
  updatedAt?: string;
}): AgentProviderCardSnapshot {
  const template = getKnownProviderTemplate(input.providerId);
  if (!template) {
    throw new Error(`unknown provider template: ${input.providerId}`);
  }

  const now = normalizeTimestamp(input.updatedAt);
  const existing = getLlmProviderById(input.providerId);
  const baseUrl = normalizeProviderBaseUrl(
    input.baseUrl ?? existing?.base_url ?? template.baseUrl,
  );
  const authScheme =
    input.authScheme || existing?.auth_scheme || template.authScheme;

  upsertLlmProvider({
    id: template.id,
    name: template.name,
    providerKind: template.providerKind,
    apiFormat: template.apiFormat,
    baseUrl,
    authScheme,
    enabled: true,
    coreCompatibility: 'none',
    updatedBy: input.updatedBy,
    updatedAt: now,
  });

  if (input.credential && input.credential.apiKey.trim()) {
    upsertProviderSecret({
      providerId: template.id,
      ciphertext: encryptProviderSecret(input.credential),
      updatedBy: input.updatedBy,
      updatedAt: now,
    });
    upsertProviderVerification({
      providerId: template.id,
      status: 'not_verified',
      lastVerifiedAt: null,
      lastError: null,
      updatedAt: now,
    });
  } else {
    deleteProviderSecret(template.id);
    upsertProviderVerification({
      providerId: template.id,
      status: 'missing',
      lastVerifiedAt: null,
      lastError: null,
      updatedAt: now,
    });
  }

  const updated = listKnownProviderCredentialCards().find(
    (provider) => provider.id === template.id,
  );
  if (!updated) {
    throw new Error('provider save failed');
  }
  return updated;
}

export function listLlmProviders(): LlmProviderRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_providers
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `,
    )
    .all() as LlmProviderRecord[];
}

export function getLlmProviderById(
  providerId: string,
): LlmProviderRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM llm_providers WHERE id = ?')
    .get(providerId) as LlmProviderRecord | undefined;
}

export function listLlmProviderModels(
  providerId?: string,
): LlmProviderModelRecord[] {
  if (providerId) {
    return getDb()
      .prepare(
        `
        SELECT *
        FROM llm_provider_models
        WHERE provider_id = ?
        ORDER BY display_name COLLATE NOCASE ASC, model_id ASC
      `,
      )
      .all(providerId) as LlmProviderModelRecord[];
  }

  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_provider_models
      ORDER BY provider_id ASC, display_name COLLATE NOCASE ASC, model_id ASC
    `,
    )
    .all() as LlmProviderModelRecord[];
}

export function getLlmProviderModel(
  providerId: string,
  modelId: string,
): LlmProviderModelRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_provider_models
      WHERE provider_id = ? AND model_id = ?
      LIMIT 1
    `,
    )
    .get(providerId, modelId) as LlmProviderModelRecord | undefined;
}

export function getProviderSecretByProviderId(
  providerId: string,
): LlmProviderSecretRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_provider_secrets
      WHERE provider_id = ?
      LIMIT 1
    `,
    )
    .get(providerId) as LlmProviderSecretRecord | undefined;
}

export function upsertTalkRoute(input: {
  id: string;
  name: string;
  enabled: boolean;
  steps: Array<{ position: number; providerId: string; modelId: string }>;
  updatedBy?: string | null;
  updatedAt?: string;
}): void {
  const now = normalizeTimestamp(input.updatedAt);
  const tx = getDb().transaction(() => {
    getDb()
      .prepare(
        `
        INSERT INTO talk_routes (id, name, enabled, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
      )
      .run(
        input.id,
        input.name,
        input.enabled ? 1 : 0,
        now,
        input.updatedBy || null,
      );

    getDb()
      .prepare('DELETE FROM talk_route_steps WHERE route_id = ?')
      .run(input.id);
    const stepStmt = getDb().prepare(
      `
      INSERT INTO talk_route_steps (route_id, position, provider_id, model_id)
      VALUES (?, ?, ?, ?)
    `,
    );
    for (const step of input.steps) {
      stepStmt.run(input.id, step.position, step.providerId, step.modelId);
    }
  });
  tx();
}

export function replaceTalkRoutes(
  routes: Array<{
    id: string;
    name: string;
    enabled: boolean;
    steps: Array<{ position: number; providerId: string; modelId: string }>;
  }>,
  updatedBy?: string | null,
  updatedAt?: string,
): void {
  const now = normalizeTimestamp(updatedAt);
  const tx = getDb().transaction(() => {
    for (const route of routes) {
      upsertTalkRoute({
        ...route,
        updatedBy,
        updatedAt: now,
      });
    }
  });
  tx();
}

export function listTalkRoutes(): TalkRouteRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_routes
      ORDER BY name COLLATE NOCASE ASC, id ASC
    `,
    )
    .all() as TalkRouteRecord[];
}

export function getTalkRouteById(routeId: string): TalkRouteRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM talk_routes WHERE id = ?')
    .get(routeId) as TalkRouteRecord | undefined;
}

export function listTalkRouteSteps(routeId?: string): TalkRouteStepRecord[] {
  if (routeId) {
    return getDb()
      .prepare(
        `
        SELECT *
        FROM talk_route_steps
        WHERE route_id = ?
        ORDER BY position ASC
      `,
      )
      .all(routeId) as TalkRouteStepRecord[];
  }
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_route_steps
      ORDER BY route_id ASC, position ASC
    `,
    )
    .all() as TalkRouteStepRecord[];
}

export function getTalkRouteUsageCounts(routeId: string): TalkRouteUsageCounts {
  const row = getDb()
    .prepare(
      `
      SELECT
        COUNT(*) AS assigned_agent_count,
        COUNT(DISTINCT talk_id) AS assigned_talk_count
      FROM talk_agents
      WHERE route_id = ?
    `,
    )
    .get(routeId) as {
    assigned_agent_count: number;
    assigned_talk_count: number;
  };

  return {
    assignedAgentCount: row?.assigned_agent_count || 0,
    assignedTalkCount: row?.assigned_talk_count || 0,
  };
}

export function getDefaultTalkRouteId(): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT value
      FROM settings_kv
      WHERE key = ?
      LIMIT 1
    `,
    )
    .get(TALK_DEFAULT_ROUTE_KEY) as { value: string } | undefined;
  return row?.value || null;
}

export function setDefaultTalkRouteId(
  routeId: string,
  updatedBy?: string | null,
  updatedAt?: string,
): void {
  getDb()
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      TALK_DEFAULT_ROUTE_KEY,
      routeId,
      normalizeTimestamp(updatedAt),
      updatedBy || null,
    );
}

export function getDefaultRegisteredAgentId(): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT value
      FROM settings_kv
      WHERE key = ?
      LIMIT 1
    `,
    )
    .get(DEFAULT_REGISTERED_AGENT_KEY) as { value: string } | undefined;
  return row?.value || null;
}

export function setDefaultRegisteredAgentId(
  registeredAgentId: string | null,
  updatedBy?: string | null,
  updatedAt?: string,
): void {
  if (!registeredAgentId) {
    getDb()
      .prepare('DELETE FROM settings_kv WHERE key = ?')
      .run(DEFAULT_REGISTERED_AGENT_KEY);
    return;
  }

  getDb()
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      DEFAULT_REGISTERED_AGENT_KEY,
      registeredAgentId,
      normalizeTimestamp(updatedAt),
      updatedBy || null,
    );
}

export function listRegisteredAgentRecords(): RegisteredAgentRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM registered_agents
      ORDER BY enabled DESC, name COLLATE NOCASE ASC, id ASC
    `,
    )
    .all() as RegisteredAgentRecord[];
}

export function getRegisteredAgentById(
  agentId: string,
): RegisteredAgentRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM registered_agents
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(agentId) as RegisteredAgentRecord | undefined;
}

export function getRegisteredAgentUsageCount(agentId: string): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(DISTINCT talk_id) AS talk_count
      FROM talk_agents
      WHERE registered_agent_id = ?
    `,
    )
    .get(agentId) as { talk_count: number } | undefined;
  return row?.talk_count || 0;
}

function listRegisteredAgentUsageCounts(): Map<string, number> {
  const rows = getDb()
    .prepare(
      `
      SELECT registered_agent_id, COUNT(DISTINCT talk_id) AS talk_count
      FROM talk_agents
      WHERE registered_agent_id IS NOT NULL
      GROUP BY registered_agent_id
    `,
    )
    .all() as Array<{ registered_agent_id: string; talk_count: number }>;
  return new Map(
    rows.map((row) => [row.registered_agent_id, row.talk_count || 0] as const),
  );
}

function findNextEnabledRegisteredAgentId(
  excludeAgentId?: string,
): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT id
      FROM registered_agents
      WHERE enabled = 1
        AND (? IS NULL OR id != ?)
      ORDER BY name COLLATE NOCASE ASC, id ASC
      LIMIT 1
    `,
    )
    .get(excludeAgentId || null, excludeAgentId || null) as
    | { id: string }
    | undefined;
  return row?.id || null;
}

export function listRegisteredAgents(): RegisteredAgentSnapshot[] {
  const providersById = new Map(
    listLlmProviders().map((provider) => [provider.id, provider]),
  );
  const modelsByKey = new Map(
    listLlmProviderModels().map((model) => [
      `${model.provider_id}:${model.model_id}`,
      model,
    ]),
  );
  const usageCounts = listRegisteredAgentUsageCounts();

  return listRegisteredAgentRecords().map((agent) => {
    const provider = providersById.get(agent.provider_id);
    const model = modelsByKey.get(`${agent.provider_id}:${agent.model_id}`);
    return {
      id: agent.id,
      name: agent.name,
      providerId: agent.provider_id,
      providerName: provider?.name || agent.provider_id,
      providerKind: provider?.provider_kind || 'custom',
      modelId: agent.model_id,
      modelDisplayName: model?.display_name || agent.model_id,
      routeId: agent.route_id,
      enabled: asBoolean(agent.enabled),
      usageCount: usageCounts.get(agent.id) || 0,
    };
  });
}

function ensureProviderModelExists(input: {
  providerId: string;
  modelId: string;
  displayName?: string;
  updatedAt?: string;
}): void {
  const existing = getLlmProviderModel(input.providerId, input.modelId);
  if (existing) return;
  const metadata = getFallbackModelMetadata(
    input.providerId,
    input.modelId,
    input.displayName,
  );
  const updatedAt = normalizeTimestamp(input.updatedAt);
  getDb()
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id,
        model_id,
        display_name,
        context_window_tokens,
        default_max_output_tokens,
        enabled,
        updated_at,
        updated_by
      ) VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
    `,
    )
    .run(
      input.providerId,
      metadata.modelId,
      metadata.displayName,
      metadata.contextWindowTokens,
      metadata.defaultMaxOutputTokens,
      updatedAt,
    );
}

export function createRegisteredAgent(input: {
  name: string;
  providerId: string;
  modelId: string;
  modelDisplayName?: string;
  enabled?: boolean;
  updatedBy?: string | null;
  updatedAt?: string;
  setAsDefault?: boolean;
}): RegisteredAgentSnapshot {
  const now = normalizeTimestamp(input.updatedAt);
  const id = `ragent_${randomUUID()}`;
  const routeId = `route.agent.${id}`;
  const provider = getLlmProviderById(input.providerId);
  if (!provider) {
    throw new Error(`provider not found: ${input.providerId}`);
  }

  ensureProviderModelExists({
    providerId: input.providerId,
    modelId: input.modelId,
    displayName: input.modelDisplayName,
    updatedAt: now,
  });

  const tx = getDb().transaction(() => {
    upsertTalkRoute({
      id: routeId,
      name: `${input.name.trim()} Route`,
      enabled: true,
      steps: [
        {
          position: 0,
          providerId: input.providerId,
          modelId: input.modelId,
        },
      ],
      updatedBy: input.updatedBy,
      updatedAt: now,
    });

    getDb()
      .prepare(
        `
        INSERT INTO registered_agents (
          id,
          name,
          provider_id,
          model_id,
          route_id,
          enabled,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        id,
        input.name.trim(),
        input.providerId,
        input.modelId,
        routeId,
        input.enabled === false ? 0 : 1,
        now,
        now,
      );

    if (input.setAsDefault || !getDefaultRegisteredAgentId()) {
      setDefaultRegisteredAgentId(id, input.updatedBy, now);
    }
  });
  tx();

  const created = listRegisteredAgents().find((agent) => agent.id === id);
  if (!created) {
    throw new Error('registered agent create failed');
  }
  return created;
}

export function updateRegisteredAgentName(
  agentId: string,
  name: string,
  updatedAt?: string,
): RegisteredAgentSnapshot {
  const now = normalizeTimestamp(updatedAt);
  getDb()
    .prepare(
      `
      UPDATE registered_agents
      SET name = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(name.trim(), now, agentId);

  const updated = listRegisteredAgents().find((agent) => agent.id === agentId);
  if (!updated) {
    throw new Error('registered agent not found');
  }
  return updated;
}

export function setRegisteredAgentEnabled(
  agentId: string,
  enabled: boolean,
  updatedAt?: string,
): RegisteredAgentSnapshot {
  const now = normalizeTimestamp(updatedAt);
  getDb()
    .prepare(
      `
      UPDATE registered_agents
      SET enabled = ?, updated_at = ?
      WHERE id = ?
    `,
    )
    .run(enabled ? 1 : 0, now, agentId);

  const updated = listRegisteredAgents().find((agent) => agent.id === agentId);
  if (!updated) {
    throw new Error('registered agent not found');
  }

  if (!enabled && getDefaultRegisteredAgentId() === agentId) {
    const nextDefault = findNextEnabledRegisteredAgentId(agentId);
    setDefaultRegisteredAgentId(nextDefault, null, now);
  }

  return updated;
}

export function duplicateRegisteredAgent(input: {
  sourceAgentId: string;
  name: string;
  providerId: string;
  modelId: string;
  modelDisplayName?: string;
  updatedBy?: string | null;
  updatedAt?: string;
}): RegisteredAgentSnapshot {
  // v1 registered agents only duplicate name/provider/model. We still require
  // a sourceAgentId so the duplication flow has an explicit source to validate
  // against, and this field becomes the natural copy source if per-agent
  // configuration is added later.
  return createRegisteredAgent({
    name: input.name,
    providerId: input.providerId,
    modelId: input.modelId,
    modelDisplayName: input.modelDisplayName,
    updatedBy: input.updatedBy,
    updatedAt: input.updatedAt,
    setAsDefault: false,
  });
}

export function deleteRegisteredAgent(agentId: string): void {
  if (getRegisteredAgentUsageCount(agentId) > 0) {
    throw new Error('registered agent is still used by talks');
  }
  const record = getRegisteredAgentById(agentId);
  if (!record) return;
  const defaultAgentId = getDefaultRegisteredAgentId();
  const tx = getDb().transaction(() => {
    if (defaultAgentId === agentId) {
      const nextDefault = findNextEnabledRegisteredAgentId(agentId);
      setDefaultRegisteredAgentId(nextDefault);
    }
    getDb().prepare('DELETE FROM registered_agents WHERE id = ?').run(agentId);
    getDb()
      .prepare('DELETE FROM talk_routes WHERE id = ?')
      .run(record.route_id);
  });
  tx();
}

export function listTalkAgents(talkId: string): TalkAgentRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_agents
      WHERE talk_id = ?
      ORDER BY is_primary DESC, sort_order ASC, created_at ASC
    `,
    )
    .all(talkId) as TalkAgentRecord[];
}

export function getTalkAgentById(
  talkId: string,
  agentId: string,
): TalkAgentRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_agents
      WHERE talk_id = ? AND id = ?
      LIMIT 1
    `,
    )
    .get(talkId, agentId) as TalkAgentRecord | undefined;
}

export function getPrimaryTalkAgent(
  talkId: string,
): TalkAgentRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_agents
      WHERE talk_id = ? AND is_primary = 1
      ORDER BY sort_order ASC, created_at ASC
      LIMIT 1
    `,
    )
    .get(talkId) as TalkAgentRecord | undefined;
}

export function replaceTalkAgents(
  talkId: string,
  agents: TalkAgentInput[],
  now?: string,
): TalkAgentRecord[] {
  const updatedAt = normalizeTimestamp(now);
  const normalized = agents.map((agent, index) => ({
    id: agent.id || `agent_${randomUUID()}`,
    talkId,
    name: agent.name.trim(),
    personaRole: agent.personaRole,
    routeId: agent.routeId,
    registeredAgentId: agent.registeredAgentId || null,
    isPrimary: agent.isPrimary,
    sortOrder: normalizeSortOrder(index, agent.sortOrder),
  }));

  const tx = getDb().transaction(() => {
    getDb().prepare('DELETE FROM talk_agents WHERE talk_id = ?').run(talkId);
    const stmt = getDb().prepare(
      `
      INSERT INTO talk_agents (
        id, talk_id, name, persona_role, route_id, registered_agent_id,
        is_primary, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    for (const agent of normalized) {
      stmt.run(
        agent.id,
        talkId,
        agent.name,
        agent.personaRole,
        agent.routeId,
        agent.registeredAgentId,
        agent.isPrimary ? 1 : 0,
        agent.sortOrder,
        updatedAt,
        updatedAt,
      );
    }
  });
  tx();

  return listTalkAgents(talkId);
}

export function resetTalkAgentsToDefault(
  talkId: string,
  now?: string,
): TalkAgentRecord[] {
  const defaultRegisteredAgentId = getDefaultRegisteredAgentId();
  const defaultRegisteredAgent = defaultRegisteredAgentId
    ? getRegisteredAgentById(defaultRegisteredAgentId)
    : undefined;
  if (defaultRegisteredAgent && defaultRegisteredAgent.enabled === 1) {
    return replaceTalkAgents(
      talkId,
      [
        {
          id: `agent_${randomUUID()}`,
          name: defaultRegisteredAgent.name,
          personaRole: 'assistant',
          routeId: defaultRegisteredAgent.route_id,
          registeredAgentId: defaultRegisteredAgent.id,
          isPrimary: true,
          sortOrder: 0,
        },
      ],
      now,
    );
  }

  const fallbackRouteId =
    getDefaultTalkRouteId() ||
    listTalkRoutes().find((route) => route.enabled === 1)?.id ||
    BUILTIN_MOCK_ROUTE_ID;

  return replaceTalkAgents(
    talkId,
    [
      {
        id: `agent_${randomUUID()}`,
        name: buildDefaultTalkAgentName(fallbackRouteId),
        personaRole: 'assistant',
        routeId: fallbackRouteId,
        registeredAgentId: null,
        isPrimary: true,
        sortOrder: 0,
      },
    ],
    now,
  );
}

export function ensureTalkHasDefaultAgent(
  talkId: string,
  now?: string,
): TalkAgentRecord[] {
  const existing = listTalkAgents(talkId);
  if (existing.length > 0) return existing;
  return resetTalkAgentsToDefault(talkId, now);
}

export function listTalkAgentInstances(
  talkId: string,
): TalkAgentInstanceSnapshot[] {
  const existing = ensureTalkHasDefaultAgent(talkId);
  const registeredAgentsById = new Map(
    listRegisteredAgents().map((agent) => [agent.id, agent]),
  );
  return existing.map((agent) => {
    const registeredAgent = agent.registered_agent_id
      ? registeredAgentsById.get(agent.registered_agent_id)
      : undefined;
    return {
      id: agent.id,
      registeredAgentId: agent.registered_agent_id,
      name: registeredAgent?.name || agent.name,
      role: agent.persona_role,
      isLead: agent.is_primary === 1,
      displayOrder: agent.sort_order,
      status: registeredAgent
        ? registeredAgent.enabled
          ? 'active'
          : 'archived'
        : 'legacy',
      providerId: registeredAgent?.providerId || null,
      providerName: registeredAgent?.providerName || null,
      modelId: registeredAgent?.modelId || null,
      modelDisplayName: registeredAgent?.modelDisplayName || null,
    };
  });
}

export function replaceTalkAgentInstances(
  talkId: string,
  agents: TalkAgentInstanceInput[],
  now?: string,
): TalkAgentRecord[] {
  const existingById = new Map(
    listTalkAgents(talkId).map((agent) => [agent.id, agent]),
  );
  const normalized: TalkAgentInput[] = agents.map((agent, index) => {
    const existing = agent.id ? existingById.get(agent.id) : undefined;
    if (agent.registeredAgentId) {
      const registeredAgent = getRegisteredAgentById(agent.registeredAgentId);
      if (!registeredAgent) {
        throw new Error(
          `registered agent not found: ${agent.registeredAgentId}`,
        );
      }
      return {
        id: agent.id,
        name: registeredAgent.name,
        personaRole: agent.role,
        routeId: registeredAgent.route_id,
        registeredAgentId: registeredAgent.id,
        isPrimary: agent.isLead,
        sortOrder: normalizeSortOrder(index, agent.displayOrder),
      };
    }

    if (!existing || existing.registered_agent_id) {
      throw new Error('legacy talk agents cannot be created manually');
    }

    return {
      id: existing.id,
      name: existing.name,
      personaRole: agent.role,
      routeId: existing.route_id,
      registeredAgentId: null,
      isPrimary: agent.isLead,
      sortOrder: normalizeSortOrder(index, agent.displayOrder),
    };
  });

  return replaceTalkAgents(talkId, normalized, now);
}

export function resolveTalkAgent(
  talkId: string,
  targetAgentId?: string | null,
): ResolvedTalkAgent | null {
  const agents = ensureTalkHasDefaultAgent(talkId);
  const agent =
    (targetAgentId
      ? agents.find((entry) => entry.id === targetAgentId)
      : undefined) || agents.find((entry) => entry.is_primary === 1);
  if (!agent) return null;

  const registeredAgent = agent.registered_agent_id
    ? getRegisteredAgentById(agent.registered_agent_id)
    : undefined;
  const effectiveAgent = registeredAgent
    ? ({ ...agent, name: registeredAgent.name } as TalkAgentRecord)
    : agent;

  const route = getTalkRouteById(agent.route_id);
  if (!route) return null;

  const routeSteps = listTalkRouteSteps(route.id);
  const steps: ResolvedTalkRouteStep[] = [];
  for (const routeStep of routeSteps) {
    const provider = getLlmProviderById(routeStep.provider_id);
    const model = provider
      ? getLlmProviderModel(provider.id, routeStep.model_id)
      : undefined;
    if (!provider || !model) continue;
    steps.push({
      routeStep,
      provider,
      model,
      hasCredential:
        !providerNeedsCredential(provider) ||
        Boolean(getProviderSecretByProviderId(provider.id)),
      talkUsable: isTalkUsableProvider(provider),
    });
  }

  return { agent: effectiveAgent, route, steps };
}

export function listTalkLlmSettingsSnapshot(): TalkLlmSettingsSnapshot {
  const providers = listLlmProviders();
  const providerModels = listLlmProviderModels();
  const providerSecrets = new Set(
    (
      getDb()
        .prepare('SELECT provider_id FROM llm_provider_secrets')
        .all() as Array<{ provider_id: string }>
    ).map((row: { provider_id: string }) => row.provider_id),
  );

  const routes = listTalkRoutes();
  const routeSteps = listTalkRouteSteps();

  return {
    defaultRouteId: getDefaultTalkRouteId(),
    providers: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      providerKind: provider.provider_kind,
      apiFormat: provider.api_format,
      baseUrl: provider.base_url,
      authScheme: provider.auth_scheme,
      enabled: asBoolean(provider.enabled),
      coreCompatibility: provider.core_compatibility,
      responseStartTimeoutMs: provider.response_start_timeout_ms,
      streamIdleTimeoutMs: provider.stream_idle_timeout_ms,
      absoluteTimeoutMs: provider.absolute_timeout_ms,
      hasCredential:
        providerSecrets.has(provider.id) || !providerNeedsCredential(provider),
      models: providerModels
        .filter((model) => model.provider_id === provider.id)
        .map((model) => ({
          modelId: model.model_id,
          displayName: model.display_name,
          contextWindowTokens: model.context_window_tokens,
          defaultMaxOutputTokens: model.default_max_output_tokens,
          enabled: asBoolean(model.enabled),
        })),
    })),
    routes: routes.map((route) => {
      const usage = getTalkRouteUsageCounts(route.id);
      return {
        id: route.id,
        name: route.name,
        enabled: asBoolean(route.enabled),
        assignedAgentCount: usage.assignedAgentCount,
        assignedTalkCount: usage.assignedTalkCount,
        steps: routeSteps
          .filter((step) => step.route_id === route.id)
          .map((step) => ({
            position: step.position,
            providerId: step.provider_id,
            modelId: step.model_id,
          })),
      };
    }),
  };
}

export function replaceTalkLlmSettingsSnapshot(input: {
  providers: Array<
    Omit<LlmProviderSnapshot, 'hasCredential'> & {
      credential?: ProviderSecretPayload | null;
    }
  >;
  routes: Array<{
    id: string;
    name: string;
    enabled: boolean;
    steps: Array<{ position: number; providerId: string; modelId: string }>;
  }>;
  defaultRouteId: string;
  updatedBy?: string | null;
  updatedAt?: string;
}): TalkLlmSettingsSnapshot {
  const now = normalizeTimestamp(input.updatedAt);
  const tx = getDb().transaction(() => {
    for (const provider of input.providers) {
      upsertLlmProvider({
        id: provider.id,
        name: provider.name,
        providerKind: provider.providerKind,
        apiFormat: provider.apiFormat,
        baseUrl: provider.baseUrl,
        authScheme: provider.authScheme,
        enabled: provider.enabled,
        coreCompatibility: provider.coreCompatibility,
        responseStartTimeoutMs: provider.responseStartTimeoutMs ?? null,
        streamIdleTimeoutMs: provider.streamIdleTimeoutMs ?? null,
        absoluteTimeoutMs: provider.absoluteTimeoutMs ?? null,
        updatedBy: input.updatedBy,
        updatedAt: now,
      });
      replaceProviderModels(
        provider.id,
        provider.models.map((model) => ({
          modelId: model.modelId,
          displayName: model.displayName,
          contextWindowTokens: model.contextWindowTokens,
          defaultMaxOutputTokens: model.defaultMaxOutputTokens,
          enabled: model.enabled,
        })),
        input.updatedBy,
        now,
      );
    }

    for (const route of input.routes) {
      upsertTalkRoute({
        ...route,
        updatedBy: input.updatedBy,
        updatedAt: now,
      });
    }

    for (const provider of input.providers) {
      if (provider.credential === undefined) continue;
      if (provider.credential === null || !provider.credential.apiKey?.trim()) {
        deleteProviderSecret(provider.id);
        continue;
      }
      upsertProviderSecret({
        providerId: provider.id,
        ciphertext: encryptProviderSecret(provider.credential),
        updatedBy: input.updatedBy,
        updatedAt: now,
      });
    }

    setDefaultTalkRouteId(input.defaultRouteId, input.updatedBy, now);
  });

  tx();
  return listTalkLlmSettingsSnapshot();
}

export function createLlmAttempt(input: {
  runId: string;
  talkId: string;
  agentId?: string | null;
  routeId?: string | null;
  routeStepPosition?: number | null;
  providerId?: string | null;
  modelId?: string | null;
  status: LlmAttemptStatus;
  failureClass?: LlmFailureClass | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number | null;
  createdAt?: string;
}): number {
  const result = getDb()
    .prepare(
      `
      INSERT INTO llm_attempts (
        run_id, talk_id, agent_id, route_id, route_step_position,
        provider_id, model_id, status, failure_class, latency_ms,
        input_tokens, output_tokens, estimated_cost_usd, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      input.runId,
      input.talkId,
      input.agentId || null,
      input.routeId || null,
      input.routeStepPosition ?? null,
      input.providerId || null,
      input.modelId || null,
      input.status,
      input.failureClass || null,
      input.latencyMs ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.estimatedCostUsd ?? null,
      normalizeTimestamp(input.createdAt),
    );
  return Number(result.lastInsertRowid);
}

export function listLlmAttemptsForRun(runId: string): LlmAttemptRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM llm_attempts
      WHERE run_id = ?
      ORDER BY id ASC
    `,
    )
    .all(runId) as LlmAttemptRecord[];
}
