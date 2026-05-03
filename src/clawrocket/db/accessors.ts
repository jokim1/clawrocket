// editorialboard.ai persistence accessors.
//
// PR-3 of the PURGE collapsed this from ~6100 LOC of mixed Talk/agent/
// channel/browser/connector concerns down to the editorial-only surface:
// User CRUD, web sessions, invites, OAuth state, device auth codes.
//
// Provider secrets, llm_provider_*, oauth flows for LLM providers, and
// editorial setup state stay on raw `getDb().prepare(...)` in the route
// handlers and `editorial-llm-call` — they are narrow enough that going
// through typed accessors would add ceremony without buying anything.

import { getDb } from '../../db.js';
import { UserRole, UserType } from '../types.js';

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
  requested_by_user_id: string | null;
  requested_by_session_id: string | null;
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
  requestedByUserId?: string | null;
  requestedBySessionId?: string | null;
  expiresAt: string;
}): void {
  getDb()
    .prepare(
      `
    INSERT INTO oauth_state (
      id, provider, state_hash, nonce_hash, code_verifier_hash, code_verifier, redirect_uri, return_to,
      requested_by_user_id, requested_by_session_id, created_at, expires_at, used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
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
      input.requestedByUserId || null,
      input.requestedBySessionId || null,
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
