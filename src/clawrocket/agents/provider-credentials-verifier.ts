import {
  decryptProviderSecret,
} from '../llm/provider-secret-store.js';
import {
  getLlmProviderById,
  getProviderSecretByProviderId,
  listKnownProviderCredentialCards,
  upsertProviderVerification,
} from '../db/index.js';
import type { AgentProviderCardSnapshot } from '../db/llm-accessors.js';
import type { LlmProviderRecord, ProviderSecretPayload } from '../llm/types.js';

const VERIFY_TIMEOUT_MS = 5_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function buildHeaders(
  provider: LlmProviderRecord,
  secret: ProviderSecretPayload,
): Record<string, string> {
  if (provider.auth_scheme === 'x_api_key') {
    return {
      'x-api-key': secret.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  return {
    authorization: `Bearer ${secret.apiKey}`,
    ...(secret.organizationId
      ? { 'openai-organization': secret.organizationId }
      : {}),
  };
}

function verificationEndpoint(provider: LlmProviderRecord): string {
  switch (provider.api_format) {
    case 'anthropic_messages':
      return joinUrl(provider.base_url, '/v1/models');
    case 'openai_chat_completions':
      return joinUrl(provider.base_url, '/models');
    default:
      return provider.base_url;
  }
}

export class ProviderCredentialsVerifier {
  private readonly fetchImpl: typeof fetch;

  constructor(input?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = input?.fetchImpl || fetch;
  }

  async verify(providerId: string): Promise<AgentProviderCardSnapshot> {
    const provider = getLlmProviderById(providerId);
    if (!provider) {
      throw new Error(`provider not found: ${providerId}`);
    }

    const secretRecord = getProviderSecretByProviderId(providerId);
    if (!secretRecord) {
      upsertProviderVerification({
        providerId,
        status: 'missing',
        lastVerifiedAt: null,
        lastError: null,
      });
      return this.getCard(providerId);
    }

    if (provider.base_url.startsWith('mock://')) {
      upsertProviderVerification({
        providerId,
        status: 'verified',
        lastVerifiedAt: new Date().toISOString(),
        lastError: null,
      });
      return this.getCard(providerId);
    }

    const secret = decryptProviderSecret(secretRecord.ciphertext);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('provider_verify_timeout'), VERIFY_TIMEOUT_MS);

    try {
      const response = await this.fetchImpl(verificationEndpoint(provider), {
        method: 'GET',
        headers: buildHeaders(provider, secret),
        signal: controller.signal,
      });

      if (response.ok) {
        upsertProviderVerification({
          providerId,
          status: 'verified',
          lastVerifiedAt: new Date().toISOString(),
          lastError: null,
        });
      } else if (response.status === 401 || response.status === 403) {
        const message = `Credential rejected by ${provider.name}.`;
        upsertProviderVerification({
          providerId,
          status: 'invalid',
          lastVerifiedAt: new Date().toISOString(),
          lastError: message,
        });
      } else {
        const message = `${provider.name} verification failed with HTTP ${response.status}.`;
        upsertProviderVerification({
          providerId,
          status: 'unavailable',
          lastVerifiedAt: new Date().toISOString(),
          lastError: message,
        });
      }
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? `${provider.name} verification timed out.`
          : error instanceof Error
            ? error.message
            : `${provider.name} verification failed.`;
      upsertProviderVerification({
        providerId,
        status: 'unavailable',
        lastVerifiedAt: new Date().toISOString(),
        lastError: message,
      });
    } finally {
      clearTimeout(timer);
    }

    return this.getCard(providerId);
  }

  private getCard(providerId: string): AgentProviderCardSnapshot {
    const card = listKnownProviderCredentialCards().find(
      (entry) => entry.id === providerId,
    );
    if (!card) {
      throw new Error(`provider card not found: ${providerId}`);
    }
    return card;
  }
}
