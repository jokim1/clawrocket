import Database from 'better-sqlite3';

import { getDb } from '../../db.js';

function seedBuiltinLlmProvider(database: Database.Database): void {
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
        'builtin.mock',
        'Local Mock',
        'custom',
        'openai_chat_completions',
        'mock://local-talk-runtime',
        'bearer',
        1,
        'none',
        60000,
        20000,
        300000,
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
      VALUES (
        'builtin.mock',
        'mock-default',
        'Mock',
        64000,
        2048,
        10000,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);
}

function seedAnthropicProvider(database: Database.Database): void {
  const now = new Date().toISOString();

  // Ensure a provider.anthropic row exists in llm_providers so that
  // registered agents created through the UI can reference it.  The actual
  // API-key is stored separately in llm_provider_secrets (written when the
  // user configures Claude credentials).
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

  // Seed a default Claude model so the provider has at least one selectable
  // option before the user overrides model suggestions via settings.
  database
    .prepare(
      `
      INSERT INTO llm_provider_models (
        provider_id, model_id, display_name, context_window_tokens,
        default_max_output_tokens, default_ttft_timeout_ms, enabled, updated_at, updated_by
      )
      VALUES (
        'provider.anthropic',
        'claude-sonnet-4-6',
        'Claude Sonnet 4.6',
        200000,
        8192,
        90000,
        1,
        ?,
        NULL
      )
      ON CONFLICT(provider_id, model_id) DO NOTHING
    `,
    )
    .run(now);
}

function seedMainAgent(database: Database.Database): void {
  const now = new Date().toISOString();
  const toolPermissions = JSON.stringify({
    shell: true,
    filesystem: true,
    web: true,
    browser: true,
    connectors: true,
    google_read: true,
    google_write: true,
    gmail_read: true,
    gmail_send: true,
    messaging: true,
  });

  database
    .prepare(
      `
      INSERT INTO registered_agents (
        id, name, provider_id, model_id, tool_permissions_json,
        persona_role, system_prompt, enabled, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(
      'agent.main',
      'Nanoclaw',
      'builtin.mock',
      'mock-default',
      toolPermissions,
      'assistant',
      null,
      1,
      now,
      now,
    );
}

function seedSystemUsers(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO users (
        id, email, display_name, user_type, role, is_active, created_at, last_login_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        user_type = excluded.user_type,
        role = excluded.role,
        is_active = excluded.is_active
    `,
    )
    .run(
      'system:channel-ingress',
      'channel-ingress@local.invalid',
      'Channel Ingress',
      'system',
      'member',
      0,
      now,
    );
}

function seedDefaultSettings(database: Database.Database): void {
  const now = new Date().toISOString();

  database
    .prepare(
      `
      INSERT INTO settings_kv (key, value, updated_at, updated_by)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(key) DO NOTHING
    `,
    )
    .run('system.mainAgentId', 'agent.main', now);
}

