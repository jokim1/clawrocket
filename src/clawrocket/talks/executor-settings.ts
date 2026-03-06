import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import { logger } from '../../logger.js';
import {
  TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON,
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_ANTHROPIC_BASE_URL,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
  TALK_EXECUTOR_DEFAULT_ALIAS,
} from '../config.js';
import { countRunningTalkRuns } from '../db/index.js';

export const EXECUTOR_COMPATIBILITY_ALIAS_MODEL_SEEDS: Record<string, string> =
  {
    Mock: 'default',
    Gemini: 'default',
    'Opus4.6': 'default',
    Haiku: 'default',
    'GPT-4o': 'default',
    Opus: 'default',
  };

type SettingSource = 'db' | 'bootstrap' | 'none';
export type DetectedAuthMethod = 'oauth' | 'api_key' | 'auth_token' | 'none';

const EXECUTOR_SETTINGS_PREFIX = 'executor.';
const EXECUTOR_KEY_API_KEY = 'executor.anthropicApiKey';
const EXECUTOR_KEY_OAUTH_TOKEN = 'executor.claudeOauthToken';
const EXECUTOR_KEY_AUTH_TOKEN = 'executor.anthropicAuthToken';
const EXECUTOR_KEY_BASE_URL = 'executor.anthropicBaseUrl';
const EXECUTOR_KEY_ALIAS_MODEL_MAP = 'executor.aliasModelMap';
const EXECUTOR_KEY_DEFAULT_ALIAS = 'executor.defaultAlias';
const EXECUTOR_KEY_CONFIG_VERSION = 'executor.configVersion';
const EXECUTOR_KEY_CONFIG_OWNED = 'executor.configOwned';

const DEFAULT_EXECUTOR_ALIAS = 'Mock';
const SELF_RESTART_ENV = 'CLAWROCKET_SELF_RESTART';

const PROCESS_BOOT_ID = randomUUID();

interface BootstrapExecutorConfig {
  aliasModelMapJson: string;
  defaultAlias: string;
  baseUrl: string;
  apiKey: string;
  oauthToken: string;
  authToken: string;
}

interface SettingRow {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

interface StoredRows {
  configOwned: boolean;
  configVersion: number;
  apiKey: string | null;
  oauthToken: string | null;
  authToken: string | null;
  baseUrl: string | null;
  aliasModelMapJson: string | null;
  defaultAlias: string | null;
}

interface ParsedAliasMapResult {
  aliasMap: Record<string, string>;
  errors: string[];
}

interface SettingSources {
  configuredAliasMap: SettingSource;
  defaultAlias: SettingSource;
  anthropicBaseUrl: SettingSource;
  anthropicApiKey: SettingSource;
  claudeOauthToken: SettingSource;
  anthropicAuthToken: SettingSource;
}

export interface ResolvedExecutorConfig {
  configuredAliasMap: Record<string, string>;
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  anthropicBaseUrl: string;
  configOwned: boolean;
  configVersion: number;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  configErrors: string[];
  sources: SettingSources;
}

export interface RunningConfigSnapshot {
  mode: 'real' | 'mock';
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  configErrors: string[];
  configVersion: number;
  isConfigured: boolean;
}

export interface SettingsActor {
  id: string;
  displayName: string;
}

export interface ExecutorSettingsView {
  configuredAliasMap: Record<string, string>;
  effectiveAliasMap: Record<string, string>;
  defaultAlias: string;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  anthropicBaseUrl: string;
  isConfigured: boolean;
  configVersion: number;
  lastUpdatedAt: string | null;
  lastUpdatedBy: SettingsActor | null;
  configErrors: string[];
}

export interface ExecutorStatusView {
  mode: 'real' | 'mock';
  restartSupported: boolean;
  pendingRestartReasons: string[];
  activeRunCount: number;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  detectedAuthMethod: DetectedAuthMethod;
  configVersion: number;
  isConfigured: boolean;
  bootId: string;
  configErrors: string[];
}

export interface ExecutorConfigUpdate {
  anthropicApiKey?: string | null;
  claudeOauthToken?: string | null;
  anthropicAuthToken?: string | null;
  anthropicBaseUrl?: string | null;
  aliasModelMap?: Record<string, string>;
  defaultAlias?: string;
}

export class ExecutorSettingsValidationError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ExecutorSettingsValidationError';
    this.code = code;
    this.details = details;
  }
}

