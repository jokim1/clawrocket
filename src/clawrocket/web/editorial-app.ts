// editorialboard.ai HTTP server.
//
// Built fresh in PR-3 of the PURGE to replace the chassis-era
// `src/clawrocket/web/server.ts` (8,000 LOC of Talks, Channels, Browser,
// Connectors, Main-channel, Executor-settings handlers). This file wires
// only the routes the Editorial Room product consumes:
//
//   - identity:            /api/v1/auth/* + /api/v1/session/me
//   - provider catalog:    /api/v1/agents
//   - provider secrets:    PUT /api/v1/agents/providers/:id
//   - provider OAuth:      /api/v1/agents/providers/{anthropic,openai}/oauth/*
//   - editorial panel:     POST /api/v1/editorial/panel-turn  (SSE)
//   - admin invites:       POST /api/v1/settings/users/invite
//   - health:              GET  /api/v1/health
//   - webapp shell:        SPA fallback to webapp/dist/index.html
//
// Helpers (cookie set/clear, redirect-target sanitization, dist serving,
// rate limiting, CSRF) are kept compact and inlined — they are short
// enough that hoisting them into shared modules adds more navigation
// cost than it saves.

import fs from 'fs';
import path from 'path';

import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Context, Hono } from 'hono';

import { logger } from '../../logger.js';
import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_DEV_MODE,
  GOOGLE_OAUTH_REDIRECT_URI,
  REFRESH_TOKEN_TTL_SEC,
  TRUSTED_PROXY_MODE,
  WEB_PORT,
  WEB_SECURE_COOKIES,
  isPublicMode,
} from '../config.js';
import { getUserById, updateUserDisplayName } from '../db/index.js';
import {
  AuthError,
  completeDeviceAuthFlow,
  completeGoogleOAuthCallback,
  createInvite,
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
import { authenticateRequest } from './middleware/auth.js';
import { validateCsrfToken } from './middleware/csrf.js';
import {
  checkRateLimit,
  type RateLimitResult,
} from './middleware/rate-limit.js';
import {
  getAiAgentsRoute,
  putAiProviderCredentialRoute,
  updateDefaultClaudeModelRoute,
  verifyAiProviderCredentialRoute,
} from './routes/ai-agents.js';
import { handleEditorialPanelTurn } from './routes/editorial-panel.js';
import {
  disconnectAnthropicOAuthRoute,
  getAnthropicOAuthStatusRoute,
  initiateAnthropicOAuthRoute,
  submitAnthropicOAuthRoute,
} from './routes/llm-oauth.js';
import {
  disconnectOpenAIOAuthRoute,
  getOpenAIOAuthStatusRoute,
  initiateOpenAIOAuthRoute,
  pollOpenAIOAuthRoute,
} from './routes/llm-oauth-openai.js';
import { healthResponse } from './routes/system.js';
import type { AuthContext } from './types.js';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_WEB_APP_DIST_DIR = path.resolve(process.cwd(), 'webapp', 'dist');
const DEFAULT_RETURN_TO = '/';

let warnedAboutMissingCloudflareClientIp = false;
let warnedAboutMissingCaddyForwardedFor = false;
let warnedAboutUnexpectedForwardedHeaders = false;

export interface WebServerOptions {
  host: string;
  port: number;
  webAppDistDir: string;
}

export interface WebServerHandle {
  start: () => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  server: ServerType | null;
}

export function createWebServer(
  input?: Partial<WebServerOptions>,
): WebServerHandle {
  const opts: WebServerOptions = {
    host: input?.host ?? '127.0.0.1',
    port: input?.port ?? WEB_PORT,
    webAppDistDir: input?.webAppDistDir ?? DEFAULT_WEB_APP_DIST_DIR,
  };

  const app = buildApp(opts);
  let server: ServerType | null = null;

  return {
    get server() {
      return server;
    },
    request: async (reqPath: string, init?: RequestInit) => {
      const normalized = reqPath.startsWith('/') ? reqPath : `/${reqPath}`;
      const url =
        reqPath.startsWith('http://') || reqPath.startsWith('https://')
          ? reqPath
          : `http://localhost${normalized}`;
      return app.request(url, init);
    },
    start: async () => {
      if (server) {
        const address = server.address();
        const resolvedPort =
          address && typeof address === 'object' ? address.port : opts.port;
        return { host: opts.host, port: resolvedPort };
      }

      const candidate = createAdaptorServer({
        fetch: app.fetch,
        hostname: opts.host,
        port: opts.port,
      });
      server = candidate;

      return new Promise<{ host: string; port: number }>((resolve, reject) => {
        const cleanup = () => {
          candidate.off('error', onError);
          candidate.off('listening', onListening);
        };
        const onError = (error: Error) => {
          cleanup();
          server = null;
          reject(error);
        };
        const onListening = () => {
          cleanup();
          const address = candidate.address();
          const resolvedPort =
            address && typeof address === 'object' ? address.port : opts.port;
          resolve({ host: opts.host, port: resolvedPort });
        };

        candidate.once('error', onError);
        candidate.once('listening', onListening);
        candidate.listen(opts.port, opts.host);
      });
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

  app.use('/api/v1/*', async (c, next) => {
    maybeWarnAboutUnexpectedForwardedHeaders(c);
    await next();
  });

  app.get('/api/v1/health', async (c) => {
    const health = await healthResponse();
    return c.json(health, health.ok ? 200 : 503);
  });

  app.get('/api/v1/auth/config', async (c) => {
    return c.json({ ok: true, data: { devMode: AUTH_DEV_MODE } }, 200);
  });

  app.post('/api/v1/auth/google/start', async (c) => {
    const rateResult = checkRateLimit({
      principalId: getRequestRateLimitPrincipal(c),
      bucket: 'auth_start',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    try {
      let requestedReturnTo: string | undefined;
      const contentType = (c.req.header('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        const body = (await c.req.json().catch(() => ({}))) as {
          returnTo?: unknown;
        };
        if (typeof body.returnTo === 'string') {
          requestedReturnTo = body.returnTo;
        }
      }

      const payload = startGoogleOAuth({
        redirectUri: resolveGoogleOAuthRedirectUri(c, opts),
        returnTo: normalizeReturnToPath(requestedReturnTo) || undefined,
      });
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
      const accept = (c.req.header('accept') || '').toLowerCase();

      const result = await completeGoogleOAuthCallback({
        state,
        code,
        email,
        displayName,
        ipAddress: getClientIp(c),
        userAgent: c.req.header('user-agent'),
      });
      setSessionCookies(c, result.session);
      const returnTo =
        normalizeReturnToPath(result.returnTo) || DEFAULT_RETURN_TO;
      if (accept.includes('text/html')) {
        c.header('cache-control', 'no-store');
        return c.redirect(returnTo, 302);
      }
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
    if (isPublicMode) return publicModeDisabledResponse(c);

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
    if (isPublicMode) return publicModeDisabledResponse(c);

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
        ipAddress: getClientIp(c),
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

  app.patch('/api/v1/session/me', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) return rateLimitedResponse(c, rateResult);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_body', message: 'Invalid JSON body.' },
        },
        400,
      );
    }

    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim() : null;
    if (displayName !== null) {
      if (displayName.length === 0 || displayName.length > 200) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_display_name',
              message: 'Display name must be between 1 and 200 characters.',
            },
          },
          400,
        );
      }
      updateUserDisplayName(auth.userId, displayName);
    }

    const user = getUserById(auth.userId);
    if (!user || user.is_active !== 1) return unauthorized(c);

    return c.json({ ok: true, data: { user: normalizeUser(user) } }, 200);
  });

  app.post('/api/v1/settings/users/invite', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const csrf = validateCsrfToken({
      method: c.req.method,
      authType: auth.authType,
      cookieHeader: c.req.header('cookie'),
      csrfHeader: c.req.header('x-csrf-token'),
    });
    if (!csrf.ok) {
      return c.json(
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
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

  // ── /api/v1/agents ─ provider catalog + provider-secret management ────

  app.get('/api/v1/agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await getAiAgentsRoute();
    return jsonResponse(result.status, result.body);
  });

  // Talk-era endpoint kept as a no-op stub so the webapp's existing
  // PUT /api/v1/agents/default-claude (if it ever fires) doesn't 404.
  app.put('/api/v1/agents/default-claude', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await updateDefaultClaudeModelRoute(auth, body);
    return jsonResponse(result.status, result.body);
  });

  app.put('/api/v1/agents/providers/:providerId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const providerId = c.req.param('providerId');
    const body = await c.req.json().catch(() => ({}));
    const result = await putAiProviderCredentialRoute(auth, providerId, body);
    return jsonResponse(result.status, result.body);
  });

  app.post('/api/v1/agents/providers/:providerId/verify', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const providerId = c.req.param('providerId');
    const result = await verifyAiProviderCredentialRoute(auth, providerId);
    return jsonResponse(result.status, result.body);
  });

  // ── Anthropic OAuth (Claude.ai subscription) ──────────────────────────

  app.post('/api/v1/agents/providers/anthropic/oauth/initiate', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await initiateAnthropicOAuthRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  app.post('/api/v1/agents/providers/anthropic/oauth/submit', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await submitAnthropicOAuthRoute(auth, body);
    return jsonResponse(result.statusCode, result.body);
  });

  app.get('/api/v1/agents/providers/anthropic/oauth/status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await getAnthropicOAuthStatusRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  app.post('/api/v1/agents/providers/anthropic/oauth/disconnect', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await disconnectAnthropicOAuthRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  // ── OpenAI Codex OAuth (ChatGPT subscription) ─────────────────────────

  app.post('/api/v1/agents/providers/openai/oauth/initiate', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await initiateOpenAIOAuthRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  app.post('/api/v1/agents/providers/openai/oauth/poll', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const body = await c.req.json().catch(() => ({}));
    const result = await pollOpenAIOAuthRoute(auth, body);
    return jsonResponse(result.statusCode, result.body);
  });

  app.get('/api/v1/agents/providers/openai/oauth/status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await getOpenAIOAuthStatusRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  app.post('/api/v1/agents/providers/openai/oauth/disconnect', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    const result = await disconnectOpenAIOAuthRoute(auth);
    return jsonResponse(result.statusCode, result.body);
  });

  // ── /api/v1/editorial/panel-turn (SSE) ────────────────────────────────

  app.post('/api/v1/editorial/panel-turn', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    return handleEditorialPanelTurn(c, auth);
  });

  // ── Webapp shell ──────────────────────────────────────────────────────
  // Anything not matched above falls back to the SPA's index.html so React
  // Router can resolve the route client-side.

  app.all('*', async (c) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      return c.json(
        {
          ok: false,
          error: { code: 'not_found', message: 'Route not found' },
        },
        404,
      );
    }
    const url = new URL(c.req.url);
    const response = serveWebAppRequest(url.pathname, opts.webAppDistDir);
    if (response) return response;
    return c.json(
      {
        ok: false,
        error: { code: 'not_found', message: 'Route not found' },
      },
      404,
    );
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
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
      error: { code: 'unauthorized', message: 'Authentication is required' },
    },
    401,
  );
}

