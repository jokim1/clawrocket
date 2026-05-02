/**
 * llm-oauth.ts
 *
 * HTTP routes for LLM-provider OAuth flows. Currently covers Anthropic
 * (Claude.ai subscription); OpenAI Codex CLI piggyback lands in a follow-up.
 *
 * Routes:
 *   POST /api/v1/agents/providers/anthropic/oauth/initiate
 *     → returns { authorizeUrl, state }; user opens authorizeUrl in a new
 *       tab, logs into claude.ai, lands on console.anthropic.com which
 *       displays a code, then pastes the code+state back via /submit
 *
 *   POST /api/v1/agents/providers/anthropic/oauth/submit
 *     → exchanges code for tokens, encrypts + stores in
 *       llm_provider_secrets keyed by 'provider.anthropic'
 *
 *   GET  /api/v1/agents/providers/anthropic/oauth/status
 *     → returns { connected, expiresAt, kind } so the Settings page can
 *       show whether a Claude subscription credential is on file
 *
 *   POST /api/v1/agents/providers/anthropic/oauth/disconnect
 *     → removes the stored OAuth credential (does NOT touch any API-key
 *       credential at the same provider)
 */

import { randomUUID } from 'crypto';

import { getDb } from '../../../db.js';
import { logger } from '../../../logger.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
} from '../../llm/anthropic-oauth.js';
import {
  consumeState,
  storeState,
} from '../../llm/anthropic-oauth-state-store.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

const ANTHROPIC_PROVIDER_ID = 'provider.anthropic';

export interface InitiateOAuthResult {
  authorizeUrl: string;
  state: string;
}

export interface OAuthStatus {
  connected: boolean;
  kind: 'oauth_subscription' | 'api_key' | 'none';
  expiresAt: string | null;
  expiringSoon: boolean;
}

export interface SubmitOAuthBody {
  code?: unknown;
  state?: unknown;
}

function envelopeError<T>(
  statusCode: number,
  code: string,
  message: string,
): { statusCode: number; body: ApiEnvelope<T> } {
  return {
    statusCode,
    body: { ok: false, error: { code, message } },
  };
}

/** POST /api/v1/agents/providers/anthropic/oauth/initiate */
export async function initiateAnthropicOAuthRoute(
  auth: AuthContext,
): Promise<{ statusCode: number; body: ApiEnvelope<InitiateOAuthResult> }> {
  const pair = createPkcePair();
  const state = randomUUID();

  storeState({
    state,
    verifier: pair.verifier,
    userId: auth.userId,
  });

  const authorizeUrl = buildAuthorizeUrl({
    codeChallenge: pair.challenge,
    state,
  });

  return {
    statusCode: 200,
    body: { ok: true, data: { authorizeUrl, state } },
  };
}

/** POST /api/v1/agents/providers/anthropic/oauth/submit */
export async function submitAnthropicOAuthRoute(
  auth: AuthContext,
  body: SubmitOAuthBody,
): Promise<{ statusCode: number; body: ApiEnvelope<OAuthStatus> }> {
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const state = typeof body.state === 'string' ? body.state.trim() : '';

  if (!code) {
    return envelopeError(
      400,
      'invalid_input',
      'Missing or empty code. Paste the full code+state blob from console.anthropic.com.',
    );
  }
  if (!state) {
    return envelopeError(
      400,
      'invalid_input',
      'Missing or empty state. Paste the full code+state blob from console.anthropic.com.',
    );
  }

  const consumed = consumeState({ state, userId: auth.userId });
  switch (consumed.kind) {
    case 'not_found':
      return envelopeError(
        400,
        'invalid_state',
        'OAuth state not found. Click Sign in with Claude again to start a fresh flow.',
      );
    case 'expired':
      return envelopeError(
        400,
        'expired_state',
        'OAuth flow timed out (10-minute window). Click Sign in with Claude again.',
      );
    case 'wrong_user':
      return envelopeError(
        400,
        'invalid_state',
        'OAuth state did not match your session. Click Sign in with Claude again.',
      );
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      code,
      codeVerifier: consumed.verifier,
      state,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'anthropic OAuth code exchange failed',
    );
    return envelopeError(
      400,
      'exchange_failed',
      err instanceof Error
        ? err.message
        : 'Anthropic rejected the OAuth code. Try Sign in with Claude again.',
    );
  }

  const ciphertext = encryptProviderSecret({
    kind: 'anthropic_oauth',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET
         ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .run(ANTHROPIC_PROVIDER_ID, ciphertext, now, auth.userId);

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connected: true,
        kind: 'oauth_subscription',
        expiresAt: tokens.expiresAt,
        expiringSoon: false,
      },
    },
  };
}

/** GET /api/v1/agents/providers/anthropic/oauth/status */
export async function getAnthropicOAuthStatusRoute(
  _auth: AuthContext,
): Promise<{ statusCode: number; body: ApiEnvelope<OAuthStatus> }> {
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(ANTHROPIC_PROVIDER_ID) as { ciphertext: string } | undefined;

  if (!row?.ciphertext) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          connected: false,
          kind: 'none',
          expiresAt: null,
          expiringSoon: false,
        },
      },
    };
  }

  try {
    const payload = decryptProviderSecret(row.ciphertext);
    if (payload.kind === 'anthropic_oauth') {
      const expiresAtMs = Date.parse(payload.expiresAt);
      const expiringSoon = !Number.isNaN(expiresAtMs)
        ? expiresAtMs <= Date.now() + 5 * 60 * 1000
        : true;
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            connected: true,
            kind: 'oauth_subscription',
            expiresAt: payload.expiresAt,
            expiringSoon,
          },
        },
      };
    }
    if (payload.kind === 'api_key') {
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            connected: true,
            kind: 'api_key',
            expiresAt: null,
            expiringSoon: false,
          },
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          connected: false,
          kind: 'none',
          expiresAt: null,
          expiringSoon: false,
        },
      },
    };
  } catch {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          connected: false,
          kind: 'none',
          expiresAt: null,
          expiringSoon: false,
        },
      },
    };
  }
}

/** POST /api/v1/agents/providers/anthropic/oauth/disconnect */
export async function disconnectAnthropicOAuthRoute(
  _auth: AuthContext,
): Promise<{ statusCode: number; body: ApiEnvelope<OAuthStatus> }> {
  // Only remove the row if the stored credential is OAuth — we don't want
  // to nuke an API-key credential that happens to share the same provider
  // record. (At v0p one row per provider, but the discriminant guards it.)
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(ANTHROPIC_PROVIDER_ID) as { ciphertext: string } | undefined;

  if (row?.ciphertext) {
    try {
      const payload = decryptProviderSecret(row.ciphertext);
      if (payload.kind === 'anthropic_oauth') {
        getDb()
          .prepare(`DELETE FROM llm_provider_secrets WHERE provider_id = ?`)
          .run(ANTHROPIC_PROVIDER_ID);
      }
    } catch {
      // If the existing row can't be decoded, drop it.
      getDb()
        .prepare(`DELETE FROM llm_provider_secrets WHERE provider_id = ?`)
        .run(ANTHROPIC_PROVIDER_ID);
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        connected: false,
        kind: 'none',
        expiresAt: null,
        expiringSoon: false,
      },
    },
  };
}