function normalizeAliasModelMapObject(raw: unknown): ParsedAliasMapResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      aliasMap: {},
      errors: ['Alias map must be a JSON object'],
    };
  }

  const aliasMap: Record<string, string> = {};
  const errors: string[] = [];

  for (const [rawAlias, rawModel] of Object.entries(raw)) {
    const alias = rawAlias.trim();
    const model = typeof rawModel === 'string' ? rawModel.trim() : '';
    if (!alias || !model) {
      errors.push(`Invalid alias mapping entry for "${rawAlias}"`);
      continue;
    }
    aliasMap[alias] = model;
  }

  return { aliasMap, errors };
}

function parseAliasModelMapJson(rawJson: string | null): ParsedAliasMapResult {
  if (!rawJson || !rawJson.trim()) {
    return { aliasMap: {}, errors: [] };
  }

  try {
    const parsed = JSON.parse(rawJson);
    return normalizeAliasModelMapObject(parsed);
  } catch {
    return {
      aliasMap: {},
      errors: ['Alias map must be valid JSON'],
    };
  }
}

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, Object.keys(value as object).sort());
}

function normalizeUrl(value: string | null | undefined): string {
  return (value || '').trim();
}

function detectAuthMethod(rows: StoredRows): DetectedAuthMethod {
  if (rows.oauthToken) return 'oauth';
  if (rows.apiKey) return 'api_key';
  if (rows.authToken) return 'auth_token';
  return 'none';
}

function snapshotMode(config: ResolvedExecutorConfig): 'real' | 'mock' {
  return config.hasProviderAuth &&
    config.hasValidAliasMap &&
    config.configErrors.length === 0
    ? 'real'
    : 'mock';
}

function settingRowSource(
  storedValue: string | null,
  bootstrapValue: string,
  configOwned: boolean,
): SettingSource {
  if (storedValue !== null) return 'db';
  if (!configOwned && bootstrapValue.trim()) return 'bootstrap';
  return 'none';
}

function persistableAliasModelMapJson(
  aliasMap: Record<string, string>,
): string {
  return JSON.stringify(aliasMap);
}

export function computeSessionCompatKey(alias: string, model: string): string {
  return JSON.stringify([alias, model]);
}

export class ExecutorSettingsService {
  private runningSnapshot: RunningConfigSnapshot | null = null;
  private readonly bootstrapConfig: BootstrapExecutorConfig;
  private readonly startupAnchorMs: number;

  constructor(input?: {
    bootstrapConfig?: Partial<BootstrapExecutorConfig>;
    startupAnchorMs?: number;
  }) {
    this.bootstrapConfig = {
      aliasModelMapJson:
        input?.bootstrapConfig?.aliasModelMapJson ??
        TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON,
      defaultAlias:
        input?.bootstrapConfig?.defaultAlias ?? TALK_EXECUTOR_DEFAULT_ALIAS,
      baseUrl:
        input?.bootstrapConfig?.baseUrl ?? TALK_EXECUTOR_ANTHROPIC_BASE_URL,
      apiKey: input?.bootstrapConfig?.apiKey ?? TALK_EXECUTOR_ANTHROPIC_API_KEY,
      oauthToken:
        input?.bootstrapConfig?.oauthToken ?? TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
      authToken:
        input?.bootstrapConfig?.authToken ?? TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
    };
    this.startupAnchorMs = input?.startupAnchorMs ?? Date.now();
  }

  loadStoredConfig(): ResolvedExecutorConfig {
    return this.resolveEffectiveConfig();
  }

