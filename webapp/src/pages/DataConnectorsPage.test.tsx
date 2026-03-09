import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import { DataConnectorsPage } from './DataConnectorsPage';
import type { DataConnector } from '../lib/api';

describe('DataConnectorsPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders connectors and creates a new PostHog connector', async () => {
    const user = userEvent.setup();
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Data Connectors' });
    expect(screen.getByText('FTUE PostHog')).toBeTruthy();

    const addCard = screen.getByRole('heading', { name: 'Add Connector' }).closest('article');
    if (!addCard) {
      throw new Error('Expected Add Connector card');
    }

    await user.clear(within(addCard).getByLabelText('Name'));
    await user.type(within(addCard).getByLabelText('Name'), 'Economy PostHog');
    await user.click(within(addCard).getByRole('button', { name: 'Create Connector' }));

    expect(await screen.findByText('Economy PostHog')).toBeTruthy();
    expect(
      screen.getByText('Economy PostHog connector created.'),
    ).toBeTruthy();
  });

  it('saves a credential and deletes a connector', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    installDataConnectorsFetch();

    render(
      <MemoryRouter initialEntries={['/app/connectors']}>
        <DataConnectorsPage onUnauthorized={vi.fn()} userRole="owner" />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Data Connectors' });
    const connectorCard = screen
      .getByRole('heading', { name: 'FTUE PostHog' })
      .closest('article');
    if (!connectorCard) {
      throw new Error('Expected FTUE PostHog card');
    }

    await user.type(within(connectorCard).getByLabelText('PostHog API Key'), 'phc_new_key');
    await user.click(within(connectorCard).getByRole('button', { name: 'Save API Key' }));
    expect(
      await screen.findByText('FTUE PostHog credential saved.'),
    ).toBeTruthy();

    await user.click(within(connectorCard).getByRole('button', { name: 'Delete' }));
    expect(
      await screen.findByText('FTUE PostHog connector deleted.'),
    ).toBeTruthy();
    expect(screen.queryByText('FTUE PostHog')).toBeNull();
  });
});

function installDataConnectorsFetch() {
  let connectors: DataConnector[] = [
    {
      id: 'connector-posthog',
      name: 'FTUE PostHog',
      connectorKind: 'posthog',
      config: {
        hostUrl: 'https://us.posthog.com',
        projectId: '12345',
      },
      discovered: null,
      enabled: true,
      hasCredential: true,
      verificationStatus: 'not_verified',
      lastVerifiedAt: null,
      lastVerificationError: null,
      attachedTalkCount: 2,
      createdAt: '2026-03-06T00:00:00.000Z',
      updatedAt: '2026-03-06T00:00:00.000Z',
    },
  ];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.toString()
            : request instanceof Request
              ? request.url
              : String(request);
      const method = init?.method || 'GET';

      if (url.endsWith('/api/v1/data-connectors') && method === 'GET') {
        return jsonResponse(200, {
          ok: true,
          data: { connectors },
        });
      }

      if (url.endsWith('/api/v1/data-connectors') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}')) as {
          name: string;
          connectorKind: DataConnector['connectorKind'];
          config?: Record<string, unknown>;
          enabled?: boolean;
        };
        const created: DataConnector = {
          id: `connector-${connectors.length + 1}`,
          name: body.name,
          connectorKind: body.connectorKind,
          config: body.config || {},
          discovered: null,
          enabled: body.enabled !== false,
          hasCredential: false,
          verificationStatus: 'missing',
          lastVerifiedAt: null,
          lastVerificationError: null,
          attachedTalkCount: 0,
          createdAt: '2026-03-06T01:00:00.000Z',
          updatedAt: '2026-03-06T01:00:00.000Z',
        };
        connectors = [created, ...connectors];
        return jsonResponse(201, {
          ok: true,
          data: { connector: created },
        });
      }

      if (
        url.includes('/api/v1/data-connectors/') &&
        url.endsWith('/credential') &&
        method === 'PUT'
      ) {
        const connectorId = url.split('/api/v1/data-connectors/')[1]?.split('/credential')[0];
        const body = JSON.parse(String(init?.body || '{}')) as {
          apiKey?: string | null;
        };
        connectors = connectors.map((connector) =>
          connector.id === connectorId
            ? {
                ...connector,
                hasCredential: Boolean(body.apiKey),
                verificationStatus: body.apiKey ? 'not_verified' : 'missing',
                updatedAt: '2026-03-06T02:00:00.000Z',
              }
            : connector,
        );
        const updated = connectors.find((connector) => connector.id === connectorId);
        return jsonResponse(200, {
          ok: true,
          data: { connector: updated },
        });
      }

      if (url.includes('/api/v1/data-connectors/') && method === 'DELETE') {
        const connectorId = url.split('/api/v1/data-connectors/')[1];
        connectors = connectors.filter((connector) => connector.id !== connectorId);
        return jsonResponse(200, {
          ok: true,
          data: { deleted: true },
        });
      }

      throw new Error(`Unhandled request: ${method} ${url}`);
    }),
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}
