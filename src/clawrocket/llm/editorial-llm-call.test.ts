import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../db.js';
import { _initTestDatabase, upsertUser } from '../db/index.js';
import {
  providerIdForFixtureProvider,
  resolveAgentCredential,
  streamPanelTurn,
} from './editorial-llm-call.js';
import {
  decryptProviderSecret,
  encryptProviderSecret,
} from './provider-secret-store.js';

function seedProviderSecret(
  providerId: string,
  payload: Parameters<typeof encryptProviderSecret>[0],
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(providerId, encryptProviderSecret(payload), now, 'tester');
}

function readStoredSecret(providerId: string) {
  const row = getDb()
    .prepare(
      'SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = ?',
    )
    .get(providerId) as { ciphertext: string } | undefined;
  return row ? decryptProviderSecret(row.ciphertext) : null;
}

function makeStreamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect<T>(iter: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of iter) out.push(event);
  return out;
}

describe('providerIdForFixtureProvider', () => {
  it('maps each fixture string to its catalog id', () => {
    expect(providerIdForFixtureProvider('ANTHROPIC')).toBe(
      'provider.anthropic',
    );
    expect(providerIdForFixtureProvider('OPENAI')).toBe('provider.openai');
    expect(providerIdForFixtureProvider('GOOGLE')).toBe('provider.gemini');
    expect(providerIdForFixtureProvider('GEMINI')).toBe('provider.gemini');
    expect(providerIdForFixtureProvider('NVIDIA')).toBe('provider.nvidia');
  });

  it('is case-insensitive and returns null for unknown providers', () => {
    expect(providerIdForFixtureProvider('anthropic')).toBe(
      'provider.anthropic',
    );
    expect(providerIdForFixtureProvider('mistral')).toBeNull();
    expect(providerIdForFixtureProvider('')).toBeNull();
  });
});

describe('resolveAgentCredential', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'tester',
      email: 'tester@example.com',
      displayName: 'tester',
      role: 'owner',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws when no secret is stored for the provider', async () => {
    await expect(resolveAgentCredential('GEMINI')).rejects.toThrow(
      /No stored credential/,
    );
  });

  it('returns the api_key secret + transport for gemini', async () => {
    seedProviderSecret('provider.gemini', { kind: 'api_key', apiKey: 'g-1' });
    const cred = await resolveAgentCredential('GEMINI');
    expect(cred.providerId).toBe('provider.gemini');
    expect(cred.transport).toBe('openai_chat');
    expect(cred.baseUrl).toContain('generativelanguage.googleapis.com');
    expect(cred.model).toBe('gemini-2.5-flash');
    expect(cred.secret.kind).toBe('api_key');
  });

  it('honours modelOverride when provided', async () => {
    seedProviderSecret('provider.nvidia', {
      kind: 'api_key',
      apiKey: 'nv-1',
    });
    const cred = await resolveAgentCredential('NVIDIA', {
      modelOverride: 'meta/llama-4-instruct',
    });
    expect(cred.model).toBe('meta/llama-4-instruct');
  });

  it('refreshes anthropic_oauth tokens that are about to expire and persists the rotation', async () => {
    const expiringAt = new Date(Date.now() + 30_000).toISOString();
    seedProviderSecret('provider.anthropic', {
      kind: 'anthropic_oauth',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      expiresAt: expiringAt,
      claudeCodeVersion: '2.1.113',
    });

    const fetchImpl = vi.fn().mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const cred = await resolveAgentCredential('ANTHROPIC', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(cred.secret.kind).toBe('anthropic_oauth');
    if (cred.secret.kind !== 'anthropic_oauth') return;
    expect(cred.secret.accessToken).toBe('new-access');
    expect(cred.secret.refreshToken).toBe('new-refresh');
    expect(cred.secret.claudeCodeVersion).toBe('2.1.113');

    const stored = readStoredSecret('provider.anthropic');
    expect(stored?.kind).toBe('anthropic_oauth');
    if (stored && stored.kind === 'anthropic_oauth') {
      expect(stored.accessToken).toBe('new-access');
    }
  });

  it('does not refresh anthropic_oauth tokens that are still valid', async () => {
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    seedProviderSecret('provider.anthropic', {
      kind: 'anthropic_oauth',
      accessToken: 'still-good',
      refreshToken: 'rt',
      expiresAt,
    });
    const fetchImpl = vi.fn();
    const cred = await resolveAgentCredential('ANTHROPIC', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(cred.secret.kind).toBe('anthropic_oauth');
    if (cred.secret.kind === 'anthropic_oauth') {
      expect(cred.secret.accessToken).toBe('still-good');
    }
  });
});

