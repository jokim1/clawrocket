import crypto from 'crypto';

import { readEnvFile } from '../../env.js';
import { logger } from '../../logger.js';
import type { ProviderSecretPayload } from './types.js';

export const PROVIDER_SECRET_KEY_ENV = 'CLAWROCKET_PROVIDER_SECRET_KEY';
export const PROVIDER_SECRET_DEV_FALLBACK =
  'clawrocket-dev-provider-secret-key-unsafe-default';
const AES_ALGO = 'aes-256-gcm';
let warnedAboutFallbackSecret = false;
const envConfig = readEnvFile([PROVIDER_SECRET_KEY_ENV]);

function getSecretMaterial(): string {
  const configured = (
    process.env[PROVIDER_SECRET_KEY_ENV] ||
    envConfig[PROVIDER_SECRET_KEY_ENV] ||
    ''
  ).trim();
  if (configured) return configured;

  if (!warnedAboutFallbackSecret && process.env.NODE_ENV !== 'test') {
    warnedAboutFallbackSecret = true;
    logger.warn(
      { envVar: PROVIDER_SECRET_KEY_ENV },
      'Using unsafe development fallback for Talk provider secret encryption key',
    );
  }

  return PROVIDER_SECRET_DEV_FALLBACK;
}

function deriveKey(): Buffer {
  return crypto.scryptSync(
    getSecretMaterial(),
    'clawrocket-provider-store',
    32,
  );
}

function validateProviderSecretPayload(
  payload: ProviderSecretPayload,
): ProviderSecretPayload {
  switch (payload.kind) {
    case 'api_key': {
      if (!payload.apiKey || typeof payload.apiKey !== 'string') {
        throw new Error('Provider secret payload missing apiKey');
      }
      if (
        payload.organizationId !== undefined &&
        typeof payload.organizationId !== 'string'
      ) {
        throw new Error(
          'Provider secret payload organizationId must be a string',
        );
      }
      return payload;
    }
    case 'anthropic_oauth': {
      if (!payload.accessToken || typeof payload.accessToken !== 'string') {
        throw new Error('Anthropic OAuth payload missing accessToken');
      }
      if (!payload.refreshToken || typeof payload.refreshToken !== 'string') {
        throw new Error('Anthropic OAuth payload missing refreshToken');
      }
      if (!payload.expiresAt || typeof payload.expiresAt !== 'string') {
        throw new Error('Anthropic OAuth payload missing expiresAt');
      }
      if (Number.isNaN(Date.parse(payload.expiresAt))) {
        throw new Error('Anthropic OAuth expiresAt is not a valid ISO date');
      }
      return payload;
    }
    case 'openai_codex': {
      if (!payload.accessToken || typeof payload.accessToken !== 'string') {
        throw new Error('OpenAI Codex payload missing accessToken');
      }
      if (
        payload.refreshToken !== undefined &&
        typeof payload.refreshToken !== 'string'
      ) {
        throw new Error(
          'OpenAI Codex refreshToken must be a string when present',
        );
      }
      if (
        payload.expiresAt !== undefined &&
        Number.isNaN(Date.parse(payload.expiresAt))
      ) {
        throw new Error('OpenAI Codex expiresAt is not a valid ISO date');
      }
      return payload;
    }
    default: {
      // Exhaustive — TS narrows away the union at compile time, runtime
      // protection for malformed payloads.
      const _exhaustive: never = payload;
      throw new Error(
        `Provider secret payload has unknown kind: ${(_exhaustive as { kind?: unknown }).kind}`,
      );
    }
  }
}

// Decode the legacy shape (no `kind` field, just `{ apiKey, organizationId? }`)
// into the new discriminated union. Runs before validation so old DB rows
// keep working without a migration.
function backfillLegacyPayload(raw: unknown): ProviderSecretPayload {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Provider secret payload is not an object');
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.kind === 'string') {
    return obj as unknown as ProviderSecretPayload;
  }
  // No discriminant — assume it's the pre-union api_key shape.
  if (typeof obj.apiKey === 'string') {
    return {
      kind: 'api_key',
      apiKey: obj.apiKey,
      organizationId:
        typeof obj.organizationId === 'string' ? obj.organizationId : undefined,
    };
  }
  throw new Error('Provider secret payload missing kind discriminator');
}

export function encryptProviderSecret(payload: ProviderSecretPayload): string {
  const iv = crypto.randomBytes(12);
  const key = deriveKey();
  const cipher = crypto.createCipheriv(AES_ALGO, key, iv);
  const plaintext = JSON.stringify(payload);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: AES_ALGO,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  });
}

export function decryptProviderSecret(
  ciphertext: string,
): ProviderSecretPayload {
  const parsed = JSON.parse(ciphertext) as {
    v: number;
    alg: string;
    iv: string;
    tag: string;
    data: string;
  };

  if (parsed.v !== 1 || parsed.alg !== AES_ALGO) {
    throw new Error('Unsupported provider secret payload format');
  }

  const decipher = crypto.createDecipheriv(
    AES_ALGO,
    deriveKey(),
    Buffer.from(parsed.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parsed.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const raw = JSON.parse(plaintext) as unknown;
  const payload = backfillLegacyPayload(raw);
  return validateProviderSecretPayload(payload);
}
