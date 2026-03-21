import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  approveChannelTarget,
  ChannelConnection,
  ChannelTarget,
  clearSlackChannelConnectorConfig,
  diagnoseSlackWorkspaceTarget,
  disconnectSlackWorkspace,
  getSlackChannelConnector,
  listChannelTargets,
  saveSlackChannelConnectorConfig,
  SlackChannelConnector,
  startSlackChannelConnectorInstall,
  syncSlackWorkspace,
  UnauthorizedError,
  unapproveChannelTarget,
} from '../lib/api';
import { launchSlackInstallPopup } from '../lib/slackInstallPopup';

type Props = {
  onUnauthorized: () => void;
};

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function statusChipClass(status: ChannelConnection['healthStatus']): string {
  switch (status) {
    case 'healthy':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'degraded':
      return 'talk-agent-chip talk-agent-chip-warning';
    case 'error':
      return 'talk-agent-chip talk-agent-chip-error';
    default:
      return 'talk-agent-chip';
  }
}

function readConfigString(
  connection: ChannelConnection,
  key: string,
): string | null {
  const value = connection.config?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function formatWorkspaceMeta(connection: ChannelConnection): string {
  const teamUrl = readConfigString(connection, 'teamUrl');
  const teamId = readConfigString(connection, 'teamId');
  if (teamUrl && teamId) {
    return `${teamUrl} · ${teamId}`;
  }
  return teamUrl || teamId || connection.accountKey;
}

function formatChannelType(target: ChannelTarget): string {
  return target.metadata?.isPrivate === true ? 'Private channel' : 'Channel';
}

function filterTargets(
  targets: ChannelTarget[],
  query: string,
): ChannelTarget[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return targets;
  return targets.filter((target) => {
    const haystack = [
      target.displayName,
      target.targetId,
      typeof target.metadata?.channelName === 'string'
        ? target.metadata.channelName
        : '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(normalized);
  });
}

export function SlackChannelConnectorPanel({
  onUnauthorized,
}: Props): JSX.Element {
  const [connector, setConnector] = useState<SlackChannelConnector | null>(null);
  const [targetsByConnection, setTargetsByConnection] = useState<
    Record<string, ChannelTarget[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [clientSecretDraft, setClientSecretDraft] = useState('');
  const [signingSecretDraft, setSigningSecretDraft] = useState('');
  const [searchByConnection, setSearchByConnection] = useState<
    Record<string, string>
  >({});
  const [diagnosticDrafts, setDiagnosticDrafts] = useState<
    Record<string, string>
  >({});

  const refresh = async () => {
    try {
      const next = await getSlackChannelConnector();
      setConnector(next);
      setClientIdDraft(next.config.clientId || '');
      const targets = await Promise.all(
        next.workspaces.map(async (workspace) => [
          workspace.id,
          await listChannelTargets({
            connectionId: workspace.id,
            approval: 'all',
            limit: 200,
          }),
        ]),
      );
      setTargetsByConnection(
        Object.fromEntries(targets) as Record<string, ChannelTarget[]>,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to load Slack connector.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (cancelled) return;
      await refresh();
    };
    void load();
    const interval = window.setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [onUnauthorized]);

  const workspaceEntries = useMemo(
    () =>
      (connector?.workspaces || []).map((workspace) => {
        const query = searchByConnection[workspace.id] || '';
        const targets = filterTargets(targetsByConnection[workspace.id] || [], query);
        return {
          workspace,
          targets,
          approved: targets.filter((target) => target.approved),
          discovered: targets.filter((target) => !target.approved),
        };
      }),
    [connector?.workspaces, searchByConnection, targetsByConnection],
  );

  const handleSaveConfig = async () => {
    setBusyKey('save-config');
    try {
      const next = await saveSlackChannelConnectorConfig({
        clientId: clientIdDraft,
        clientSecret: clientSecretDraft || undefined,
        signingSecret: signingSecretDraft || undefined,
      });
      setConnector(next);
      setClientSecretDraft('');
      setSigningSecretDraft('');
      setNotice('Slack app configuration saved.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to save Slack app configuration.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearConfig = async () => {
    setBusyKey('clear-config');
    try {
      const next = await clearSlackChannelConnectorConfig();
      setConnector(next);
      setClientIdDraft('');
      setClientSecretDraft('');
      setSigningSecretDraft('');
      setNotice('Slack app configuration cleared.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to clear Slack app configuration.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleInstallWorkspace = async () => {
    setBusyKey('install-workspace');
    try {
      const result = await startSlackChannelConnectorInstall(
        '/app/connectors?tab=channel-connectors',
      );
      await launchSlackInstallPopup(result.authorizationUrl);
      await refresh();
      setNotice('Slack workspace connected.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : (err as Error).message,
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleSyncWorkspace = async (connectionId: string) => {
    setBusyKey(`sync:${connectionId}`);
    try {
      const result = await syncSlackWorkspace(connectionId);
      const targets = await listChannelTargets({
        connectionId,
        approval: 'all',
        limit: 200,
      });
      setTargetsByConnection((current) => ({
        ...current,
        [connectionId]: targets,
      }));
      setNotice(
        `Synced ${result.syncedCount} Slack channels (${result.publicCount} public, ${result.privateCount} private).`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to sync Slack channels.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleDisconnectWorkspace = async (connectionId: string) => {
    setBusyKey(`disconnect:${connectionId}`);
    try {
      await disconnectSlackWorkspace(connectionId);
      await refresh();
      setNotice('Slack workspace disconnected.');
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to disconnect Slack workspace.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleApproveTarget = async (
    connectionId: string,
    target: ChannelTarget,
  ) => {
    setBusyKey(`approve:${connectionId}:${target.targetId}`);
    try {
      await approveChannelTarget({
        connectionId,
        targetKind: target.targetKind,
        targetId: target.targetId,
        displayName: target.displayName,
        metadata: target.metadata,
      });
      const targets = await listChannelTargets({
        connectionId,
        approval: 'all',
        limit: 200,
      });
      setTargetsByConnection((current) => ({
        ...current,
        [connectionId]: targets,
      }));
      setNotice(`${target.displayName} approved for Talk bindings.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to approve Slack channel.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleUnapproveTarget = async (
    connectionId: string,
    target: ChannelTarget,
  ) => {
    setBusyKey(`unapprove:${connectionId}:${target.targetId}`);
    try {
      const result = await unapproveChannelTarget({
        connectionId,
        targetKind: target.targetKind,
        targetId: target.targetId,
      });
      const targets = await listChannelTargets({
        connectionId,
        approval: 'all',
        limit: 200,
      });
      setTargetsByConnection((current) => ({
        ...current,
        [connectionId]: targets,
      }));
      setNotice(
        result.deactivatedBindingCount && result.deactivatedBindingCount > 0
          ? `${target.displayName} unapproved and ${result.deactivatedBindingCount} Talk binding(s) were deactivated.`
          : `${target.displayName} removed from approved channels.`,
      );
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError
          ? err.message
          : 'Failed to unapprove Slack channel.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  const handleCheckChannel = async (workspaceId: string) => {
    const rawInput = (diagnosticDrafts[workspaceId] || '').trim();
    if (!rawInput) return;
    setBusyKey(`check:${workspaceId}`);
    try {
      const diagnostic = await diagnoseSlackWorkspaceTarget({
        connectionId: workspaceId,
        rawInput,
      });
      await approveChannelTarget({
        connectionId: workspaceId,
        targetKind: diagnostic.target.targetKind,
        targetId: diagnostic.target.targetId,
        displayName: diagnostic.target.displayName,
        metadata: diagnostic.target.metadata,
      });
      const targets = await listChannelTargets({
        connectionId: workspaceId,
        approval: 'all',
        limit: 200,
      });
      setTargetsByConnection((current) => ({
        ...current,
        [workspaceId]: targets,
      }));
      setDiagnosticDrafts((current) => ({ ...current, [workspaceId]: '' }));
      setNotice(`${diagnostic.target.displayName} approved for Talk bindings.`);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to check Slack channel.',
      );
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <>
      <article className="settings-card">
        <h2>Connect Slack App</h2>
        <p className="settings-copy">
          Configure one Slack app for this ClawTalk workspace. Save the signing
          secret first, then use the generated Redirect URL and Events API URL
          in Slack before installing the app into any workspace.
        </p>
        {error ? (
          <div className="settings-banner settings-banner-error" role="alert">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div
            className="settings-banner settings-banner-success"
            role="status"
          >
            {notice}
          </div>
        ) : null}
        {loading ? (
          <p className="page-state">Loading Slack connector…</p>
        ) : connector ? (
          <>
            {!connector.config.available ? (
              <div className="settings-banner settings-banner-warning" role="status">
                {connector.config.availabilityReason}
              </div>
            ) : null}
            <div className="connector-form-grid">
              <label>
                <span className="settings-label">Client ID</span>
                <input
                  type="text"
                  value={clientIdDraft}
                  onChange={(event) => setClientIdDraft(event.target.value)}
                  placeholder="1234567890.1234567890"
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="settings-label">Client Secret</span>
                <input
                  type="password"
                  value={clientSecretDraft}
                  onChange={(event) => setClientSecretDraft(event.target.value)}
                  placeholder={
                    connector.config.hasClientSecret
                      ? 'Stored in ClawTalk'
                      : 'Paste Slack client secret'
                  }
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="settings-label">Signing Secret</span>
                <input
                  type="password"
                  value={signingSecretDraft}
                  onChange={(event) =>
                    setSigningSecretDraft(event.target.value)
                  }
                  placeholder={
                    connector.config.hasSigningSecret
                      ? 'Stored in ClawTalk'
                      : 'Paste Slack signing secret'
                  }
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="connector-card-list" style={{ marginTop: '1rem' }}>
              <div className="talk-llm-card" style={{ margin: 0 }}>
                <h3>Setup Order</h3>
                <ol style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                  <li>Save the Slack app credentials here.</li>
                  <li>Paste the Redirect URL into Slack.</li>
                  <li>Paste the Events API URL into Slack and complete verification.</li>
                  <li>Enable bot scopes and event subscriptions.</li>
                  <li>Install the app to a workspace.</li>
                  <li>Invite the app to any private channels you want to bind.</li>
                  <li>Sync channels here, then approve the ones Talks may use.</li>
                </ol>
              </div>
              <div className="talk-llm-card" style={{ margin: 0 }}>
                <h3>Callback URLs</h3>
                <p className="talk-llm-meta">
                  Redirect URL: {connector.config.redirectUrl || 'Unavailable'}
                </p>
                <p className="talk-llm-meta">
                  Events API URL:{' '}
                  {connector.config.eventsApiUrl || 'Not ready until the signing secret is saved'}
                </p>
                <p className="talk-llm-meta">
                  Events API status:{' '}
                  {connector.config.eventsApiReady ? 'Ready' : 'Not ready'}
                </p>
              </div>
            </div>
            <div className="settings-button-row" style={{ marginTop: '1rem' }}>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleSaveConfig()}
                disabled={busyKey !== null}
              >
                {busyKey === 'save-config' ? 'Saving…' : 'Save Slack App'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleInstallWorkspace()}
                disabled={
                  busyKey !== null || !connector.config.oauthInstallReady
                }
              >
                {busyKey === 'install-workspace'
                  ? 'Opening Slack…'
                  : 'Install to Workspace'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleClearConfig()}
                disabled={busyKey !== null}
              >
                Clear Config
              </button>
            </div>
          </>
        ) : null}
      </article>

      <article className="settings-card">
        <h2>Connected Workspaces</h2>
        <p className="settings-copy">
          Each installed Slack workspace becomes its own live channel
          connection. Sync channels after install, then approve the ones Talks
          may bind to.
        </p>
        {loading ? (
          <p className="page-state">Loading workspaces…</p>
        ) : workspaceEntries.length === 0 ? (
          <div className="settings-banner settings-banner-warning" role="status">
            No Slack workspaces are connected yet.
          </div>
        ) : (
          <div className="connector-card-list">
            {workspaceEntries.map(({ workspace, approved, discovered }) => (
              <article key={workspace.id} className="talk-llm-card connector-card">
                <div className="connector-card-header">
                  <div>
                    <h3>{workspace.displayName}</h3>
                    <p className="talk-llm-meta">{formatWorkspaceMeta(workspace)}</p>
                  </div>
                  <span className={statusChipClass(workspace.healthStatus)}>
                    {workspace.healthStatus}
                  </span>
                </div>
                <p className="talk-llm-meta">
                  Last checked: {formatDateTime(workspace.lastHealthCheckAt)}
                </p>
                {workspace.lastHealthError ? (
                  <div className="settings-banner settings-banner-warning" role="status">
                    {workspace.lastHealthError}
                  </div>
                ) : null}
                <div className="settings-button-row" style={{ marginTop: '0.75rem' }}>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleSyncWorkspace(workspace.id)}
                    disabled={busyKey !== null}
                  >
                    {busyKey === `sync:${workspace.id}` ? 'Syncing…' : 'Sync Channels'}
                  </button>
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleDisconnectWorkspace(workspace.id)}
                    disabled={busyKey !== null}
                  >
                    Disconnect Workspace
                  </button>
                </div>

                <label style={{ display: 'block', marginTop: '1rem' }}>
                  <span className="settings-label">Search channels</span>
                  <input
                    type="text"
                    value={searchByConnection[workspace.id] || ''}
                    onChange={(event) =>
                      setSearchByConnection((current) => ({
                        ...current,
                        [workspace.id]: event.target.value,
                      }))
                    }
                    placeholder="Search approved or discovered channels"
                    style={{ width: '100%' }}
                  />
                </label>

                <label style={{ display: 'block', marginTop: '0.75rem' }}>
                  <span className="settings-label">Check channel by URL or ID</span>
                  <div className="connector-attach-row">
                    <input
                      type="text"
                      value={diagnosticDrafts[workspace.id] || ''}
                      onChange={(event) =>
                        setDiagnosticDrafts((current) => ({
                          ...current,
                          [workspace.id]: event.target.value,
                        }))
                      }
                      placeholder="https://app.slack.com/.../C123 or C12345678"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleCheckChannel(workspace.id)}
                      disabled={busyKey !== null}
                    >
                      Add Channel
                    </button>
                  </div>
                </label>
                <p className="talk-llm-meta" style={{ marginTop: '0.5rem' }}>
                  Private channels require the Slack app to be invited first.
                  In Slack, open the channel and run <code>/invite @YourAppName</code>,
                  then sync channels again.
                </p>

                <div className="connector-card-list" style={{ marginTop: '1rem' }}>
                  <div className="talk-llm-card" style={{ margin: 0 }}>
                    <h3>Approved Channels</h3>
                    {approved.length === 0 ? (
                      <p className="page-state">
                        No approved channels yet.
                      </p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
                        {approved.map((target) => (
                          <li
                            key={target.targetId}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.5rem 0',
                              borderBottom: '1px solid var(--border, #e6e9ef)',
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <strong>{target.displayName}</strong>
                              <div className="talk-llm-meta">
                                {formatChannelType(target)} · {target.targetId}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() =>
                                void handleUnapproveTarget(workspace.id, target)
                              }
                              disabled={busyKey !== null}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="talk-llm-card" style={{ margin: 0 }}>
                    <h3>Discovered Channels</h3>
                    {discovered.length === 0 ? (
                      <p className="page-state">
                        Nothing new discovered. Sync channels after installing
                        the app or inviting it to private channels.
                      </p>
                    ) : (
                      <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
                        {discovered.map((target) => (
                          <li
                            key={target.targetId}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.75rem',
                              padding: '0.5rem 0',
                              borderBottom: '1px solid var(--border, #e6e9ef)',
                            }}
                          >
                            <div style={{ flex: 1 }}>
                              <strong>{target.displayName}</strong>
                              <div className="talk-llm-meta">
                                {formatChannelType(target)} · {target.targetId}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="secondary-btn"
                              onClick={() =>
                                void handleApproveTarget(workspace.id, target)
                              }
                              disabled={busyKey !== null}
                            >
                              Approve
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </article>
    </>
  );
}
