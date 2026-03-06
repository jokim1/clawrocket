import {
  listTalkLlmSettingsSnapshot,
  replaceTalkLlmSettingsSnapshot,
} from '../../db/index.js';
import type { AuthContext, ApiEnvelope } from '../types.js';

type PutTalkLlmSettingsInput = {
  defaultRouteId?: unknown;
  providers?: unknown;
  routes?: unknown;
};

function isAdminLike(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

function validateTalkLlmSettingsPayload(input: PutTalkLlmSettingsInput): {
  ok: true;
  value: Parameters<typeof replaceTalkLlmSettingsSnapshot>[0];
} | {
  ok: false;
  error: string;
} {
  if (typeof input.defaultRouteId !== 'string' || !input.defaultRouteId.trim()) {
    return { ok: false, error: 'defaultRouteId is required' };
  }
  if (!Array.isArray(input.providers)) {
    return { ok: false, error: 'providers must be an array' };
  }
  if (!Array.isArray(input.routes)) {
    return { ok: false, error: 'routes must be an array' };
  }

  const providers: Parameters<typeof replaceTalkLlmSettingsSnapshot>[0]['providers'] = [];
  for (const rawProvider of input.providers) {
    if (!rawProvider || typeof rawProvider !== 'object') {
      return { ok: false, error: 'each provider must be an object' };
    }
    const provider = rawProvider as Record<string, unknown>;
    if (
      typeof provider.id !== 'string' ||
      typeof provider.name !== 'string' ||
      typeof provider.providerKind !== 'string' ||
      typeof provider.apiFormat !== 'string' ||
      typeof provider.baseUrl !== 'string' ||
      typeof provider.authScheme !== 'string' ||
      typeof provider.coreCompatibility !== 'string' ||
      !Array.isArray(provider.models)
    ) {
      return { ok: false, error: 'provider entries are missing required fields' };
    }

    const models = provider.models.map((rawModel) => {
      const model = rawModel as Record<string, unknown>;
      return {
        modelId: typeof model.modelId === 'string' ? model.modelId : '',
        displayName: typeof model.displayName === 'string' ? model.displayName : '',
        contextWindowTokens:
          typeof model.contextWindowTokens === 'number'
            ? Math.max(256, Math.floor(model.contextWindowTokens))
            : 0,
        defaultMaxOutputTokens:
          typeof model.defaultMaxOutputTokens === 'number'
            ? Math.max(1, Math.floor(model.defaultMaxOutputTokens))
            : 0,
        enabled: model.enabled !== false,
      };
    });
    if (
      models.some(
        (model) =>
          !model.modelId ||
          !model.displayName ||
          model.contextWindowTokens <= 0 ||
          model.defaultMaxOutputTokens <= 0,
      )
    ) {
      return { ok: false, error: 'provider models are invalid' } as const;
    }

    let credential: { apiKey: string; organizationId?: string } | null | undefined;
    if (provider.credential === null) {
      credential = null;
    } else if (provider.credential !== undefined) {
      const secret = provider.credential as Record<string, unknown>;
      if (typeof secret.apiKey !== 'string' || !secret.apiKey.trim()) {
        return { ok: false, error: 'provider credentials must include apiKey' } as const;
      }
      credential = {
        apiKey: secret.apiKey.trim(),
        organizationId:
          typeof secret.organizationId === 'string' && secret.organizationId.trim()
            ? secret.organizationId.trim()
            : undefined,
      };
    }

    providers.push({
      id: provider.id.trim(),
      name: provider.name.trim(),
      providerKind: provider.providerKind as Parameters<
        typeof replaceTalkLlmSettingsSnapshot
      >[0]['providers'][number]['providerKind'],
      apiFormat: provider.apiFormat as Parameters<
        typeof replaceTalkLlmSettingsSnapshot
      >[0]['providers'][number]['apiFormat'],
      baseUrl: provider.baseUrl.trim(),
      authScheme: provider.authScheme as Parameters<
        typeof replaceTalkLlmSettingsSnapshot
      >[0]['providers'][number]['authScheme'],
      enabled: provider.enabled !== false,
      coreCompatibility: provider.coreCompatibility as Parameters<
        typeof replaceTalkLlmSettingsSnapshot
      >[0]['providers'][number]['coreCompatibility'],
      responseStartTimeoutMs:
        typeof provider.responseStartTimeoutMs === 'number'
          ? Math.max(1, Math.floor(provider.responseStartTimeoutMs))
          : null,
      streamIdleTimeoutMs:
        typeof provider.streamIdleTimeoutMs === 'number'
          ? Math.max(1, Math.floor(provider.streamIdleTimeoutMs))
          : null,
      absoluteTimeoutMs:
        typeof provider.absoluteTimeoutMs === 'number'
          ? Math.max(1, Math.floor(provider.absoluteTimeoutMs))
          : null,
      models,
      credential,
    });
  }

  const routes: Parameters<typeof replaceTalkLlmSettingsSnapshot>[0]['routes'] = [];
  for (const rawRoute of input.routes) {
    if (!rawRoute || typeof rawRoute !== 'object') {
      return { ok: false, error: 'each route must be an object' };
    }
    const route = rawRoute as Record<string, unknown>;
    if (
      typeof route.id !== 'string' ||
      typeof route.name !== 'string' ||
      !Array.isArray(route.steps)
    ) {
      return { ok: false, error: 'route entries are missing required fields' };
    }
    const steps = route.steps.map((rawStep, index) => {
      const step = rawStep as Record<string, unknown>;
      return {
        position:
          typeof step.position === 'number'
            ? Math.max(0, Math.floor(step.position))
            : index,
        providerId: typeof step.providerId === 'string' ? step.providerId.trim() : '',
        modelId: typeof step.modelId === 'string' ? step.modelId.trim() : '',
      };
    });
    if (steps.length === 0 || steps.some((step) => !step.providerId || !step.modelId)) {
      return { ok: false, error: 'each route must have at least one valid step' };
    }
    routes.push({
      id: route.id.trim(),
      name: route.name.trim(),
      enabled: route.enabled !== false,
      steps,
    });
  }

  return {
    ok: true,
    value: {
      defaultRouteId: input.defaultRouteId.trim(),
      providers,
      routes,
    },
  };
}

export function getTalkLlmSettingsRoute(input: {
  auth: AuthContext;
}): {
  statusCode: number;
  body: ApiEnvelope<ReturnType<typeof listTalkLlmSettingsSnapshot>>;
} {
  if (!isAdminLike(input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to manage Talk LLM settings',
        },
      },
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: listTalkLlmSettingsSnapshot(),
    },
  };
}

export function updateTalkLlmSettingsRoute(input: {
  auth: AuthContext;
  payload: PutTalkLlmSettingsInput;
}): {
  statusCode: number;
  body: ApiEnvelope<ReturnType<typeof listTalkLlmSettingsSnapshot>>;
} {
  if (!isAdminLike(input.auth.role)) {
    return {
      statusCode: 403,
      body: {
        ok: false,
        error: {
          code: 'forbidden',
          message: 'You do not have permission to manage Talk LLM settings',
        },
      },
    };
  }

  const validated = validateTalkLlmSettingsPayload(input.payload);
  if (!validated.ok) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: {
          code: 'invalid_talk_llm_settings',
          message: validated.error,
        },
      },
    };
  }

  replaceTalkLlmSettingsSnapshot({
    ...validated.value,
    updatedBy: input.auth.userId,
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      data: listTalkLlmSettingsSnapshot(),
    },
  };
}
