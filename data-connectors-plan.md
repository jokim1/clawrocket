# Plan: Data Connectors For Talk Agents (V8 — Revised)

## Overview

Add a "Data Connectors" system that lets users define external data sources at the org level, attach them to individual Talks, and have agents use them as tools at runtime.

**V1 scope: Google Sheets and PostHog.** Google Sheets uses full OAuth. PostHog uses API key auth. Schema/metadata discovery runs as part of the verify step.

**This plan is structured runtime-first.** The hardest part is making agents actually call tools, not the CRUD/UI layer.

Three deliverables:
1. **Runtime: host-side tool execution in DirectTalkExecutor** — add `tools` to LLM requests, handle `tool_use` response blocks, execute tool calls host-side with decrypted credentials, loop until the agent produces a final text response
2. **Backend: connector data model + API** — schema, CRUD, OAuth, verification with discovery
3. **Frontend: connector management + Talk binding UI** — sidebar link, admin page, Talk tab

---

## Part 1: Runtime — Host-Side Tool Execution

### Problem

`DirectTalkExecutor` currently sends plain prompt→response HTTP requests. The Anthropic request body (line 1356 of `direct-executor.ts`) includes `model`, `max_tokens`, `system`, `messages`, `stream` — but no `tools` parameter. There is no tool-call loop. Provider-backed agents cannot use tools today.

The container/agent-runner path explicitly disables MCP for `web_talk` mode (excluded from `allowedTools`, `mcpServers` not registered, single-turn enforced). Enabling MCP in the container would require multi-turn IPC changes and is out of scope for V1.

### V1 agent scope: provider-backed agents + claude_default reroute

There are two execution paths in `DirectTalkExecutor`:

1. **`claude_default`** (line 652): branches to `executeClaudeDefaultAttempt()`, which spawns a container via `this.runContainer()` with `toolProfile: 'web_talk'`. MCP is disabled, single-turn.
2. **Provider-backed** (line 680): iterates route steps and calls `executeAnthropicAttempt()` / `executeOpenAiAttempt()` — plain HTTP to external LLMs.

New talks default to `claude_default` (line 1684 in `llm-accessors.ts`), making it the most common agent type. Connector tools must work for these agents too.

### The auth model mismatch and why `claude_default` cannot simply use the provider HTTP path

The two execution paths use **completely separate auth stores**:

- **`claude_default`** (line 1089): calls `settingsService.getExecutorSecrets()`, which reads from the `settings_kv` table. `ExecutorAuthMode` resolves to one of three modes (line 1030 of `executor-settings.ts`):
  - `subscription` → `CLAUDE_CODE_OAUTH_TOKEN` (OAuth token from Anthropic login)
  - `api_key` → `ANTHROPIC_API_KEY` (user-provided API key)
  - `advanced_bearer` → `ANTHROPIC_AUTH_TOKEN` (auth token)
  - Plus an optional `ANTHROPIC_BASE_URL` for `api_key` and `advanced_bearer` modes only (line 1050, gated by `usesCustomBaseUrl()`).

- **Provider-backed** (line 789): calls `getProviderSecretByProviderId(step.provider.id)`, which reads from the `llm_provider_secrets` table. `decryptProviderSecret()` (line 797) returns a `ProviderSecretPayload` with `apiKey`. This is a completely separate table and encryption path.

There is no `llm_provider_secrets` entry for the virtual `provider.anthropic` that `claude_default` resolves to. Rerouting into the provider HTTP path would immediately throw `provider_request_missing_credentials`.

### V1 auth restriction: `api_key` and `advanced_bearer` only

The `subscription` mode OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`) has no proven direct HTTP path. The existing `ExecutorCredentialVerifier` (line 164 of `executor-credentials-verifier.ts`) dispatches `subscription` to `verifySubscription()` (line 239), which verifies through the **container path** — it spins up a container via `runContainerAgent()`. Only `api_key` and `advanced_bearer` go through `verifyHttpCredential()` (line 173), which makes direct HTTP calls with `x-api-key` or `Authorization: Bearer` headers respectively.

Since the subscription token may not be a valid Anthropic API Bearer token (Claude Code handles OAuth internally within the container), **V1 connector-enabled `claude_default` runs are restricted to `api_key` and `advanced_bearer` auth modes only.**

The connector-enabled `claude_default` path must still respect the existing executor blocked-reason logic first. Today `executeClaudeDefaultAttempt()` calls `settingsService.getExecutionBlockedReason()` before doing anything else. The tool-enabled path must do the same, because the executor can be misconfigured even when secret material exists (for example: multiple stored credential types requiring explicit auth-mode selection, or an invalid custom base URL).

The correct decision order is:
1. Call `getExecutionBlockedReason()`. If non-null, fail with `executor_not_configured` exactly like the existing container path.
2. Read the resolved auth mode from `getSettingsView()` (or a small helper extracted from the settings service).
3. If the resolved mode is `subscription`, fail with a connector-specific `connector_auth_mode_unsupported` error.
4. Only then build HTTP auth headers from `getExecutorSecrets()`.

If the executor is in `subscription` mode and connectors are attached, the run fails immediately with a clear error:

```typescript
// In executeClaudeDefaultWithTools(), before making any API call:
const blockedReason = settingsService.getExecutionBlockedReason();
if (blockedReason) {
  throw new TalkExecutorError('executor_not_configured', blockedReason);
}

const settingsView = settingsService.getSettingsView();
if (settingsView.executorAuthMode === 'subscription') {
  throw new TalkExecutorError(
    'connector_auth_mode_unsupported',
    'Data connectors require API key or Bearer token authentication. ' +
    'Subscription (OAuth) mode is not supported for connector-enabled talks. ' +
    'Update your Anthropic auth mode in Settings → Executor.',
  );
}

