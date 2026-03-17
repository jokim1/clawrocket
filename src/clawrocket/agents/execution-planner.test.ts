import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import {
  buildDefaultTalkToolPermissions,
  createRegisteredAgent,
  upsertUserToolPermission,
} from '../db/agent-accessors.js';
import {
  ExecutionPlannerError,
  getContainerAllowedTools,
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
    .run(JSON.stringify({ apiKey }), now, 'owner-1');
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

  it('requires shell when browser is enabled in 5A', () => {
    seedAnthropicSecret();
    const agent = createRegisteredAgent({
      name: 'Claude Browser',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ browser: true }),
    });

    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      ExecutionPlannerError,
    );
    expect(() => planExecution(agent, 'owner-1')).toThrowError(
      /requires shell/i,
    );
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

    const plan = planExecution(agent, 'owner-1', 'main');
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

    const plan = planExecution(agent, 'owner-1', 'talk_single');
    expect(plan.backend).toBe('container');
    expect(plan.routeReason).toBe('subscription_fallback');
  });

  it('rejects subscription fallback for multi-agent Talk rounds', () => {
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

    expect(() => planExecution(agent, 'owner-1', 'talk_multi')).toThrowError(
      /not supported for multi-agent Talk rounds/i,
    );
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
