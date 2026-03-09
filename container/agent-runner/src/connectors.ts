import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_SHEETS_BASE_URL = 'https://sheets.googleapis.com';
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_RESULT_CHARS = 16_000;
const GOOGLE_REFRESH_SKEW_MS = 60_000;
const GOOGLE_TIMEOUT_MS = 10_000;
const POSTHOG_TIMEOUT_MS = 15_000;
const MAX_POSTHOG_LIMIT = 1_000;
const DEFAULT_POSTHOG_LIMIT = 100;
const MAX_POSTHOG_RANGE_DAYS = 90;
const MAX_SHEETS_RANGE_LENGTH = 200;

type JsonMap = Record<string, unknown>;

type ContainerConnectorSecretPayload =
  | {
      kind: 'posthog';
      apiKey: string;
    }
  | {
      kind: 'google_sheets';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    };

type GoogleSheetsSecret = Extract<
  ContainerConnectorSecretPayload,
  { kind: 'google_sheets' }
>;

export interface WebTalkConnectorBundle {
  connectors: Array<{
    id: string;
    name: string;
    connectorKind: 'google_sheets' | 'posthog';
    config: JsonMap | null;
    secret: ContainerConnectorSecretPayload;
  }>;
  toolDefinitions: Array<{
    connectorId: string;
    connectorKind: 'google_sheets' | 'posthog';
    connectorName: string;
    toolName: string;
    description: string;
    inputSchema: JsonMap;
  }>;
  googleOAuth?: {
    clientId: string;
    clientSecret: string;
  };
}

interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

interface PostHogConnectorConfig {
  hostUrl: string;
  projectId: string;
}

interface GoogleSheetsConnectorConfig {
  spreadsheetId: string;
}

class ConnectorToolError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ConnectorToolError';
    this.code = code;
    this.status = status;
  }
}

const googleSheetsRefreshInFlight = new Map<
  string,
  Promise<GoogleSheetsSecret>
