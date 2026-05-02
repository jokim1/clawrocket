/**
 * editorial-llm-call.ts
 *
 * Editorial Room panel-turn LLM dispatch. Resolves an agent's stored
 * credential (api_key | anthropic_oauth | openai_codex), refreshes OAuth
 * tokens about to expire, and streams a single panel turn against the
 * provider's native streaming format. Used by `web/routes/editorial-panel.ts`.
 *
 * Three transports are supported, mirroring the catalog in
 * `webapp/src/lib/llm-providers.ts`:
 *   - anthropic_messages → POST api.anthropic.com/v1/messages
 *   - openai_responses   → POST chatgpt.com/backend-api/codex/responses
 *   - openai_chat        → POST <baseUrl>/chat/completions
 *
 * v0p scope: text-only, single-turn, no tool calls, no image input. The
 * caller passes a system prompt + a single user message; the helper yields
 * `text_delta` events as tokens arrive and a `completed` event with the
 * accumulated text + latency at the end. Errors yield `error` events.
 *
 * Refresh-on-401: if the first request returns 401 with a body that looks
 * like an expired-token signal, OAuth credentials get refreshed once and
 * the request is retried. API-key credentials never retry.
 */

import { getDb } from '../../db.js';
import {
  ANTHROPIC_DEFAULT_VALIDATION_MODEL,
  buildAnthropicHeaders,
  buildAnthropicSystemPrompt,
  isOAuthTokenExpiring,
  refreshOAuthToken,
} from './anthropic-oauth.js';
import {
  refreshDeviceCodeToken,
  type ExchangeDeviceCodeResult,
} from './openai-codex-oauth.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from './provider-secret-store.js';
import type {
  ProviderAnthropicOAuthSecret,
  ProviderApiKeySecret,
  ProviderOpenaiCodexSecret,
  ProviderSecretPayload,
} from './types.js';

// ─── Catalog (mirrors webapp/src/lib/llm-providers.ts) ──────────────────────
//
// Kept as a tiny backend-side mirror so this helper can stand alone without
// importing from the webapp folder. The IDs match the backend
// BUILTIN_ADDITIONAL_PROVIDERS list; runtime defaults pick a working model
// per transport when the caller doesn't pin one.

export type EditorialTransport =
  | 'anthropic_messages'
  | 'openai_responses'
  | 'openai_chat';

export interface EditorialProviderEntry {
  id: string;
  transport: EditorialTransport;
  baseUrl: string;
  defaultModel: string;
}

const PROVIDERS: ReadonlyArray<EditorialProviderEntry> = [
  {
    id: 'provider.anthropic',
    transport: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: ANTHROPIC_DEFAULT_VALIDATION_MODEL,
  },
  {
    id: 'provider.openai',
    transport: 'openai_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    defaultModel: 'gpt-5',
  },
  {
    id: 'provider.gemini',
    transport: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
  },
  {
    id: 'provider.nvidia',
    transport: 'openai_chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'moonshotai/kimi-k2.5',
  },
];

const FIXTURE_PROVIDER_TO_ID: Record<string, string> = {
  ANTHROPIC: 'provider.anthropic',
  OPENAI: 'provider.openai',
  GOOGLE: 'provider.gemini',
  GEMINI: 'provider.gemini',
  NVIDIA: 'provider.nvidia',
};

export function providerIdForFixtureProvider(
  fixtureProvider: string,
): string | null {
  return FIXTURE_PROVIDER_TO_ID[fixtureProvider.toUpperCase()] ?? null;
}

export function getEditorialProvider(
  providerId: string,
): EditorialProviderEntry | null {
  return PROVIDERS.find((p) => p.id === providerId) ?? null;
}

// ─── Credential resolution + refresh ────────────────────────────────────────

export interface ResolvedCredential {
  providerId: string;
  transport: EditorialTransport;
  baseUrl: string;
  model: string;
  secret: ProviderSecretPayload;
}

