import Database from 'better-sqlite3';

import { getDb } from '../../db.js';

function computeSessionCompatKey(alias: string, model: string): string {
  // Keep this backfill logic aligned with the canonical helper in
  // talks/executor-settings.ts.
  return JSON.stringify([alias, model]);
}

function createClawrocketSchema(database: Database.Database): void {
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

    CREATE TABLE IF NOT EXISTS talks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      topic_title TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'archived')),
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
  `);

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
}

export function initClawrocketSchema(): void {
  createClawrocketSchema(getDb());
}

/** @internal - for tests only. */
export function _initClawrocketTestSchema(): void {
  createClawrocketSchema(getDb());
}
