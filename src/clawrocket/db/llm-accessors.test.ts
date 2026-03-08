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
  listTalkLlmSettingsSnapshot,
  replaceTalkLlmSettingsSnapshot,
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
      nickname: expectedModelDisplayName,
      sourceKind: 'claude_default',
      providerId: 'provider.anthropic',
      modelId: expectedModelId,
      modelDisplayName: expectedModelDisplayName,
    });
  });

  it('resets old mock default talk agents to the Claude default agent', () => {
    upsertUser({
      id: 'owner-2',
      email: 'owner2@example.com',
      displayName: 'Owner Two',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-2',
      ownerId: 'owner-2',
      topicTitle: 'Mock Reset Test',
    });

    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id,
          talk_id,
          name,
          source_kind,
          persona_role,
          route_id,
          registered_agent_id,
          provider_id,
          model_id,
          is_primary,
          sort_order,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        'agent-mock',
        'talk-2',
        'Mock',
        'provider',
        'assistant',
        'route.default.mock',
        null,
        null,
        null,
        1,
        0,
        new Date().toISOString(),
        new Date().toISOString(),
      );

    const expectedModelId = getDefaultClaudeModelId();
    const expectedModelDisplayName =
      listClaudeModelSuggestions().find(
        (model) => model.modelId === expectedModelId,
      )?.displayName || expectedModelId;
    const [agent] = listTalkAgentInstances('talk-2');

    expect(agent).toMatchObject({
      nickname: expectedModelDisplayName,
      sourceKind: 'claude_default',
      providerId: 'provider.anthropic',
      modelId: expectedModelId,
    });
  });

  it('marks known Claude suggestions as tool-capable and persists supportsTools for provider models', () => {
    expect(
      listClaudeModelSuggestions().every((model) => model.supportsTools),
    ).toBe(true);

    replaceTalkLlmSettingsSnapshot({
      defaultRouteId: 'route.provider.custom',
      providers: [
        {
          id: 'provider.custom-tools',
          name: 'Custom Tools',
          providerKind: 'custom',
          apiFormat: 'openai_chat_completions',
          baseUrl: 'https://example.com/v1',
          authScheme: 'bearer',
          enabled: true,
          coreCompatibility: 'none',
          responseStartTimeoutMs: null,
          streamIdleTimeoutMs: null,
          absoluteTimeoutMs: null,
          models: [
            {
              modelId: 'tool-model',
              displayName: 'Tool Model',
              contextWindowTokens: 64000,
              defaultMaxOutputTokens: 2048,
              supportsTools: true,
              enabled: true,
            },
            {
              modelId: 'plain-model',
              displayName: 'Plain Model',
              contextWindowTokens: 32000,
              defaultMaxOutputTokens: 1024,
              supportsTools: false,
              enabled: true,
            },
          ],
        },
      ],
      routes: [
        {
          id: 'route.provider.custom',
          name: 'Custom Route',
          enabled: true,
          steps: [
            {
              position: 0,
              providerId: 'provider.custom-tools',
              modelId: 'tool-model',
            },
          ],
        },
      ],
    });

    const snapshot = listTalkLlmSettingsSnapshot();
    const provider = snapshot.providers.find(
      (entry) => entry.id === 'provider.custom-tools',
    );
    expect(provider?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          modelId: 'tool-model',
          supportsTools: true,
        }),
        expect.objectContaining({
          modelId: 'plain-model',
          supportsTools: false,
        }),
      ]),
    );
  });
});