export interface ResolveAgentCredentialOptions {
  fetchImpl?: typeof fetch;
  /** Override the default model for the agent's provider. Optional — most
   *  panel turns use the provider's documented default. */
  modelOverride?: string;
  /** Skip the refresh-on-expiring step (useful for tests). */
  skipRefresh?: boolean;
}

/**
 * Look up the secret for a fixture-provider string (e.g. 'ANTHROPIC') and
 * refresh OAuth tokens that are within 60s of expiring. Throws when the
 * provider is unknown, has no stored credential, or the refresh failed.
 */
export async function resolveAgentCredential(
  fixtureProvider: string,
  options: ResolveAgentCredentialOptions = {},
): Promise<ResolvedCredential> {
  const providerId = providerIdForFixtureProvider(fixtureProvider);
  if (!providerId) {
    throw new Error(
      `No catalog provider for fixture provider '${fixtureProvider}'.`,
    );
  }
  const provider = getEditorialProvider(providerId);
  if (!provider) {
    throw new Error(
      `Provider '${providerId}' is not in the editorial catalog.`,
    );
  }

  const db = getDb();
  const row = db
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?`,
    )
    .get(providerId) as { ciphertext: string } | undefined;
  if (!row) {
    throw new Error(
      `No stored credential for provider '${providerId}'. Connect it from Setup → LLM Room.`,
    );
  }

  let secret = decryptProviderSecret(row.ciphertext);

  if (!options.skipRefresh) {
    secret = await maybeRefreshSecret(providerId, secret, options.fetchImpl);
  }

  return {
    providerId,
    transport: provider.transport,
    baseUrl: provider.baseUrl,
    model: options.modelOverride?.trim() || provider.defaultModel,
    secret,
  };
}

async function maybeRefreshSecret(
  providerId: string,
  secret: ProviderSecretPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderSecretPayload> {
  if (secret.kind === 'anthropic_oauth') {
    if (!isOAuthTokenExpiring(secret.expiresAt)) return secret;
    const refreshed = await refreshOAuthToken({
      refreshToken: secret.refreshToken,
      fetchImpl,
    });
    const next: ProviderAnthropicOAuthSecret = {
      kind: 'anthropic_oauth',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(secret.claudeCodeVersion
        ? { claudeCodeVersion: secret.claudeCodeVersion }
        : {}),
    };
    persistRefreshedSecret(providerId, next);
    return next;
  }

  if (secret.kind === 'openai_codex') {
    if (!secret.expiresAt || !secret.refreshToken) return secret;
    if (!isOAuthTokenExpiring(secret.expiresAt)) return secret;
    let refreshed: ExchangeDeviceCodeResult;
    try {
      refreshed = await refreshDeviceCodeToken({
        refreshToken: secret.refreshToken,
        fetchImpl,
      });
    } catch {
      // Refresh failed; surface the original token and let the request
      // surface the 401, which the caller's refresh-on-401 path can handle.
      return secret;
    }
    const next: ProviderOpenaiCodexSecret = {
      kind: 'openai_codex',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(secret.accountId ? { accountId: secret.accountId } : {}),
    };
    persistRefreshedSecret(providerId, next);
    return next;
  }

  return secret;
}

function persistRefreshedSecret(
  providerId: string,
  secret: ProviderSecretPayload,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE llm_provider_secrets
     SET ciphertext = ?, updated_at = ?
     WHERE provider_id = ?`,
  ).run(encryptProviderSecret(secret), now, providerId);
}

// ─── Streaming dispatch ─────────────────────────────────────────────────────

export type PanelTurnEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'completed'; text: string; durationMs: number }
  | { type: 'error'; message: string };

