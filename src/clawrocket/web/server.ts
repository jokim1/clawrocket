import fs from 'fs';
import path from 'path';

import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { Context, Hono } from 'hono';

import {
  ACCESS_TOKEN_TTL_SEC,
  AUTH_DEV_MODE,
  REFRESH_TOKEN_TTL_SEC,
  WEB_SECURE_COOKIES,
} from '../config.js';
import {
  canUserAccessTalk,
  countRunningTalkRuns,
  getOutboxEventsForTopics,
  getOutboxMinEventIdForTopics,
  getUserById,
} from '../db/index.js';
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
import type { TalkRunWorkerControl } from '../talks/run-worker.js';
import {
  ExecutorAuthMode,
  ExecutorSubscriptionImportResult,
  ExecutorSettingsService,
  ExecutorSettingsValidationError,
} from '../talks/executor-settings.js';
import { ExecutorCredentialVerifier } from '../talks/executor-credentials-verifier.js';
import { ExecutorSubscriptionHostAuthService } from '../talks/executor-subscription-host-auth.js';
import { ProviderCredentialsVerifier } from '../agents/provider-credentials-verifier.js';
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
  formatOutboxEventAsSse,
  getTalkScopedEventTopics,
  getUserScopedEventTopics,
} from './routes/events.js';
import { healthResponse, statusResponse } from './routes/system.js';
import {
  createTalkFolderRoute,
  cancelTalkChat,
  createTalkRoute,
  deleteTalkFolderRoute,
  deleteTalkRoute,
  enqueueTalkChat,
  getTalkPolicyRoute,
  getTalkRoute,
  listTalkAgentsRoute,
  listTalkMessagesRoute,
  listTalkRunsRoute,
  listTalkSidebarRoute,
  listTalksRoute,
  patchTalkFolderRoute,
  patchTalkRoute,
  reorderTalkSidebarRoute,
  updateTalkAgentsRoute,
  updateTalkPolicyRoute,
} from './routes/talks.js';
import {
  getAiAgentsRoute,
  saveAiProviderCredentialRoute,
  updateDefaultClaudeModelRoute,
  verifyAiProviderCredentialRoute,
} from './routes/agents.js';
import {
  getTalkLlmSettingsRoute,
  updateTalkLlmSettingsRoute,
} from './routes/talk-llm.js';
import {
  attachTalkDataConnectorRoute,
  createDataConnectorRoute,
  deleteDataConnectorRoute,
  detachTalkDataConnectorRoute,
  listDataConnectorsRoute,
  listTalkDataConnectorsRoute,
  patchDataConnectorRoute,
  setDataConnectorCredentialRoute,
} from './routes/data-connectors.js';
import { authenticateRequest } from './middleware/auth.js';
import { AuthContext } from './types.js';
import { DataConnectorVerifier } from '../connectors/connector-verifier.js';

const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const SSE_RETRY_MS = 3000;
const SSE_STREAM_POLL_MS = 250;
const SSE_STREAM_HEARTBEAT_MS = 15_000;
const SSE_STREAM_BATCH_LIMIT = 100;
const SSE_STREAM_RETRY_AFTER_SEC = 5;
const MAX_LIVE_SSE_CONNECTIONS_PER_USER = 3;
const DEFAULT_WEB_APP_DIST_DIR = path.resolve(process.cwd(), 'webapp', 'dist');

export interface WebServerOptions {
  host: string;
  port: number;
  keychain: KeychainBridge;
  runWorker: TalkRunWorkerControl;
  webAppDistDir: string;
  executorSettings: ExecutorSettingsService;
  executorVerifier: ExecutorCredentialVerifier;
  subscriptionHostAuth: ExecutorSubscriptionHostAuthService;
  dataConnectorVerifier: DataConnectorVerifier;
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
  const noopRunWorker: TalkRunWorkerControl = {
    wake: () => {
      /* no-op */
    },
    abortTalk: () => {
      /* no-op */
    },
  };