const executorSecrets = settingsService.getExecutorSecrets();
if (!executorSecrets.ANTHROPIC_API_KEY && !executorSecrets.ANTHROPIC_AUTH_TOKEN) {
  throw new TalkExecutorError(
    'connector_auth_mode_unsupported',
    'Data connectors require API key or Bearer token authentication. ' +
    'Subscription (OAuth) mode is not supported for connector-enabled talks. ' +
    'Update your Anthropic auth mode in Settings → Executor.',
  );
}
```

This restriction can be lifted if/when we confirm subscription tokens work as direct HTTP Bearer tokens. Non-connector `claude_default` talks continue to use the container path under all auth modes (unchanged).

### Solution: dedicated `executeClaudeDefaultWithTools()` method

Add a new method that reads credentials from the executor settings auth store and makes Anthropic API calls with `tools` included:

```typescript
// New method in DirectTalkExecutor:
private async executeClaudeDefaultWithTools(
  context: AttemptContext,
  talkConnectors: ConnectorRuntimeRecord[],
  talk: TalkRecord,
  signal: AbortSignal,
  emit: (event: TalkExecutionEvent) => void,
): Promise<TalkExecutorOutput> {
  // 1. Reuse executor blocked-reason logic
  // 2. Reject subscription mode for connector-enabled runs
  // 3. Get credentials from executor settings (NOT llm_provider_secrets)
  const executorSecrets = settingsService.getExecutorSecrets();

  // 4. Build auth headers from executor secrets
  const authHeaders = buildAnthropicAuthHeaders(executorSecrets);

  // 5. Resolve base URL (available for api_key/advanced_bearer only)
  const baseUrl = executorSecrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';

  // 6. Build tool definitions from connectors
  const toolDefinitions = buildToolDefinitions(talkConnectors);

  // 7. Enter tool-call loop (same loop as provider path, different auth)
  return this.executeToolCallLoop({
    baseUrl,
    authHeaders,
    modelId: context.modelId,
    toolDefinitions,
    talkConnectors,
    context,
    talk,
    signal,
    emit,
  });
}
```

`context.modelId` is not newly invented by this path. It reuses the same resolved model selection as the existing `claude_default` container path: `executeRun()` already resolves `modelId` from `resolved.modelId || primaryStep.model.model_id` before calling either execution branch. The new HTTP path must keep using that exact resolved model ID so Claude-default talks continue to honor the Talk's configured model.

The `buildAnthropicAuthHeaders()` helper maps executor secrets to HTTP headers. It only supports `api_key` and `advanced_bearer`:

```typescript
function buildAnthropicAuthHeaders(
  secrets: Record<string, string>,
): Record<string, string> {
  if (secrets.ANTHROPIC_API_KEY) {
    return {
      'x-api-key': secrets.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
  }
  if (secrets.ANTHROPIC_AUTH_TOKEN) {
    return {
      'Authorization': `Bearer ${secrets.ANTHROPIC_AUTH_TOKEN}`,
      'anthropic-version': '2023-06-01',
    };
  }
  // subscription mode (CLAUDE_CODE_OAUTH_TOKEN) — not supported for direct HTTP
  throw new TalkExecutorError(
    'connector_auth_mode_unsupported',
    'Data connectors require API key or Bearer token authentication. ' +
    'Subscription (OAuth) mode is not supported for connector-enabled talks. ' +
    'Update your Anthropic auth mode in Settings.',
  );
}
```

The execution flow in `executeRun()` becomes:

```typescript
const talkConnectors = listConnectorsForTalkRun(input.talkId);
const hasConnectors = talkConnectors.length > 0;

if (resolved.sourceKind === 'claude_default') {
  if (hasConnectors) {
    // Use dedicated method that reads from executor settings auth
    return this.executeClaudeDefaultWithTools(
      { input, agentId: resolved.agent.id, ... },
      talkConnectors, talk, signal, emit,
    );
  }
  // No connectors: use existing container path (unchanged)
  return this.executeClaudeDefaultAttempt(/* ... existing args ... */);
}
```

The tradeoff: rerouted `claude_default` runs lose container capabilities (Bash, file tools, etc.) for that run. For data-analysis talks this is acceptable — the agent gets connector tools instead. Non-connector talks continue to use the container path unchanged.

### Shared tool-call loop

Both `executeClaudeDefaultWithTools()` and the provider-backed path share the same `executeToolCallLoop()` method. The only difference is how credentials and base URL are resolved:

- `claude_default` with connectors: reads from `getExecutorSecrets()` → `buildAnthropicAuthHeaders()` (api_key/advanced_bearer only)
- Provider-backed: reads from `getProviderSecretByProviderId()` → `decryptProviderSecret()` → `{ 'x-api-key': secret.apiKey }`

The loop logic, tool execution, and message persistence are shared. The SSE parsing is **not** identical between Anthropic and OpenAI, so the loop needs an explicit provider-adapter boundary.

Add a provider-agnostic stream accumulator contract:

```typescript
type ToolLoopStopReason = 'end_turn' | 'tool_use';

type ParsedToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

type ToolLoopTurnResult = {
  stopReason: ToolLoopStopReason;
  text: string;                  // assistant text emitted during this turn
  toolCalls: ParsedToolCall[];   // empty unless stopReason === 'tool_use'
  usage?: TalkExecutionUsage;
  providerMessage: unknown;      // provider-native structured message for in-flight replay only
};

interface ToolLoopProviderAdapter {
  sendTurn(input: {
    baseUrl: string;
    authHeaders: Record<string, string>;
    modelId: string;
    maxOutputTokens: number;
    messages: unknown[];
    tools: unknown[];
    signal: AbortSignal;
    onTextDelta?: (deltaText: string) => void;
  }): Promise<ToolLoopTurnResult>;
}
```

Two concrete adapters implement it:
- `AnthropicToolLoopAdapter`: parses `content_block_start` / `input_json_delta` / `content_block_stop`
- `OpenAiToolLoopAdapter`: parses `choices[0].delta.tool_calls[index]`, accumulates `function.name` and chunked `function.arguments`, and treats `finish_reason === 'tool_calls'` as a strong hint rather than the sole signal

`executeToolCallLoop()` owns Talk event emission. Adapters only normalize provider streaming into `ToolLoopTurnResult` plus optional text-delta callbacks. That keeps the provider abstraction testable and avoids leaking Talk-specific event semantics into provider-specific code.

V1 tool looping therefore supports:
- Anthropic `anthropic_messages`
- OpenAI-compatible `openai_chat_completions` providers that actually emit tool-call deltas in the expected schema

If a provider claims `openai_chat_completions` compatibility but does not implement streamed `tool_calls` correctly, that should be treated as provider incompatibility and fail the run rather than silently degrading.

### Provider capability gate — fail closed at the run level

The existing `ModelCapabilities` type in `capabilities.ts` defines `supports_tools: boolean` (default: `false`), but it's completely unwired — no provider or model record references it.

**Fix: add a `supports_tools` column to `llm_provider_models`** (INTEGER NOT NULL DEFAULT 0). Before adding `tools` to a request, check the model's capability.

The correct behavior is:
- If a **current route step** does not support tools and connectors are attached, mark that step as unusable for this run and continue to the next eligible step.
- If **no route step** can run with tools, fail the run with a clear configuration error.
- Do **not** silently drop tools and continue on the same step.

```typescript
if (toolDefinitions.length > 0 && !modelRecord.supports_tools) {
  createLlmAttempt({
    ...attemptContext,
    status: 'skipped',
    failureClass: 'configuration',
  });
  continue;
}

// After all steps:
throw new TalkExecutorError(
  'route_lacks_tool_capable_steps',
  'Data connectors are attached to this talk, but none of the configured route steps support tool use.',
);
```

Silent degradation (removing tools and continuing on the same step) is wrong — it produces a normal-looking answer that ignores the attached data, misleading the user.

For V1, set `supports_tools = 1` for Anthropic Claude models and OpenAI GPT-4+ models. Other providers/models remain `0` by default.

For `claude_default`, this gate is implicit — `claude_default` always resolves to an Anthropic Claude model which supports tools. The gate is primarily relevant for provider-backed routes with custom models.

**UI surface for `supports_tools`**: The existing model settings flow must be extended so custom models can be marked tool-capable:

1. Add `supportsTools: boolean` to the model suggestion shape in `api.ts`:
   ```typescript
   // In AgentProviderCard (api.ts line 144):
   modelSuggestions: Array<{
     modelId: string;
     displayName: string;
     contextWindowTokens: number;
     defaultMaxOutputTokens: number;
     supportsTools: boolean;  // NEW
   }>;
   ```
2. Add `supportsTools` to the model validation in `talk-llm.ts` (line 63-79 — the `models.map()` that validates and sanitizes model entries):
   ```typescript
   // In the models.map() block:
   supportsTools: model.supportsTools === true,
   ```
3. Add `supports_tools` to the model read/write operations in `llm-accessors.ts` — INSERT, UPDATE, and SELECT queries for `llm_provider_models`.
4. Add a "Supports tool use" toggle in the provider model settings UI.
5. Default to `false` for custom models — user must explicitly opt in.
6. The `claudeModelSuggestions` in `AiAgentsPageData` also gets `supportsTools` (always `true` for Claude models).

### Step 1 — Build tool definitions from attached connectors

Before calling the LLM, query `listConnectorsForTalkRun(talkId)` to get attached, enabled, verified connectors. For each connector, generate tool definitions:

```typescript
// Google Sheets connector → tool:
{
  name: 'connector_{connectorId}__read_google_sheet',
  description: 'Read data from a Google Sheets spreadsheet. Returns cell values as JSON.',
  input_schema: {
    type: 'object',
    properties: {
      range: { type: 'string', description: 'A1 notation range, e.g. "Sheet1!A1:D10". Max 10,000 cells per request.' },
    },
    required: ['range'],
  },
}

// PostHog connector → tool (structured input — no free-form LIMIT/date rewriting):
{
  name: 'connector_{connectorId}__posthog_query',
  description: 'Run a HogQL query against PostHog analytics data. Returns results as JSON. Do NOT include LIMIT or date filters in the query — use the dedicated parameters instead.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'HogQL query string. Do NOT include LIMIT or date range filters — use the limit, dateFrom, dateTo parameters.',
      },
      dateFrom: {
        type: 'string',
        description: 'Start date in YYYY-MM-DD format (required). Max 90 days before dateTo.',
      },
      dateTo: {
        type: 'string',
        description: 'End date in YYYY-MM-DD format (required). Max 90 days after dateFrom.',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return, 1-1000. Default 100.',
      },
    },
    required: ['query', 'dateFrom', 'dateTo'],
  },
}
```

Tool names are namespaced with the connector ID to avoid collisions when multiple connectors of the same kind are attached.

PostHog V1 ships with `posthog_query` (HogQL) as the single tool. HogQL is general-purpose — the model can express trends, funnels, retention, etc. as queries without needing bespoke wrapper tools for each insight type. The PostHog MCP server is the long-term path for richer tool coverage.

`buildToolDefinitions()` should also use **bounded `discovered_json` hints** to improve tool choice without bloating context:
- Google Sheets: append a compact summary like `Available sheets: Revenue (1000x26), Users (500x10)` using only the first few discovered sheets.
- PostHog: append a compact summary like `Known events include: app_open, ftue_step_completed, extraction_started` using a short capped sample.
- Do not dump full discovery payloads into tool descriptions. Keep hints short enough that the tool-definition reserve from Step 1a remains reliable.

The structured PostHog input (`query`, `dateFrom`, `dateTo`, `limit`) avoids brittle heuristic rewriting of free-form HogQL. The executor injects the bounded filters server-side:
- Validate `dateFrom`/`dateTo` are valid ISO dates, `dateTo >= dateFrom`, and `dateTo - dateFrom <= 90 days`. Reject with error if invalid.
- Clamp `limit` to `[1, 1000]`, default `100` if omitted.
- Pass via PostHog's query API parameters: `{ query: { kind: 'HogQLQuery', query: userQuery }, limit, dateRange: { date_from: dateFrom, date_to: dateTo } }`. The PostHog API handles injection safely — no string concatenation of user-provided SQL.

### Step 1a — Reserve context budget for tool definitions

Attached tools consume context. The context assembler cannot spend the entire input budget on system prompt + history + current user message and then append tools for free.

Before selecting historical turns, reserve tokens for serialized tool definitions:

```typescript
function estimateToolDefinitionTokens(toolDefinitions: unknown[]): number {
  const serialized = JSON.stringify(toolDefinitions);
  return Math.ceil(serialized.length / 4) + 32; // framing cushion
}

