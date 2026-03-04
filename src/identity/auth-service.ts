import crypto from 'crypto';

import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_DEV_MODE,
  DEVICE_CODE_TTL_SEC,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  REFRESH_TOKEN_TTL_SEC,
} from '../config.js';
import {
  createDeviceAuthCode,
  createOAuthState,
  createUserInvite,
  consumeOAuthStateByHash,
  getActiveInviteByEmail,
  getOwnerUser,
  getPendingDeviceAuthCodeByDeviceHash,
  getUserByEmail,
  getUserById,
  getWebSessionByRefreshTokenHash,
  markDeviceAuthCodeCompleted,
  markInviteAccepted,
  revokeWebSession,
  revokeWebSessionChain,
  upsertUser,
  upsertWebSession,
  UserRecord,
} from '../db.js';
import { hashOpaqueToken } from '../security/hash.js';
import { UserRole } from '../types.js';

export interface SessionMaterial {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
}

export interface LoginResult {
  user: UserRecord;
  session: SessionMaterial;
}

export interface OAuthStartResult {
  state: string;
  authorizationUrl: string;
  expiresInSec: number;
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSec: number;
  intervalSec: number;
}

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const OAUTH_STATE_TTL_SEC = 600;

export function startGoogleOAuth(): OAuthStartResult {
  const state = randomOpaque(24);
  const nonce = randomOpaque(24);
  const codeVerifier = randomOpaque(48);
  const stateHash = hashOpaqueToken(state);
  const nonceHash = hashOpaqueToken(nonce);
  const codeVerifierHash = hashOpaqueToken(codeVerifier);
  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_SEC * 1000,
  ).toISOString();

  const redirectUri =
    GOOGLE_OAUTH_REDIRECT_URI ||
    'http://127.0.0.1:3210/api/v1/auth/google/callback';

  createOAuthState({
    id: crypto.randomUUID(),
    provider: 'google',
    stateHash,
    nonceHash,
    codeVerifierHash,
    redirectUri,
    expiresAt,
  });

  if (AUTH_DEV_MODE) {
    const authorizationUrl = `${redirectUri}?state=${encodeURIComponent(
      state,
    )}&email=owner@example.com&name=Owner`;
    return { state, authorizationUrl, expiresInSec: OAUTH_STATE_TTL_SEC };
  }

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URI) {
    throw new AuthError(
      'google_oauth_not_configured',
      'Google OAuth is not configured',
      503,
    );
  }

  const challenge = toCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'offline',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    state,
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    expiresInSec: OAUTH_STATE_TTL_SEC,
  };
}

