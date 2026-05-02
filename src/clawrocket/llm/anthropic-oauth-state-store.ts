/**
 * anthropic-oauth-state-store.ts
 *
 * In-memory store for the PKCE verifier + state pairs that bridge the
 * `/initiate` and `/submit-code` halves of the OAuth flow. Single-process
 * clawrocket; restart loses state which forces the user to re-initiate
 * (rare and recoverable).
 *
 * State entries:
 *   - state (uuid): random correlation id sent to claude.ai
 *   - verifier: PKCE verifier; never leaves the server, only sent to Anthropic's
 *     token endpoint at exchange time
 *   - userId: who initiated; submit-code rejects if a different user submits
 *   - createdAt: TTL anchor (10 minute window matches rocketboard)
 *
 * Cleanup: lazy on every read, plus an opportunistic sweep on every write.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

interface StoredState {
  verifier: string;
  userId: string;
  createdAt: number;
}

const store = new Map<string, StoredState>();

function isExpired(entry: StoredState): boolean {
  return Date.now() - entry.createdAt > STATE_TTL_MS;
}

function sweepExpired(): void {
  for (const [state, entry] of store.entries()) {
    if (isExpired(entry)) store.delete(state);
  }
}

export function storeState(input: {
  state: string;
  verifier: string;
  userId: string;
}): void {
  sweepExpired();
  store.set(input.state, {
    verifier: input.verifier,
    userId: input.userId,
    createdAt: Date.now(),
  });
}

export type ConsumeResult =
  | { kind: 'ok'; verifier: string }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'wrong_user' };

export function consumeState(input: {
  state: string;
  userId: string;
}): ConsumeResult {
  const entry = store.get(input.state);
  if (!entry) return { kind: 'not_found' };

  // Always delete on consumption (one-time use).
  store.delete(input.state);

  if (isExpired(entry)) return { kind: 'expired' };
  if (entry.userId !== input.userId) {
    // Don't leak that the state existed for a different user.
    return { kind: 'wrong_user' };
  }
  return { kind: 'ok', verifier: entry.verifier };
}

// Test-only — clears all stored states. Not exported via the barrel.
export function _resetStateStoreForTests(): void {
  store.clear();
}
