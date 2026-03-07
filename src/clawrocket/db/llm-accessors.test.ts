import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './index.js';
import {
  createRegisteredAgent,
  deleteRegisteredAgent,
  getDefaultRegisteredAgentId,
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
      modelId: 'claude-opus-4-1',
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
});
