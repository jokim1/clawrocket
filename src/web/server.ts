import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Context, Hono } from 'hono';

import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  WEB_SECURE_COOKIES,
} from '../config.js';
import { canUserAccessTalk, getUserById } from '../db.js';
import {
  completeDeviceAuthFlow,
  completeGoogleOAuthCallback,
  createInvite,
  AuthError,
  logoutSession,
  refreshSession,
  startDeviceAuthFlow,
  startGoogleOAuth,
} from '../identity/auth-service.js';
import {
  ACCESS_TOKEN_COOKIE,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../identity/session.js';
import { KeychainBridge, noopKeychainBridge } from '../secrets/keychain.js';
import { TalkRunQueue } from '../talks/run-queue.js';
import { validateCsrfToken } from './middleware/csrf.js';
import {
  idempotencyPrecheck,
  saveIdempotencyResult,
} from './middleware/idempotency.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from './middleware/rate-limit.js';
import {
  buildTalkScopedSseStream,
  buildUserScopedSseStream,
} from './routes/events.js';
import { healthResponse, statusResponse } from './routes/system.js';
import {
  cancelTalkChat,
  createTalkRoute,
  enqueueTalkChat,
  getTalkRoute,
  listTalkMessagesRoute,
  listTalksRoute,
} from './routes/talks.js';
import { authenticateRequest } from './middleware/auth.js';
import { AuthContext } from './types.js';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

export interface WebServerOptions {
  host: string;
  port: number;
  keychain: KeychainBridge;
  runQueue: TalkRunQueue;
}

export interface WebServerHandle {
  start: () => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  server: ReturnType<typeof serve> | null;
}

export function createWebServer(
  input?: Partial<WebServerOptions>,
): WebServerHandle {
  const opts: WebServerOptions = {
    host: input?.host ?? '127.0.0.1',
    port: input?.port ?? 3210,
    keychain: input?.keychain || noopKeychainBridge,
    runQueue: input?.runQueue || new TalkRunQueue(),
  };

  const app = buildApp(opts);
  let server: ReturnType<typeof serve> | null = null;

  return {
    get server() {
      return server;
    },
    request: async (path: string, init?: RequestInit) => {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const url =
        path.startsWith('http://') || path.startsWith('https://')
          ? path
          : `http://localhost${normalizedPath}`;
      return app.request(url, init);
    },
    start: async () => {
      if (server) {
        const address = server.address();
        const resolvedPort =
          address && typeof address === 'object' ? address.port : opts.port;
        return { host: opts.host, port: resolvedPort };
      }

      server = serve({
        fetch: app.fetch,
        hostname: opts.host,
        port: opts.port,
      });

      const address = server.address();
      const resolvedPort =
        address && typeof address === 'object' ? address.port : opts.port;
      return { host: opts.host, port: resolvedPort };
    },
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      server = null;
    },
  };
}

