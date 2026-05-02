/**
 * openai-oauth-state-store.ts
 *
 * In-memory store for OpenAI device code flow state — bridges the
 * `/initiate` and `/poll` halves of the flow. Each state holds the
 * deviceAuthId + userCode that we got back from auth.openai.com so we
 * can resume polling on every /poll request.
 *
 * Single-process clawrocket; restart loses state. Cleanup is lazy on
 * write + reads.
 */

const STATE_TTL_MS = 16 * 60 * 1000; // device code flow has a 15-min timeout

interface StoredState {
  deviceAuthId: string;
  userCode: string;
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

export function storeOpenAIState(input: {
  state: string;
  deviceAuthId: string;
  userCode: string;
  userId: string;
}): void {
  sweepExpired();
  store.set(input.state, {
    deviceAuthId: input.deviceAuthId,
    userCode: input.userCode,
    userId: input.userId,
    createdAt: Date.now(),
  });
}

export type LookupOpenAIResult =
  | {
      kind: 'ok';
      deviceAuthId: string;
      userCode: string;
    }
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'wrong_user' };

// Looks up state but does NOT delete — polling needs the entry across
// many calls. Caller deletes via `consumeOpenAIState` after authorization.
export function peekOpenAIState(input: {
  state: string;
  userId: string;
}): LookupOpenAIResult {
  const entry = store.get(input.state);
  if (!entry) return { kind: 'not_found' };
  if (isExpired(entry)) {
    store.delete(input.state);
    return { kind: 'expired' };
  }
  if (entry.userId !== input.userId) {
    return { kind: 'wrong_user' };
  }
  return {
    kind: 'ok',
    deviceAuthId: entry.deviceAuthId,
    userCode: entry.userCode,
  };
}

// Delete the state — call after the device code is authorized + tokens
// stored, or when the user cancels.
export function consumeOpenAIState(state: string): void {
  store.delete(state);
}

export function _resetOpenAIStateStoreForTests(): void {
  store.clear();
}