export interface PanelTurnInput {
  /** Fixture provider tag (uppercase string from FIXTURE_AGENT_PROFILES). */
  fixtureProvider: string;
  /** Optional override; otherwise the catalog default for the provider. */
  modelOverride?: string;
  /** System-prompt text. The Anthropic OAuth path prepends the Claude Code
   *  identity block; api-key paths use the value as-is. */
  systemPrompt: string;
  /** Single user message for the turn. */
  userMessage: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/**
 * Stream a single panel turn for the given agent. Yields `text_delta`
 * events as tokens arrive, then a `completed` event with the full text and
 * elapsed wall time. On failure, yields exactly one `error` event and
 * returns.
 */
export async function* streamPanelTurn(
  input: PanelTurnInput,
): AsyncGenerator<PanelTurnEvent, void, void> {
  const fetchImpl = input.fetchImpl ?? fetch;
  let credential: ResolvedCredential;
  try {
    credential = await resolveAgentCredential(input.fixtureProvider, {
      fetchImpl,
      modelOverride: input.modelOverride,
    });
  } catch (err) {
    yield {
      type: 'error',
      message:
        err instanceof Error ? err.message : 'Failed to resolve credential.',
    };
    return;
  }

  const startedAt = Date.now();
  let accumulated = '';

  // Refresh-on-401: api-key paths never retry; OAuth paths retry once after
  // forcing a token refresh.
  try {
    let retried = false;
    let outerAttempt = streamForTransport(credential, input, fetchImpl);
    for await (const event of outerAttempt) {
      if (event.type === 'auth_failed') {
        if (
          retried ||
          (credential.secret.kind !== 'anthropic_oauth' &&
            credential.secret.kind !== 'openai_codex')
        ) {
          yield { type: 'error', message: event.message };
          return;
        }
        retried = true;
        // Force a refresh by clearing the expiry and re-resolving.
        try {
          const forced = await forceRefresh(credential, fetchImpl);
          credential = forced;
        } catch (err) {
          yield {
            type: 'error',
            message:
              err instanceof Error
                ? err.message
                : 'Failed to refresh OAuth token after 401.',
          };
          return;
        }
        outerAttempt = streamForTransport(credential, input, fetchImpl);
        for await (const retryEvent of outerAttempt) {
          if (retryEvent.type === 'auth_failed') {
            yield { type: 'error', message: retryEvent.message };
            return;
          }
          if (retryEvent.type === 'text_delta') {
            accumulated += retryEvent.text;
          }
          yield retryEvent;
        }
        break;
      }
      if (event.type === 'text_delta') {
        accumulated += event.text;
      }
      yield event;
    }
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Panel turn failed.',
    };
    return;
  }

  yield {
    type: 'completed',
    text: accumulated,
    durationMs: Date.now() - startedAt,
  };
}

async function forceRefresh(
  cred: ResolvedCredential,
  fetchImpl: typeof fetch,
): Promise<ResolvedCredential> {
  if (cred.secret.kind === 'anthropic_oauth') {
    const refreshed = await refreshOAuthToken({
      refreshToken: cred.secret.refreshToken,
      fetchImpl,
    });
    const next: ProviderAnthropicOAuthSecret = {
      kind: 'anthropic_oauth',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(cred.secret.claudeCodeVersion
        ? { claudeCodeVersion: cred.secret.claudeCodeVersion }
        : {}),
    };
    persistRefreshedSecret(cred.providerId, next);
    return { ...cred, secret: next };
  }
  if (cred.secret.kind === 'openai_codex' && cred.secret.refreshToken) {
    const refreshed = await refreshDeviceCodeToken({
      refreshToken: cred.secret.refreshToken,
      fetchImpl,
    });
    const next: ProviderOpenaiCodexSecret = {
      kind: 'openai_codex',
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      ...(cred.secret.accountId ? { accountId: cred.secret.accountId } : {}),
    };
    persistRefreshedSecret(cred.providerId, next);
    return { ...cred, secret: next };
  }
  throw new Error(
    `Cannot refresh credential of kind '${cred.secret.kind}' for ${cred.providerId}.`,
  );
}

type StreamEvent = PanelTurnEvent | { type: 'auth_failed'; message: string };

