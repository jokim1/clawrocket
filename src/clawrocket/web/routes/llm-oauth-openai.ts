/**
 * llm-oauth-openai.ts
 *
 * HTTP routes for OpenAI ChatGPT subscription auth via device-code flow.
 *
 * Routes:
 *   POST /api/v1/agents/providers/openai/oauth/initiate
 *     → server requests device code from OpenAI, stores in state map,
 *       returns { state, userCode, verificationUrl, intervalMs, expiresAtMs }
 *
 *   POST /api/v1/agents/providers/openai/oauth/poll  { state }
 *     → server polls OpenAI's deviceauth/token endpoint once. Returns
 *       { status: 'pending' | 'authorized' | 'error' }. On 'authorized',
 *       exchanges code, stores tokens encrypted, and clears state.
 *
 *   GET  /api/v1/agents/providers/openai/oauth/status
 *     → returns current OpenAI credential state
 *
 *   POST /api/v1/agents/providers/openai/oauth/disconnect
 *     → removes the stored OpenAI Codex credential
 */

import { randomUUID } from 'crypto';

import { getDb } from '../../../db.js';
import { logger } from '../../../logger.js';
import {
  exchangeDeviceCode,
  pollDeviceCode,
  requestDeviceCode,
} from '../../llm/openai-codex-oauth.js';
import {
  consumeOpenAIState,
  peekOpenAIState,
  storeOpenAIState,
} from '../../llm/openai-oauth-state-store.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

const OPENAI_PROVIDER_ID = 'provider.openai';

export interface InitiateOpenAIOAuthResult {
  state: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAtMs: number;
}

export interface PollOpenAIOAuthBody {
  state?: unknown;
}

export type PollOpenAIOAuthResult =
  | { status: 'pending' }
  | { status: 'authorized'; expiresAt: string }
  | { status: 'expired' }
  | { status: 'error'; message: string };

export interface OpenAIOAuthStatus {
  connected: boolean;
  kind: 'oauth_subscription' | 'api_key' | 'none';
  expiresAt: string | null;
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

/** POST /api/v1/agents/providers/openai/oauth/initiate */
export async function initiateOpenAIOAuthRoute(auth: AuthContext): Promise<{
  statusCode: number;
  body: ApiEnvelope<InitiateOpenAIOAuthResult>;
}> {
  let device;
  try {
    device = await requestDeviceCode();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OpenAI device code request failed',
    );
    return envelopeError(
      502,
      'request_failed',
      err instanceof Error
        ? err.message
        : 'Could not request a device code from OpenAI.',
    );
  }

  const state = randomUUID();
  storeOpenAIState({
    state,
    deviceAuthId: device.deviceAuthId,
    userCode: device.userCode,
    userId: auth.userId,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: {
        state,
        userCode: device.userCode,
        verificationUrl: device.verificationUrl,
        intervalMs: device.intervalMs,
        expiresAtMs: device.expiresAtMs,
      },
    },
  };
}

/** POST /api/v1/agents/providers/openai/oauth/poll */
export async function pollOpenAIOAuthRoute(
  auth: AuthContext,
  body: PollOpenAIOAuthBody,
): Promise<{ statusCode: number; body: ApiEnvelope<PollOpenAIOAuthResult> }> {
  const state = typeof body.state === 'string' ? body.state.trim() : '';
  if (!state) {
    return envelopeError(400, 'invalid_input', 'Missing state.');
  }

  const lookup = peekOpenAIState({ state, userId: auth.userId });
  switch (lookup.kind) {
    case 'not_found':
      return {
        statusCode: 200,
        body: { ok: true, data: { status: 'expired' } },
      };
    case 'expired':
      return {
        statusCode: 200,
        body: { ok: true, data: { status: 'expired' } },
      };
    case 'wrong_user':
      return envelopeError(
        400,
        'invalid_state',
        'OAuth state did not match your session.',
      );
  }

  const pollResult = await pollDeviceCode({
    deviceAuthId: lookup.deviceAuthId,
    userCode: lookup.userCode,
  });

  if (pollResult.status === 'pending') {
    return {
      statusCode: 200,
      body: { ok: true, data: { status: 'pending' } },
    };
  }

  if (pollResult.status === 'error') {
    consumeOpenAIState(state);
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { status: 'error', message: pollResult.message },
      },
    };
  }

  // 'authorized' — exchange the code for tokens, store, return success.
  let tokens;
  try {
    tokens = await exchangeDeviceCode({
      authorizationCode: pollResult.authorizationCode,
      codeVerifier: pollResult.codeVerifier,
    });
  } catch (err) {
    consumeOpenAIState(state);
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'OpenAI device code exchange failed',
    );
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'OpenAI rejected the device code exchange.',
        },
      },
    };
  }

  const ciphertext = encryptProviderSecret({
    kind: 'openai_codex',
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
    .run(OPENAI_PROVIDER_ID, ciphertext, now, auth.userId);

  consumeOpenAIState(state);

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { status: 'authorized', expiresAt: tokens.expiresAt },
    },
  };
}

/** GET /api/v1/agents/providers/openai/oauth/status */
export async function getOpenAIOAuthStatusRoute(
  _auth: AuthContext,
): Promise<{ statusCode: number; body: ApiEnvelope<OpenAIOAuthStatus> }> {
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(OPENAI_PROVIDER_ID) as { ciphertext: string } | undefined;

  if (!row?.ciphertext) {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { connected: false, kind: 'none', expiresAt: null },
      },
    };
  }

  try {
    const payload = decryptProviderSecret(row.ciphertext);
    if (payload.kind === 'openai_codex') {
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: {
            connected: true,
            kind: 'oauth_subscription',
            expiresAt: payload.expiresAt ?? null,
          },
        },
      };
    }
    if (payload.kind === 'api_key') {
      return {
        statusCode: 200,
        body: {
          ok: true,
          data: { connected: true, kind: 'api_key', expiresAt: null },
        },
      };
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { connected: false, kind: 'none', expiresAt: null },
      },
    };
  } catch {
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: { connected: false, kind: 'none', expiresAt: null },
      },
    };
  }
}

/** POST /api/v1/agents/providers/openai/oauth/disconnect */
export async function disconnectOpenAIOAuthRoute(
  _auth: AuthContext,
): Promise<{ statusCode: number; body: ApiEnvelope<OpenAIOAuthStatus> }> {
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(OPENAI_PROVIDER_ID) as { ciphertext: string } | undefined;

  if (row?.ciphertext) {
    try {
      const payload = decryptProviderSecret(row.ciphertext);
      if (payload.kind === 'openai_codex') {
        getDb()
          .prepare(`DELETE FROM llm_provider_secrets WHERE provider_id = ?`)
          .run(OPENAI_PROVIDER_ID);
      }
    } catch {
      getDb()
        .prepare(`DELETE FROM llm_provider_secrets WHERE provider_id = ?`)
        .run(OPENAI_PROVIDER_ID);
    }
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { connected: false, kind: 'none', expiresAt: null },
    },
  };
}