const toolDefinitionReserve = estimateToolDefinitionTokens(toolDefinitions);
const inputBudgetTokens = Math.max(
  256,
  modelContextWindowTokens - maxOutputTokens - 256 - toolDefinitionReserve,
);
```

Rules:
- The reserve is computed from the actual built tool schemas, not a hard-coded constant.
- If the reserve alone makes the route unusable, fail with a clear configuration error instead of sending an oversized request.
- Historical replay selection and current-message admission both operate on the post-reserve budget.

### Step 2 — Message types for tool-use conversations

The current `PromptMessage` type is text-only:

```typescript
// Current (context-assembler.ts line 4):
interface PromptMessage { role: 'system' | 'user' | 'assistant'; text: string; }
```

This cannot represent tool-use turns. Extend with a provider-specific conversation state model:

```typescript
// New types for tool-use capable conversations:

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

// OpenAI equivalent:
type OpenAiToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type OpenAiMessage =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
```

These types are used **only within the in-flight tool-call loop** during a single run. They are NOT stored directly or used for historical replay (see "Context assembler extension" below for the replay strategy).

The existing `buildAnthropicMessages()` (line 577) continues to produce `{ role, content: string }` for the initial request. The tool-call loop manages the extended message types internally — it appends `AnthropicContentBlock[]` messages during the loop and collapses back to text for the final stored response.

### Step 3 — SSE handler extensions for tool-use

The shared loop does not parse raw SSE directly. Each provider-specific adapter implements the stream accumulator contract from "Shared tool-call loop" and returns a normalized `ToolLoopTurnResult`.

Current SSE parsing (line 1399) only handles `content_block_delta` with `delta.text`. Extend for tool-use:

**Anthropic streaming tool-use events:**
- `content_block_start` with `content_block.type === 'tool_use'` → start accumulating a tool call (capture `id`, `name`)
- `content_block_delta` with `delta.type === 'input_json_delta'` → append to tool call's `partial_json` accumulator
- `content_block_stop` → finalize the tool call block, parse accumulated JSON as input
- `message_delta` with `stop_reason === 'tool_use'` → trigger tool execution loop

**OpenAI streaming tool-use events:**
- `choices[0].delta.tool_calls` array → accumulate `function.name` and `function.arguments` chunks per tool call index
- If one or more tool calls have been fully accumulated by the end of the streamed turn, return `stopReason = 'tool_use'` even if an OpenAI-compatible provider reports a generic terminal finish reason
- `choices[0].finish_reason === 'tool_calls'` remains a strong positive signal, but not the only one
- `choices[0].finish_reason === 'stop'` or equivalent terminal finish → return `stopReason = 'end_turn'`

The SSE handler accumulates both text and tool-use content blocks during a single streamed response. Tool-use blocks are accumulated silently. Text handling is split into two cases:
- **Terminal assistant turn (`stop_reason === 'end_turn'`)**: emit normal `talk_response_started` / `talk_response_delta` / `talk_response_completed` events.
- **Intermediary tool-use turn (`stop_reason === 'tool_use'`)**: do **not** emit normal response-delta events to the UI. Persist the intermediary assistant/tool activity as timeline messages instead.

This split is required because the current Talk UI treats response deltas as the one live draft for a run. If intermediary tool-use text is streamed through the normal delta channel, the draft flickers, gets cleared by later `message_appended` events, and produces ghost text.

### Step 4 — Tool-call loop

```
loop (max 10 iterations):
  1. Send messages + tools to LLM (streaming)
  2. Accumulate response: text blocks + tool_use blocks
  3. If stop_reason === 'end_turn':
     a. Emit normal response streaming events for the FINAL assistant text only
     b. Store final assistant message as role='assistant'
        with `sequence_in_run = lastSequenceInRun + 1`
     c. Return final text
  4. If stop_reason === 'tool_use':
     a. Store the intermediary assistant turn as role='assistant'
        with RuntimeMessageMetadata(kind='assistant_tool_use')
     b. For each tool_use block:
        - Parse connector ID from tool name prefix (connector_{id}__)
        - Look up connector record + ciphertext from the pre-fetched run context
        - Decrypt credentials at point of use (not earlier)
        - Validate input against guardrails (range size, date range, limit — see Part 1a)
        - Execute the tool call against the external API
        - Build tool_result content block
        - Store tool_result as role='tool' with
          RuntimeMessageMetadata(kind='tool_result')
          and TRUNCATED content (see "Tool result persistence" below)
     c. Append assistant message + tool results to in-flight provider-native
        conversation state
     d. Continue loop
  5. If loop cap reached:
     a. Persist a final assistant warning message
        with `sequence_in_run = lastSequenceInRun + 1`
     b. Return the last accumulated safe text with a warning suffix
```

### Part 1b: Live run/event contract

To keep the Talk timeline coherent, V1 uses a strict event contract:

1. **Intermediary tool-use iterations** produce `message_appended` events only:
   - one `assistant` message with `metadata.kind = 'assistant_tool_use'`
   - one or more `tool` messages with `metadata.kind = 'tool_result'`
2. **Only the terminal assistant iteration** produces `talk_response_started`, `talk_response_delta`, and `talk_response_completed`.
3. The final persisted assistant message is appended after terminal streaming finishes, just like today.

This keeps live drafting semantics unchanged for the webapp while still showing tool activity in real time via appended timeline entries.

### Step 5 — Host-side tool executors

New file: `src/clawrocket/connectors/tool-executors.ts`

```typescript
interface ToolExecutionContext {
  connectorId: string;
  connectorKind: ConnectorKind;
  ciphertext: string;      // encrypted — decrypted at point of use
  config: Record<string, unknown>;
  signal: AbortSignal;
}

async function executeConnectorTool(
  toolName: string,       // e.g. 'read_google_sheet'
  toolInput: unknown,     // parsed from LLM tool_use
  context: ToolExecutionContext,
  fetchImpl?: typeof fetch,
): Promise<{ content: string; isError: boolean }>
```

For Google Sheets: decrypt → refresh token if expired → call `GET https://sheets.googleapis.com/v4/spreadsheets/{id}/values/{range}` with Bearer token.

For PostHog: decrypt → validate structured input (dateFrom, dateTo, limit) → call `POST {host}/api/projects/{projectId}/query` with `Authorization: Bearer {apiKey}` and structured HogQL query body including date range and limit parameters.

Each executor has a per-call timeout (Google Sheets: 10s, PostHog: 15s) and returns errors as `{ content: errorMessage, isError: true }` rather than throwing, so the model gets error feedback and can retry.

Tool-executor cancellation must be linked to the parent run cancellation signal:
- Compose the per-call timeout controller with the parent run signal.
- If the Talk run is cancelled while a Sheets/PostHog request is in flight, abort the external request immediately.
- Do not append stale runtime messages after the parent run has already transitioned to cancelled/failed.

### Part 1a: Server-Side Data Guardrails

Tool executors enforce hard limits **before** making external API calls. These are not just timeouts — they prevent a single bad tool call from destroying latency, context budget, and operator confidence.

