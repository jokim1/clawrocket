import Database from 'better-sqlite3';

import { getDb } from '../../db.js';

function computeSessionCompatKey(alias: string, model: string): string {
  // Keep this backfill logic aligned with the canonical helper in
  // talks/executor-settings.ts.
  return JSON.stringify([alias, model]);
}

function seedBuiltinTalkLlmDefaults(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO llm_providers (
        id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
        core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
        absolute_timeout_ms, updated_at, updated_by
      )
      VALUES (
        'builtin.mock',
        'Local Mock',
        'custom',
        'openai_chat_completions',
        'mock://local-talk-runtime',
        'bearer',
        1,
        'none',
        60000,
        20000,
        300000,
        ?,
        NULL
      )
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, enabled, updated_at, updated_by
      )
      VALUES (
        'builtin.mock',
        'mock-default',
        'Mock',
        64000,
        2048,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO talk_routes (id, name, enabled, updated_at, updated_by)
      VALUES ('route.default.mock', 'Local Mock Default', 1, ?, NULL)
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO talk_route_steps (route_id, position, provider_id, model_id)
      VALUES ('route.default.mock', 0, 'builtin.mock', 'mock-default')
      ON CONFLICT(route_id, position) DO NOTHING
    `,
    )
    .run();

  database
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES ('talkLlm.defaultRouteId', 'route.default.mock', ?, NULL)
      ON CONFLICT(key) DO NOTHING
    `,
    )
    .run(now);
}

function migrateLlmProvidersForNvidia(database: Database.Database): void {
  const row = database
    .prepare(
      `
      SELECT sql
      FROM sqlite_master
      WHERE type = 'table' AND name = 'llm_providers'
    `,
    )
    .get() as { sql?: string | null } | undefined;

  const sql = row?.sql || '';
  if (!sql || sql.includes("'nvidia'")) {
    return;
  }

  database.exec(`
    PRAGMA foreign_keys = OFF;

    CREATE TABLE llm_providers_new (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL
        CHECK(provider_kind IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
      api_format TEXT NOT NULL
        CHECK(api_format IN ('anthropic_messages', 'openai_chat_completions')),
      base_url TEXT NOT NULL,
      auth_scheme TEXT NOT NULL
        CHECK(auth_scheme IN ('x_api_key', 'bearer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      core_compatibility TEXT NOT NULL DEFAULT 'none'
        CHECK(core_compatibility IN ('none', 'claude_sdk_proxy')),
      response_start_timeout_ms INTEGER,
      stream_idle_timeout_ms INTEGER,
      absolute_timeout_ms INTEGER,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    INSERT INTO llm_providers_new (
      id,
      name,
      provider_kind,
      api_format,
      base_url,
      auth_scheme,
      enabled,
      core_compatibility,
      response_start_timeout_ms,
      stream_idle_timeout_ms,
      absolute_timeout_ms,
      updated_at,
      updated_by
    )
    SELECT
      id,
      name,
      provider_kind,
      api_format,
      base_url,
      auth_scheme,
      enabled,
      core_compatibility,
      response_start_timeout_ms,
      stream_idle_timeout_ms,
      absolute_timeout_ms,
      updated_at,
      updated_by
    FROM llm_providers;

    DROP TABLE llm_providers;
    ALTER TABLE llm_providers_new RENAME TO llm_providers;

    PRAGMA foreign_keys = ON;
  `);
}

function tableExists(database: Database.Database, name: string): boolean {
  const row = database
    .prepare(
      `
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `,
    )
    .get(name) as { 1: number } | undefined;
  return Boolean(row);
}

