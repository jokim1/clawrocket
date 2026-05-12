// clawtalk Phase 5 (PR 1) — Postgres data layer.
//
// Lives alongside src/db.ts (better-sqlite3) during the foundation PR.
// PR 2 deletes src/db.ts and points every accessor at this module.
//
// Two execution modes share this code:
//
//   Node (`tsx src/server.ts`, local dev): single module-scoped
//   postgres.js client. Connections pooled in-client. tsx is a
//   long-lived process so this is fine.
//
//   Cloudflare Workers (`src/worker.ts`): per-request client via
//   `withRequestScopedDb`. Workers' I/O isolation rejects cross-request
//   sockets, so a module-scoped client throws on the second request.
//
// Per-user routes wrap accessor segments in `withUserContext(userId, fn)`
// which opens a transaction, downgrades to the `authenticated` role, and
// binds `request.jwt.claims->>'sub'` so `auth.uid()` returns the caller's
// userId. The 0002_rls_policies.sql migration enforces per-row ownership
// through these claims.
//
// Lookup chain in `getDb()`: userContext (inside withUserContext) →
// requestScoped (Worker) → nodeScoped (Node). Once inside a wrapped
// block, every accessor MUST use the tx — anything else silently bypasses
// RLS via the BYPASSRLS pooled connection.

import { AsyncLocalStorage } from 'node:async_hooks';

import postgres from 'postgres';

export const DATABASE_URL_ENV = 'CLAWTALK_DATABASE_URL';
const LOCAL_FALLBACK_URL =
  'postgresql://postgres:postgres@127.0.0.1:54432/postgres';

let nodeScopedDb: postgres.Sql | null = null;
const requestScopedDbStorage = new AsyncLocalStorage<postgres.Sql>();

interface UserContextStore {
  tx: postgres.TransactionSql;
  userId: string;
}
const userContextStorage = new AsyncLocalStorage<UserContextStore>();

export type Sql = postgres.Sql;

function resolveDatabaseUrl(override?: string): string {
  return (
    override?.trim() ||
    process.env[DATABASE_URL_ENV]?.trim() ||
    LOCAL_FALLBACK_URL
  );
}

export function getDbPg(): Sql {
  const fromUserContext = userContextStorage.getStore();
  // TransactionSql is a structural subset of Sql (no .end, no listen, etc.)
  // but exposes the tagged-template query API every accessor uses. Cast
  // is safe in practice — the missing methods aren't called inside
  // withUserContext.
  if (fromUserContext) return fromUserContext.tx as unknown as Sql;
  const fromRequest = requestScopedDbStorage.getStore();
  if (fromRequest) return fromRequest;
  if (!nodeScopedDb) throw new Error('Postgres database not initialized');
  return nodeScopedDb;
}

/**
 * Open a Postgres transaction, downgrade to `authenticated`, bind
 * `request.jwt.claims` so `auth.uid()` returns the caller's userId, and
 * run `fn` in an ALS scope where `getDbPg()` returns that transaction.
 *
 * Re-entrancy with the same userId reuses the outer transaction. Nested
 * calls with a different userId are a caller bug and throw synchronously
 * — cross-user nesting would silently leak data via the outer tx's claims.
 */
export async function withUserContext<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = userContextStorage.getStore();
  if (existing) {
    if (existing.userId !== userId) {
      throw new Error(
        `withUserContext re-entered with a different userId (outer=${existing.userId}, inner=${userId}); cross-user nesting is a caller bug`,
      );
    }
    return fn();
  }
  const db = requestScopedDbStorage.getStore() ?? nodeScopedDb;
  if (!db) throw new Error('Postgres database not initialized');
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });
  return db.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${claims}, true)`;
    return userContextStorage.run({ tx, userId }, fn);
  }) as Promise<T>;
}

// Node mode — call once at process boot. Idempotent.
export async function initPgDatabase(input?: { url?: string }): Promise<void> {
  if (nodeScopedDb) return;
  nodeScopedDb = postgres(resolveDatabaseUrl(input?.url), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

export async function closePgDatabase(): Promise<void> {
  if (!nodeScopedDb) return;
  const handle = nodeScopedDb;
  nodeScopedDb = null;
  await handle.end({ timeout: 5 });
}

// Minimal slice of Cloudflare's ExecutionContext — enough for waitUntil.
// Avoids importing @cloudflare/workers-types globals into modules that
// also need @types/node DOM types.
export interface RequestExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Workers mode — wrap a per-request unit of work. Creates a fresh
 * postgres.js client (bound to this request's I/O context), runs `fn`
 * inside an ALS-scoped context so accessors that call `getDbPg()` see
 * this client, and best-effort closes the client after `fn` resolves.
 * If `ctx` is provided, the close is forwarded via `ctx.waitUntil()`.
 */
export async function withRequestScopedDb<T>(
  url: string,
  ctx: RequestExecutionContext | null,
  fn: (sql: Sql) => Promise<T>,
): Promise<T> {
  const sql = postgres(url, {
    // Hyperdrive owns the upstream pool — one client connection per
    // request is enough. fetch_types: true is required for text[]
    // column decoding (gotcha #2 in editorialroom's port: without it,
    // text[] columns return raw `'{a,b,c}'` strings instead of JS
    // arrays). +1 round-trip per cold isolate, amortized vs LLM calls.
    max: 1,
    fetch_types: true,
    idle_timeout: 5,
    connect_timeout: 10,
  });
  try {
    return await requestScopedDbStorage.run(sql, () => fn(sql));
  } finally {
    const close = sql.end({ timeout: 5 }).catch(() => undefined);
    if (ctx) {
      ctx.waitUntil(close);
    } else {
      await close;
    }
  }
}

export async function isPgDatabaseHealthy(): Promise<boolean> {
  const db =
    userContextStorage.getStore()?.tx ??
    requestScopedDbStorage.getStore() ??
    nodeScopedDb;
  if (!db) return false;
  try {
    const rows = await db`select 1 as ok`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
