import http, { IncomingMessage, Server, ServerResponse } from 'http';

import { canAccessTalk } from './middleware/acl.js';
import { authenticateRequest } from './middleware/auth.js';
import { validateCsrfToken } from './middleware/csrf.js';
import {
  idempotencyPrecheck,
  saveIdempotencyResult,
} from './middleware/idempotency.js';
import { checkRateLimit } from './middleware/rate-limit.js';
import { sendJson, sendSse } from './response.js';
import {
  buildTalkScopedSseStream,
  buildUserScopedSseStream,
} from './routes/events.js';
import { healthResponse, statusResponse } from './routes/system.js';
import { cancelTalkChat } from './routes/talks.js';
import { KeychainBridge, noopKeychainBridge } from '../secrets/keychain.js';
import { TalkRunQueue } from '../talks/run-queue.js';

export interface WebServerOptions {
  host: string;
  port: number;
  keychain: KeychainBridge;
  runQueue: TalkRunQueue;
}

export interface WebServerHandle {
  start: () => Promise<{ host: string; port: number }>;
  stop: () => Promise<void>;
  server: Server;
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

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, opts);
  });

  return {
    server,
    start: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host, () => {
          const address = server.address();
          const resolvedPort =
            address && typeof address === 'object' ? address.port : opts.port;
          resolve({ host: opts.host, port: resolvedPort });
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: WebServerOptions,
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  );
  const path = url.pathname;

  if (method === 'GET' && path === '/api/v1/health') {
    const health = await healthResponse();
    if (!health.ok) {
      sendJson(res, 503, health);
      return;
    }
    sendJson(res, 200, health);
    return;
  }

  const auth = authenticateRequest({
    authorization: stringHeader(req.headers.authorization),
    cookie: stringHeader(req.headers.cookie),
  });
  if (!auth) {
    sendJson(res, 401, {
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Authentication is required',
      },
    });
    return;
  }

  const rateBucket = selectRateBucket(method, path);
  const rate = checkRateLimit({ userId: auth.userId, bucket: rateBucket });
  if (!rate.allowed) {
    sendJson(
      res,
      429,
      {
        ok: false,
        error: {
          code: 'rate_limited',
          message: 'Rate limit exceeded',
          details: {
            limit: rate.limit,
            retryAfterSec: rate.retryAfterSec,
          },
        },
      },
      {
        'retry-after': String(rate.retryAfterSec),
      },
    );
    return;
  }

  const bodyText = await readBody(req);

  if (isMutating(method)) {
    const csrfResult = validateCsrfToken({
      method,
      authType: auth.authType,
      cookieHeader: stringHeader(req.headers.cookie),
      csrfHeader: stringHeader(req.headers['x-csrf-token']),
    });
    if (!csrfResult.ok) {
      sendJson(res, 403, {
        ok: false,
        error: {
          code: 'csrf_failed',
          message: csrfResult.reason,
        },
      });
      return;
    }

    const precheck = idempotencyPrecheck({
      userId: auth.userId,
      idempotencyKey: stringHeader(req.headers['idempotency-key']) || null,
      method,
      path,
      bodyText,
    });
    if (precheck.error) {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'idempotency_error',
          message: precheck.error,
        },
      });
      return;
    }

    if (precheck.replay && precheck.response) {
      res.setHeader('x-idempotent-replay', 'true');
      res.writeHead(precheck.response.statusCode, {
        'content-type': 'application/json; charset=utf-8',
      });
      res.end(precheck.response.responseBody);
      return;
    }

    if (method === 'POST') {
      const cancelMatch = path.match(
        /^\/api\/v1\/talks\/([^/]+)\/chat\/cancel$/,
      );
      if (cancelMatch) {
        const talkId = decodeURIComponent(cancelMatch[1]);
        const result = cancelTalkChat({
          talkId,
          auth,
          runQueue: opts.runQueue,
        });
        const serialized = JSON.stringify(result.body);
        saveIdempotencyResult({
          userId: auth.userId,
          idempotencyKey: stringHeader(req.headers['idempotency-key']) || '',
          method,
          path,
          requestHash: precheck.requestHash,
          statusCode: result.statusCode,
          responseBody: serialized,
        });
        sendJson(res, result.statusCode, result.body);
        return;
      }
    }

    sendJson(res, 404, {
      ok: false,
      error: {
        code: 'not_found',
        message: 'Route not found',
      },
    });
    return;
  }

  if (method === 'GET' && path === '/api/v1/status') {
    const payload = await statusResponse(opts.keychain);
    sendJson(res, 200, payload);
    return;
  }

  if (method === 'GET' && path === '/api/v1/events') {
    const lastEventId = parseLastEventId(
      stringHeader(req.headers['last-event-id']),
    );
    const stream = buildUserScopedSseStream({
      userId: auth.userId,
      lastEventId,
    });
    sendSse(res, stream);
    return;
  }

  const talkEventMatch = path.match(/^\/api\/v1\/talks\/([^/]+)\/events$/);
  if (method === 'GET' && talkEventMatch) {
    const talkId = decodeURIComponent(talkEventMatch[1]);
    if (!canAccessTalk(talkId, auth.userId)) {
      sendJson(res, 404, {
        ok: false,
        error: {
          code: 'talk_not_found',
          message: 'Talk not found',
        },
      });
      return;
    }

    const lastEventId = parseLastEventId(
      stringHeader(req.headers['last-event-id']),
    );
    const stream = buildTalkScopedSseStream({ talkId, lastEventId });
    sendSse(res, stream);
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: {
      code: 'not_found',
      message: 'Route not found',
    },
  });
}

function stringHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseLastEventId(value: string | undefined): number {
  const parsed = value ? parseInt(value, 10) : 0;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function selectRateBucket(
  method: string,
  path: string,
): 'chat_write' | 'write' | 'read' {
  if (!isMutating(method)) return 'read';
  if (path.includes('/chat')) return 'chat_write';
  return 'write';
}

function isMutating(method: string): boolean {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method.toUpperCase());
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}
