// editorialboard.ai database bootstrap.
//
// Minimal connection helper. The schema lives in
// `src/clawrocket/db/init.ts`; the typed accessors live in
// `src/clawrocket/db/accessors.ts`. This file just opens the
// better-sqlite3 handle, exposes it via `getDb()`, and provides the
// in-memory test database hook.

import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

import { STORE_DIR } from './config.js';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
}

export function isDatabaseHealthy(): boolean {
  try {
    const row = getDb().prepare('SELECT 1 AS ok').get() as { ok: number };
    return row.ok === 1;
  } catch {
    return false;
  }
}
