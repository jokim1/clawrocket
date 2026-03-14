import {
  getDefaultClaudeModelId,
  listAdditionalProviderCredentialCards,
  listClaudeModelSuggestions,
  setDefaultClaudeModelId,
  upsertProviderVerification,
  upsertKnownProviderCredential,
} from '../../db/index.js';
import { ProviderCredentialsVerifier } from '../../agents/provider-credentials-verifier.js';
import type { AgentProviderCardSnapshot } from '../../db/llm-accessors.js';
import type { LlmAuthScheme, ProviderSecretPayload } from '../../llm/types.js';
import { ApiEnvelope, AuthContext } from '../types.js';

function canManageAgents(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

export interface AiAgentsPageRecord {
  defaultClaudeModelId: string;
  claudeModelSuggestions: Array<{
    modelId: string;
    displayName: string;
    contextWindowTokens: number;
    defaultMaxOutputTokens: number;
    supportsTools: boolean;
  }>;
  additionalProviders: AgentProviderCardSnapshot[];
}

function buildAgentsSnapshot(): AiAgentsPageRecord {
  return {
    defaultClaudeModelId: getDefaultClaudeModelId(),
    claudeModelSuggestions: listClaudeModelSuggestions(),
    additionalProviders: listAdditionalProviderCredentialCards(),
  };
}

function getProviderCard(providerId: string): AgentProviderCardSnapshot {
  const provider = listAdditionalProviderCredentialCards().find(
    (entry) => entry.id === providerId,
  );
  if (!provider) {
    throw new Error(`provider card not found: ${providerId}`);
  }
  return provider;
}

export function getAiAgentsRoute(input: { auth: AuthContext }): {
  statusCode: number;
  body: ApiEnvelope<AiAgentsPageRecord>;
} {
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildAgentsSnapshot(),
    },
  };
}

export function updateDefaultClaudeModelRoute(input: {
  auth: AuthContext;
  modelId: string;
}): {
  statusCode: number;
  body: ApiEnvelope<AiAgentsPageRecord>;
} {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message:
            'You do not have permission to update the default Claude model.',
        },
      },
    };
  }

  if (!input.modelId.trim()) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_model',
          message: 'A Claude model is required.',
        },
      },
    };
  }

  setDefaultClaudeModelId(input.modelId.trim(), input.auth.userId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: buildAgentsSnapshot(),
    },
  };
}

export function saveAiProviderCredentialRoute(input: {
  auth: AuthContext;
  providerId: string;
  apiKey?: string | null;
  organizationId?: string | null;
  baseUrl?: string | null;
  authScheme?: LlmAuthScheme;
  verifier: ProviderCredentialsVerifier;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCardSnapshot }>;
}> {
  return (async () => {
    if (!canManageAgents(input.auth)) {
      return {
        statusCode: 403,
        body: {
          ok: false,
          error: {
            code: 'forbidden',
            message:
              'You do not have permission to manage provider credentials.',
          },
        },
      };
    }

    const credential =
      input.apiKey && input.apiKey.trim()
        ? ({
            apiKey: input.apiKey.trim(),
            ...(input.organizationId?.trim()
              ? { organizationId: input.organizationId.trim() }
              : {}),
          } satisfies ProviderSecretPayload)
        : null;

    const provider = upsertKnownProviderCredential({
      providerId: input.providerId,
      credential,
      baseUrl: input.baseUrl,
      authScheme: input.authScheme,
      updatedBy: input.auth.userId,
    });

    let responseProvider = provider;
    if (credential) {
      upsertProviderVerification({
        providerId: provider.id,
        status: 'verifying',
        lastVerifiedAt: provider.lastVerifiedAt,
        lastError: null,
      });

      // Persist first, then verify in the background so a slow provider probe
      // does not make the save itself look broken in the UI.
      void input.verifier.verify(provider.id).catch(() => undefined);
      responseProvider = getProviderCard(provider.id);
    }

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          provider: responseProvider,
        },
      },
    };
  })();
}

export async function verifyAiProviderCredentialRoute(input: {
  auth: AuthContext;
  providerId: string;
  verifier: ProviderCredentialsVerifier;
}): Promise<{
  statusCode: number;
  body: ApiEnvelope<{ provider: AgentProviderCardSnapshot }>;
}> {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to verify provider credentials.',
        },
      },
    };
  }

  const provider = await input.verifier.verify(input.providerId);
  return {
    statusCode: 200,
    body: {
      ok: true,
      data: { provider },
    },
  };
}
