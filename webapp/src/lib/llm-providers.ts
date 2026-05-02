// Frontend catalog of LLM providers usable by the Editorial Room.
//
// Mirrors the hermes-agent `HermesOverlay` shape (transport + auth pattern +
// base URL) but trimmed to the providers clawrocket actually wires up. The
// backend source-of-truth is `BUILTIN_ADDITIONAL_PROVIDERS` in
// `src/clawrocket/agents/builtin-additional-providers.ts` plus the dedicated
// Anthropic OAuth route; this catalog mirrors those provider IDs so the same
// `provider_id` is used end to end.
//
// NOTE: `provider.openai_codex` (host-login Codex CLI) is intentionally
// omitted — the Editorial Room reaches OpenAI subscriptions through the
// device-code flow on `provider.openai` instead.

export type ProviderTransport =
  | 'anthropic_messages'
  | 'openai_chat'
  | 'openai_responses';

export type ProviderAuthType =
  | 'oauth_anthropic'
  | 'oauth_openai_codex'
  | 'api_key';

export type ProviderEntry = {
  id: string;
  name: string;
  transport: ProviderTransport;
  baseUrl: string;
  authType: ProviderAuthType;
  // For OAuth providers, the existing /oauth/status endpoint that the card
  // polls. API-key providers rely on `GET /api/v1/agents` instead.
  oauthStatusEndpoint?: string;
  // Visible hint shown above the paste box for API-key cards.
  apiKeyHelp?: string;
};

export const PROVIDER_CATALOG: ReadonlyArray<ProviderEntry> = [
  {
    id: 'provider.anthropic',
    name: 'Claude (Anthropic)',
    transport: 'anthropic_messages',
    baseUrl: 'https://api.anthropic.com',
    authType: 'oauth_anthropic',
    oauthStatusEndpoint: '/api/v1/agents/providers/anthropic/oauth/status',
  },
  {
    id: 'provider.openai',
    name: 'ChatGPT (OpenAI)',
    transport: 'openai_responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    authType: 'oauth_openai_codex',
    oauthStatusEndpoint: '/api/v1/agents/providers/openai/oauth/status',
  },
  {
    id: 'provider.gemini',
    name: 'Gemini (Google)',
    transport: 'openai_chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authType: 'api_key',
    apiKeyHelp:
      'Paste a Google AI Studio API key (aistudio.google.com → Get API key).',
  },
  {
    id: 'provider.nvidia',
    name: 'NVIDIA NIM',
    transport: 'openai_chat',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authType: 'api_key',
    apiKeyHelp:
      'Paste an NVIDIA NIM key from build.nvidia.com (Manage API Keys).',
  },
];

// Fixture agent profiles use uppercase provider strings ('ANTHROPIC',
// 'OPENAI', 'GOOGLE', 'NVIDIA') for human readability. Map them back to the
// catalog provider IDs so the picker can correlate authed providers.
const FIXTURE_PROVIDER_TO_CATALOG_ID: Record<string, string> = {
  ANTHROPIC: 'provider.anthropic',
  OPENAI: 'provider.openai',
  GOOGLE: 'provider.gemini',
  GEMINI: 'provider.gemini',
  NVIDIA: 'provider.nvidia',
};

export function catalogIdForFixtureProvider(
  fixtureProvider: string,
): string | null {
  return FIXTURE_PROVIDER_TO_CATALOG_ID[fixtureProvider.toUpperCase()] ?? null;
}

export function getProviderEntry(id: string): ProviderEntry | null {
  return PROVIDER_CATALOG.find((p) => p.id === id) ?? null;
}
