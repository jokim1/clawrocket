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

  it('seeds both Sonnet and Opus Anthropic models for AI Agents', () => {
    _initTestDatabase();
    const db = getDb();

    const models = db
      .prepare(
        `SELECT model_id, display_name
         FROM llm_provider_models
         WHERE provider_id = 'provider.anthropic'
         ORDER BY model_id`,
      )
      .all() as Array<{ model_id: string; display_name: string }>;

    expect(models).toEqual([
      {
        model_id: 'claude-opus-4-6',
        display_name: 'Claude Opus 4.6',
      },
      {
        model_id: 'claude-sonnet-4-6',
        display_name: 'Claude Sonnet 4.6',
      },
    ]);
  });

  it('seeds builtin additional providers for direct-http agents', () => {
    _initTestDatabase();
    const db = getDb();

    const providers = db
      .prepare(
        `SELECT id, name
         FROM llm_providers
         WHERE id IN ('provider.openai', 'provider.gemini', 'provider.nvidia')
         ORDER BY id`,
      )
      .all() as Array<{ id: string; name: string }>;

    expect(providers).toEqual([
      { id: 'provider.gemini', name: 'Google / Gemini' },
      { id: 'provider.nvidia', name: 'NVIDIA Kimi2.5' },
      { id: 'provider.openai', name: 'OpenAI' },
    ]);

    const models = db
      .prepare(
        `SELECT provider_id, model_id
         FROM llm_provider_models
         WHERE provider_id IN ('provider.openai', 'provider.gemini', 'provider.nvidia')
         ORDER BY provider_id, model_id`,
      )
      .all() as Array<{ provider_id: string; model_id: string }>;

    expect(models).toEqual([
      { provider_id: 'provider.gemini', model_id: 'gemini-2.5-flash' },
      { provider_id: 'provider.nvidia', model_id: 'moonshotai/kimi-k2.5' },
      { provider_id: 'provider.openai', model_id: 'gpt-5-mini' },
    ]);
  });

  it('seeds separate main and default Talk agents', () => {
    _initTestDatabase();
    const db = getDb();

    const agents = db
      .prepare(
        `SELECT id, provider_id, model_id FROM registered_agents WHERE id IN ('agent.main', 'agent.talk') ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      provider_id: string;
      model_id: string;
    }>;
    expect(agents).toEqual([
      {
        id: 'agent.main',
        provider_id: 'provider.anthropic',
        model_id: 'claude-sonnet-4-6',
      },
      {
        id: 'agent.talk',
        provider_id: 'provider.anthropic',
        model_id: 'claude-sonnet-4-6',
      },
    ]);

    const settings = db
      .prepare(
        `SELECT key, value FROM settings_kv WHERE key IN ('system.mainAgentId', 'system.defaultTalkAgentId') ORDER BY key`,
      )
      .all() as Array<{ key: string; value: string }>;
    expect(settings).toEqual([
      {
        key: 'system.defaultTalkAgentId',
        value: 'agent.talk',
      },
      {
        key: 'system.mainAgentId',
        value: 'agent.main',
      },
    ]);
  });
});