  resolveEffectiveConfig(): ResolvedExecutorConfig {
    const rows = this.readStoredRows();
    const envAliasResult = parseAliasModelMapJson(
      this.bootstrapConfig.aliasModelMapJson,
    );
    const storedAliasResult = parseAliasModelMapJson(rows.aliasModelMapJson);

    const configuredAliasMap =
      rows.aliasModelMapJson !== null
        ? storedAliasResult.aliasMap
        : rows.configOwned
          ? {}
          : envAliasResult.aliasMap;

    const configuredAliasSource = settingRowSource(
      rows.aliasModelMapJson,
      this.bootstrapConfig.aliasModelMapJson,
      rows.configOwned,
    );

    const baseUrlSource = settingRowSource(
      rows.baseUrl,
      this.bootstrapConfig.baseUrl,
      rows.configOwned,
    );
    const defaultAliasSource = settingRowSource(
      rows.defaultAlias,
      this.bootstrapConfig.defaultAlias,
      rows.configOwned,
    );

    const effectiveAliasMap = {
      ...EXECUTOR_COMPATIBILITY_ALIAS_MODEL_SEEDS,
      ...configuredAliasMap,
    };

    const defaultAliasCandidate =
      rows.defaultAlias?.trim() ||
      (!rows.configOwned ? this.bootstrapConfig.defaultAlias.trim() : '') ||
      DEFAULT_EXECUTOR_ALIAS;

    const configErrors: string[] = [];
    let hasValidAliasMap = true;

    if (rows.configOwned && storedAliasResult.errors.length > 0) {
      configErrors.push(...storedAliasResult.errors);
      hasValidAliasMap = false;
    }

    let defaultAlias = defaultAliasCandidate;
    if (!effectiveAliasMap[defaultAlias]) {
      hasValidAliasMap = false;
      if (rows.configOwned) {
        configErrors.push(
          `Default alias "${defaultAliasCandidate}" is not mapped to a configured or seed alias`,
        );
      }
      defaultAlias = effectiveAliasMap[DEFAULT_EXECUTOR_ALIAS]
        ? DEFAULT_EXECUTOR_ALIAS
        : Object.keys(effectiveAliasMap)[0] || DEFAULT_EXECUTOR_ALIAS;
    }

    const anthropicBaseUrl =
      rows.baseUrl !== null
        ? rows.baseUrl
        : rows.configOwned
          ? ''
          : this.bootstrapConfig.baseUrl;

    if (rows.configOwned && anthropicBaseUrl) {
      try {
        new URL(anthropicBaseUrl);
      } catch {
        configErrors.push('Anthropic base URL must be a valid absolute URL');
      }
    }

    return {
      configuredAliasMap,
      effectiveAliasMap,
      defaultAlias,
      anthropicBaseUrl,
      configOwned: rows.configOwned,
      configVersion: rows.configVersion,
      hasProviderAuth:
        Boolean(rows.apiKey) ||
        Boolean(rows.oauthToken) ||
        Boolean(rows.authToken),
      hasValidAliasMap,
      configErrors,
      sources: {
        configuredAliasMap: configuredAliasSource,
        defaultAlias: defaultAliasSource,
        anthropicBaseUrl: baseUrlSource,
        anthropicApiKey: rows.apiKey ? 'db' : 'none',
        claudeOauthToken: rows.oauthToken ? 'db' : 'none',
        anthropicAuthToken: rows.authToken ? 'db' : 'none',
      },
    };
  }

  runBootstrapMigration(): void {
    const rows = this.readStoredRows();
    if (rows.configOwned) return;

    const envApiKey = this.bootstrapConfig.apiKey.trim();
    const envOauthToken = this.bootstrapConfig.oauthToken.trim();
    const envAuthToken = this.bootstrapConfig.authToken.trim();
    if (!envApiKey && !envOauthToken && !envAuthToken) return;

    const config = this.resolveEffectiveConfig();
    const updatedAt = new Date().toISOString();
    const nextVersion = rows.configVersion + 1;

    const tx = getDb().transaction(() => {
      this.upsertSettingRow(
        EXECUTOR_KEY_ALIAS_MODEL_MAP,
        persistableAliasModelMapJson(config.configuredAliasMap),
        updatedAt,
        null,
      );
      this.upsertSettingRow(
        EXECUTOR_KEY_DEFAULT_ALIAS,
        config.defaultAlias,
        updatedAt,
        null,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_BASE_URL,
        normalizeUrl(config.anthropicBaseUrl),
        updatedAt,
        null,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_API_KEY,
        envApiKey,
        updatedAt,
        null,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_OAUTH_TOKEN,
        envOauthToken,
        updatedAt,
        null,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_AUTH_TOKEN,
        envAuthToken,
        updatedAt,
        null,
      );
      this.upsertSettingRow(
        EXECUTOR_KEY_CONFIG_VERSION,
        String(nextVersion),
        updatedAt,
        null,
      );
      this.upsertSettingRow(EXECUTOR_KEY_CONFIG_OWNED, 'true', updatedAt, null);
    });

    tx();

    logger.info(
      { configVersion: nextVersion },
      'Bootstrap migration: env credentials imported to settings DB',
    );
  }

