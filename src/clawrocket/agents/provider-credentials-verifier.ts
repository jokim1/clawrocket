import { setTimeout as delay } from 'node:timers/promises';

import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import {
  getLlmProviderById,
  getProviderVerificationByProviderId,
  getProviderSecretByProviderId,
  listKnownProviderCredentialCards,
  upsertProviderVerification,
} from '../db/index.js';
import type { AgentProviderCardSnapshot } from '../db/llm-accessors.js';
import type { LlmProviderRecord, ProviderSecretPayload } from '../llm/types.js';

const DEFAULT_VERIFY_TIMEOUT_MS = 5_000;
const NVIDIA_VERIFY_TIMEOUT_MS = 15_000;
const NVIDIA_MAX_ATTEMPTS = 2;

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

type VerificationRequest = {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
  headers?: Record<string, string>;
};

function buildVerificationRequest(
  provider: LlmProviderRecord,
): VerificationRequest {
  if (provider.provider_kind === 'nvidia') {
    return {
      url: joinUrl(provider.base_url, '/chat/completions'),
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'moonshotai/kimi-k2.5',
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 16,
        temperature: 1.0,
        top_p: 1.0,
        stream: false,
      }),
    };
  }

  switch (provider.api_format) {
    case 'anthropic_messages':
      return {
        url: joinUrl(provider.base_url, '/v1/models'),
        method: 'GET',
      };
    case 'openai_chat_completions':
      return {
        url: joinUrl(provider.base_url, '/models'),
        method: 'GET',
      };
    default:
      return {
        url: provider.base_url,
        method: 'GET',
      };
  }
}

export class ProviderCredentialsVerifier {
  private readonly fetchImpl: typeof fetch;
  private readonly inFlight = new Map<
    string,
    Promise<AgentProviderCardSnapshot>
  >();

  constructor(input?: { fetchImpl?: typeof fetch }) {
    this.fetchImpl = input?.fetchImpl || fetch;
  }

  verify(providerId: string): Promise<AgentProviderCardSnapshot> {
    const existing = this.inFlight.get(providerId);
    if (existing) {
      return existing;
    }

    const task = this.verifyInternal(providerId).finally(() => {
      this.inFlight.delete(providerId);
    });
    this.inFlight.set(providerId, task);
    return task;
  }

  private async verifyInternal(
    providerId: string,
  ): Promise<AgentProviderCardSnapshot> {
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

    const currentVerification = getProviderVerificationByProviderId(providerId);
    upsertProviderVerification({
      providerId,
      status: 'verifying',
      lastVerifiedAt: currentVerification?.last_verified_at ?? null,
      lastError: null,
    });

    const secret = decryptProviderSecret(secretRecord.ciphertext);
    const request = buildVerificationRequest(provider);
    const timeoutMs =
      provider.provider_kind === 'nvidia'
        ? NVIDIA_VERIFY_TIMEOUT_MS
        : DEFAULT_VERIFY_TIMEOUT_MS;
    const maxAttempts =
      provider.provider_kind === 'nvidia' ? NVIDIA_MAX_ATTEMPTS : 1;
    let finalStatus: 'verified' | 'invalid' | 'unavailable' = 'unavailable';
    let finalError: string | null = `${provider.name} verification failed.`;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort('provider_verify_timeout'),
        timeoutMs,
      );

      try {
        const response = await this.fetchImpl(request.url, {
          method: request.method,
          headers: {
            ...buildHeaders(provider, secret),
            ...(request.headers || {}),
          },
          body: request.body,
          signal: controller.signal,
        });

        if (response.ok) {
          finalStatus = 'verified';
          finalError = null;
          break;
        }

        if (response.status === 401 || response.status === 403) {
          finalStatus = 'invalid';
          finalError = `Credential rejected by ${provider.name}.`;
          break;
        }

        finalStatus = 'unavailable';
        finalError = `${provider.name} verification failed with HTTP ${response.status}.`;
        if (
          provider.provider_kind === 'nvidia' &&
          attempt < maxAttempts &&
          response.status >= 500
        ) {
          await delay(500);
          continue;
        }
        break;
      } catch (error) {
        finalStatus = 'unavailable';
        finalError =
          error instanceof Error && error.name === 'AbortError'
            ? `${provider.name} verification timed out.`
            : error instanceof Error
              ? error.message
              : `${provider.name} verification failed.`;

        if (provider.provider_kind === 'nvidia' && attempt < maxAttempts) {
          await delay(500);
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    upsertProviderVerification({
      providerId,
      status: finalStatus,
      lastVerifiedAt: new Date().toISOString(),
      lastError: finalError,
    });

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
