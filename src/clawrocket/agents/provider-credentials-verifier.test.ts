import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  listKnownProviderCredentialCards,
  upsertKnownProviderCredential,
  upsertUser,
} from '../db/index.js';
import { ProviderCredentialsVerifier } from './provider-credentials-verifier.js';

describe('ProviderCredentialsVerifier', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'test-user',
      email: 'test@example.com',
      displayName: 'Test User',
      role: 'owner',
    });
    upsertKnownProviderCredential({
      providerId: 'provider.nvidia',
      credential: { apiKey: 'nvapi-test-key' },
      updatedBy: 'test-user',
    });
  });

  it('retries nvidia verification once after a transient server failure', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const verifier = new ProviderCredentialsVerifier({ fetchImpl });
    const result = await verifier.verify('provider.nvidia');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.id).toBe('provider.nvidia');
    expect(result.verificationStatus).toBe('verified');

    const stored = listKnownProviderCredentialCards().find(
      (provider) => provider.id === 'provider.nvidia',
    );
    expect(stored?.verificationStatus).toBe('verified');
    expect(stored?.lastVerificationError).toBeNull();
  });
});
