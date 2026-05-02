import { describe, expect, it, vi } from 'vitest';

import {
  ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX,
  ANTHROPIC_OAUTH_AUTHORIZE_URL,
  ANTHROPIC_OAUTH_BETAS,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
  ANTHROPIC_OAUTH_SCOPES,
  ANTHROPIC_OAUTH_TOKEN_URLS,
  ANTHROPIC_VERSION_HEADER,
  buildAnthropicHeaders,
  buildAnthropicSystemPrompt,
  buildAuthorizeUrl,
  createPkcePair,
  exchangeAuthorizationCode,
  isOAuthTokenExpiring,
  refreshOAuthToken,
} from './anthropic-oauth.js';

describe('createPkcePair', () => {
  it('returns a verifier and challenge of expected length', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toHaveLength(64);
    expect(pair.challenge.length).toBeGreaterThan(40);
    // url-safe base64 — no `+`, `/`, or `=`
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces unique pairs per call', () => {
    const a = createPkcePair();
    const b = createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds an authorize URL with all required OAuth params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        codeChallenge: 'test-challenge',
        state: 'state-abc',
      }),
    );

    expect(url.origin + url.pathname).toBe(ANTHROPIC_OAUTH_AUTHORIZE_URL);
    expect(url.searchParams.get('code')).toBe('true');
    expect(url.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(
      ANTHROPIC_OAUTH_REDIRECT_URI,
    );
    expect(url.searchParams.get('scope')).toBe(
      ANTHROPIC_OAUTH_SCOPES.join(' '),
    );
    expect(url.searchParams.get('code_challenge')).toBe('test-challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-abc');
  });

  it('honours an explicit redirectUri', () => {
    const url = new URL(
      buildAuthorizeUrl({
        codeChallenge: 'c',
        state: 's',
        redirectUri: 'https://localhost:3210/oauth/callback',
      }),
    );
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://localhost:3210/oauth/callback',
    );
  });
});

describe('buildAnthropicHeaders', () => {
  it('returns x-api-key auth for api_key credentials', () => {
    const headers = buildAnthropicHeaders({
      credentialKind: 'api_key',
      token: 'sk-ant-123',
    });
    expect(headers['anthropic-version']).toBe(ANTHROPIC_VERSION_HEADER);
    expect(headers['x-api-key']).toBe('sk-ant-123');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['anthropic-beta']).toBeTruthy();
  });

  it('returns Bearer + Claude Code identity headers for oauth_subscription', () => {
    const headers = buildAnthropicHeaders({
      credentialKind: 'oauth_subscription',
      token: 'access-xyz',
    });
    expect(headers.Authorization).toBe('Bearer access-xyz');
    expect(headers['anthropic-beta']).toBe(ANTHROPIC_OAUTH_BETAS.join(','));
    expect(headers['user-agent']).toContain('claude-cli/');
    expect(headers['user-agent']).toContain('(external, cli)');
    expect(headers['x-app']).toBe('cli');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('uses provided claudeCodeVersion in user-agent', () => {
    const headers = buildAnthropicHeaders({
      credentialKind: 'oauth_subscription',
      token: 't',
      claudeCodeVersion: '9.9.9',
    });
    expect(headers['user-agent']).toBe('claude-cli/9.9.9 (external, cli)');
  });
});

describe('buildAnthropicSystemPrompt', () => {
  it('returns the plain string for api_key credentials', () => {
    expect(
      buildAnthropicSystemPrompt({
        credentialKind: 'api_key',
        systemPrompt: 'You are a writer.',
      }),
    ).toBe('You are a writer.');
  });

  it('prepends the Claude Code identity block for oauth_subscription', () => {
    const result = buildAnthropicSystemPrompt({
      credentialKind: 'oauth_subscription',
      systemPrompt: 'You are a writer.',
    });
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error('expected array');
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      type: 'text',
      text: ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX,
    });
    expect(result[1]).toEqual({ type: 'text', text: 'You are a writer.' });
  });

  it('returns identity-only block when systemPrompt is empty (oauth)', () => {
    const result = buildAnthropicSystemPrompt({
      credentialKind: 'oauth_subscription',
      systemPrompt: '',
    });
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) throw new Error('expected array');
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe(ANTHROPIC_CLAUDE_CODE_SYSTEM_PREFIX);
  });
});

describe('isOAuthTokenExpiring', () => {
  it('treats null/undefined as expiring', () => {
    expect(isOAuthTokenExpiring(null)).toBe(true);
    expect(isOAuthTokenExpiring(undefined)).toBe(true);
  });

  it('treats a malformed date as expiring', () => {
    expect(isOAuthTokenExpiring('not-a-date')).toBe(true);
  });

  it('reports past timestamps as expiring', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isOAuthTokenExpiring(past)).toBe(true);
  });

  it('reports timestamps within the skew window as expiring', () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    expect(isOAuthTokenExpiring(soon, 60_000)).toBe(true);
  });

  it('reports timestamps beyond the skew window as not expiring', () => {
    const later = new Date(Date.now() + 120_000).toISOString();
    expect(isOAuthTokenExpiring(later, 60_000)).toBe(false);
  });
});

describe('exchangeAuthorizationCode', () => {
  it('returns parsed tokens on first-endpoint success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'a-1',
          refresh_token: 'r-1',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tokens = await exchangeAuthorizationCode({
      code: 'abc',
      codeVerifier: 'verifier',
      state: 'state',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe('a-1');
    expect(tokens.refreshToken).toBe('r-1');
    // ~1 hour out
    const ms = Date.parse(tokens.expiresAt) - Date.now();
    expect(ms).toBeGreaterThan(3500_000);
    expect(ms).toBeLessThan(3700_000);
    // Hit the first token URL only.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(ANTHROPIC_OAUTH_TOKEN_URLS[0]);
  });

  it('falls through to the second endpoint when first returns non-OK', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'a-2',
            refresh_token: 'r-2',
            expires_in: 1800,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

    const tokens = await exchangeAuthorizationCode({
      code: 'abc',
      codeVerifier: 'verifier',
      state: 'state',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe('a-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when both endpoints reject', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 400 }));

    await expect(
      exchangeAuthorizationCode({
        code: 'c',
        codeVerifier: 'v',
        state: 's',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/code exchange failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('refreshOAuthToken', () => {
  it('returns refreshed tokens on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'a-new',
          refresh_token: 'r-new',
          expires_in: 7200,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tokens = await refreshOAuthToken({
      refreshToken: 'r-old',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe('a-new');
    expect(tokens.refreshToken).toBe('r-new');
  });

  it('keeps the prior refresh token when the response omits it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'a-new',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const tokens = await refreshOAuthToken({
      refreshToken: 'r-old',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe('a-new');
    expect(tokens.refreshToken).toBe('r-old');
  });
});
