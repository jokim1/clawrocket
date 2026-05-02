// Shared dispatch helper for Editorial Room `+ ASK` panel composers.
//
// `streamAgentPanelTurn` POSTs one panel turn to /api/v1/editorial/panel-turn
// and parses the SSE response, invoking callbacks as text deltas arrive,
// once on completion, and once on error. Pages that fan out across multiple
// agents call this in parallel under `Promise.allSettled` so one agent's
// failure can't block the others — that mirrors the contract's
// `partial_provider_failures` semantics in EDITORIAL_ROOM_CONTRACT.md §4.4.
//
// Each page owns its own turn shape, storage key, and JSX; this module just
// gives them a single source of truth for the network protocol.

export interface PanelFanOutAgent {
  /** Fixture-provider tag (uppercase) — ANTHROPIC | OPENAI | GOOGLE | GEMINI | NVIDIA. */
  provider: string;
  name: string;
  role: string;
}

export interface PanelFanOutRequest {
  agent: PanelFanOutAgent;
  userMessage: string;
  segmentContext: string;
  /** Optional point index for routing context. Pass null when the panel is
   *  scoped to a Topic (no Point yet) or a Theme. */
  scopePointIndex: number | null;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

export interface PanelFanOutCallbacks {
  /** Fires every time the server emits a token. `accumulated` is the
   *  running concatenation so far. */
  onTextDelta?: (delta: string, accumulated: string) => void;
  /** Fires once when the stream finishes successfully. `finalText` is the
   *  authoritative server-emitted value (what arrived in the `completed`
   *  event), falling back to the running accumulator. */
  onComplete?: (finalText: string) => void;
  /** Fires once on a transport, HTTP, or stream error. After this fires,
   *  the function rejects so a `Promise.allSettled` caller can identify
   *  which agents failed. */
  onError?: (message: string) => void;
}

/**
 * Stream a single agent's panel turn. Throws on hard error after invoking
 * the optional `onError` callback, so callers can use `Promise.allSettled`
 * to fan out across N agents and still distinguish per-agent outcomes.
 */
export async function streamAgentPanelTurn(
  request: PanelFanOutRequest,
  callbacks: PanelFanOutCallbacks = {},
): Promise<string> {
  const fetchImpl = request.fetchImpl ?? fetch;
  let accumulated = '';
  let streamErrorMessage: string | null = null;

  try {
    const res = await fetchImpl('/api/v1/editorial/panel-turn', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fixtureProvider: request.agent.provider,
        agentName: request.agent.name,
        agentRole: request.agent.role,
        userMessage: request.userMessage,
        segmentContext: request.segmentContext,
        scopePointIndex: request.scopePointIndex,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
      );
    }
    if (!res.body) {
      throw new Error('Response had no stream body.');
    }

    const decoder = new TextDecoder('utf-8');
    const reader = res.body.getReader();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = parsePanelTurnSseRecord(raw);
        if (!event) continue;

        if (event.event === 'text_delta') {
          try {
            const data = JSON.parse(event.data) as { text?: string };
            if (typeof data.text === 'string') {
              accumulated += data.text;
              callbacks.onTextDelta?.(data.text, accumulated);
            }
          } catch {
            // ignore malformed SSE record
          }
        } else if (event.event === 'completed') {
          try {
            const data = JSON.parse(event.data) as { text?: string };
            if (typeof data.text === 'string' && data.text.length > 0) {
              accumulated = data.text;
            }
          } catch {
            // ignore
          }
        } else if (event.event === 'error') {
          try {
            const data = JSON.parse(event.data) as { message?: string };
            streamErrorMessage = data.message ?? 'Panel turn errored.';
          } catch {
            streamErrorMessage = 'Panel turn errored.';
          }
        }
      }
    }

    if (streamErrorMessage) throw new Error(streamErrorMessage);
    callbacks.onComplete?.(accumulated);
    return accumulated;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Panel turn failed.';
    callbacks.onError?.(msg);
    throw err;
  }
}

/**
 * Minimal SSE record parser. Mirrors the server-side parser in
 * `src/clawrocket/llm/editorial-llm-call.ts`; the route emits records of
 * the form `event: <name>\ndata: <json>\n\n`.
 */
export function parsePanelTurnSseRecord(
  raw: string,
): { event?: string; data: string } | null {
  const lines = raw.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const valueRaw = colon === -1 ? '' : line.slice(colon + 1);
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !eventName) return null;
  return { event: eventName, data: dataLines.join('\n') };
}
