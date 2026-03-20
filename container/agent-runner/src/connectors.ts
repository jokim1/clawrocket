import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_DOCS_BASE_URL = 'https://docs.googleapis.com';
const GOOGLE_SHEETS_BASE_URL = 'https://sheets.googleapis.com';
const DEFAULT_MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_TOOL_RESULT_CHARS = 16_000;
const GOOGLE_REFRESH_SKEW_MS = 60_000;
const GOOGLE_TIMEOUT_MS = 10_000;
const MAX_GOOGLE_DOCS_BATCH_REQUESTS = 50;
const POSTHOG_TIMEOUT_MS = 15_000;
const MAX_POSTHOG_LIMIT = 1_000;
const DEFAULT_POSTHOG_LIMIT = 100;
const MAX_POSTHOG_RANGE_DAYS = 90;
const MAX_SHEETS_RANGE_LENGTH = 200;
const WEB_TALK_OUTPUT_BRIDGE_TIMEOUT_MS = 15_000;
const WEB_TALK_OUTPUT_BRIDGE_POLL_MS = 50;

type JsonMap = Record<string, unknown>;

type ContainerConnectorSecretPayload =
  | {
      kind: 'posthog';
      apiKey: string;
    }
  | {
      kind: 'google_docs';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    }
  | {
      kind: 'google_sheets';
      accessToken: string;
      refreshToken?: string;
      expiryDate?: string | null;
      scopes?: string[];
    };

type GoogleDocsSecret = Extract<
  ContainerConnectorSecretPayload,
  { kind: 'google_docs' }
>;
type GoogleSheetsSecret = Extract<
  ContainerConnectorSecretPayload,
  { kind: 'google_sheets' }
>;

