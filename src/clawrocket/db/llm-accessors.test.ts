import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  listTalkAgentInstances,
  resetTalkAgentsToDefault,
  upsertTalk,
  upsertUser,
} from './index.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getDefaultClaudeModelId,
  getDefaultRegisteredAgentId,
  listClaudeModelSuggestions,
  upsertKnownProviderCredential,
} from './llm-accessors.js';

describe('registered agent accessors', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertKnownProviderCredential({
      providerId: 'provider.anthropic',
      credential: null,
    });
    upsertKnownProviderCredential({
      providerId: 'provider.gemini',
      credential: null,
    });
  });

  it('promotes the next enabled registered agent when deleting the default', () => {
    const defaultAgent = createRegisteredAgent({
      name: 'Claude Opus',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      setAsDefault: true,
    });
    const fallbackAgent = createRegisteredAgent({
      name: 'Gemini Fast',
      providerId: 'provider.gemini',
      modelId: 'gemini-2.5-flash',
    });

    expect(getDefaultRegisteredAgentId()).toBe(defaultAgent.id);

    deleteRegisteredAgent(defaultAgent.id);

    expect(getDefaultRegisteredAgentId()).toBe(fallbackAgent.id);
  });

  it('rehydrates malformed persisted Claude agents from their route data', () => {
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Hydration Test',
    });
    resetTalkAgentsToDefault('talk-1');

    getDb()
      .prepare(
        `
        UPDATE talk_agents
        SET source_kind = 'provider',
            provider_id = NULL,
            model_id = NULL
        WHERE talk_id = ?
      `,
      )
      .run('talk-1');

    const expectedModelId = getDefaultClaudeModelId();
    const expectedModelDisplayName =
      listClaudeModelSuggestions().find(
        (model) => model.modelId === expectedModelId,
      )?.displayName || expectedModelId;
    const [agent] = listTalkAgentInstances('talk-1');
    expect(agent).toMatchObject({
      name: 'Claude',
      sourceKind: 'claude_default',
      providerId: 'provider.anthropic',
      modelId: expectedModelId,
      modelDisplayName: expectedModelDisplayName,
    });
  });
});