**Google Sheets guardrails:**
- **Max cells per request**: 10,000 cells. The executor parses the A1 notation range, estimates cell count (`columns × rows`), and rejects with an error if over threshold. E.g., `Sheet1!A1:Z1000` = 26 × 1000 = 26,000 → rejected.
- **Max response body bytes**: 512 KB. If the Sheets API response body exceeds this, truncate and append `"[truncated — response exceeded 512KB limit]"`.
- **Per-call timeout**: 10s (abort controller on the fetch).

**PostHog guardrails (enforced via structured input, not heuristic rewriting):**
- **Date range validation**: `dateFrom` and `dateTo` are required structured parameters. The executor validates they are valid ISO dates, `dateTo >= dateFrom`, and `dateTo - dateFrom <= 90 days`. Reject with a clear error if invalid.
- **Limit enforcement**: `limit` parameter is clamped to `[1, 1000]`, default `100`. Injected via PostHog's query API parameters (not string concatenation).
- **Max response body bytes**: 512 KB. Truncate if exceeded.
- **Per-call timeout**: 15s (PostHog queries can be slower).

**General guardrails (all connectors):**
- **Max result payload for model context**: After receiving the API response, if the stringified result exceeds 8,000 tokens (estimated via char count / 4), truncate to 8,000 tokens and append `"[result truncated to fit context budget — {totalRows} rows total, showing first {shownRows}]"`. This prevents a single tool result from consuming the entire context window.
- These constants are defined in `tool-executors.ts` as named constants for easy tuning:
  ```typescript
  const GOOGLE_SHEETS_MAX_CELLS = 10_000;
  const POSTHOG_MAX_LIMIT = 1_000;
  const POSTHOG_DEFAULT_LIMIT = 100;
  const POSTHOG_MAX_DATE_RANGE_DAYS = 90;
  const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB
  const MAX_TOOL_RESULT_TOKENS = 8_000;
  const GOOGLE_SHEETS_TIMEOUT_MS = 10_000;
  const POSTHOG_TIMEOUT_MS = 15_000;
  const TOOL_RESULT_PERSIST_MAX_CHARS = 2_000;
  ```

### Tool result persistence — summary-only by default

The `talk_messages` table already supports `role = 'tool'` (line 418 of init.ts), but nothing writes tool messages today.

**Decision: persist runtime activity as assistant/tool timeline entries, but store tool results as TRUNCATED SUMMARIES, not full raw payloads.**

Storing full raw PostHog or Google Sheets results would duplicate external business/user data into the local talk store with no retention policy, no redaction rules, and no user notice. For V1, the default is summary-only persistence:

- **Intermediary assistant tool-use messages**: store as `role = 'assistant'`. `content` contains a short human-readable summary, and `metadata_json` carries the full tool-call arguments / provider payload needed for audit and UI display.
- **`kind: 'tool_result'` messages**: store as `role = 'tool'`. `content` is a **truncated summary** capped at `TOOL_RESULT_PERSIST_MAX_CHARS` (2,000 characters). If the raw result exceeds this, truncate and append `"[Full result not persisted — {totalRows} rows returned, {totalBytes} bytes]"`.
- The full raw result exists only in the **in-flight tool loop's memory** during the run. It is passed to the model for the current turn, then discarded. It does NOT persist to the DB.
- The audit trail shows "what the model asked to do" and "a summary of what came back," but not the full external data payload.

If full-audit persistence is needed later, it should be behind a connector-level `retainFullResults: boolean` config flag with a clear data-retention notice in the UI. For V1, summary-only is the safe default.

### Runtime message metadata schema

Runtime activity needs a metadata contract that works for both intermediary assistant tool-use turns and tool-result turns.

```typescript
type RuntimeMessageMetadata =
  | {
      kind: 'assistant_tool_use';
      loopIteration: number;
      sequenceInRun: number;
      displaySummary: string;   // e.g. "Checking FTUE funnel drop-off in PostHog"
      agentId: string;
      agentNickname: string;
      toolCalls: Array<{
        toolName: string;
        toolCallId: string;
        connectorId: string;
        connectorKind: ConnectorKind;
        displaySummary: string; // e.g. "Run retention query for last 30 days"
      }>;
      providerPayload?: {
        toolUseCount: number;
        toolUses: Array<{ id: string; name: string }>;
      }; // bounded debug payload, not raw provider response
    }
  | {
      kind: 'tool_result';
      loopIteration: number;
      sequenceInRun: number;
      toolName: string;
      toolCallId: string;
      connectorId: string;
      connectorKind: ConnectorKind;
      displaySummary: string;   // e.g. "Returned 40 rows" or "Error: date range too large"
      isError?: boolean;
      agentId: string;
      agentNickname: string;
      providerPayload?: {
        rowCount?: number;
        byteCount?: number;
        truncated: boolean;
      }; // bounded debug payload, not full raw result
    };
```

Key points:
- `sequenceInRun` is required for stable ordering within a run.
- The final assistant text message does **not** need this runtime metadata unless we later decide to add a `kind: 'assistant_final'` variant.
- `providerPayload` is debugging/audit data, not UI display data.
- `providerPayload` is always normalized and size-bounded. Do not persist raw provider SSE payloads or arbitrarily large nested objects in `metadata_json`.
- Cap serialized `providerPayload` at 4 KB. If the normalized payload would exceed that, persist an even smaller summary instead.

### Live event and API plumbing for runtime messages

The existing Talk message infrastructure does not carry metadata to the frontend. Four structures must be extended:

**1. `TalkMessage` API type** (`webapp/src/lib/api.ts` line 63):
```typescript
export type TalkMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdBy: string | null;
  createdAt: string;
  runId: string | null;
  agentId?: string | null;
  agentNickname?: string | null;
  metadata?: RuntimeMessageMetadata | null;
};
```

**2. `MessageAppendedEvent` SSE type** (`webapp/src/lib/talkStream.ts` line 7):
```typescript
export type MessageAppendedEvent = {
  // ... existing fields ...
  metadata?: RuntimeMessageMetadata | null;
};
```

**3. Runtime message insert + outbox helper** (`src/clawrocket/db/accessors.ts`):

The current helpers are split between plain `createTalkMessage()` and `appendAssistantMessageWithOutbox()`. For runtime activity, add a generic helper that can emit either an `assistant` or `tool` message with metadata and stable in-run ordering:

```typescript
function appendRuntimeTalkMessage(input: {
  id: string;
  talkId: string;
  runId: string;
  role: 'assistant' | 'tool';
  content: string;
  metadataJson?: string | null;
  sequenceInRun: number;
  createdAt: string;
}): void {
  // 1. INSERT into talk_messages with metadata_json + sequence_in_run
  // 2. INSERT into event_outbox with event_type='message_appended'
  //    and payload including parsed metadata
}
```

**4. API route for `listTalkMessages`** (`src/clawrocket/web/routes/talks.ts` line 290):

The existing `toApiRecord()` shaping function reads `metadata_json` only for `agentId`/`agentNickname`. Extend it to parse and return full `RuntimeMessageMetadata` for any message role when `metadata_json.kind` matches a runtime variant.

Without these four changes, runtime messages would persist in the DB but appear in the webapp as generic assistant/tool rows with no tool context, no grouping key, and no displaySummary.

### Context assembler extension — two-tier replay strategy

The context assembler (`context-assembler.ts`) must handle runtime messages in historical turns, but the approach differs between **in-flight** (current run) and **historical** (prior completed runs) contexts.

