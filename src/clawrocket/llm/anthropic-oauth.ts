/**
 * anthropic-oauth.ts
 *
 * Anthropic Claude.ai subscription OAuth flow — port of rocketboard's
 * `src/features/ai/anthropic-auth.shared.ts` + `_shared/anthropic-auth.ts`,
 * adapted for clawrocket's runtime (no Supabase, no Deno-specific APIs).
 *
 * Pattern is shared with Claude Code, Hermes, pi-ai, OpenCode — Anthropic
 * whitelists their own console URL as the OAuth redirect, so the user logs
 * in on claude.ai, lands on console.anthropic.com which displays the code,
 * and pastes the `{code}#{state}` blob back into clawrocket.
 *
 * Used by:
 *   - `web/routes/llm-oauth.ts` (initiate / submit-code endpoints)
 *   - `agents/llm-client.ts` (refresh-on-401 for stored subscription tokens)
 *   - Editorial Room runtime (panel turns, optimize rounds)
 */

import { createHash, randomBytes } from 'crypto';

// ─── Constants — match Claude Code / Hermes / pi-ai for OAuth gate routing ─

export const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const ANTHROPIC_OAUTH_AUTHORIZE_URL =
  'https://claude.ai/oauth/authorize';

// Anthropic's own console URL catches the redirect and displays the code.
// Whitelisted with the public Claude Code OAuth client; users paste the
// `{code}#{state}` blob back into clawrocket to complete the flow.
export const ANTHROPIC_OAUTH_REDIRECT_URI =
  'https://console.anthropic.com/oauth/code/callback';

// Try platform.claude.com first, fall back to console.anthropic.com.
// Both endpoints accept the same payload; Hermes/pi-ai do the same.
export const ANTHROPIC_OAUTH_TOKEN_URLS = [
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
] as const;

export const ANTHROPIC_OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
] as const;

export const ANTHROPIC_VERSION_HEADER = '2023-06-01';

// User-Agent the Anthropic OAuth gate validates. Bump alongside Claude
// Code releases — stale versions get cryptic 429s back.
export const ANTHROPIC_CLAUDE_CODE_VERSION_FALLBACK = '2.1.113';

// System-prompt identity prefix Anthropic's OAuth gate keys on. Without
// this exact string as the first system block, oauth-routed requests come
// back as minimal-body 429s like {"error":{"type":"Error"}}.
export const ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";

export const ANTHROPIC_COMMON_BETAS = [
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
] as const;

export const ANTHROPIC_OAUTH_ONLY_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
] as const;

export const ANTHROPIC_OAUTH_BETAS = [
  ...ANTHROPIC_COMMON_BETAS,
  ...ANTHROPIC_OAUTH_ONLY_BETAS,
] as const;

export const ANTHROPIC_DEFAULT_VALIDATION_MODEL = 'claude-sonnet-4-20250514';

// ─── PKCE ────────────────────────────────────────────────────────────────────

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function toBase64Url(bytes: Buffer): string {
  return bytes
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function createPkcePair(): PkcePair {
  // 64 url-safe characters of entropy. randomBytes(48) base64-url-encoded
  // gives us 64 url-safe characters; trim defensively.
  const verifierBytes = randomBytes(48);
  const verifier = toBase64Url(verifierBytes).slice(0, 64);
  const challengeBytes = createHash('sha256').update(verifier).digest();
  const challenge = toBase64Url(challengeBytes);
  return { verifier, challenge };
}

// ─── URL builder ─────────────────────────────────────────────────────────────

export interface BuildAuthorizeUrlInput {
  codeChallenge: string;
  state: string;
  redirectUri?: string;
}

export function buildAuthorizeUrl(input: BuildAuthorizeUrlInput): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(
    'redirect_uri',
    input.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI,
  );
  url.searchParams.set('scope', ANTHROPIC_OAUTH_SCOPES.join(' '));
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', input.state);
  return url.toString();
}

// ─── Headers / system prompt builders ────────────────────────────────────────

export type AnthropicCredentialKind = 'api_key' | 'oauth_subscription';

export interface BuildAnthropicHeadersInput {
  credentialKind: AnthropicCredentialKind;
  token: string;
  claudeCodeVersion?: string;
}

export function buildAnthropicHeaders(
  input: BuildAnthropicHeadersInput,
): Record<string, string> {
  const headers: Record<string, string> = {
    'anthropic-version': ANTHROPIC_VERSION_HEADER,
  };

  if (input.credentialKind === 'oauth_subscription') {
    headers.Authorization = `Bearer ${input.token}`;
    headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETAS.join(',');
    headers['user-agent'] = `claude-cli/${
      input.claudeCodeVersion ?? ANTHROPIC_CLAUDE_CODE_VERSION_FALLBACK
    } (external, cli)`;
    headers['x-app'] = 'cli';
    return headers;
  }

  headers['anthropic-beta'] = ANTHROPIC_COMMON_BETAS.join(',');
  headers['x-api-key'] = input.token;
  return headers;
}

