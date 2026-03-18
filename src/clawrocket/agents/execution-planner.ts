import { getDb } from '../../db.js';
import {
  getEffectiveToolsForAgent,
  type EffectiveToolAccess,
  type RegisteredAgentRecord,
} from '../db/agent-accessors.js';
import { getSettingValue } from '../db/accessors.js';
import { decryptProviderSecret } from '../llm/provider-secret-store.js';
import type { LlmProviderRecord } from '../llm/types.js';
import {
  resolveExecution,
  type ExecutionBinding,
  type ExecutionResolverError,
} from './execution-resolver.js';
import {
  TALK_EXECUTOR_ANTHROPIC_API_KEY,
  TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN,
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN,
} from '../config.js';

export const EXECUTOR_MAIN_PROJECT_PATH_KEY = 'executor.mainProjectPath';

export type ExecutionBackend = 'direct_http' | 'container';
export type ExecutionRouteReason = 'normal' | 'subscription_fallback';

export interface ContainerCredentialConfig {
  authMode: 'api_key' | 'subscription';
  secrets: Record<string, string>;
}

export interface DirectHttpExecutionPlan {
  backend: 'direct_http';
  routeReason: 'normal';
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  binding: ExecutionBinding;
}

export interface ContainerExecutionPlan {
  backend: 'container';
  routeReason: ExecutionRouteReason;
  effectiveTools: EffectiveToolAccess[];
  providerId: string;
  modelId: string;
  heavyToolFamilies: string[];
  containerCredential: ContainerCredentialConfig;
}

export type ExecutionPlan = DirectHttpExecutionPlan | ContainerExecutionPlan;

export class ExecutionPlannerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'CONTAINER_BROWSER_REQUIRES_SHELL'
      | 'CONTAINER_PROVIDER_INCOMPATIBLE'
      | 'CONTAINER_CREDENTIAL_MISSING'
      | 'DIRECT_EXECUTION_UNAVAILABLE',
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExecutionPlannerError';
  }
}

const BASE_CONTAINER_ALLOWED_TOOLS = [
  'Task',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'TodoWrite',
  'ToolSearch',
  'Skill',
  'NotebookEdit',
] as const;

function getProviderRecord(providerId: string): LlmProviderRecord | undefined {
  return getDb()
    .prepare(`SELECT * FROM llm_providers WHERE id = ? LIMIT 1`)
    .get(providerId) as LlmProviderRecord | undefined;
}

function getAnthropicApiKeyFromDb(): string | null {
  const row = getDb()
    .prepare(
      `SELECT ciphertext FROM llm_provider_secrets WHERE provider_id = 'provider.anthropic' LIMIT 1`,
    )
    .get() as { ciphertext: string } | undefined;
  if (!row?.ciphertext) {
    return null;
  }

  try {
    return decryptProviderSecret(row.ciphertext).apiKey.trim();
  } catch {
    return null;
  }
}

function getConfiguredExecutorAuthMode():
  | 'subscription'
  | 'api_key'
  | 'advanced_bearer'
  | 'none'
  | null {
  const mode = getSettingValue('executor.authMode')?.trim() || '';
  if (
    mode === 'subscription' ||
    mode === 'api_key' ||
    mode === 'advanced_bearer' ||
    mode === 'none'
  ) {
    return mode;
  }
  return null;
}

export function resolveContainerCredential(input?: {
  preferredAuthMode?: 'api_key' | 'subscription';
}): ContainerCredentialConfig {
  const configuredAuthMode = getConfiguredExecutorAuthMode() || undefined;
  const dbOauth = getSettingValue('executor.claudeOauthToken')?.trim() || null;
  const dbAuth = getSettingValue('executor.anthropicAuthToken')?.trim() || null;
  const envOauth = TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.trim() || null;
  const envAuth = TALK_EXECUTOR_ANTHROPIC_AUTH_TOKEN.trim() || null;
  const apiKey = getAnthropicApiKeyFromDb() || TALK_EXECUTOR_ANTHROPIC_API_KEY;
  const normalizedApiKey = apiKey?.trim() || null;

  const inferredAuthMode =
    input?.preferredAuthMode ||
    configuredAuthMode ||
    (normalizedApiKey
      ? 'api_key'
      : dbOauth || envOauth || dbAuth || envAuth
        ? 'subscription'
        : 'none');

  if (inferredAuthMode === 'api_key') {
    if (!normalizedApiKey) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an Anthropic API key in executor settings or env.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'api_key',
      secrets: {
        ANTHROPIC_API_KEY: normalizedApiKey,
      },
    };
  }

  if (inferredAuthMode === 'subscription') {
    const secrets: Record<string, string> = {};
    const oauthToken = dbOauth || envOauth;
    if (oauthToken) {
      secrets.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    }
    const authToken = dbAuth || envAuth;
    if (authToken) {
      secrets.ANTHROPIC_AUTH_TOKEN = authToken;
    }
    if (Object.keys(secrets).length === 0) {
      throw new ExecutionPlannerError(
        'Claude container execution requires an executor OAuth/auth token when subscription mode is selected.',
        'CONTAINER_CREDENTIAL_MISSING',
      );
    }
    return {
      authMode: 'subscription',
      secrets,
    };
  }

  throw new ExecutionPlannerError(
    'Container execution is not configured. Set executor Claude credentials before routing heavy-tool agents to the container backend.',
    'CONTAINER_CREDENTIAL_MISSING',
  );
}