  const executorSettings =
    input?.executorSettings || new ExecutorSettingsService();
  const opts: WebServerOptions = {
    host: input?.host ?? '127.0.0.1',
    port: input?.port ?? 3210,
    keychain: input?.keychain || noopKeychainBridge,
    runWorker: input?.runWorker || noopRunWorker,
    webAppDistDir: input?.webAppDistDir ?? DEFAULT_WEB_APP_DIST_DIR,
    executorSettings,
    executorVerifier:
      input?.executorVerifier ||
      new ExecutorCredentialVerifier({
        executorSettings,
      }),
    subscriptionHostAuth:
      input?.subscriptionHostAuth || new ExecutorSubscriptionHostAuthService(),
    dataConnectorVerifier:
      input?.dataConnectorVerifier || new DataConnectorVerifier(),
  };

  // startWebServer() already runs bootstrap migration in production. Repeat it
  // here so request-only server instances used by tests exercise the same
  // executor settings path without needing the full startup wrapper.
  opts.executorSettings.runBootstrapMigration();
  if (!opts.executorSettings.getRunningSnapshot()) {
    const config = opts.executorSettings.resolveEffectiveConfig();
    opts.executorSettings.captureRunningSnapshot(
      config,
      opts.executorSettings.getConfigVersion(),
    );
  }

  const app = buildApp(opts);
  let server: ServerType | null = null;

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
  const liveSseConnectionsByUser = new Map<string, number>();
  const providerVerifier = new ProviderCredentialsVerifier();

  const tryAcquireLiveSseConnection = (userId: string): boolean => {
    const active = liveSseConnectionsByUser.get(userId) || 0;
    if (active >= MAX_LIVE_SSE_CONNECTIONS_PER_USER) return false;
    liveSseConnectionsByUser.set(userId, active + 1);
    return true;
  };

  const releaseLiveSseConnection = (userId: string): void => {
    const active = liveSseConnectionsByUser.get(userId) || 0;
    if (active <= 1) {
      liveSseConnectionsByUser.delete(userId);
      return;
    }
    liveSseConnectionsByUser.set(userId, active - 1);
  };

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