function createClawrocketSchema(database: Database.Database): void {
  // Run thread_id migration BEFORE the schema exec block, because the exec
  // block contains CREATE INDEX statements that reference the column.
  // For fresh databases the tables don't exist yet, so this is a no-op.
  migrateAddThreadIdColumns(database);

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
    CREATE INDEX IF NOT EXISTS idx_user_google_credentials_user_id ON user_google_credentials(user_id);

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

    CREATE TABLE IF NOT EXISTS llm_ttft_stats (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      p50_ms REAL NOT NULL DEFAULT 0,
      p95_ms REAL NOT NULL DEFAULT 0,
      p99_ms REAL NOT NULL DEFAULT 0,
      max_ms REAL NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS registered_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      tool_permissions_json TEXT NOT NULL,
      persona_role TEXT,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_registered_agents_enabled_name
      ON registered_agents(enabled, name);

    CREATE TABLE IF NOT EXISTS agent_fallback_steps (
      agent_id TEXT NOT NULL REFERENCES registered_agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      provider_id TEXT NOT NULL REFERENCES llm_providers(id),
      model_id TEXT NOT NULL,
      PRIMARY KEY (agent_id, position),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS data_connectors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connector_kind TEXT NOT NULL
        CHECK(connector_kind IN ('google_sheets', 'posthog')),
      config_json TEXT,
      discovered_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_data_connectors_kind_enabled
      ON data_connectors(connector_kind, enabled);

    CREATE TABLE IF NOT EXISTS data_connector_secrets (
      connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
      ciphertext TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS data_connector_verifications (
      connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
      status TEXT NOT NULL
        CHECK(status IN ('not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
      last_verified_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_connections (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      connection_mode TEXT NOT NULL,
      account_key TEXT NOT NULL,
      display_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      health_status TEXT NOT NULL DEFAULT 'healthy',
      last_health_check_at TEXT,
      last_health_error TEXT,
      config_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_connections_platform_account
      ON channel_connections(platform, account_key);

    CREATE TABLE IF NOT EXISTS channel_targets (
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      metadata_json TEXT,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (connection_id, target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_targets_connection_seen
      ON channel_targets(connection_id, last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS talk_folders (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_folders_owner_sort
      ON talk_folders(owner_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talks (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      folder_id TEXT REFERENCES talk_folders(id) ON DELETE SET NULL,
      topic_title TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active', 'paused', 'archived')),
      sort_order REAL NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talks_owner_folder_sort
      ON talks(owner_id, folder_id, sort_order, updated_at);

    CREATE TABLE IF NOT EXISTS talk_members (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('viewer', 'editor')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (talk_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_members_user_id ON talk_members(user_id);

    CREATE TABLE IF NOT EXISTS talk_messages (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      thread_id TEXT,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      run_id TEXT,
      sequence_in_run INTEGER,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_messages_talk_created_at
      ON talk_messages(talk_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_messages_thread_id
      ON talk_messages(thread_id);

    CREATE TABLE IF NOT EXISTS talk_message_attachments (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES talk_messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT NOT NULL,
      extracted_text TEXT,
      extraction_status TEXT NOT NULL DEFAULT 'pending'
        CHECK(extraction_status IN ('pending', 'ready', 'failed')),
      extraction_error TEXT,
      created_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_message_attachments_message_id
      ON talk_message_attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_talk_message_attachments_talk_created
      ON talk_message_attachments(talk_id, created_at);

    CREATE TABLE IF NOT EXISTS talk_context_summary (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      summary_text TEXT NOT NULL,
      covers_through_message_id TEXT REFERENCES talk_messages(id),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_context_goal (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      goal_text TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_context_rules (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      rule_text TEXT NOT NULL,
      sort_order REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_context_rules_talk_sort
      ON talk_context_rules(talk_id, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS talk_context_sources (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL
        CHECK(source_type IN ('url', 'file', 'text')),
      title TEXT,
      note TEXT,
      sort_order REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'ready', 'failed')),
      source_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      mime_type TEXT,
      storage_key TEXT,
      extracted_text TEXT,
      extracted_at TEXT,
      last_fetched_at TEXT,
      extraction_error TEXT,
      fetch_strategy TEXT
        CHECK(fetch_strategy IN ('http', 'browser', 'managed') OR fetch_strategy IS NULL),
      is_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_context_sources_talk_sort
      ON talk_context_sources(talk_id, sort_order, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_talk_context_sources_ref
      ON talk_context_sources(talk_id, source_ref);

    CREATE TABLE IF NOT EXISTS talk_context_source_ref_counter (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      next_ref_number INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS talk_agents (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      source_kind TEXT NOT NULL DEFAULT 'provider'
        CHECK(source_kind IN ('claude_default', 'provider')),
      provider_id TEXT,
      model_id TEXT,
      nickname TEXT,
      nickname_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(nickname_mode IN ('auto', 'custom')),
      persona_role TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_talk_agents_talk_sort
      ON talk_agents(talk_id, sort_order, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_agents_registered_agent_id
      ON talk_agents(registered_agent_id);

    CREATE TABLE IF NOT EXISTS talk_data_connectors (
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL REFERENCES data_connectors(id) ON DELETE CASCADE,
      attached_at TEXT NOT NULL,
      attached_by TEXT REFERENCES users(id),
      PRIMARY KEY (talk_id, connector_id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_data_connectors_connector
      ON talk_data_connectors(connector_id);

    CREATE TABLE IF NOT EXISTS talk_llm_policies (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      llm_policy TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_executor_sessions (
      talk_id TEXT PRIMARY KEY REFERENCES talks(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      executor_alias TEXT NOT NULL,
      executor_model TEXT NOT NULL,
      session_compat_key TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS talk_channel_bindings (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      display_name TEXT,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      allowed_senders_json TEXT,
      rate_limit_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_talk_channel_bindings_talk
      ON talk_channel_bindings(talk_id, active, created_at);

    CREATE TABLE IF NOT EXISTS talk_channel_policies (
      binding_id TEXT PRIMARY KEY REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      response_mode TEXT NOT NULL DEFAULT 'mentions'
        CHECK(response_mode IN ('off', 'mentions', 'all')),
      responder_mode TEXT NOT NULL DEFAULT 'primary'
        CHECK(responder_mode IN ('primary', 'agent')),
      responder_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'reply'
        CHECK(delivery_mode IN ('reply', 'channel')),
      thread_mode TEXT NOT NULL DEFAULT 'conversation'
        CHECK(thread_mode IN ('conversation')),
      channel_context_note TEXT,
      allowed_senders_json TEXT,
      inbound_rate_limit_per_minute INTEGER,
      max_pending_events INTEGER DEFAULT 20,
      overflow_policy TEXT NOT NULL DEFAULT 'drop_oldest'
        CHECK(overflow_policy IN ('drop_oldest', 'drop_newest')),
      max_deferred_age_minutes INTEGER DEFAULT 60,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS talk_runs (
      id TEXT PRIMARY KEY,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      requested_by TEXT NOT NULL REFERENCES users(id),
      status TEXT NOT NULL
        CHECK(status IN ('queued', 'running', 'awaiting_confirmation', 'cancelled', 'completed', 'failed')),
      trigger_message_id TEXT REFERENCES talk_messages(id),
      target_agent_id TEXT,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      executor_alias TEXT,
      executor_model TEXT,
      thread_id TEXT,
      idempotency_key TEXT,
      source_binding_id TEXT,
      source_external_message_id TEXT,
      source_thread_key TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      cancel_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_talk_runs_talk_id_status
      ON talk_runs(talk_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_talk_runs_status_created_at
      ON talk_runs(status, created_at);

    CREATE TABLE IF NOT EXISTS run_confirmations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      action_summary TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'approved', 'rejected')),
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_confirmations_run_status
      ON run_confirmations(run_id, status, created_at);

    CREATE TABLE IF NOT EXISTS llm_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      talk_id TEXT REFERENCES talks(id) ON DELETE CASCADE,
      agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      provider_id TEXT REFERENCES llm_providers(id) ON DELETE SET NULL,
      model_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK(status IN ('success', 'failed', 'skipped', 'cancelled')),
      failure_class TEXT,
      latency_ms INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      estimated_cost_usd REAL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_run_id ON llm_attempts(run_id);
    CREATE INDEX IF NOT EXISTS idx_llm_attempts_talk_id_created_at
      ON llm_attempts(talk_id, created_at);

    CREATE TABLE IF NOT EXISTS channel_ingress_queue (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES channel_connections(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      platform_event_id TEXT,
      external_message_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'deferred', 'processing', 'completed', 'dropped', 'dead_letter')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT NOT NULL UNIQUE,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_status_available
      ON channel_ingress_queue(status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_binding_status_available
      ON channel_ingress_queue(binding_id, status, available_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_ingress_queue_talk_status_available
      ON channel_ingress_queue(talk_id, status, available_at, created_at);

    CREATE TABLE IF NOT EXISTS channel_outbound_queue (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      binding_id TEXT NOT NULL REFERENCES talk_channel_bindings(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES talk_runs(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sent', 'failed', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      next_retry_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_queue_status_available
      ON channel_outbound_queue(status, next_retry_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbound_queue_binding_status
      ON channel_outbound_queue(binding_id, status, created_at);

    CREATE TABLE IF NOT EXISTS channel_delivery_outbox (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      run_id TEXT,
      talk_message_id TEXT,
      target_kind TEXT NOT NULL,
      target_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'sending', 'sent', 'failed', 'dead_letter', 'dropped')),
      reason_code TEXT,
      reason_detail TEXT,
      dedupe_key TEXT,
      available_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_channel_delivery_outbox_status
      ON channel_delivery_outbox(status, available_at);

    CREATE TABLE IF NOT EXISTS settings_kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL,
      updated_by TEXT REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      topic TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_outbox_topic_event_id
      ON event_outbox(topic, event_id);

    CREATE TABLE IF NOT EXISTS dead_letter_queue (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      payload TEXT,
      error_class TEXT NOT NULL,
      error_detail TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_retry_at TEXT,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letter_created_at
      ON dead_letter_queue(created_at);

    CREATE TABLE IF NOT EXISTS idempotency_cache (
      idempotency_key TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      PRIMARY KEY (idempotency_key, user_id, method, path)
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expires_at
      ON idempotency_cache(expires_at);
  `);

  // ---------------------------------------------------------------------------
  // Migrations for existing databases — MUST run before seeds, because seeds
  // reference columns that may not exist yet in older databases.
  // ---------------------------------------------------------------------------
  migrateTalkAgentsTable(database);
  migrateAddTtftSupport(database);
  migrateAddThreadIdColumns(database);
  migrateAddMissingColumns(database);

  seedBuiltinLlmProvider(database);
  seedAnthropicProvider(database);
  seedMainAgent(database);
  seedSystemUsers(database);
  seedDefaultSettings(database);
}

/**
 * Rebuild talk_agents to:
 *  - relax registered_agent_id from NOT NULL to nullable
 *  - add source_kind, provider_id, model_id, nickname, nickname_mode
 *
 * Idempotent: skips if the new columns already exist.
 */
function migrateTalkAgentsTable(database: Database.Database): void {
  // Check if migration is needed by looking for the source_kind column.
  const columns = database
    .prepare(`PRAGMA table_info(talk_agents)`)
    .all() as Array<{ name: string }>;
  const hasSourceKind = columns.some((c) => c.name === 'source_kind');
  if (hasSourceKind) return; // already migrated or fresh DB

  database.exec(`
    -- 1. Copy existing rows into a temp table
    CREATE TABLE talk_agents_migration_backup AS SELECT * FROM talk_agents;

    -- 2. Drop old table + indexes
    DROP TABLE talk_agents;

    -- 3. Recreate with new schema (matches the CREATE TABLE in createClawrocketSchema)
    CREATE TABLE talk_agents (
      id TEXT PRIMARY KEY,
      talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
      registered_agent_id TEXT REFERENCES registered_agents(id) ON DELETE SET NULL,
      source_kind TEXT NOT NULL DEFAULT 'provider'
        CHECK(source_kind IN ('claude_default', 'provider')),
      provider_id TEXT,
      model_id TEXT,
      nickname TEXT,
      nickname_mode TEXT NOT NULL DEFAULT 'auto'
        CHECK(nickname_mode IN ('auto', 'custom')),
      persona_role TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      sort_order REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_talk_agents_talk_sort
      ON talk_agents(talk_id, sort_order, created_at);
    CREATE INDEX idx_talk_agents_registered_agent_id
      ON talk_agents(registered_agent_id);

    -- 4. Copy old rows back, JOIN registered_agents to backfill
    --    provider_id, model_id, and nickname from the registered agent.
    INSERT INTO talk_agents (
      id, talk_id, registered_agent_id,
      source_kind, provider_id, model_id,
      nickname, nickname_mode,
      persona_role, is_primary, sort_order,
      created_at, updated_at
    )
    SELECT
      bak.id,
      bak.talk_id,
      bak.registered_agent_id,
      'provider',
      ra.provider_id,
      ra.model_id,
      ra.name,
      'auto',
      bak.persona_role,
      bak.is_primary,
      bak.sort_order,
      bak.created_at,
      bak.updated_at
    FROM talk_agents_migration_backup bak
    LEFT JOIN registered_agents ra ON ra.id = bak.registered_agent_id;

    -- 5. Clean up
    DROP TABLE talk_agents_migration_backup;
  `);
}

/**
 * Add adaptive TTFT timeout support:
 *  - default_ttft_timeout_ms column on llm_provider_models
 *  - llm_ttft_stats table for recording observed TTFT
 *
 * Idempotent: skips if the column already exists.
 */
function migrateAddTtftSupport(database: Database.Database): void {
  const columns = database
    .prepare(`PRAGMA table_info(llm_provider_models)`)
    .all() as Array<{ name: string }>;
  const hasTtft = columns.some((c) => c.name === 'default_ttft_timeout_ms');
  if (hasTtft) return; // already migrated or fresh DB

  database.exec(`
    ALTER TABLE llm_provider_models ADD COLUMN default_ttft_timeout_ms INTEGER;
  `);

  // llm_ttft_stats is created in createClawrocketSchema via IF NOT EXISTS,
  // but for existing DBs that ran schema creation before this table existed:
  database.exec(`
    CREATE TABLE IF NOT EXISTS llm_ttft_stats (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      sample_count INTEGER NOT NULL DEFAULT 0,
      p50_ms REAL NOT NULL DEFAULT 0,
      p95_ms REAL NOT NULL DEFAULT 0,
      p99_ms REAL NOT NULL DEFAULT 0,
      max_ms REAL NOT NULL DEFAULT 0,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id),
      FOREIGN KEY (provider_id, model_id)
        REFERENCES llm_provider_models(provider_id, model_id)
        ON DELETE CASCADE
    );
  `);

  // Seed sensible defaults for known Anthropic models
  database.exec(`
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 90000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%sonnet%';
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 180000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%opus%';
    UPDATE llm_provider_models SET default_ttft_timeout_ms = 30000
      WHERE provider_id = 'provider.anthropic' AND model_id LIKE '%haiku%';
  `);
}

/**
 * Add thread_id column to talk_messages and talk_runs for existing databases.
 * Fresh databases already have the column from the CREATE TABLE statement.
 * Idempotent: skips if the table doesn't exist yet OR the column already exists.
 */
function migrateAddThreadIdColumns(database: Database.Database): void {
  for (const table of ['talk_messages', 'talk_runs']) {
    const cols = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    // Table doesn't exist yet (fresh DB) — the CREATE TABLE will add it
    if (cols.length === 0) continue;
    // Column already present — nothing to do
    if (cols.some((c) => c.name === 'thread_id')) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN thread_id TEXT;`);
  }
}

/**
 * Generic catch-all migration for columns added to CREATE TABLE statements
 * after the user's database was first created.  `CREATE TABLE IF NOT EXISTS`
 * does NOT add new columns to existing tables, so we must ALTER them in.
 *
 * Each entry is { table, column, definition }.  Idempotent: skips if the
 * table doesn't exist yet (fresh DB) or the column already exists.
 *
 * Add new entries here whenever a column is added to an existing table's
 * CREATE TABLE statement.
 */
function migrateAddMissingColumns(database: Database.Database): void {
  const additions: Array<{
    table: string;
    column: string;
    definition: string;
  }> = [
    // registered_agents — columns added after initial schema
    {
      table: 'registered_agents',
      column: 'tool_permissions_json',
      definition: "TEXT NOT NULL DEFAULT '{}'",
    },
    {
      table: 'registered_agents',
      column: 'persona_role',
      definition: 'TEXT',
    },
    {
      table: 'registered_agents',
      column: 'system_prompt',
      definition: 'TEXT',
    },
  ];

  for (const { table, column, definition } of additions) {
    const cols = database
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // table doesn't exist yet
    if (cols.some((c) => c.name === column)) continue; // already present
    database.exec(
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`,
    );
  }
}

export function initClawrocketSchema(): void {
  createClawrocketSchema(getDb());
}

/** @internal - for tests only. */
export function _initClawrocketTestSchema(): void {
  createClawrocketSchema(getDb());
}
