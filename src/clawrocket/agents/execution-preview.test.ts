import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetContainerRuntimeStatusForTests,
  _setContainerRuntimeStatusForTests,
} from '../../container-runtime.js';
import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  upsertSettingValue,
  upsertUser,
} from '../db/index.js';
import { createRegisteredAgent } from '../db/agent-accessors.js';
import { encryptProviderSecret } from '../llm/provider-secret-store.js';
import { buildMainExecutionPreview } from './execution-preview.js';

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

describe('execution-preview', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetContainerRuntimeStatusForTests();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('marks subscription-backed container routes as unavailable when Docker is unavailable', () => {
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
    _setContainerRuntimeStatusForTests('unavailable');

    const agent = createRegisteredAgent({
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: false,
      routeReason: 'no_valid_path',
      backend: null,
      authPath: null,
    });
    expect(buildMainExecutionPreview(agent, 'owner-1').message).toMatch(
      /container runtime is unavailable/i,
    );
  });

  it('keeps direct HTTP Claude routes available when Docker is unavailable', () => {
    seedAnthropicSecret();
    _setContainerRuntimeStatusForTests('unavailable');

    const agent = createRegisteredAgent({
      name: 'Claude Main',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: JSON.stringify({ web: true }),
    });

    expect(buildMainExecutionPreview(agent, 'owner-1')).toMatchObject({
      ready: true,
      backend: 'direct_http',
      authPath: 'api_key',
    });
  });
});