export type AnthropicSystemBlock = { type: 'text'; text: string };
export type AnthropicSystemPrompt = string | AnthropicSystemBlock[];

// OAuth-routed requests must send the system prompt as a content-block
// array with the Claude Code identity as the first block. API-key requests
// keep the plain-string form.
export function buildAnthropicSystemPrompt(input: {
  credentialKind: AnthropicCredentialKind;
  systemPrompt: string;
}): AnthropicSystemPrompt {
  if (input.credentialKind !== 'oauth_subscription') {
    return input.systemPrompt;
  }
  const identity: AnthropicSystemBlock = {
    type: 'text',
    text: ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX,
  };
  if (!input.systemPrompt) {
    return [identity];
  }
  return [identity, { type: 'text', text: input.systemPrompt }];
}

// ─── Token exchange + refresh ────────────────────────────────────────────────

export interface ExchangeAuthorizationCodeInput {
  code: string;
  codeVerifier: string;
  state: string;
  redirectUri?: string;
  fetchImpl?: typeof fetch;
}

export interface AnthropicOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

async function postJson(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION_FALLBACK} (external, cli)`,
    },
    body: JSON.stringify(body),
  });
}

async function postForm(
  url: string,
  params: URLSearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION_FALLBACK} (external, cli)`,
    },
    body: params.toString(),
  });
}

function expiresInToIsoExpiry(expiresInSeconds: unknown): string {
  const n = Math.max(1, Number(expiresInSeconds ?? 3600));
  return new Date(Date.now() + n * 1000).toISOString();
}

export async function exchangeAuthorizationCode(
  input: ExchangeAuthorizationCodeInput,
): Promise<AnthropicOAuthTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  // Hermes / Claude Code / pi-ai / OpenCode all use a JSON body that
  // includes `state` alongside the PKCE verifier. Form-urlencoded without
  // state gets a 400 from Anthropic's token endpoint for this OAuth client.
  const body = {
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    code: input.code,
    code_verifier: input.codeVerifier,
    grant_type: 'authorization_code' as const,
    redirect_uri: input.redirectUri ?? ANTHROPIC_OAUTH_REDIRECT_URI,
    state: input.state,
  };

  let lastError: Error | null = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_URLS) {
    try {
      const response = await postJson(endpoint, body, fetchImpl);
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        lastError = new Error(
          `Anthropic OAuth code exchange failed (${response.status})${
            text ? `: ${text.slice(0, 300)}` : ''
          }`,
        );
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const accessToken = String(payload.access_token ?? '').trim();
      const refreshToken = String(payload.refresh_token ?? '').trim();
      if (!accessToken || !refreshToken) {
        lastError = new Error(
          'Anthropic OAuth code exchange response was incomplete',
        );
        continue;
      }
      return {
        accessToken,
        refreshToken,
        expiresAt: expiresInToIsoExpiry(payload.expires_in),
      };
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error('Anthropic OAuth code exchange failed');
    }
  }
  throw lastError ?? new Error('Anthropic OAuth code exchange failed');
}

export interface RefreshOAuthTokenInput {
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export async function refreshOAuthToken(
  input: RefreshOAuthTokenInput,
): Promise<AnthropicOAuthTokens> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    client_id: ANTHROPIC_OAUTH_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
  });

  let lastError: Error | null = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_URLS) {
    try {
      const response = await postForm(endpoint, params, fetchImpl);
      if (!response.ok) {
        lastError = new Error(
          `Anthropic OAuth refresh failed (${response.status})`,
        );
        continue;
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const accessToken = String(payload.access_token ?? '').trim();
      if (!accessToken) {
        lastError = new Error(
          'Anthropic OAuth refresh response was missing access_token',
        );
        continue;
      }
      const refreshedRefreshToken =
        String(payload.refresh_token ?? input.refreshToken).trim() ||
        input.refreshToken;
      return {
        accessToken,
        refreshToken: refreshedRefreshToken,
        expiresAt: expiresInToIsoExpiry(payload.expires_in),
      };
    } catch (err) {
      lastError =
        err instanceof Error
          ? err
          : new Error('Anthropic OAuth refresh failed');
    }
  }
  throw lastError ?? new Error('Anthropic OAuth refresh failed');
}

// ─── Expiry check ────────────────────────────────────────────────────────────

export function isOAuthTokenExpiring(
  expiresAt: string | null | undefined,
  skewMs = 60_000,
): boolean {
  if (!expiresAt) return true;
  const ms = Date.parse(expiresAt);
  if (Number.isNaN(ms)) return true;
  return ms <= Date.now() + skewMs;
}