**In-flight replay (within a single run's tool-call loop):**

The tool-call loop maintains provider-native structured messages internally. Each loop iteration builds exact `AnthropicMessage[]` or `OpenAiMessage[]` sequences:
- Anthropic: `assistant(content: [tool_use blocks]) → user(content: [tool_result blocks])`
- OpenAI: `assistant(tool_calls: [...]) → tool(tool_call_id, content) messages`

These are the full raw results (in memory only, not persisted).

**Historical replay (prior completed runs across turns):**

Prior runtime activity is replayed as **summarized text**, not provider-native structured messages. This is the correct choice because:
1. The context assembler produces `{ role: 'user' | 'assistant'; text: string }` pairs.
2. Full raw results are not persisted (summary-only, per the retention policy), so native reconstruction is impossible.
3. A talk may switch providers between runs; text replay is provider-agnostic.

Budgeting note: the historical-turn selector operates on the already-reduced input budget after subtracting the tool-definition reserve from "Step 1a — Reserve context budget for tool definitions."

The `buildHistoricalTurns()` function must now group all messages in a run, not just the first user + first assistant pair:

```typescript
type HistoricalTurn = {
  runId: string;
  user: TalkMessageRecord;
  runtimeMessages: TalkMessageRecord[];   // ordered by sequence_in_run
  assistant: TalkMessageRecord;           // terminal assistant text only
};
```

Rules:
- Only replay **completed** runs with a terminal assistant text message.
- `runtimeMessages` include intermediary `assistant_tool_use` and `tool_result` entries, ordered by `sequence_in_run`.
- The terminal assistant is the last assistant message in the run that is **not** an intermediary `assistant_tool_use` message.
- Failed/cancelled runs with no terminal assistant are omitted from replay.

When building prompt pairs, runtime activity is collapsed to a compact summary prepended to the final assistant message:

```typescript
function buildAssistantTextWithRuntimeSummary(
  turn: HistoricalTurn,
): string {
  const summaryLines = turn.runtimeMessages
    .map((message) => parseRuntimeMetadata(message.metadata_json))
    .filter((meta): meta is RuntimeMessageMetadata => Boolean(meta))
    .filter((meta) => meta.kind === 'tool_result')
    .map((meta) => `[Tool: ${meta.toolName} -> ${meta.displaySummary}]`);

  if (summaryLines.length === 0) {
    return turn.assistant.content;
  }

  return `${summaryLines.join('\n')}\n\n${turn.assistant.content}`;
}
```

This keeps the assembler producing simple `{ role, text }` pairs while preserving tool context. Since tool summaries are short, they add minimal token overhead compared to raw results.

### Security: credentials never enter the agent process

All tool execution happens host-side in the Node.js process running `DirectTalkExecutor`. The agent only sees tool definitions (names + schemas) and tool results (data). Credentials are decrypted at the moment of each tool call and never placed in environment variables, message content, or any context the agent can observe.

### PostHog: MCP proxy as future option

PostHog has an official MCP server with HogQL, trends, session replay, and error tracking tools. V1 builds a native host-side executor for simplicity (one HogQL tool, no MCP dependency). The tool-executor interface is the same either way — upgrading to MCP proxy later doesn't change the agent-facing contract.

---

## Part 2: Data Model

### `data_connectors` table (org-level definitions)

```sql
CREATE TABLE IF NOT EXISTS data_connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connector_kind TEXT NOT NULL
    CHECK(connector_kind IN ('google_sheets', 'posthog')),
  config_json TEXT NOT NULL DEFAULT '{}',
  -- User-authored configuration only:
  --   google_sheets: { spreadsheetId }  (required — explicit sheet, no Drive listing)
  --   posthog:       { host, projectId }
  discovered_json TEXT,
  -- Server-written metadata from verify/discovery step:
  --   google_sheets: { title, sheets: [{ name, rowCount, columnCount }] }
  --   posthog:       { projectName, eventNames: [...], propertyNames: [...] }
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_data_connectors_kind
  ON data_connectors(connector_kind, enabled);
```

`config_json` and `discovered_json` are separate columns. User config is immutable except by explicit user edit. Discovery metadata is overwritten on each verify. No race conditions, no ambiguity about intent vs. observed state.

Google Sheets requires an explicit `spreadsheetId` in config — no Drive-wide listing. This follows Google's guidance on minimizing scope breadth and avoids requesting `drive.metadata.readonly`.

### `data_connector_secrets` table

```sql
CREATE TABLE IF NOT EXISTS data_connector_secrets (
  connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  -- Encrypted payload shape per kind:
  --   google_sheets: { kind: 'google_sheets', accessToken, refreshToken, expiresAt, scope }
  --   posthog:       { kind: 'posthog', apiKey }
  updated_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id)
);
```

### `data_connector_verifications` table

```sql
CREATE TABLE IF NOT EXISTS data_connector_verifications (
  connector_id TEXT PRIMARY KEY REFERENCES data_connectors(id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK(status IN ('missing', 'not_verified', 'verifying', 'verified', 'invalid', 'unavailable')),
  last_verified_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
```

`verifying` is required because verification is async. The OAuth callback and `POST /verify` route should immediately upsert `status = 'verifying'`, then the verifier worker resolves it to `verified` / `invalid` / `unavailable`. Duplicate verify requests while already verifying should return a cheap `already_verifying` / `scheduled: true` response rather than enqueueing duplicate work.

### `talk_data_connectors` table (Talk-level binding)

```sql
CREATE TABLE IF NOT EXISTS talk_data_connectors (
  talk_id TEXT NOT NULL REFERENCES talks(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL REFERENCES data_connectors(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL REFERENCES users(id),
  added_at TEXT NOT NULL,
  PRIMARY KEY (talk_id, connector_id)
);
CREATE INDEX IF NOT EXISTS idx_talk_data_connectors_connector
  ON talk_data_connectors(connector_id);
```

### Migration strategy

The four connector tables are purely additive — use `CREATE TABLE IF NOT EXISTS` in `initializeSchema()`. No reset function, no destructive migration.

Additionally, two existing tables need new columns:

```sql
-- Add supports_tools to llm_provider_models (idempotent)
ALTER TABLE llm_provider_models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0;

-- Add stable in-run ordering to talk_messages (idempotent)
ALTER TABLE talk_messages ADD COLUMN sequence_in_run INTEGER;
```

Wrapped in try-catch since SQLite throws if the column already exists.

After adding:
- seed `supports_tools = 1` for known tool-capable models (Anthropic Claude, OpenAI GPT-4+)
- runtime-emitted messages populate `sequence_in_run = 1..N` per run, including the terminal assistant message as the final `N`
- user messages can leave `sequence_in_run = NULL`
- `listTalkMessages()` and historical replay must order by `created_at ASC, COALESCE(sequence_in_run, 0) ASC, id ASC`

The ordering column is important. `created_at` alone is only millisecond precision, which is not reliable enough for multi-message tool loops.

---

## Part 3: Secret Encryption

The existing `decryptProviderSecret()` in `provider-secret-store.ts` hard-requires `payload.apiKey` (line 79) and throws if missing. A Google Sheets OAuth payload `{ accessToken, refreshToken, expiresAt, scope }` would fail decryption.

**Fix: extract generic AES-256-GCM crypto, then specialize.**

New file: `src/clawrocket/crypto/aes-gcm.ts`

```typescript
// Generic encrypt/decrypt — no payload shape validation
export function encryptJson(payload: unknown): string    // → JSON envelope { v, alg, iv, tag, data }
export function decryptJson(ciphertext: string): unknown  // → parsed JSON
```

Uses the same key derivation (`CLAWROCKET_PROVIDER_SECRET_KEY` + scrypt) and AES-256-GCM scheme.

Then:
- `provider-secret-store.ts` calls `encryptJson` / `decryptJson` and adds its `apiKey` validation on top (no behavioral change)
- `connector-secret-store.ts` calls `encryptJson` / `decryptJson` and validates with the `ConnectorSecretPayload` discriminated union:

```typescript
type ConnectorSecretPayload =
  | { kind: 'google_sheets'; accessToken: string; refreshToken: string; expiresAt: string; scope: string }
  | { kind: 'posthog'; apiKey: string };

export function encryptConnectorSecret(payload: ConnectorSecretPayload): string
export function decryptConnectorSecret(ciphertext: string): ConnectorSecretPayload
```

---

## Part 4: OAuth Flow (Google Sheets)

### OAuth state storage

The existing `oauth_state` table is reused. The `provider` column distinguishes login OAuth from connector OAuth: `provider = 'connector:google_sheets'`.

**Do not overload `return_to` with connector_id.** `return_to` is documented and used as a URL redirect path. Add a `context_json` column to `oauth_state` for arbitrary flow-specific metadata.

Since `oauth_state` already exists via `CREATE TABLE IF NOT EXISTS` (line 327 of init.ts), adding a column requires an explicit idempotent migration:

```typescript
// In initializeSchema(), after the CREATE TABLE block:
try {
  database.exec(`ALTER TABLE oauth_state ADD COLUMN context_json TEXT`);
} catch {
  // Column already exists — safe to ignore
}
```

For connector OAuth, `context_json = '{"connectorId":"abc123"}'`. For login OAuth, `context_json` is null.

### Google Sheets OAuth flow

**Env vars** (new in `config.ts`):
```
GOOGLE_SHEETS_OAUTH_CLIENT_ID
GOOGLE_SHEETS_OAUTH_CLIENT_SECRET
GOOGLE_SHEETS_OAUTH_REDIRECT_URI
```

**Scope**: `https://www.googleapis.com/auth/spreadsheets.readonly` only. No Drive scope — the user provides an explicit spreadsheet ID.

**Flow**:
1. `GET /api/v1/data-connectors/oauth/google_sheets/start?connectorId=X` → generates state, PKCE, stores in `oauth_state` with `context_json = {"connectorId":"X"}`, redirects to Google
2. Google redirects to `GET /api/v1/data-connectors/oauth/google_sheets/callback?code=...&state=...`
3. Callback: consume state atomically, exchange code for tokens, encrypt tokens, store in `data_connector_secrets`, kick off async verify, redirect to `/app/connectors?connected=X`

**Token refresh**: Before any API call, check `expiresAt`. If expired, refresh via `POST https://oauth2.googleapis.com/token` with `grant_type=refresh_token`. Update encrypted secret in DB.

Use a **per-connector single-flight promise cache**, not ad hoc mutex-or-race behavior:
- Maintain an in-memory `Map<connectorId, Promise<ConnectorSecretPayload>>`.
- If a refresh is already in flight for a connector, subsequent callers await the same promise instead of starting duplicate refreshes.
- On success, persist the refreshed encrypted secret and clear the in-flight entry.
- On failure, clear the in-flight entry and propagate the error.

This is the simplest correct behavior and avoids duplicate refresh calls and inconsistent writes.

### PostHog auth (API key)

No OAuth flow. User pastes a personal API key in the UI. Stored encrypted via `encryptConnectorSecret({ kind: 'posthog', apiKey })`. Same as LLM provider credential flow.

**Env var** (optional default):
```
POSTHOG_DEFAULT_HOST  — default: https://app.posthog.com
```

---

## Part 5: Connector Verifier + Schema Discovery

New file: `src/clawrocket/connectors/connector-verifier.ts`

Follows the `ProviderCredentialsVerifier` pattern.

When verification is requested:
1. Upsert `status = 'verifying'` immediately.
2. Execute verification/discovery asynchronously.
3. Resolve to `verified`, `invalid`, or `unavailable`.
4. If a verify is already in progress for the connector, return `already_verifying` / `scheduled: true` and do not start a duplicate run.

### Google Sheets verify + discovery

1. Decrypt secret, refresh access token if expired
2. Call `GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}?fields=properties.title,sheets.properties` with Bearer token
3. On success: extract spreadsheet title, sheet names/dimensions
4. Write to `discovered_json`: `{ title, sheets: [{ name, rowCount, columnCount }] }`
5. Update verification: `status = 'verified'`
6. On 401/403: `status = 'invalid'` (token revoked or expired refresh token)
7. On error/timeout: `status = 'unavailable'`

### PostHog verify + discovery

1. Decrypt secret (API key)
2. Call `GET {host}/api/projects/` with `Authorization: Bearer {apiKey}`
3. On success: extract project list, match `projectId` from config
4. If `projectId` set: call `GET {host}/api/projects/{projectId}/event_definitions/?limit=50` to discover event names
5. Write to `discovered_json`: `{ projectName, eventNames: [...] }`
6. Update verification status

---

## Part 6: API Surface

New route file: `src/clawrocket/web/routes/data-connectors.ts`

### Org-level connector management (admin/owner only)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/data-connectors` | List all connectors with verification + discovery |
| `POST` | `/api/v1/data-connectors` | Create connector (name + kind + config) |
| `PATCH` | `/api/v1/data-connectors/:id` | Update name/config |
| `DELETE` | `/api/v1/data-connectors/:id` | Delete (cascades from all Talks) |
| `PUT` | `/api/v1/data-connectors/:id/credential` | Set API key (PostHog) |
| `POST` | `/api/v1/data-connectors/:id/verify` | Test + discover schema |
| `GET` | `/api/v1/data-connectors/oauth/google_sheets/start` | Start Google OAuth |
| `GET` | `/api/v1/data-connectors/oauth/google_sheets/callback` | Google OAuth callback |

### Talk-level connector binding (admin/owner only for V1)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/talks/:talkId/data-connectors` | List attached connectors |
| `POST` | `/api/v1/talks/:talkId/data-connectors` | Attach connector |
| `DELETE` | `/api/v1/talks/:talkId/data-connectors/:connectorId` | Detach connector |

**Permission: admin/owner only for V1.** Attaching a connector effectively grants data access. Until per-connector sharing policy exists, restrict attach/detach to admins.

### API types

```typescript
type ConnectorKind = 'google_sheets' | 'posthog';

type VerificationStatus =
  | 'missing' | 'not_verified' | 'verifying' | 'verified' | 'invalid' | 'unavailable';

type DataConnectorCard = {
  id: string;
  name: string;
  connectorKind: ConnectorKind;
  config: Record<string, unknown>;           // user-authored
  discovered: Record<string, unknown> | null; // from verify/discovery
  enabled: boolean;
  hasCredential: boolean;
  credentialHint: string | null;
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
  lastVerificationError: string | null;
  createdAt: string;
  updatedAt: string;
};

type TalkDataConnector = {
  connectorId: string;
  name: string;
  connectorKind: ConnectorKind;
  enabled: boolean;
  verificationStatus: VerificationStatus;
  addedAt: string;
};
```

Response envelope: `{ ok: true, data: { ... } }`. All mutations get auth + CSRF + rate-limiting + idempotency.

`POST /api/v1/data-connectors/:id/verify` should return a scheduled-style payload rather than pretending verification completed inline:

```typescript
{ ok: true, data: { scheduled: true, status: 'verifying' } }
```

---

## Part 7: Frontend

### Sidebar: "Data Connectors" nav link

In `ClawTalkSidebar.tsx`, add `NavLink` to `/app/connectors` below "AI Agents". Permission gate: `canManageAgents` (owner/admin only).

### New page: `/app/connectors`

Follows the AI Agents page pattern. Owner/admin only.

**Connector list**: card per connector with name, kind badge, verification status dot, enabled toggle, discovered metadata inline.

**Add connector flow**:
1. Pick kind (Google Sheets or PostHog)
2. Enter display name
3. **Google Sheets**: enter spreadsheet ID (required), click "Connect with Google" → OAuth → return. Click "Verify" → discover sheet metadata.
4. **PostHog**: enter API key + host (default `app.posthog.com`) + project ID. Click "Verify" → discover events.

**Per-connector actions**: edit name/config, re-authenticate (Google Sheets), update API key (PostHog), verify, delete.

### Talk tab: "Data Connectors"

In `TalkDetailPage.tsx`:

1. `TabKey`: `'talk' | 'agents' | 'data-connectors' | 'runs'`
2. `getTabFromPath`: `pathname === \`${base}/data-connectors\`` → `'data-connectors'`
3. Tab bar: `Talk | Agents | Data Connectors | Run History`
4. Panel:
   - Attached connectors list with name, kind badge, verification status, "Detach" button
   - "Attach Connector" dropdown (admin/owner only): lists enabled org-level connectors not yet attached
   - Empty state text
   - "Manage Data Connectors" link to `/app/connectors` (admin/owner only)

### Tool call display in Talk timeline

Runtime activity is rendered from `metadata` on both assistant and tool messages:

- **`metadata.kind = 'assistant_tool_use'` on `role = 'assistant'`**: render as a collapsible "Tool Call" assistant block showing `displaySummary`, with expandable detail listing the planned tool calls and their arguments.
- **`metadata.kind = 'tool_result'` on `role = 'tool'`**: render as a collapsible "Tool Result" block showing `displaySummary`, with expandable detail showing the truncated result data. Error results (`isError: true`) get a warning/error style.
- Runtime blocks are grouped by `loopIteration` and ordered by `sequenceInRun`.
- The final free-text assistant answer remains the normal assistant bubble after the tool blocks.
- The `connectorKind` determines the icon (Google Sheets icon, PostHog icon).

Because intermediary tool-use turns do not emit normal response-delta events, the live draft in the Talk UI should only appear for the terminal assistant response. Tool activity appears live through appended timeline entries instead.

### Connector auth error UX

The Talk UI already renders run/live failure messages generically from `errorMessage`, so `connector_auth_mode_unsupported` does not require a brand-new rendering path. But V8 should explicitly preserve the actionable copy:

- If a run fails with `connector_auth_mode_unsupported`, surface the server-provided message in run history / live failure state.
- Keep the message explicit: "Data connectors require API key or Bearer token authentication... Update your Anthropic auth mode in Settings → Executor."
- Optionally add a lightweight "Open Executor Settings" affordance later, but it is not required for V1.

### Provider model settings: `supportsTools` toggle

In the LLM provider settings UI (where custom models are added/edited), add a "Supports tool use" toggle. This maps to the `supports_tools` column in `llm_provider_models`. For built-in providers (Anthropic, OpenAI GPT-4+), this is pre-set and read-only. For custom providers, the user must explicitly enable it.

---

## Part 8: DB Accessors

New file: `src/clawrocket/db/connector-accessors.ts`

```
// Org-level CRUD
createDataConnector(input)
getDataConnectorById(connectorId)
listDataConnectors() → DataConnectorCard[]
patchDataConnector(connectorId, patch: { name?, configJson?, enabled?, updatedBy })
patchDataConnectorDiscovery(connectorId, discoveredJson)
deleteDataConnector(connectorId)

// Secrets
setDataConnectorCredential(connectorId, ciphertext, updatedBy)
getDataConnectorCredential(connectorId) → { ciphertext } | undefined
deleteDataConnectorCredential(connectorId)
// Setting or replacing credentials also resets verification status to
// `not_verified` and clears any previous verification error/last_verified_at.

// Verification
upsertDataConnectorVerification(connectorId, status, lastError?)

// Talk binding
listTalkDataConnectors(talkId) → TalkDataConnector[]
attachDataConnectorToTalk(talkId, connectorId, userId)
detachDataConnectorFromTalk(talkId, connectorId)

// Runtime (server-only, called by DirectTalkExecutor)
listConnectorsForTalkRun(talkId) → ConnectorRuntimeRecord[]
// Returns enabled + verified connector records with ciphertext (NOT decrypted).
// Decryption happens in the executor/tool-executor at point of use,
// following the existing provider pattern (getProviderSecretByProviderId
// returns ciphertext, decryptProviderSecret is called in the verifier/executor).
// Exact runtime filter:
//   WHERE data_connectors.enabled = 1
//     AND data_connector_verifications.status = 'verified'
//     AND data_connector_secrets.ciphertext IS NOT NULL
//     AND talk_data_connectors.talk_id = ?

// Runtime message persistence
appendRuntimeTalkMessage(input: {
  id, talkId, runId, role, content, metadataJson, sequenceInRun, createdAt
}) → void
// INSERTs into talk_messages with role='assistant' or role='tool',
// metadata_json, and sequence_in_run, AND emits a message_appended
// outbox event with parsed metadata included.

// Talk message reads
listTalkMessages(input) → TalkMessageRecord[]
// Orders by created_at ASC, COALESCE(sequence_in_run, 0) ASC, id ASC
```

---

## Part 9: Config

New env vars in `config.ts`:

```typescript
export const GOOGLE_SHEETS_OAUTH_CLIENT_ID = ...
export const GOOGLE_SHEETS_OAUTH_CLIENT_SECRET = ...
export const GOOGLE_SHEETS_OAUTH_REDIRECT_URI = ...
export const POSTHOG_DEFAULT_HOST = ... // default: 'https://app.posthog.com'
```

Added to `readEnvFile()` list.

---

## File Changes

| File | Change |
|------|--------|
| `src/clawrocket/config.ts` | Add Google Sheets OAuth + PostHog env vars |
| `src/clawrocket/db/init.ts` | Add 4 new tables via `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE` for `oauth_state.context_json`, `llm_provider_models.supports_tools`, and `talk_messages.sequence_in_run` |
| `src/clawrocket/db/accessors.ts` | Add `sequence_in_run` to `TalkMessageRecord`, stable ordering in `listTalkMessages()`, and `appendRuntimeTalkMessage()` with outbox emit |
| `src/clawrocket/db/connector-accessors.ts` | **New** — connector CRUD, talk binding, runtime query |
| `src/clawrocket/db/llm-accessors.ts` | Add `supports_tools` to model INSERT/UPDATE/SELECT queries, snapshot shaping, and known-model catalog seeding |
| `src/clawrocket/crypto/aes-gcm.ts` | **New** — generic AES-256-GCM encrypt/decrypt |
| `src/clawrocket/llm/provider-secret-store.ts` | Refactor to use generic `aes-gcm.ts` (no behavioral change) |
| `src/clawrocket/llm/types.ts` | Add `supports_tools` to `LlmProviderModelRecord` |
| `src/clawrocket/llm/capabilities.ts` | Wire `supports_tools` check into executor |
| `src/clawrocket/connectors/connector-secret-store.ts` | **New** — type-safe connector secret encrypt/decrypt |
| `src/clawrocket/connectors/connector-oauth.ts` | **New** — Google Sheets OAuth initiation + callback |
| `src/clawrocket/connectors/connector-verifier.ts` | **New** — async verify + schema discovery with `verifying` / `already_verifying` handling |
| `src/clawrocket/connectors/tool-executors.ts` | **New** — host-side tool execution + guardrails (structured PostHog input, cell-count validation, byte/token caps) |
| `src/clawrocket/connectors/tool-definitions.ts` | **New** — build tool schemas from connector records (PostHog: structured `query`/`dateFrom`/`dateTo`/`limit`) |
| `src/clawrocket/talks/direct-executor.ts` | `executeClaudeDefaultWithTools()` with executor blocked-reason reuse, resolved-model reuse, `buildAnthropicAuthHeaders()`, subscription-mode rejection, shared `executeToolCallLoop()`, provider-specific stream adapters, final-only response streaming, runtime message persistence, SSE tool-use extensions |
| `src/clawrocket/talks/context-assembler.ts` | Run-level grouping with `runtimeMessages`, terminal-assistant selection, summarized historical replay, tool-aware turn cost budgeting, and tool-definition token reservation |
| `src/clawrocket/web/routes/data-connectors.ts` | **New** — all route handlers |
| `src/clawrocket/web/routes/talks.ts` | Extend `toApiRecord()` to parse and return `RuntimeMessageMetadata` for assistant/tool runtime messages |
| `src/clawrocket/web/routes/talk-llm.ts` | Add `supportsTools` to model validation in the provider settings snapshot/update path (line 63-79) |
| `src/clawrocket/web/server.ts` | Mount new routes with auth/CSRF/rate-limiting |
| `webapp/src/lib/api.ts` | Add `RuntimeMessageMetadata`, `metadata?: RuntimeMessageMetadata \| null` to `TalkMessage`, connector types, `verifying` status, and `supportsTools` model fields |
| `webapp/src/lib/talkStream.ts` | Add `metadata?: RuntimeMessageMetadata \| null` to `MessageAppendedEvent` |
| `webapp/src/pages/DataConnectorsPage.tsx` | **New** — org-level management page |
| `webapp/src/pages/TalkDetailPage.tsx` | Add Data Connectors tab, runtime message rendering using `metadata`, and final-only live draft behavior during tool loops |
| `webapp/src/components/ClawTalkSidebar.tsx` | Add "Data Connectors" nav link |
| `webapp/src/App.tsx` | Add `/app/connectors` route |
| `webapp/src/styles.css` | Connector card + kind badge + tool message styles |
| Provider settings UI files | Add `supportsTools` toggle to model creation/editing |
| Tests (new files) | Route tests, verifier tests, tool executor tests, guardrail tests, SSE tool-loop tests, provider-adapter tests, page tests, live event plumbing tests |

---

## Implementation Order

1. **Generic crypto extraction** — `aes-gcm.ts` + refactor `provider-secret-store.ts`
   Each PR from here forward ships with its own unit tests; tests are not deferred to the very end.
2. **Schema + shared types** — 4 new connector tables, `ALTER TABLE` migrations (`oauth_state.context_json`, `llm_provider_models.supports_tools`, `talk_messages.sequence_in_run`), `llm/types.ts`, `llm-accessors.ts`, `talk-llm.ts`
3. **Connector secrets + verifier** — `connector-secret-store.ts`, `connector-verifier.ts`, `verifying` state handling
4. **OAuth flow + connector routes** — `connector-oauth.ts`, callback routes, `data-connectors.ts`, route mounting
5. **Tool definitions + executors + guardrails** — `tool-definitions.ts`, `tool-executors.ts`
6. **Runtime message plumbing** — `appendRuntimeTalkMessage()`, `listTalkMessages()` ordering, `TalkMessage` / SSE metadata wiring
7. **DirectTalkExecutor tool loop** — executor blocked-reason reuse, subscription rejection, capability gate, provider adapters, final-only streaming, tool loop, runtime message persistence
8. **Context assembler extension** — run-level grouping, summarized historical replay, token budgeting including tool-definition reserve
9. **Frontend** — sidebar link, DataConnectorsPage, Talk tab, runtime timeline rendering, verifying state, `supportsTools` toggle, connector auth error copy
10. **Test hardening + cross-layer integration** — end-to-end edge cases across runtime, UI plumbing, and replay

Steps 1-4 are the "connector infra" PR. Steps 5-8 are the "runtime + plumbing" PR. Step 9 is the "UI" PR. Step 10 is the cross-layer integration and hardening PR. Or ship as one if the total diff is manageable.

---

## Testing Plan

### Auth path coverage (critical — covers supported `ExecutorAuthMode` variants)
- `claude_default` + connectors + `api_key` auth mode: verify `buildAnthropicAuthHeaders()` produces `x-api-key: <apiKey>`, request succeeds
- `claude_default` + connectors + `advanced_bearer` auth mode: verify produces `Authorization: Bearer <authToken>`, request succeeds
- `claude_default` + connectors + `subscription` auth mode: verify throws `connector_auth_mode_unsupported` (NOT a silent fallback)
- `claude_default` + connectors + `none` auth mode (no credentials): verify throws `executor_not_configured`
- `claude_default` + connectors + multiple stored credential types requiring explicit selection: verify throws `executor_not_configured`
- `claude_default` + connectors + invalid custom base URL: verify throws `executor_not_configured`
- `claude_default` + no connectors: verify container path used (unchanged behavior) under ALL auth modes
- Provider-backed + connectors: verify `llm_provider_secrets` path used, tools included
- Base URL: verify `ANTHROPIC_BASE_URL` used when present (api_key/advanced_bearer), default `api.anthropic.com` when absent

### Capability gate
- Connectors attached + first route step `supports_tools = 0` + later step `supports_tools = 1`: verify first step is skipped and later tool-capable step executes
- Connectors attached + all route steps `supports_tools = 0`: verify run fails with `route_lacks_tool_capable_steps` (NOT silent degradation)
- Connectors attached + `supports_tools = 1`: verify tools injected, loop executes
- No connectors + `supports_tools = 0`: verify run proceeds normally (no tool injection, no error)

### Guardrails
- Google Sheets: range exceeding 10,000 cells → rejected with error before API call
- Google Sheets: response > 512KB → truncated with warning
- PostHog structured input: missing `dateFrom`/`dateTo` → rejected
- PostHog: `dateTo - dateFrom > 90 days` → rejected with error
- PostHog: `limit > 1000` → clamped to 1000
- PostHog: `limit` omitted → default 100
- PostHog: date parameters injected via PostHog API (not string concat) → verify no SQL injection
- Both: response > 512KB raw → truncated
- Both: tool result > 8,000 tokens for model context → truncated with summary
- Per-call timeout: verify abort controller triggers on Google Sheets (10s) and PostHog (15s)
- Parent-signal cancellation: verify in-flight connector fetch aborts when the Talk run signal aborts
- Tool-definition reserve: verify large tool schemas reduce available history budget and prevent oversized requests
- `buildToolDefinitions()` uses bounded discovery hints without inflating tool descriptions unboundedly

### Runtime message persistence + metadata
- Verify intermediary assistant tool-use messages are stored as `role = 'assistant'` with `metadata.kind = 'assistant_tool_use'`
- Verify tool-result messages are stored as `role = 'tool'` with `metadata.kind = 'tool_result'`
- Verify `loopIteration`, `sequenceInRun`, `displaySummary`, `connectorId`, and `toolCallId` are populated
- Verify terminal assistant message is persisted with the highest `sequence_in_run` for its run
- Verify tool result `content` is truncated to 2,000 chars (full result not persisted)
- Verify `providerPayload` stays within the normalized bounded shape and does not persist raw provider payloads
- Verify API shaping (`toApiRecord()`) returns full runtime metadata to frontend for assistant/tool runtime messages
- Verify non-tool messages unaffected by metadata extension

### Live event plumbing
- Verify `message_appended` outbox events for assistant/tool runtime messages include `metadata` fields
- Verify `MessageAppendedEvent` SSE carries metadata to webapp
- Verify `TalkMessage` API response includes parsed `RuntimeMessageMetadata` for runtime messages
- Verify `TalkMessage` API response for non-tool messages has `metadata: null`
- Verify intermediary tool-use iterations do NOT emit normal `talk_response_delta` events
- Verify only the terminal assistant iteration emits `talk_response_started` / `talk_response_delta` / `talk_response_completed`

### Tool-call loop
- Single tool call, single iteration → final text response
- Multiple tool calls in one turn → all executed, results returned
- Multi-turn loop (tool → result → tool → result → text) → correct message assembly
- Multi-turn loop persists ordered assistant/tool runtime messages before the final assistant message
- Loop cap (10 iterations) → returns last text with warning
- Tool execution error → `isError: true` result returned to model, model retries or gracefully responds

### Context assembler — historical replay
- Verify historical runtime turns collapsed to text summary via `buildAssistantTextWithRuntimeSummary()`
- Verify summary format: `[Tool: toolName → displaySummary]` prepended to assistant text
- Verify turn cost includes summarized assistant text
- Verify turns without tool messages replay unchanged
- Verify runtime messages are ordered by `sequence_in_run`, not just timestamp
- Verify runs without a terminal assistant message are omitted from replay
- Verify tool-heavy turns that exceed budget are skipped entirely (not partially included)

### SSE streaming
- Anthropic: `content_block_start` → `input_json_delta` → `content_block_stop` → `message_delta(tool_use)` flow
- OpenAI: `tool_calls` delta accumulation, with accumulated tool calls treated as the authoritative signal for `stopReason = 'tool_use'`
- Provider adapters: Anthropic and OpenAI adapters both normalize into the same `ToolLoopTurnResult` shape
- OpenAI-compatible adapters treat accumulated `tool_calls` presence as the source of truth, not only `finish_reason === 'tool_calls'`
- Mixed text + tool_use blocks in single response

### OAuth + migrations
- `context_json` migration: test on fresh DB (column created with table) and existing DB (ALTER TABLE adds column)
- `supports_tools` migration: test on fresh DB and existing DB
- `sequence_in_run` migration: test on fresh DB and existing DB
- Google token refresh: expired token → refresh call → updated secret → serialization under concurrent requests
- Google token refresh single-flight: concurrent callers for one connector await the same in-flight refresh promise
- Connector verify endpoint: `status = 'verifying'` written immediately, duplicate verify requests return `already_verifying`
- Updating connector credentials resets verification status to `not_verified`
- `listConnectorsForTalkRun()` excludes `not_verified`, `verifying`, `invalid`, and `unavailable` connectors

### UI surface
- `supportsTools` toggle visible in custom model settings, not editable for built-in models
- Custom model with `supportsTools = false` + attached connectors → error shown in UI before run
- Connector cards render `verifying` state distinctly from `not_verified`
- Runtime timeline entries render with correct icons, collapsible blocks, ordering, and displaySummary from metadata
- Tool-loop runs do not show ghost/flickering live draft text before the terminal assistant response
- `connector_auth_mode_unsupported` surfaces the actionable backend message in live failure and run-history UI

---

## Future: Scheduled Data Jobs

The existing `startSchedulerLoop()` + `scheduled_tasks` table already supports recurring task execution via `runContainerAgent()`. Future "scheduled data pulls" should reuse this infrastructure rather than introducing a new job engine.

However, the current scheduler model uses `chat_jid` + `prompt` (designed for container-based tasks). A "run Talk X at 9am" job needs a `talk_id` + optional `target_agent_id` rather than a free-form prompt. The bridge: extend `scheduled_tasks` with a `talk_id` column and a code path that calls `enqueueTalkTurnAtomic()` (line 1505 of `accessors.ts`) to atomically create the user message + run records, then let the normal run worker and outbox flow handle execution. This is the reusable insertion point — it ensures the scheduled run goes through the same validation, outbox polling, and status tracking as a user-initiated turn. `TalkExecutor.execute()` requires an already-created run record and skips this pipeline, so it is the wrong entry point.

This is out of scope for the connector V1 PR but should reuse the existing scheduler, not create a parallel one.

---

## Future: Subscription Mode Support

The V1 restriction to `api_key`/`advanced_bearer` auth modes for connector-enabled talks can be lifted if either:
1. We confirm that `CLAUDE_CODE_OAUTH_TOKEN` works as a direct HTTP `Authorization: Bearer` token against `api.anthropic.com/v1/messages` (not just via the container).
2. We add a thin proxy path that routes connector tool calls through the container's Claude Code runtime, though this reintroduces the single-turn/MCP limitation.

Until then, subscription-mode users who want data connectors must configure an API key or Bearer token in Settings.
