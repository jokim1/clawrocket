import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
  '@modelcontextprotocol/sdk/server/mcp.js',
  () => ({
    McpServer: class {},
  }),
  { virtual: true },
);

class FakeMcpServer {
  readonly registrations = new Map<
    string,
    {
      schema: Record<string, unknown>;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }
  >();

  tool(
    name: string,
    _description: string,
    schema: Record<string, unknown>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.registrations.set(name, { schema, handler });
  }
}

function createPostHogBundle() {
  return {
    connectors: [
      {
        id: 'connector-posthog',
        name: 'FTUE PostHog',
        connectorKind: 'posthog' as const,
        config: {
          hostUrl: 'https://us.posthog.com/',
          projectId: '250736',
        },
        secret: {
          kind: 'posthog' as const,
          apiKey: 'phc_test_key',
        },
      },
    ],
    toolDefinitions: [
      {
        connectorId: 'connector-posthog',
        connectorKind: 'posthog' as const,
        connectorName: 'FTUE PostHog',
        toolName: 'connector_connector-posthog__posthog_query',
        description: 'Run a PostHog HogQL query.',
        inputSchema: {},
      },
    ],
  };
}

async function loadConnectorsModule() {
  vi.resetModules();
  return import('../container/agent-runner/src/connectors.ts');
}

describe('container PostHog connector runtime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('registers PostHog query with optional date fields and canonical request shape', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://us.posthog.com/api/projects/250736/query/',
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        query: {
          kind: 'HogQLQuery',
          query: 'SELECT event FROM events LIMIT 5',
        },
      });

      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new FakeMcpServer();
    const { registerConnectorTools } = await loadConnectorsModule();
    registerConnectorTools(server as never, createPostHogBundle());

    const registration = server.registrations.get(
      'connector_connector-posthog__posthog_query',
    );
    expect(registration).toBeTruthy();
    expect(
      (
        registration?.schema.dateFrom as {
          safeParse: (value: unknown) => { success: boolean };
        }
      ).safeParse(undefined).success,
    ).toBe(true);
    expect(
      (
        registration?.schema.dateTo as {
          safeParse: (value: unknown) => { success: boolean };
        }
      ).safeParse(undefined).success,
    ).toBe(true);

    const result = (await registration?.handler({
      query: 'SELECT event FROM events',
      limit: 5,
    })) as {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    };

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('"results"');
  });

  it('surfaces PostHog error bodies instead of a bare HTTP status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return new Response('Bad Request: unexpected field "dateRange"', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        });
      }),
    );

    const server = new FakeMcpServer();
    const { registerConnectorTools } = await loadConnectorsModule();
    registerConnectorTools(server as never, createPostHogBundle());

    const registration = server.registrations.get(
      'connector_connector-posthog__posthog_query',
    );
    const result = (await registration?.handler({
      query: 'SELECT 1',
    })) as {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('HTTP 400');
    expect(result.content[0]?.text).toContain('unexpected field "dateRange"');
  });

  it('requires PostHog dateFrom/dateTo to be provided together', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('fetch should not be called');
    });
    vi.stubGlobal('fetch', fetchMock);

    const server = new FakeMcpServer();
    const { registerConnectorTools } = await loadConnectorsModule();
    registerConnectorTools(server as never, createPostHogBundle());

    const registration = server.registrations.get(
      'connector_connector-posthog__posthog_query',
    );
    const result = (await registration?.handler({
      query: 'SELECT 1',
      dateFrom: '2026-01-01',
    })) as {
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('provided together');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
