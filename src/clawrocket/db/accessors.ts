import { getDb } from '../../db.js';
import {
  TalkAccessRole,
  TalkMessageRole,
  TalkRunStatus,
  UserRole,
} from '../types.js';

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
  getDb()
    .prepare(
      `
    INSERT INTO users (id, email, display_name, role, is_active, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      role = excluded.role,
      is_active = excluded.is_active
  `,
    )
    .run(
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
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(userId) as
    | UserRecord
    | undefined;
}

export function getUserByEmail(email: string): UserRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE')
    .get(email) as UserRecord | undefined;
}

export function getOwnerUser(): UserRecord | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM users WHERE role = 'owner' AND is_active = 1 ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as UserRecord | undefined;
}

export function hasAnyUsers(): boolean {
  const row = getDb()
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
  getDb()
    .prepare(
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
    )
    .run(
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
  return getDb()
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
  return getDb()
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
  getDb()
    .prepare(`UPDATE web_sessions SET revoked_at = ? WHERE id = ?`)
    .run(revokedAt || new Date().toISOString(), sessionId);
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
    const children = getDb()
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
  getDb()
    .prepare(
      `
    INSERT INTO user_invites (
      id, email, role, invited_by, accepted, created_at, expires_at, accepted_at
    ) VALUES (?, ?, ?, ?, 0, ?, ?, NULL)
  `,
    )
    .run(
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
  return getDb()
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
  getDb()
    .prepare(
      `
    UPDATE user_invites
    SET accepted = 1, accepted_at = ?
    WHERE id = ?
  `,
    )
    .run(new Date().toISOString(), inviteId);
}

// --- OAuth state accessors ---

export interface OAuthStateRecord {
  id: string;
  provider: string;
  state_hash: string;
  nonce_hash: string;
  code_verifier_hash: string;
  code_verifier: string | null;
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
  codeVerifier?: string;
  redirectUri: string;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO oauth_state (
      id, provider, state_hash, nonce_hash, code_verifier_hash, code_verifier, redirect_uri,
      created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `,
    )
    .run(
      input.id,
      input.provider,
      input.stateHash,
      input.nonceHash,
      input.codeVerifierHash,
      input.codeVerifier || null,
      input.redirectUri,
      new Date().toISOString(),
      input.expiresAt,
    );
}

export function consumeOAuthStateByHash(
  stateHash: string,
): OAuthStateRecord | undefined {
  const now = new Date().toISOString();
  const tx = getDb().transaction(
    (
      hashedState: string,
      currentTime: string,
    ): OAuthStateRecord | undefined => {
      const row = getDb()
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

      const updated = getDb()
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
  getDb()
    .prepare(
      `
    INSERT INTO device_auth_codes (
      id, device_code_hash, user_code_hash, status, user_id, created_at, expires_at, completed_at
    ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, NULL)
  `,
    )
    .run(
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
  return getDb()
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
  getDb()
    .prepare(
      `
    UPDATE device_auth_codes
    SET status = 'completed', user_id = ?, completed_at = ?
    WHERE id = ?
  `,
    )
    .run(input.userId, new Date().toISOString(), input.id);
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

export type TalkAccessLevel = 'owner' | 'admin' | 'editor' | 'viewer';

export interface TalkWithAccessRecord extends TalkRecord {
  access_role: TalkAccessLevel;
}

export interface TalkListPage {
  limit: number;
  offset: number;
}

export function normalizeTalkListPage(input?: {
  limit?: number;
  offset?: number;
}): TalkListPage {
  const limit =
    typeof input?.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 50;
  const offset =
    typeof input?.offset === 'number'
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  return { limit, offset };
}

export function createTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  status?: 'active' | 'paused' | 'archived';
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO talks (id, owner_id, topic_title, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `,
    )
    .run(
      input.id,
      input.ownerId,
      input.topicTitle || null,
      input.status || 'active',
      now,
      now,
    );
}

export function getTalkById(talkId: string): TalkRecord | undefined {
  return getDb().prepare('SELECT * FROM talks WHERE id = ?').get(talkId) as
    | TalkRecord
    | undefined;
}

export function touchTalkUpdatedAt(talkId: string, updatedAt?: string): void {
  getDb()
    .prepare('UPDATE talks SET updated_at = ? WHERE id = ?')
    .run(updatedAt || new Date().toISOString(), talkId);
}

export function listTalksForUser(input: {
  userId: string;
  limit?: number;
  offset?: number;
}): TalkWithAccessRecord[] {
  const user = getUserById(input.userId);
  if (!user || user.is_active !== 1) return [];
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });

  if (user.role === 'owner' || user.role === 'admin') {
    // Global admin/owner role is authoritative here; membership role is not surfaced.
    const accessRole = user.role === 'owner' ? 'owner' : 'admin';
    return getDb()
      .prepare(
        `
        SELECT id, owner_id, topic_title, status, version, created_at, updated_at,
               CASE WHEN owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks
        ORDER BY updated_at DESC, created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(
        input.userId,
        accessRole,
        page.limit,
        page.offset,
      ) as TalkWithAccessRecord[];
  }

  return getDb()
    .prepare(
      `
      SELECT DISTINCT
        t.id,
        t.owner_id,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      WHERE t.owner_id = ? OR tm.user_id = ?
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      page.limit,
      page.offset,
    ) as TalkWithAccessRecord[];
}

export function getTalkForUser(
  talkId: string,
  userId: string,
): TalkWithAccessRecord | undefined {
  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return undefined;

  if (user.role === 'owner' || user.role === 'admin') {
    // Global admin/owner role is authoritative here; membership role is not surfaced.
    const row = getDb()
      .prepare(
        `
        SELECT id, owner_id, topic_title, status, version, created_at, updated_at,
               CASE WHEN owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks
        WHERE id = ?
        LIMIT 1
      `,
      )
      .get(userId, user.role === 'owner' ? 'owner' : 'admin', talkId) as
      | TalkWithAccessRecord
      | undefined;
    return row;
  }

  const row = getDb()
    .prepare(
      `
      SELECT
        t.id,
        t.owner_id,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      WHERE t.id = ?
        AND (t.owner_id = ? OR tm.user_id = ?)
      LIMIT 1
    `,
    )
    .get(userId, userId, talkId, userId, userId) as
    | TalkWithAccessRecord
    | undefined;
  return row;
}

export function upsertTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  status?: 'active' | 'paused' | 'archived';
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO talks (id, owner_id, topic_title, status, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      topic_title = excluded.topic_title,
      status = excluded.status,
      updated_at = excluded.updated_at,
      version = talks.version + 1
  `,
    )
    .run(
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
  getDb()
    .prepare(
      `
    INSERT INTO talk_members (talk_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(talk_id, user_id) DO UPDATE SET role = excluded.role
  `,
    )
    .run(input.talkId, input.userId, input.role, new Date().toISOString());
}

export function canUserAccessTalk(talkId: string, userId: string): boolean {
  const owned = getDb()
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const user = getUserById(userId);
  if (!user || user.is_active !== 1) return false;
  if (user.role === 'owner' || user.role === 'admin') return true;

  const shared = getDb()
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

  const owned = getDb()
    .prepare('SELECT 1 AS ok FROM talks WHERE id = ? AND owner_id = ?')
    .get(talkId, userId) as { ok: number } | undefined;
  if (owned) return true;

  const sharedEditor = getDb()
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
      getDb().prepare('SELECT id FROM talks').all() as Array<{ id: string }>
    ).map((row) => row.id);
  }

  const rows = getDb()
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

export interface TalkMessageRecord {
  id: string;
  talk_id: string;
  role: TalkMessageRole;
  content: string;
  created_by: string | null;
  created_at: string;
  run_id: string | null;
  metadata_json: string | null;
}

export function createTalkMessage(input: {
  id: string;
  talkId: string;
  role: TalkMessageRole;
  content: string;
  createdBy?: string | null;
  runId?: string | null;
  metadataJson?: string | null;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_messages (
      id, talk_id, role, content, created_by, created_at, run_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talkId,
      input.role,
      input.content,
      input.createdBy || null,
      input.createdAt || new Date().toISOString(),
      input.runId || null,
      input.metadataJson || null,
    );
}

export function listTalkMessages(input: {
  talkId: string;
  limit?: number;
  beforeCreatedAt?: string;
}): TalkMessageRecord[] {
  const limit =
    typeof input.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 100;
  const before = input.beforeCreatedAt || null;

  const rows = getDb()
    .prepare(
      `
      SELECT id, talk_id, role, content, created_by, created_at, run_id, metadata_json
      FROM talk_messages
      WHERE talk_id = ?
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC
      LIMIT ?
    `,
    )
    .all(input.talkId, before, before, limit) as TalkMessageRecord[];

  rows.reverse();
  return rows;
}

export function getTalkMessageById(
  messageId: string,
): TalkMessageRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM talk_messages WHERE id = ?')
    .get(messageId) as TalkMessageRecord | undefined;
}

export function enqueueTalkTurnAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runId: string;
  idempotencyKey?: string | null;
  now?: string;
}): { message: TalkMessageRecord; run: TalkRunRecord } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      message: TalkMessageRecord;
      run: TalkRunRecord;
    } => {
      const now = txInput.now || new Date().toISOString();
      const running = getDb()
        .prepare(
          `
          SELECT id
          FROM talk_runs
          WHERE talk_id = ? AND status = 'running'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        )
        .get(txInput.talkId) as { id: string } | undefined;
      const status: TalkRunStatus = running ? 'queued' : 'running';

      const message: TalkMessageRecord = {
        id: txInput.messageId,
        talk_id: txInput.talkId,
        role: 'user',
        content: txInput.content,
        created_by: txInput.userId,
        created_at: now,
        run_id: null,
        metadata_json: null,
      };

      createTalkMessage({
        id: message.id,
        talkId: message.talk_id,
        role: message.role,
        content: message.content,
        createdBy: message.created_by,
        createdAt: message.created_at,
      });

      touchTalkUpdatedAt(txInput.talkId, now);

      getDb()
        .prepare(
          `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          `talk:${txInput.talkId}`,
          'message_appended',
          JSON.stringify({
            talkId: txInput.talkId,
            messageId: txInput.messageId,
            runId: txInput.runId,
            role: 'user',
            createdBy: txInput.userId,
            content: txInput.content,
            createdAt: now,
          }),
          now,
        );

      const run: TalkRunRecord = {
        id: txInput.runId,
        talk_id: txInput.talkId,
        requested_by: txInput.userId,
        status,
        trigger_message_id: txInput.messageId,
        idempotency_key: txInput.idempotencyKey || null,
        created_at: now,
        started_at: status === 'running' ? now : null,
        ended_at: null,
        cancel_reason: null,
      };

      createTalkRun(run);

      getDb()
        .prepare(
          `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          `talk:${txInput.talkId}`,
          status === 'running' ? 'talk_run_started' : 'talk_run_queued',
          JSON.stringify({
            talkId: txInput.talkId,
            runId: txInput.runId,
            triggerMessageId: txInput.messageId,
            status,
          }),
          now,
        );

      return { message, run };
    },
  );

  return tx(input);
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
  const stmt = getDb().prepare(
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
  return getDb()
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
  const row = getDb()
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

  const topics = getDb()
    .prepare('SELECT DISTINCT topic FROM event_outbox')
    .all() as Array<{ topic: string }>;
  let deleted = 0;

  for (const row of topics) {
    const threshold = getDb()
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
      ? getDb()
          .prepare(
            `
            DELETE FROM event_outbox
            WHERE topic = ?
              AND created_at < ?
              AND event_id < ?
          `,
          )
          .run(row.topic, cutoffIso, threshold.event_id)
      : getDb()
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
  const row = getDb()
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
  getDb()
    .prepare(
      `
    INSERT OR REPLACE INTO idempotency_cache (
      idempotency_key, user_id, method, path, request_hash, status_code,
      response_body, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
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
  const result = getDb()
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
  return getDb()
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
  trigger_message_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  cancel_reason: string | null;
}

export function createTalkRun(input: TalkRunRecord): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_runs (
      id, talk_id, requested_by, status, trigger_message_id, idempotency_key,
      created_at, started_at, ended_at, cancel_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talk_id,
      input.requested_by,
      input.status,
      input.trigger_message_id,
      input.idempotency_key,
      input.created_at,
      input.started_at,
      input.ended_at,
      input.cancel_reason,
    );
}

export function getTalkRunById(runId: string): TalkRunRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM talk_runs WHERE id = ?')
    .get(runId) as TalkRunRecord | undefined;
  return row || null;
}

export function getRunningTalkRun(talkId: string): TalkRunRecord | null {
  const row = getDb()
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
    return getDb()
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
  return getDb()
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

export function listRunningTalkRuns(limit = 50): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE status = 'running'
      ORDER BY created_at ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit) as TalkRunRecord[];
}

/**
 * Appends an assistant message and related outbox event.
 *
 * Safe to call inside an existing transaction (better-sqlite3 will use savepoints
 * for nested transactional scopes), and also safe as a standalone helper.
 */
export function appendAssistantMessageWithOutbox(input: {
  talkId: string;
  runId: string;
  messageId: string;
  content: string;
  createdAt?: string;
}): TalkMessageRecord {
  const tx = getDb().transaction((txInput: typeof input): TalkMessageRecord => {
    const createdAt = txInput.createdAt || new Date().toISOString();
    const message: TalkMessageRecord = {
      id: txInput.messageId,
      talk_id: txInput.talkId,
      role: 'assistant',
      content: txInput.content,
      created_by: null,
      created_at: createdAt,
      run_id: txInput.runId,
      metadata_json: null,
    };

    createTalkMessage({
      id: message.id,
      talkId: message.talk_id,
      role: message.role,
      content: message.content,
      createdBy: null,
      runId: message.run_id,
      createdAt: message.created_at,
    });

    touchTalkUpdatedAt(txInput.talkId, createdAt);
    getDb()
      .prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
      )
      .run(
        `talk:${txInput.talkId}`,
        'message_appended',
        JSON.stringify({
          talkId: txInput.talkId,
          messageId: txInput.messageId,
          runId: txInput.runId,
          role: 'assistant',
          createdBy: null,
          content: txInput.content,
          createdAt,
        }),
        createdAt,
      );

    return message;
  });

  return tx(input);
}

function promoteNextQueuedRunTx(
  talkId: string,
  now: string,
): { id: string; triggerMessageId: string | null } | null {
  const next = getDb()
    .prepare(
      `
      SELECT id, trigger_message_id
      FROM talk_runs
      WHERE talk_id = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `,
    )
    .get(talkId) as
    | { id: string; trigger_message_id: string | null }
    | undefined;
  if (!next) return null;

  const updated = getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET status = 'running',
          started_at = ?,
          ended_at = NULL,
          cancel_reason = NULL
      WHERE id = ? AND status = 'queued'
    `,
    )
    .run(now, next.id);
  if (updated.changes !== 1) return null;

  getDb()
    .prepare(
      `
    INSERT INTO event_outbox (topic, event_type, payload, created_at)
    VALUES (?, ?, ?, ?)
  `,
    )
    .run(
      `talk:${talkId}`,
      'talk_run_started',
      JSON.stringify({
        talkId,
        runId: next.id,
        triggerMessageId: next.trigger_message_id,
        status: 'running',
      }),
      now,
    );

  return { id: next.id, triggerMessageId: next.trigger_message_id };
}

export function completeRunAndPromoteNextAtomic(input: {
  runId: string;
  responseMessageId: string;
  responseContent: string;
  now?: string;
}): {
  applied: boolean;
  talkId: string | null;
  promotedRunId: string | null;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
      promotedRunId: string | null;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, trigger_message_id
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | { id: string; talk_id: string; trigger_message_id: string | null }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null, promotedRunId: null };
      }

      const completed = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'completed',
              ended_at = ?,
              cancel_reason = NULL
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(now, run.id);
      if (completed.changes !== 1) {
        return { applied: false, talkId: run.talk_id, promotedRunId: null };
      }

      const responseMessage = appendAssistantMessageWithOutbox({
        talkId: run.talk_id,
        runId: run.id,
        messageId: txInput.responseMessageId,
        content: txInput.responseContent,
        createdAt: now,
      });

      getDb()
        .prepare(
          `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          `talk:${run.talk_id}`,
          'talk_run_completed',
          JSON.stringify({
            talkId: run.talk_id,
            runId: run.id,
            triggerMessageId: run.trigger_message_id,
            responseMessageId: responseMessage.id,
          }),
          now,
        );

      const promoted = promoteNextQueuedRunTx(run.talk_id, now);
      return {
        applied: true,
        talkId: run.talk_id,
        promotedRunId: promoted?.id || null,
      };
    },
  );

  return tx(input);
}

export function failRunAndPromoteNextAtomic(input: {
  runId: string;
  errorCode: string;
  errorMessage: string;
  now?: string;
}): {
  applied: boolean;
  talkId: string | null;
  promotedRunId: string | null;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
      promotedRunId: string | null;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, trigger_message_id
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | { id: string; talk_id: string; trigger_message_id: string | null }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null, promotedRunId: null };
      }

      const failed = getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'failed',
              ended_at = ?,
              cancel_reason = ?
          WHERE id = ? AND status = 'running'
        `,
        )
        .run(
          now,
          `${txInput.errorCode}: ${txInput.errorMessage}`.slice(0, 500),
          run.id,
        );
      if (failed.changes !== 1) {
        return { applied: false, talkId: run.talk_id, promotedRunId: null };
      }

      getDb()
        .prepare(
          `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
        )
        .run(
          `talk:${run.talk_id}`,
          'talk_run_failed',
          JSON.stringify({
            talkId: run.talk_id,
            runId: run.id,
            triggerMessageId: run.trigger_message_id,
            errorCode: txInput.errorCode,
            errorMessage: txInput.errorMessage,
          }),
          now,
        );

      const promoted = promoteNextQueuedRunTx(run.talk_id, now);
      return {
        applied: true,
        talkId: run.talk_id,
        promotedRunId: promoted?.id || null,
      };
    },
  );

  return tx(input);
}

export function cancelTalkRunsAtomic(input: {
  talkId: string;
  cancelledBy: string;
  now?: string;
}): {
  cancelledRuns: number;
  cancelledRunIds: string[];
  cancelledRunning: boolean;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      cancelledRuns: number;
      cancelledRunIds: string[];
      cancelledRunning: boolean;
    } => {
      const now = txInput.now || new Date().toISOString();
      const candidates = getDb()
        .prepare(
          `
          SELECT id, status
          FROM talk_runs
          WHERE talk_id = ? AND status IN ('running', 'queued')
          ORDER BY created_at ASC
        `,
        )
        .all(txInput.talkId) as Array<{ id: string; status: TalkRunStatus }>;

      const cancelledRunIds: string[] = [];
      let cancelledRunning = false;
      for (const candidate of candidates) {
        const updated = getDb()
          .prepare(
            `
            UPDATE talk_runs
            SET status = 'cancelled',
                ended_at = ?,
                cancel_reason = ?
            WHERE id = ? AND status IN ('running', 'queued')
          `,
          )
          .run(
            now,
            `Cancelled by ${txInput.cancelledBy}`.slice(0, 500),
            candidate.id,
          );
        if (updated.changes === 1) {
          cancelledRunIds.push(candidate.id);
          if (candidate.status === 'running') cancelledRunning = true;
        }
      }

      if (cancelledRunIds.length > 0) {
        // TODO(phase-2-streaming-sse): emit per-run cancellation lifecycle events
        // when migrating to long-lived SSE consumers that need granular run-state updates.
        getDb()
          .prepare(
            `
          INSERT INTO event_outbox (topic, event_type, payload, created_at)
          VALUES (?, ?, ?, ?)
        `,
          )
          .run(
            `talk:${txInput.talkId}`,
            'talk_run_cancelled',
            JSON.stringify({
              talkId: txInput.talkId,
              cancelledBy: txInput.cancelledBy,
              runIds: cancelledRunIds,
            }),
            now,
          );
      }

      return {
        cancelledRuns: cancelledRunIds.length,
        cancelledRunIds,
        cancelledRunning,
      };
    },
  );

  return tx(input);
}

export function failInterruptedRunsOnStartup(now?: string): {
  failedRunIds: string[];
  promotedRunIds: string[];
} {
  const tx = getDb().transaction(
    (
      inputNow?: string,
    ): { failedRunIds: string[]; promotedRunIds: string[] } => {
      const currentNow = inputNow || new Date().toISOString();
      const runningRuns = getDb()
        .prepare(
          `
          SELECT id, talk_id, trigger_message_id
          FROM talk_runs
          WHERE status = 'running'
          ORDER BY created_at ASC
        `,
        )
        .all() as Array<{
        id: string;
        talk_id: string;
        trigger_message_id: string | null;
      }>;

      const failedRunIds: string[] = [];
      const affectedTalkIds = new Set<string>();
      for (const run of runningRuns) {
        const updated = getDb()
          .prepare(
            `
            UPDATE talk_runs
            SET status = 'failed',
                ended_at = ?,
                cancel_reason = ?
            WHERE id = ? AND status = 'running'
          `,
          )
          .run(currentNow, 'interrupted_by_restart', run.id);
        if (updated.changes !== 1) continue;

        failedRunIds.push(run.id);
        affectedTalkIds.add(run.talk_id);
        getDb()
          .prepare(
            `
          INSERT INTO event_outbox (topic, event_type, payload, created_at)
          VALUES (?, ?, ?, ?)
        `,
          )
          .run(
            `talk:${run.talk_id}`,
            'talk_run_failed',
            JSON.stringify({
              talkId: run.talk_id,
              runId: run.id,
              triggerMessageId: run.trigger_message_id,
              errorCode: 'interrupted_by_restart',
              errorMessage: 'Run interrupted by process restart',
            }),
            currentNow,
          );
      }

      const promotedRunIds: string[] = [];
      for (const talkId of affectedTalkIds) {
        const promoted = promoteNextQueuedRunTx(talkId, currentNow);
        if (promoted) promotedRunIds.push(promoted.id);
      }

      return { failedRunIds, promotedRunIds };
    },
  );

  return tx(now);
}

export function markTalkRunStatus(
  runId: string,
  status: TalkRunStatus,
  endedAt: string | null,
  cancelReason: string | null,
  startedAt?: string | null,
): void {
  getDb()
    .prepare(
      `
    UPDATE talk_runs
    SET status = ?,
        ended_at = ?,
        cancel_reason = ?,
        started_at = COALESCE(?, started_at)
    WHERE id = ?
  `,
    )
    .run(status, endedAt, cancelReason, startedAt || null, runId);
}
