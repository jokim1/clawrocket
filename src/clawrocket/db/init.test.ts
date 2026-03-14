import { describe, expect, it } from 'vitest';

import { _initTestDatabase } from './index.js';
import { getDb } from '../../db.js';

describe('clawrocket schema init', () => {
  it('creates all core tables on a fresh database', () => {
    _initTestDatabase();
    const db = getDb();

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    // Core tables from db.ts
    expect(tableNames).toContain('chats');
    expect(tableNames).toContain('scheduled_tasks');

    // Clawrocket tables
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('talks');
    expect(tableNames).toContain('talk_messages');
    expect(tableNames).toContain('talk_runs');
    expect(tableNames).toContain('registered_agents');
    expect(tableNames).toContain('talk_agents');
    expect(tableNames).toContain('talk_llm_policies');
    expect(tableNames).toContain('talk_executor_sessions');
    expect(tableNames).toContain('channel_delivery_outbox');
    expect(tableNames).toContain('llm_attempts');
  });

  it('talk_messages table has required columns', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('talk_messages')`)
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('talk_id');
    expect(colNames).toContain('thread_id');
    expect(colNames).toContain('role');
    expect(colNames).toContain('content');
    expect(colNames).toContain('agent_id');
    expect(colNames).toContain('run_id');
    expect(colNames).toContain('sequence_in_run');
    expect(colNames).toContain('created_by');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('metadata_json');
  });

  it('talks table includes version column', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db.prepare(`PRAGMA table_info('talks')`).all() as Array<{
      name: string;
    }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('version');
  });

  it('registered_agents table has tool_permissions_json', () => {
    _initTestDatabase();
    const db = getDb();

    const columns = db
      .prepare(`PRAGMA table_info('registered_agents')`)
      .all() as Array<{ name: string }>;
    const colNames = columns.map((c) => c.name);

    expect(colNames).toContain('tool_permissions_json');
  });
});
