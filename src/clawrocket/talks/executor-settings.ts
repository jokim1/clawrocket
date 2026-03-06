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
import { fingerprintStableJson, stableJson } from './json-fingerprint.js';

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
export type ExecutorAuthMode =
  | 'subscription'
  | 'api_key'
  | 'advanced_bearer'
  | 'none';
export type ExecutorVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';
export type VerifiableExecutorAuthMode = Exclude<ExecutorAuthMode, 'none'>;

const EXECUTOR_SETTINGS_PREFIX = 'executor.';
const EXECUTOR_KEY_API_KEY = 'executor.anthropicApiKey';
const EXECUTOR_KEY_OAUTH_TOKEN = 'executor.claudeOauthToken';
const EXECUTOR_KEY_AUTH_TOKEN = 'executor.anthropicAuthToken';
const EXECUTOR_KEY_AUTH_MODE = 'executor.authMode';
const EXECUTOR_KEY_AUTH_VERIFICATION = 'executor.authVerification';
const EXECUTOR_KEY_BASE_URL = 'executor.anthropicBaseUrl';
const EXECUTOR_KEY_ALIAS_MODEL_MAP = 'executor.aliasModelMap';
const EXECUTOR_KEY_DEFAULT_ALIAS = 'executor.defaultAlias';
const EXECUTOR_KEY_CONFIG_VERSION = 'executor.configVersion';
const EXECUTOR_KEY_CONFIG_OWNED = 'executor.configOwned';

const DEFAULT_EXECUTOR_ALIAS = 'Mock';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
const SELF_RESTART_ENV = 'CLAWROCKET_SELF_RESTART';
const VERIFICATION_STALE_MS = 2 * 60 * 1000;
const VERIFIABLE_EXECUTOR_AUTH_MODES: VerifiableExecutorAuthMode[] = [
  'subscription',
  'api_key',
  'advanced_bearer',
];

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
  authMode: ExecutorAuthMode | null;
  authVerificationJson: string | null;
  baseUrl: string | null;
  aliasModelMapJson: string | null;
  defaultAlias: string | null;
}

interface AuthModeResolution {
  mode: ExecutorAuthMode;
  needsExplicitSelection: boolean;
  inferred: boolean;
}

interface VerificationStateRecord {
  status: 'not_verified' | 'verifying' | 'verified' | 'invalid' | 'unavailable';
  fingerprint: string | null;
  verificationStartedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
}

type VerificationStateMap = Partial<
  Record<VerifiableExecutorAuthMode, VerificationStateRecord>
>;

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
  executorAuthMode: ExecutorAuthMode;
  anthropicBaseUrl: string;
  configOwned: boolean;
  configVersion: number;
  activeCredentialConfigured: boolean;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
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
  executorAuthMode: ExecutorAuthMode;
  hasApiKey: boolean;
  hasOauthToken: boolean;
  hasAuthToken: boolean;
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
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
  executorAuthMode: ExecutorAuthMode;
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  hasProviderAuth: boolean;
  hasValidAliasMap: boolean;
  configVersion: number;
  isConfigured: boolean;
  bootId: string;
  configErrors: string[];
}

export interface ExecutorConfigUpdate {
  executorAuthMode?: ExecutorAuthMode;
  anthropicApiKey?: string | null;
  claudeOauthToken?: string | null;
  anthropicAuthToken?: string | null;
  anthropicBaseUrl?: string | null;
  aliasModelMap?: Record<string, string>;
  defaultAlias?: string;
}

export interface ExecutorVerificationTarget {
  mode: VerifiableExecutorAuthMode;
  fingerprint: string;
  anthropicBaseUrl: string;
  credential: string;
  model: string;
}

