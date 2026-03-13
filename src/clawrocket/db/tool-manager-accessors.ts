import { randomUUID } from 'crypto';

import Database from 'better-sqlite3';

import { getDb } from '../../db.js';

type JsonMap = Record<string, unknown>;

export type ToolFamily =
  | 'saved_sources'
  | 'attachments'
  | 'web'
  | 'gmail'
  | 'google_drive'
  | 'google_docs'
  | 'google_sheets'
  | 'data_connectors';

export type ToolRegistryInstallStatus =
  | 'installed'
  | 'disabled'
  | 'unconfigured';

export type ToolRegistryHealthStatus = 'healthy' | 'degraded' | 'unavailable';

export type TalkResourceBindingKind =
  | 'google_drive_folder'
  | 'google_drive_file'
  | 'data_connector'
  | 'saved_source'
  | 'message_attachment';

export type ConfirmationType = 'mutation' | 'scope_expansion';

export type ConfirmationStatus =
  | 'pending'
  | 'approved_pending_execution'
  | 'approved_executed'
  | 'approved_failed'
  | 'rejected'
  | 'superseded';

export type AuditResultStatus = 'success' | 'failed';

export type ToolErrorCategory =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'validation'
  | 'transient'
  | 'unavailable'
  | 'user_declined'
  | 'revoked_after_confirmation';

