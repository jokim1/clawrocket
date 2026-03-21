import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import {
  buildDefaultTalkToolPermissions,
  createRegisteredAgent,
  upsertUserToolPermission,
} from '../db/agent-accessors.js';
import {
  ExecutionPlannerError,
  getContainerAllowedTools,
  planMainExecution,
  planExecution,
} from './execution-planner.js';

function seedAnthropicSecret(apiKey = 'sk-ant-test'): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO llm_provider_secrets (provider_id, ciphertext, updated_at, updated_by)
       VALUES ('provider.anthropic', ?, ?, ?)
       ON CONFLICT(provider_id) DO UPDATE SET ciphertext = excluded.ciphertext,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(encryptProviderSecret({ apiKey }), now, 'owner-1');
}

describe('execution-planner', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('returns direct_http for light/API agents', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Research',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
    if (plan.backend === 'direct_http') {
      expect(plan.binding.providerConfig.providerId).toBe('provider.anthropic');
    }
  });

  it('defaults new agents to the Talk-safe direct profile when tool permissions are omitted', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Persona',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
    });

    expect(JSON.parse(agent.tool_permissions_json)).toEqual(
      buildDefaultTalkToolPermissions(),
    );

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
  });

  it('returns container for heavy Claude-compatible agents without requiring a registered group', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true, filesystem: true }),
    });
    upsertUserToolPermission('owner-1', 'Bash', true, true);

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('api_key');
      expect(plan.heavyToolFamilies).toEqual(['shell', 'filesystem']);
    }
  });

  it('routes from effective user permissions rather than raw heavy tool flags', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    upsertUserToolPermission('owner-1', 'Bash', false, false);
    upsertUserToolPermission('owner-1', 'Read', false, false);

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
    expect(
      plan.effectiveTools.find((tool) => tool.toolFamily === 'shell'),
    ).toMatchObject({
      enabled: false,
      requiresApproval: false,
      runtimeTools: ['Bash'],
    });
    expect(
      plan.effectiveTools.find((tool) => tool.toolFamily === 'filesystem'),
    ).toMatchObject({
      enabled: false,
      requiresApproval: false,
      runtimeTools: ['Read', 'Write', 'Edit', 'Glob'],
    });
  });

  it('routes browser-only agents through direct_http when direct credentials exist', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('direct_http');
  });

  it('rejects agents that mix browser with shell/filesystem in the same run', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        browser: true,
        shell: true,
        filesystem: true,
      }),
    });

    try {
      planExecution(agent, 'owner-1');
      expect.unreachable('expected mixed browser/container tool plan to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionPlannerError);
      expect((error as ExecutionPlannerError).code).toBe(
        'BROWSER_AND_CONTAINER_TOOLS_MIXED_UNSUPPORTED',
      );
      expect((error as ExecutionPlannerError).message).toBe(
        'This agent has both browser and shell/filesystem tools enabled, which is not supported in the same run. Browser runs host-side and shell/filesystem run in the container in v1. Create separate agents for browser and shell work, or disable one tool family.',
      );
    }
  });

  it('requires direct execution for browser-enabled agents', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    try {
      planExecution(agent, 'owner-1');
      expect.unreachable(
        'expected browser direct-execution requirement to throw',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionPlannerError);
      expect((error as ExecutionPlannerError).code).toBe(
        'BROWSER_REQUIRES_DIRECT_EXECUTION',
      );
      expect((error as ExecutionPlannerError).message).toBe(
        'This agent has browser tools enabled, but browser runs require direct execution in v1. Configure a direct-execution-compatible provider/credential set, or disable browser tools for this agent.',
      );
    }
  });

  it('keeps browser-enabled Main agents on direct_only policy', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    const plan = planMainExecution(agent, 'owner-1');
    expect(plan.policy).toBe('direct_only');
    expect(plan.directPlan?.backend).toBe('direct_http');
    expect(plan.containerPlan).toBeNull();
  });

  it('rejects Main agents that mix browser with shell/filesystem before browser direct-only routing', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser Builder Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({
        browser: true,
        shell: true,
        filesystem: true,
      }),
    });

    try {
      planMainExecution(agent, 'owner-1');
      expect.unreachable(
        'expected mixed browser/container Main plan to throw',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionPlannerError);
      expect((error as ExecutionPlannerError).code).toBe(
        'BROWSER_AND_CONTAINER_TOOLS_MIXED_UNSUPPORTED',
      );
      expect((error as ExecutionPlannerError).message).toBe(
        'This agent has both browser and shell/filesystem tools enabled, which is not supported in the same run. Browser runs host-side and shell/filesystem run in the container in v1. Create separate agents for browser and shell work, or disable one tool family.',
      );
    }
  });

  it('rejects heavy-tool agents on providers that are not Claude-SDK compatible', () => {
    const agent = createRegisteredAgent({
      name: 'GPT Builder',
      providerId: 'provider.openai',
      modelId: 'gpt-5',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /not compatible with the Claude container runtime/i,
    );
  });

  it('uses executor subscription credentials for container execution when configured', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Shell',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ shell: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.containerCredential.secrets.CLAUDE_CODE_OAUTH_TOKEN).toBe(
        'oauth-token-123',
      );
    }
  });

  it('falls back light Claude agents to subscription container execution on Main', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.heavyToolFamilies).toEqual([]);
    }
  });

  it('applies the same subscription fallback for single-agent Talk turns', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
  });

  it('prefers configured subscription mode over direct Anthropic HTTP for light Claude agents', () => {
    seedAnthropicSecret('sk-ant-stale');
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'subscription',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('normal');
    if (plan.backend === 'container') {
      expect(plan.containerCredential.authMode).toBe('subscription');
      expect(plan.heavyToolFamilies).toEqual([]);
    }
  });

  it('does not silently fall back to subscription when api key mode is explicitly selected', () => {
    upsertSettingValue({
      key: 'executor.authMode',
      value: 'api_key',
      updatedBy: 'owner-1',
    });
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /Direct execution is unavailable|No Anthropic API key configured/i,
    );
  });

  it('allows subscription fallback for multi-agent Talk rounds', () => {
    upsertSettingValue({
      key: 'executor.claudeOauthToken',
      value: 'oauth-token-123',
      updatedBy: 'owner-1',
    });
    const agent = createRegisteredAgent({
      name: 'Claude Light',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    const plan = planExecution(agent, 'owner-1');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
  });

  it('maps effective tools into the talk/main container profile', () => {
    const allowedTools = getContainerAllowedTools({
      effectiveTools: [
        {
          toolFamily: 'shell',
          runtimeTools: ['Bash'],
          enabled: true,
          requiresApproval: false,
        },
        {
          toolFamily: 'filesystem',
          runtimeTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
          enabled: true,
          requiresApproval: false,
        },
        {
          toolFamily: 'web',
          runtimeTools: ['web_search', 'web_fetch'],
          enabled: true,
          requiresApproval: false,
        },
      ],
      includeConnectorTools: true,
    });

    expect(allowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'mcp__nanoclaw__*',
      ]),
    );
  });
});
