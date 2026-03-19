import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../db.js';
import { _initTestDatabase, upsertUser } from '../../db/index.js';
import { encryptProviderSecret } from '../../llm/provider-secret-store.js';
import type { AuthContext } from '../types.js';
import {
  getAiAgentsRoute,
  putAiProviderCredentialRoute,
  verifyAiProviderCredentialRoute,
} from './ai-agents.js';

const auth: AuthContext = {
  sessionId: 'session-1',
  userId: 'owner-1',
  role: 'owner',
  authType: 'bearer',
};

function seedProviderSecret(
  providerId: string,
  apiKey: string,
  organizationId?: string,
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(
      providerId,
      encryptProviderSecret({
        apiKey,
        ...(organizationId ? { organizationId } : {}),
      }),
      now,
      auth.userId,
    );
}

function createOpenAiStreamResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":null}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
        ),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('ai-agents routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: auth.userId,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns builtin additional provider cards on a fresh database', () => {
    const result = getAiAgentsRoute();
    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('Expected ok response');
    }

    expect(
      result.body.data.additionalProviders.map((provider) => provider.id),
    ).toEqual(['provider.openai', 'provider.gemini', 'provider.nvidia']);
  });

  it('saves and verifies an OpenAI credential through the direct-http client', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
        return createOpenAiStreamResponse();
      }),
    );

    const result = await putAiProviderCredentialRoute(auth, 'provider.openai', {
      apiKey: 'sk-openai-good',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('Expected ok response');
    }

    expect(result.body.data.provider.hasCredential).toBe(true);
    expect(result.body.data.provider.credentialHint).toBe('••••good');
    expect(result.body.data.provider.verificationStatus).toBe('verified');

    const secretRow = getDb()
      .prepare(
        `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = 'provider.openai'`,
      )
      .get() as { ciphertext: string } | undefined;
    expect(secretRow?.ciphertext).toBeTruthy();
    expect(secretRow?.ciphertext.includes('sk-openai-good')).toBe(false);

    const storedVerification = getDb()
      .prepare(
        `SELECT status FROM llm_provider_verifications WHERE provider_id = 'provider.openai'`,
      )
      .get() as { status: string } | undefined;
    expect(storedVerification?.status).toBe('verified');
  });

  it('verifies Gemini credentials against the Google OpenAI-compatible endpoint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        );
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer AIza-gemini-good',
        );
        return createOpenAiStreamResponse();
      }),
    );

    const result = await putAiProviderCredentialRoute(auth, 'provider.gemini', {
      apiKey: 'AIza-gemini-good',
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('Expected ok response');
    }

    expect(result.body.data.provider.hasCredential).toBe(true);
    expect(result.body.data.provider.verificationStatus).toBe('verified');
  });

  it('marks a provider invalid when upstream rejects the stored API key', async () => {
    seedProviderSecret('provider.nvidia', 'nvapi-bad-key');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 })),
    );

    const result = await verifyAiProviderCredentialRoute(
      auth,
      'provider.nvidia',
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('Expected ok response');
    }

    expect(result.body.data.provider.verificationStatus).toBe('invalid');
    expect(result.body.data.provider.lastVerificationError).toBe(
      'Invalid API key.',
    );
  });

  it('clears provider credentials and returns the card to missing state', async () => {
    seedProviderSecret('provider.gemini', 'gemini-secret');
    const now = new Date().toISOString();
    getDb()
      .prepare(
        `INSERT INTO llm_provider_verifications (
           provider_id, status, last_verified_at, last_error, updated_at
         )
         VALUES ('provider.gemini', 'verified', ?, NULL, ?)`,
      )
      .run(now, now);

    const result = await putAiProviderCredentialRoute(auth, 'provider.gemini', {
      apiKey: null,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('Expected ok response');
    }

    expect(result.body.data.provider.hasCredential).toBe(false);
    expect(result.body.data.provider.verificationStatus).toBe('missing');
    expect(
      getDb()
        .prepare(
          `SELECT 1 FROM llm_provider_secrets WHERE provider_id = 'provider.gemini'`,
        )
        .get(),
    ).toBeUndefined();
  });
});
