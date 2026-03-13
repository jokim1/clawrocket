import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import {
  TalkAccessRole,
  TalkMessageRole,
  TalkRunStatus,
  UserRole,
  UserType,
} from '../types.js';
import { initializeTalkToolGrants } from './tool-manager-accessors.js';

// --- Identity and web session accessors ---

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  user_type: UserType;
  role: UserRole;
  is_active: number;
  created_at: string;
  last_login_at: string | null;
}

export function upsertUser(input: {
  id: string;
  email: string;
  displayName: string;
  userType?: UserType;
  role?: UserRole;
  isActive?: boolean;
}): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO users (id, email, display_name, user_type, role, is_active, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      user_type = excluded.user_type,
      role = excluded.role,
      is_active = excluded.is_active
  `,
    )
    .run(
      input.id,
      input.email,
      input.displayName,
      input.userType || 'human',
      input.role || 'member',
      input.isActive === false ? 0 : 1,
      now,
      now,
    );
}

export function updateUserDisplayName(
  userId: string,
  displayName: string,
): void {
  getDb()
    .prepare('UPDATE users SET display_name = ? WHERE id = ?')
    .run(displayName, userId);
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
      `SELECT * FROM users WHERE role = 'owner' AND is_active = 1 AND user_type = 'human' ORDER BY created_at ASC LIMIT 1`,
    )
    .get() as UserRecord | undefined;
}

export function hasAnyUsers(): boolean {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) as count FROM users WHERE is_active = 1 AND user_type = 'human'",
    )
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
  return_to: string | null;
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
  returnTo?: string;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO oauth_state (
      id, provider, state_hash, nonce_hash, code_verifier_hash, code_verifier, redirect_uri, return_to,
      created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
      input.returnTo || null,
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
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TalkFolderRecord {
  id: string;
  owner_id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type TalkAccessLevel = 'owner' | 'admin' | 'editor' | 'viewer';

export interface TalkWithAccessRecord extends TalkRecord {
  access_role: TalkAccessLevel;
  llm_policy: string | null;
}

export interface TalkExecutorSessionRecord {
  talk_id: string;
  session_id: string;
  executor_alias: string;
  executor_model: string;
  session_compat_key: string;
  updated_at: string;
}

export interface TalkListPage {
  limit: number;
  offset: number;
}

export interface TalkSidebarTalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
  access_role: TalkAccessLevel;
  llm_policy: string | null;
}

export interface TalkSidebarTreeRecord {
  folders: TalkFolderRecord[];
  rootTalks: TalkSidebarTalkRecord[];
  talksByFolderId: Record<string, TalkSidebarTalkRecord[]>;
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

function bumpRootSortOrders(ownerId: string): void {
  getDb()
    .prepare(
      `
      UPDATE talks
      SET sort_order = sort_order + 1
      WHERE owner_id = ? AND folder_id IS NULL
    `,
    )
    .run(ownerId);
  getDb()
    .prepare(
      `
      UPDATE talk_folders
      SET sort_order = sort_order + 1
      WHERE owner_id = ?
    `,
    )
    .run(ownerId);
}

function writeRootSidebarOrder(
  ownerId: string,
  items: Array<{ type: 'talk' | 'folder'; id: string }>,
): void {
  const updateTalk = getDb().prepare(
    `
      UPDATE talks
      SET sort_order = ?
      WHERE id = ? AND owner_id = ? AND folder_id IS NULL
    `,
  );
  const updateFolder = getDb().prepare(
    `
      UPDATE talk_folders
      SET sort_order = ?
      WHERE id = ? AND owner_id = ?
    `,
  );
  items.forEach((item, index) => {
    if (item.type === 'talk') {
      updateTalk.run(index, item.id, ownerId);
    } else {
      updateFolder.run(index, item.id, ownerId);
    }
  });
}

function writeFolderTalkOrder(
  ownerId: string,
  folderId: string,
  talkIds: string[],
): void {
  const updateTalk = getDb().prepare(
    `
      UPDATE talks
      SET sort_order = ?
      WHERE id = ? AND owner_id = ? AND folder_id = ?
    `,
  );
  talkIds.forEach((talkId, index) => {
    updateTalk.run(index, talkId, ownerId, folderId);
  });
}

function listOwnedRootSidebarItems(ownerId: string): Array<{
  type: 'talk' | 'folder';
  id: string;
  sort_order: number;
}> {
  return getDb()
    .prepare(
      `
      SELECT 'talk' AS type, id, sort_order
      FROM talks
      WHERE owner_id = ? AND folder_id IS NULL
      UNION ALL
      SELECT 'folder' AS type, id, sort_order
      FROM talk_folders
      WHERE owner_id = ?
      ORDER BY sort_order ASC, id ASC
    `,
    )
    .all(ownerId, ownerId) as Array<{
    type: 'talk' | 'folder';
    id: string;
    sort_order: number;
  }>;
}

function listOwnedFolderTalkIds(ownerId: string, folderId: string): string[] {
  return getDb()
    .prepare(
      `
      SELECT id
      FROM talks
      WHERE owner_id = ? AND folder_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `,
    )
    .all(ownerId, folderId)
    .map((row) => (row as { id: string }).id);
}

function getTalkFolderByIdForOwner(
  folderId: string,
  ownerId: string,
): TalkFolderRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_folders
      WHERE id = ? AND owner_id = ?
      LIMIT 1
    `,
    )
    .get(folderId, ownerId) as TalkFolderRecord | undefined;
}

function appendTalksToTopLevel(ownerId: string, talkIds: string[]): void {
  if (talkIds.length === 0) return;
  const maxRootTalk = getDb()
    .prepare(
      `
      SELECT COALESCE(MAX(sort_order), -1) AS value
      FROM talks
      WHERE owner_id = ? AND folder_id IS NULL
    `,
    )
    .get(ownerId) as { value: number };
  const maxRootFolder = getDb()
    .prepare(
      `
      SELECT COALESCE(MAX(sort_order), -1) AS value
      FROM talk_folders
      WHERE owner_id = ?
    `,
    )
    .get(ownerId) as { value: number };
  let nextSort = Math.max(maxRootTalk.value, maxRootFolder.value) + 1;
  const update = getDb().prepare(
    `
      UPDATE talks
      SET folder_id = NULL, sort_order = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `,
  );
  const now = new Date().toISOString();
  talkIds.forEach((talkId) => {
    update.run(nextSort, now, talkId, ownerId);
    nextSort += 1;
  });
}

