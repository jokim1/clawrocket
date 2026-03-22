import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import { getContainerRuntimeStatus } from '../../container-runtime.js';
import {
  ExecutionPlannerError,
  planMainExecution,
  type ExecutionPlan,
} from './execution-planner.js';

export interface AgentExecutionPreview {
  surface: 'main';
  backend: 'direct_http' | 'container' | 'host_codex' | null;
  authPath: 'api_key' | 'subscription' | 'host_login' | null;
  routeReason:
    | 'normal'
    | 'browser_fast_lane'
    | 'subscription_fallback'
    | 'host_only'
    | 'direct_with_promotion'
    | 'no_valid_path';
  ready: boolean;
  message: string;
}

function buildReadyMessage(
  agent: RegisteredAgentRecord,
  plan: ExecutionPlan,
): string {
  if (plan.backend === 'direct_http') {
    if (plan.routeReason === 'browser_fast_lane') {
      return 'Main will use the browser fast lane over direct Anthropic HTTP.';
    }
    if (
      plan.authPath === 'api_key' &&
      agent.provider_id === 'provider.anthropic'
    ) {
      return 'Main will use Anthropic direct HTTP with an API key.';
    }
    return 'Main will use direct HTTP.';
  }

  if (plan.backend === 'host_codex') {
    return 'Main will use the OpenAI Codex host runtime.';
  }

  if (
    plan.routeReason === 'subscription_fallback' &&
    plan.containerCredential.authMode === 'subscription'
  ) {
    return 'Main will use Claude subscription via container fallback because no Anthropic API key is configured.';
  }

  if (plan.containerCredential.authMode === 'subscription') {
    return 'Main will use Claude subscription via the container runtime.';
  }

  return 'Main will use the Claude container runtime with an Anthropic API key.';
}

function buildContainerRuntimeUnavailableMessage(
  agent: RegisteredAgentRecord,
  plan: Extract<ExecutionPlan, { backend: 'container' }>,
): string {
  if (
    agent.provider_id === 'provider.anthropic' &&
    plan.routeReason === 'subscription_fallback'
  ) {
    return 'Claude container runtime is unavailable on this host. Start Docker or configure an Anthropic API key for this agent.';
  }

  return 'Claude container runtime is unavailable on this host. Start Docker before using this agent in Main.';
}

function normalizePlannerFailureMessage(error: ExecutionPlannerError): string {
  if (error.code === 'DIRECT_EXECUTION_UNAVAILABLE') {
    return 'No valid Main execution path is currently configured for this agent.';
  }
  return error.message;
}

export function buildMainExecutionPreview(
  agent: RegisteredAgentRecord,
  userId: string,
): AgentExecutionPreview {
  try {
    const mainPlan = planMainExecution(agent, userId);
    const plan =
      mainPlan.policy === 'container_only'
        ? mainPlan.containerPlan
        : mainPlan.policy === 'host_codex_only'
          ? mainPlan.hostCodexPlan
          : mainPlan.directPlan;
    if (!plan) {
      return {
        surface: 'main',
        backend: null,
        authPath: null,
        routeReason: 'no_valid_path',
        ready: false,
        message:
          'No valid Main execution path is currently configured for this agent.',
      };
    }
    if (
      plan.backend === 'container' &&
      getContainerRuntimeStatus() !== 'ready'
    ) {
      return {
        surface: 'main',
        backend: null,
        authPath: null,
        routeReason: 'no_valid_path',
        ready: false,
        message: buildContainerRuntimeUnavailableMessage(agent, plan),
      };
    }
    if (mainPlan.policy === 'direct_with_promotion') {
      return {
        surface: 'main',
        backend: 'direct_http',
        authPath: mainPlan.directPlan?.authPath ?? null,
        routeReason: 'direct_with_promotion',
        ready: true,
        message:
          'Main will keep web and browser tools in the direct parent run and promote shell/filesystem work into a background container run only when needed.',
      };
    }
    if (mainPlan.policy === 'host_codex_only') {
      return {
        surface: 'main',
        backend: 'host_codex',
        authPath: 'host_login',
        routeReason: 'host_only',
        ready: true,
        message: buildReadyMessage(agent, plan),
      };
    }
    return {
      surface: 'main',
      backend: plan.backend,
      authPath:
        plan.backend === 'direct_http'
          ? plan.authPath
          : plan.backend === 'container'
            ? plan.containerCredential.authMode
            : plan.authPath,
      routeReason: plan.routeReason,
      ready: true,
      message: buildReadyMessage(agent, plan),
    };
  } catch (error) {
    if (error instanceof ExecutionPlannerError) {
      return {
        surface: 'main',
        backend: null,
        authPath: null,
        routeReason: 'no_valid_path',
        ready: false,
        message: normalizePlannerFailureMessage(error),
      };
    }
    throw error;
  }
}
