import type { TalkRunConnectorRecord } from '../db/connector-accessors.js';

import type { ConnectorKind } from './types.js';

type JsonMap = Record<string, unknown>;

const TOOL_NAME_PREFIX = 'connector_';
const MAX_GOOGLE_HINT_SHEETS = 3;
const MAX_POSTHOG_HINT_EVENTS = 5;

export interface PostHogConnectorConfig {
  hostUrl: string;
  projectId: string;
}

export interface GoogleSheetsConnectorConfig {
  spreadsheetId: string;
  spreadsheetUrl: string | null;
}

export interface PostHogConnectorDiscovery {
  projectName: string | null;
  eventNames: string[];
}

export interface GoogleSheetDiscoveryItem {
  title: string;
  rowCount: number | null;
  columnCount: number | null;
}

export interface GoogleSheetsConnectorDiscovery {
  sheets: GoogleSheetDiscoveryItem[];
}

export interface ConnectorToolDefinition {
  connectorId: string;
  connectorKind: ConnectorKind;
  connectorName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : null;
}

export function parsePostHogConnectorConfig(
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

export function parseGoogleSheetsConnectorConfig(
  config: JsonMap | null,
): GoogleSheetsConnectorConfig | null {
  const spreadsheetId = readString(config?.spreadsheetId);
  if (!spreadsheetId) return null;
  return {
    spreadsheetId,
    spreadsheetUrl: readString(config?.spreadsheetUrl),
  };
}

export function parsePostHogDiscovery(
  discovered: JsonMap | null,
): PostHogConnectorDiscovery {
  const projectName = readString(discovered?.projectName);
  const eventNames = Array.isArray(discovered?.eventNames)
    ? discovered.eventNames.filter((value): value is string => typeof value === 'string')
    : [];

  return {
    projectName,
    eventNames,
  };
}

export function parseGoogleSheetsDiscovery(
  discovered: JsonMap | null,
): GoogleSheetsConnectorDiscovery {
  const sheets = Array.isArray(discovered?.sheets)
    ? discovered.sheets
        .map((item) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return null;
          }
          const title = readString((item as JsonMap).title);
          if (!title) return null;
          return {
            title,
            rowCount: readNumber((item as JsonMap).rowCount),
            columnCount: readNumber((item as JsonMap).columnCount),
          } satisfies GoogleSheetDiscoveryItem;
        })
        .filter((item): item is GoogleSheetDiscoveryItem => Boolean(item))
    : [];

  return { sheets };
}

function buildGoogleSheetsHint(connector: TalkRunConnectorRecord): string {
  const discovery = parseGoogleSheetsDiscovery(connector.discovered);
  if (discovery.sheets.length === 0) {
    return `Connector "${connector.name}" (Google Sheets).`;
  }

  const preview = discovery.sheets
    .slice(0, MAX_GOOGLE_HINT_SHEETS)
    .map((sheet) => {
      const dims =
        sheet.rowCount !== null && sheet.columnCount !== null
          ? ` (${sheet.rowCount}x${sheet.columnCount})`
          : '';
      return `${sheet.title}${dims}`;
    })
    .join(', ');

  return `Connector "${connector.name}" (Google Sheets). Sheets include: ${preview}.`;
}

function buildPostHogHint(connector: TalkRunConnectorRecord): string {
  const config = parsePostHogConnectorConfig(connector.config);
  const discovery = parsePostHogDiscovery(connector.discovered);
  const projectLabel =
    discovery.projectName ||
    (config ? `project ${config.projectId}` : 'configured project');
  const events = discovery.eventNames.slice(0, MAX_POSTHOG_HINT_EVENTS);

  if (events.length === 0) {
    return `Connector "${connector.name}" (PostHog, ${projectLabel}).`;
  }

  return `Connector "${connector.name}" (PostHog, ${projectLabel}). Known events: ${events.join(', ')}.`;
}

function buildToolName(
  connectorId: string,
  operation: 'posthog_query' | 'list_sheets' | 'read_range',
): string {
  return `${TOOL_NAME_PREFIX}${connectorId}__${operation}`;
}

export function parseConnectorToolName(toolName: string): {
  connectorId: string;
  operation: 'posthog_query' | 'list_sheets' | 'read_range';
} | null {
  if (!toolName.startsWith(TOOL_NAME_PREFIX)) return null;
  const suffix = toolName.slice(TOOL_NAME_PREFIX.length);
  const delimiter = suffix.indexOf('__');
  if (delimiter <= 0) return null;
  const connectorId = suffix.slice(0, delimiter);
  const operation = suffix.slice(delimiter + 2);
  if (
    operation !== 'posthog_query' &&
    operation !== 'list_sheets' &&
    operation !== 'read_range'
  ) {
    return null;
  }
  return {
    connectorId,
    operation,
  };
}

export function buildConnectorToolDefinitions(
  connectors: TalkRunConnectorRecord[],
): ConnectorToolDefinition[] {
  const definitions: ConnectorToolDefinition[] = [];

  for (const connector of connectors) {
    if (connector.connectorKind === 'posthog') {
      definitions.push({
        connectorId: connector.id,
        connectorKind: connector.connectorKind,
        connectorName: connector.name,
        toolName: buildToolName(connector.id, 'posthog_query'),
        description: `${buildPostHogHint(connector)} Run a bounded read-only HogQL query. Use dateFrom/dateTo/limit parameters instead of embedding date filters or LIMIT in the query.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'HogQL query string. Do not include LIMIT or date filters directly in the query.',
            },
            dateFrom: {
              type: 'string',
              description:
                'Inclusive start date in YYYY-MM-DD format. Must be within 90 days of dateTo.',
            },
            dateTo: {
              type: 'string',
              description:
                'Inclusive end date in YYYY-MM-DD format. Must be within 90 days of dateFrom.',
            },
            limit: {
              type: 'number',
              description: 'Optional result row cap from 1 to 1000. Defaults to 100.',
            },
          },
          required: ['query', 'dateFrom', 'dateTo'],
        },
      });
      continue;
    }

    const hint = buildGoogleSheetsHint(connector);
    definitions.push({
      connectorId: connector.id,
      connectorKind: connector.connectorKind,
      connectorName: connector.name,
      toolName: buildToolName(connector.id, 'list_sheets'),
      description: `${hint} Return the current sheet names and dimensions for this spreadsheet.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
      },
    });
    definitions.push({
      connectorId: connector.id,
      connectorKind: connector.connectorKind,
      connectorName: connector.name,
      toolName: buildToolName(connector.id, 'read_range'),
      description: `${hint} Read a bounded A1-style range from this spreadsheet. Read headers with ranges like SheetName!1:1.`,
      inputSchema: {
        type: 'object',
        properties: {
          range: {
            type: 'string',
            description: 'A1-style range, for example Summary!A1:C20 or Sheet1!1:1.',
          },
        },
        required: ['range'],
      },
    });
  }

  return definitions;
}