export function createTalk(input: {
  id: string;
  ownerId: string;
  topicTitle?: string;
  status?: 'active' | 'paused' | 'archived';
}): void {
  const tx = getDb().transaction((txInput: typeof input) => {
    const now = new Date().toISOString();
    bumpRootSortOrders(txInput.ownerId);
    getDb()
      .prepare(
        `
      INSERT INTO talks (
        id, owner_id, folder_id, sort_order, topic_title, status, version, created_at, updated_at
      )
      VALUES (?, ?, NULL, 0, ?, ?, 1, ?, ?)
    `,
      )
      .run(
        txInput.id,
        txInput.ownerId,
        txInput.topicTitle || null,
        txInput.status || 'active',
        now,
        now,
      );
    initializeTalkToolGrants(txInput.id, txInput.ownerId);
  });
  tx(input);
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
  status?: 'active' | 'paused' | 'archived';
}): TalkWithAccessRecord[] {
  const user = getUserById(input.userId);
  if (!user || user.is_active !== 1) return [];
  const page = normalizeTalkListPage({
    limit: input.limit,
    offset: input.offset,
  });
  const statusFilter = input.status ?? null;

  if (user.role === 'owner' || user.role === 'admin') {
    // Global admin/owner role is authoritative here; membership role is not surfaced.
    const accessRole = user.role === 'owner' ? 'owner' : 'admin';
    return getDb()
      .prepare(
        `
        SELECT t.id, t.owner_id, t.topic_title, t.status, t.version, t.created_at, t.updated_at,
               t.folder_id, t.sort_order,
               p.llm_policy,
               CASE WHEN t.owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks t
        LEFT JOIN talk_llm_policies p
          ON p.talk_id = t.id
        WHERE (? IS NULL OR t.status = ?)
        ORDER BY t.updated_at DESC, t.created_at DESC
        LIMIT ? OFFSET ?
      `,
      )
      .all(
        input.userId,
        accessRole,
        statusFilter,
        statusFilter,
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
        t.folder_id,
        t.sort_order,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        p.llm_policy,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      LEFT JOIN talk_llm_policies p
        ON p.talk_id = t.id
      WHERE (t.owner_id = ? OR tm.user_id = ?)
        AND (? IS NULL OR t.status = ?)
      ORDER BY t.updated_at DESC, t.created_at DESC
      LIMIT ? OFFSET ?
    `,
    )
    .all(
      input.userId,
      input.userId,
      input.userId,
      input.userId,
      statusFilter,
      statusFilter,
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
        SELECT t.id, t.owner_id, t.topic_title, t.status, t.version, t.created_at, t.updated_at,
               t.folder_id, t.sort_order,
               p.llm_policy,
               CASE WHEN t.owner_id = ? THEN 'owner' ELSE ? END AS access_role
        FROM talks t
        LEFT JOIN talk_llm_policies p
          ON p.talk_id = t.id
        WHERE t.id = ?
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
        t.folder_id,
        t.sort_order,
        t.topic_title,
        t.status,
        t.version,
        t.created_at,
        t.updated_at,
        p.llm_policy,
        CASE WHEN t.owner_id = ? THEN 'owner' ELSE tm.role END AS access_role
      FROM talks t
      LEFT JOIN talk_members tm
        ON tm.talk_id = t.id
       AND tm.user_id = ?
      LEFT JOIN talk_llm_policies p
        ON p.talk_id = t.id
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
    INSERT INTO talks (
      id, owner_id, folder_id, sort_order, topic_title, status, version, created_at, updated_at
    )
    VALUES (?, ?, NULL, 0, ?, ?, 1, ?, ?)
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

export function listTalkFoldersForOwner(ownerId: string): TalkFolderRecord[] {
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_folders
      WHERE owner_id = ?
      ORDER BY sort_order ASC, created_at ASC, id ASC
    `,
    )
    .all(ownerId) as TalkFolderRecord[];
}

export function createTalkFolder(input: {
  id: string;
  ownerId: string;
  title: string;
}): TalkFolderRecord {
  const tx = getDb().transaction((txInput: typeof input) => {
    const now = new Date().toISOString();
    bumpRootSortOrders(txInput.ownerId);
    getDb()
      .prepare(
        `
        INSERT INTO talk_folders (id, owner_id, title, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, 0, ?, ?)
      `,
      )
      .run(txInput.id, txInput.ownerId, txInput.title, now, now);
    return getTalkFolderByIdForOwner(txInput.id, txInput.ownerId)!;
  });
  return tx(input);
}

export function renameTalkFolder(input: {
  id: string;
  ownerId: string;
  title: string;
}): TalkFolderRecord | undefined {
  getDb()
    .prepare(
      `
      UPDATE talk_folders
      SET title = ?, updated_at = ?
      WHERE id = ? AND owner_id = ?
    `,
    )
    .run(input.title, new Date().toISOString(), input.id, input.ownerId);
  return getTalkFolderByIdForOwner(input.id, input.ownerId);
}

export function deleteTalkFolderAndMoveTalksToTopLevel(input: {
  id: string;
  ownerId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    const folder = getTalkFolderByIdForOwner(txInput.id, txInput.ownerId);
    if (!folder) return false;
    const talkIds = listOwnedFolderTalkIds(txInput.ownerId, txInput.id);
    appendTalksToTopLevel(txInput.ownerId, talkIds);
    getDb()
      .prepare('DELETE FROM talk_folders WHERE id = ? AND owner_id = ?')
      .run(txInput.id, txInput.ownerId);
    const remainingRoot = listOwnedRootSidebarItems(txInput.ownerId).map(
      (item) => ({
        type: item.type,
        id: item.id,
      }),
    );
    writeRootSidebarOrder(txInput.ownerId, remainingRoot);
    return true;
  });
  return tx(input);
}