  saveExecutorConfig(
    update: ExecutorConfigUpdate,
    userId: string,
  ): ExecutorSettingsView {
    const rows = this.readStoredRows();

    const currentAliasMap =
      rows.aliasModelMapJson !== null
        ? parseAliasModelMapJson(rows.aliasModelMapJson).aliasMap
        : rows.configOwned
          ? {}
          : parseAliasModelMapJson(this.bootstrapConfig.aliasModelMapJson)
              .aliasMap;

    const candidateAliasMap = update.aliasModelMap
      ? this.validateAliasModelMap(update.aliasModelMap)
      : currentAliasMap;

    const candidateDefaultAlias =
      update.defaultAlias !== undefined
        ? this.validateDefaultAlias(update.defaultAlias)
        : rows.defaultAlias?.trim() ||
          (!rows.configOwned ? this.bootstrapConfig.defaultAlias.trim() : '') ||
          DEFAULT_EXECUTOR_ALIAS;

    const effectiveAliasMap = {
      ...EXECUTOR_COMPATIBILITY_ALIAS_MODEL_SEEDS,
      ...candidateAliasMap,
    };
    if (!effectiveAliasMap[candidateDefaultAlias]) {
      throw new ExecutorSettingsValidationError(
        'invalid_default_alias',
        `Default alias "${candidateDefaultAlias}" is not mapped to a configured or seed alias`,
      );
    }

    const baseUrl =
      update.anthropicBaseUrl !== undefined
        ? this.validateBaseUrl(update.anthropicBaseUrl)
        : rows.baseUrl !== null
          ? rows.baseUrl
          : rows.configOwned
            ? ''
            : this.bootstrapConfig.baseUrl;

    const apiKey =
      update.anthropicApiKey !== undefined
        ? this.validateSecretInput(update.anthropicApiKey, 'API key')
        : rows.apiKey;
    const oauthToken =
      update.claudeOauthToken !== undefined
        ? this.validateSecretInput(update.claudeOauthToken, 'OAuth token')
        : rows.oauthToken;
    const authToken =
      update.anthropicAuthToken !== undefined
        ? this.validateSecretInput(update.anthropicAuthToken, 'Auth token')
        : rows.authToken;

    const updatedAt = new Date().toISOString();
    const nextVersion = rows.configVersion + 1;
    const tx = getDb().transaction(() => {
      this.upsertSettingRow(
        EXECUTOR_KEY_ALIAS_MODEL_MAP,
        persistableAliasModelMapJson(candidateAliasMap),
        updatedAt,
        userId,
      );
      this.upsertSettingRow(
        EXECUTOR_KEY_DEFAULT_ALIAS,
        candidateDefaultAlias,
        updatedAt,
        userId,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_BASE_URL,
        baseUrl,
        updatedAt,
        userId,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_API_KEY,
        apiKey,
        updatedAt,
        userId,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_OAUTH_TOKEN,
        oauthToken,
        updatedAt,
        userId,
      );
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_AUTH_TOKEN,
        authToken,
        updatedAt,
        userId,
      );
      this.upsertSettingRow(
        EXECUTOR_KEY_CONFIG_VERSION,
        String(nextVersion),
        updatedAt,
        userId,
      );
      this.upsertSettingRow(
        EXECUTOR_KEY_CONFIG_OWNED,
        'true',
        updatedAt,
        userId,
      );
    });

