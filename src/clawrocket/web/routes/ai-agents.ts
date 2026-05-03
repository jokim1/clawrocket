// Editorial provider card listing + provider secret management.
//
// PR-3 of the PURGE collapsed this from 787 LOC (with codex-host status,
// real LLM verification, default Claude model selection — all Talk-era
// concerns) down to the minimum the Editorial Room actually consumes:
//   - GET /api/v1/agents → additionalProviders[] for the Setup → LLM Room
//     provider cards
//   - PUT /api/v1/agents/providers/:providerId → set/update an API key
//
// Real per-key verification (calling the provider with the new key to
// confirm it works) is deferred to Phase F of CLOUD_TARGET. v1 trusts
// the user — if a key is wrong, it surfaces on the next panel turn as
// an HTTP 401 from the provider.

import { getDb } from '../../../db.js';
import { BUILTIN_ADDITIONAL_PROVIDERS } from '../../llm/builtin-providers.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from '../../llm/provider-secret-store.js';
import type { ProviderApiKeySecret } from '../../llm/types.js';
import type { ApiEnvelope, AuthContext } from '../types.js';

type AdditionalProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export type AgentProviderCard = {
  id: string;
  name: string;
  providerKind: 'openai' | 'gemini' | 'nvidia';
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: AdditionalProviderVerificationStatus;
};

export type AiAgentsPageData = {
  additionalProviders: AgentProviderCard[];
};

interface ProviderSecretBody {
  apiKey?: unknown;
}

const BUILTIN_PROVIDER_IDS = BUILTIN_ADDITIONAL_PROVIDERS.map((p) => p.id);

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function maskApiKey(key: string): string {
  if (!key || key.length < 8) return '••••';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

interface SecretRow {
  ciphertext: string;
}

function getCredentialHint(providerId: string): string | null {
  const row = getDb()
    .prepare(
      'SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?',
    )
    .get(providerId) as SecretRow | undefined;
  if (!row) return null;
  try {
    const secret = decryptProviderSecret(row.ciphertext);
    if (secret.kind === 'api_key') return maskApiKey(secret.apiKey);
    if (secret.kind === 'anthropic_oauth') return 'OAuth (Claude.ai)';
    if (secret.kind === 'openai_codex') return 'OAuth (ChatGPT)';
    return '••••';
  } catch {
    return '••••';
  }
}

function hasCredential(providerId: string): boolean {
  return !!getDb()
    .prepare('SELECT 1 FROM llm_provider_secrets WHERE provider_id = ?')
    .get(providerId);
}

function buildCard(
  provider: (typeof BUILTIN_ADDITIONAL_PROVIDERS)[number],
): AgentProviderCard {
  // Codex (host login) is editorial-irrelevant; ignore it in the listing.
  if (provider.credentialMode !== 'api_key') {
    return {
      id: provider.id,
      name: provider.name,
      providerKind: provider.providerKind,
      hasCredential: false,
      credentialHint: null,
      verificationStatus: 'unavailable',
    };
  }
  const credentialPresent = hasCredential(provider.id);
  return {
    id: provider.id,
    name: provider.name,
    providerKind: provider.providerKind,
    hasCredential: credentialPresent,
    credentialHint: credentialPresent ? getCredentialHint(provider.id) : null,
    // v1 stub: presence implies trusted. Real verification (Phase F) calls
    // the provider with the key to confirm it works.
    verificationStatus: credentialPresent ? 'verified' : 'missing',
  };
}

export async function buildAiAgentsPageData(): Promise<AiAgentsPageData> {
  return {
    additionalProviders: BUILTIN_ADDITIONAL_PROVIDERS.filter(
      (p) => p.credentialMode === 'api_key',
    ).map(buildCard),
  };
}

export async function getAiAgentsRoute(): Promise<{
  status: number;
  body: ApiEnvelope<AiAgentsPageData>;
}> {
  const data = await buildAiAgentsPageData();
  return { status: 200, body: { ok: true, data } };
}

export async function putAiProviderCredentialRoute(
  auth: AuthContext,
  providerId: string,
  body: ProviderSecretBody,
): Promise<{ status: number; body: ApiEnvelope<AiAgentsPageData> }> {
  if (!isAdminLike(auth.role)) {
    return {
      status: 403,
      body: {
        ok: false,
        error: { code: 'forbidden', message: 'Admin role required' },
      },
    };
  }
  if (!BUILTIN_PROVIDER_IDS.includes(providerId)) {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Unknown provider: ${providerId}`,
        },
      },
    };
  }
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  if (!apiKey) {
    return {
      status: 400,
      body: {
        ok: false,
        error: { code: 'invalid_input', message: 'apiKey is required' },
      },
    };
  }

  const secret: ProviderApiKeySecret = { kind: 'api_key', apiKey };
  const ciphertext = encryptProviderSecret(secret);
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
    .run(providerId, ciphertext, now, auth.userId);

  const data = await buildAiAgentsPageData();
  return { status: 200, body: { ok: true, data } };
}

export async function verifyAiProviderCredentialRoute(
  _auth: AuthContext,
  providerId: string,
): Promise<{ status: number; body: ApiEnvelope<AiAgentsPageData> }> {
  // v1 stub. Real verification (call provider with key) lands in Phase F.
  if (!BUILTIN_PROVIDER_IDS.includes(providerId)) {
    return {
      status: 404,
      body: {
        ok: false,
        error: {
          code: 'not_found',
          message: `Unknown provider: ${providerId}`,
        },
      },
    };
  }
  const data = await buildAiAgentsPageData();
  return { status: 200, body: { ok: true, data } };
}

// Talk-era endpoint kept stubbed so server.ts compiles. Returns a no-op
// page payload — no consumer in the editorial flow.
export async function updateDefaultClaudeModelRoute(
  _auth: AuthContext,
  _body: unknown,
): Promise<{ status: number; body: ApiEnvelope<AiAgentsPageData> }> {
  const data = await buildAiAgentsPageData();
  return { status: 200, body: { ok: true, data } };
}