export function patchTalkMetadata(input: {
  talkId: string;
  ownerId: string;
  title?: string;
  folderId?: string | null;
}): TalkRecord | undefined {
  const tx = getDb().transaction((txInput: typeof input) => {
    const talk = getTalkById(txInput.talkId);
    if (!talk || talk.owner_id !== txInput.ownerId) return undefined;

    const nextFolderId =
      txInput.folderId === undefined ? talk.folder_id : txInput.folderId;
    if (nextFolderId !== null && nextFolderId !== talk.folder_id) {
      const folder = getTalkFolderByIdForOwner(nextFolderId, txInput.ownerId);
      if (!folder) return undefined;
    }

    const now = new Date().toISOString();
    if (txInput.title !== undefined) {
      getDb()
        .prepare(
          `
          UPDATE talks
          SET topic_title = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(txInput.title || null, now, txInput.talkId, txInput.ownerId);
    }

    if (txInput.folderId !== undefined && txInput.folderId !== talk.folder_id) {
      const oldFolderId = talk.folder_id;
      const oldRootItems =
        oldFolderId === null
          ? listOwnedRootSidebarItems(txInput.ownerId)
              .filter(
                (item) => !(item.type === 'talk' && item.id === txInput.talkId),
              )
              .map((item) => ({ type: item.type, id: item.id }))
          : null;
      const oldFolderItems =
        oldFolderId !== null
          ? listOwnedFolderTalkIds(txInput.ownerId, oldFolderId).filter(
              (id) => id !== txInput.talkId,
            )
          : null;
      if (oldRootItems) {
        writeRootSidebarOrder(txInput.ownerId, oldRootItems);
      }
      if (oldFolderItems && oldFolderId) {
        writeFolderTalkOrder(txInput.ownerId, oldFolderId, oldFolderItems);
      }

      if (txInput.folderId === null) {
        appendTalksToTopLevel(txInput.ownerId, [txInput.talkId]);
      } else {
        const folderTalkIds = listOwnedFolderTalkIds(
          txInput.ownerId,
          txInput.folderId,
        );
        getDb()
          .prepare(
            `
            UPDATE talks
            SET folder_id = ?, sort_order = ?, updated_at = ?, version = version + 1
            WHERE id = ? AND owner_id = ?
          `,
          )
          .run(
            txInput.folderId,
            folderTalkIds.length,
            now,
            txInput.talkId,
            txInput.ownerId,
          );
      }
    }

    return getTalkById(txInput.talkId);
  });
  return tx(input);
}

export function deleteTalkForOwner(input: {
  talkId: string;
  ownerId: string;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    const talk = getTalkById(txInput.talkId);
    if (!talk || talk.owner_id !== txInput.ownerId) return false;
    const oldFolderId = talk.folder_id;
    getDb()
      .prepare('DELETE FROM talks WHERE id = ? AND owner_id = ?')
      .run(txInput.talkId, txInput.ownerId);
    if (oldFolderId === null) {
      const remaining = listOwnedRootSidebarItems(txInput.ownerId).map(
        (item) => ({
          type: item.type,
          id: item.id,
        }),
      );
      writeRootSidebarOrder(txInput.ownerId, remaining);
    } else {
      const remaining = listOwnedFolderTalkIds(txInput.ownerId, oldFolderId);
      writeFolderTalkOrder(txInput.ownerId, oldFolderId, remaining);
    }
    return true;
  });
  return tx(input);
}

export function reorderTalkSidebarItem(input: {
  ownerId: string;
  itemType: 'talk' | 'folder';
  itemId: string;
  destinationFolderId: string | null;
  destinationIndex: number;
}): boolean {
  const tx = getDb().transaction((txInput: typeof input) => {
    if (txInput.itemType === 'folder' && txInput.destinationFolderId !== null) {
      return false;
    }

    const talk =
      txInput.itemType === 'talk' ? getTalkById(txInput.itemId) : undefined;
    const folder =
      txInput.itemType === 'folder'
        ? getTalkFolderByIdForOwner(txInput.itemId, txInput.ownerId)
        : undefined;

    if (txInput.itemType === 'talk') {
      if (!talk || talk.owner_id !== txInput.ownerId) return false;
      if (
        txInput.destinationFolderId !== null &&
        !getTalkFolderByIdForOwner(txInput.destinationFolderId, txInput.ownerId)
      ) {
        return false;
      }
    } else if (!folder) {
      return false;
    }

    if (txInput.itemType === 'folder') {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
        .filter(
          (item) => !(item.type === 'folder' && item.id === txInput.itemId),
        )
        .map((item) => ({ type: item.type, id: item.id }));
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, rootItems.length),
      );
      rootItems.splice(index, 0, { type: 'folder', id: txInput.itemId });
      writeRootSidebarOrder(txInput.ownerId, rootItems);
      return true;
    }

    const sourceFolderId = talk!.folder_id;
    if (sourceFolderId === txInput.destinationFolderId) {
      if (sourceFolderId === null) {
        const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
          .filter(
            (item) => !(item.type === 'talk' && item.id === txInput.itemId),
          )
          .map((item) => ({ type: item.type, id: item.id }));
        const index = Math.max(
          0,
          Math.min(txInput.destinationIndex, rootItems.length),
        );
        rootItems.splice(index, 0, { type: 'talk', id: txInput.itemId });
        writeRootSidebarOrder(txInput.ownerId, rootItems);
      } else {
        const talkIds = listOwnedFolderTalkIds(
          txInput.ownerId,
          sourceFolderId,
        ).filter((id) => id !== txInput.itemId);
        const index = Math.max(
          0,
          Math.min(txInput.destinationIndex, talkIds.length),
        );
        talkIds.splice(index, 0, txInput.itemId);
        writeFolderTalkOrder(txInput.ownerId, sourceFolderId, talkIds);
      }
      return true;
    }

    if (sourceFolderId === null) {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId)
        .filter((item) => !(item.type === 'talk' && item.id === txInput.itemId))
        .map((item) => ({ type: item.type, id: item.id }));
      writeRootSidebarOrder(txInput.ownerId, rootItems);
    } else {
      const sourceTalkIds = listOwnedFolderTalkIds(
        txInput.ownerId,
        sourceFolderId,
      ).filter((id) => id !== txInput.itemId);
      writeFolderTalkOrder(txInput.ownerId, sourceFolderId, sourceTalkIds);
    }

    const now = new Date().toISOString();
    if (txInput.destinationFolderId === null) {
      const rootItems = listOwnedRootSidebarItems(txInput.ownerId).map(
        (item) => ({
          type: item.type,
          id: item.id,
        }),
      );
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, rootItems.length),
      );
      rootItems.splice(index, 0, { type: 'talk', id: txInput.itemId });
      getDb()
        .prepare(
          `
          UPDATE talks
          SET folder_id = NULL, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(now, txInput.itemId, txInput.ownerId);
      writeRootSidebarOrder(txInput.ownerId, rootItems);
    } else {
      const talkIds = listOwnedFolderTalkIds(
        txInput.ownerId,
        txInput.destinationFolderId,
      );
      const index = Math.max(
        0,
        Math.min(txInput.destinationIndex, talkIds.length),
      );
      talkIds.splice(index, 0, txInput.itemId);
      getDb()
        .prepare(
          `
          UPDATE talks
          SET folder_id = ?, updated_at = ?, version = version + 1
          WHERE id = ? AND owner_id = ?
        `,
        )
        .run(txInput.destinationFolderId, now, txInput.itemId, txInput.ownerId);
      writeFolderTalkOrder(
        txInput.ownerId,
        txInput.destinationFolderId,
        talkIds,
      );
    }
    return true;
  });
  return tx(input);
}

export function listTalkSidebarTreeForUser(
  userId: string,
): TalkSidebarTreeRecord {
  const folders = listTalkFoldersForOwner(userId);
  // Sidebar trees stay intentionally small in v1; this ceiling avoids pulling an
  // unbounded root list while still covering normal usage comfortably.
  const talks = listTalksForUser({
    userId,
    limit: 1000,
    offset: 0,
    status: 'active',
  }) as TalkSidebarTalkRecord[];
  const rootTalks = talks
    .filter((talk) => talk.folder_id === null)
    .sort(
      (a, b) =>
        a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at),
    );
  const talksByFolderId = folders.reduce<
    Record<string, TalkSidebarTalkRecord[]>
  >((acc, folder) => {
    acc[folder.id] = talks
      .filter((talk) => talk.folder_id === folder.id)
      .sort(
        (a, b) =>
          a.sort_order - b.sort_order ||
          a.created_at.localeCompare(b.created_at),
      );
    return acc;
  }, {});
  return { folders, rootTalks, talksByFolderId };
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

export function upsertTalkLlmPolicy(input: {
  talkId: string;
  llmPolicy: string;
  updatedAt?: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_llm_policies (talk_id, llm_policy, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(talk_id) DO UPDATE SET
      llm_policy = excluded.llm_policy,
      updated_at = excluded.updated_at
  `,
    )
    .run(
      input.talkId,
      input.llmPolicy,
      input.updatedAt || new Date().toISOString(),
    );
}

export function deleteTalkLlmPolicy(talkId: string): void {
  getDb()
    .prepare('DELETE FROM talk_llm_policies WHERE talk_id = ?')
    .run(talkId);
}

export function getTalkLlmPolicyByTalkId(talkId: string): string | null {
  const row = getDb()
    .prepare(
      `
      SELECT llm_policy
      FROM talk_llm_policies
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as { llm_policy: string } | undefined;
  return row?.llm_policy || null;
}

export function getTalkExecutorSession(
  talkId: string,
): TalkExecutorSessionRecord | undefined {
  return getDb()
    .prepare(
      `
      SELECT
        talk_id,
        session_id,
        executor_alias,
        executor_model,
        session_compat_key,
        updated_at
      FROM talk_executor_sessions
      WHERE talk_id = ?
      LIMIT 1
    `,
    )
    .get(talkId) as TalkExecutorSessionRecord | undefined;
}

export function upsertTalkExecutorSession(input: {
  talkId: string;
  sessionId: string;
  executorAlias: string;
  executorModel: string;
  sessionCompatKey: string;
  updatedAt?: string;
}): void {
  getDb()
    .prepare(
      `
      INSERT INTO talk_executor_sessions (
        talk_id,
        session_id,
        executor_alias,
        executor_model,
        session_compat_key,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(talk_id) DO UPDATE SET
        session_id = excluded.session_id,
        executor_alias = excluded.executor_alias,
        executor_model = excluded.executor_model,
        session_compat_key = excluded.session_compat_key,
        updated_at = excluded.updated_at
    `,
    )
    .run(
      input.talkId,
      input.sessionId,
      input.executorAlias,
      input.executorModel,
      input.sessionCompatKey,
      input.updatedAt || new Date().toISOString(),
    );
}

export function deleteTalkExecutorSession(talkId: string): void {
  getDb()
    .prepare('DELETE FROM talk_executor_sessions WHERE talk_id = ?')
    .run(talkId);
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
  sequence_in_run: number | null;
}

export function createTalkMessage(input: {
  id: string;
  talkId: string;
  role: TalkMessageRole;
  content: string;
  createdBy?: string | null;
  runId?: string | null;
  metadataJson?: string | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO talk_messages (
      id, talk_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.sequenceInRun ?? null,
    );
}

function parseMessageMetadataJson(
  metadataJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function extractMessageActorFromMetadata(
  metadata: Record<string, unknown> | null,
): { agentId: string | null; agentNickname: string | null } {
  if (!metadata) {
    return { agentId: null, agentNickname: null };
  }

  const agentId =
    typeof metadata.agentId === 'string' ? metadata.agentId : null;
  const agentNickname =
    typeof metadata.agentNickname === 'string'
      ? metadata.agentNickname
      : typeof metadata.agentName === 'string'
        ? metadata.agentName
        : null;

  return { agentId, agentNickname };
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
      SELECT id, talk_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
      FROM talk_messages
      WHERE talk_id = ?
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC, COALESCE(sequence_in_run, 0) DESC, id DESC
      LIMIT ?
    `,
    )
    .all(input.talkId, before, before, limit) as TalkMessageRecord[];

  rows.reverse();
  return rows;
}

export interface TalkReplayRow {
  user: TalkMessageRecord;
  assistant: TalkMessageRecord;
}

export function listTalkReplayRows(input: {
  talkId: string;
  currentRunId: string;
  currentUserMessageId: string;
  limit?: number;
}): TalkReplayRow[] {
  const limit =
    typeof input.limit === 'number'
      ? Math.min(500, Math.max(1, Math.floor(input.limit)))
      : 500;

  const rows = getDb()
    .prepare(
      `
      WITH recent_messages AS (
        SELECT id, talk_id, role, content, created_by, created_at, run_id, metadata_json, sequence_in_run
        FROM talk_messages
        WHERE talk_id = ?
        ORDER BY created_at DESC, COALESCE(sequence_in_run, 0) DESC, id DESC
        LIMIT ?
      )
      SELECT
        u.id AS user_id,
        u.talk_id AS user_talk_id,
        u.role AS user_role,
        u.content AS user_content,
        u.created_by AS user_created_by,
        u.created_at AS user_created_at,
        u.run_id AS user_run_id,
        u.metadata_json AS user_metadata_json,
        u.sequence_in_run AS user_sequence_in_run,
        a.id AS assistant_id,
        a.talk_id AS assistant_talk_id,
        a.role AS assistant_role,
        a.content AS assistant_content,
        a.created_by AS assistant_created_by,
        a.created_at AS assistant_created_at,
        a.run_id AS assistant_run_id,
        a.metadata_json AS assistant_metadata_json,
        a.sequence_in_run AS assistant_sequence_in_run
      FROM recent_messages a
      JOIN talk_runs r ON r.id = a.run_id
      JOIN talk_messages u ON u.id = r.trigger_message_id
      WHERE a.role = 'assistant'
        AND a.run_id IS NOT NULL
        AND a.run_id != ?
        AND u.role = 'user'
        AND u.id != ?
      ORDER BY
        u.created_at ASC,
        u.id ASC,
        a.created_at ASC,
        COALESCE(a.sequence_in_run, 0) ASC,
        a.id ASC
    `,
    )
    .all(
      input.talkId,
      limit,
      input.currentRunId,
      input.currentUserMessageId,
    ) as Array<{
    user_id: string;
    user_talk_id: string;
    user_role: TalkMessageRole;
    user_content: string;
    user_created_by: string | null;
    user_created_at: string;
    user_run_id: string | null;
    user_metadata_json: string | null;
    user_sequence_in_run: number | null;
    assistant_id: string;
    assistant_talk_id: string;
    assistant_role: TalkMessageRole;
    assistant_content: string;
    assistant_created_by: string | null;
    assistant_created_at: string;
    assistant_run_id: string | null;
    assistant_metadata_json: string | null;
    assistant_sequence_in_run: number | null;
  }>;

  return rows.map((row) => ({
    user: {
      id: row.user_id,
      talk_id: row.user_talk_id,
      role: row.user_role,
      content: row.user_content,
      created_by: row.user_created_by,
      created_at: row.user_created_at,
      run_id: row.user_run_id,
      metadata_json: row.user_metadata_json,
      sequence_in_run: row.user_sequence_in_run,
    },
    assistant: {
      id: row.assistant_id,
      talk_id: row.assistant_talk_id,
      role: row.assistant_role,
      content: row.assistant_content,
      created_by: row.assistant_created_by,
      created_at: row.assistant_created_at,
      run_id: row.assistant_run_id,
      metadata_json: row.assistant_metadata_json,
      sequence_in_run: row.assistant_sequence_in_run,
    },
  }));
}

export function getTalkMessageById(
  messageId: string,
): TalkMessageRecord | undefined {
  return getDb()
    .prepare('SELECT * FROM talk_messages WHERE id = ?')
    .get(messageId) as TalkMessageRecord | undefined;
}

export function deleteTalkMessagesAtomic(input: {
  talkId: string;
  messageIds: string[];
  now?: string;
}): { deletedCount: number; deletedMessageIds: string[] } {
  const normalizedIds = Array.from(
    new Set(
      input.messageIds
        .map((messageId) => messageId.trim())
        .filter((messageId) => messageId.length > 0),
    ),
  );

  const tx = getDb().transaction(
    (
      txInput: typeof input,
      ids: string[],
    ): { deletedCount: number; deletedMessageIds: string[] } => {
      if (ids.length === 0) {
        throw new Error('talk history edit requires at least one message');
      }
      if (hasActiveTalkRuns(txInput.talkId)) {
        throw new Error('talk already has an active round');
      }

      const placeholders = ids.map(() => '?').join(', ');
      const rows = getDb()
        .prepare(
          `
          SELECT id, role
          FROM talk_messages
          WHERE talk_id = ?
            AND id IN (${placeholders})
        `,
        )
        .all(txInput.talkId, ...ids) as Array<{
        id: string;
        role: TalkMessageRole;
      }>;

      if (rows.length !== ids.length) {
        throw new Error('one or more talk messages were not found');
      }
      if (rows.some((row) => row.role === 'system')) {
        throw new Error('system messages cannot be deleted');
      }

      const now = txInput.now || new Date().toISOString();
      getDb()
        .prepare(
          `
          DELETE FROM talk_messages
          WHERE talk_id = ?
            AND id IN (${placeholders})
        `,
        )
        .run(txInput.talkId, ...ids);

      // Reset cached executor session so future runs do not retain deleted context.
      deleteTalkExecutorSession(txInput.talkId);
      touchTalkUpdatedAt(txInput.talkId, now);
      appendOutboxEvent({
        topic: `talk:${txInput.talkId}`,
        eventType: 'talk_history_edited',
        payload: JSON.stringify({
          talkId: txInput.talkId,
          deletedCount: ids.length,
          deletedMessageIds: ids,
          editedAt: now,
        }),
      });

      return { deletedCount: ids.length, deletedMessageIds: ids };
    },
  );

  return tx(input, normalizedIds);
}

export function enqueueTalkTurnAtomic(input: {
  talkId: string;
  userId: string;
  content: string;
  messageId: string;
  runIds: string[];
  targetAgentIds: string[];
  attachmentIds?: string[] | null;
  maxAttachmentsPerMessage?: number;
  idempotencyKey?: string | null;
  now?: string;
}): { message: TalkMessageRecord; runs: TalkRunRecord[] } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      message: TalkMessageRecord;
      runs: TalkRunRecord[];
    } => {
      const now = txInput.now || new Date().toISOString();
      if (
        txInput.runIds.length === 0 ||
        txInput.runIds.length !== txInput.targetAgentIds.length
      ) {
        throw new Error('talk turn requires one run id per target agent');
      }

      const active = getDb()
        .prepare(
          `
          SELECT COUNT(*) AS count
          FROM talk_runs
          WHERE talk_id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
        `,
        )
        .get(txInput.talkId) as { count: number };
      if ((active?.count || 0) > 0) {
        throw new Error('talk already has an active round');
      }

      const message: TalkMessageRecord = {
        id: txInput.messageId,
        talk_id: txInput.talkId,
        role: 'user',
        content: txInput.content,
        created_by: txInput.userId,
        created_at: now,
        run_id: null,
        metadata_json: null,
        sequence_in_run: null,
      };

      const runs: TalkRunRecord[] = txInput.runIds.map((runId, index) => ({
        id: runId,
        talk_id: txInput.talkId,
        requested_by: txInput.userId,
        status: 'queued',
        trigger_message_id: txInput.messageId,
        target_agent_id: txInput.targetAgentIds[index] || null,
        idempotency_key: index === 0 ? txInput.idempotencyKey || null : null,
        executor_alias: null,
        executor_model: null,
        source_binding_id: null,
        source_external_message_id: null,
        source_thread_key: null,
        created_at: now,
        started_at: null,
        ended_at: null,
        cancel_reason: null,
      }));

      createTalkMessage({
        id: message.id,
        talkId: message.talk_id,
        role: message.role,
        content: message.content,
        createdBy: message.created_by,
        createdAt: message.created_at,
      });

      for (const run of runs) {
        createTalkRun(run);
      }

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
            runId: null,
            role: 'user',
            createdBy: txInput.userId,
            content: txInput.content,
            createdAt: now,
          }),
          now,
        );

      const outboxStmt = getDb().prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
      );
      for (const run of runs) {
        outboxStmt.run(
          `talk:${txInput.talkId}`,
          'talk_run_queued',
          JSON.stringify({
            talkId: txInput.talkId,
            runId: run.id,
            triggerMessageId: txInput.messageId,
            targetAgentId: run.target_agent_id || null,
            status: 'queued',
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
          now,
        );
      }

      // Validate and link attachments inside the same transaction so the
      // entire operation is atomic — no race between validation and linking.
      const attIds = txInput.attachmentIds;
      if (Array.isArray(attIds) && attIds.length > 0) {
        const cap = txInput.maxAttachmentsPerMessage ?? 5;
        if (attIds.length > cap) {
          throw new AttachmentValidationError(
            'too_many_attachments',
            `A message may have at most ${cap} attachments.`,
          );
        }

        const linkStmt = getDb().prepare(
          `UPDATE talk_message_attachments
           SET message_id = ?
           WHERE id = ? AND talk_id = ? AND message_id IS NULL`,
        );
        const invalidIds: string[] = [];
        for (const attId of attIds) {
          const result = linkStmt.run(message.id, attId, txInput.talkId);
          if (result.changes === 0) {
            invalidIds.push(attId);
          }
        }
        if (invalidIds.length > 0) {
          throw new AttachmentValidationError(
            'invalid_attachment_ids',
            `Some attachment IDs could not be linked: ${invalidIds.join(', ')}. ` +
              'They may be invalid, already linked, or belong to another talk.',
          );
        }
      }

      return { message, runs };
    },
  );

  return tx(input);
}

/**
 * Thrown when attachment validation fails inside enqueueTalkTurnAtomic.
 * The transaction is rolled back so no message or runs are persisted.
 */
export class AttachmentValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.code = code;
  }
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
  target_agent_id?: string | null;
  idempotency_key: string | null;
  executor_alias: string | null;
  executor_model: string | null;
  source_binding_id?: string | null;
  source_external_message_id?: string | null;
  source_thread_key?: string | null;
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
      id, talk_id, requested_by, status, trigger_message_id, target_agent_id, idempotency_key,
      executor_alias, executor_model, source_binding_id, source_external_message_id, source_thread_key,
      created_at, started_at, ended_at, cancel_reason
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.id,
      input.talk_id,
      input.requested_by,
      input.status,
      input.trigger_message_id,
      input.target_agent_id || null,
      input.idempotency_key,
      input.executor_alias,
      input.executor_model,
      input.source_binding_id || null,
      input.source_external_message_id || null,
      input.source_thread_key || null,
      input.created_at,
      input.started_at,
      input.ended_at,
      input.cancel_reason,
    );
}

export function setTalkRunExecutorProfile(input: {
  runId: string;
  executorAlias: string;
  executorModel: string;
}): void {
  getDb()
    .prepare(
      `
      UPDATE talk_runs
      SET executor_alias = ?, executor_model = ?
      WHERE id = ?
    `,
    )
    .run(input.executorAlias, input.executorModel, input.runId);
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
      WHERE talk_id = ? AND status IN ('running', 'awaiting_confirmation')
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          ELSE 1
        END ASC,
        created_at ASC
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

export function listQueuedTalkRuns(limit = 50): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE status = 'queued'
      ORDER BY created_at ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit) as TalkRunRecord[];
}

export function listRunningTalkRuns(limit = 50): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT *
      FROM talk_runs
      WHERE status IN ('running', 'awaiting_confirmation')
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          ELSE 1
        END ASC,
        created_at ASC
      LIMIT ?
    `,
    )
    .all(normalizedLimit) as TalkRunRecord[];
}

export function countRunningTalkRuns(): number {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_runs
      WHERE status IN ('running', 'awaiting_confirmation')
    `,
    )
    .get() as { count: number };
  return row.count;
}

export function hasActiveTalkRuns(talkId: string): boolean {
  const row = getDb()
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM talk_runs
      WHERE talk_id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
    `,
    )
    .get(talkId) as { count: number };
  return row.count > 0;
}

export function listTalkRunsForTalk(
  talkId: string,
  limit = 50,
): Array<
  TalkRunRecord & {
    target_agent_nickname: string | null;
  }
> {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  return getDb()
    .prepare(
      `
      SELECT r.*, a.name AS target_agent_nickname
      FROM talk_runs r
      LEFT JOIN talk_agents a ON a.id = r.target_agent_id
      WHERE r.talk_id = ?
      ORDER BY r.created_at DESC
      LIMIT ?
    `,
    )
    .all(talkId, normalizedLimit) as Array<
    TalkRunRecord & { target_agent_nickname: string | null }
  >;
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
  metadataJson?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  sequenceInRun?: number | null;
  createdAt?: string;
}): TalkMessageRecord {
  const tx = getDb().transaction((txInput: typeof input): TalkMessageRecord => {
    const createdAt = txInput.createdAt || new Date().toISOString();
    const metadata = parseMessageMetadataJson(txInput.metadataJson);
    const message: TalkMessageRecord = {
      id: txInput.messageId,
      talk_id: txInput.talkId,
      role: 'assistant',
      content: txInput.content,
      created_by: null,
      created_at: createdAt,
      run_id: txInput.runId,
      metadata_json: txInput.metadataJson || null,
      sequence_in_run: txInput.sequenceInRun ?? null,
    };

    createTalkMessage({
      id: message.id,
      talkId: message.talk_id,
      role: message.role,
      content: message.content,
      createdBy: null,
      runId: message.run_id,
      metadataJson: message.metadata_json,
      sequenceInRun: message.sequence_in_run,
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
          agentId: txInput.agentId || null,
          agentNickname: txInput.agentNickname || null,
          metadata,
        }),
        createdAt,
      );

    return message;
  });

  return tx(input);
}

export function appendRuntimeTalkMessage(input: {
  id: string;
  talkId: string;
  runId: string;
  role: 'assistant' | 'tool';
  content: string;
  metadataJson?: string | null;
  sequenceInRun: number;
  createdAt?: string;
}): TalkMessageRecord {
  const tx = getDb().transaction((txInput: typeof input): TalkMessageRecord => {
    const createdAt = txInput.createdAt || new Date().toISOString();
    const metadata = parseMessageMetadataJson(txInput.metadataJson);
    const actor = extractMessageActorFromMetadata(metadata);
    const message: TalkMessageRecord = {
      id: txInput.id,
      talk_id: txInput.talkId,
      role: txInput.role,
      content: txInput.content,
      created_by: null,
      created_at: createdAt,
      run_id: txInput.runId,
      metadata_json: txInput.metadataJson || null,
      sequence_in_run: txInput.sequenceInRun,
    };

    createTalkMessage({
      id: message.id,
      talkId: message.talk_id,
      role: message.role,
      content: message.content,
      createdBy: null,
      runId: message.run_id,
      metadataJson: message.metadata_json,
      sequenceInRun: message.sequence_in_run,
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
          messageId: txInput.id,
          runId: txInput.runId,
          role: txInput.role,
          createdBy: null,
          content: txInput.content,
          createdAt,
          agentId: actor.agentId,
          agentNickname: actor.agentNickname,
          metadata,
        }),
        createdAt,
      );

    return message;
  });

  return tx(input);
}

