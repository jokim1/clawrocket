// editorialboard.ai schema bootstrap.
//
// PR-3 of the PURGE collapsed this from ~3300 LOC across 116 CREATE TABLE
// statements (Talks, Channels, Browser, Connectors, agent runtime, etc.)
// down to the editorial-only persistence surface: identity, sessions,
// invites, OAuth state, device codes, Google credentials, and the LLM
// provider catalog.
//
// Local data is disposable per CLAUDE.md, so this file has no migration
// logic. Fresh installs get the schema below; older installs nuke their
// SQLite file and re-bootstrap.

import Database from 'better-sqlite3';

import { getDb } from '../../db.js';
import { BUILTIN_ADDITIONAL_PROVIDERS } from '../llm/builtin-providers.js';

function createEditorialSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      user_type TEXT NOT NULL DEFAULT 'human'
        CHECK(user_type IN ('human', 'system')),
      role TEXT NOT NULL DEFAULT 'member'
        CHECK(role IN ('owner', 'admin', 'member')),
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      last_login_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS user_invites (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'member')),
      invited_by TEXT NOT NULL REFERENCES users(id),
      accepted INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_invites_email ON user_invites(email);

    CREATE TABLE IF NOT EXISTS web_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_token_hash TEXT NOT NULL UNIQUE,
      refresh_token_hash TEXT NOT NULL UNIQUE,
      access_expires_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      rotated_from TEXT REFERENCES web_sessions(id),
      device_id TEXT,
      created_at TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_web_sessions_user_id ON web_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_state (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      state_hash TEXT NOT NULL UNIQUE,
      nonce_hash TEXT NOT NULL,
      code_verifier_hash TEXT NOT NULL,
      code_verifier TEXT,
      redirect_uri TEXT NOT NULL,
      return_to TEXT,
      requested_by_user_id TEXT REFERENCES users(id),
      requested_by_session_id TEXT REFERENCES web_sessions(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_state_expires_at ON oauth_state(expires_at);

    CREATE TABLE IF NOT EXISTS device_auth_codes (
      id TEXT PRIMARY KEY,
      device_code_hash TEXT NOT NULL UNIQUE,
      user_code_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'expired')),
      user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_device_auth_status_expires
      ON device_auth_codes(status, expires_at);

    CREATE TABLE IF NOT EXISTS user_google_credentials (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      google_subject TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT,
      scopes_json TEXT NOT NULL,
      ciphertext TEXT NOT NULL,
      access_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_google_credentials_user_id_unique
      ON user_google_credentials(user_id);

    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_kind TEXT NOT NULL
        CHECK(provider_kind IN ('anthropic', 'openai', 'gemini', 'deepseek', 'kimi', 'nvidia', 'custom')),
      api_format TEXT NOT NULL
        CHECK(api_format IN ('anthropic_messages', 'openai_chat_completions')),
      base_url TEXT NOT NULL,
      auth_scheme TEXT NOT NULL
        CHECK(auth_scheme IN ('x_api_key', 'bearer')),
      enabled INTEGER NOT NULL DEFAULT 1,
      core_compatibility TEXT NOT NULL DEFAULT 'none'
        CHECK(core_compatibility IN ('none', 'claude_sdk_proxy')),
      response_start_timeout_ms INTEGER,
      stream_idle_timeout_ms INTEGER,
      absolute_timeout_ms INTEGER,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_models (
      provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
      model_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      context_window_tokens INTEGER NOT NULL,
      default_max_output_tokens INTEGER NOT NULL,
      default_ttft_timeout_ms INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id),
      PRIMARY KEY (provider_id, model_id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_secrets (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS llm_provider_verifications (
      provider_id TEXT PRIMARY KEY REFERENCES llm_providers(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_tool_permissions (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      allowed INTEGER NOT NULL DEFAULT 1,
      requires_approval INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, tool_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_tool_permissions_user_id
      ON user_tool_permissions(user_id);
  `);

  seedAnthropicProvider(database);
  seedAdditionalProviders(database);
}

function seedAnthropicProvider(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO llm_providers (
        id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
        core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
        absolute_timeout_ms, updated_at, updated_by
      )
      VALUES (
        'provider.anthropic',
        'Claude (Anthropic)',
        'anthropic',
        'anthropic_messages',
        'https://api.anthropic.com',
        'x_api_key',
        1,
        'claude_sdk_proxy',
        60000,
        30000,
        600000,
        ?,
        NULL
      )
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(now);

  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
      )
      VALUES
        ('provider.anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 200000, 8192, 90000, 1, ?, NULL),
        ('provider.anthropic', 'claude-opus-4-6',   'Claude Opus 4.6',   200000, 8192, 180000, 1, ?, NULL)
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now, now);
}

function seedAdditionalProviders(database: Database.Database): void {
  const now = new Date().toISOString();

  for (const provider of BUILTIN_ADDITIONAL_PROVIDERS) {
    database
      .prepare(
        `
        INSERT INTO llm_providers (
          id, name, provider_kind, api_format, base_url, auth_scheme, enabled,
          core_compatibility, response_start_timeout_ms, stream_idle_timeout_ms,
          absolute_timeout_ms, updated_at, updated_by
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, 'none', ?, ?, ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          provider_kind = excluded.provider_kind,
          api_format = excluded.api_format,
          base_url = excluded.base_url,
          auth_scheme = excluded.auth_scheme,
          enabled = excluded.enabled,
          core_compatibility = excluded.core_compatibility,
          response_start_timeout_ms = excluded.response_start_timeout_ms,
          stream_idle_timeout_ms = excluded.stream_idle_timeout_ms,
          absolute_timeout_ms = excluded.absolute_timeout_ms,
          updated_at = excluded.updated_at,
          updated_by = excluded.updated_by
      `,
      )
      .run(
        provider.id,
        provider.name,
        provider.providerKind,
        provider.apiFormat,
        provider.baseUrl,
        provider.authScheme,
        provider.responseStartTimeoutMs,
        provider.streamIdleTimeoutMs,
        provider.absoluteTimeoutMs,
        now,
      );

    for (const model of provider.models) {
      database
        .prepare(
          `
          INSERT INTO llm_provider_models (
            provider_id, model_id, display_name, context_window_tokens,
            default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
          )
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)
          ON CONFLICT(provider_id, model_id) DO NOTHING
        `,
        )
        .run(
          provider.id,
          model.modelId,
          model.displayName,
          model.contextWindowTokens,
          model.defaultMaxOutputTokens,
          model.defaultTtftTimeoutMs,
          now,
        );
    }
  }
}

export function initClawrocketSchema(): void {
  createEditorialSchema(getDb());
}

/** @internal - for tests only. */
export function _initClawrocketTestSchema(): void {
  createEditorialSchema(getDb());
}
