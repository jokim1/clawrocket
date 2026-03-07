import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  duplicateRegisteredAgent,
  getDefaultRegisteredAgentId,
  getLlmProviderById,
  getProviderSecretByProviderId,
  getRegisteredAgentById,
  listKnownProviderCredentialCards,
  listRegisteredAgents,
  setDefaultRegisteredAgentId,
  setRegisteredAgentEnabled,
  updateRegisteredAgentName,
  upsertKnownProviderCredential,
} from '../../db/index.js';
import { ProviderCredentialsVerifier } from '../../agents/provider-credentials-verifier.js';
import type {
  AgentProviderCardSnapshot,
  RegisteredAgentSnapshot,
} from '../../db/llm-accessors.js';
import type { LlmAuthScheme, ProviderSecretPayload } from '../../llm/types.js';
import { ApiEnvelope, AuthContext } from '../types.js';

function canManageAgents(auth: AuthContext): boolean {
  return auth.role === 'owner' || auth.role === 'admin';
}

export interface AiAgentsPageRecord {
  defaultRegisteredAgentId: string | null;
  providers: AgentProviderCardSnapshot[];
  registeredAgents: RegisteredAgentSnapshot[];
  onboardingRequired: boolean;
}

function buildAgentsSnapshot(): AiAgentsPageRecord {
  const registeredAgents = listRegisteredAgents();
  return {
    defaultRegisteredAgentId: getDefaultRegisteredAgentId(),
    providers: listKnownProviderCredentialCards(),
    registeredAgents,
    onboardingRequired: registeredAgents.length === 0,
  };
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

    const verified = credential
      ? await input.verifier.verify(provider.id)
      : provider;

    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          provider: verified,
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

export function createRegisteredAgentRoute(input: {
  auth: AuthContext;
  name: string;
  providerId: string;
  modelId: string;
  modelDisplayName?: string | null;
  setAsDefault?: boolean;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    agent: RegisteredAgentSnapshot;
    defaultRegisteredAgentId: string | null;
  }>;
} {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to create AI agents.',
        },
      },
    };
  }

  const provider = getLlmProviderById(input.providerId);
  if (!provider) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'provider_not_found',
          message: 'Provider is not configured.',
        },
      },
    };
  }
  if (!getProviderSecretByProviderId(input.providerId)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'provider_missing_credential',
          message:
            'Configure the provider credential before creating an agent.',
        },
      },
    };
  }

  try {
    const agent = createRegisteredAgent({
      name: input.name,
      providerId: input.providerId,
      modelId: input.modelId,
      modelDisplayName: input.modelDisplayName || undefined,
      updatedBy: input.auth.userId,
      setAsDefault: input.setAsDefault,
    });
    return {
      statusCode: 201,
      body: {
        ok: true,
        data: {
          agent,
          defaultRegisteredAgentId: getDefaultRegisteredAgentId(),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'registered_agent_create_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to create AI agent.',
        },
      },
    };
  }
}

export function updateRegisteredAgentRoute(input: {
  auth: AuthContext;
  agentId: string;
  name?: string;
  enabled?: boolean;
  setAsDefault?: boolean;
}): {
  statusCode: number;
  body: ApiEnvelope<{
    agent: RegisteredAgentSnapshot;
    defaultRegisteredAgentId: string | null;
  }>;
} {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to update AI agents.',
        },
      },
    };
  }

  const existing = getRegisteredAgentById(input.agentId);
  if (!existing) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'agent_not_found', message: 'AI agent not found.' },
      },
    };
  }

  let agent: RegisteredAgentSnapshot | null = null;
  try {
    if (typeof input.name === 'string' && input.name.trim()) {
      agent = updateRegisteredAgentName(input.agentId, input.name, undefined);
    }
    if (typeof input.enabled === 'boolean') {
      agent = setRegisteredAgentEnabled(
        input.agentId,
        input.enabled,
        undefined,
      );
    }
    if (!agent) {
      agent =
        listRegisteredAgents().find((entry) => entry.id === input.agentId) ||
        null;
    }
    if (!agent) {
      throw new Error('AI agent not found after update.');
    }
    if (input.setAsDefault) {
      setDefaultRegisteredAgentId(agent.id, input.auth.userId);
    }
    return {
      statusCode: 200,
      body: {
        ok: true,
        data: {
          agent,
          defaultRegisteredAgentId: getDefaultRegisteredAgentId(),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'registered_agent_update_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to update AI agent.',
        },
      },
    };
  }
}

export function duplicateRegisteredAgentRoute(input: {
  auth: AuthContext;
  sourceAgentId: string;
  name: string;
  providerId: string;
  modelId: string;
  modelDisplayName?: string | null;
}): {
  statusCode: number;
  body: ApiEnvelope<{ agent: RegisteredAgentSnapshot }>;
} {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to duplicate AI agents.',
        },
      },
    };
  }

  const existing = getRegisteredAgentById(input.sourceAgentId);
  if (!existing) {
    return {
      statusCode: 404,
      body: {
        ok: false,
        error: { code: 'agent_not_found', message: 'AI agent not found.' },
      },
    };
  }

  try {
    const agent = duplicateRegisteredAgent({
      sourceAgentId: input.sourceAgentId,
      name: input.name,
      providerId: input.providerId,
      modelId: input.modelId,
      modelDisplayName: input.modelDisplayName || undefined,
      updatedBy: input.auth.userId,
    });
    return { statusCode: 201, body: { ok: true, data: { agent } } };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'registered_agent_duplicate_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to duplicate AI agent.',
        },
      },
    };
  }
}

export function deleteRegisteredAgentRoute(input: {
  auth: AuthContext;
  agentId: string;
}): { statusCode: number; body: ApiEnvelope<{ deleted: true }> } {
  if (!canManageAgents(input.auth)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to delete AI agents.',
        },
      },
    };
  }
  try {
    deleteRegisteredAgent(input.agentId);
    return {
      statusCode: 200,
      body: { ok: true, data: { deleted: true } },
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'registered_agent_delete_failed',
          message:
            error instanceof Error
              ? error.message
              : 'Failed to delete AI agent.',
        },
      },
    };
  }
}