  app.get('/api/v1/auth/config', async (c) => {
    return c.json(
      {
        ok: true,
        data: {
          devMode: AUTH_DEV_MODE,
        },
      },
      200,
    );
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
      const result = await completeGoogleOAuthCallback({
        state,
        code,
        email,
        displayName,
        ipAddress: getClientIp(c.req.header('x-forwarded-for')),
        userAgent: c.req.header('user-agent'),
      });
      setSessionCookies(c, result.session);
      const accept = (c.req.header('accept') || '').toLowerCase();
      if (accept.includes('text/html')) {
        c.header('cache-control', 'no-store');
        return c.redirect(
          normalizeReturnToPath(result.returnTo) || '/app/talks',
          302,
        );
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

  app.get('/api/v1/settings/executor', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    return c.json(
      {
        ok: true,
        data: opts.executorSettings.getSettingsView(),
      },
      200,
    );
  });

  app.get('/api/v1/settings/executor/subscription-host-status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const data = await opts.subscriptionHostAuth.getStatusView();
    return c.json(
      {
        ok: true,
        data,
      },
      200,
    );
  });

  app.put('/api/v1/settings/executor', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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

    const payload = parseJsonPayload<{
      executorAuthMode?: ExecutorAuthMode;
      anthropicApiKey?: string | null;
      claudeOauthToken?: string | null;
      anthropicAuthToken?: string | null;
      anthropicBaseUrl?: string | null;
      aliasModelMap?: Record<string, string>;
      defaultAlias?: string;
    }>(bodyText);
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

    try {
      opts.executorSettings.saveExecutorConfig(payload.data, auth.userId);
      const latestSettings = opts.executorSettings.getSettingsView();
      if (
        latestSettings.executorAuthMode === 'api_key' ||
        latestSettings.executorAuthMode === 'advanced_bearer'
      ) {
        opts.executorVerifier.scheduleVerification(
          latestSettings.executorAuthMode,
        );
      }
      const data = opts.executorSettings.getSettingsView();
      const serialized = JSON.stringify({ ok: true, data });
      saveIdempotencyResult({
        userId: auth.userId,
        idempotencyKey,
        method: c.req.method,
        path: c.req.path,
        requestHash: precheck.requestHash,
        statusCode: 200,
        responseBody: serialized,
      });

      return new Response(serialized, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      if (err instanceof ExecutorSettingsValidationError) {
        return c.json(
          {
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          400,
        );
      }
      throw err;
    }
  });

  app.post('/api/v1/settings/executor/verify', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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

    const result = opts.executorVerifier.scheduleVerification();
    if (!result.scheduled && result.code !== 'already_verifying') {
      return c.json(
        {
          ok: false,
          error: {
            code: result.code,
            message: result.message,
          },
        },
        409,
      );
    }

    return c.json(
      {
        ok: true,
        data: {
          scheduled: result.scheduled || result.code === 'already_verifying',
          code: result.code,
          message: result.message,
        },
      },
      200,
    );
  });

  app.post('/api/v1/settings/executor/subscription/import', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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

    const payload = parseJsonPayload<{
      expectedFingerprint?: string | null;
    }>(bodyText);
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

    const expectedFingerprint =
      payload.data.expectedFingerprint?.trim() || null;
    const probe = await opts.subscriptionHostAuth.probeImportSource();
    if (!probe.importAvailable || !probe.importCredential) {
      const code =
        probe.hostLoginDetected || probe.serviceEnvOauthPresent
          ? 'host_import_unavailable'
          : 'host_login_not_detected';
      return c.json(
        {
          ok: false,
          error: {
            code,
            message: probe.message,
          },
        },
        409,
      );
    }

    if (
      !expectedFingerprint ||
      !probe.hostCredentialFingerprint ||
      expectedFingerprint !== probe.hostCredentialFingerprint
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'host_state_changed',
            message:
              'Host Claude login changed since the last check. Please check again and retry import.',
          },
        },
        409,
      );
    }

    let data: ExecutorSubscriptionImportResult;
    try {
      data = opts.executorSettings.importSubscriptionCredential(
        probe.importCredential,
        auth.userId,
      );
    } catch (err) {
      if (err instanceof ExecutorSettingsValidationError) {
        return c.json(
          {
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              details: err.details,
            },
          },
          400,
        );
      }
      throw err;
    }

    const safeData = {
      status: data.status,
      settings: data.settings,
    };
    const serialized = JSON.stringify({
      ok: true,
      data: safeData,
    });
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: 200,
      responseBody: serialized,
    });

    return new Response(serialized, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/settings/executor-status', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner' && auth.role !== 'admin') {
      return forbidden(c, 'Owner or admin role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    return c.json(
      {
        ok: true,
        data: opts.executorSettings.getStatusView(),
      },
      200,
    );
  });

  app.get('/api/v1/settings/talk-llm', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = getTalkLlmSettingsRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/settings/talk-llm', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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

    const payload = parseJsonPayload(bodyText);
    if (!payload.ok || !payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_json',
            message: payload.ok
              ? 'Request body must be a JSON object'
              : payload.error,
          },
        },
        400,
      );
    }

    const result = updateTalkLlmSettingsRoute({
      auth,
      payload: payload.data as Record<string, unknown>,
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

  app.post('/api/v1/settings/restart', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);
    if (auth.role !== 'owner') {
      return forbidden(c, 'Owner role required');
    }

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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

    if (!opts.executorSettings.isRestartSupported()) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'restart_unsupported',
            message:
              'Service restart is only available when CLAWROCKET_SELF_RESTART=1',
          },
        },
        409,
      );
    }

    if (opts.executorSettings.getStartupAgeMs() < 10_000) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'restart_cooldown',
            message: 'Service recently started',
          },
        },
        409,
      );
    }

    const data = {
      status: 'restarting',
      activeRunCount: countRunningTalkRuns(),
    };
    const serialized = JSON.stringify({ ok: true, data });
    saveIdempotencyResult({
      userId: auth.userId,
      idempotencyKey,
      method: c.req.method,
      path: c.req.path,
      requestHash: precheck.requestHash,
      statusCode: 200,
      responseBody: serialized,
    });

    setTimeout(() => {
      process.kill(process.pid, 'SIGTERM');
    }, 500);

    return new Response(serialized, {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
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

  app.get('/api/v1/talks/sidebar', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({ userId: auth.userId, bucket: 'read' });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = listTalkSidebarRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/agents', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'read',
    });
    if (!rateResult.allowed) {
      return rateLimitedResponse(c, rateResult);
    }

    const result = getAiAgentsRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/agents/default-claude', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{ modelId?: string }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = updateDefaultClaudeModelRoute({
      auth,
      modelId:
        typeof payload.data.modelId === 'string' ? payload.data.modelId : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/agents/providers/:providerId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const providerId = c.req.param('providerId');
    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      apiKey?: string | null;
      organizationId?: string | null;
      baseUrl?: string | null;
      authScheme?: 'x_api_key' | 'bearer';
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = await saveAiProviderCredentialRoute({
      auth,
      providerId,
      apiKey:
        typeof payload.data.apiKey === 'string' || payload.data.apiKey === null
          ? payload.data.apiKey
          : undefined,
      organizationId:
        typeof payload.data.organizationId === 'string' ||
        payload.data.organizationId === null
          ? payload.data.organizationId
          : undefined,
      baseUrl:
        typeof payload.data.baseUrl === 'string' ||
        payload.data.baseUrl === null
          ? payload.data.baseUrl
          : undefined,
      authScheme:
        payload.data.authScheme === 'x_api_key' ||
        payload.data.authScheme === 'bearer'
          ? payload.data.authScheme
          : undefined,
      verifier: providerVerifier,
    });

    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/agents/providers/:providerId/verify', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const providerId = c.req.param('providerId');
    const result = await verifyAiProviderCredentialRoute({
      auth,
      providerId,
      verifier: providerVerifier,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listDataConnectorsRoute({ auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      name?: string;
      connectorKind?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = createDataConnectorRoute({
      auth,
      name: typeof payload.data.name === 'string' ? payload.data.name : '',
      connectorKind:
        typeof payload.data.connectorKind === 'string'
          ? payload.data.connectorKind
          : '',
      config:
        payload.data.config && typeof payload.data.config === 'object'
          ? payload.data.config
          : undefined,
      enabled:
        typeof payload.data.enabled === 'boolean'
          ? payload.data.enabled
          : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/data-connectors/:connectorId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      name?: string;
      config?: Record<string, unknown>;
      enabled?: boolean;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = await patchDataConnectorRoute({
      auth,
      connectorId: c.req.param('connectorId'),
      name:
        typeof payload.data.name === 'string' ? payload.data.name : undefined,
      config:
        payload.data.config !== undefined &&
        payload.data.config &&
        typeof payload.data.config === 'object'
          ? payload.data.config
          : payload.data.config === null
            ? {}
            : undefined,
      enabled:
        typeof payload.data.enabled === 'boolean'
          ? payload.data.enabled
          : undefined,
      verifier: opts.dataConnectorVerifier,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/data-connectors/:connectorId', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const result = deleteDataConnectorRoute({
      auth,
      connectorId: c.req.param('connectorId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/data-connectors/:connectorId/credential', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      apiKey?: string | null;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = await setDataConnectorCredentialRoute({
      auth,
      connectorId: c.req.param('connectorId'),
      apiKey:
        typeof payload.data.apiKey === 'string' || payload.data.apiKey === null
          ? payload.data.apiKey
          : undefined,
      verifier: opts.dataConnectorVerifier,
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

  app.post('/api/v1/talk-folders', async (c) => {
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

    const result = createTalkFolderRoute({
      auth,
      title: payload.data.title,
    });

    return new Response(JSON.stringify(result.body), {
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

  app.patch('/api/v1/talks/:id', async (c) => {
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

    const encodedTalkId = c.req.param('id');
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

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      title?: string;
      folderId?: string | null;
    }>(bodyText);
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

    const result = patchTalkRoute({
      talkId,
      auth,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
      folderId:
        typeof payload.data.folderId === 'string' ||
        payload.data.folderId === null
          ? payload.data.folderId
          : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talks/:id', async (c) => {
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

    const encodedTalkId = c.req.param('id');
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

    const result = deleteTalkRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.patch('/api/v1/talk-folders/:id', async (c) => {
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

    const encodedFolderId = c.req.param('id');
    const folderId = safeDecodePathSegment(encodedFolderId);
    if (!folderId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_folder_id',
            message: 'Folder ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const bodyText = await c.req.text();
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

    const result = patchTalkFolderRoute({
      folderId,
      auth,
      title:
        typeof payload.data.title === 'string' ? payload.data.title : undefined,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete('/api/v1/talk-folders/:id', async (c) => {
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

    const encodedFolderId = c.req.param('id');
    const folderId = safeDecodePathSegment(encodedFolderId);
    if (!folderId) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_folder_id',
            message: 'Folder ID path segment is not valid URL encoding',
          },
        },
        400,
      );
    }

    const result = deleteTalkFolderRoute({
      folderId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/sidebar/reorder', async (c) => {
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
    const payload = parseJsonPayload<{
      itemType?: 'talk' | 'folder';
      itemId?: string;
      destinationFolderId?: string | null;
      destinationIndex?: number;
    }>(bodyText);
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

    if (
      payload.data.itemType !== 'talk' &&
      payload.data.itemType !== 'folder'
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Item type must be talk or folder',
          },
        },
        400,
      );
    }
    if (
      typeof payload.data.itemId !== 'string' ||
      payload.data.itemId.length === 0
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Item id is required',
          },
        },
        400,
      );
    }
    if (
      !(
        typeof payload.data.destinationFolderId === 'string' ||
        payload.data.destinationFolderId === null
      )
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Destination folder must be a folder id or null',
          },
        },
        400,
      );
    }
    if (
      typeof payload.data.destinationIndex !== 'number' ||
      Number.isNaN(payload.data.destinationIndex)
    ) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'invalid_sidebar_reorder',
            message: 'Destination index must be a number',
          },
        },
        400,
      );
    }

    const result = reorderTalkSidebarRoute({
      auth,
      itemType: payload.data.itemType,
      itemId: payload.data.itemId,
      destinationFolderId: payload.data.destinationFolderId,
      destinationIndex: payload.data.destinationIndex,
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

  app.get('/api/v1/talks/:talkId/agents', async (c) => {
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

    const result = listTalkAgentsRoute({
      talkId,
      auth,
      executorSettings: opts.executorSettings,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const result = listTalkDataConnectorsRoute({
      auth,
      talkId: c.req.param('talkId'),
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.post('/api/v1/talks/:talkId/data-connectors', async (c) => {
    const auth = requireAuth(c);
    if (!auth) return unauthorized(c);

    const rateResult = checkRateLimit({
      principalId: auth.userId,
      bucket: 'write',
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
        { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
        403,
      );
    }

    const bodyText = await c.req.text();
    const payload = parseJsonPayload<{
      connectorId?: string;
    }>(bodyText);
    if (!payload.ok) {
      return c.json(
        { ok: false, error: { code: 'invalid_json', message: payload.error } },
        400,
      );
    }
    if (!payload.data || typeof payload.data !== 'object') {
      return c.json(
        {
          ok: false,
          error: { code: 'invalid_json', message: 'JSON object expected.' },
        },
        400,
      );
    }

    const result = attachTalkDataConnectorRoute({
      auth,
      talkId: c.req.param('talkId'),
      connectorId:
        typeof payload.data.connectorId === 'string'
          ? payload.data.connectorId
          : '',
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.delete(
    '/api/v1/talks/:talkId/data-connectors/:connectorId',
    async (c) => {
      const auth = requireAuth(c);
      if (!auth) return unauthorized(c);

      const rateResult = checkRateLimit({
        principalId: auth.userId,
        bucket: 'write',
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
          { ok: false, error: { code: 'csrf_failed', message: csrf.reason } },
          403,
        );
      }

      const result = detachTalkDataConnectorRoute({
        auth,
        talkId: c.req.param('talkId'),
        connectorId: c.req.param('connectorId'),
      });
      return new Response(JSON.stringify(result.body), {
        status: result.statusCode,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  );

  app.put('/api/v1/talks/:talkId/agents', async (c) => {
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

    const payload = parseJsonPayload<{ agents?: unknown }>(bodyText);
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

    const result = updateTalkAgentsRoute({
      talkId,
      auth,
      agents: payload.data.agents,
      executorSettings: opts.executorSettings,
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

  app.get('/api/v1/talks/:talkId/runs', async (c) => {
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

    const result = listTalkRunsRoute({ talkId, auth });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.get('/api/v1/talks/:talkId/policy', async (c) => {
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

    const result = getTalkPolicyRoute({
      talkId,
      auth,
    });
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  app.put('/api/v1/talks/:talkId/policy', async (c) => {
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

    const payload = parseJsonPayload<{ agents?: unknown }>(bodyText);
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

    const result = updateTalkPolicyRoute({
      talkId,
      auth,
      agents: payload.data.agents,
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

    const payload = parseJsonPayload<{
      content?: string;
      targetAgentIds?: unknown;
    }>(bodyText);
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
      targetAgentIds: Array.isArray(payload.data.targetAgentIds)
        ? payload.data.targetAgentIds.filter(
            (entry): entry is string => typeof entry === 'string',
          )
        : null,
      idempotencyKey,
    });
    if (result.statusCode === 202 && result.body.ok) {
      opts.runWorker.wake();
    }

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
    if (isLiveSseMode(c.req.query('stream'))) {
      if (!tryAcquireLiveSseConnection(auth.userId)) {
        c.header('retry-after', String(SSE_STREAM_RETRY_AFTER_SEC));
        return c.json(
          {
            ok: false,
            error: {
              code: 'too_many_stream_connections',
              message: `Maximum ${MAX_LIVE_SSE_CONNECTIONS_PER_USER} live event streams per user`,
            },
          },
          429,
        );
      }
      return createLiveSseResponse({
        topics: getUserScopedEventTopics(auth.userId),
        lastEventId,
        requestSignal: c.req.raw.signal,
        onClose: () => releaseLiveSseConnection(auth.userId),
      });
    }

    const stream = buildUserScopedSseStream({
      userId: auth.userId,
      lastEventId,
    });

    return c.body(
      `retry: ${SSE_RETRY_MS}\n\n${stream}`,
      200,
      sseHeaders('snapshot'),
    );
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
    if (isLiveSseMode(c.req.query('stream'))) {
      if (!tryAcquireLiveSseConnection(auth.userId)) {
        c.header('retry-after', String(SSE_STREAM_RETRY_AFTER_SEC));
        return c.json(
          {
            ok: false,
            error: {
              code: 'too_many_stream_connections',
              message: `Maximum ${MAX_LIVE_SSE_CONNECTIONS_PER_USER} live event streams per user`,
            },
          },
          429,
        );
      }
      return createLiveSseResponse({
        topics: getTalkScopedEventTopics(talkId),
        lastEventId,
        requestSignal: c.req.raw.signal,
        onClose: () => releaseLiveSseConnection(auth.userId),
      });
    }

    const stream = buildTalkScopedSseStream({ talkId, lastEventId });

    return c.body(
      `retry: ${SSE_RETRY_MS}\n\n${stream}`,
      200,
      sseHeaders('snapshot'),
    );
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
    });
    if (
      result.statusCode === 200 &&
      result.body.ok &&
      result.cancelledRunning
    ) {
      opts.runWorker.abortTalk(talkId);
    }

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

  // Serve SPA assets in production from webapp/dist.
  app.get('*', (c) => {
    const response = serveWebAppRequest(c.req.path, opts.webAppDistDir);
    return response || c.text('Not Found', 404);
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

function forbidden(c: Context, message: string) {
  return c.json(
    {
      ok: false,
      error: {
        code: 'forbidden',
        message,
      },
    },
    403,
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

function isLiveSseMode(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

function sseHeaders(mode: 'snapshot' | 'stream'): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-clawrocket-sse-mode': mode,
  };
}

function createLiveSseResponse(input: {
  topics: string[];
  lastEventId: number;
  requestSignal: AbortSignal;
  onClose?: () => void;
}): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  let finalized = false;

  const finalize = () => {
    if (finalized) return;
    finalized = true;
    input.onClose?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const write = (chunk: string) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const close = () => {
        if (!cancelled) {
          cancelled = true;
        }
        try {
          controller.close();
        } catch {
          // ignored; stream may already be closed
        } finally {
          finalize();
        }
      };

      const onAbort = () => close();
      input.requestSignal.addEventListener('abort', onAbort, { once: true });

      try {
        write(`retry: ${SSE_RETRY_MS}\n\n`);

        let cursor = input.lastEventId;
        let lastHeartbeatMs = Date.now();

        while (!cancelled && !input.requestSignal.aborted) {
          const minId = getOutboxMinEventIdForTopics(input.topics);
          if (cursor > 0 && minId !== null && cursor < minId - 1) {
            write(
              'event: replay_gap\ndata: {"message":"Requested replay position is outside retention window"}\n\n',
            );
            // Resume from earliest retained event to avoid repeated replay_gap spam.
            cursor = minId - 1;
          }

          const events = getOutboxEventsForTopics(
            input.topics,
            cursor,
            SSE_STREAM_BATCH_LIMIT,
          );
          for (const event of events) {
            write(formatOutboxEventAsSse(event));
            cursor = event.event_id;
          }

          const nowMs = Date.now();
          if (nowMs - lastHeartbeatMs >= SSE_STREAM_HEARTBEAT_MS) {
            write(': keepalive\n\n');
            lastHeartbeatMs = nowMs;
          }

          await sleepWithAbort(SSE_STREAM_POLL_MS, input.requestSignal);
        }
      } finally {
        input.requestSignal.removeEventListener('abort', onAbort);
        close();
      }
    },
    cancel: () => {
      cancelled = true;
      finalize();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: sseHeaders('stream'),
  });
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return;

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function serveWebAppRequest(
  requestPath: string,
  webAppDistDir: string,
): Response | null {
  const distDir = path.resolve(webAppDistDir);
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) return null;

  // Asset requests (with extension) map directly to files under dist/.
  const extension = path.extname(requestPath);
  if (extension) {
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

  // Route paths fallback to SPA index.
  return serveStaticFile(indexPath, true, requestPath);
}

function resolveSafeDistPath(
  distDir: string,
  requestPath: string,
): string | null {
  const relativePath = requestPath.startsWith('/')
    ? requestPath.slice(1)
    : requestPath;
  const normalizedRelative = path.normalize(relativePath);
  if (
    !normalizedRelative ||
    normalizedRelative.startsWith('..') ||
    path.isAbsolute(normalizedRelative)
  ) {
    return null;
  }

  const fullPath = path.resolve(distDir, normalizedRelative);
  if (fullPath === distDir || !fullPath.startsWith(`${distDir}${path.sep}`)) {
    return null;
  }

  return fullPath;
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
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
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

function isSafeRelativeRedirectTarget(pathValue: string): boolean {
  if (!pathValue.startsWith('/')) return false;
  if (pathValue.startsWith('//')) return false;
  if (pathValue.includes('\\')) return false;
  if (/[\u0000-\u001f\u007f]/.test(pathValue)) return false;
  return true;
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