export interface WebTalkConnectorBundle {
  connectors: Array<{
    id: string;
    name: string;
    connectorKind: 'google_docs' | 'google_sheets' | 'posthog';
    config: JsonMap | null;
    secret: ContainerConnectorSecretPayload;
  }>;
  toolDefinitions: Array<{
    connectorId: string;
    connectorKind: 'google_docs' | 'google_sheets' | 'posthog';
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

interface WebTalkOutputBridgeRequest {
  id: string;
  toolName: 'list_outputs' | 'read_output' | 'write_output';
  args: Record<string, unknown>;
}

interface WebTalkOutputBridgeResponse {
  id: string;
  result: string;
  isError?: boolean;
}

type WebTalkOutputToolName =
  | WebTalkOutputBridgeRequest['toolName'];

interface PostHogConnectorConfig {
  hostUrl: string;
  projectId: string;
}

interface GoogleSheetsConnectorConfig {
  spreadsheetId: string;
}

interface GoogleDocsConnectorConfig {
  documentId: string;
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
const googleDocsRefreshInFlight = new Map<string, Promise<GoogleDocsSecret>>();

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
              ((item as { connectorKind?: unknown }).connectorKind ===
                'google_docs' ||
                (item as { connectorKind?: unknown }).connectorKind ===
                  'posthog' ||
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

export function readWebTalkOutputBridgeDirFromEnv(): string | null {
  const raw = process.env.NANOCLAW_WEB_TALK_OUTPUT_BRIDGE_DIR;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function readWebTalkOutputToolNamesFromEnv(): WebTalkOutputToolName[] {
  const raw = process.env.NANOCLAW_WEB_TALK_OUTPUT_TOOL_NAMES;
  if (!raw) {
    return ['list_outputs', 'read_output', 'write_output'];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return ['list_outputs', 'read_output', 'write_output'];
    }
    const allowed = new Set<WebTalkOutputToolName>([
      'list_outputs',
      'read_output',
      'write_output',
    ]);
    const toolNames = parsed.filter(
      (value): value is WebTalkOutputToolName =>
        typeof value === 'string' &&
        allowed.has(value as WebTalkOutputToolName),
    );
    return toolNames.length > 0
      ? Array.from(new Set(toolNames))
      : ['list_outputs', 'read_output', 'write_output'];
  } catch {
    return ['list_outputs', 'read_output', 'write_output'];
  }
}

function writeBridgeRequest(
  bridgeDir: string,
  payload: WebTalkOutputBridgeRequest,
): void {
  const requestsDir = path.join(bridgeDir, 'requests');
  fs.mkdirSync(requestsDir, { recursive: true });
  const filePath = path.join(requestsDir, `${payload.id}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload));
  fs.renameSync(tempPath, filePath);
}

async function waitForBridgeResponse(
  bridgeDir: string,
  requestId: string,
): Promise<WebTalkOutputBridgeResponse> {
  const responsesDir = path.join(bridgeDir, 'responses');
  const responsePath = path.join(responsesDir, `${requestId}.json`);
  const deadline = Date.now() + WEB_TALK_OUTPUT_BRIDGE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(responsePath)) {
      const raw = fs.readFileSync(responsePath, 'utf-8');
      fs.unlinkSync(responsePath);
      return JSON.parse(raw) as WebTalkOutputBridgeResponse;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, WEB_TALK_OUTPUT_BRIDGE_POLL_MS),
    );
  }

  throw new ConnectorToolError(
    'output_bridge_timeout',
    'Timed out waiting for the Talk output bridge to respond.',
  );
}

async function executeOutputBridgeTool(
  bridgeDir: string,
  toolName: WebTalkOutputBridgeRequest['toolName'],
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  writeBridgeRequest(bridgeDir, {
    id: requestId,
    toolName,
    args,
  });
  const response = await waitForBridgeResponse(bridgeDir, requestId);
  return {
    content: response.result,
    isError: response.isError === true,
  };
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

function parseGoogleDocsConnectorConfig(
  config: JsonMap | null,
): GoogleDocsConnectorConfig | null {
  const documentId = readString(config?.documentId);
  if (!documentId) return null;
  return { documentId };
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

function isGoogleSecretExpired(
  secret: GoogleSheetsSecret | GoogleDocsSecret,
): boolean {
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

async function performGoogleDocsSecretRefresh(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
}): Promise<GoogleDocsSecret> {
  const secret = input.connector.secret;
  if (secret.kind !== 'google_docs') {
    throw new ConnectorToolError(
      'google_docs_credential_invalid',
      'Connector credential is not a Google Docs OAuth credential.',
    );
  }
  if (!secret.refreshToken) {
    throw new ConnectorToolError(
      'google_docs_refresh_unavailable',
      'Google Docs access token expired and no refresh token is available.',
    );
  }
  if (!input.googleOAuth?.clientId || !input.googleOAuth?.clientSecret) {
    throw new ConnectorToolError(
      'google_docs_refresh_unavailable',
      'Google OAuth client credentials are not configured for Docs token refresh.',
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
      'google_docs_refresh_failed',
      `Google Docs token refresh failed with HTTP ${response.status}.`,
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
      'google_docs_refresh_failed',
      'Google Docs token refresh did not return an access token.',
    );
  }

  const refreshed: GoogleDocsSecret = {
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

async function refreshGoogleDocsSecret(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  signal: AbortSignal;
}): Promise<GoogleDocsSecret> {
  const existing = googleDocsRefreshInFlight.get(input.connector.id);
  if (existing) {
    return waitForPromiseWithSignal(existing, input.signal);
  }

  const refreshPromise = performGoogleDocsSecretRefresh({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
  }).finally(() => {
    googleDocsRefreshInFlight.delete(input.connector.id);
  });
  googleDocsRefreshInFlight.set(input.connector.id, refreshPromise);
  return waitForPromiseWithSignal(refreshPromise, input.signal);
}

async function getGoogleDocsSecret(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  signal: AbortSignal;
}): Promise<GoogleDocsSecret> {
  if (input.connector.secret.kind !== 'google_docs') {
    throw new ConnectorToolError(
      'google_docs_credential_invalid',
      'Connector credential is not a Google Docs OAuth credential.',
    );
  }

  if (!isGoogleSecretExpired(input.connector.secret)) {
    return input.connector.secret;
  }

  return refreshGoogleDocsSecret(input);
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

async function fetchGoogleDocsJson(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  url: string;
  method?: 'GET' | 'POST';
  body?: string;
  signal: AbortSignal;
}): Promise<JsonMap> {
  let activeSecret = await getGoogleDocsSecret({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    signal: input.signal,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(input.url, {
      method: input.method || 'GET',
      headers: {
        authorization: `Bearer ${activeSecret.accessToken}`,
        accept: 'application/json',
        ...(input.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(input.body ? { body: input.body } : {}),
      signal: input.signal,
    });

    if (response.ok) {
      return readJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
    }

    if (
      attempt === 0 &&
      (response.status === 401 || response.status === 403) &&
      activeSecret.refreshToken
    ) {
      activeSecret = await refreshGoogleDocsSecret({
        connector: input.connector,
        googleOAuth: input.googleOAuth,
        signal: input.signal,
      });
      continue;
    }

    throw new ConnectorToolError(
      'google_docs_request_failed',
      `Google Docs request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  throw new ConnectorToolError(
    'google_docs_request_failed',
    'Google Docs request failed.',
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

function readGoogleDocParagraphText(paragraph: JsonMap): string {
  const elements = Array.isArray(paragraph.elements) ? paragraph.elements : [];
  return elements
    .map((element) => {
      const map = parseJsonMap(element);
      const textRun = parseJsonMap(map?.textRun);
      return typeof textRun?.content === 'string' ? textRun.content : '';
    })
    .join('')
    .trimEnd();
}

function extractGoogleDocText(elements: unknown[]): string {
  const blocks: string[] = [];

  for (const element of elements) {
    const map = parseJsonMap(element);
    if (!map) continue;

    const paragraph = parseJsonMap(map.paragraph);
    if (paragraph) {
      const text = readGoogleDocParagraphText(paragraph).trim();
      if (text) blocks.push(text);
      continue;
    }

    const table = parseJsonMap(map.table);
    if (table) {
      const rows = Array.isArray(table.tableRows) ? table.tableRows : [];
      for (const row of rows) {
        const rowMap = parseJsonMap(row);
        if (!rowMap) continue;
        const cells = Array.isArray(rowMap.tableCells) ? rowMap.tableCells : [];
        const cellTexts = cells
          .map((cell) => {
            const cellMap = parseJsonMap(cell);
            if (!cellMap) return '';
            const content = Array.isArray(cellMap.content)
              ? cellMap.content
              : [];
            return extractGoogleDocText(content).trim();
          })
          .filter(Boolean);
        if (cellTexts.length > 0) {
          blocks.push(cellTexts.join(' | '));
        }
      }
      continue;
    }

    const tableOfContents = parseJsonMap(map.tableOfContents);
    if (tableOfContents) {
      const content = Array.isArray(tableOfContents.content)
        ? tableOfContents.content
        : [];
      const text = extractGoogleDocText(content).trim();
      if (text) blocks.push(text);
    }
  }

  return blocks.join('\n\n');
}

async function fetchGoogleDoc(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  documentId: string;
  signal: AbortSignal;
}): Promise<{ title: string; text: string }> {
  const payload = await fetchGoogleDocsJson({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    url: joinUrl(
      GOOGLE_DOCS_BASE_URL,
      `/v1/documents/${encodeURIComponent(input.documentId)}`,
    ),
    signal: input.signal,
  });

  const title =
    typeof payload.title === 'string' && payload.title.trim()
      ? payload.title.trim()
      : input.documentId;
  const body = parseJsonMap(payload.body);
  const content = Array.isArray(body?.content) ? body.content : [];

  return {
    title,
    text: extractGoogleDocText(content),
  };
}

async function batchUpdateGoogleDoc(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  googleOAuth?: WebTalkConnectorBundle['googleOAuth'];
  documentId: string;
  requests: JsonMap[];
  writeControl: JsonMap | null;
  signal: AbortSignal;
}): Promise<JsonMap> {
  return fetchGoogleDocsJson({
    connector: input.connector,
    googleOAuth: input.googleOAuth,
    url: joinUrl(
      GOOGLE_DOCS_BASE_URL,
      `/v1/documents/${encodeURIComponent(input.documentId)}:batchUpdate`,
    ),
    method: 'POST',
    body: JSON.stringify({
      requests: input.requests,
      ...(input.writeControl ? { writeControl: input.writeControl } : {}),
    }),
    signal: input.signal,
  });
}

async function runPostHogQuery(input: {
  connector: WebTalkConnectorBundle['connectors'][number];
  config: PostHogConnectorConfig;
  query: string;
  limit: number;
  signal: AbortSignal;
}): Promise<JsonMap> {
  if (input.connector.secret.kind !== 'posthog') {
    throw new ConnectorToolError(
      'posthog_credential_invalid',
      'Connector credential is not a PostHog API key.',
    );
  }

  const finalQuery = injectLimitIfMissing(input.query, input.limit);

  const response = await fetch(
    joinUrl(
      input.config.hostUrl,
      `/api/projects/${encodeURIComponent(input.config.projectId)}/query/`,
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
          query: finalQuery,
        },
      }),
      signal: input.signal,
    },
  );

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new ConnectorToolError(
      'posthog_request_failed',
      `PostHog query failed with HTTP ${response.status}${errorBody ? `: ${errorBody.slice(0, 200)}` : ''}.`,
      response.status,
    );
  }

  return readJsonResponse(response, DEFAULT_MAX_RESPONSE_BYTES);
}

function injectLimitIfMissing(query: string, limit: number): string {
  const trimmed = query.replace(/[\s;]+$/, '');
  if (/\bLIMIT\s+\d+/i.test(trimmed)) {
    return query;
  }
  return `${trimmed} LIMIT ${limit}`;
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
  limit: number;
} {
  const input = parseJsonMap(value);
  const query = readString(input?.query);
  const dateFrom = readString(input?.dateFrom);
  const dateTo = readString(input?.dateTo);
  if (!query) {
    throw new ConnectorToolError(
      'posthog_query_invalid',
      'posthog_query requires a query string.',
    );
  }

  // Optional date guardrails: if the agent supplies both dateFrom/dateTo,
  // validate them to discourage unbounded queries, but keep the canonical
  // request payload limited to HogQL itself.
  if ((dateFrom && !dateTo) || (!dateFrom && dateTo)) {
    throw new ConnectorToolError(
      'posthog_query_invalid',
      'PostHog dateFrom/dateTo must be provided together when used.',
    );
  }
  if (dateFrom && dateTo) {
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
  }

  return {
    query,
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

function validateGoogleDocsBatchUpdateInput(value: unknown): {
  requests: JsonMap[];
  writeControl: JsonMap | null;
} {
  const input = parseJsonMap(value);
  const rawRequests = Array.isArray(input?.requests) ? input.requests : [];
  const requests = rawRequests.map((request) => parseJsonMap(request));
  if (requests.some((request) => !request)) {
    throw new ConnectorToolError(
      'google_docs_batch_update_invalid',
      'Google Docs batchUpdate requests must be JSON objects.',
    );
  }
  if (requests.length === 0) {
    throw new ConnectorToolError(
      'google_docs_batch_update_invalid',
      'Google Docs batchUpdate requires a non-empty requests array.',
    );
  }
  if (requests.length > MAX_GOOGLE_DOCS_BATCH_REQUESTS) {
    throw new ConnectorToolError(
      'google_docs_batch_update_invalid',
      `Google Docs batchUpdate supports at most ${MAX_GOOGLE_DOCS_BATCH_REQUESTS} requests per call.`,
    );
  }

  return {
    requests: requests as JsonMap[],
    writeControl: parseJsonMap(input?.writeControl),
  };
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

async function executeReadDocumentTool(
  connector: WebTalkConnectorBundle['connectors'][number],
  googleOAuth: WebTalkConnectorBundle['googleOAuth'] | undefined,
): Promise<ToolExecutionResult> {
  const config = parseGoogleDocsConnectorConfig(connector.config);
  if (!config) {
    return {
      content: 'Google Docs connector is missing documentId.',
      isError: true,
    };
  }

  const timed = createTimeoutSignal(GOOGLE_TIMEOUT_MS);
  try {
    const result = await fetchGoogleDoc({
      connector,
      googleOAuth,
      documentId: config.documentId,
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

async function executeBatchUpdateTool(
  connector: WebTalkConnectorBundle['connectors'][number],
  googleOAuth: WebTalkConnectorBundle['googleOAuth'] | undefined,
  args: unknown,
): Promise<ToolExecutionResult> {
  const config = parseGoogleDocsConnectorConfig(connector.config);
  if (!config) {
    return {
      content: 'Google Docs connector is missing documentId.',
      isError: true,
    };
  }

  const timed = createTimeoutSignal(GOOGLE_TIMEOUT_MS);
  try {
    const input = validateGoogleDocsBatchUpdateInput(args);
    const result = await batchUpdateGoogleDoc({
      connector,
      googleOAuth,
      documentId: config.documentId,
      requests: input.requests,
      writeControl: input.writeControl,
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
):
  | 'posthog_query'
  | 'list_sheets'
  | 'read_range'
  | 'read_document'
  | 'batch_update'
  | null {
  if (toolName.endsWith('__posthog_query')) return 'posthog_query';
  if (toolName.endsWith('__list_sheets')) return 'list_sheets';
  if (toolName.endsWith('__read_range')) return 'read_range';
  if (toolName.endsWith('__read_document')) return 'read_document';
  if (toolName.endsWith('__batch_update')) return 'batch_update';
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
            query: z
              .string()
              .describe(
                'HogQL query string with date filters in WHERE clause.',
              ),
            dateFrom: z
              .string()
              .optional()
              .describe(
                'Optional inclusive start date in YYYY-MM-DD format. Must be provided together with dateTo.',
              ),
            dateTo: z
              .string()
              .optional()
              .describe(
                'Optional inclusive end date in YYYY-MM-DD format. Must be provided together with dateFrom.',
              ),
            limit: z
              .number()
              .optional()
              .describe('Optional result row cap from 1 to 1000.'),
          },
          async (args: Record<string, unknown>) =>
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
          async (args: Record<string, unknown>) =>
            formatToolResult(
              await executeReadRangeTool(connector, bundle.googleOAuth, args),
            ),
        );
        break;
      case 'read_document':
        server.tool(
          tool.toolName,
          tool.description,
          {},
          async () =>
            formatToolResult(
              await executeReadDocumentTool(connector, bundle.googleOAuth),
            ),
        );
        break;
      case 'batch_update':
        server.tool(
          tool.toolName,
          tool.description,
          {
            requests: z
              .array(z.record(z.string(), z.unknown()))
              .describe(
                'Array of Google Docs API batchUpdate request objects.',
              ),
            writeControl: z
              .record(z.string(), z.unknown())
              .optional()
              .describe(
                'Optional Google Docs writeControl object for revision-guarded updates.',
              ),
          },
          async (args: Record<string, unknown>) =>
            formatToolResult(
              await executeBatchUpdateTool(
                connector,
                bundle.googleOAuth,
                args,
              ),
            ),
        );
        break;
    }
  }
}

export function registerOutputTools(
  server: McpServer,
  bridgeDir: string,
  allowedToolNames: WebTalkOutputToolName[],
): void {
  if (allowedToolNames.includes('list_outputs')) {
    server.tool(
      'list_outputs',
      'List saved Talk outputs as lightweight summaries.',
      {},
      async () =>
        formatToolResult(
          await executeOutputBridgeTool(bridgeDir, 'list_outputs', {}),
        ),
    );
  }

  if (allowedToolNames.includes('read_output')) {
    server.tool(
      'read_output',
      'Read a saved Talk output by outputId.',
      {
        outputId: z.string().describe('Saved Talk output ID.'),
      },
      async (args: Record<string, unknown>) =>
        formatToolResult(
          await executeOutputBridgeTool(bridgeDir, 'read_output', args),
        ),
    );
  }

  if (allowedToolNames.includes('write_output')) {
    server.tool(
      'write_output',
      'Create or update a saved Talk output using compare-and-swap versioning over the whole document.',
      {
        outputId: z
          .string()
          .optional()
          .describe(
            'Existing output ID for updates. Omit to create a new output.',
          ),
        title: z
          .string()
          .optional()
          .describe('Output title. Required for create. Optional for update.'),
        contentMarkdown: z
          .string()
          .optional()
          .describe('Markdown body. Required for create. Optional for update.'),
        expectedVersion: z
          .number()
          .int()
          .nonnegative()
          .describe(
            'Use 0 for create. For updates, use the current output version.',
          ),
      },
      async (args: Record<string, unknown>) =>
        formatToolResult(
          await executeOutputBridgeTool(bridgeDir, 'write_output', args),
        ),
    );
  }
}
