export type LlmApiFormat = 'anthropic_messages' | 'openai_chat_completions';

export type LlmCoreCompatibility = 'none' | 'claude_sdk_proxy';

export type LlmAuthScheme = 'x_api_key' | 'bearer';

export type LlmProviderKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'deepseek'
  | 'kimi'
  | 'nvidia'
  | 'custom';

export interface LlmProviderRecord {
  id: string;
  name: string;
  provider_kind: LlmProviderKind;
  api_format: LlmApiFormat;
  base_url: string;
  auth_scheme: LlmAuthScheme;
  enabled: number;
  core_compatibility: LlmCoreCompatibility;
  response_start_timeout_ms: number | null;
  stream_idle_timeout_ms: number | null;
  absolute_timeout_ms: number | null;
  updated_at: string;
  updated_by: string | null;
}

export interface LlmProviderModelRecord {
  provider_id: string;
  model_id: string;
  display_name: string;
  context_window_tokens: number;
  default_max_output_tokens: number;
  supports_tools: number;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export interface LlmProviderSecretRecord {
  provider_id: string;
  ciphertext: string;
  updated_at: string;
  updated_by: string | null;
}

export type LlmProviderVerificationStatus =
  | 'missing'
  | 'not_verified'
  | 'verifying'
  | 'verified'
  | 'invalid'
  | 'unavailable';

export interface LlmProviderVerificationRecord {
  provider_id: string;
  status: LlmProviderVerificationStatus;
  last_verified_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export interface TalkRouteRecord {
  id: string;
  name: string;
  enabled: number;
  updated_at: string;
  updated_by: string | null;
}

export interface TalkRouteStepRecord {
  route_id: string;
  position: number;
  provider_id: string;
  model_id: string;
}

export type TalkPersonaRole =
  | 'assistant'
  | 'analyst'
  | 'critic'
  | 'strategist'
  | 'devils-advocate'
  | 'synthesizer'
  | 'editor';

export type TalkAgentSourceKind = 'claude_default' | 'provider';
export type TalkAgentNicknameMode = 'auto' | 'custom';

export interface TalkAgentRecord {
  id: string;
  talk_id: string;
  name: string;
  nickname_mode: TalkAgentNicknameMode;
  source_kind: TalkAgentSourceKind;
  persona_role: TalkPersonaRole;
  route_id: string;
  registered_agent_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  is_primary: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface RegisteredAgentRecord {
  id: string;
  name: string;
  provider_id: string;
  model_id: string;
  route_id: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export type LlmAttemptStatus = 'success' | 'failed' | 'skipped' | 'cancelled';

export type LlmFailureClass =
  | 'timeout'
  | 'network'
  | 'upstream_5xx'
  | 'retryable_429'
  | 'quota_exhausted'
  | 'auth'
  | 'configuration'
  | 'invalid_request'
  | 'policy'
  | 'unknown';

export interface LlmAttemptRecord {
  id: number;
  run_id: string;
  talk_id: string;
  agent_id: string | null;
  route_id: string | null;
  route_step_position: number | null;
  provider_id: string | null;
  model_id: string | null;
  status: LlmAttemptStatus;
  failure_class: LlmFailureClass | null;
  latency_ms: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  created_at: string;
}

export interface TalkRouteUsageCounts {
  assignedAgentCount: number;
  assignedTalkCount: number;
}

// ProviderSecretPayload — what gets encrypted in `LlmProviderSecretRecord`.
// Discriminated union so we can store API keys (current behavior) plus
// subscription-OAuth credentials (Anthropic Claude.ai login, OpenAI Codex
// CLI piggyback) without forking the storage layer.
//
// Backwards compatibility: existing rows in the DB encrypted before this
// change have shape `{ apiKey, organizationId? }` with no `kind` field.
// `decryptProviderSecret` treats a missing `kind` as `'api_key'` so old
// rows decode without re-encryption.
export type ProviderSecretPayload =
  | ProviderApiKeySecret
  | ProviderAnthropicOAuthSecret
  | ProviderOpenaiCodexSecret;

export interface ProviderApiKeySecret {
  kind: 'api_key';
  apiKey: string;
  organizationId?: string;
}

export interface ProviderAnthropicOAuthSecret {
  kind: 'anthropic_oauth';
  accessToken: string;
  refreshToken: string;
  // ISO-8601 instant when the access token expires.
  expiresAt: string;
  // The Claude Code CLI version we sent on the originating User-Agent.
  // Anthropic gates oauth-routed requests on a recent CLI version; we record
  // the value so refreshes mirror it.
  claudeCodeVersion?: string;
}

export interface ProviderOpenaiCodexSecret {
  kind: 'openai_codex';
  accessToken: string;
  refreshToken?: string;
  // Account ID returned by Codex CLI's auth.json.
  accountId?: string;
  // ISO-8601; optional because Codex CLI's auth.json doesn't always include it.
  expiresAt?: string;
}
