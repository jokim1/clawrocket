// Session + auth API client for the Editorial Room.
//
// This is the minimal surface the editorial product needs: who am I, sign in,
// sign out, dev callback, plus the apiRequest plumbing (refresh-on-401, CSRF,
// idempotency) that the auth helpers themselves depend on.
//
// Everything else from the old `lib/api.ts` (Talk/Channel/Browser/MainChannel
// helpers and types) was deleted in PR-1 of the PURGE. The Editorial Room
// reaches the backend via direct `fetch` from feature-specific helpers
// (`lib/llm-provider-auth.ts`, `lib/panel-fanout.ts`, etc.), not via a
// generic typed API client.
//
// Cloud port note: in Phase D of `docs/CLOUD_TARGET.md`, this file is
// replaced by a Supabase-Auth-driven session shim that reads our HttpOnly
// cookie + validates against Supabase JWT. The auth functions below
// (getSessionMe, logout, etc.) survive shape-compatibly so callers don't
// need to change.

export class UnauthorizedError extends Error {
  constructor(message = 'Authentication is required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
};

export type StartAuthPayload = {
  state: string;
  authorizationUrl: string;
  expiresInSec: number;
};

export type AuthConfigPayload = {
  devMode: boolean;
};

const AUTH_REFRESH_PATH = '/api/v1/auth/refresh';
const AUTH_LOGOUT_PATH = '/api/v1/auth/logout';
let refreshInFlight: Promise<boolean> | null = null;

// ─── Public auth API ─────────────────────────────────────────────────────────

export async function getAuthConfig(): Promise<AuthConfigPayload> {
  return apiRequest<AuthConfigPayload>('/api/v1/auth/config');
}

export async function getSessionMe(): Promise<SessionUser> {
  const envelope = await apiRequest<{ user: SessionUser }>(
    '/api/v1/session/me',
  );
  return envelope.user;
}

export async function updateSessionMe(input: {
  displayName?: string;
}): Promise<SessionUser> {
  const envelope = await apiMutationRequest<{ user: SessionUser }>(
    '/api/v1/session/me',
    {
      method: 'PATCH',
      body: JSON.stringify(input),
    },
  );
  return envelope.user;
}

export async function startGoogleAuth(input?: {
  returnTo?: string;
}): Promise<StartAuthPayload> {
  if (input?.returnTo) {
    return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ returnTo: input.returnTo }),
    });
  }

  return apiRequest<StartAuthPayload>('/api/v1/auth/google/start', {
    method: 'POST',
  });
}

export async function completeDevCallback(callbackUrl: string): Promise<void> {
  const response = await fetch(callbackUrl, {
    method: 'GET',
    credentials: 'include',
    headers: {
      accept: 'application/json',
    },
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }
  if (!response.ok) {
    throw new Error(`Dev callback failed with status ${response.status}`);
  }
}

export async function logout(): Promise<void> {
  await apiMutationRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
  });
}

// ─── Internal request helpers ────────────────────────────────────────────────

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return apiRequestWithRefresh<T>(path, init, true);
}

type MutationRequestInit = Omit<RequestInit, 'headers'> & {
  headers?: HeadersInit;
  includeJson?: boolean;
};

type MutationRetryState = {
  allowAuthRetry: boolean;
  allowCsrfRetry: boolean;
  idempotencyKey: string;
};

async function apiMutationRequest<T>(
  path: string,
  init?: MutationRequestInit,
): Promise<T> {
  return apiMutationRequestWithRefresh<T>(path, init, {
    allowAuthRetry: true,
    allowCsrfRetry: true,
    idempotencyKey: buildIdempotencyKey(),
  });
}

async function apiRequestWithRefresh<T>(
  path: string,
  init: RequestInit | undefined,
  allowRefreshRetry: boolean,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (response.status === 401) {
    if (allowRefreshRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiRequestWithRefresh<T>(path, init, false);
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

async function apiMutationRequestWithRefresh<T>(
  path: string,
  init: MutationRequestInit | undefined,
  retryState: MutationRetryState,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: buildMutationAttemptHeaders({
      includeJson: init?.includeJson === true,
      explicitHeaders: init?.headers,
      idempotencyKey: retryState.idempotencyKey,
    }),
  });

  if (response.status === 401) {
    if (retryState.allowAuthRetry && !shouldSkipRefresh(path)) {
      const refreshed = await ensureRefreshedSession();
      if (refreshed) {
        return apiMutationRequestWithRefresh<T>(path, init, {
          ...retryState,
          allowAuthRetry: false,
        });
      }
    }
    throw new UnauthorizedError();
  }

  const payload = (await response.json()) as ApiEnvelope<T>;

  if (
    response.status === 403 &&
    !payload.ok &&
    payload.error?.code === 'csrf_failed' &&
    retryState.allowCsrfRetry &&
    !shouldSkipRefresh(path)
  ) {
    const refreshed = await ensureRefreshedSession();
    if (refreshed) {
      return apiMutationRequestWithRefresh<T>(path, init, {
        ...retryState,
        allowAuthRetry: false,
        allowCsrfRetry: false,
      });
    }
  }

  if (!response.ok || !payload.ok) {
    const message =
      !payload.ok && payload.error?.message
        ? payload.error.message
        : `Request failed with status ${response.status}`;
    const code = !payload.ok ? payload.error?.code : undefined;
    throw new ApiError(message, response.status, code);
  }
  return payload.data;
}

function shouldSkipRefresh(path: string): boolean {
  const normalizedPath = path.split('?')[0];
  // Logout intentionally skips refresh-based recovery so we never revive the
  // same session the user is actively trying to end.
  return (
    normalizedPath === AUTH_REFRESH_PATH || normalizedPath === AUTH_LOGOUT_PATH
  );
}

async function ensureRefreshedSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(AUTH_REFRESH_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: {
          accept: 'application/json',
        },
      });
      if (response.status === 401 || !response.ok) return false;

      const payload = (await response
        .json()
        .catch(() => null)) as ApiEnvelope<unknown> | null;
      return Boolean(payload?.ok);
    } catch {
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

function buildMutationAttemptHeaders(input: {
  includeJson: boolean;
  explicitHeaders?: HeadersInit;
  idempotencyKey: string;
}): HeadersInit {
  const headers = new Headers();
  headers.set('accept', 'application/json');

  if (input.explicitHeaders) {
    const explicitHeaders = new Headers(input.explicitHeaders);
    explicitHeaders.forEach((value, key) => {
      headers.set(key, value);
    });
  }

  if (input.includeJson && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  // Caller headers may supply generic metadata, but CSRF and idempotency are
  // always owned by this wrapper and written last from current cookie state.
  const csrfToken = getCsrfTokenFromCookie();
  if (csrfToken) {
    headers.set('x-csrf-token', csrfToken);
  } else {
    headers.delete('x-csrf-token');
  }

  headers.set('idempotency-key', input.idempotencyKey);
  return headers;
}

function getCsrfTokenFromCookie(): string | null {
  if (!globalThis.document?.cookie) return null;
  const tokenPair = document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('cr_csrf_token='));
  if (!tokenPair) return null;

  const [, value = ''] = tokenPair.split('=', 2);
  if (!value) return null;

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildIdempotencyKey(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `idem-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