export function completeGoogleOAuthCallback(input: {
  state: string;
  email?: string;
  displayName?: string;
  ipAddress?: string;
  userAgent?: string;
}): LoginResult {
  if (!input.state) {
    throw new AuthError('invalid_state', 'Missing OAuth state', 400);
  }

  const consumed = consumeOAuthState(input.state);
  if (!consumed) {
    throw new AuthError(
      'invalid_state',
      'OAuth state is invalid or expired',
      400,
    );
  }

  const email = (input.email || '').trim().toLowerCase();
  if (!email) {
    if (!AUTH_DEV_MODE) {
      throw new AuthError(
        'google_exchange_not_implemented',
        'Google code exchange is not implemented yet in this phase',
        501,
      );
    }
    throw new AuthError(
      'email_required',
      'Dev mode callback requires email query parameter',
      400,
    );
  }

  const displayName =
    input.displayName?.trim() || email.split('@')[0] || 'User';

  const user = resolveUserForLogin({ email, displayName });
  const session = createSessionForUser(user.id, {
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { user, session };
}

export function refreshSession(refreshToken: string): LoginResult {
  if (!refreshToken) {
    throw new AuthError(
      'missing_refresh_token',
      'Refresh token is required',
      401,
    );
  }

  const refreshHash = hashOpaqueToken(refreshToken);
  const current = getWebSessionByRefreshTokenHash(refreshHash);
  if (!current) {
    throw new AuthError(
      'invalid_refresh_token',
      'Refresh token is invalid',
      401,
    );
  }

  const user = getUserById(current.user_id);
  if (!user || user.is_active !== 1) {
    throw new AuthError(
      'invalid_refresh_token',
      'Refresh token is invalid',
      401,
    );
  }

  revokeWebSession(current.id);

  const session = createSessionForUser(user.id, {
    rotatedFrom: current.id,
    deviceId: current.device_id || undefined,
    ipAddress: current.ip_address || undefined,
    userAgent: current.user_agent || undefined,
  });

  return { user, session };
}

export function logoutSession(sessionId: string): void {
  revokeWebSessionChain(sessionId);
}

export function startDeviceAuthFlow(): DeviceStartResult {
  const deviceCode = randomOpaque(32);
  const userCode = randomUserCode();
  const expiresAt = new Date(
    Date.now() + DEVICE_CODE_TTL_SEC * 1000,
  ).toISOString();

  createDeviceAuthCode({
    id: crypto.randomUUID(),
    deviceCodeHash: hashOpaqueToken(deviceCode),
    userCodeHash: hashOpaqueToken(userCode),
    expiresAt,
  });

  return {
    deviceCode,
    userCode,
    verificationUri: '/api/v1/auth/device/complete',
    expiresInSec: DEVICE_CODE_TTL_SEC,
    intervalSec: 5,
  };
}

export function completeDeviceAuthFlow(input: {
  deviceCode: string;
  email: string;
  displayName?: string;
  ipAddress?: string;
  userAgent?: string;
}): LoginResult {
  const deviceCode = input.deviceCode?.trim();
  const email = input.email?.trim().toLowerCase();
  if (!deviceCode || !email) {
    throw new AuthError(
      'invalid_device_completion',
      'deviceCode and email are required',
      400,
    );
  }

  const row = getPendingDeviceAuthCodeByDeviceHash(hashOpaqueToken(deviceCode));
  if (!row) {
    throw new AuthError(
      'invalid_device_code',
      'Device code is invalid or expired',
      401,
    );
  }

  const displayName =
    input.displayName?.trim() || email.split('@')[0] || 'User';
  const user = resolveUserForLogin({ email, displayName });
  markDeviceAuthCodeCompleted({ id: row.id, userId: user.id });

  const session = createSessionForUser(user.id, {
    deviceId: `device:${row.id}`,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { user, session };
}

export function createInvite(input: {
  inviterUserId: string;
  role: 'admin' | 'member';
  email: string;
}): { inviteId: string; expiresAt: string } {
  const inviteId = crypto.randomUUID();
  const expiresAt = new Date(
    Date.now() + 7 * 24 * 60 * 60 * 1000,
  ).toISOString();
  createUserInvite({
    id: inviteId,
    email: input.email.trim().toLowerCase(),
    role: input.role,
    invitedBy: input.inviterUserId,
    expiresAt,
  });
  return { inviteId, expiresAt };
}

function resolveUserForLogin(input: {
  email: string;
  displayName: string;
}): UserRecord {
  const existing = getUserByEmail(input.email);
  if (existing) {
    if (existing.is_active !== 1) {
      throw new AuthError('user_inactive', 'Account is inactive', 403);
    }
    return existing;
  }

  const owner = getOwnerUser();
  if (!owner) {
    const userId = crypto.randomUUID();
    upsertUser({
      id: userId,
      email: input.email,
      displayName: input.displayName,
      role: 'owner',
    });
    const claimed = getUserById(userId);
    if (!claimed) {
      throw new AuthError(
        'owner_claim_failed',
        'Failed to claim owner account',
        500,
      );
    }
    return claimed;
  }

  const invite = getActiveInviteByEmail(input.email);
  if (!invite) {
    throw new AuthError(
      'invite_required',
      'This email is not approved for this installation',
      403,
    );
  }

  const userId = crypto.randomUUID();
  const role: UserRole = invite.role === 'admin' ? 'admin' : 'member';
  upsertUser({
    id: userId,
    email: input.email,
    displayName: input.displayName,
    role,
  });
  markInviteAccepted(invite.id);

  const invitedUser = getUserById(userId);
  if (!invitedUser) {
    throw new AuthError(
      'invite_accept_failed',
      'Failed to create invited user',
      500,
    );
  }
  return invitedUser;
}

function createSessionForUser(
  userId: string,
  input?: {
    rotatedFrom?: string;
    deviceId?: string;
    ipAddress?: string;
    userAgent?: string;
  },
): SessionMaterial {
  const sessionId = crypto.randomUUID();
  const accessToken = randomOpaque(32);
  const refreshToken = randomOpaque(32);
  const csrfToken = randomOpaque(16);

  const now = Date.now();
  const accessExpiresAt = new Date(
    now + ACCESS_TOKEN_TTL_SEC * 1000,
  ).toISOString();
  const refreshExpiresAt = new Date(
    now + REFRESH_TOKEN_TTL_SEC * 1000,
  ).toISOString();

  upsertWebSession({
    id: sessionId,
    userId,
    accessTokenHash: hashOpaqueToken(accessToken),
    refreshTokenHash: hashOpaqueToken(refreshToken),
    accessExpiresAt,
    expiresAt: refreshExpiresAt,
    rotatedFrom: input?.rotatedFrom,
    deviceId: input?.deviceId,
    ipAddress: input?.ipAddress,
    userAgent: input?.userAgent,
  });

  return {
    sessionId,
    accessToken,
    refreshToken,
    csrfToken,
    accessExpiresAt,
    refreshExpiresAt,
  };
}

function consumeOAuthState(state: string): { id: string } | null {
  const row = consumeOAuthStateByHash(hashOpaqueToken(state));
  if (!row) return null;
  return { id: row.id };
}

function randomOpaque(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomUserCode(): string {
  return randomOpaque(6)
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, 8)
    .toUpperCase();
}

function toCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}
