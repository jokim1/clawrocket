import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  ExecutorSettings,
  ExecutorStatus,
  getExecutorSettings,
  getExecutorStatus,
  getHealthStatus,
  getTalkLlmSettings,
  restartService,
  TalkLlmSettings,
  UnauthorizedError,
  updateTalkLlmSettings,
  updateExecutorSettings,
} from '../lib/api';

type AliasRow = {
  id: string;
  alias: string;
  model: string;
};

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

function createRowId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `alias-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function configuredAliasRows(
  aliasMap: Record<string, string>,
): AliasRow[] {
  return Object.entries(aliasMap).map(([alias, model]) => ({
    id: createRowId(),
    alias,
    model,
  }));
}

function formatDetectedAuth(
  method: ExecutorStatus['detectedAuthMethod'],
): string {
  switch (method) {
    case 'oauth':
      return 'OAuth token';
    case 'api_key':
      return 'API key';
    case 'auth_token':
      return 'Auth token';
    default:
      return 'None';
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never configured';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeAliasDraft(rows: AliasRow[]): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const row of rows) {
    const alias = row.alias.trim();
    const model = row.model.trim();
    if (!alias && !model) continue;
    if (!alias || !model) {
      throw new Error('Each alias row must include both an alias and a model.');
    }
    if (normalized[alias]) {
      throw new Error(`Duplicate alias "${alias}" is not allowed.`);
    }
    normalized[alias] = model;
  }

  return normalized;
}

export function SettingsPage({ onUnauthorized, userRole }: Props) {
  const [settings, setSettings] = useState<ExecutorSettings | null>(null);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySection, setBusySection] = useState<
    'credentials' | 'runtime' | 'aliases' | 'restart' | 'talk-llm' | null
  >(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [oauthDraft, setOauthDraft] = useState('');
  const [authTokenDraft, setAuthTokenDraft] = useState('');
  const [baseUrlDraft, setBaseUrlDraft] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearOauth, setClearOauth] = useState(false);
  const [clearAuthToken, setClearAuthToken] = useState(false);
  const [clearBaseUrl, setClearBaseUrl] = useState(false);
  const [aliasRows, setAliasRows] = useState<AliasRow[]>([]);
  const [defaultAliasDraft, setDefaultAliasDraft] = useState('Mock');
  const [talkLlmJsonDraft, setTalkLlmJsonDraft] = useState('');
  const [talkLlmLoaded, setTalkLlmLoaded] = useState(false);
  const [talkLlmError, setTalkLlmError] = useState<string | null>(null);
  const [talkLlmNotice, setTalkLlmNotice] = useState<string | null>(null);

  const applyTalkLlmDraft = (snapshot: TalkLlmSettings): void => {
    setTalkLlmJsonDraft(JSON.stringify(snapshot, null, 2));
    setTalkLlmLoaded(true);
  };

  const applySettingsDrafts = (nextSettings: ExecutorSettings): void => {
    setSettings(nextSettings);
    setAliasRows(configuredAliasRows(nextSettings.configuredAliasMap));
    setDefaultAliasDraft(nextSettings.defaultAlias);
    setBaseUrlDraft(nextSettings.anthropicBaseUrl || '');
    setApiKeyDraft('');
    setOauthDraft('');
    setAuthTokenDraft('');
    setClearApiKey(false);
    setClearOauth(false);
    setClearAuthToken(false);
    setClearBaseUrl(false);
  };

  const loadPage = async (): Promise<void> => {
    try {
      const [nextSettings, nextStatus] = await Promise.all([
        getExecutorSettings(),
        getExecutorStatus(),
      ]);
      applySettingsDrafts(nextSettings);
      setStatus(nextStatus);
      setPageError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setPageError(
        err instanceof ApiError ? err.message : 'Failed to load settings.',
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPage();
  }, []);

  const configErrors = useMemo(() => {
    const combined = new Set<string>();
    for (const error of settings?.configErrors || []) combined.add(error);
    for (const error of status?.configErrors || []) combined.add(error);
    return Array.from(combined);
  }, [settings, status]);

  const baseEffectiveAliasMap = useMemo(() => {
    if (!settings) return {};
    return Object.fromEntries(
      Object.entries(settings.effectiveAliasMap).filter(
        ([alias]) =>
          !Object.prototype.hasOwnProperty.call(settings.configuredAliasMap, alias),
      ),
    );
  }, [settings]);

  const effectiveAliasOptions = useMemo(() => {
    try {
      return {
        ...baseEffectiveAliasMap,
        ...normalizeAliasDraft(aliasRows),
      };
    } catch {
      return settings?.effectiveAliasMap || {};
    }
  }, [aliasRows, baseEffectiveAliasMap, settings?.effectiveAliasMap]);

  const handleApiFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setPageError(err instanceof ApiError ? err.message : fallback);
  };

  const saveCredentials = async (): Promise<void> => {
    setBusySection('credentials');
    setPageError(null);
    setNotice(null);

    try {
      const update: Record<string, string | null> = {};
      if (clearApiKey) update.anthropicApiKey = null;
      else if (apiKeyDraft.trim()) update.anthropicApiKey = apiKeyDraft.trim();
      if (clearOauth) update.claudeOauthToken = null;
      else if (oauthDraft.trim()) update.claudeOauthToken = oauthDraft.trim();
      if (clearAuthToken) update.anthropicAuthToken = null;
      else if (authTokenDraft.trim()) {
        update.anthropicAuthToken = authTokenDraft.trim();
      }

      if (Object.keys(update).length === 0) {
        setNotice('No credential changes to save.');
        return;
      }

      const nextSettings = await updateExecutorSettings(update);
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(
        nextStatus.pendingRestartReasons.some((reason) =>
          reason.includes('Executor mode'),
        )
          ? 'Credentials saved. Restart required to change executor mode.'
          : 'Credentials saved. Changes take effect on the next talk run.',
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to save credentials.');
    } finally {
      setBusySection(null);
    }
  };

  const saveRuntimeConfig = async (): Promise<void> => {
    setBusySection('runtime');
    setPageError(null);
    setNotice(null);

    try {
      const update =
        clearBaseUrl || baseUrlDraft.trim() !== (settings?.anthropicBaseUrl || '')
          ? {
              anthropicBaseUrl: clearBaseUrl ? null : baseUrlDraft.trim(),
            }
          : null;

      if (!update) {
        setNotice('No runtime-config changes to save.');
        return;
      }

      const nextSettings = await updateExecutorSettings(update);
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice('Runtime config saved. Base URL changes apply on the next talk run.');
    } catch (err) {
      handleApiFailure(err, 'Failed to save runtime config.');
    } finally {
      setBusySection(null);
    }
  };

  const saveAliasMap = async (): Promise<void> => {
    setBusySection('aliases');
    setPageError(null);
    setNotice(null);

    try {
      const aliasModelMap = normalizeAliasDraft(aliasRows);
      if (!effectiveAliasOptions[defaultAliasDraft]) {
        throw new Error('Default alias must exist in the effective alias set.');
      }

      const nextSettings = await updateExecutorSettings({
        aliasModelMap,
        defaultAlias: defaultAliasDraft,
      });
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice('Alias settings saved. Restart required for constructor-captured changes.');
    } catch (err) {
      handleApiFailure(err, 'Failed to save alias settings.');
    } finally {
      setBusySection(null);
    }
  };

  const handleRestart = async (): Promise<void> => {
    if (!status) return;
    if (
      !window.confirm(
        'This will restart the ClawRocket service. Active connections will be interrupted. Continue?',
      )
    ) {
      return;
    }

    setBusySection('restart');
    setPageError(null);
    setNotice(null);

    try {
      const previousBootId = status.bootId;
      await restartService();

      const deadline = Date.now() + 30_000;
      await sleep(2_000);

      while (Date.now() < deadline) {
        const healthy = await getHealthStatus();
        if (healthy) {
          try {
            const nextStatus = await getExecutorStatus();
            if (
              nextStatus.bootId !== previousBootId &&
              nextStatus.pendingRestartReasons.length === 0
            ) {
              setStatus(nextStatus);
              await loadPage();
              setNotice('Service restarted successfully.');
              return;
            }
          } catch {
            // Retry until the service is fully back.
          }
        }

        await sleep(2_000);
      }

      throw new Error('Timed out waiting for the service to restart.');
    } catch (err) {
      handleApiFailure(err, 'Failed to restart the service.');
    } finally {
      setBusySection(null);
    }
  };

  const loadTalkLlm = async (): Promise<void> => {
    setBusySection('talk-llm');
    setTalkLlmError(null);
    setTalkLlmNotice(null);
    try {
      const snapshot = await getTalkLlmSettings();
      applyTalkLlmDraft(snapshot);
      setTalkLlmNotice('Talk LLM settings loaded.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setTalkLlmError(
        err instanceof ApiError
          ? err.message
          : 'Failed to load Talk LLM settings.',
      );
    } finally {
      setBusySection(null);
    }
  };

  const saveTalkLlm = async (): Promise<void> => {
    setBusySection('talk-llm');
    setTalkLlmError(null);
    setTalkLlmNotice(null);
    try {
      const parsed = JSON.parse(talkLlmJsonDraft) as TalkLlmSettings & {
        providers: Array<
          TalkLlmSettings['providers'][number] & {
            credential?: { apiKey: string; organizationId?: string } | null;
          }
        >;
      };
      const next = await updateTalkLlmSettings(parsed);
      applyTalkLlmDraft(next);
      setTalkLlmNotice(
        'Talk LLM settings saved. Provider and route changes apply on the next talk run.',
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setTalkLlmError(
        err instanceof SyntaxError
          ? 'Talk LLM settings JSON is invalid.'
          : err instanceof ApiError
            ? err.message
            : 'Failed to save Talk LLM settings.',
      );
    } finally {
      setBusySection(null);
    }
  };

  if (loading) {
    return <section className="page-state">Loading settings…</section>;
  }

  if (!settings || !status) {
    return <section className="page-state">Settings are unavailable.</section>;
  }

  const seedAliases = Object.entries(settings.effectiveAliasMap).filter(
    ([alias]) => !Object.prototype.hasOwnProperty.call(settings.configuredAliasMap, alias),
  );

  return (
    <section className="page-shell settings-shell">
      <header className="page-header">
        <div>
          <h1>Executor Settings</h1>
          <p>Manage Anthropic-compatible executor credentials, aliases, and restart-required changes.</p>
        </div>
      </header>

      {pageError ? <div className="settings-banner settings-banner-error">{pageError}</div> : null}
      {notice ? <div className="settings-banner settings-banner-success">{notice}</div> : null}
      {configErrors.length > 0 ? (
        <div className="settings-banner settings-banner-error">
          <strong>Configuration errors detected.</strong>
          <ul>
            {configErrors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {status.pendingRestartReasons.length > 0 ? (
        <div className="settings-banner settings-banner-warning">
          <strong>Pending changes require restart.</strong>
          <ul>
            {status.pendingRestartReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          {userRole !== 'owner' ? (
            <p>Only the account owner can restart the service.</p>
          ) : null}
        </div>
      ) : null}

      <section className="settings-card">
        <h2>Executor Status</h2>
        <div className="settings-grid">
          <div>
            <span className="settings-label">Mode</span>
            <strong>{status.mode}</strong>
          </div>
          <div>
            <span className="settings-label">Detected auth</span>
            <strong>{formatDetectedAuth(status.detectedAuthMethod)}</strong>
          </div>
          <div>
            <span className="settings-label">Provider auth</span>
            <strong>{status.hasProviderAuth ? 'Configured' : 'Missing'}</strong>
          </div>
          <div>
            <span className="settings-label">Alias map</span>
            <strong>{status.hasValidAliasMap ? 'Valid' : 'Invalid'}</strong>
          </div>
          <div>
            <span className="settings-label">Config status</span>
            <strong>{settings.isConfigured ? 'Owned by settings page' : 'Using bootstrap defaults'}</strong>
          </div>
          <div>
            <span className="settings-label">Active runs</span>
            <strong>{status.activeRunCount}</strong>
          </div>
        </div>
      </section>

      <section className="settings-card">
        <h2>Anthropic Credentials</h2>
        <p className="settings-copy">
          Detected auth is a best-effort hint based on configured credentials, not a verified SDK contract.
        </p>
        <div className="settings-form-grid">
          <label>
            <span>API Key</span>
            <input
              type="password"
              value={apiKeyDraft}
              onChange={(event) => {
                setApiKeyDraft(event.target.value);
                setClearApiKey(false);
              }}
              placeholder={settings.hasApiKey ? 'Configured' : 'Not configured'}
            />
          </label>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setApiKeyDraft('');
              setClearApiKey(true);
            }}
          >
            Clear API Key
          </button>
          <label>
            <span>OAuth Token</span>
            <input
              type="password"
              value={oauthDraft}
              onChange={(event) => {
                setOauthDraft(event.target.value);
                setClearOauth(false);
              }}
              placeholder={settings.hasOauthToken ? 'Configured' : 'Not configured'}
            />
          </label>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setOauthDraft('');
              setClearOauth(true);
            }}
          >
            Clear OAuth Token
          </button>
          <label>
            <span>Auth Token</span>
            <input
              type="password"
              value={authTokenDraft}
              onChange={(event) => {
                setAuthTokenDraft(event.target.value);
                setClearAuthToken(false);
              }}
              placeholder={settings.hasAuthToken ? 'Configured' : 'Not configured'}
            />
          </label>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setAuthTokenDraft('');
              setClearAuthToken(true);
            }}
          >
            Clear Auth Token
          </button>
        </div>
        {status.mode === 'real' ? (
          <p className="settings-copy">
            Clearing credentials while running in real mode may cause talk execution to fail until a replacement is saved or the service is restarted.
          </p>
        ) : null}
        <button
          type="button"
          className="primary-btn"
          disabled={busySection === 'credentials'}
          onClick={() => void saveCredentials()}
        >
          {busySection === 'credentials' ? 'Saving…' : 'Save Credentials'}
        </button>
      </section>

      <section className="settings-card">
        <h2>Runtime Config</h2>
        <div className="settings-form-grid">
          <label className="settings-field-span">
            <span>Base URL</span>
            <input
              type="text"
              value={baseUrlDraft}
              onChange={(event) => {
                setBaseUrlDraft(event.target.value);
                setClearBaseUrl(false);
              }}
              placeholder="https://api.anthropic.com"
            />
          </label>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setBaseUrlDraft('');
              setClearBaseUrl(true);
            }}
          >
            Clear Base URL
          </button>
        </div>
        <button
          type="button"
          className="primary-btn"
          disabled={busySection === 'runtime'}
          onClick={() => void saveRuntimeConfig()}
        >
          {busySection === 'runtime' ? 'Saving…' : 'Save Runtime Config'}
        </button>
      </section>

      <section className="settings-card">
        <h2>Model Alias Map</h2>
        <div className="settings-alias-list">
          {aliasRows.map((row) => (
            <div key={row.id} className="settings-alias-row">
              <input
                type="text"
                value={row.alias}
                placeholder="Alias"
                onChange={(event) =>
                  setAliasRows((current) =>
                    current.map((item) =>
                      item.id === row.id
                        ? { ...item, alias: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <input
                type="text"
                value={row.model}
                placeholder="Model"
                onChange={(event) =>
                  setAliasRows((current) =>
                    current.map((item) =>
                      item.id === row.id
                        ? { ...item, model: event.target.value }
                        : item,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="secondary-btn"
                onClick={() =>
                  setAliasRows((current) =>
                    current.filter((item) => item.id !== row.id),
                  )
                }
              >
                Remove
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="secondary-btn"
          onClick={() =>
            setAliasRows((current) => [
              ...current,
              { id: createRowId(), alias: '', model: '' },
            ])
          }
        >
          Add Alias
        </button>

        <div className="settings-seed-list">
          <strong>Seed aliases</strong>
          <ul>
            {seedAliases.map(([alias, model]) => (
              <li key={alias}>
                <span>{alias}</span>
                <code>{model}</code>
              </li>
            ))}
          </ul>
        </div>

        <label className="settings-field-span">
          <span>Default Alias</span>
          <select
            value={defaultAliasDraft}
            onChange={(event) => setDefaultAliasDraft(event.target.value)}
          >
            {Object.keys(effectiveAliasOptions)
              .sort()
              .map((alias) => (
                <option key={alias} value={alias}>
                  {alias}
                </option>
              ))}
          </select>
        </label>

        <button
          type="button"
          className="primary-btn"
          disabled={busySection === 'aliases'}
          onClick={() => void saveAliasMap()}
        >
          {busySection === 'aliases' ? 'Saving…' : 'Save Alias Settings'}
        </button>
      </section>

      <section className="settings-card">
        <h2>Restart ClawRocket Service</h2>
        {!status.restartSupported ? (
          <p className="settings-copy">
            Service restart is only available when running under the systemd service with <code>CLAWROCKET_SELF_RESTART=1</code>.
          </p>
        ) : null}
        {status.activeRunCount > 0 ? (
          <p className="settings-copy">
            There are {status.activeRunCount} active runs that will be interrupted and marked as failed on next startup.
          </p>
        ) : null}
        {userRole !== 'owner' ? (
          <p className="settings-copy">
            Only the account owner can restart the service.
          </p>
        ) : null}
        {status.restartSupported && userRole === 'owner' ? (
          <button
            type="button"
            className="primary-btn"
            disabled={busySection === 'restart'}
            onClick={() => void handleRestart()}
          >
            {busySection === 'restart'
              ? 'Restarting…'
              : 'Restart ClawRocket Service'}
          </button>
        ) : null}
      </section>

      <section className="settings-card">
        <h2>Last Modified</h2>
        <p className="settings-copy">
          {settings.lastUpdatedAt
            ? `Last updated ${formatDateTime(settings.lastUpdatedAt)}${
                settings.lastUpdatedBy
                  ? ` by ${settings.lastUpdatedBy.displayName}.`
                  : '.'
              }`
            : 'Never configured.'}
        </p>
      </section>

      {(userRole === 'owner' || userRole === 'admin') ? (
        <section className="settings-card">
          <header>
            <h2>Talk LLM Settings</h2>
            <p>
              Manage provider-neutral Talk routes, providers, and the global default Talk route.
              Credentials can be included as `credential` objects on provider entries when saving.
              Loaded snapshots are write-only and will never include stored secret values.
            </p>
          </header>
          {talkLlmError ? (
            <div className="settings-banner settings-banner-error">{talkLlmError}</div>
          ) : null}
          {talkLlmNotice ? (
            <div className="settings-banner settings-banner-success">{talkLlmNotice}</div>
          ) : null}
          {!talkLlmLoaded ? (
            <div className="settings-section-actions">
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  void loadTalkLlm();
                }}
                disabled={busySection === 'talk-llm'}
              >
                {busySection === 'talk-llm' ? 'Loading…' : 'Load Talk LLM Settings'}
              </button>
            </div>
          ) : (
            <div className="settings-field-grid">
              <label className="settings-textarea-label">
                <span>Talk LLM Settings JSON</span>
                <textarea
                  rows={22}
                  value={talkLlmJsonDraft}
                  onChange={(event) => setTalkLlmJsonDraft(event.target.value)}
                  disabled={busySection === 'talk-llm'}
                  spellCheck={false}
                />
              </label>
              <div className="settings-section-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    void loadTalkLlm();
                  }}
                  disabled={busySection === 'talk-llm'}
                >
                  Reload Snapshot
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => {
                    void saveTalkLlm();
                  }}
                  disabled={busySection === 'talk-llm'}
                >
                  {busySection === 'talk-llm' ? 'Saving…' : 'Save Talk LLM Settings'}
                </button>
              </div>
            </div>
          )}
        </section>
      ) : null}
    </section>
  );
}
