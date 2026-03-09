import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  createDataConnector,
  DataConnector,
  deleteDataConnector,
  getDataConnectors,
  patchDataConnector,
  setDataConnectorCredential,
  UnauthorizedError,
} from '../lib/api';

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type ConnectorDraft = {
  name: string;
  enabled: boolean;
  hostUrl: string;
  projectId: string;
  spreadsheetId: string;
  spreadsheetUrl: string;
};

function canManageDataConnectors(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function formatVerificationStatus(status: DataConnector['verificationStatus']): string {
  switch (status) {
    case 'missing':
      return 'Missing credential';
    case 'not_verified':
      return 'Needs verification';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Configured';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
}

function verificationStatusClass(status: DataConnector['verificationStatus']): string {
  switch (status) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

function formatConnectorKind(kind: DataConnector['connectorKind']): string {
  return kind === 'posthog' ? 'PostHog' : 'Google Sheets';
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function readConfigString(
  connector: DataConnector,
  key: string,
  fallback = '',
): string {
  const value = connector.config?.[key];
  return typeof value === 'string' ? value : fallback;
}

function buildConnectorDraft(connector: DataConnector): ConnectorDraft {
  return {
    name: connector.name,
    enabled: connector.enabled,
    hostUrl: readConfigString(connector, 'hostUrl', 'https://us.posthog.com'),
    projectId: readConfigString(connector, 'projectId'),
    spreadsheetId: readConfigString(connector, 'spreadsheetId'),
    spreadsheetUrl: readConfigString(connector, 'spreadsheetUrl'),
  };
}

function createEmptyDraft(kind: DataConnector['connectorKind']): ConnectorDraft {
  return {
    name: '',
    enabled: true,
    hostUrl: 'https://us.posthog.com',
    projectId: '',
    spreadsheetId: '',
    spreadsheetUrl: '',
  };
}

function buildConnectorConfig(
  kind: DataConnector['connectorKind'],
  draft: ConnectorDraft,
): Record<string, unknown> {
  if (kind === 'posthog') {
    return {
      hostUrl: draft.hostUrl.trim(),
      projectId: draft.projectId.trim(),
    };
  }
  return {
    spreadsheetId: draft.spreadsheetId.trim(),
    spreadsheetUrl: draft.spreadsheetUrl.trim(),
  };
}

export function DataConnectorsPage({
  onUnauthorized,
  userRole,
}: Props): JSX.Element {
  const [connectors, setConnectors] = useState<DataConnector[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ConnectorDraft>>({});
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string>>({});
  const [createKind, setCreateKind] = useState<DataConnector['connectorKind']>('posthog');
  const [createDraft, setCreateDraft] = useState<ConnectorDraft>(() =>
    createEmptyDraft('posthog'),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const canManage = useMemo(
    () => canManageDataConnectors(userRole),
    [userRole],
  );

  const syncConnectors = (nextConnectors: DataConnector[]) => {
    setConnectors(nextConnectors);
    setDrafts((current) => {
      const nextDrafts: Record<string, ConnectorDraft> = {};
      for (const connector of nextConnectors) {
        nextDrafts[connector.id] = current[connector.id] || buildConnectorDraft(connector);
      }
      return nextDrafts;
    });
    setCredentialDrafts((current) => {
      const nextDrafts: Record<string, string> = {};
      for (const connector of nextConnectors) {
        nextDrafts[connector.id] = current[connector.id] || '';
      }
      return nextDrafts;
    });
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const nextConnectors = await getDataConnectors();
        if (cancelled) return;
        syncConnectors(nextConnectors);
        setError(null);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'Failed to load data connectors.',
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    if (canManage) {
      void load();
    } else {
      setLoading(false);
    }
    return () => {
      cancelled = true;
    };
  }, [canManage, onUnauthorized]);

  if (!canManage) {
    return (
      <section className="settings-shell">
        <p className="page-state">Data connectors are available to owners and admins.</p>
      </section>
    );
  }

  const upsertConnector = (connector: DataConnector) => {
    setConnectors((current) => {
      const existing = current.find((item) => item.id === connector.id);
      if (!existing) {
        return [connector, ...current];
      }
      return current.map((item) => (item.id === connector.id ? connector : item));
    });
    setDrafts((current) => ({
      ...current,
      [connector.id]: buildConnectorDraft(connector),
    }));
    setCredentialDrafts((current) => ({
      ...current,
      [connector.id]: '',
    }));
  };

  const handleCreate = async () => {
    setBusyKey('create');
    try {
      const created = await createDataConnector({
        name: createDraft.name,
        connectorKind: createKind,
        config: buildConnectorConfig(createKind, createDraft),
        enabled: createDraft.enabled,
      });
      upsertConnector(created);
      setCreateDraft(createEmptyDraft(createKind));
      setNotice(`${created.name} connector created.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to create connector.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveConnector = async (connector: DataConnector) => {
    const draft = drafts[connector.id];
    if (!draft) return;
    setBusyKey(`save:${connector.id}`);
    try {
      const updated = await patchDataConnector({
        connectorId: connector.id,
        name: draft.name,
        enabled: draft.enabled,
        config: buildConnectorConfig(connector.connectorKind, draft),
      });
      upsertConnector(updated);
      setNotice(`${updated.name} connector updated.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to update connector.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSaveCredential = async (connector: DataConnector) => {
    setBusyKey(`credential:${connector.id}`);
    try {
      const updated = await setDataConnectorCredential({
        connectorId: connector.id,
        apiKey: credentialDrafts[connector.id] || null,
      });
      upsertConnector(updated);
      setNotice(
        credentialDrafts[connector.id]?.trim()
          ? `${updated.name} credential saved.`
          : `${updated.name} credential cleared.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to save credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDelete = async (connector: DataConnector) => {
    const confirmed = window.confirm(`Delete "${connector.name}"?`);
    if (!confirmed) return;
    setBusyKey(`delete:${connector.id}`);
    try {
      await deleteDataConnector(connector.id);
      setConnectors((current) => current.filter((item) => item.id !== connector.id));
      setDrafts((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setCredentialDrafts((current) => {
        const next = { ...current };
        delete next[connector.id];
        return next;
      });
      setNotice(`${connector.name} connector deleted.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to delete connector.');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className="settings-shell">
      <article className="settings-card">
        <h1>Data Connectors</h1>
        <p className="settings-copy">
          Define org-level data sources, store credentials, and attach them to
          Talks so tool-capable agents can query those sources during runs.
        </p>
        {error ? (
          <div className="settings-banner settings-banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="settings-banner settings-banner-success" role="status">
            {notice}
          </div>
        ) : null}
      </article>

      <article className="settings-card">
        <h2>Add Connector</h2>
        <div className="connector-form-grid">
          <label>
            <span className="settings-label">Kind</span>
            <select
              value={createKind}
              onChange={(event) => {
                const nextKind = event.target.value as DataConnector['connectorKind'];
                setCreateKind(nextKind);
                setCreateDraft(createEmptyDraft(nextKind));
              }}
            >
              <option value="posthog">PostHog</option>
              <option value="google_sheets">Google Sheets</option>
            </select>
          </label>
          <label>
            <span className="settings-label">Name</span>
            <input
              value={createDraft.name}
              onChange={(event) =>
                setCreateDraft((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder={
                createKind === 'posthog' ? 'FTUE PostHog' : 'Live Ops Sheet'
              }
            />
          </label>
          {createKind === 'posthog' ? (
            <>
              <label>
                <span className="settings-label">Host URL</span>
                <input
                  value={createDraft.hostUrl}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      hostUrl: event.target.value,
                    }))
                  }
                  placeholder="https://us.posthog.com"
                />
              </label>
              <label>
                <span className="settings-label">Project ID</span>
                <input
                  value={createDraft.projectId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      projectId: event.target.value,
                    }))
                  }
                  placeholder="12345"
                />
              </label>
            </>
          ) : (
            <>
              <label>
                <span className="settings-label">Spreadsheet ID</span>
                <input
                  value={createDraft.spreadsheetId}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      spreadsheetId: event.target.value,
                    }))
                  }
                  placeholder="1AbC..."
                />
              </label>
              <label>
                <span className="settings-label">Spreadsheet URL</span>
                <input
                  value={createDraft.spreadsheetUrl}
                  onChange={(event) =>
                    setCreateDraft((current) => ({
                      ...current,
                      spreadsheetUrl: event.target.value,
                    }))
                  }
                  placeholder="https://docs.google.com/..."
                />
              </label>
            </>
          )}
          <label className="connector-enabled-toggle">
            <input
              type="checkbox"
              checked={createDraft.enabled}
              onChange={(event) =>
                setCreateDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))
              }
            />
            <span>Enabled</span>
          </label>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void handleCreate()}
            disabled={busyKey === 'create'}
          >
            {busyKey === 'create' ? 'Creating…' : 'Create Connector'}
          </button>
        </div>
      </article>

      <article className="settings-card">
        <div className="connector-list-header">
          <h2>Connectors</h2>
          <span className="talk-llm-meta">{connectors.length} total</span>
        </div>
        {loading ? (
          <p className="page-state">Loading connectors…</p>
        ) : connectors.length === 0 ? (
          <p className="page-state">No connectors yet.</p>
        ) : (
          <div className="connector-card-list">
            {connectors.map((connector) => {
              const draft = drafts[connector.id] || buildConnectorDraft(connector);
              const isBusy = busyKey?.endsWith(`:${connector.id}`);
              return (
                <article key={connector.id} className="talk-llm-card connector-card">
                  <div className="connector-card-header">
                    <div>
                      <h3>{connector.name}</h3>
                      <p className="talk-llm-meta">
                        {formatConnectorKind(connector.connectorKind)} • Attached to{' '}
                        {connector.attachedTalkCount} talk
                        {connector.attachedTalkCount === 1 ? '' : 's'}
                      </p>
                    </div>
                    <span
                      className={verificationStatusClass(connector.verificationStatus)}
                    >
                      {formatVerificationStatus(connector.verificationStatus)}
                    </span>
                  </div>

                  <div className="connector-form-grid">
                    <label>
                      <span className="settings-label">Name</span>
                      <input
                        value={draft.name}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [connector.id]: {
                              ...draft,
                              name: event.target.value,
                            },
                          }))
                        }
                      />
                    </label>
                    {connector.connectorKind === 'posthog' ? (
                      <>
                        <label>
                          <span className="settings-label">Host URL</span>
                          <input
                            value={draft.hostUrl}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  hostUrl: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="settings-label">Project ID</span>
                          <input
                            value={draft.projectId}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  projectId: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </>
                    ) : (
                      <>
                        <label>
                          <span className="settings-label">Spreadsheet ID</span>
                          <input
                            value={draft.spreadsheetId}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  spreadsheetId: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span className="settings-label">Spreadsheet URL</span>
                          <input
                            value={draft.spreadsheetUrl}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [connector.id]: {
                                  ...draft,
                                  spreadsheetUrl: event.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                      </>
                    )}
                    <label className="connector-enabled-toggle">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [connector.id]: {
                              ...draft,
                              enabled: event.target.checked,
                            },
                          }))
                        }
                      />
                      <span>Enabled</span>
                    </label>
                  </div>

                  <div className="connector-meta-grid">
                    <div>
                      <strong>Credential</strong>
                      <p>{connector.hasCredential ? 'Stored' : 'Missing'}</p>
                    </div>
                    <div>
                      <strong>Last verified</strong>
                      <p>{formatDateTime(connector.lastVerifiedAt)}</p>
                    </div>
                    <div>
                      <strong>Updated</strong>
                      <p>{formatDateTime(connector.updatedAt)}</p>
                    </div>
                  </div>

                  {connector.lastVerificationError ? (
                    <div className="inline-banner inline-banner-warning" role="status">
                      {connector.lastVerificationError}
                    </div>
                  ) : null}

                  {connector.connectorKind === 'posthog' ? (
                    <div className="connector-credential-row">
                      <label>
                        <span className="settings-label">PostHog API Key</span>
                        <input
                          type="password"
                          value={credentialDrafts[connector.id] || ''}
                          onChange={(event) =>
                            setCredentialDrafts((current) => ({
                              ...current,
                              [connector.id]: event.target.value,
                            }))
                          }
                          placeholder={connector.hasCredential ? 'Stored key' : 'phx_...'}
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleSaveCredential(connector)}
                        disabled={busyKey === `credential:${connector.id}`}
                      >
                        {busyKey === `credential:${connector.id}`
                          ? 'Saving…'
                          : 'Save API Key'}
                      </button>
                    </div>
                  ) : (
                    <div className="inline-banner inline-banner-warning" role="status">
                      Google Sheets OAuth is planned next. You can create and attach the
                      connector now, but auth is not wired on this branch yet.
                    </div>
                  )}

                  <div className="settings-button-row">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleSaveConnector(connector)}
                      disabled={busyKey === `save:${connector.id}` || isBusy}
                    >
                      {busyKey === `save:${connector.id}` ? 'Saving…' : 'Save Details'}
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleDelete(connector)}
                      disabled={busyKey === `delete:${connector.id}` || isBusy}
                    >
                      {busyKey === `delete:${connector.id}` ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </article>
    </section>
  );
}