>();

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseJsonMap(value: unknown): JsonMap | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonMap)
    : null;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function serializeToolResult(value: unknown): string {
  const serialized =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) {
    return serialized;
  }

  const overflow = serialized.length - MAX_TOOL_RESULT_CHARS;
  return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}\n…truncated ${overflow} characters`;
}

function parseWebTalkConnectorBundleValue(
  value: unknown,
): WebTalkConnectorBundle | null {
  const parsed = parseJsonMap(value);
  if (!parsed) return null;

  const connectors = Array.isArray(parsed.connectors)
    ? parsed.connectors.filter(
        (item): item is WebTalkConnectorBundle['connectors'][number] =>
          Boolean(
            item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof (item as { id?: unknown }).id === 'string' &&
              typeof (item as { name?: unknown }).name === 'string' &&
              (((item as { connectorKind?: unknown }).connectorKind ===
                'posthog') ||
                (item as { connectorKind?: unknown }).connectorKind ===
                  'google_sheets'),
          ),
      )
    : [];

  const toolDefinitions = Array.isArray(parsed.toolDefinitions)
    ? parsed.toolDefinitions.filter(
        (item): item is WebTalkConnectorBundle['toolDefinitions'][number] =>
          Boolean(
            item &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              typeof (item as { connectorId?: unknown }).connectorId ===
                'string' &&
              typeof (item as { toolName?: unknown }).toolName === 'string' &&
              typeof (item as { description?: unknown }).description ===
                'string',
          ),
      )
    : [];

  if (connectors.length === 0 || toolDefinitions.length === 0) {
    return null;
  }

  const googleOAuthMap = parseJsonMap(parsed.googleOAuth);
  const googleOAuth =
    googleOAuthMap &&
    typeof googleOAuthMap.clientId === 'string' &&
    typeof googleOAuthMap.clientSecret === 'string'
      ? {
          clientId: googleOAuthMap.clientId,
          clientSecret: googleOAuthMap.clientSecret,
        }
      : undefined;

  return {
    connectors,
    toolDefinitions,
    googleOAuth,
  };
}

export function readWebTalkConnectorBundleFromEnv(): WebTalkConnectorBundle | null {
  const raw = process.env.NANOCLAW_WEB_TALK_CONNECTOR_BUNDLE;
  if (!raw) return null;
  try {
    return parseWebTalkConnectorBundleValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parsePostHogConnectorConfig(
  config: JsonMap | null,
): PostHogConnectorConfig | null {
  const hostUrl = readString(config?.hostUrl);
  const projectId = readString(config?.projectId);
  if (!hostUrl || !projectId) return null;
  return {
    hostUrl: hostUrl.replace(/\/+$/, ''),
    projectId,
  };
}

function parseGoogleSheetsConnectorConfig(
  config: JsonMap | null,
): GoogleSheetsConnectorConfig | null {
  const spreadsheetId = readString(config?.spreadsheetId);
  if (!spreadsheetId) return null;
  return { spreadsheetId };
}

function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort('connector_timeout');
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

async function readResponseText(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new ConnectorToolError(
        'connector_response_too_large',
        'Connector response exceeded the maximum allowed size.',
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel('connector_response_too_large').catch(() => undefined);
        throw new ConnectorToolError(
          'connector_response_too_large',
          'Connector response exceeded the maximum allowed size.',
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8',
  );
}

async function readJsonResponse(
  response: Response,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<JsonMap> {
  const text = await readResponseText(response, maxBytes);
  try {
    const parsed = JSON.parse(text) as unknown;
    const map = parseJsonMap(parsed);
    if (!map) {
      throw new Error('Connector response was not a JSON object.');
    }
    return map;
  } catch (error) {
    throw new ConnectorToolError(
      'connector_invalid_response',
      error instanceof Error
        ? error.message
        : 'Connector returned invalid JSON.',
    );
  }
}

function isGoogleSecretExpired(secret: GoogleSheetsSecret): boolean {
  if (!secret.expiryDate) return false;
  const expiresAt = Date.parse(secret.expiryDate);
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt <= Date.now() + GOOGLE_REFRESH_SKEW_MS;
}

async function waitForPromiseWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    throw new ConnectorToolError(
      'connector_timeout',
      'Connector request timed out.',
    );
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(
        new ConnectorToolError(
          'connector_timeout',
          'Connector request timed out.',
        ),
      );
    };
    signal.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function performGoogleSheetsSecretRefresh(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
}): Promise<GoogleSheetsSecret> {
  const secret = input.connector.secret;
  if (secret.kind !== 'google_sheets') {
    throw new ConnectorToolError(
      'google_sheets_credential_invalid',
      'Connector credential is not a Google Sheets OAuth credential.',
    );
  }
  if (!secret.refreshToken) {
    throw new ConnectorToolError(
      'google_sheets_refresh_unavailable',
      'Google Sheets access token expired and no refresh token is available.',
    );
  }
  if (!input.googleOAuth?.clientId || !input.googleOAuth?.clientSecret) {
    throw new ConnectorToolError(
      'google_sheets_refresh_unavailable',
      'Google OAuth client credentials are not configured for Sheets token refresh.',
    );
  }

  const body = new URLSearchParams({
    client_id: input.googleOAuth.clientId,
    client_secret: input.googleOAuth.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: secret.refreshToken,
  });

  const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new ConnectorToolError(
      'google_sheets_refresh_failed',
      `Google Sheets token refresh failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const payload = await readJsonResponse(response, 64 * 1024);
  const accessToken = readString(payload.access_token);
  const expiresIn =
    typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;

  if (!accessToken) {
    throw new ConnectorToolError(
      'google_sheets_refresh_failed',
      'Google Sheets token refresh did not return an access token.',
    );
  }

  const refreshed: GoogleSheetsSecret = {
    ...secret,
    accessToken,
    refreshToken:
      typeof payload.refresh_token === 'string'
        ? payload.refresh_token
        : secret.refreshToken,
    expiryDate: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };

  input.connector.secret = refreshed;
  return refreshed;
}

async function refreshGoogleSheetsSecret(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  signal: AbortSignal;
}): Promise<GoogleSheetsSecret> {
  const existing = googleSheetsRefreshInFlight.get(input.connector.id);
  if (existing) {
    return waitForPromiseWithSignal(existing, input.signal);
  }

  const refreshPromise = performGoogleSheetsSecretRefresh({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
  }).finally(() => {
    googleSheetsRefreshInFlight.delete(input.connector.id);
  });
  googleSheetsRefreshInFlight.set(input.connector.id, refreshPromise);
  return waitForPromiseWithSignal(refreshPromise, input.signal);
}

async function getGoogleSheetsSecret(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  signal: AbortSignal;
}): Promise<GoogleSheetsSecret> {
  if (input.connector.secret.kind !== 'google_sheets') {
    throw new ConnectorToolError(
      'google_sheets_credential_invalid',
      'Connector credential is not a Google Sheets OAuth credential.',
    );
  }

  if (!isGoogleSecretExpired(input.connector.secret)) {
    return input.connector.secret;
  }

  return refreshGoogleSheetsSecret(input);
}

