import { beforeEach, describe, expect, it } from 'vitest';

import { getDb, setRegisteredGroup } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import {
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

  it('returns container for heavy Claude-compatible agents and ignores requiresApproval for routing', () => {
    seedAnthropicSecret();
    setRegisteredGroup('main-jid', {
      name: 'Main',
      folder: 'main',
      trigger: '@main',
      added_at: new Date().toISOString(),
      isMain: true,
    });
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

  it('requires shell when browser is enabled in 5A', () => {
    seedAnthropicSecret();
    setRegisteredGroup('main-jid', {
      name: 'Main',
      folder: 'main',
      trigger: '@main',
      added_at: new Date().toISOString(),
      isMain: true,
    });
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
    setRegisteredGroup('main-jid', {
      name: 'Main',
      folder: 'main',
      trigger: '@main',
      added_at: new Date().toISOString(),
      isMain: true,
    });
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
    setRegisteredGroup('main-jid', {
      name: 'Main',
      folder: 'main',
      trigger: '@main',
      added_at: new Date().toISOString(),
      isMain: true,
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