function buildApp(opts: WebServerOptions): Hono {
  const app = new Hono();

  app.use(
    '/api/v1/*',
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) => {
        c.header('Connection', 'close');
        return c.json(
          {
            ok: false,
            error: {
              code: 'payload_too_large',
              message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
            },
          },
          413,
        );
      },
    }),
  );

  app.get('/api/v1/health', async (c) => {
    const health = await healthResponse();
    return c.json(health, health.ok ? 200 : 503);
  });

  app.post('/api/v1/auth/google/start', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_start',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const payload = startGoogleOAuth();
      return c.json({ ok: true, data: payload }, 200);
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.get('/api/v1/auth/google/callback', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_callback',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const state = c.req.query('state') || '';
      const code = c.req.query('code') || undefined;
      const email = c.req.query('email') || undefined;
      const displayName = c.req.query('name') || undefined;
      const result = await completeGoogleOAuthCallback({
        state,
        code,
        email,
        displayName,
        ipAddress: getClientIp(c.req.header('x-forwarded-for')),
        userAgent: c.req.header('user-agent'),
      });
      setSessionCookies(c, result.session);
      return c.json(
        {
          ok: true,
          data: {
            user: normalizeUser(result.user),
            accessExpiresAt: result.session.accessExpiresAt,
            refreshExpiresAt: result.session.refreshExpiresAt,
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/refresh', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_sensitive',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const refreshToken =
        getCookie(c, REFRESH_TOKEN_COOKIE) ||
        c.req.header('x-refresh-token') ||
        '';
      const result = refreshSession(refreshToken);
      setSessionCookies(c, result.session);
      return c.json(
        {
          ok: true,
          data: {
            user: normalizeUser(result.user),
            accessExpiresAt: result.session.accessExpiresAt,
            refreshExpiresAt: result.session.refreshExpiresAt,
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/device/start', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_start',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const payload = startDeviceAuthFlow();
      return c.json({ ok: true, data: payload }, 200);
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/device/complete', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_sensitive',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        deviceCode?: string;
        email?: string;
        displayName?: string;
      };
      const result = completeDeviceAuthFlow({
        deviceCode: body.deviceCode || '',
        email: body.email || '',
        displayName: body.displayName,
        ipAddress: getClientIp(c.req.header('x-forwarded-for')),
        userAgent: c.req.header('user-agent'),
      });

      return c.json(
        {
          ok: true,
          data: {
            accessToken: result.session.accessToken,
            refreshToken: result.session.refreshToken,
            expiresInSec: ACCESS_TOKEN_TTL_SEC,
            user: normalizeUser(result.user),
          },
        },
        200,
      );
    } catch (err) {
      return authErrorResponse(c, err);
    }
  });

  app.post('/api/v1/auth/logout', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    logoutSession(auth.sessionId);
    clearSessionCookies(c);
    return c.json({ ok: true, data: { loggedOut: true } }, 200);
  });

  app.get('/api/v1/session/me', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const user = getUserById(auth.userId);
    if (!user || user.is_active !== 1) return unauthorized(c);

    return c.json({ ok: true, data: { user: normalizeUser(user) } }, 200);
  });

  app.post('/api/v1/settings/users/invite', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return c.json(
        {
          ok: false,
          error: {
            code: 'forbidden',
            message: 'Owner or admin role required',
          },
        },
        403,
      );
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      role?: 'admin' | 'member';
    };
    const email = (body.email || '').trim().toLowerCase();
    if (!email) {
      return c.json(
        {
          ok: false,
          error: { code: 'email_required', message: 'email is required' },
        },
        400,
      );
    }

    const invite = createInvite({
      inviterUserId: auth.userId,
      email,
      role: body.role === 'admin' ? 'admin' : 'member',
    });

    return c.json(
      {
        ok: true,
        data: {
          inviteId: invite.inviteId,
          email,
          role: body.role === 'admin' ? 'admin' : 'member',
          expiresAt: invite.expiresAt,
        },
      },
      200,
    );
  });

  app.get('/api/v1/status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const payload = await statusResponse(opts.keychain);
    return c.json(payload, 200);
  });

  app.get('/api/v1/talks', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const limit = parsePositiveInt(c.req.query('limit'));
    const offset = parseNonNegativeInt(c.req.query('offset'));

    const result = listTalksRoute({
      auth,
      limit: limit ?? undefined,
      offset: offset ?? undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'write' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const payload = parseJsonPayload<{ title?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = createTalkRoute({
      auth,
      title: payload.data.title,
    });

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = getTalkRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/messages', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const limit = parsePositiveInt(c.req.query('limit'));
    const beforeCreatedAt = c.req.query('before') || undefined;
    const result = listTalkMessagesRoute({
      talkId,
      auth,
      limit: limit ?? undefined,
      beforeCreatedAt,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/chat', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      userId: auth.userId,
      bucket: 'chat_write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const payload = parseJsonPayload<{ content?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.error,
          },
        },
        400,
      );
    }

    const result = enqueueTalkChat({
      talkId,
      auth,
      content: payload.data.content || '',
      runQueue: opts.runQueue,
      idempotencyKey,
    });

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/events', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const lastEventId = parseLastEventId(c.req.header('last-event-id'));
    const stream = buildUserScopedSseStream({
      userId: auth.userId,
      lastEventId,
    });

    return c.body(`retry: 3000\n${stream}`, 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-clawrocket-sse-mode': 'snapshot',
    });
  });

  app.get('/api/v1/talks/:talkId/events', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    if (!canUserAccessTalk(talkId, auth.userId)) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'talk_not_found',
            message: 'Talk not found',
          },
        },
        404,
      );
    }

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const lastEventId = parseLastEventId(c.req.header('last-event-id'));
    const stream = buildTalkScopedSseStream({ talkId, lastEventId });

    return c.body(`retry: 3000\n${stream}`, 200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-clawrocket-sse-mode': 'snapshot',
    });
  });

  app.post('/api/v1/talks/:talkId/chat/cancel', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      userId: auth.userId,
      bucket: 'chat_write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'csrf_failed',
            message: csrf.reason,
          },
        },
        403,
      );
    }

    const bodyText = await c.req.text();
    const idempotencyKey = c.req.header('idempotency-key') || null;
    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      bodyText,
    });
    if (precheck.error) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'idempotency_error',
            message: precheck.error,
          },
        },
        400,
      );
    }

    if (precheck.replay && precheck.response) {
      return new Response(precheck.response.responseBody, {
        status: precheck.response.statusCode,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-idempotent-replay': 'true',
        },
      });
    }

    const encodedTalkId = c.req.param('talkId');
    const talkId = safeDecodePathSegment(encodedTalkId);
    if (!talkId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_talk_id',
            message: 'Talk ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = cancelTalkChat({
      talkId,
      auth,
      runQueue: opts.runQueue,
    });

    const serialized = JSON.stringify(result.body);
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: result.statusCode,
      responseBody: serialized,
    });

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.all('/api/v1/*', (c) => {
    return c.json(
      {
        ok: false,
        error: {
          code: 'not_found',
          message: 'Route not found',
        },
      },
      404,
    );
  });

  return app;
}