function listTableColumns(
  database: Database.Database,
  table: string,
): string[] {
  return (
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

// NOTE: This is intentionally destructive. We explicitly discard old talk-domain
// data if the DB predates the folder-tree schema because this build is treated
// as greenfield and we do not support backfilling legacy talk ordering.
function resetTalkDomainForFolderTree(database: Database.Database): void {
  if (!tableExists(database, 'talks')) {
    return;
  }

  const talkColumns = listTableColumns(database, 'talks');
  const hasFolderTreeColumns =
    talkColumns.includes('folder_id') && talkColumns.includes('sort_order');
  const hasFoldersTable = tableExists(database, 'talk_folders');
  if (hasFolderTreeColumns && hasFoldersTable) {
    return;
  }

  const talkCount =
    (database.prepare(`SELECT COUNT(*) AS count FROM talks`).get() as
      | { count: number }
      | undefined)?.count ?? 0;
  if (talkCount > 0) {
    console.warn(
      `[clawrocket] Resetting talk-domain data for folder-tree schema rollout; deleting ${talkCount} existing talks and related records.`,
    );
  }

  database.exec(`
    DROP VIEW IF EXISTS group_llm_policies;

    PRAGMA foreign_keys = OFF;

    DROP TABLE IF EXISTS llm_attempts;
    DROP TABLE IF EXISTS talk_agents;
    DROP TABLE IF EXISTS talk_executor_sessions;
    DROP TABLE IF EXISTS talk_llm_policies;
    DROP TABLE IF EXISTS talk_messages;
    DROP TABLE IF EXISTS talk_runs;
    DROP TABLE IF EXISTS talk_members;
    DROP TABLE IF EXISTS talks;
    DROP TABLE IF EXISTS talk_folders;
    DROP TABLE IF EXISTS registered_agents;
    DROP TABLE IF EXISTS talk_route_steps;
    DROP TABLE IF EXISTS talk_routes;

    PRAGMA foreign_keys = ON;
  `);
}

function createClawrocketSchema(database: Database.Database): void {
  resetTalkDomainForFolderTree(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member'
        CHECK(role IN ('owner', 'admin', 'member')),
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS user_invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      invited_by TEXT NOT NULL REFERENCES users(id),
      accepted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

    CREATE TABLE IF NOT EXISTS talk_folders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_folders_owner_sort
      ON talk_folders(owner_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES talk_folders(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      topic_title TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'archived')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talks_owner_folder_sort
      ON talks(owner_id, folder_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talk_members (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer', 'editor')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (talk_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_members_user_id ON talk_members(user_id);

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_from TEXT REFERENCES web_sessions(id),
      device_id TEXT,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user_id ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_state (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      nonce_hash TEXT NOT NULL,
      code_verifier_hash TEXT NOT NULL,
      code_verifier TEXT,
      redirect_uri TEXT NOT NULL,
      return_to TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);

    CREATE TABLE IF NOT EXISTS device_auth_codes (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'expired')),
      user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_device_auth_status_expires
      ON device_auth_codes(status, expires_at);

    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_topic_event_id
      ON event_outbox(topic, event_id);

    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      error_class TEXT NOT NULL,
      error_detail TEXT,
      attempts INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_retry_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letter_created_at ON dead_letter_queue(created_at);

    CREATE TABLE IF NOT EXISTS idempotency_cache (
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, user_id, method, path)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at ON idempotency_cache(expires_at);

    CREATE TABLE IF NOT EXISTS talk_runs (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'cancelled', 'completed', 'failed')),
      trigger_message_id TEXT REFERENCES talk_messages(id) ON DELETE SET NULL,
      target_agent_id TEXT,
      idempotency_key TEXT,
      executor_alias TEXT,
      executor_model TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      cancel_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_runs_talk_id_status
      ON talk_runs(talk_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_status_created_at
      ON talk_runs(status, created_at);

    CREATE TABLE IF NOT EXISTS talk_messages (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      role TEXT NOT NULL
        CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      run_id TEXT REFERENCES talk_runs(id) ON DELETE SET NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_messages_talk_created_at
      ON talk_messages(talk_id, created_at);

    CREATE TABLE IF NOT EXISTS talk_llm_policies (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      llm_policy TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_executor_sessions (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      executor_alias TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      session_compat_key TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL
        CHECK(provider_kind IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
      api_format TEXT NOT NULL
        CHECK(api_format IN ('anthropic_messages', 'openai_chat_completions')),
      base_url TEXT NOT NULL,
      auth_scheme TEXT NOT NULL
        CHECK(auth_scheme IN ('x_api_key', 'bearer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      core_compatibility TEXT NOT NULL DEFAULT 'none'
        CHECK(core_compatibility IN ('none', 'claude_sdk_proxy')),
      response_start_timeout_ms INTEGER,
      stream_idle_timeout_ms INTEGER,
      absolute_timeout_ms INTEGER,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_models (
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window_tokens INTEGER NOT NULL,
      default_max_output_tokens INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      PRIMARY KEY (provider_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_secrets (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_verifications (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('missing', 'not_verified', 'verified', 'invalid', 'unavailable')),
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_route_steps (
      route_id TEXT NOT NULL REFERENCES talk_routes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      PRIMARY KEY (route_id, position),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS registered_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE RESTRICT,
      model_id TEXT NOT NULL,
      route_id TEXT NOT NULL UNIQUE REFERENCES talk_routes(id) ON DELETE RESTRICT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(provider_id, model_id),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_registered_agents_enabled_name
      ON registered_agents(enabled, name);

    CREATE TABLE IF NOT EXISTS talk_agents (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      nickname_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(nickname_mode IN ('auto', 'custom')),
      source_kind TEXT NOT NULL DEFAULT 'provider'
        CHECK(source_kind IN ('claude_default', 'provider')),
      persona_role TEXT NOT NULL
        CHECK(persona_role IN ('assistant', 'analyst', 'critic', 'strategist', 'devils-advocate', 'synthesizer', 'editor')),
      -- Prevent deleting a route while Talk agents still reference it.
      route_id TEXT NOT NULL REFERENCES talk_routes(id) ON DELETE RESTRICT,
      registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
      model_id TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_agents_talk_sort
      ON talk_agents(talk_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_agents_route_id
      ON talk_agents(route_id);

    CREATE TABLE IF NOT EXISTS llm_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES talk_agents(id) ON DELETE SET NULL,
      route_id TEXT REFERENCES talk_routes(id) ON DELETE SET NULL,
      route_step_position INTEGER,
      provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
      model_id TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('success', 'failed', 'skipped', 'cancelled')),
      failure_class TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_run_id ON llm_attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_talk_id_created_at
      ON llm_attempts(talk_id, created_at);
  `);

  migrateLlmProvidersForNvidia(database);

  try {
    database.exec(`
      CREATE VIEW group_llm_policies AS
      SELECT talk_id AS group_id, llm_policy, updated_at
      FROM talk_llm_policies
    `);
  } catch {
    // view already exists
  }

  // Add access_expires_at column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE web_sessions ADD COLUMN access_expires_at TEXT`);
    database.exec(
      `UPDATE web_sessions SET access_expires_at = expires_at WHERE access_expires_at IS NULL`,
    );
  } catch {
    /* column already exists */
  }

  // Add code_verifier column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE oauth_state ADD COLUMN code_verifier TEXT`);
  } catch {
    /* column already exists */
  }

  // Add return_to column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE oauth_state ADD COLUMN return_to TEXT`);
  } catch {
    /* column already exists */
  }

  // Add trigger_message_id column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE talk_runs ADD COLUMN trigger_message_id TEXT`);
  } catch {
    /* column already exists */
  }

  // Add executor_alias column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE talk_runs ADD COLUMN executor_alias TEXT`);
  } catch {
    /* column already exists */
  }

  // Add executor_model column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE talk_runs ADD COLUMN executor_model TEXT`);
  } catch {
    /* column already exists */
  }

  // Add session_compat_key column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE talk_executor_sessions ADD COLUMN session_compat_key TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE talk_runs ADD COLUMN target_agent_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE talk_agents ADD COLUMN registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE talk_agents ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'provider' CHECK(source_kind IN ('claude_default', 'provider'))`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE talk_agents ADD COLUMN provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL`,
    );
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE talk_agents ADD COLUMN model_id TEXT`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(
      `ALTER TABLE talk_agents ADD COLUMN nickname_mode TEXT NOT NULL DEFAULT 'auto' CHECK(nickname_mode IN ('auto', 'custom'))`,
    );
  } catch {
    /* column already exists */
  }

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_talk_agents_registered_agent_id
      ON talk_agents(registered_agent_id)
  `);

  const staleSessions = database
    .prepare(
      `
      SELECT talk_id, executor_alias, executor_model
      FROM talk_executor_sessions
      WHERE session_compat_key = ''
        AND executor_alias != ''
        AND executor_model != ''
    `,
    )
    .all() as Array<{
    talk_id: string;
    executor_alias: string;
    executor_model: string;
  }>;

  if (staleSessions.length > 0) {
    const backfill = database.prepare(
      `
      UPDATE talk_executor_sessions
      SET session_compat_key = ?
      WHERE talk_id = ?
    `,
    );

    const tx = database.transaction(
      (
        rows: Array<{
          talk_id: string;
          executor_alias: string;
          executor_model: string;
        }>,
      ) => {
        for (const row of rows) {
          backfill.run(
            computeSessionCompatKey(row.executor_alias, row.executor_model),
            row.talk_id,
          );
        }
      },
    );

    tx(staleSessions);
  }

  seedBuiltinTalkLlmDefaults(database);
}

export function initClawrocketSchema(): void {
  createClawrocketSchema(getDb());
}

/** @internal - for tests only. */
export function _initClawrocketTestSchema(): void {
  createClawrocketSchema(getDb());
}
