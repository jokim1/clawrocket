import { describe, expect, it } from 'vitest';

import { _initTestDatabase as _initCoreTestDatabase, getDb } from '../../db.js';
import { _initClawrocketTestSchema } from './index.js';

describe('clawrocket schema init', () => {
  it('adds registered_agent_id to legacy talk_agents tables before creating its index', () => {
    _initCoreTestDatabase();

    const database = getDb();
    database.exec(`
      CREATE TABLE talk_agents (
        id TEXT PRIMARY KEY,
        talk_id TEXT NOT NULL,
        name TEXT NOT NULL,
        persona_role TEXT NOT NULL,
        route_id TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    expect(() => _initClawrocketTestSchema()).not.toThrow();

    const columns = database
      .prepare(`PRAGMA table_info('talk_agents')`)
      .all() as Array<{ name: string }>;
    expect(
      columns.some((column) => column.name === 'registered_agent_id'),
    ).toBe(true);

    const indexes = database
      .prepare(`PRAGMA index_list('talk_agents')`)
      .all() as Array<{ name: string }>;
    expect(
      indexes.some(
        (index) => index.name === 'idx_talk_agents_registered_agent_id',
      ),
    ).toBe(true);
  });
});