function forbidden(c: Context, message: string) {
  return c.json({ ok: false, error: { code: 'forbidden', message } }, 403);
}

function authErrorResponse(c: Context, err: unknown) {
  if (err instanceof AuthError) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: { code: err.code, message: err.message },
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

interface SessionCookieInput {
  accessToken: string;
  refreshToken: string;
  csrfToken: string;
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

interface UserLike {
  id: string;
  email: string;
  display_name: string;
  role: string;
  created_at: string;
}

function normalizeUser(user: UserLike) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    createdAt: user.created_at,
  };
}

function publicModeDisabledResponse(c: Context): Response {
  return c.json(
    {
      ok: false,
      error: {
        code: 'device_auth_disabled',
        message: 'Device auth is disabled in public mode',
      },
    },
    403,
  );
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

function getRequestRateLimitPrincipal(c: Context): string {
  const ip = getClientIp(c);
  return ip ? `ip:${ip}` : 'ip:unknown';
}

function getClientIp(c: Context): string | undefined {
  const headers = {
    xForwardedFor: c.req.header('x-forwarded-for') || undefined,
    cfConnectingIp: c.req.header('cf-connecting-ip') || undefined,
  };
  const remoteAddress = (() => {
    try {
      return getConnInfo(c).remote.address?.trim() || undefined;
    } catch {
      return undefined;
    }
  })();

  switch (TRUSTED_PROXY_MODE) {
    case 'cloudflare': {
      const cf = headers.cfConnectingIp?.trim();
      if (cf) return cf;
      if (!warnedAboutMissingCloudflareClientIp) {
        warnedAboutMissingCloudflareClientIp = true;
        logger.error(
          { remoteAddress: remoteAddress || 'unknown' },
          'CF-Connecting-IP header missing; per-client rate limiting is degraded.',
        );
      }
      return remoteAddress;
    }
    case 'caddy': {
      const xff = headers.xForwardedFor
        ?.split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .at(-1);
      if (xff) return xff;
      if (!warnedAboutMissingCaddyForwardedFor) {
        warnedAboutMissingCaddyForwardedFor = true;
        logger.error(
          { remoteAddress: remoteAddress || 'unknown' },
          'X-Forwarded-For header missing; per-client rate limiting is degraded.',
        );
      }
      return remoteAddress;
    }
    case 'none':
    default:
      return remoteAddress;
  }
}

function maybeWarnAboutUnexpectedForwardedHeaders(c: Context): void {
  if (isPublicMode || warnedAboutUnexpectedForwardedHeaders) return;
  const xff = c.req.header('x-forwarded-for');
  const cf = c.req.header('cf-connecting-ip');
  if (!xff && !cf) return;
  warnedAboutUnexpectedForwardedHeaders = true;
  logger.warn(
    'Forwarded headers detected but PUBLIC_MODE is not enabled. If this instance is internet-facing, set PUBLIC_MODE=true.',
  );
}

function resolveGoogleOAuthRedirectUri(
  c: Context,
  opts: WebServerOptions,
): string {
  const local = resolveLoopbackGoogleOAuthRedirectUri(c, opts);
  if (local) return local;
  return (
    GOOGLE_OAUTH_REDIRECT_URI ||
    `http://127.0.0.1:${WEB_PORT}/api/v1/auth/google/callback`
  );
}

function resolveLoopbackGoogleOAuthRedirectUri(
  c: Context,
  opts: WebServerOptions,
): string | null {
  let requestUrl: URL;
  try {
    requestUrl = new URL(c.req.url);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(requestUrl.hostname)) return null;

  const callbackUrl = new URL(requestUrl.toString());
  callbackUrl.hostname = isLoopbackHostname(opts.host)
    ? opts.host
    : requestUrl.hostname;
  callbackUrl.pathname = '/api/v1/auth/google/callback';
  callbackUrl.search = '';
  callbackUrl.hash = '';
  callbackUrl.port =
    requestUrl.port || (opts.port > 0 ? String(opts.port) : String(WEB_PORT));
  return callbackUrl.toString();
}

function isLoopbackHostname(hostname: string): boolean {
  const n = hostname.trim().toLowerCase();
  return n === 'localhost' || n === '127.0.0.1' || n === '::1' || n === '[::1]';
}

function normalizeReturnToPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate) return null;
  if (/%0d|%0a/i.test(candidate)) return null;
  if (!isSafeRelativeRedirectTarget(candidate)) return null;

  let decoded = '';
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  if (/%0d|%0a/i.test(decoded)) return null;
  if (!isSafeRelativeRedirectTarget(decoded)) return null;

  return candidate;
}

