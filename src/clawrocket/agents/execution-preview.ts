import type { RegisteredAgentRecord } from '../db/agent-accessors.js';
import {
  ExecutionPlannerError,
  planExecution,
  type ExecutionPlan,
} from './execution-planner.js';

export interface AgentExecutionPreview {
  surface: 'main';
  backend: 'direct_http' | 'container' | null;
  authPath: 'api_key' | 'subscription' | null;
  routeReason: 'normal' | 'subscription_fallback' | 'no_valid_path';
  ready: boolean;
  message: string;
}

function buildReadyMessage(
  agent: RegisteredAgentRecord,
  plan: ExecutionPlan,
): string {
  if (plan.backend === 'direct_http') {
    if (agent.provider_id === 'provider.anthropic') {
      return 'Main will use Anthropic direct HTTP with an API key.';
    }
    return 'Main will use direct HTTP.';
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
    const plan = planExecution(agent, userId, 'main');
    return {
      surface: 'main',
      backend: plan.backend,
      authPath:
        plan.backend === 'direct_http'
          ? agent.provider_id === 'provider.anthropic'
            ? 'api_key'
            : null
          : plan.containerCredential.authMode,
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
