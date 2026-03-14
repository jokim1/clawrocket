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

  // it('migrates legacy llm_providers tables so nvidia providers can be saved', () => {
  //   _initCoreTestDatabase();
  //
  //   const database = getDb();
  //   database.exec(`
  //     CREATE TABLE llm_providers (
  //       id TEXT PRIMARY KEY,
  //       name TEXT NOT NULL,
  //       provider_kind TEXT NOT NULL
  //         CHECK(provider_kind IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'custom')),
  //       api_format TEXT NOT NULL
  //         CHECK(api_format IN ('anthropic_messages', 'openai_chat_completions')),
  //       base_url TEXT NOT NULL,
  //       auth_scheme TEXT NOT NULL
  //         CHECK(auth_scheme IN ('x_api_key', 'bearer')),
  //       enabled INTEGER NOT NULL DEFAULT 1,
  //       core_compatibility TEXT NOT NULL DEFAULT 'none'
  //         CHECK(core_compatibility IN ('none', 'claude_sdk_proxy')),
  //       response_start_timeout_ms INTEGER,
  //       stream_idle_timeout_ms INTEGER,
  //       absolute_timeout_ms INTEGER,
  //       updated_at TEXT NOT NULL,
  //       updated_by TEXT REFERENCES users(id)
  //     );
  //
  //     CREATE TABLE llm_provider_models (
  //       provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  //       model_id TEXT NOT NULL,
  //       display_name TEXT NOT NULL,
  //       context_window_tokens INTEGER NOT NULL,
  //       default_max_output_tokens INTEGER NOT NULL,
  //       enabled INTEGER NOT NULL DEFAULT 1,
  //       updated_at TEXT NOT NULL,
  //       updated_by TEXT REFERENCES users(id),
  //       PRIMARY KEY (provider_id, model_id)
  //     );
  //
  //     CREATE TABLE llm_provider_secrets (
  //       provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
  //       ciphertext TEXT NOT NULL,
  //       updated_at TEXT NOT NULL,
  //       updated_by TEXT REFERENCES users(id)
  //     );
  //
  //     CREATE TABLE llm_provider_verifications (
  //       provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
  //       status TEXT NOT NULL
  //         CHECK(status IN ('missing', 'not_verified', 'verified', 'invalid', 'unavailable')),
  //       last_verified_at TEXT,
  //       last_error TEXT,
  //       updated_at TEXT NOT NULL
  //     );
  //   `);
  //
  //   expect(() => _initClawrocketTestSchema()).not.toThrow();
  //   expect(() =>
  //     upsertKnownProviderCredential({
  //       providerId: 'provider.nvidia',
  //       credential: { apiKey: 'nvapi-test-key' },
  //     }),
  //   ).not.toThrow();
  //   expect(() =>
  //     upsertProviderVerification({
  //       providerId: 'provider.nvidia',
  //       status: 'verifying',
  //     }),
  //   ).not.toThrow();
  // });

  it('adds sequence_in_run and supports_tools to legacy tables', () => {
    _initCoreTestDatabase();

    const database = getDb();
    database.exec(`
      CREATE TABLE talk_messages (
        id TEXT PRIMARY KEY,
        talk_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL,
        run_id TEXT,
        metadata_json TEXT
      );

      CREATE TABLE llm_provider_models (
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        context_window_tokens INTEGER NOT NULL,
        default_max_output_tokens INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT,
        PRIMARY KEY (provider_id, model_id)
      );
    `);

    expect(() => _initClawrocketTestSchema()).not.toThrow();

    const messageColumns = database
      .prepare(`PRAGMA table_info('talk_messages')`)
      .all() as Array<{ name: string }>;
    expect(
      messageColumns.some((column) => column.name === 'sequence_in_run'),
    ).toBe(true);

    const modelColumns = database
      .prepare(`PRAGMA table_info('llm_provider_models')`)
      .all() as Array<{ name: string }>;
    expect(
      modelColumns.some((column) => column.name === 'supports_tools'),
    ).toBe(true);
  });
});
