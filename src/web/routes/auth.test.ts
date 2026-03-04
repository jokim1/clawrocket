import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../../db.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('auth routes (phase 1)', () => {
  let server: WebServerHandle;

  beforeEach(async () => {
    _initTestDatabase();
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
    });
  });

  it('supports owner-claim on first OAuth callback and /session/me', async () => {
    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;
    const state = startBody.data.state as string;

    const callbackRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        state,
      )}&email=owner@example.com&name=Owner`,
    );
    expect(callbackRes.status).toBe(200);
    const callbackBody = (await callbackRes.json()) as any;
    expect(callbackBody.data.user.role).toBe('owner');

    const cookies = getCookieHeader(callbackRes);
    expect(cookies).toContain('cr_access_token=');

    const meRes = await server.request('/api/v1/session/me', {
      headers: {
        Cookie: cookies,
      },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as any;
    expect(meBody.data.user.email).toBe('owner@example.com');
  });

  it('requires invite for second account and allows login after invite', async () => {
    const ownerCtx = await loginViaDevCallback(
      server,
      'owner@example.com',
      'Owner',
    );

    const startRes = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    const startBody = (await startRes.json()) as any;
    const blockedRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        startBody.data.state,
      )}&email=member@example.com&name=Member`,
    );
    expect(blockedRes.status).toBe(403);

    const inviteRes = await server.request('/api/v1/settings/users/invite', {
      method: 'POST',
      headers: {
        Cookie: ownerCtx.cookies,
        'Content-Type': 'application/json',
        'X-CSRF-Token': ownerCtx.csrfToken,
      },
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    expect(inviteRes.status).toBe(200);

    const startRes2 = await server.request('/api/v1/auth/google/start', {
      method: 'POST',
    });
    const startBody2 = (await startRes2.json()) as any;
    const allowedRes = await server.request(
      `/api/v1/auth/google/callback?state=${encodeURIComponent(
        startBody2.data.state,
      )}&email=member@example.com&name=Member`,
    );
    expect(allowedRes.status).toBe(200);
    const allowedBody = (await allowedRes.json()) as any;
    expect(allowedBody.data.user.role).toBe('member');
  });

  it('refreshes and logs out sessions', async () => {
    const ownerCtx = await loginViaDevCallback(
      server,
      'owner@example.com',
      'Owner',
    );

    const refreshRes = await server.request('/api/v1/auth/refresh', {
      method: 'POST',
      headers: {
        Cookie: ownerCtx.cookies,
      },
    });
    expect(refreshRes.status).toBe(200);
    const refreshedCookies = getCookieHeader(refreshRes);
    expect(refreshedCookies).toContain('cr_access_token=');
    const refreshedAccessToken =
      getCookieValue(refreshedCookies, 'cr_access_token') ||
      ownerCtx.accessToken;

    const logoutRes = await server.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${refreshedAccessToken}`,
      },
    });
    expect(logoutRes.status).toBe(200);

    const meRes = await server.request('/api/v1/session/me', {
      headers: {
        Authorization: `Bearer ${refreshedAccessToken}`,
      },
    });
    expect(meRes.status).toBe(401);
  });

  it('supports device flow completion for existing user', async () => {
    await loginViaDevCallback(server, 'owner@example.com', 'Owner');

    const startRes = await server.request('/api/v1/auth/device/start', {
      method: 'POST',
    });
    expect(startRes.status).toBe(200);
    const startBody = (await startRes.json()) as any;

    const completeRes = await server.request('/api/v1/auth/device/complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceCode: startBody.data.deviceCode,
        email: 'owner@example.com',
      }),
    });

    expect(completeRes.status).toBe(200);
    const completeBody = (await completeRes.json()) as any;
    expect(completeBody.data.accessToken).toBeTruthy();
    expect(completeBody.data.user.email).toBe('owner@example.com');
  });
});

async function loginViaDevCallback(
  server: WebServerHandle,
  email: string,
  name: string,
): Promise<{ cookies: string; csrfToken: string; accessToken: string }> {
  const startRes = await server.request('/api/v1/auth/google/start', {
    method: 'POST',
  });
  const startBody = (await startRes.json()) as any;
  const state = startBody.data.state as string;

  const callbackRes = await server.request(
    `/api/v1/auth/google/callback?state=${encodeURIComponent(
      state,
    )}&email=${encodeURIComponent(email)}&name=${encodeURIComponent(name)}`,
  );
  if (callbackRes.status !== 200) {
    throw new Error(`Login failed: ${callbackRes.status}`);
  }

  const cookies = getCookieHeader(callbackRes);
  return {
    cookies,
    csrfToken: getCookieValue(cookies, 'cr_csrf_token') || '',
    accessToken: getCookieValue(cookies, 'cr_access_token') || '',
  };
}

function getCookieHeader(res: Response): string {
  const anyHeaders = res.headers as any;
  const setCookies: string[] =
    typeof anyHeaders.getSetCookie === 'function'
      ? anyHeaders.getSetCookie()
      : [res.headers.get('set-cookie') || ''];

  return setCookies
    .filter(Boolean)
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
}

function getCookieValue(
  cookieHeader: string,
  name: string,
): string | undefined {
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return undefined;
}