function requireAuth(c: Context): AuthContext | null {
  return authenticateRequest({
    authorization: c.req.header('authorization'),
    cookie: c.req.header('cookie'),
  });
}

function unauthorized(c: Context) {
  return c.json(
    {
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Authentication is required',
      },
    },
    401,
  );
}

function authErrorResponse(c: Context, err: unknown) {
  if (err instanceof AuthError) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: err.code,
          message: err.message,
        },
      }),
      {
        status: err.status,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      },
    );
  }

  return c.json(
    {
      ok: false,
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    },
    500,
  );
}

function setSessionCookies(c: Context, session: SessionCookieInput): void {
  setCookie(c, ACCESS_TOKEN_COOKIE, session.accessToken, {
    httpOnly: true,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });
  setCookie(c, REFRESH_TOKEN_COOKIE, session.refreshToken, {
    httpOnly: true,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: REFRESH_TOKEN_TTL_SEC,
  });
  setCookie(c, CSRF_TOKEN_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure: WEB_SECURE_COOKIES,
    sameSite: 'Lax',
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SEC,
  });
}

function clearSessionCookies(c: Context): void {
  deleteCookie(c, ACCESS_TOKEN_COOKIE, { path: '/' });
  deleteCookie(c, REFRESH_TOKEN_COOKIE, { path: '/' });
  deleteCookie(c, CSRF_TOKEN_COOKIE, { path: '/' });
}

function parseLastEventId(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseNonNegativeInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function parseJsonPayload<T>(
  bodyText: string,
): { ok: true; data: T } | { ok: false; error: string } {
  if (!bodyText.trim()) {
    return { ok: true, data: {} as T };
  }
  try {
    return { ok: true, data: JSON.parse(bodyText) as T };
  } catch {
    return { ok: false, error: 'Request body is not valid JSON' };
  }
}

function safeDecodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeUser(user: UserLike) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
  };
}

function getClientIp(xForwardedFor: string | undefined): string | undefined {
  if (!xForwardedFor) return undefined;
  const first = xForwardedFor.split(',')[0]?.trim();
  return first || undefined;
}

function getRequestRateLimitPrincipal(c: Context): string {
  const forwarded = getClientIp(c.req.header('x-forwarded-for'));
  if (forwarded) return `ip:${forwarded}`;

  try {
    const connInfo = getConnInfo(c);
    const remoteAddress = connInfo.remote.address?.trim();
    if (remoteAddress) return `ip:${remoteAddress}`;
  } catch {
    // app.request() tests and non-node runtimes may not expose conninfo
  }

  return 'ip:unknown';
}

function rateLimitedResponse(
  c: Context,
  rateResult: RateLimitResult,
): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Rate limit exceeded',
        details: {
          limit: rateResult.limit,
          retryAfterSec: rateResult.retryAfterSec,
        },
      },
    },
    429,
    {
      'retry-after': String(rateResult.retryAfterSec),
    },
  );
}

type SessionCookieInput = {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
};

type UserLike = {
  id: string;
  email: string;
  display_name: string;
  role: string;
};