    tx();
    return this.getSettingsView();
  }

  captureRunningSnapshot(
    config: ResolvedExecutorConfig,
    configVersion: number,
  ): void {
    this.runningSnapshot = {
      mode: snapshotMode(config),
      effectiveAliasMap: config.effectiveAliasMap,
      defaultAlias: config.defaultAlias,
      hasProviderAuth: config.hasProviderAuth,
      hasValidAliasMap: config.hasValidAliasMap,
      configErrors: config.configErrors,
      configVersion,
      isConfigured: config.configOwned,
    };
  }

  getRunningSnapshot(): RunningConfigSnapshot | null {
    return this.runningSnapshot;
  }

  getConfigVersion(): number {
    return this.readStoredRows().configVersion;
  }

  computeRestartReasons(): string[] {
    const running = this.runningSnapshot;
    if (!running) return [];

    const candidate = this.resolveEffectiveConfig();
    const reasons: string[] = [];
    const candidateMode = snapshotMode(candidate);

    if (running.mode !== candidateMode) {
      reasons.push(
        `Executor mode would change from ${running.mode} to ${candidateMode}`,
      );
    }
    if (
      stableJson(running.effectiveAliasMap) !==
      stableJson(candidate.effectiveAliasMap)
    ) {
      reasons.push('Alias model map changed');
    }
    if (running.defaultAlias !== candidate.defaultAlias) {
      reasons.push(
        `Default alias changed from ${running.defaultAlias} to ${candidate.defaultAlias}`,
      );
    }

    return reasons;
  }

  getExecutorSecrets(): Record<string, string> {
    let rows: StoredRows;
    try {
      rows = this.readStoredRows();
    } catch (error) {
      logger.warn(
        { err: error },
        'Failed to load executor secrets from settings DB',
      );
      return {};
    }
    const output: Record<string, string> = {};

    if (rows.oauthToken) output.CLAUDE_CODE_OAUTH_TOKEN = rows.oauthToken;
    if (rows.apiKey) output.ANTHROPIC_API_KEY = rows.apiKey;
    if (rows.authToken) output.ANTHROPIC_AUTH_TOKEN = rows.authToken;
    if (rows.baseUrl) output.ANTHROPIC_BASE_URL = rows.baseUrl;

    return output;
  }

  resolveDetectedAuthMethod(): DetectedAuthMethod {
    return detectAuthMethod(this.readStoredRows());
  }

  getBootId(): string {
    return PROCESS_BOOT_ID;
  }

  getStartupAgeMs(): number {
    return Date.now() - this.startupAnchorMs;
  }

  isRestartSupported(): boolean {
    return process.env[SELF_RESTART_ENV] === '1';
  }

  getSettingsView(): ExecutorSettingsView {
    const config = this.resolveEffectiveConfig();
    const rows = this.readStoredRows();
    const lastUpdated = this.getLastUpdatedMeta();

    return {
      configuredAliasMap: config.configuredAliasMap,
      effectiveAliasMap: config.effectiveAliasMap,
      defaultAlias: config.defaultAlias,
      hasApiKey: Boolean(rows.apiKey),
      hasOauthToken: Boolean(rows.oauthToken),
      hasAuthToken: Boolean(rows.authToken),
      anthropicBaseUrl: config.anthropicBaseUrl,
      isConfigured: config.configOwned,
      configVersion: rows.configVersion,
      lastUpdatedAt: lastUpdated.updatedAt,
      lastUpdatedBy: lastUpdated.updatedBy,
      configErrors: config.configErrors,
    };
  }

  getStatusView(): ExecutorStatusView {
    const config = this.resolveEffectiveConfig();
    return {
      mode: this.runningSnapshot?.mode || snapshotMode(config),
      restartSupported: this.isRestartSupported(),
      pendingRestartReasons: this.computeRestartReasons(),
      activeRunCount: countRunningTalkRuns(),
      hasProviderAuth: config.hasProviderAuth,
      hasValidAliasMap: config.hasValidAliasMap,
      detectedAuthMethod: this.resolveDetectedAuthMethod(),
      configVersion: config.configVersion,
      isConfigured: config.configOwned,
      bootId: this.getBootId(),
      configErrors: config.configErrors,
    };
  }

  private readStoredRows(): StoredRows {
    const rows = getDb()
      .prepare(
        `
        SELECT key, value, updated_at, updated_by
        FROM settings_kv
        WHERE key LIKE 'executor.%'
      `,
      )
      .all() as SettingRow[];

    const byKey = new Map(rows.map((row) => [row.key, row]));

    return {
      configOwned: byKey.get(EXECUTOR_KEY_CONFIG_OWNED)?.value === 'true',
      configVersion:
        Number.parseInt(
          byKey.get(EXECUTOR_KEY_CONFIG_VERSION)?.value ?? '0',
          10,
        ) || 0,
      apiKey: byKey.get(EXECUTOR_KEY_API_KEY)?.value ?? null,
      oauthToken: byKey.get(EXECUTOR_KEY_OAUTH_TOKEN)?.value ?? null,
      authToken: byKey.get(EXECUTOR_KEY_AUTH_TOKEN)?.value ?? null,
      baseUrl: byKey.get(EXECUTOR_KEY_BASE_URL)?.value ?? null,
      aliasModelMapJson: byKey.get(EXECUTOR_KEY_ALIAS_MODEL_MAP)?.value ?? null,
      defaultAlias: byKey.get(EXECUTOR_KEY_DEFAULT_ALIAS)?.value ?? null,
    };
  }

  private getLastUpdatedMeta(): {
    updatedAt: string | null;
    updatedBy: SettingsActor | null;
  } {
    const row = getDb()
      .prepare(
        `
        SELECT
          sk.updated_at AS updated_at,
          sk.updated_by AS updated_by,
          u.display_name AS display_name
        FROM settings_kv sk
        LEFT JOIN users u ON u.id = sk.updated_by
        WHERE sk.key LIKE ?
        ORDER BY sk.updated_at DESC, sk.key DESC
        LIMIT 1
      `,
      )
      .get(`${EXECUTOR_SETTINGS_PREFIX}%`) as
      | {
          updated_at: string;
          updated_by: string | null;
          display_name: string | null;
        }
      | undefined;

    if (!row) {
      return { updatedAt: null, updatedBy: null };
    }

    if (!row.updated_by) {
      return { updatedAt: row.updated_at, updatedBy: null };
    }

    return {
      updatedAt: row.updated_at,
      updatedBy: {
        id: row.updated_by,
        displayName: row.display_name || 'Unknown user',
      },
    };
  }

  private upsertSettingRow(
    key: string,
    value: string,
    updatedAt: string,
    updatedBy: string | null,
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
      .run(key, value, updatedAt, updatedBy);
  }

  private writeOptionalSettingRow(
    key: string,
    value: string | null,
    updatedAt: string,
    updatedBy: string | null,
  ): void {
    if (!value) {
      getDb().prepare(`DELETE FROM settings_kv WHERE key = ?`).run(key);
      return;
    }
    this.upsertSettingRow(key, value, updatedAt, updatedBy);
  }

  private validateAliasModelMap(
    aliasModelMap: Record<string, string>,
  ): Record<string, string> {
    const { aliasMap, errors } = normalizeAliasModelMapObject(aliasModelMap);
    if (errors.length > 0) {
      throw new ExecutorSettingsValidationError(
        'invalid_alias_model_map',
        'Alias map contains invalid entries',
        errors,
      );
    }
    return aliasMap;
  }

  private validateDefaultAlias(value: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new ExecutorSettingsValidationError(
        'default_alias_required',
        'Default alias is required',
      );
    }
    return normalized;
  }

  private validateSecretInput(
    value: string | null,
    label: string,
  ): string | null {
    if (value === null) return null;
    const normalized = value.trim();
    if (!normalized) {
      throw new ExecutorSettingsValidationError(
        'invalid_secret_value',
        `${label} must be a non-empty string`,
      );
    }
    return normalized;
  }

  private validateBaseUrl(value: string | null): string | null {
    if (value === null) return null;
    const normalized = normalizeUrl(value);
    if (!normalized) {
      throw new ExecutorSettingsValidationError(
        'invalid_base_url',
        'Anthropic base URL must be a non-empty absolute URL or null',
      );
    }
    try {
      new URL(normalized);
    } catch {
      throw new ExecutorSettingsValidationError(
        'invalid_base_url',
        'Anthropic base URL must be a valid absolute URL',
      );
    }
    return normalized;
  }
}

let activeExecutorSettingsService: ExecutorSettingsService | null = null;

export function setActiveExecutorSettingsService(
  service: ExecutorSettingsService,
): void {
  activeExecutorSettingsService = service;
}

export function getActiveExecutorSettingsService(): ExecutorSettingsService {
  if (!activeExecutorSettingsService) {
    activeExecutorSettingsService = new ExecutorSettingsService();
  }
  return activeExecutorSettingsService;
}

/** @internal - for tests only. */
export function _resetActiveExecutorSettingsServiceForTests(): void {
  activeExecutorSettingsService = null;
}
