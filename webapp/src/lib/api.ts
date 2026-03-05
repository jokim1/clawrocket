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
};

export type Talk = {
  id: string;
  ownerId: string;
  title: string;
  agents: string[];
  status: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  accessRole: 'owner' | 'admin' | 'editor' | 'viewer';
};

export type TalkMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
};

export type TalkRun = {
  id: string;
  status: 'queued' | 'running' | 'cancelled' | 'completed' | 'failed';
  createdAt: string;
  startedAt: string | null;
};

export type TalkPolicy = {
  talkId: string;
  agents: string[];
};

type ApiEnvelope<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
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

export async function getAuthConfig(): Promise<AuthConfigPayload> {
  return apiRequest<AuthConfigPayload>('/api/v1/auth/config');
}

export async function getSessionMe(): Promise<SessionUser> {
  const envelope = await apiRequest<{ user: SessionUser }>('/api/v1/session/me');
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

export async function listTalks(): Promise<Talk[]> {
  const envelope = await apiRequest<{
    talks: Talk[];
    page: { limit: number; offset: number; count: number };
  }>('/api/v1/talks');
  return envelope.talks;
}

export async function createTalk(title: string): Promise<Talk> {
  const envelope = await apiRequest<{ talk: Talk }>('/api/v1/talks', {
    method: 'POST',
    headers: buildMutationHeaders({ includeJson: true }),
    body: JSON.stringify({ title }),
  });
  return envelope.talk;
}

export async function getTalk(talkId: string): Promise<Talk> {
  const envelope = await apiRequest<{ talk: Talk }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}`,
  );
  return envelope.talk;
}

export async function getTalkPolicy(talkId: string): Promise<TalkPolicy> {
  return apiRequest<TalkPolicy>(`/api/v1/talks/${encodeURIComponent(talkId)}/policy`);
}

export async function updateTalkPolicy(input: {
  talkId: string;
  agents: string[];
}): Promise<TalkPolicy> {
  return apiRequest<TalkPolicy>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/policy`,
    {
      method: 'PUT',
      headers: buildMutationHeaders({ includeJson: true }),
      body: JSON.stringify({ agents: input.agents }),
    },
  );
}

export async function listTalkMessages(talkId: string): Promise<TalkMessage[]> {
  const envelope = await apiRequest<{
    talkId: string;
    messages: TalkMessage[];
    page: { limit: number; count: number; beforeCreatedAt: string | null };
  }>(`/api/v1/talks/${encodeURIComponent(talkId)}/messages`);
  return envelope.messages;
}

export async function sendTalkMessage(input: {
  talkId: string;
  content: string;
}): Promise<{ talkId: string; message: TalkMessage; run: TalkRun }> {
  return apiRequest<{ talkId: string; message: TalkMessage; run: TalkRun }>(
    `/api/v1/talks/${encodeURIComponent(input.talkId)}/chat`,
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: true }),
      body: JSON.stringify({ content: input.content }),
    },
  );
}

export async function cancelTalkRuns(
  talkId: string,
): Promise<{ talkId: string; cancelledRuns: number }> {
  return apiRequest<{ talkId: string; cancelledRuns: number }>(
    `/api/v1/talks/${encodeURIComponent(talkId)}/chat/cancel`,
    {
      method: 'POST',
      headers: buildMutationHeaders({ includeJson: false }),
    },
  );
}

export async function logout(): Promise<void> {
  await apiRequest<{ loggedOut: boolean }>(AUTH_LOGOUT_PATH, {
    method: 'POST',
    headers: buildMutationHeaders({ includeJson: false }),
  });
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  return apiRequestWithRefresh<T>(path, init, true);
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

function shouldSkipRefresh(path: string): boolean {
  const normalizedPath = path.split('?')[0];
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

      const payload = (await response.json().catch(() => null)) as
        | ApiEnvelope<unknown>
        | null;
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

function buildMutationHeaders(input: { includeJson: boolean }): HeadersInit {
  const headers: Record<string, string> = {
    'x-csrf-token': getCsrfTokenFromCookie() || '',
    'idempotency-key': buildIdempotencyKey(),
  };
  if (input.includeJson) {
    headers['content-type'] = 'application/json';
  }
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
