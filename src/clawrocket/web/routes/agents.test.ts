import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  listKnownProviderCredentialCards,
} from '../../db/index.js';
import { upsertUser } from '../../db/accessors.js';
import { saveAiProviderCredentialRoute } from './agents.js';
import type { AuthContext } from '../types.js';

const OWNER_AUTH: AuthContext = {
  sessionId: 'session-1',
  userId: 'owner-1',
  role: 'owner',
  authType: 'cookie',
};

describe('agents routes', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
  });

  it('persists provider credentials before background verification finishes', async () => {
    const verify = vi.fn().mockRejectedValue(new Error('provider unavailable'));

    const result = await saveAiProviderCredentialRoute({
      auth: OWNER_AUTH,
      providerId: 'provider.nvidia',
      apiKey: 'nvapi-test-key',
      verifier: { verify } as never,
    });

    expect(result.statusCode).toBe(200);
    expect(result.body.ok).toBe(true);
    if (!result.body.ok) {
      throw new Error('expected success response');
    }
    expect(result.body.data.provider.id).toBe('provider.nvidia');
    expect(result.body.data.provider.hasCredential).toBe(true);
    expect(result.body.data.provider.verificationStatus).toBe('not_verified');

    expect(verify).toHaveBeenCalledWith('provider.nvidia');

    const stored = listKnownProviderCredentialCards().find(
      (provider) => provider.id === 'provider.nvidia',
    );
    expect(stored?.hasCredential).toBe(true);
    expect(stored?.verificationStatus).toBe('not_verified');
  });
});