function isSafeRelativeRedirectTarget(value: string): boolean {
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//')) return false;
  if (value.includes('\\')) return false;
  if (/[ -]/.test(value)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// SPA shell
// ---------------------------------------------------------------------------

function serveWebAppRequest(
  requestPath: string,
  webAppDistDir: string,
): Response | null {
  const distDir = path.resolve(webAppDistDir);
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) return null;

  const ext = path.extname(requestPath);
  if (ext) {
    const assetPath = resolveSafeDistPath(distDir, requestPath);
    if (
      !assetPath ||
      !fs.existsSync(assetPath) ||
      !fs.statSync(assetPath).isFile()
    ) {
      return null;
    }
    return serveStaticFile(assetPath, false, requestPath);
  }
  return serveStaticFile(indexPath, true, requestPath);
}

function resolveSafeDistPath(
  distDir: string,
  requestPath: string,
): string | null {
  const relative = requestPath.startsWith('/')
    ? requestPath.slice(1)
    : requestPath;
  const normalized = path.normalize(relative);
  if (
    !normalized ||
    normalized.startsWith('..') ||
    path.isAbsolute(normalized)
  ) {
    return null;
  }
  const full = path.resolve(distDir, normalized);
  if (full === distDir || !full.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }
  return full;
}

function serveStaticFile(
  filePath: string,
  isHtml: boolean,
  requestPath: string,
): Response {
  const body = fs.readFileSync(filePath);
  const headers: Record<string, string> = {
    'content-type': contentTypeForPath(filePath),
  };
  if (isHtml) {
    headers['cache-control'] = 'no-cache';
    headers['content-security-policy'] =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
  } else if (requestPath.startsWith('/assets/')) {
    headers['cache-control'] = 'public, max-age=31536000, immutable';
  } else {
    headers['cache-control'] = 'public, max-age=3600';
  }
  return new Response(body, { status: 200, headers });
}

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
