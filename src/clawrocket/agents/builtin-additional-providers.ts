export type BuiltinAdditionalProviderKind = 'openai' | 'gemini' | 'nvidia';

export interface BuiltinAdditionalProviderModel {
  modelId: string;
  displayName: string;
  contextWindowTokens: number;
  defaultMaxOutputTokens: number;
  defaultTtftTimeoutMs: number;
}

export interface BuiltinAdditionalProvider {
  id: string;
  name: string;
  providerKind: BuiltinAdditionalProviderKind;
  apiFormat: 'openai_chat_completions';
  baseUrl: string;
  authScheme: 'bearer';
  responseStartTimeoutMs: number;
  streamIdleTimeoutMs: number;
  absoluteTimeoutMs: number;
  models: BuiltinAdditionalProviderModel[];
}

export const BUILTIN_ADDITIONAL_PROVIDERS: BuiltinAdditionalProvider[] = [
  {
    id: 'provider.openai',
    name: 'OpenAI',
    providerKind: 'openai',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    responseStartTimeoutMs: 60_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'gpt-5-mini',
        displayName: 'GPT-5 Mini',
        contextWindowTokens: 128_000,
        defaultMaxOutputTokens: 4_096,
        defaultTtftTimeoutMs: 30_000,
      },
    ],
  },
  {
    id: 'provider.gemini',
    name: 'Google / Gemini',
    providerKind: 'gemini',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    authScheme: 'bearer',
    responseStartTimeoutMs: 90_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'gemini-2.5-flash',
        displayName: 'Gemini 2.5 Flash',
        contextWindowTokens: 1_000_000,
        defaultMaxOutputTokens: 8_192,
        defaultTtftTimeoutMs: 45_000,
      },
    ],
  },
  {
    id: 'provider.nvidia',
    name: 'NVIDIA Kimi2.5',
    providerKind: 'nvidia',
    apiFormat: 'openai_chat_completions',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    authScheme: 'bearer',
    responseStartTimeoutMs: 90_000,
    streamIdleTimeoutMs: 20_000,
    absoluteTimeoutMs: 300_000,
    models: [
      {
        modelId: 'moonshotai/kimi-k2.5',
        displayName: 'Kimi 2.5 (NVIDIA)',
        contextWindowTokens: 262_144,
        defaultMaxOutputTokens: 16_384,
        defaultTtftTimeoutMs: 60_000,
      },
    ],
  },
];

export const BUILTIN_ADDITIONAL_PROVIDER_IDS = BUILTIN_ADDITIONAL_PROVIDERS.map(
  (provider) => provider.id,
);
