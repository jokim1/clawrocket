import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
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
  ProviderSecretPayload,
  TalkAgentRecord,
  TalkPersonaRole,
  TalkRouteRecord,
  TalkRouteStepRecord,
  TalkRouteUsageCounts,
} from '../llm/types.js';

const TALK_DEFAULT_ROUTE_KEY = 'talkLlm.defaultRouteId';
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
  isPrimary: boolean;
  sortOrder: number;
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
    isPrimary: agent.isPrimary,
    sortOrder: normalizeSortOrder(index, agent.sortOrder),
  }));

  const tx = getDb().transaction(() => {
    getDb().prepare('DELETE FROM talk_agents WHERE talk_id = ?').run(talkId);
    const stmt = getDb().prepare(
      `
      INSERT INTO talk_agents (
        id, talk_id, name, persona_role, route_id, is_primary, sort_order,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    );
    for (const agent of normalized) {
      stmt.run(
        agent.id,
        talkId,
        agent.name,
        agent.personaRole,
        agent.routeId,
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

  return { agent, route, steps };
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
