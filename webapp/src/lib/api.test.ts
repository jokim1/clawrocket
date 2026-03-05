import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('api auth retry behavior', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      value: 'cr_csrf_token=test-csrf-token',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes once and retries the original request after a 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          talks: [],
          page: { limit: 50, offset: 0, count: 0 },
        },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();
    const talks = await api.listTalks();

    expect(talks).toEqual([]);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('throws UnauthorizedError when refresh fails', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'invalid_refresh_token', message: 'Invalid token' },
      }),
    ];
    vi.stubGlobal('fetch', async () => {
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
  });

  it('throws UnauthorizedError when refresh succeeds but retried request is still 401', async () => {
    const queue: Response[] = [
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
      jsonResponse(200, {
        ok: true,
        data: {
          user: {
            id: 'u1',
            email: 'owner@example.com',
            displayName: 'Owner',
            role: 'owner',
          },
        },
      }),
      jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      }),
    ];
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      paths.push(normalizePath(input));
      const next = queue.shift();
      if (!next) throw new Error('No mocked response left for fetch()');
      return next;
    });

    const api = await loadApiModule();

    await expect(api.listTalks()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual([
      '/api/v1/talks',
      '/api/v1/auth/refresh',
      '/api/v1/talks',
    ]);
  });

  it('coalesces concurrent refresh attempts into a single refresh call', async () => {
    const callCounts = new Map<string, number>();
    let refreshCalls = 0;

    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      const count = callCounts.get(path) || 0;
      callCounts.set(path, count + 1);

      if (path === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      if (path === '/api/v1/talks') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            talks: [],
            page: { limit: 50, offset: 0, count: 0 },
          },
        });
      }

      if (path === '/api/v1/session/me') {
        if (count === 0) {
          return jsonResponse(401, {
            ok: false,
            error: {
              code: 'unauthorized',
              message: 'Authentication is required',
            },
          });
        }
        return jsonResponse(200, {
          ok: true,
          data: {
            user: {
              id: 'u1',
              email: 'owner@example.com',
              displayName: 'Owner',
              role: 'owner',
            },
          },
        });
      }

      throw new Error(`Unexpected fetch path: ${path}`);
    });

    const api = await loadApiModule();
    const [talks, user] = await Promise.all([api.listTalks(), api.getSessionMe()]);

    expect(talks).toEqual([]);
    expect(user.email).toBe('owner@example.com');
    expect(refreshCalls).toBe(1);
  });

  it('does not attempt refresh for logout requests', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const path = normalizePath(input);
      paths.push(path);
      return jsonResponse(401, {
        ok: false,
        error: { code: 'unauthorized', message: 'Authentication is required' },
      });
    });

    const api = await loadApiModule();

    await expect(api.logout()).rejects.toBeInstanceOf(api.UnauthorizedError);
    expect(paths).toEqual(['/api/v1/auth/logout']);
  });
});

async function loadApiModule() {
  vi.resetModules();
  return import('./api');
}

function normalizePath(input: RequestInfo | URL): string {
  const raw = String(input);
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return new URL(raw).pathname;
  }
  return raw.split('?')[0];
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