export function claimQueuedTalkRuns(
  limit: number,
  now?: string,
): TalkRunRecord[] {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  const tx = getDb().transaction(
    (txLimit: number, txNow?: string): TalkRunRecord[] => {
      const startedAt = txNow || new Date().toISOString();
      const queued = getDb()
        .prepare(
          `
          SELECT *
          FROM talk_runs
          WHERE status = 'queued'
          ORDER BY created_at ASC
          LIMIT ?
        `,
        )
        .all(txLimit) as TalkRunRecord[];
      if (queued.length === 0) return [];

      const updateStmt = getDb().prepare(
        `
        UPDATE talk_runs
        SET status = 'running',
            started_at = ?,
            ended_at = NULL,
            cancel_reason = NULL
        WHERE id = ? AND status = 'queued'
      `,
      );
      const outboxStmt = getDb().prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
      );

      const claimed: TalkRunRecord[] = [];
      for (const run of queued) {
        const updated = updateStmt.run(startedAt, run.id);
        if (updated.changes !== 1) continue;
        const claimedRun: TalkRunRecord = {
          ...run,
          status: 'running',
          started_at: startedAt,
          ended_at: null,
          cancel_reason: null,
        };
        claimed.push(claimedRun);
        outboxStmt.run(
          `talk:${run.talk_id}`,
          'talk_run_started',
          JSON.stringify({
            talkId: run.talk_id,
            runId: run.id,
            triggerMessageId: run.trigger_message_id,
            targetAgentId: run.target_agent_id || null,
            status: 'running',
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
          startedAt,
        );
      }

      return claimed;
    },
  );

  return tx(normalizedLimit, now);
}

export function completeRunAndPromoteNextAtomic(input: {
  runId: string;
  responseMessageId: string;
  responseContent: string;
  responseMetadataJson?: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  responseSequenceInRun?: number | null;
  now?: string;
}): {
  applied: boolean;
  talkId: string | null;
  deliveryQueued: boolean;
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
      deliveryQueued: boolean;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, trigger_message_id, target_agent_id, executor_alias, executor_model,
                 source_binding_id, source_external_message_id, source_thread_key
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | {
            id: string;
            talk_id: string;
            trigger_message_id: string | null;
            target_agent_id: string | null;
            executor_alias: string | null;
            executor_model: string | null;
            source_binding_id: string | null;
            source_external_message_id: string | null;
            source_thread_key: string | null;
          }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null, deliveryQueued: false };
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
        return { applied: false, talkId: run.talk_id, deliveryQueued: false };
      }

      const responseMessage = appendAssistantMessageWithOutbox({
        talkId: run.talk_id,
        runId: run.id,
        messageId: txInput.responseMessageId,
        content: txInput.responseContent,
        metadataJson: txInput.responseMetadataJson || null,
        agentId: txInput.agentId || run.target_agent_id,
        agentNickname: txInput.agentNickname || null,
        sequenceInRun: txInput.responseSequenceInRun ?? null,
        createdAt: now,
      });

      let deliveryQueued = false;
      if (run.source_binding_id) {
        const binding = getDb()
          .prepare(
            `
            SELECT id, active, target_kind, target_id
            FROM talk_channel_bindings
            WHERE id = ?
            LIMIT 1
          `,
          )
          .get(run.source_binding_id) as
          | {
              id: string;
              active: number;
              target_kind: string;
              target_id: string;
            }
          | undefined;
        if (binding) {
          const immediateDeadLetter = binding.active !== 1;
          getDb()
            .prepare(
              `
              INSERT INTO channel_delivery_outbox (
                id, binding_id, talk_id, run_id, talk_message_id, target_kind,
                target_id, payload_json, status, reason_code, reason_detail,
                dedupe_key, available_at, created_at, updated_at, attempt_count
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `,
            )
            .run(
              `delivery_${randomUUID()}`,
              binding.id,
              run.talk_id,
              run.id,
              responseMessage.id,
              binding.target_kind,
              binding.target_id,
              JSON.stringify({
                content: txInput.responseContent,
                metadataJson: txInput.responseMetadataJson || null,
                sourceThreadKey: run.source_thread_key || null,
                sourceExternalMessageId: run.source_external_message_id || null,
              }),
              immediateDeadLetter ? 'dead_letter' : 'pending',
              immediateDeadLetter ? 'binding_deactivated' : null,
              immediateDeadLetter
                ? 'Binding was deactivated before the response could be delivered'
                : null,
              `delivery:${run.id}:${responseMessage.id}`,
              now,
              now,
              now,
            );
          deliveryQueued = !immediateDeadLetter;
        }
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
          'talk_run_completed',
          JSON.stringify({
            talkId: run.talk_id,
            runId: run.id,
            triggerMessageId: run.trigger_message_id,
            responseMessageId: responseMessage.id,
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
          now,
        );

      return {
        applied: true,
        talkId: run.talk_id,
        deliveryQueued,
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
} {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): {
      applied: boolean;
      talkId: string | null;
    } => {
      const now = txInput.now || new Date().toISOString();
      const run = getDb()
        .prepare(
          `
          SELECT id, talk_id, trigger_message_id, target_agent_id, executor_alias, executor_model
          FROM talk_runs
          WHERE id = ? AND status = 'running'
          LIMIT 1
        `,
        )
        .get(txInput.runId) as
        | {
            id: string;
            talk_id: string;
            trigger_message_id: string | null;
            target_agent_id: string | null;
            executor_alias: string | null;
            executor_model: string | null;
          }
        | undefined;
      if (!run) {
        return { applied: false, talkId: null };
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
        return { applied: false, talkId: run.talk_id };
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
            executorAlias: run.executor_alias,
            executorModel: run.executor_model,
          }),
          now,
        );

      return {
        applied: true,
        talkId: run.talk_id,
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
      const activeRuns = getDb()
        .prepare(
          `
          SELECT id, status, trigger_message_id, target_agent_id, executor_alias, executor_model
          FROM talk_runs
          WHERE talk_id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
          ORDER BY created_at ASC
        `,
        )
        .all(txInput.talkId) as Array<{
        id: string;
        status: TalkRunStatus;
        trigger_message_id: string | null;
        target_agent_id: string | null;
        executor_alias: string | null;
        executor_model: string | null;
      }>;

      const cancelledRunIds: string[] = [];
      let cancelledRunning = false;
      const cancelStmt = getDb().prepare(
        `
        UPDATE talk_runs
        SET status = 'cancelled',
            ended_at = ?,
            cancel_reason = ?
        WHERE id = ? AND status IN ('queued', 'running', 'awaiting_confirmation')
      `,
      );
      const eventStmt = getDb().prepare(
        `
        INSERT INTO event_outbox (topic, event_type, payload, created_at)
        VALUES (?, ?, ?, ?)
      `,
      );
      for (const run of activeRuns) {
        const updated = cancelStmt.run(
          now,
          `Cancelled by ${txInput.cancelledBy}`.slice(0, 500),
          run.id,
        );
        if (updated.changes !== 1) continue;
        cancelledRunIds.push(run.id);
        if (run.status === 'running') {
          cancelledRunning = true;
          eventStmt.run(
            `talk:${txInput.talkId}`,
            'talk_response_cancelled',
            JSON.stringify({
              talkId: txInput.talkId,
              runId: run.id,
              agentId: run.target_agent_id || null,
            }),
            now,
          );
        }
      }

      if (cancelledRunIds.length > 0) {
        eventStmt.run(
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
          SELECT id, talk_id, trigger_message_id, executor_alias, executor_model
          FROM talk_runs
          WHERE status = 'running'
          ORDER BY created_at ASC
        `,
        )
        .all() as Array<{
        id: string;
        talk_id: string;
        trigger_message_id: string | null;
        executor_alias: string | null;
        executor_model: string | null;
      }>;

      const failedRunIds: string[] = [];
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
              executorAlias: run.executor_alias,
              executorModel: run.executor_model,
            }),
            currentNow,
          );
      }

      return { failedRunIds, promotedRunIds: [] };
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