export interface ExecutorSubscriptionImportResult {
  status: 'imported' | 'no_change';
  settings: ExecutorSettingsView;
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

function normalizeUrl(value: string | null | undefined): string {
  return (value || '').trim();
}

function isExecutorAuthMode(value: string | null): value is ExecutorAuthMode {
  return (
    value === 'subscription' ||
    value === 'api_key' ||
    value === 'advanced_bearer' ||
    value === 'none'
  );
}

function usesCustomBaseUrl(mode: ExecutorAuthMode): boolean {
  return mode === 'api_key' || mode === 'advanced_bearer';
}

function getModeCredential(
  mode: ExecutorAuthMode,
  rows: Pick<StoredRows, 'apiKey' | 'oauthToken' | 'authToken'>,
): string | null {
  switch (mode) {
    case 'subscription':
      return rows.oauthToken;
    case 'api_key':
      return rows.apiKey;
    case 'advanced_bearer':
      return rows.authToken;
    default:
      return null;
  }
}

function resolveAuthMode(rows: StoredRows): AuthModeResolution {
  if (rows.authMode && isExecutorAuthMode(rows.authMode)) {
    return {
      mode: rows.authMode,
      needsExplicitSelection: false,
      inferred: false,
    };
  }

  const hasApiKey = Boolean(rows.apiKey);
  const hasOauthToken = Boolean(rows.oauthToken);
  const hasAuthToken = Boolean(rows.authToken);

  if (hasAuthToken && (hasApiKey || hasOauthToken)) {
    return {
      mode: 'none',
      needsExplicitSelection: true,
      inferred: false,
    };
  }

  // Deliberately prefer API-key mode when both API key and OAuth are stored.
  // This matches Claude Code behavior where API-key auth takes precedence over
  // subscription auth when both credential types are configured.
  if (hasApiKey) {
    return {
      mode: 'api_key',
      needsExplicitSelection: false,
      inferred: true,
    };
  }

  if (hasOauthToken) {
    return {
      mode: 'subscription',
      needsExplicitSelection: false,
      inferred: true,
    };
  }

  if (hasAuthToken) {
    return {
      mode: 'advanced_bearer',
      needsExplicitSelection: false,
      inferred: true,
    };
  }

  return {
    mode: 'none',
    needsExplicitSelection: false,
    inferred: false,
  };
}

function fingerprint(input: unknown): string {
  return fingerprintStableJson(input);
}

function computeModeFingerprint(
  mode: VerifiableExecutorAuthMode,
  rows: Pick<StoredRows, 'apiKey' | 'oauthToken' | 'authToken' | 'baseUrl'>,
): string | null {
  const credential = getModeCredential(mode, rows);
  if (!credential) return null;
  return fingerprint({
    mode,
    credential,
    baseUrl: usesCustomBaseUrl(mode) ? normalizeUrl(rows.baseUrl) : '',
  });
}

function createNotVerifiedState(
  fingerprintValue: string,
  previous?: VerificationStateRecord,
): VerificationStateRecord {
  return {
    status: 'not_verified',
    fingerprint: fingerprintValue,
    verificationStartedAt: null,
    lastVerifiedAt: previous?.lastVerifiedAt ?? null,
    lastVerificationError: null,
  };
}

function normalizeVerificationRecord(
  raw: unknown,
): VerificationStateRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const candidate = raw as Record<string, unknown>;
  const status = candidate.status;
  if (
    status !== 'not_verified' &&
    status !== 'verifying' &&
    status !== 'verified' &&
    status !== 'invalid' &&
    status !== 'unavailable'
  ) {
    return null;
  }

  return {
    status,
    fingerprint:
      typeof candidate.fingerprint === 'string' ? candidate.fingerprint : null,
    verificationStartedAt:
      typeof candidate.verificationStartedAt === 'string'
        ? candidate.verificationStartedAt
        : null,
    lastVerifiedAt:
      typeof candidate.lastVerifiedAt === 'string'
        ? candidate.lastVerifiedAt
        : null,
    lastVerificationError:
      typeof candidate.lastVerificationError === 'string'
        ? candidate.lastVerificationError
        : null,
  };
}

function parseVerificationStateJson(
  rawJson: string | null,
): VerificationStateMap {
  if (!rawJson || !rawJson.trim()) return {};

  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const next: VerificationStateMap = {};
    for (const mode of VERIFIABLE_EXECUTOR_AUTH_MODES) {
      const record = normalizeVerificationRecord(parsed[mode]);
      if (record) {
        next[mode] = record;
      }
    }
    return next;
  } catch {
    return {};
  }
}