describe('streamPanelTurn — transport dispatch', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'tester',
      email: 'tester@example.com',
      displayName: 'tester',
      role: 'owner',
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches anthropic_messages and yields parsed text deltas + completed', async () => {
    seedProviderSecret('provider.anthropic', {
      kind: 'anthropic_oauth',
      accessToken: 'tok',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      return makeStreamResponse([
        'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","delta":{"text":"hel"}}\n\n',
        'event: content_block_delta\n' +
          'data: {"type":"content_block_delta","delta":{"text":"lo"}}\n\n',
        'event: message_stop\n' + 'data: {"type":"message_stop"}\n\n',
      ]);
    });

    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'ANTHROPIC',
        systemPrompt: 'system',
        userMessage: 'hi',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const calledBody = JSON.parse(
      fetchImpl.mock.calls[0][1].body as string,
    ) as Record<string, unknown>;
    expect(calledBody.stream).toBe(true);
    expect(calledBody.model).toBe('claude-sonnet-4-20250514');
    // OAuth subscription system prompt comes back as content blocks with the
    // Claude Code identity prefix as the first block.
    expect(Array.isArray(calledBody.system)).toBe(true);
    expect(
      ((calledBody.system as Array<{ text: string }>)[0].text ?? '').startsWith(
        'You are Claude Code',
      ),
    ).toBe(true);

    expect(events.filter((e) => e.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'hel' },
      { type: 'text_delta', text: 'lo' },
    ]);
    const completed = events.find((e) => e.type === 'completed');
    expect(completed?.type).toBe('completed');
    if (completed?.type === 'completed') {
      expect(completed.text).toBe('hello');
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('dispatches openai_chat for gemini and parses Chat Completions deltas', async () => {
    seedProviderSecret('provider.gemini', {
      kind: 'api_key',
      apiKey: 'gem-key',
    });

    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        expect(url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
        );
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer gem-key');
        return makeStreamResponse([
          'data: {"choices":[{"delta":{"content":"foo "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"bar"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
      });

    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'GEMINI',
        systemPrompt: 'sys',
        userMessage: 'hi',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    const completed = events.find((e) => e.type === 'completed');
    expect(completed?.type).toBe('completed');
    if (completed?.type === 'completed') {
      expect(completed.text).toBe('foo bar');
    }
  });

  it('dispatches openai_responses for openai subscription and parses delta events', async () => {
    seedProviderSecret('provider.openai', {
      kind: 'openai_codex',
      accessToken: 'codex-token',
      refreshToken: 'codex-refresh',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const fetchImpl = vi
      .fn()
      .mockImplementation(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer codex-token');
        expect(headers.originator).toBe('codex_cli_rs');
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body.stream).toBe(true);
        expect(body.instructions).toBe('sys');
        return makeStreamResponse([
          'event: response.output_text.delta\n' +
            'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
          'event: response.completed\n' +
            'data: {"type":"response.completed"}\n\n',
        ]);
      });

    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'OPENAI',
        systemPrompt: 'sys',
        userMessage: 'hello',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    const completed = events.find((e) => e.type === 'completed');
    if (completed?.type === 'completed') {
      expect(completed.text).toBe('hi');
    } else {
      throw new Error('Expected completed event');
    }
  });

  it('refreshes the OAuth token once on a 401 and retries the request', async () => {
    seedProviderSecret('provider.anthropic', {
      kind: 'anthropic_oauth',
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });

    const fetchImpl = vi
      .fn()
      // 1st call: anthropic /v1/messages → 401
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"expired"}}', { status: 401 }),
      )
      // 2nd call: refresh /v1/oauth/token → new token
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'fresh',
            refresh_token: 'rt2',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      // 3rd call: anthropic /v1/messages retry → stream
      .mockResolvedValueOnce(
        makeStreamResponse([
          'event: content_block_delta\n' +
            'data: {"type":"content_block_delta","delta":{"text":"ok"}}\n\n',
        ]),
      );

    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'ANTHROPIC',
        systemPrompt: 's',
        userMessage: 'u',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const completed = events.find((e) => e.type === 'completed');
    if (completed?.type === 'completed') {
      expect(completed.text).toBe('ok');
    } else {
      throw new Error('Expected completed event');
    }
    const stored = readStoredSecret('provider.anthropic');
    if (stored?.kind === 'anthropic_oauth') {
      expect(stored.accessToken).toBe('fresh');
    } else {
      throw new Error('Expected anthropic_oauth secret');
    }
  });

  it('does not retry an api_key 401 — yields a single error event', async () => {
    seedProviderSecret('provider.gemini', {
      kind: 'api_key',
      apiKey: 'bad',
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"error":"unauth"}', { status: 401 }),
      );

    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'GEMINI',
        systemPrompt: 's',
        userMessage: 'u',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events.find((e) => e.type === 'error')?.type).toBe('error');
    expect(events.find((e) => e.type === 'completed')).toBeUndefined();
  });

  it('yields an error event when no credential is stored', async () => {
    const events = await collect(
      streamPanelTurn({
        fixtureProvider: 'NVIDIA',
        systemPrompt: 's',
        userMessage: 'u',
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    if (events[0].type === 'error') {
      expect(events[0].message).toMatch(/No stored credential/);
    }
  });
});
