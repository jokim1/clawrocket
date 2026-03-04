import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import {
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TalkAccessRole,
  TalkRunStatus,
  TaskRunLog,
  UserRole,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

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
      redirect_uri TEXT NOT NULL,
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
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      cancel_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_runs_talk_id_status
      ON talk_runs(talk_id, status, created_at);

    CREATE TABLE IF NOT EXISTS talk_llm_policies (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      llm_policy TEXT NOT NULL,
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

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 1 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
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
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders})
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
      AND content != '' AND content IS NOT NULL
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
        is_main: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
  };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db.prepare('SELECT * FROM registered_groups').all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
    is_main: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger:
        row.requires_trigger === null ? undefined : row.requires_trigger === 1,
      isMain: row.is_main === 1 ? true : undefined,
    };
  }
  return result;
}

// --- Identity and web session accessors ---

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export function upsertUser(input: {
  id: string;
  email: string;
  displayName: string;
  role?: UserRole;
  isActive?: boolean;
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO users (id, email, display_name, role, is_active, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      role = excluded.role,
      is_active = excluded.is_active
  `,
  ).run(
    input.id,
    input.email,
    input.displayName,
    input.role || 'member',
    input.isActive === false ? 0 : 1,
    now,
    now,
  );
}

export function getUserById(userId: string): UserRecord | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | UserRecord
    | undefined;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return db
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email) as UserRecord | undefined;
}

export function getOwnerUser(): UserRecord | undefined {
  return db
    .prepare(
      `SELECT * FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as UserRecord | undefined;
}

export function hasAnyUsers(): boolean {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM users WHERE is_active = 1')
    .get() as { count: number };
  return row.count > 0;
}

export interface WebSessionRecord {
  id: string;
  user_id: string;
  access_token_hash: string;
  refresh_token_hash: string;
  access_expires_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_from: string | null;
  device_id: string | null;
  created_at: string;
  ip_address: string | null;
  user_agent: string | null;
}

export function upsertWebSession(input: {
  id: string;
  userId: string;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt?: string;
  expiresAt: string;
  revokedAt?: string | null;
  rotatedFrom?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}): void {
  db.prepare(
    `
    INSERT INTO web_sessions (
      id, user_id, access_token_hash, refresh_token_hash, access_expires_at, expires_at, revoked_at,
      rotated_from, device_id, created_at, ip_address, user_agent
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      access_token_hash = excluded.access_token_hash,
      refresh_token_hash = excluded.refresh_token_hash,
      access_expires_at = excluded.access_expires_at,
      expires_at = excluded.expires_at,
      revoked_at = excluded.revoked_at,
      rotated_from = excluded.rotated_from,
      device_id = excluded.device_id,
      ip_address = excluded.ip_address,
      user_agent = excluded.user_agent
  `,
  ).run(
    input.id,
    input.userId,
    input.accessTokenHash,
    input.refreshTokenHash,
    input.accessExpiresAt || input.expiresAt,
    input.expiresAt,
    input.revokedAt || null,
    input.rotatedFrom || null,
    input.deviceId || null,
    new Date().toISOString(),
    input.ipAddress || null,
    input.userAgent || null,
  );
}

export function getWebSessionByAccessTokenHash(
  accessTokenHash: string,
): WebSessionRecord | undefined {
  return db
    .prepare(
      `
      SELECT * FROM web_sessions
      WHERE access_token_hash = ?
        AND revoked_at IS NULL
        AND COALESCE(access_expires_at, expires_at) > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(accessTokenHash, new Date().toISOString()) as
    | WebSessionRecord
    | undefined;
}

export function getWebSessionByRefreshTokenHash(
  refreshTokenHash: string,
): WebSessionRecord | undefined {
  return db
    .prepare(
      `
      SELECT * FROM web_sessions
      WHERE refresh_token_hash = ?
        AND revoked_at IS NULL
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(refreshTokenHash, new Date().toISOString()) as
    | WebSessionRecord
    | undefined;
}

export function revokeWebSession(sessionId: string, revokedAt?: string): void {
  db.prepare(`UPDATE web_sessions SET revoked_at = ? WHERE id = ?`).run(
    revokedAt || new Date().toISOString(),
    sessionId,
  );
}

export function revokeWebSessionChain(rootSessionId: string): void {
  const now = new Date().toISOString();
  const pending = [rootSessionId];
  const seen = new Set<string>();

  while (pending.length > 0) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    revokeWebSession(next, now);
    const children = db
      .prepare(`SELECT id FROM web_sessions WHERE rotated_from = ?`)
      .all(next) as Array<{ id: string }>;
    for (const child of children) pending.push(child.id);
  }
}

// --- Invite accessors ---

export interface UserInviteRecord {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invited_by: string;
  accepted: number;
  created_at: string;
  expires_at: string;
  accepted_at: string | null;
}

export function createUserInvite(input: {
  id: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string;
  expiresAt: string;
}): void {
  db.prepare(
    `
    INSERT INTO user_invites (
      id, email, role, invited_by, accepted, created_at, expires_at, accepted_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
  `,
  ).run(
    input.id,
    input.email.toLowerCase(),
    input.role,
    input.invitedBy,
    new Date().toISOString(),
    input.expiresAt,
  );
}

export function getActiveInviteByEmail(
  email: string,
): UserInviteRecord | undefined {
  return db
    .prepare(
      `
      SELECT *
      FROM user_invites
      WHERE email = ? COLLATE NOCASE
        AND accepted = 0
        AND expires_at > ?
      ORDER BY created_at DESC
      LIMIT 1
    `,
    )
    .get(email, new Date().toISOString()) as UserInviteRecord | undefined;
}

export function markInviteAccepted(inviteId: string): void {
  db.prepare(
    `
    UPDATE user_invites
    SET accepted = 1, accepted_at = ?
    WHERE id = ?
  `,
  ).run(new Date().toISOString(), inviteId);
}

// --- OAuth state accessors ---

export interface OAuthStateRecord {
  id: string;
  provider: string;
  state_hash: string;
  nonce_hash: string;
  code_verifier_hash: string;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export function createOAuthState(input: {
  id: string;
  provider: string;
  stateHash: string;
  nonceHash: string;
  codeVerifierHash: string;
  redirectUri: string;
  expiresAt: string;
}): void {
  db.prepare(
    `
    INSERT INTO oauth_state (
      id, provider, state_hash, nonce_hash, code_verifier_hash, redirect_uri,
      created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `,
  ).run(
    input.id,
    input.provider,
    input.stateHash,
    input.nonceHash,
    input.codeVerifierHash,
    input.redirectUri,
    new Date().toISOString(),
    input.expiresAt,
  );
}

export function consumeOAuthStateByHash(
  stateHash: string,
): OAuthStateRecord | undefined {
  const now = new Date().toISOString();
  const tx = db.transaction(
    (
      hashedState: string,
      currentTime: string,
    ): OAuthStateRecord | undefined => {
      const row = db
        .prepare(
          `
          SELECT *
          FROM oauth_state
          WHERE state_hash = ?
            AND used_at IS NULL
            AND expires_at > ?
          LIMIT 1
        `,
        )
        .get(hashedState, currentTime) as OAuthStateRecord | undefined;
      if (!row) return undefined;

      const updated = db
        .prepare(
          `
          UPDATE oauth_state
          SET used_at = ?
          WHERE id = ?
            AND used_at IS NULL
            AND expires_at > ?
        `,
        )
        .run(currentTime, row.id, currentTime);
      if (updated.changes !== 1) return undefined;

      return { ...row, used_at: currentTime };
    },
  );

  return tx(stateHash, now);
}

// --- Device auth code accessors ---

export interface DeviceAuthCodeRecord {
  id: string;
  device_code_hash: string;
  user_code_hash: string;
  status: 'pending' | 'completed' | 'expired';
  user_id: string | null;
  created_at: string;
  expires_at: string;
  completed_at: string | null;
}

export function createDeviceAuthCode(input: {
  id: string;
  deviceCodeHash: string;
  userCodeHash: string;
  expiresAt: string;
}): void {
  db.prepare(
    `
    INSERT INTO device_auth_codes (
      id, device_code_hash, user_code_hash, status, user_id, created_at, expires_at, completed_at
    ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)
  `,
  ).run(
    input.id,
    input.deviceCodeHash,
    input.userCodeHash,
    new Date().toISOString(),
    input.expiresAt,
  );
}

export function getPendingDeviceAuthCodeByDeviceHash(
  deviceCodeHash: string,
): DeviceAuthCodeRecord | undefined {
  return db
    .prepare(
      `
      SELECT *
      FROM device_auth_codes
      WHERE device_code_hash = ?
        AND status = 'pending'
        AND expires_at > ?
      LIMIT 1
    `,
    )
    .get(deviceCodeHash, new Date().toISOString()) as
    | DeviceAuthCodeRecord
    | undefined;
}

export function markDeviceAuthCodeCompleted(input: {
  id: string;
  userId: string;
}): void {
  db.prepare(
    `
    UPDATE device_auth_codes
    SET status = 'completed', user_id = ?, completed_at = ?
    WHERE id = ?
  `,
  ).run(input.userId, new Date().toISOString(), input.id);
}

// --- Talk ACL accessors ---

export interface TalkRecord {
  id: string;
  owner_id: string;
  topic_title: string | null;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export function upsertTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  status?: 'active' | 'paused' | 'archived';
}): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    INSERT INTO talks (id, owner_id, topic_title, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      topic_title = excluded.topic_title,
      status = excluded.status,
      updated_at = excluded.updated_at,
      version = talks.version + 1
  `,
  ).run(
    input.id,
    input.ownerId,
    input.topicTitle || null,
    input.status || 'active',
    now,
    now,
  );
}

export function upsertTalkMember(input: {
  talkId: string;
  userId: string;
  role: TalkAccessRole;
}): void {
  db.prepare(
    `
    INSERT INTO talk_members (talk_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(talk_id, user_id) DO UPDATE SET role = excluded.role
  `,
  ).run(input.talkId, input.userId, input.role, new Date().toISOString());
}

export function canUserAccessTalk(talkId: string, userId: string): boolean {
  const owned = db
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;

  const shared = db
    .prepare(
      'SELECT 1 AS ok FROM talk_members WHERE talk_id = ? AND user_id = ?',
    )
    .get(talkId, userId) as { ok: number } | undefined;
  return Boolean(shared);
}

export function canUserEditTalk(talkId: string, userId: string): boolean {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;

  const owned = db
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const sharedEditor = db
    .prepare(
      `
      SELECT 1 AS ok
      FROM talk_members
      WHERE talk_id = ? AND user_id = ? AND role = 'editor'
    `,
    )
    .get(talkId, userId) as { ok: number } | undefined;
  return Boolean(sharedEditor);
}

export function getTalkIdsAccessibleByUser(userId: string): string[] {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return [];
  if (user.role === 'owner' || user.role === 'admin') {
    return (
      db.prepare('SELECT id FROM talks').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  const rows = db
    .prepare(
      `
      SELECT DISTINCT t.id
      FROM talks t
      LEFT JOIN talk_members tm ON tm.talk_id = t.id
      WHERE t.owner_id = ? OR tm.user_id = ?
    `,
    )
    .all(userId, userId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

// --- Event outbox ---

export interface OutboxEvent {
  event_id: number;
  topic: string;
  event_type: string;
  payload: string;
  created_at: string;
}

export function appendOutboxEvent(input: {
  topic: string;
  eventType: string;
  payload: string;
}): number {
  const stmt = db.prepare(
    `
    INSERT INTO event_outbox (topic, event_type, payload, created_at)
    VALUES (?, ?, ?, ?)
  `,
  );
  const result = stmt.run(
    input.topic,
    input.eventType,
    input.payload,
    new Date().toISOString(),
  );
  return Number(result.lastInsertRowid);
}

export function getOutboxEventsForTopics(
  topics: string[],
  afterEventId: number,
  limit = 100,
): OutboxEvent[] {
  if (topics.length === 0) return [];
  const placeholders = topics.map(() => '?').join(',');
  return db
    .prepare(
      `
      SELECT event_id, topic, event_type, payload, created_at
      FROM event_outbox
      WHERE topic IN (${placeholders}) AND event_id > ?
      ORDER BY event_id ASC
      LIMIT ?
    `,
    )
    .all(...topics, afterEventId, limit) as OutboxEvent[];
}

export function getOutboxMinEventIdForTopics(topics: string[]): number | null {
  if (topics.length === 0) return null;
  const placeholders = topics.map(() => '?').join(',');
  const row = db
    .prepare(
      `
      SELECT MIN(event_id) AS min_event_id
      FROM event_outbox
      WHERE topic IN (${placeholders})
    `,
    )
    .get(...topics) as { min_event_id: number | null };
  return row?.min_event_id ?? null;
}

export function pruneEventOutbox(input?: {
  nowMs?: number;
  retentionHours?: number;
  keepRecentPerTopic?: number;
}): number {
  const nowMs = input?.nowMs ?? Date.now();
  const retentionMs = (input?.retentionHours ?? 72) * 60 * 60 * 1000;
  const keepRecentPerTopic = input?.keepRecentPerTopic ?? 5000;
  const cutoffIso = new Date(nowMs - retentionMs).toISOString();

  const topics = db
    .prepare('SELECT DISTINCT topic FROM event_outbox')
    .all() as Array<{ topic: string }>;
  let deleted = 0;

  for (const row of topics) {
    const threshold = db
      .prepare(
        `
        SELECT event_id
        FROM event_outbox
        WHERE topic = ?
        ORDER BY event_id DESC
        LIMIT 1 OFFSET ?
      `,
      )
      .get(row.topic, keepRecentPerTopic - 1) as
      | { event_id: number }
      | undefined;

    const result = threshold
      ? db
          .prepare(
            `
            DELETE FROM event_outbox
            WHERE topic = ?
              AND created_at < ?
              AND event_id < ?
          `,
          )
          .run(row.topic, cutoffIso, threshold.event_id)
      : db
          .prepare(
            `
            DELETE FROM event_outbox
            WHERE topic = ?
              AND created_at < ?
          `,
          )
          .run(row.topic, cutoffIso);

    deleted += result.changes;
  }

  return deleted;
}

// --- Idempotency cache ---

export interface IdempotencyCacheRecord {
  idempotency_key: string;
  user_id: string;
  method: string;
  path: string;
  request_hash: string;
  status_code: number;
  response_body: string;
  created_at: string;
  expires_at: string;
}

export function getIdempotencyCache(input: {
  userId: string;
  idempotencyKey: string;
  method: string;
  path: string;
}): IdempotencyCacheRecord | undefined {
  const row = db
    .prepare(
      `
      SELECT *
      FROM idempotency_cache
      WHERE user_id = ?
        AND idempotency_key = ?
        AND method = ?
        AND path = ?
        AND expires_at > ?
      LIMIT 1
    `,
    )
    .get(
      input.userId,
      input.idempotencyKey,
      input.method.toUpperCase(),
      input.path,
      new Date().toISOString(),
    ) as IdempotencyCacheRecord | undefined;
  return row;
}

export function saveIdempotencyCache(input: IdempotencyCacheRecord): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO idempotency_cache (
      idempotency_key, user_id, method, path, request_hash, status_code,
      response_body, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.idempotency_key,
    input.user_id,
    input.method.toUpperCase(),
    input.path,
    input.request_hash,
    input.status_code,
    input.response_body,
    input.created_at,
    input.expires_at,
  );
}

export function pruneIdempotencyCache(nowMs?: number): number {
  const nowIso = new Date(nowMs ?? Date.now()).toISOString();
  const result = db
    .prepare('DELETE FROM idempotency_cache WHERE expires_at <= ?')
    .run(nowIso);
  return result.changes;
}

// --- Dead-letter queue ---

export interface DeadLetterRecord {
  id: string;
  source_type: string;
  source_id: string;
  payload: string;
  error_class: string;
  error_detail: string | null;
  attempts: number;
  created_at: string;
  last_retry_at: string | null;
  resolved_at: string | null;
}

export function scanDeadLetterQueue(limit = 50): DeadLetterRecord[] {
  return db
    .prepare(
      `
      SELECT *
      FROM dead_letter_queue
      WHERE resolved_at IS NULL
      ORDER BY created_at ASC
      LIMIT ?
    `,
    )
    .all(limit) as DeadLetterRecord[];
}

// --- Talk runs ---

export interface TalkRunRecord {
  id: string;
  talk_id: string;
  requested_by: string;
  status: TalkRunStatus;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
}

export function createTalkRun(input: TalkRunRecord): void {
  db.prepare(
    `
    INSERT INTO talk_runs (
      id, talk_id, requested_by, status, idempotency_key, created_at,
      started_at, ended_at, cancel_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    input.id,
    input.talk_id,
    input.requested_by,
    input.status,
    input.idempotency_key,
    input.created_at,
    input.started_at,
    input.ended_at,
    input.cancel_reason,
  );
}

export function getTalkRunById(runId: string): TalkRunRecord | null {
  const row = db.prepare('SELECT * FROM talk_runs WHERE id = ?').get(runId) as
    | TalkRunRecord
    | undefined;
  return row || null;
}

export function getRunningTalkRun(talkId: string): TalkRunRecord | null {
  const row = db
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id = ? AND status = 'running'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(talkId) as TalkRunRecord | undefined;
  return row || null;
}

export function getQueuedTalkRuns(
  talkId: string,
  limit?: number,
): TalkRunRecord[] {
  if (limit && limit > 0) {
    return db
      .prepare(
        `
        SELECT *
        FROM talk_runs
        WHERE talk_id = ? AND status = 'queued'
        ORDER BY created_at ASC
        LIMIT ?
      `,
      )
      .all(talkId, limit) as TalkRunRecord[];
  }
  return db
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE talk_id = ? AND status = 'queued'
      ORDER BY created_at ASC
    `,
    )
    .all(talkId) as TalkRunRecord[];
}

export function markTalkRunStatus(
  runId: string,
  status: TalkRunStatus,
  endedAt: string | null,
  cancelReason: string | null,
  startedAt?: string | null,
): void {
  db.prepare(
    `
    UPDATE talk_runs
    SET status = ?,
        ended_at = ?,
        cancel_reason = ?,
        started_at = COALESCE(?, started_at)
    WHERE id = ?
  `,
  ).run(status, endedAt, cancelReason, startedAt || null, runId);
}

// --- Health ---

export function isDatabaseHealthy(): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
    return row.ok === 1;
  } catch {
    return false;
  }
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