function stringifyVerificationState(
  state: VerificationStateMap,
): string | null {
  const normalized = Object.fromEntries(
    VERIFIABLE_EXECUTOR_AUTH_MODES.flatMap((mode) =>
      state[mode] ? [[mode, state[mode]]] : [],
    ),
  );
  return Object.keys(normalized).length > 0 ? JSON.stringify(normalized) : null;
}

function deriveVerificationStatus(
  mode: ExecutorAuthMode,
  rows: StoredRows,
  state: VerificationStateMap,
): {
  activeCredentialConfigured: boolean;
  verificationStatus: ExecutorVerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
} {
  if (mode === 'none') {
    return {
      activeCredentialConfigured: false,
      verificationStatus: 'missing',
      lastVerifiedAt: null,
      lastVerificationError: null,
    };
  }

  const credential = getModeCredential(mode, rows);
  if (!credential) {
    return {
      activeCredentialConfigured: false,
      verificationStatus: 'missing',
      lastVerifiedAt: null,
      lastVerificationError: null,
    };
  }

  const record = state[mode];
  if (!record) {
    return {
      activeCredentialConfigured: true,
      verificationStatus: 'not_verified',
      lastVerifiedAt: null,
      lastVerificationError: null,
    };
  }

  return {
    activeCredentialConfigured: true,
    verificationStatus: record.status,
    lastVerifiedAt: record.lastVerifiedAt,
    lastVerificationError: record.lastVerificationError,
  };
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
  private rowsCache: {
    fingerprint: string;
    rows: StoredRows;
    nextReconcileAt: number | null;
  } | null = null;

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
    const authModeResolution = resolveAuthMode(rows);
    const verificationState = parseVerificationStateJson(
      rows.authVerificationJson,
    );

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

    if (
      rows.configOwned &&
      anthropicBaseUrl &&
      usesCustomBaseUrl(authModeResolution.mode)
    ) {
      try {
        new URL(anthropicBaseUrl);
      } catch {
        configErrors.push('Anthropic base URL must be a valid absolute URL');
      }
    }

    if (authModeResolution.needsExplicitSelection) {
      configErrors.push(
        'Multiple Anthropic credential types are stored. Select an active auth mode before running the core executor.',
      );
    }

    const verification = deriveVerificationStatus(
      authModeResolution.mode,
      rows,
      verificationState,
    );

    return {
      configuredAliasMap,
      effectiveAliasMap,
      defaultAlias,
      executorAuthMode: authModeResolution.mode,
      anthropicBaseUrl,
      configOwned: rows.configOwned,
      configVersion: rows.configVersion,
      activeCredentialConfigured: verification.activeCredentialConfigured,
      hasProviderAuth: verification.activeCredentialConfigured,
      hasValidAliasMap,
      verificationStatus: verification.verificationStatus,
      lastVerifiedAt: verification.lastVerifiedAt,
      lastVerificationError: verification.lastVerificationError,
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
      if (config.executorAuthMode !== 'none') {
        this.upsertSettingRow(
          EXECUTOR_KEY_AUTH_MODE,
          config.executorAuthMode,
          updatedAt,
          null,
        );
      }
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

    const nextRowsPreview: StoredRows = {
      ...rows,
      apiKey,
      oauthToken,
      authToken,
      baseUrl,
    };
    const authModeResolution = resolveAuthMode(nextRowsPreview);
    const candidateAuthMode =
      update.executorAuthMode !== undefined
        ? this.validateAuthMode(update.executorAuthMode)
        : authModeResolution.mode;
    const shouldPersistAuthMode =
      update.executorAuthMode !== undefined ||
      !authModeResolution.needsExplicitSelection;
    const nextVerification = this.reconcileVerificationStateForConfigChange(
      rows,
      {
        apiKey,
        oauthToken,
        authToken,
        baseUrl,
      },
      parseVerificationStateJson(rows.authVerificationJson),
    );

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
      if (shouldPersistAuthMode) {
        this.upsertSettingRow(
          EXECUTOR_KEY_AUTH_MODE,
          candidateAuthMode,
          updatedAt,
          userId,
        );
      }
      this.writeOptionalSettingRow(
        EXECUTOR_KEY_AUTH_VERIFICATION,
        stringifyVerificationState(nextVerification),
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

  importSubscriptionCredential(
    credential: string,
    userId: string,
  ): ExecutorSubscriptionImportResult {
    const normalized = this.validateSecretInput(
      credential,
      'OAuth token',
    );
    const rows = this.readStoredRows();
    const authModeResolution = resolveAuthMode(rows);
    if (
      rows.oauthToken === normalized &&
      authModeResolution.mode === 'subscription' &&
      !authModeResolution.needsExplicitSelection
    ) {
      return {
        status: 'no_change',
        settings: this.getSettingsView(),
      };
    }

    const settings = this.saveExecutorConfig(
      {
        executorAuthMode: 'subscription',
        claudeOauthToken: normalized,
      },
      userId,
    );

    return {
      status: 'imported',
      settings,
    };
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

    const authModeResolution = resolveAuthMode(rows);
    const output: Record<string, string> = {};

    switch (authModeResolution.mode) {
      case 'subscription':
        if (rows.oauthToken) {
          output.CLAUDE_CODE_OAUTH_TOKEN = rows.oauthToken;
        }
        break;
      case 'api_key':
        if (rows.apiKey) {
          output.ANTHROPIC_API_KEY = rows.apiKey;
        }
        break;
      case 'advanced_bearer':
        if (rows.authToken) {
          output.ANTHROPIC_AUTH_TOKEN = rows.authToken;
        }
        break;
      default:
        break;
    }

    if (rows.baseUrl && usesCustomBaseUrl(authModeResolution.mode)) {
      output.ANTHROPIC_BASE_URL = rows.baseUrl;
    }

    return output;
  }

  getExecutionBlockedReason(): string | null {
    const rows = this.readStoredRows();
    const authModeResolution = resolveAuthMode(rows);

    if (authModeResolution.needsExplicitSelection) {
      return 'Multiple Anthropic credential types are stored. Choose an active auth mode in Settings before running the core executor.';
    }

    if (authModeResolution.mode === 'none') {
      return 'Anthropic credentials are not configured for the selected core executor mode.';
    }

    if (!getModeCredential(authModeResolution.mode, rows)) {
      return `Selected Anthropic auth mode "${authModeResolution.mode}" has no configured credential.`;
    }

    if (usesCustomBaseUrl(authModeResolution.mode) && rows.baseUrl) {
      try {
        new URL(rows.baseUrl);
      } catch {
        return 'Anthropic/Gateway Base URL must be a valid absolute URL.';
      }
    }

    return null;
  }

  getVerificationTarget(
    requestedMode?: ExecutorAuthMode,
  ): ExecutorVerificationTarget | null {
    const rows = this.readStoredRows();
    const config = this.resolveEffectiveConfig();
    const authModeResolution = resolveAuthMode(rows);
    const mode =
      requestedMode && requestedMode !== 'none'
        ? requestedMode
        : authModeResolution.mode;

    if (
      mode === 'none' ||
      authModeResolution.needsExplicitSelection ||
      !VERIFIABLE_EXECUTOR_AUTH_MODES.includes(mode)
    ) {
      return null;
    }

    const targetFingerprint = computeModeFingerprint(mode, rows);
    if (!targetFingerprint) return null;
    const credential = getModeCredential(mode, rows);
    if (!credential) return null;

    return {
      mode,
      fingerprint: targetFingerprint,
      anthropicBaseUrl:
        normalizeUrl(rows.baseUrl) || DEFAULT_ANTHROPIC_BASE_URL,
      credential,
      model:
        config.effectiveAliasMap[config.defaultAlias] || DEFAULT_EXECUTOR_ALIAS,
    };
  }

  markVerificationStarted(
    mode: VerifiableExecutorAuthMode,
    fingerprintValue: string,
  ): void {
    const rows = this.readStoredRows();
    const updatedAt = new Date().toISOString();
    const next = parseVerificationStateJson(rows.authVerificationJson);
    const current = next[mode];

    next[mode] = {
      status: 'verifying',
      fingerprint: fingerprintValue,
      verificationStartedAt: updatedAt,
      lastVerifiedAt: current?.lastVerifiedAt ?? null,
      lastVerificationError: null,
    };

    this.writeOptionalSettingRow(
      EXECUTOR_KEY_AUTH_VERIFICATION,
      stringifyVerificationState(next),
      updatedAt,
      null,
    );
  }

  completeVerification(
    mode: VerifiableExecutorAuthMode,
    fingerprintValue: string,
    result: {
      status: Extract<
        ExecutorVerificationStatus,
        'verified' | 'invalid' | 'unavailable'
      >;
      error?: string | null;
    },
  ): void {
    const rows = this.readStoredRows();
    const next = parseVerificationStateJson(rows.authVerificationJson);
    const current = next[mode];
    if (!current || current.fingerprint !== fingerprintValue) {
      return;
    }

    const updatedAt = new Date().toISOString();
    next[mode] = {
      status: result.status,
      fingerprint: fingerprintValue,
      verificationStartedAt: null,
      lastVerifiedAt: updatedAt,
      lastVerificationError: result.error?.trim() || null,
    };

    this.writeOptionalSettingRow(
      EXECUTOR_KEY_AUTH_VERIFICATION,
      stringifyVerificationState(next),
      updatedAt,
      null,
    );
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
      executorAuthMode: config.executorAuthMode,
      hasApiKey: Boolean(rows.apiKey),
      hasOauthToken: Boolean(rows.oauthToken),
      hasAuthToken: Boolean(rows.authToken),
      activeCredentialConfigured: config.activeCredentialConfigured,
      verificationStatus: config.verificationStatus,
      lastVerifiedAt: config.lastVerifiedAt,
      lastVerificationError: config.lastVerificationError,
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
      executorAuthMode: config.executorAuthMode,
      activeCredentialConfigured: config.activeCredentialConfigured,
      verificationStatus: config.verificationStatus,
      lastVerifiedAt: config.lastVerifiedAt,
      lastVerificationError: config.lastVerificationError,
      hasProviderAuth: config.hasProviderAuth,
      hasValidAliasMap: config.hasValidAliasMap,
      configVersion: config.configVersion,
      isConfigured: config.configOwned,
      bootId: this.getBootId(),
      configErrors: config.configErrors,
    };
  }

  private readStoredRows(): StoredRows {
    const raw = this.readStoredRowsRaw();
    const rawFingerprint = fingerprint(raw);
    const now = Date.now();

    if (
      this.rowsCache &&
      this.rowsCache.fingerprint === rawFingerprint &&
      (this.rowsCache.nextReconcileAt === null ||
        now < this.rowsCache.nextReconcileAt)
    ) {
      return this.rowsCache.rows;
    }

    const reconciled = this.reconcileStoredRows(raw);
    this.rowsCache = {
      fingerprint: fingerprint(reconciled),
      rows: reconciled,
      nextReconcileAt: this.computeNextReconcileAt(
        reconciled.authVerificationJson,
      ),
    };

    return reconciled;
  }

  private readStoredRowsRaw(): StoredRows {
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
    const authModeValue = byKey.get(EXECUTOR_KEY_AUTH_MODE)?.value ?? null;
    if (authModeValue !== null && !isExecutorAuthMode(authModeValue)) {
      logger.warn(
        { authModeValue },
        'Ignoring invalid stored executor auth mode value',
      );
    }

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
      authMode: isExecutorAuthMode(authModeValue) ? authModeValue : null,
      authVerificationJson:
        byKey.get(EXECUTOR_KEY_AUTH_VERIFICATION)?.value ?? null,
      baseUrl: byKey.get(EXECUTOR_KEY_BASE_URL)?.value ?? null,
      aliasModelMapJson: byKey.get(EXECUTOR_KEY_ALIAS_MODEL_MAP)?.value ?? null,
      defaultAlias: byKey.get(EXECUTOR_KEY_DEFAULT_ALIAS)?.value ?? null,
    };
  }

  private reconcileStoredRows(rows: StoredRows): StoredRows {
    const authModeResolution = resolveAuthMode(rows);
    const nextVerification = parseVerificationStateJson(
      rows.authVerificationJson,
    );
    let nextRows = rows;
    let authModeChanged = false;
    let verificationChanged = false;

    if (
      rows.authMode === null &&
      authModeResolution.inferred &&
      (rows.apiKey || rows.oauthToken || rows.authToken)
    ) {
      nextRows = {
        ...nextRows,
        authMode: authModeResolution.mode,
      };
      authModeChanged = true;
    }

    for (const mode of VERIFIABLE_EXECUTOR_AUTH_MODES) {
      const current = nextVerification[mode];
      const nextFingerprint = computeModeFingerprint(mode, nextRows);

      if (!nextFingerprint) {
        if (current) {
          delete nextVerification[mode];
          verificationChanged = true;
        }
        continue;
      }

      if (!current) continue;

      if (current.fingerprint !== nextFingerprint) {
        nextVerification[mode] = createNotVerifiedState(
          nextFingerprint,
          current,
        );
        verificationChanged = true;
        continue;
      }

      if (current.status === 'verifying') {
        const startedAtMs = current.verificationStartedAt
          ? Date.parse(current.verificationStartedAt)
          : Number.NaN;
        if (
          !Number.isFinite(startedAtMs) ||
          Date.now() - startedAtMs > VERIFICATION_STALE_MS
        ) {
          nextVerification[mode] = {
            ...current,
            status: 'not_verified',
            verificationStartedAt: null,
            lastVerificationError:
              'Previous verification attempt expired before completion.',
          };
          verificationChanged = true;
        }
      }
    }

    if (!authModeChanged && !verificationChanged) {
      return nextRows;
    }

    const updatedAt = new Date().toISOString();
    const tx = getDb().transaction(() => {
      if (authModeChanged && nextRows.authMode) {
        this.upsertSettingRow(
          EXECUTOR_KEY_AUTH_MODE,
          nextRows.authMode,
          updatedAt,
          null,
        );
      }
      if (verificationChanged) {
        this.writeOptionalSettingRow(
          EXECUTOR_KEY_AUTH_VERIFICATION,
          stringifyVerificationState(nextVerification),
          updatedAt,
          null,
        );
      }
    });

    tx();

    return {
      ...nextRows,
      authVerificationJson: stringifyVerificationState(nextVerification),
    };
  }

  private computeNextReconcileAt(
    authVerificationJson: string | null,
  ): number | null {
    const verificationState = parseVerificationStateJson(authVerificationJson);
    let nextReconcileAt: number | null = null;

    for (const mode of VERIFIABLE_EXECUTOR_AUTH_MODES) {
      const current = verificationState[mode];
      if (current?.status !== 'verifying') continue;
      const startedAtMs = current.verificationStartedAt
        ? Date.parse(current.verificationStartedAt)
        : Number.NaN;
      if (!Number.isFinite(startedAtMs)) {
        return Date.now();
      }
      const expiryMs = startedAtMs + VERIFICATION_STALE_MS;
      if (nextReconcileAt === null || expiryMs < nextReconcileAt) {
        nextReconcileAt = expiryMs;
      }
    }

    return nextReconcileAt;
  }

  private reconcileVerificationStateForConfigChange(
    previousRows: StoredRows,
    nextConfig: {
      apiKey: string | null;
      oauthToken: string | null;
      authToken: string | null;
      baseUrl: string | null;
    },
    currentState: VerificationStateMap,
  ): VerificationStateMap {
    const nextRows: StoredRows = {
      ...previousRows,
      ...nextConfig,
    };
    const next: VerificationStateMap = {};

    for (const mode of VERIFIABLE_EXECUTOR_AUTH_MODES) {
      const current = currentState[mode];
      const nextFingerprint = computeModeFingerprint(mode, nextRows);
      if (!nextFingerprint) continue;

      if (!current || current.fingerprint !== nextFingerprint) {
        next[mode] = createNotVerifiedState(nextFingerprint, current);
        continue;
      }

      next[mode] = current;
    }

    return next;
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
    this.rowsCache = null;
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
      this.rowsCache = null;
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

  private validateAuthMode(value: ExecutorAuthMode): ExecutorAuthMode {
    if (!isExecutorAuthMode(value)) {
      throw new ExecutorSettingsValidationError(
        'invalid_auth_mode',
        'Executor auth mode must be one of subscription, api_key, advanced_bearer, or none',
      );
    }
    return value;
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