async function* streamForTransport(
  cred: ResolvedCredential,
  input: PanelTurnInput,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamEvent, void, void> {
  switch (cred.transport) {
    case 'anthropic_messages':
      yield* streamAnthropicMessages(cred, input, fetchImpl);
      return;
    case 'openai_responses':
      yield* streamOpenAIResponses(cred, input, fetchImpl);
      return;
    case 'openai_chat':
      yield* streamOpenAIChat(cred, input, fetchImpl);
      return;
  }
}

// ─── Anthropic Messages ─────────────────────────────────────────────────────

async function* streamAnthropicMessages(
  cred: ResolvedCredential,
  input: PanelTurnInput,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamEvent, void, void> {
  if (
    cred.secret.kind !== 'anthropic_oauth' &&
    cred.secret.kind !== 'api_key'
  ) {
    yield {
      type: 'error',
      message: `Anthropic transport cannot use credential kind '${cred.secret.kind}'.`,
    };
    return;
  }
  const credentialKind: 'oauth_subscription' | 'api_key' =
    cred.secret.kind === 'anthropic_oauth' ? 'oauth_subscription' : 'api_key';
  const token =
    cred.secret.kind === 'anthropic_oauth'
      ? cred.secret.accessToken
      : (cred.secret as ProviderApiKeySecret).apiKey;

  const headers: Record<string, string> = {
    ...buildAnthropicHeaders({
      credentialKind,
      token,
      claudeCodeVersion:
        cred.secret.kind === 'anthropic_oauth'
          ? cred.secret.claudeCodeVersion
          : undefined,
    }),
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  const body = {
    model: cred.model,
    max_tokens: 1024,
    stream: true,
    system: buildAnthropicSystemPrompt({
      credentialKind,
      systemPrompt: input.systemPrompt,
    }),
    messages: [{ role: 'user', content: input.userMessage }],
  };

  const response = await fetchImpl(`${cred.baseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    yield* handleNonOk(response, 'Anthropic');
    return;
  }
  if (!response.body) {
    yield { type: 'error', message: 'Anthropic response had no stream body.' };
    return;
  }

  for await (const event of parseSse(response.body)) {
    const payload = event.data;
    if (!payload || payload === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type === 'content_block_delta') {
      const delta = parsed.delta as { text?: unknown } | undefined;
      if (typeof delta?.text === 'string' && delta.text.length > 0) {
        yield { type: 'text_delta', text: delta.text };
      }
    } else if (parsed.type === 'error') {
      const msg =
        (parsed.error as { message?: unknown } | undefined)?.message ??
        'Anthropic stream returned error.';
      yield { type: 'error', message: String(msg) };
      return;
    }
  }
}

// ─── OpenAI Responses (ChatGPT subscription) ────────────────────────────────

async function* streamOpenAIResponses(
  cred: ResolvedCredential,
  input: PanelTurnInput,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamEvent, void, void> {
  if (cred.secret.kind !== 'openai_codex') {
    yield {
      type: 'error',
      message: `OpenAI Responses transport requires openai_codex credential, not '${cred.secret.kind}'.`,
    };
    return;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.secret.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    // Cloudflare in front of chatgpt.com/backend-api/codex requires a
    // first-party originator + matching User-Agent or it serves 403s.
    originator: 'codex_cli_rs',
    'User-Agent': 'codex_cli_rs/0.0.0 (clawrocket)',
  };
  const accountId = extractChatGPTAccountId(cred.secret.accessToken);
  if (accountId) headers['ChatGPT-Account-ID'] = accountId;

  const body = {
    model: cred.model,
    stream: true,
    instructions: input.systemPrompt,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: input.userMessage }],
      },
    ],
  };

  const response = await fetchImpl(`${cred.baseUrl}/responses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    yield* handleNonOk(response, 'OpenAI Responses');
    return;
  }
  if (!response.body) {
    yield { type: 'error', message: 'OpenAI Responses had no stream body.' };
    return;
  }

  for await (const event of parseSse(response.body)) {
    const payload = event.data;
    if (!payload || payload === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const eventType = String(parsed.type ?? '');
    if (eventType === 'response.output_text.delta') {
      const delta = parsed.delta;
      if (typeof delta === 'string' && delta.length > 0) {
        yield { type: 'text_delta', text: delta };
      }
    } else if (eventType === 'response.error' || eventType === 'error') {
      const errMsg =
        (parsed.error as { message?: unknown } | undefined)?.message ??
        parsed.message ??
        'OpenAI Responses stream returned error.';
      yield { type: 'error', message: String(errMsg) };
      return;
    }
  }
}

function extractChatGPTAccountId(jwt: string): string | null {
  // Best-effort decode of the JWT's middle segment to pull out
  // `https://api.openai.com/auth.chatgpt_account_id`. Bad tokens just
  // return null — the surrounding 401 path will handle the actual auth
  // failure.
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    const padded = parts[1] + '='.repeat((4 - (parts[1].length % 4)) % 4);
    const json = Buffer.from(padded, 'base64url').toString('utf8');
    const claims = JSON.parse(json) as Record<string, unknown>;
    const auth = claims['https://api.openai.com/auth'];
    if (!auth || typeof auth !== 'object') return null;
    const acctId = (auth as Record<string, unknown>).chatgpt_account_id;
    return typeof acctId === 'string' && acctId ? acctId : null;
  } catch {
    return null;
  }
}

// ─── OpenAI Chat Completions (Gemini, NVIDIA, anything OAI-compat) ──────────

async function* streamOpenAIChat(
  cred: ResolvedCredential,
  input: PanelTurnInput,
  fetchImpl: typeof fetch,
): AsyncGenerator<StreamEvent, void, void> {
  if (cred.secret.kind !== 'api_key') {
    yield {
      type: 'error',
      message: `OpenAI Chat transport requires api_key credential, not '${cred.secret.kind}'.`,
    };
    return;
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cred.secret.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };

  const body = {
    model: cred.model,
    stream: true,
    messages: [
      ...(input.systemPrompt
        ? [{ role: 'system' as const, content: input.systemPrompt }]
        : []),
      { role: 'user' as const, content: input.userMessage },
    ],
  };

  const response = await fetchImpl(`${cred.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    yield* handleNonOk(response, cred.providerId);
    return;
  }
  if (!response.body) {
    yield {
      type: 'error',
      message: `${cred.providerId} response had no stream body.`,
    };
    return;
  }

  for await (const event of parseSse(response.body)) {
    const payload = event.data;
    if (!payload || payload === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const choices = parsed.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;
    const delta = (choices[0] as Record<string, unknown>).delta as
      | Record<string, unknown>
      | undefined;
    if (
      delta &&
      typeof delta.content === 'string' &&
      delta.content.length > 0
    ) {
      yield { type: 'text_delta', text: delta.content };
    }
  }
}

// ─── Shared error + SSE parsing ─────────────────────────────────────────────

async function* handleNonOk(
  response: Response,
  providerLabel: string,
): AsyncGenerator<StreamEvent, void, void> {
  const text = await response.text().catch(() => '');
  if (response.status === 401) {
    yield {
      type: 'auth_failed',
      message: `${providerLabel}: 401 Unauthorized${text ? ` — ${truncate(text, 240)}` : ''}`,
    };
    return;
  }
  yield {
    type: 'error',
    message: `${providerLabel}: HTTP ${response.status}${text ? ` — ${truncate(text, 240)}` : ''}`,
  };
}

function truncate(str: string, max: number): string {
  return str.length <= max ? str : `${str.slice(0, max)}…`;
}

interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Minimal SSE parser. Reads UTF-8 chunks from a ReadableStream and yields
 * one event per blank-line-terminated record. Concatenates multi-line
 * `data:` fields with a newline per the spec. Ignores `id:` and `retry:`.
 */
async function* parseSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parseSseRecord(raw);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = parseSseRecord(tail);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseRecord(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const valueRaw = colon === -1 ? '' : line.slice(colon + 1);
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !eventName) return null;
  return {
    event: eventName,
    data: dataLines.join('\n'),
  };
}