export interface ToolRegistryEntry {
  id: string;
  family: ToolFamily;
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

export interface TalkToolGrantRecord {
  talkId: string;
  toolId: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TalkResourceBindingRecord {
  id: string;
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata: JsonMap | null;
  createdAt: string;
  createdBy: string | null;
}

export interface UserGoogleCredentialRecord {
  userId: string;
  googleSubject: string;
  email: string;
  displayName: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TalkActionConfirmationRecord {
  id: string;
  talkId: string;
  runId: string;
  toolName: string;
  confirmationType: ConfirmationType;
  status: ConfirmationStatus;
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

export interface TalkRunContinuationRecord {
  runId: string;
  talkId: string;
  routeId: string;
  routeStepPosition: number;
  providerId: string;
  modelId: string;
  apiFormat: string;
  stateJson: string;
  compacted: boolean;
  byteSize: number;
  confirmationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TalkAuditEntryRecord {
  id: string;
  talkId: string;
  runId: string;
  agentId: string | null;
  toolName: string;
  confirmationId: string | null;
  targetResourceId: string | null;
  summary: JsonMap | null;
  argsCiphertext: string | null;
  resultStatus: AuditResultStatus;
  errorCategory: ToolErrorCategory | null;
  errorMessage: string | null;
  createdAt: string;
  createdBy: string | null;
}

interface RawToolRegistryRow {
  id: string;
  family: ToolFamily;
  display_name: string;
  description: string | null;
  enabled: number;
  install_status: ToolRegistryInstallStatus;
  health_status: ToolRegistryHealthStatus;
  auth_requirements_json: string | null;
  mutates_external_state: number;
  requires_binding: number;
  default_grant: number;
  sort_order: number;
  updated_at: string;
  updated_by: string | null;
}

interface RawTalkToolGrantRow {
  talk_id: string;
  tool_id: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

interface RawTalkResourceBindingRow {
  id: string;
  talk_id: string;
  binding_kind: TalkResourceBindingKind;
  external_id: string;
  display_name: string;
  metadata_json: string | null;
  created_at: string;
  created_by: string | null;
}

interface RawUserGoogleCredentialRow {
  user_id: string;
  google_subject: string;
  email: string;
  display_name: string | null;
  scopes_json: string;
  ciphertext: string;
  access_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTalkActionConfirmationRow {
  id: string;
  talk_id: string;
  run_id: string;
  tool_name: string;
  confirmation_type: ConfirmationType;
  status: ConfirmationStatus;
  proposed_args_json: string | null;
  modified_args_json: string | null;
  preview_json: string | null;
  tool_call_id: string | null;
  requested_by: string;
  resolved_by: string | null;
  reason: string | null;
  error_category: ToolErrorCategory | null;
  error_message: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface RawTalkRunContinuationRow {
  run_id: string;
  talk_id: string;
  route_id: string;
  route_step_position: number;
  provider_id: string;
  model_id: string;
  api_format: string;
  state_json: string;
  compacted: number;
  byte_size: number;
  confirmation_id: string | null;
  created_at: string;
  updated_at: string;
}

interface RawTalkAuditEntryRow {
  id: string;
  talk_id: string;
  run_id: string;
  agent_id: string | null;
  tool_name: string;
  confirmation_id: string | null;
  target_resource_id: string | null;
  summary_json: string | null;
  args_ciphertext: string | null;
  result_status: AuditResultStatus;
  error_category: ToolErrorCategory | null;
  error_message: string | null;
  created_at: string;
  created_by: string | null;
}

function parseJsonMap(value: string | null): JsonMap | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as JsonMap;
  } catch {
    return null;
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function serializeJson(value: JsonMap | null | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function serializeStringArray(value: string[]): string {
  return JSON.stringify(value);
}

function mapToolRegistryRow(row: RawToolRegistryRow): ToolRegistryEntry {
  return {
    id: row.id,
    family: row.family,
    displayName: row.display_name,
    description: row.description,
    enabled: row.enabled === 1,
    installStatus: row.install_status,
    healthStatus: row.health_status,
    authRequirements: parseJsonMap(row.auth_requirements_json),
    mutatesExternalState: row.mutates_external_state === 1,
    requiresBinding: row.requires_binding === 1,
    defaultGrant: row.default_grant === 1,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapTalkToolGrantRow(row: RawTalkToolGrantRow): TalkToolGrantRecord {
  return {
    talkId: row.talk_id,
    toolId: row.tool_id,
    enabled: row.enabled === 1,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function mapTalkResourceBindingRow(
  row: RawTalkResourceBindingRow,
): TalkResourceBindingRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    bindingKind: row.binding_kind,
    externalId: row.external_id,
    displayName: row.display_name,
    metadata: parseJsonMap(row.metadata_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function mapUserGoogleCredentialRow(
  row: RawUserGoogleCredentialRow,
): UserGoogleCredentialRecord {
  return {
    userId: row.user_id,
    googleSubject: row.google_subject,
    email: row.email,
    displayName: row.display_name,
    scopes: parseStringArray(row.scopes_json),
    ciphertext: row.ciphertext,
    accessExpiresAt: row.access_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTalkActionConfirmationRow(
  row: RawTalkActionConfirmationRow,
): TalkActionConfirmationRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    runId: row.run_id,
    toolName: row.tool_name,
    confirmationType: row.confirmation_type,
    status: row.status,
    proposedArgs: parseJsonMap(row.proposed_args_json),
    modifiedArgs: parseJsonMap(row.modified_args_json),
    preview: parseJsonMap(row.preview_json),
    toolCallId: row.tool_call_id,
    requestedBy: row.requested_by,
    resolvedBy: row.resolved_by,
    reason: row.reason,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapTalkRunContinuationRow(
  row: RawTalkRunContinuationRow,
): TalkRunContinuationRecord {
  return {
    runId: row.run_id,
    talkId: row.talk_id,
    routeId: row.route_id,
    routeStepPosition: row.route_step_position,
    providerId: row.provider_id,
    modelId: row.model_id,
    apiFormat: row.api_format,
    stateJson: row.state_json,
    compacted: row.compacted === 1,
    byteSize: row.byte_size,
    confirmationId: row.confirmation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTalkAuditEntryRow(row: RawTalkAuditEntryRow): TalkAuditEntryRecord {
  return {
    id: row.id,
    talkId: row.talk_id,
    runId: row.run_id,
    agentId: row.agent_id,
    toolName: row.tool_name,
    confirmationId: row.confirmation_id,
    targetResourceId: row.target_resource_id,
    summary: parseJsonMap(row.summary_json),
    argsCiphertext: row.args_ciphertext,
    resultStatus: row.result_status,
    errorCategory: row.error_category,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

export const BUILTIN_TOOL_REGISTRY_DEFAULTS: ReadonlyArray<
  Omit<
    ToolRegistryEntry,
    | 'enabled'
    | 'installStatus'
    | 'healthStatus'
    | 'authRequirements'
    | 'updatedAt'
    | 'updatedBy'
  > & {
    enabled?: boolean;
    installStatus?: ToolRegistryInstallStatus;
    healthStatus?: ToolRegistryHealthStatus;
    authRequirements?: JsonMap | null;
  }
> = [
  {
    id: 'saved_sources',
    family: 'saved_sources',
    displayName: 'Saved Sources',
    description: 'Read saved Talk sources.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: true,
    sortOrder: 10,
  },
  {
    id: 'attachments',
    family: 'attachments',
    displayName: 'Message Attachments',
    description: 'Read attached Talk files.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: true,
    sortOrder: 20,
  },
  {
    id: 'web_search',
    family: 'web',
    displayName: 'Web Search',
    description: 'Search the public web.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: true,
    sortOrder: 30,
  },
  {
    id: 'web_fetch',
    family: 'web',
    displayName: 'Web Fetch',
    description: 'Fetch public web pages.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: true,
    sortOrder: 40,
  },
  {
    id: 'gmail_read',
    family: 'gmail',
    displayName: 'Gmail Read',
    description: 'Search and read mailbox content.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: false,
    sortOrder: 50,
  },
  {
    id: 'gmail_send',
    family: 'gmail',
    displayName: 'Gmail Send',
    description: 'Draft and send email.',
    mutatesExternalState: true,
    requiresBinding: false,
    defaultGrant: false,
    sortOrder: 60,
  },
  {
    id: 'google_drive_search',
    family: 'google_drive',
    displayName: 'Google Drive Search',
    description: 'Search within bound Google Drive resources.',
    mutatesExternalState: false,
    requiresBinding: true,
    defaultGrant: true,
    sortOrder: 70,
  },
  {
    id: 'google_drive_read',
    family: 'google_drive',
    displayName: 'Google Drive Read',
    description: 'Read bound Google Drive files.',
    mutatesExternalState: false,
    requiresBinding: true,
    defaultGrant: true,
    sortOrder: 80,
  },
  {
    id: 'google_drive_list_folder',
    family: 'google_drive',
    displayName: 'Google Drive List Folder',
    description: 'List bound Google Drive folders.',
    mutatesExternalState: false,
    requiresBinding: true,
    defaultGrant: true,
    sortOrder: 90,
  },
  {
    id: 'google_docs_read',
    family: 'google_docs',
    displayName: 'Google Docs Read',
    description: 'Read bound Google Docs.',
    mutatesExternalState: false,
    requiresBinding: true,
    defaultGrant: true,
    sortOrder: 100,
  },
  {
    id: 'google_docs_batch_update',
    family: 'google_docs',
    displayName: 'Google Docs Update',
    description: 'Update bound Google Docs.',
    mutatesExternalState: true,
    requiresBinding: true,
    defaultGrant: false,
    sortOrder: 110,
  },
  {
    id: 'google_sheets_read_range',
    family: 'google_sheets',
    displayName: 'Google Sheets Read',
    description: 'Read bound Google Sheets.',
    mutatesExternalState: false,
    requiresBinding: true,
    defaultGrant: true,
    sortOrder: 120,
  },
  {
    id: 'google_sheets_batch_update',
    family: 'google_sheets',
    displayName: 'Google Sheets Update',
    description: 'Update bound Google Sheets.',
    mutatesExternalState: true,
    requiresBinding: true,
    defaultGrant: false,
    sortOrder: 130,
  },
  {
    id: 'data_connectors',
    family: 'data_connectors',
    displayName: 'Data Connectors',
    description: 'Use attached Talk data connectors.',
    mutatesExternalState: false,
    requiresBinding: false,
    defaultGrant: true,
    sortOrder: 140,
  },
];

export function seedBuiltinToolRegistry(
  database: Database.Database = getDb(),
): void {
  const now = new Date().toISOString();
  const stmt = database.prepare(
    `
    INSERT INTO tool_registry_entries (
      id,
      family,
      display_name,
      description,
      enabled,
      install_status,
      health_status,
      auth_requirements_json,
      mutates_external_state,
      requires_binding,
      default_grant,
      sort_order,
      updated_at,
      updated_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET
      family = excluded.family,
      display_name = excluded.display_name,
      description = excluded.description,
      mutates_external_state = excluded.mutates_external_state,
      requires_binding = excluded.requires_binding,
      default_grant = excluded.default_grant,
      sort_order = excluded.sort_order
  `,
  );

  const tx = database.transaction(() => {
    for (const entry of BUILTIN_TOOL_REGISTRY_DEFAULTS) {
      stmt.run(
        entry.id,
        entry.family,
        entry.displayName,
        entry.description ?? null,
        entry.enabled === false ? 0 : 1,
        entry.installStatus ?? 'installed',
        entry.healthStatus ?? 'healthy',
        serializeJson(entry.authRequirements ?? null),
        entry.mutatesExternalState ? 1 : 0,
        entry.requiresBinding ? 1 : 0,
        entry.defaultGrant ? 1 : 0,
        entry.sortOrder,
        now,
      );
    }
  });
  tx();
}

export function listToolRegistryEntries(): ToolRegistryEntry[] {
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM tool_registry_entries
        ORDER BY sort_order ASC, id ASC
      `,
      )
      .all() as RawToolRegistryRow[]
  ).map(mapToolRegistryRow);
}

export function getToolRegistryEntry(
  toolId: string,
): ToolRegistryEntry | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM tool_registry_entries
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(toolId) as RawToolRegistryRow | undefined;
  return row ? mapToolRegistryRow(row) : undefined;
}

export function upsertToolRegistryEntry(input: {
  id: string;
  family: ToolFamily;
  displayName: string;
  description?: string | null;
  enabled: boolean;
  installStatus: ToolRegistryInstallStatus;
  healthStatus: ToolRegistryHealthStatus;
  authRequirements?: JsonMap | null;
  mutatesExternalState: boolean;
  requiresBinding: boolean;
  defaultGrant: boolean;
  sortOrder: number;
  updatedBy?: string | null;
}): ToolRegistryEntry {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO tool_registry_entries (
        id,
        family,
        display_name,
        description,
        enabled,
        install_status,
        health_status,
        auth_requirements_json,
        mutates_external_state,
        requires_binding,
        default_grant,
        sort_order,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        family = excluded.family,
        display_name = excluded.display_name,
        description = excluded.description,
        enabled = excluded.enabled,
        install_status = excluded.install_status,
        health_status = excluded.health_status,
        auth_requirements_json = excluded.auth_requirements_json,
        mutates_external_state = excluded.mutates_external_state,
        requires_binding = excluded.requires_binding,
        default_grant = excluded.default_grant,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by
    `,
    )
    .run(
      input.id,
      input.family,
      input.displayName,
      input.description ?? null,
      input.enabled ? 1 : 0,
      input.installStatus,
      input.healthStatus,
      serializeJson(input.authRequirements),
      input.mutatesExternalState ? 1 : 0,
      input.requiresBinding ? 1 : 0,
      input.defaultGrant ? 1 : 0,
      input.sortOrder,
      now,
      input.updatedBy ?? null,
    );

  return getToolRegistryEntry(input.id)!;
}

export function initializeTalkToolGrants(
  talkId: string,
  updatedBy: string,
): void {
  const now = new Date().toISOString();
  const registry = listToolRegistryEntries();
  const stmt = getDb().prepare(
    `
      INSERT INTO talk_tool_grants (
        talk_id,
        tool_id,
        enabled,
        updated_at,
        updated_by
      )
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(talk_id, tool_id) DO NOTHING
    `,
  );
  const tx = getDb().transaction(() => {
    for (const entry of registry) {
      stmt.run(
        talkId,
        entry.id,
        entry.enabled && entry.defaultGrant ? 1 : 0,
        now,
        updatedBy,
      );
    }
  });
  tx();
}

export function listTalkToolGrants(talkId: string): TalkToolGrantRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM talk_tool_grants
        WHERE talk_id = ?
        ORDER BY tool_id ASC
      `,
      )
      .all(talkId) as RawTalkToolGrantRow[]
  ).map(mapTalkToolGrantRow);
}

export function getTalkToolGrant(
  talkId: string,
  toolId: string,
): TalkToolGrantRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_tool_grants
      WHERE talk_id = ? AND tool_id = ?
      LIMIT 1
    `,
    )
    .get(talkId, toolId) as RawTalkToolGrantRow | undefined;
  return row ? mapTalkToolGrantRow(row) : undefined;
}

export function replaceTalkToolGrants(input: {
  talkId: string;
  grants: Array<{ toolId: string; enabled: boolean }>;
  updatedBy: string;
}): TalkToolGrantRecord[] {
  const now = new Date().toISOString();
  const deleteStmt = getDb().prepare(
    `DELETE FROM talk_tool_grants WHERE talk_id = ?`,
  );
  const insertStmt = getDb().prepare(
    `
      INSERT INTO talk_tool_grants (talk_id, tool_id, enabled, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?)
    `,
  );
  const tx = getDb().transaction(() => {
    deleteStmt.run(input.talkId);
    for (const grant of input.grants) {
      insertStmt.run(
        input.talkId,
        grant.toolId,
        grant.enabled ? 1 : 0,
        now,
        input.updatedBy,
      );
    }
  });
  tx();
  return listTalkToolGrants(input.talkId);
}

export function listTalkResourceBindings(
  talkId: string,
): TalkResourceBindingRecord[] {
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM talk_resource_bindings
        WHERE talk_id = ?
        ORDER BY created_at ASC, id ASC
      `,
      )
      .all(talkId) as RawTalkResourceBindingRow[]
  ).map(mapTalkResourceBindingRow);
}

export function createTalkResourceBinding(input: {
  talkId: string;
  bindingKind: TalkResourceBindingKind;
  externalId: string;
  displayName: string;
  metadata?: JsonMap | null;
  createdBy?: string | null;
}): TalkResourceBindingRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  const database = getDb();
  database
    .prepare(
      `
      INSERT INTO talk_resource_bindings (
        id,
        talk_id,
        binding_kind,
        external_id,
        display_name,
        metadata_json,
        created_at,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      input.bindingKind,
      input.externalId,
      input.displayName,
      serializeJson(input.metadata),
      now,
      input.createdBy ?? null,
    );

  const row = database
    .prepare(`SELECT * FROM talk_resource_bindings WHERE id = ? LIMIT 1`)
    .get(id) as RawTalkResourceBindingRow | undefined;
  if (!row) {
    throw new Error(`failed to load talk resource binding ${id}`);
  }
  return mapTalkResourceBindingRow(row);
}

export function deleteTalkResourceBinding(
  talkId: string,
  bindingId: string,
): boolean {
  const result = getDb()
    .prepare(
      `
      DELETE FROM talk_resource_bindings
      WHERE talk_id = ? AND id = ?
    `,
    )
    .run(talkId, bindingId);
  return result.changes > 0;
}

export function getUserGoogleCredential(
  userId: string,
): UserGoogleCredentialRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM user_google_credentials
      WHERE user_id = ?
      LIMIT 1
    `,
    )
    .get(userId) as RawUserGoogleCredentialRow | undefined;
  return row ? mapUserGoogleCredentialRow(row) : undefined;
}

export function upsertUserGoogleCredential(input: {
  userId: string;
  googleSubject: string;
  email: string;
  displayName?: string | null;
  scopes: string[];
  ciphertext: string;
  accessExpiresAt?: string | null;
}): UserGoogleCredentialRecord {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO user_google_credentials (
        user_id,
        google_subject,
        email,
        display_name,
        scopes_json,
        ciphertext,
        access_expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        google_subject = excluded.google_subject,
        email = excluded.email,
        display_name = excluded.display_name,
        scopes_json = excluded.scopes_json,
        ciphertext = excluded.ciphertext,
        access_expires_at = excluded.access_expires_at,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.userId,
      input.googleSubject,
      input.email,
      input.displayName ?? null,
      serializeStringArray(input.scopes),
      input.ciphertext,
      input.accessExpiresAt ?? null,
      now,
      now,
    );

  return getUserGoogleCredential(input.userId)!;
}

export function deleteUserGoogleCredential(userId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM user_google_credentials WHERE user_id = ?`)
    .run(userId);
  return result.changes > 0;
}

export function createTalkActionConfirmation(input: {
  talkId: string;
  runId: string;
  toolName: string;
  confirmationType: ConfirmationType;
  proposedArgs?: JsonMap | null;
  preview?: JsonMap | null;
  toolCallId?: string | null;
  requestedBy: string;
}): TalkActionConfirmationRecord {
  const now = new Date().toISOString();
  const id = randomUUID();
  getDb()
    .prepare(
      `
      INSERT INTO talk_action_confirmations (
        id,
        talk_id,
        run_id,
        tool_name,
        confirmation_type,
        status,
        proposed_args_json,
        modified_args_json,
        preview_json,
        tool_call_id,
        requested_by,
        resolved_by,
        reason,
        error_category,
        error_message,
        created_at,
        resolved_at
      )
      VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL)
    `,
    )
    .run(
      id,
      input.talkId,
      input.runId,
      input.toolName,
      input.confirmationType,
      serializeJson(input.proposedArgs),
      serializeJson(input.preview),
      input.toolCallId ?? null,
      input.requestedBy,
      now,
    );
  return getTalkActionConfirmationById(id)!;
}

export function getTalkActionConfirmationById(
  confirmationId: string,
): TalkActionConfirmationRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_action_confirmations
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(confirmationId) as RawTalkActionConfirmationRow | undefined;
  return row ? mapTalkActionConfirmationRow(row) : undefined;
}

export function getPendingTalkActionConfirmationForRun(
  runId: string,
): TalkActionConfirmationRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_action_confirmations
      WHERE run_id = ? AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(runId) as RawTalkActionConfirmationRow | undefined;
  return row ? mapTalkActionConfirmationRow(row) : undefined;
}

export function supersedePendingTalkActionConfirmationsForRun(input: {
  runId: string;
  resolvedBy?: string | null;
  reason?: string | null;
}): number {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE talk_action_confirmations
      SET status = 'superseded',
          modified_args_json = NULL,
          resolved_by = ?,
          reason = ?,
          error_category = NULL,
          error_message = NULL,
          resolved_at = ?
      WHERE run_id = ? AND status = 'pending'
    `,
    )
    .run(input.resolvedBy ?? null, input.reason ?? null, now, input.runId);
  return result.changes;
}

export function resolveTalkActionConfirmation(input: {
  confirmationId: string;
  status: Exclude<ConfirmationStatus, 'pending'>;
  modifiedArgs?: JsonMap | null;
  resolvedBy?: string | null;
  reason?: string | null;
  errorCategory?: ToolErrorCategory | null;
  errorMessage?: string | null;
}): TalkActionConfirmationRecord | undefined {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE talk_action_confirmations
      SET status = ?,
          modified_args_json = ?,
          resolved_by = ?,
          reason = ?,
          error_category = ?,
          error_message = ?,
          resolved_at = ?
      WHERE id = ?
    `,
    )
    .run(
      input.status,
      serializeJson(input.modifiedArgs),
      input.resolvedBy ?? null,
      input.reason ?? null,
      input.errorCategory ?? null,
      input.errorMessage ?? null,
      now,
      input.confirmationId,
    );
  return getTalkActionConfirmationById(input.confirmationId);
}

export function upsertTalkRunContinuation(input: {
  runId: string;
  talkId: string;
  routeId: string;
  routeStepPosition: number;
  providerId: string;
  modelId: string;
  apiFormat: string;
  stateJson: string;
  compacted: boolean;
  byteSize: number;
  confirmationId?: string | null;
}): TalkRunContinuationRecord {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_run_continuations (
        run_id,
        talk_id,
        route_id,
        route_step_position,
        provider_id,
        model_id,
        api_format,
        state_json,
        compacted,
        byte_size,
        confirmation_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        talk_id = excluded.talk_id,
        route_id = excluded.route_id,
        route_step_position = excluded.route_step_position,
        provider_id = excluded.provider_id,
        model_id = excluded.model_id,
        api_format = excluded.api_format,
        state_json = excluded.state_json,
        compacted = excluded.compacted,
        byte_size = excluded.byte_size,
        confirmation_id = excluded.confirmation_id,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.runId,
      input.talkId,
      input.routeId,
      input.routeStepPosition,
      input.providerId,
      input.modelId,
      input.apiFormat,
      input.stateJson,
      input.compacted ? 1 : 0,
      input.byteSize,
      input.confirmationId ?? null,
      now,
      now,
    );
  return getTalkRunContinuation(input.runId)!;
}

export function getTalkRunContinuation(
  runId: string,
): TalkRunContinuationRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_run_continuations
      WHERE run_id = ?
      LIMIT 1
    `,
    )
    .get(runId) as RawTalkRunContinuationRow | undefined;
  return row ? mapTalkRunContinuationRow(row) : undefined;
}

export function deleteTalkRunContinuation(runId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM talk_run_continuations WHERE run_id = ?`)
    .run(runId);
  return result.changes > 0;
}

export function createTalkAuditEntry(input: {
  talkId: string;
  runId: string;
  agentId?: string | null;
  toolName: string;
  confirmationId?: string | null;
  targetResourceId?: string | null;
  summary?: JsonMap | null;
  argsCiphertext?: string | null;
  resultStatus: AuditResultStatus;
  errorCategory?: ToolErrorCategory | null;
  errorMessage?: string | null;
  createdBy?: string | null;
}): TalkAuditEntryRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_audit_entries (
        id,
        talk_id,
        run_id,
        agent_id,
        tool_name,
        confirmation_id,
        target_resource_id,
        summary_json,
        args_ciphertext,
        result_status,
        error_category,
        error_message,
        created_at,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      id,
      input.talkId,
      input.runId,
      input.agentId ?? null,
      input.toolName,
      input.confirmationId ?? null,
      input.targetResourceId ?? null,
      serializeJson(input.summary),
      input.argsCiphertext ?? null,
      input.resultStatus,
      input.errorCategory ?? null,
      input.errorMessage ?? null,
      now,
      input.createdBy ?? null,
    );
  return getTalkAuditEntryById(id)!;
}

export function getTalkAuditEntryById(
  auditId: string,
): TalkAuditEntryRecord | undefined {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM talk_audit_entries
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(auditId) as RawTalkAuditEntryRow | undefined;
  return row ? mapTalkAuditEntryRow(row) : undefined;
}

export function listTalkAuditEntries(
  talkId: string,
  limit = 100,
): TalkAuditEntryRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return (
    getDb()
      .prepare(
        `
        SELECT *
        FROM talk_audit_entries
        WHERE talk_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `,
      )
      .all(talkId, normalizedLimit) as RawTalkAuditEntryRow[]
  ).map(mapTalkAuditEntryRow);
}
