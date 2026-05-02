/**
 * editorial-panel.ts
 *
 * POST /api/v1/editorial/panel-turn — streams a single Editorial Room
 * panel turn against an LLM provider as Server-Sent Events. The Draft
 * editor's `+ ASK` composer wires up to this endpoint; setup decides which
 * agent to use.
 *
 * Request body:
 *   {
 *     fixtureProvider: 'ANTHROPIC' | 'OPENAI' | 'GOOGLE' | 'GEMINI' | 'NVIDIA',
 *     agentName: string,
 *     agentRole: string,
 *     userMessage: string,
 *     segmentContext?: string,    // optional active-segment markdown
 *     scopePointIndex?: number,   // optional point index for routing context
 *     modelOverride?: string      // optional; defaults to per-provider catalog model
 *   }
 *
 * SSE events:
 *   event: text_delta   data: { text: string }
 *   event: completed    data: { text: string, durationMs: number }
 *   event: error        data: { message: string }
 *
 * v0p scope: stateless, single user message, text-only. Agent identity
 * comes from the request body — no DB-backed agent profiles yet (those
 * live in webapp's FIXTURE_AGENT_PROFILES). Tests cover credential
 * resolution and transport dispatch via mocked fetch.
 */

import { Context } from 'hono';

import { logger } from '../../../logger.js';
import {
  providerIdForFixtureProvider,
  streamPanelTurn,
  type PanelTurnEvent,
} from '../../llm/editorial-llm-call.js';
import type { AuthContext } from '../types.js';

interface PanelTurnRequestBody {
  fixtureProvider?: unknown;
  agentName?: unknown;
  agentRole?: unknown;
  userMessage?: unknown;
  segmentContext?: unknown;
  scopePointIndex?: unknown;
  modelOverride?: unknown;
}

interface ParsedPanelTurnRequest {
  fixtureProvider: string;
  agentName: string;
  agentRole: string;
  userMessage: string;
  segmentContext: string;
  scopePointIndex: number | null;
  modelOverride: string | undefined;
}

function parsePanelTurnRequest(
  body: PanelTurnRequestBody,
): { ok: true; req: ParsedPanelTurnRequest } | { ok: false; error: string } {
  const fixtureProvider =
    typeof body.fixtureProvider === 'string' ? body.fixtureProvider.trim() : '';
  if (!fixtureProvider) {
    return { ok: false, error: 'fixtureProvider is required.' };
  }
  if (!providerIdForFixtureProvider(fixtureProvider)) {
    return {
      ok: false,
      error: `fixtureProvider '${fixtureProvider}' is not in the editorial catalog.`,
    };
  }

  const agentName =
    typeof body.agentName === 'string' ? body.agentName.trim() : '';
  if (!agentName) {
    return { ok: false, error: 'agentName is required.' };
  }
  const agentRole =
    typeof body.agentRole === 'string' ? body.agentRole.trim() : '';
  if (!agentRole) {
    return { ok: false, error: 'agentRole is required.' };
  }
  const userMessage =
    typeof body.userMessage === 'string' ? body.userMessage.trim() : '';
  if (!userMessage) {
    return { ok: false, error: 'userMessage is required.' };
  }
  const segmentContext =
    typeof body.segmentContext === 'string' ? body.segmentContext : '';
  const scopePointIndex =
    typeof body.scopePointIndex === 'number' &&
    Number.isFinite(body.scopePointIndex)
      ? Math.max(0, Math.trunc(body.scopePointIndex))
      : null;
  const modelOverride =
    typeof body.modelOverride === 'string' && body.modelOverride.trim()
      ? body.modelOverride.trim()
      : undefined;

  return {
    ok: true,
    req: {
      fixtureProvider,
      agentName,
      agentRole,
      userMessage,
      segmentContext,
      scopePointIndex,
      modelOverride,
    },
  };
}

/**
 * Build the system prompt that tells the LLM which agent it's playing and
 * what context it has. Kept compact for v0p — the panel turn is a single
 * critique reply, not a multi-turn conversation.
 */
function buildSystemPrompt(req: ParsedPanelTurnRequest): string {
  const lines: string[] = [];
  lines.push(
    `You are ${req.agentName}, the ${req.agentRole} on a small editorial panel reviewing a draft in progress.`,
  );
  lines.push(
    'Reply in 2–4 sentences with one concrete critique or question. Be direct, terse, and useful — no preamble, no flattery, no caveats. Focus on what would actually improve the draft.',
  );
  if (req.scopePointIndex !== null) {
    lines.push(`The user is editing Point ${req.scopePointIndex + 1}.`);
  }
  if (req.segmentContext) {
    lines.push('---');
    lines.push('Active segment:');
    lines.push(req.segmentContext.slice(0, 4000));
    lines.push('---');
  }
  return lines.join('\n\n');
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-clawrocket-sse-mode': 'editorial-panel-turn',
  };
}

function formatSseEvent(event: PanelTurnEvent): string {
  const name = event.type;
  const data = JSON.stringify(
    event.type === 'completed'
      ? { text: event.text, durationMs: event.durationMs }
      : event.type === 'text_delta'
        ? { text: event.text }
        : { message: event.message },
  );
  return `event: ${name}\ndata: ${data}\n\n`;
}

export async function handleEditorialPanelTurn(
  c: Context,
  auth: AuthContext,
): Promise<Response> {
  let body: PanelTurnRequestBody;
  try {
    body = (await c.req.json()) as PanelTurnRequestBody;
  } catch {
    return c.json(
      {
        ok: false,
        error: { code: 'invalid_json', message: 'Body must be valid JSON.' },
      },
      400,
    );
  }
  const parsed = parsePanelTurnRequest(body);
  if (!parsed.ok) {
    return c.json(
      {
        ok: false,
        error: { code: 'invalid_input', message: parsed.error },
      },
      400,
    );
  }

  const req = parsed.req;
  const systemPrompt = buildSystemPrompt(req);
  const requestSignal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      const encoder = new TextEncoder();
      let cancelled = false;
      const write = (event: PanelTurnEvent): void => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          cancelled = true;
        }
      };
      const onAbort = (): void => {
        cancelled = true;
        try {
          controller.close();
        } catch {
          // ignored; already closed
        }
      };
      requestSignal.addEventListener('abort', onAbort, { once: true });

      try {
        const turn = streamPanelTurn({
          fixtureProvider: req.fixtureProvider,
          modelOverride: req.modelOverride,
          systemPrompt,
          userMessage: req.userMessage,
        });
        for await (const event of turn) {
          if (cancelled) break;
          write(event);
          if (event.type === 'error' || event.type === 'completed') break;
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Panel turn dispatch failed.';
        logger.error(
          { err, userId: auth.userId, fixtureProvider: req.fixtureProvider },
          'editorial-panel-turn dispatch error',
        );
        write({ type: 'error', message });
      } finally {
        requestSignal.removeEventListener('abort', onAbort);
        if (!cancelled) {
          try {
            controller.close();
          } catch {
            // ignored
          }
        }
      }
    },
    cancel: () => {
      // Client disconnected; nothing to clean up beyond the closure above.
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders() });
}
