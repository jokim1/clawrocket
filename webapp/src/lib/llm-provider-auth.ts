// Editorial Room provider-auth state — shared between Setup (LLM Room
// section) and Draft (right-rail panel composer). Polls the OAuth status
// endpoints for OAuth providers and the /api/v1/agents endpoint for
// API-key providers, then exposes a `{providerId: connected}` map that
// `isAgentAuthed` uses to filter the agent picker.
//
// Extracted from EditorialSetupPage.tsx so DraftWorkspacePage's `+ ASK`
// composer can ask "which of the selected agents have an authed provider
// right now?" without a page→page import.

import { useCallback, useEffect, useState } from 'react';

import type { AgentProfile } from './editorial-fixtures';
import { PROVIDER_CATALOG, catalogIdForFixtureProvider } from './llm-providers';

export type ProviderAuthMap = Record<string, boolean>;

export type AdditionalProviderCard = {
  id: string;
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus:
    | 'verified'
    | 'invalid'
    | 'unavailable'
    | 'missing'
    | 'not_verified';
};

export type AdditionalProviderCardMap = Record<string, AdditionalProviderCard>;

export function useProviderAuth(): {
  authed: ProviderAuthMap;
  cards: AdditionalProviderCardMap;
  refresh: () => Promise<void>;
} {
  const [authed, setAuthed] = useState<ProviderAuthMap>({});
  const [cards, setCards] = useState<AdditionalProviderCardMap>({});

  const refresh = useCallback(async (): Promise<void> => {
    const next: ProviderAuthMap = {};
    const nextCards: AdditionalProviderCardMap = {};

    const oauthEntries = PROVIDER_CATALOG.filter((p) => p.oauthStatusEndpoint);
    const apiKeyEntries = PROVIDER_CATALOG.filter(
      (p) => p.authType === 'api_key',
    );

    await Promise.all([
      ...oauthEntries.map(async (p) => {
        try {
          const res = await fetch(p.oauthStatusEndpoint!, {
            credentials: 'include',
          });
          const json = (await res.json()) as
            | { ok: true; data: { connected: boolean } }
            | { ok: false };
          next[p.id] = !!(
            'ok' in json &&
            json.ok &&
            (json.data as { connected?: boolean }).connected
          );
        } catch {
          next[p.id] = false;
        }
      }),
      apiKeyEntries.length > 0
        ? (async () => {
            try {
              const res = await fetch('/api/v1/agents', {
                credentials: 'include',
              });
              const json = (await res.json()) as
                | {
                    ok: true;
                    data: {
                      additionalProviders: AdditionalProviderCard[];
                    };
                  }
                | { ok: false };
              if ('ok' in json && json.ok) {
                for (const p of apiKeyEntries) {
                  const found = json.data.additionalProviders.find(
                    (ap) => ap.id === p.id,
                  );
                  next[p.id] = !!found?.hasCredential;
                  if (found) nextCards[p.id] = found;
                }
              } else {
                for (const p of apiKeyEntries) next[p.id] = false;
              }
            } catch {
              for (const p of apiKeyEntries) next[p.id] = false;
            }
          })()
        : Promise.resolve(),
    ]);

    setAuthed(next);
    setCards(nextCards);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { authed, cards, refresh };
}

export function isAgentAuthed(
  a: AgentProfile,
  authed: ProviderAuthMap,
): boolean {
  const catalogId = catalogIdForFixtureProvider(a.provider);
  if (!catalogId) return false;
  return !!authed[catalogId];
}
