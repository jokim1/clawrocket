/**
 * openai-codex-oauth.ts
 *
 * OpenAI ChatGPT subscription OAuth via the device-code flow — port of
 * openclaw's `extensions/openai/openai-codex-device-code.ts`, adapted for
 * clawrocket's runtime.
 *
 * Flow (different from Anthropic's paste-back PKCE):
 *   1. POST /api/accounts/deviceauth/usercode  → { device_auth_id, user_code, interval }
 *   2. Display user_code + verificationUrl to the user. They open the URL,
 *      type the user_code, and approve in their browser.
 *   3. Poll /api/accounts/deviceauth/token until authorized → returns
 *      { authorization_code, code_verifier } (PKCE pair generated server-side
 *      by OpenAI, not by us)
 *   4. POST /oauth/token with the authorization_code + code_verifier →
 *      returns { access_token, refresh_token, expires_in }
 *
 * Used by:
 *   - `web/routes/llm-oauth-openai.ts` (initiate / poll / status / disconnect)
 *   - Editorial Room runtime when an agent's `provider` is `openai`
 */

const OPENAI_AUTH_BASE_URL = 'https://auth.openai.com';
const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;

export const OPENAI_CODEX_DEVICE_VERIFICATION_URL = `${OPENAI_AUTH_BASE_URL}/codex/device`;
export {
  OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
};

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizePositiveMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
}

function normalizeTokenLifetimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }
  return undefined;
}

function buildHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    originator: 'clawrocket',
    'User-Agent': 'clawrocket',
  };
}

function formatErrorBody(prefix: string, status: number, body: string): string {
  const parsed = parseJsonObject(body);
  const error = trimNonEmptyString(parsed?.error);
  const description = trimNonEmptyString(parsed?.error_description);
  if (error && description) return `${prefix}: ${error} (${description})`;
  if (error) return `${prefix}: ${error}`;
  if (body.trim()) return `${prefix}: HTTP ${status} ${body.slice(0, 300)}`;
  return `${prefix}: HTTP ${status}`;
}

// ─── Step 1: Request device code ────────────────────────────────────────────

export interface DeviceCodeRequest {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAtMs: number;
}

export async function requestDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeRequest> {
  const response = await fetchImpl(
    `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: buildHeaders('application/json'),
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    },
  );
  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'OpenAI Codex device code login is not enabled for this client. ' +
          'OpenAI may have rotated the public client id.',
      );
    }
    throw new Error(
      formatErrorBody(
        'OpenAI device code request failed',
        response.status,
        bodyText,
      ),
    );
  }

  const parsed = parseJsonObject(bodyText);
  const deviceAuthId = trimNonEmptyString(parsed?.device_auth_id);
  const userCode =
    trimNonEmptyString(parsed?.user_code) ??
    trimNonEmptyString(parsed?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error(
      'OpenAI device code response was missing device_auth_id or user_code.',
    );
  }
  const intervalMs =
    normalizePositiveMilliseconds(parsed?.interval) ??
    OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS;
  return {
    deviceAuthId,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
    intervalMs,
    expiresAtMs: Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  };
}

// ─── Step 2: Poll for authorization ─────────────────────────────────────────

export type PollResult =
  | { status: 'pending' }
  | { status: 'authorized'; authorizationCode: string; codeVerifier: string }
  | { status: 'error'; message: string };

export async function pollDeviceCode(input: {
  deviceAuthId: string;
  userCode: string;
  fetchImpl?: typeof fetch;
}): Promise<PollResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
    {
      method: 'POST',
      headers: buildHeaders('application/json'),
      body: JSON.stringify({
        device_auth_id: input.deviceAuthId,
        user_code: input.userCode,
      }),
    },
  );
  const bodyText = await response.text();

  if (response.ok) {
    const parsed = parseJsonObject(bodyText);
    const authorizationCode = trimNonEmptyString(parsed?.authorization_code);
    const codeVerifier = trimNonEmptyString(parsed?.code_verifier);
    if (!authorizationCode || !codeVerifier) {
      return {
        status: 'error',
        message:
          'OpenAI device authorization response was missing exchange code or verifier.',
      };
    }
    return { status: 'authorized', authorizationCode, codeVerifier };
  }
  if (response.status === 403 || response.status === 404) {
    return { status: 'pending' };
  }
  return {
    status: 'error',
    message: formatErrorBody(
      'OpenAI device authorization failed',
      response.status,
      bodyText,
    ),
  };
}

// ─── Step 3: Exchange authorization code for tokens ──────────────────────────

export interface ExchangeDeviceCodeResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export async function exchangeDeviceCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch;
}): Promise<ExchangeDeviceCodeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: buildHeaders('application/x-www-form-urlencoded'),
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: input.codeVerifier,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatErrorBody(
        'OpenAI device token exchange failed',
        response.status,
        bodyText,
      ),
    );
  }
  const parsed = parseJsonObject(bodyText);
  const accessToken = trimNonEmptyString(parsed?.access_token);
  const refreshToken = trimNonEmptyString(parsed?.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new Error(
      'OpenAI token exchange succeeded but did not return access + refresh tokens.',
    );
  }
  const expiresInMs = normalizeTokenLifetimeMs(parsed?.expires_in);
  const expiresAt = new Date(
    Date.now() + (expiresInMs ?? 60 * 60 * 1000),
  ).toISOString();
  return { accessToken, refreshToken, expiresAt };
}

// ─── Refresh ────────────────────────────────────────────────────────────────

export interface RefreshOpenAIInput {
  refreshToken: string;
  fetchImpl?: typeof fetch;
}

export async function refreshDeviceCodeToken(
  input: RefreshOpenAIInput,
): Promise<ExchangeDeviceCodeResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: buildHeaders('application/x-www-form-urlencoded'),
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });
  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatErrorBody(
        'OpenAI device token refresh failed',
        response.status,
        bodyText,
      ),
    );
  }
  const parsed = parseJsonObject(bodyText);
  const accessToken = trimNonEmptyString(parsed?.access_token);
  if (!accessToken) {
    throw new Error('OpenAI refresh response missing access_token.');
  }
  const refreshToken =
    trimNonEmptyString(parsed?.refresh_token) ?? input.refreshToken;
  const expiresInMs = normalizeTokenLifetimeMs(parsed?.expires_in);
  const expiresAt = new Date(
    Date.now() + (expiresInMs ?? 60 * 60 * 1000),
  ).toISOString();
  return { accessToken, refreshToken, expiresAt };
}

export const _internal = {
  OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS,
};