async function fetchGoogleSheetsJson(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  url: string;
  signal: AbortSignal;
  maxBytes?: number;
}): Promise<JsonMap> {
  let activeSecret = await getGoogleSheetsSecret({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    signal: input.signal,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(input.url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${activeSecret.accessToken}`,
        accept: 'application/json',
      },
      signal: input.signal,
    });

    if (response.ok) {
      return readJsonResponse(response, input.maxBytes);
    }

    if (
      attempt === 0 &&
      (response.status === 401 || response.status === 403) &&
      activeSecret.refreshToken
    ) {
      activeSecret = await refreshGoogleSheetsSecret({
        connector: input.connector,
        googleOAuth: input.googleOAuth,
        signal: input.signal,
      });
      continue;
    }

    throw new ConnectorToolError(
      'google_sheets_request_failed',
      `Google Sheets request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  throw new ConnectorToolError(
    'google_sheets_request_failed',
    'Google Sheets request failed.',
  );
}

async function fetchGoogleSheetsMetadata(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  spreadsheetId: string;
  signal: AbortSignal;
}): Promise<JsonMap> {
  return fetchGoogleSheetsJson({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    url: joinUrl(
      GOOGLE_SHEETS_BASE_URL,
      `/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}?fields=sheets.properties`,
    ),
    signal: input.signal,
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });
}

async function fetchGoogleSheetRange(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  spreadsheetId: string;
  range: string;
  signal: AbortSignal;
}): Promise<JsonMap> {
  return fetchGoogleSheetsJson({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    url: joinUrl(
      GOOGLE_SHEETS_BASE_URL,
      `/v4/spreadsheets/${encodeURIComponent(
        input.spreadsheetId,
      )}/values/${encodeURIComponent(input.range)}`,
    ),
    signal: input.signal,
    maxBytes: DEFAULT_MAX_RESPONSE_BYTES,
  });
}

async function runPostHogQuery(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  config: PostHogConnectorConfig;
  query: string;
  dateFrom: string;
  dateTo: string;
  limit: number;
  signal: AbortSignal;
}): Promise<JsonMap> {
  if (input.connector.secret.kind !== 'posthog') {
    throw new ConnectorToolError(
      'posthog_credential_invalid',
      'Connector credential is not a PostHog API key.',
    );
  }

  const response = await fetch(
    joinUrl(
      input.config.hostUrl,
      `/api/projects/${encodeURIComponent(input.config.projectId)}/query`,
    ),
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.connector.secret.apiKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query: {
          kind: 'HogQLQuery',
          query: input.query,
        },
        limit: input.limit,
        dateRange: {
          date_from: input.dateFrom,
          date_to: input.dateTo,
        },
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    throw new ConnectorToolError(
      'posthog_request_failed',
      `PostHog query failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  return readJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
}

function parseDateOnly(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10) === value ? parsed : null;
}

function clampLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_POSTHOG_LIMIT;
  }
  return Math.max(1, Math.min(MAX_POSTHOG_LIMIT, Math.floor(value)));
}

function validatePostHogInput(value: unknown): {
  query: string;
  dateFrom: string;
  dateTo: string;
  limit: number;
} {
  const input = parseJsonMap(value);
  const query = readString(input?.query);
  const dateFrom = readString(input?.dateFrom);
  const dateTo = readString(input?.dateTo);
  if (!query || !dateFrom || !dateTo) {
    throw new ConnectorToolError(
      'posthog_query_invalid',
      'posthog_query requires query, dateFrom, and dateTo.',
    );
  }

  const fromDate = parseDateOnly(dateFrom);
  const toDate = parseDateOnly(dateTo);
  if (!fromDate || !toDate || toDate.valueOf() < fromDate.valueOf()) {
    throw new ConnectorToolError(
      'posthog_query_invalid',
      'PostHog dateFrom/dateTo must be valid YYYY-MM-DD values.',
    );
  }

  const diffDays =
    Math.floor((toDate.valueOf() - fromDate.valueOf()) / 86_400_000) + 1;
  if (diffDays > MAX_POSTHOG_RANGE_DAYS) {
    throw new ConnectorToolError(
      'posthog_query_invalid',
      'PostHog date range cannot exceed 90 days.',
    );
  }

  return {
    query,
    dateFrom,
    dateTo,
    limit: clampLimit(input?.limit),
  };
}

function validateRangeInput(value: unknown): string {
  const input = parseJsonMap(value);
  const range = readString(input?.range);
  if (!range) {
    throw new ConnectorToolError(
      'google_sheets_range_invalid',
      'read_range requires an A1-style range.',
    );
  }
  if (range.length > MAX_SHEETS_RANGE_LENGTH) {
    throw new ConnectorToolError(
      'google_sheets_range_invalid',
      'Google Sheets ranges must be 200 characters or fewer.',
    );
  }
  return range;
}

function mapToolError(error: unknown): ToolExecutionResult {
  return {
    content:
      error instanceof Error ? error.message : 'Connector request failed.',
    isError: true,
  };
}

async function executePostHogTool(
  connector: WebTalkConnectorBundle['connectors'][number],
  args: unknown,
): Promise<ToolExecutionResult> {
  const config = parsePostHogConnectorConfig(connector.config);
  if (!config) {
    return {
      content: 'PostHog connector is missing hostUrl or projectId.',
      isError: true,
    };
  }

  const timed = createTimeoutSignal(POSTHOG_TIMEOUT_MS);
  try {
    const input = validatePostHogInput(args);
    const result = await runPostHogQuery({
      connector,
      config,
      query: input.query,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      limit: input.limit,
      signal: timed.signal,
    });
    return {
      content: serializeToolResult(result),
      isError: false,
    };
  } catch (error) {
    return mapToolError(error);
  } finally {
    timed.dispose();
  }
}

async function executeListSheetsTool(
  connector: WebTalkConnectorBundle['connectors'][number],
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'],
): Promise<ToolExecutionResult> {
  const config = parseGoogleSheetsConnectorConfig(connector.config);
  if (!config) {
    return {
      content: 'Google Sheets connector is missing spreadsheetId.',
      isError: true,
    };
  }

  const timed = createTimeoutSignal(GOOGLE_TIMEOUT_MS);
  try {
    const result = await fetchGoogleSheetsMetadata({
      connector,
      googleOAuth,
      spreadsheetId: config.spreadsheetId,
      signal: timed.signal,
    });
    return {
      content: serializeToolResult(result),
      isError: false,
    };
  } catch (error) {
    return mapToolError(error);
  } finally {
    timed.dispose();
  }
}

async function executeReadRangeTool(
  connector: WebTalkConnectorBundle['connectors'][number],
  googleOAuth: WebTalkConnectorBundle['googleOAuth'] | undefined,
  args: unknown,
): Promise<ToolExecutionResult> {
  const config = parseGoogleSheetsConnectorConfig(connector.config);
  if (!config) {
    return {
      content: 'Google Sheets connector is missing spreadsheetId.',
      isError: true,
    };
  }

  const timed = createTimeoutSignal(GOOGLE_TIMEOUT_MS);
  try {
    const range = validateRangeInput(args);
    const result = await fetchGoogleSheetRange({
      connector,
      googleOAuth,
      spreadsheetId: config.spreadsheetId,
      range,
      signal: timed.signal,
    });
    return {
      content: serializeToolResult(result),
      isError: false,
    };
  } catch (error) {
    return mapToolError(error);
  } finally {
    timed.dispose();
  }
}

function parseToolOperation(
  toolName: string,
): 'posthog_query' | 'list_sheets' | 'read_range' | null {
  if (toolName.endsWith('__posthog_query')) return 'posthog_query';
  if (toolName.endsWith('__list_sheets')) return 'list_sheets';
  if (toolName.endsWith('__read_range')) return 'read_range';
  return null;
}

function formatToolResult(result: ToolExecutionResult): {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
} {
  return {
    content: [{ type: 'text', text: result.content }],
    ...(result.isError ? { isError: true } : {}),
  };
}

export function registerConnectorTools(
  server: McpServer,
  bundle: WebTalkConnectorBundle,
): void {
  const connectorsById = new Map(
    bundle.connectors.map((connector) => [connector.id, connector]),
  );

  for (const tool of bundle.toolDefinitions) {
    const connector = connectorsById.get(tool.connectorId);
    const operation = parseToolOperation(tool.toolName);
    if (!connector || !operation) continue;

    switch (operation) {
      case 'posthog_query':
        server.tool(
          tool.toolName,
          tool.description,
          {
            query: z.string().describe('HogQL query string.'),
            dateFrom: z
              .string()
              .describe('Inclusive start date in YYYY-MM-DD format.'),
            dateTo: z
              .string()
              .describe('Inclusive end date in YYYY-MM-DD format.'),
            limit: z
              .number()
              .optional()
              .describe('Optional result row cap from 1 to 1000.'),
          },
          async (args) =>
            formatToolResult(await executePostHogTool(connector, args)),
        );
        break;
      case 'list_sheets':
        server.tool(
          tool.toolName,
          tool.description,
          {},
          async () =>
            formatToolResult(
              await executeListSheetsTool(connector, bundle.googleOAuth),
            ),
        );
        break;
      case 'read_range':
        server.tool(
          tool.toolName,
          tool.description,
          {
            range: z
              .string()
              .describe(
                'A1-style range, for example Summary!A1:C20 or Sheet1!1:1.',
              ),
          },
          async (args) =>
            formatToolResult(
              await executeReadRangeTool(connector, bundle.googleOAuth, args),
            ),
        );
        break;
    }
  }
}