function resolveHeavyToolFamilies(
  effectiveTools: EffectiveToolAccess[],
): string[] {
  const enabled = new Set(
    effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );

  if (enabled.has('browser') && !enabled.has('shell')) {
    throw new ExecutionPlannerError(
      'Browser execution in Phase 5A requires shell to be enabled for the same agent.',
      'CONTAINER_BROWSER_REQUIRES_SHELL',
      { requiredToolFamily: 'shell', blockingToolFamily: 'browser' },
    );
  }

  const heavyFamilies: string[] = [];
  if (enabled.has('shell')) heavyFamilies.push('shell');
  if (enabled.has('filesystem')) heavyFamilies.push('filesystem');
  if (enabled.has('browser') && enabled.has('shell'))
    heavyFamilies.push('browser');
  return heavyFamilies;
}

function isContainerCompatibleProvider(
  provider: LlmProviderRecord | undefined,
): boolean {
  return Boolean(
    provider &&
    provider.api_format === 'anthropic_messages' &&
    provider.core_compatibility === 'claude_sdk_proxy',
  );
}

export function getContainerAllowedTools(input: {
  effectiveTools: EffectiveToolAccess[];
  includeConnectorTools?: boolean;
}): string[] {
  const enabled = new Set(
    input.effectiveTools
      .filter((tool) => tool.enabled)
      .map((tool) => tool.toolFamily),
  );
  const allowed = new Set<string>(BASE_CONTAINER_ALLOWED_TOOLS);

  if (enabled.has('shell')) {
    allowed.add('Bash');
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
  }

  if (enabled.has('filesystem')) {
    allowed.add('Read');
    allowed.add('Glob');
    allowed.add('Grep');
    allowed.add('Write');
    allowed.add('Edit');
  }

  if (enabled.has('web')) {
    allowed.add('WebSearch');
    allowed.add('WebFetch');
  }

  if (input.includeConnectorTools) {
    allowed.add('mcp__nanoclaw__*');
  }

  return Array.from(allowed);
}

export function planExecution(
  agent: RegisteredAgentRecord,
  userId: string,
): ExecutionPlan {
  const effectiveTools = getEffectiveToolsForAgent(agent.id, userId);
  const heavyToolFamilies = resolveHeavyToolFamilies(effectiveTools);
  const provider = getProviderRecord(agent.provider_id);
  const configuredAuthMode = getConfiguredExecutorAuthMode();

  if (
    heavyToolFamilies.length === 0 &&
    agent.provider_id === 'provider.anthropic' &&
    isContainerCompatibleProvider(provider) &&
    configuredAuthMode === 'subscription'
  ) {
    return {
      backend: 'container',
      routeReason: 'normal',
      effectiveTools,
      providerId: agent.provider_id,
      modelId: agent.model_id,
      heavyToolFamilies: [],
      containerCredential: resolveContainerCredential({
        preferredAuthMode: 'subscription',
      }),
    };
  }

  if (heavyToolFamilies.length === 0) {
    try {
      const binding = resolveExecution(agent);
      return {
        backend: 'direct_http',
        routeReason: 'normal',
        effectiveTools,
        providerId: agent.provider_id,
        modelId: agent.model_id,
        binding,
      };
    } catch (error) {
      const resolverError = error as ExecutionResolverError;
      if (
        resolverError?.code === 'ANTHROPIC_REQUIRES_API_KEY' &&
        isContainerCompatibleProvider(provider) &&
        configuredAuthMode !== 'api_key'
      ) {
        let containerCredential: ContainerCredentialConfig | null = null;
        try {
          containerCredential = resolveContainerCredential({
            preferredAuthMode: 'subscription',
          });
        } catch {
          containerCredential = null;
        }

        if (containerCredential) {
          return {
            backend: 'container',
            routeReason: 'subscription_fallback',
            effectiveTools,
            providerId: agent.provider_id,
            modelId: agent.model_id,
            heavyToolFamilies: [],
            containerCredential,
          };
        }
      }

      throw new ExecutionPlannerError(
        resolverError.message || 'Direct execution is unavailable.',
        'DIRECT_EXECUTION_UNAVAILABLE',
        {
          resolverCode:
            resolverError && typeof resolverError === 'object'
              ? resolverError.code
              : undefined,
        },
      );
    }
  }

  if (!isContainerCompatibleProvider(provider)) {
    throw new ExecutionPlannerError(
      `Agent ${agent.name} requires heavy tools, but provider ${agent.provider_id} is not compatible with the Claude container runtime.`,
      'CONTAINER_PROVIDER_INCOMPATIBLE',
      {
        providerId: agent.provider_id,
        apiFormat: provider?.api_format ?? null,
        coreCompatibility: provider?.core_compatibility ?? null,
      },
    );
  }

  const containerCredential = resolveContainerCredential();

  return {
    backend: 'container',
    routeReason: 'normal',
    effectiveTools,
    providerId: agent.provider_id,
    modelId: agent.model_id,
    heavyToolFamilies,
    containerCredential,
  };
}
