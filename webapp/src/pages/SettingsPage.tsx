import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  ExecutorSettings,
  ExecutorSubscriptionHostStatus,
  ExecutorStatus,
  getExecutorSettings,
  getExecutorSubscriptionHostStatus,
  getExecutorStatus,
  getHealthStatus,
  importExecutorSubscriptionFromHost,
  restartService,
  UnauthorizedError,
  updateExecutorSettings,
  verifyExecutorCredentials,
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

type AuthMode = ExecutorSettings['executorAuthMode'];

function createRowId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') {
    return randomUUID.call(globalThis.crypto);
  }
  return `alias-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function configuredAliasRows(aliasMap: Record<string, string>): AliasRow[] {
  return Object.entries(aliasMap).map(([alias, model]) => ({
    id: createRowId(),
    alias,
    model,
  }));
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never configured';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function formatAuthMode(mode: AuthMode): string {
  switch (mode) {
    case 'subscription':
      return 'Subscription (Claude Pro/Max)';
    case 'api_key':
      return 'API Key (Anthropic Console)';
    case 'advanced_bearer':
      return 'Advanced bearer / gateway';
    default:
      return 'None';
  }
}

function formatVerificationStatus(
  status: ExecutorStatus['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing';
    case 'not_verified':
      return 'Not verified';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Valid';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
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

function standbyCredentials(settings: ExecutorSettings): string[] {
  const items: string[] = [];
  if (settings.hasOauthToken && settings.executorAuthMode !== 'subscription') {
    items.push('Subscription login configured');
  }
  if (settings.hasApiKey && settings.executorAuthMode !== 'api_key') {
    items.push('API Key configured');
  }
  if (
    settings.hasAuthToken &&
    settings.executorAuthMode !== 'advanced_bearer'
  ) {
    items.push('Advanced bearer configured');
  }
  return items;
}

function fieldDraftState(input: {
  stored: boolean;
  cleared: boolean;
  draftValue: string;
}): {
  hasCredential: boolean;
  message: string;
} {
  if (input.cleared) {
    return {
      hasCredential: false,
      message: 'This credential will be cleared when you save.',
    };
  }
  if (input.draftValue.trim()) {
    return {
      hasCredential: true,
      message:
        'A new credential is entered locally and will be saved when you click Save Credential Settings.',
    };
  }
  if (input.stored) {
    return {
      hasCredential: true,
      message: 'A credential is already stored in settings.',
    };
  }
  return {
    hasCredential: false,
    message: 'No credential is currently stored.',
  };
}

export function SettingsPage({ onUnauthorized, userRole }: Props) {
  const [settings, setSettings] = useState<ExecutorSettings | null>(null);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busySection, setBusySection] = useState<
    'credentials' | 'verification' | 'aliases' | 'restart' | null
  >(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [authModeDraft, setAuthModeDraft] = useState<AuthMode>('none');
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
  const [subscriptionHostStatus, setSubscriptionHostStatus] =
    useState<ExecutorSubscriptionHostStatus | null>(null);
  const [subscriptionHostBusy, setSubscriptionHostBusy] = useState<
    'checking' | 'importing' | null
  >(null);
  const [showSubscriptionAdvanced, setShowSubscriptionAdvanced] =
    useState(false);
  const verificationPollAttemptsRef = useRef(0);

  const applySettingsDrafts = (nextSettings: ExecutorSettings): void => {
    setSettings(nextSettings);
    setAliasRows(configuredAliasRows(nextSettings.configuredAliasMap));
    setDefaultAliasDraft(nextSettings.defaultAlias);
    setAuthModeDraft(nextSettings.executorAuthMode);
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

  useEffect(() => {
    if (status?.verificationStatus !== 'verifying') {
      verificationPollAttemptsRef.current = 0;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const scheduleNextPoll = (): void => {
      const attempt = verificationPollAttemptsRef.current;
      const delayMs = attempt < 5 ? 2_000 : attempt < 15 ? 5_000 : 10_000;
      timer = window.setTimeout(() => {
        void getExecutorStatus()
          .then((nextStatus) => {
            if (cancelled) return;
            verificationPollAttemptsRef.current += 1;
            setStatus(nextStatus);
            if (nextStatus.verificationStatus === 'verifying') {
              scheduleNextPoll();
            }
          })
          .catch((err) => {
            if (cancelled) return;
            if (err instanceof UnauthorizedError) {
              onUnauthorized();
              return;
            }
            setPageError(
              err instanceof ApiError
                ? err.message
                : 'Failed to refresh verification status.',
            );
          });
      }, delayMs);
    };

    scheduleNextPoll();

    return () => {
      cancelled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [status?.verificationStatus, onUnauthorized]);

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
          !Object.prototype.hasOwnProperty.call(
            settings.configuredAliasMap,
            alias,
          ),
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
    if (!settings) return;

    setBusySection('credentials');
    setPageError(null);
    setNotice(null);

    try {
      const update: Record<string, string | null> = {
        executorAuthMode: authModeDraft,
      };

      if (clearOauth) {
        update.claudeOauthToken = null;
      } else if (authModeDraft === 'subscription') {
        if (oauthDraft.trim()) {
          update.claudeOauthToken = oauthDraft.trim();
        }
      }

      if (clearApiKey) {
        update.anthropicApiKey = null;
      } else if (authModeDraft === 'api_key') {
        if (apiKeyDraft.trim()) {
          update.anthropicApiKey = apiKeyDraft.trim();
        }
      }

      if (clearAuthToken) {
        update.anthropicAuthToken = null;
      } else if (authModeDraft === 'advanced_bearer') {
        if (authTokenDraft.trim()) {
          update.anthropicAuthToken = authTokenDraft.trim();
        }
      }

      if (clearBaseUrl) {
        update.anthropicBaseUrl = null;
      } else if (
        (authModeDraft === 'api_key' || authModeDraft === 'advanced_bearer') &&
        baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
      ) {
        update.anthropicBaseUrl = baseUrlDraft.trim();
      }

      const nextSettings = await updateExecutorSettings(update);
      applySettingsDrafts(nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);

      if (
        nextSettings.executorAuthMode === 'api_key' ||
        nextSettings.executorAuthMode === 'advanced_bearer'
      ) {
        setNotice(
          nextStatus.verificationStatus === 'verifying'
            ? 'Credentials saved. Verification is running in the background.'
            : 'Credentials saved. Use Re-verify if you want to validate the active credential now.',
        );
      } else if (nextSettings.executorAuthMode === 'subscription') {
        setNotice(
          'Subscription mode is now active. Use Check host Claude login for guided setup, or Verify subscription to confirm the current environment can execute with the selected subscription credential.',
        );
      } else {
        setNotice(
          'Credentials saved. Core executor runs will remain unavailable until an active Anthropic auth mode is configured.',
        );
      }
    } catch (err) {
      handleApiFailure(err, 'Failed to save credentials.');
    } finally {
      setBusySection(null);
    }
  };

  const handleVerify = async (): Promise<void> => {
    setBusySection('verification');
    setPageError(null);
    setNotice(null);

    try {
      const result = await verifyExecutorCredentials();
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(result.message);
    } catch (err) {
      handleApiFailure(err, 'Failed to start verification.');
    } finally {
      setBusySection(null);
    }
  };

  const checkSubscriptionHostLogin = async (): Promise<void> => {
    setSubscriptionHostBusy('checking');
    setPageError(null);
    setNotice(null);

    try {
      const nextHostStatus = await getExecutorSubscriptionHostStatus();
      setSubscriptionHostStatus(nextHostStatus);
      if (
        !nextHostStatus.importAvailable &&
        !nextHostStatus.serviceEnvOauthPresent &&
        (!nextHostStatus.claudeCliInstalled || nextHostStatus.hostLoginDetected)
      ) {
        setShowSubscriptionAdvanced(true);
      }
      setNotice(nextHostStatus.message);
    } catch (err) {
      handleApiFailure(err, 'Failed to check Claude host login.');
    } finally {
      setSubscriptionHostBusy(null);
    }
  };

  const importSubscriptionFromHost = async (): Promise<void> => {
    if (!subscriptionHostStatus?.hostCredentialFingerprint) return;

    setSubscriptionHostBusy('importing');
    setPageError(null);
    setNotice(null);

    try {
      const result = await importExecutorSubscriptionFromHost(
        subscriptionHostStatus.hostCredentialFingerprint,
      );
      applySettingsDrafts(result.settings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      const latestHostStatus = await getExecutorSubscriptionHostStatus();
      setSubscriptionHostStatus(latestHostStatus);
      setNotice(
        result.status === 'no_change'
          ? 'The host subscription credential is already imported into settings.'
          : 'Subscription credential imported from the service host. Use Verify subscription to confirm this environment can execute with it.',
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to import subscription credential from host.');
      if (err instanceof ApiError && err.code === 'host_state_changed') {
        try {
          const latestHostStatus = await getExecutorSubscriptionHostStatus();
          setSubscriptionHostStatus(latestHostStatus);
        } catch {
          // Ignore refresh failures after the primary error.
        }
      }
    } finally {
      setSubscriptionHostBusy(null);
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
      setNotice(
        'Alias settings saved. Restart required for constructor-captured changes.',
      );
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

  if (loading) {
    return <section className="page-state">Loading settings…</section>;
  }

  if (!settings || !status) {
    return <section className="page-state">Settings are unavailable.</section>;
  }

  const seedAliases = Object.entries(settings.effectiveAliasMap).filter(
    ([alias]) =>
      !Object.prototype.hasOwnProperty.call(settings.configuredAliasMap, alias),
  );
  const standby = standbyCredentials(settings);
  const showBaseUrl =
    authModeDraft === 'api_key' || authModeDraft === 'advanced_bearer';
  const verifyButtonLabel =
    authModeDraft === 'subscription' ? 'Verify subscription' : 'Re-verify';
  const showSubscriptionImportButton = Boolean(
    subscriptionHostStatus?.importAvailable &&
      subscriptionHostStatus.hostCredentialFingerprint,
  );
  const selectedModeCredentialState =
    authModeDraft === 'subscription'
      ? fieldDraftState({
          stored: settings.hasOauthToken,
          cleared: clearOauth,
          draftValue: oauthDraft,
        })
      : authModeDraft === 'api_key'
        ? fieldDraftState({
            stored: settings.hasApiKey,
            cleared: clearApiKey,
            draftValue: apiKeyDraft,
          })
        : authModeDraft === 'advanced_bearer'
          ? fieldDraftState({
              stored: settings.hasAuthToken,
              cleared: clearAuthToken,
              draftValue: authTokenDraft,
            })
          : {
              hasCredential: false,
              message:
                'No active Anthropic auth mode is selected. Stored credentials remain on standby until you choose a mode and save.',
            };
  const hasUnsavedModeChange = authModeDraft !== settings.executorAuthMode;
  const hasUnsavedSelectedModeCredentialChange =
    authModeDraft === 'subscription'
      ? clearOauth || oauthDraft.trim().length > 0
      : authModeDraft === 'api_key'
        ? clearApiKey ||
          apiKeyDraft.trim().length > 0 ||
          clearBaseUrl ||
          baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
        : authModeDraft === 'advanced_bearer'
          ? clearAuthToken ||
            authTokenDraft.trim().length > 0 ||
            clearBaseUrl ||
            baseUrlDraft.trim() !== (settings.anthropicBaseUrl || '')
          : false;
  const hasPendingCredentialState =
    hasUnsavedModeChange || hasUnsavedSelectedModeCredentialChange;
  const displayedConfiguredLabel =
    authModeDraft === 'none'
      ? 'No'
      : hasPendingCredentialState
        ? selectedModeCredentialState.hasCredential
          ? 'Ready to save'
          : 'Missing'
        : status.activeCredentialConfigured
          ? 'Configured'
          : 'Missing';
  const displayedVerificationLabel =
    authModeDraft === 'none'
      ? 'Select a mode'
      : hasPendingCredentialState
        ? 'Unsaved changes'
        : formatVerificationStatus(status.verificationStatus);
  const displayedLastVerifiedLabel =
    authModeDraft === 'none'
      ? 'No active mode selected'
      : hasPendingCredentialState
        ? 'Will refresh after save'
        : formatDateTime(status.lastVerifiedAt);

  return (
    <section className="page-shell settings-shell">
      <header className="page-header">
        <div>
          <h1>Executor Settings</h1>
          <p>
            Manage Anthropic auth mode, aliases, and restart-required changes
            for the core executor.
          </p>
        </div>
      </header>

      {pageError ? (
        <div className="settings-banner settings-banner-error">{pageError}</div>
      ) : null}
      {notice ? (
        <div className="settings-banner settings-banner-success">{notice}</div>
      ) : null}
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
            <span className="settings-label">Active auth mode</span>
            <strong>{formatAuthMode(status.executorAuthMode)}</strong>
          </div>
          <div>
            <span className="settings-label">Credential</span>
            <strong>
              {status.activeCredentialConfigured ? 'Configured' : 'Missing'}
            </strong>
          </div>
          <div>
            <span className="settings-label">Verification</span>
            <strong>{formatVerificationStatus(status.verificationStatus)}</strong>
          </div>
          <div>
            <span className="settings-label">Alias map</span>
            <strong>{status.hasValidAliasMap ? 'Valid' : 'Invalid'}</strong>
          </div>
          <div>
            <span className="settings-label">Config status</span>
            <strong>
              {settings.isConfigured
                ? 'Owned by settings page'
                : 'Using bootstrap defaults'}
            </strong>
          </div>
          <div>
            <span className="settings-label">Active runs</span>
            <strong>{status.activeRunCount}</strong>
          </div>
          <div>
            <span className="settings-label">Last verified</span>
            <strong>{formatDateTime(status.lastVerifiedAt)}</strong>
          </div>
        </div>
        {status.lastVerificationError ? (
          <p className="settings-copy">
            <strong>Verification note:</strong> {status.lastVerificationError}
          </p>
        ) : null}
      </section>

      <section className="settings-card">
        <h2>Anthropic Credentials</h2>
        <p className="settings-copy">
          Choose the active auth mode for the core executor. Stored standby
          credentials remain visible but are not exported unless their mode is
          selected.
        </p>

        <label className="settings-field-span">
          <span>Active auth mode</span>
          <select
            value={authModeDraft}
            onChange={(event) => setAuthModeDraft(event.target.value as AuthMode)}
          >
            <option value="subscription">Subscription (Claude Pro/Max)</option>
            <option value="api_key">API Key (Anthropic Console)</option>
            <option value="advanced_bearer">Advanced bearer / gateway</option>
            <option value="none">None</option>
          </select>
        </label>

        {authModeDraft === 'subscription' ? (
          <>
            <p className="settings-copy">
              Use the Claude Code / Claude.ai subscription path for Claude Pro or
              Max. Run Claude login on the machine running ClawRocket, as the
              same OS user that runs the ClawRocket process. API-key mode takes
              precedence over subscription usage when it is selected.
            </p>
            <div className="settings-grid settings-status-grid">
              <div>
                <span className="settings-label">Checked as user</span>
                <strong>
                  {subscriptionHostStatus?.serviceUser || 'Unknown service user'}
                </strong>
              </div>
              <div>
                <span className="settings-label">Home</span>
                <strong>
                  {subscriptionHostStatus?.serviceHomePath || 'Unknown'}
                </strong>
              </div>
              <div>
                <span className="settings-label">Host CLI</span>
                <strong>
                  {subscriptionHostStatus
                    ? subscriptionHostStatus.claudeCliInstalled === true
                      ? 'Installed'
                      : subscriptionHostStatus.claudeCliInstalled === false
                        ? 'Not found'
                        : 'Unavailable'
                    : 'Not checked'}
                </strong>
              </div>
              <div>
                <span className="settings-label">Host login</span>
                <strong>
                  {subscriptionHostStatus
                    ? subscriptionHostStatus.hostLoginDetected
                      ? 'Detected'
                      : 'Not detected'
                    : 'Not checked'}
                </strong>
              </div>
            </div>

            <div className="settings-button-row">
              <button
                type="button"
                className="secondary-btn"
                disabled={subscriptionHostBusy === 'checking'}
                onClick={() => void checkSubscriptionHostLogin()}
              >
                {subscriptionHostBusy === 'checking'
                  ? 'Checking…'
                  : 'Check host Claude login'}
              </button>
              {showSubscriptionImportButton ? (
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={subscriptionHostBusy === 'importing'}
                  onClick={() => void importSubscriptionFromHost()}
                >
                  {subscriptionHostBusy === 'importing'
                    ? 'Importing…'
                    : 'Import from host'}
                </button>
              ) : null}
              <button
                type="button"
                className="secondary-btn"
                onClick={() =>
                  setShowSubscriptionAdvanced((current) => !current)
                }
              >
                {showSubscriptionAdvanced
                  ? 'Hide manual token entry'
                  : 'Paste Claude Code OAuth token manually'}
              </button>
            </div>

            {subscriptionHostStatus ? (
              <div className="settings-host-status">
                <p className="settings-copy">{subscriptionHostStatus.message}</p>
                {subscriptionHostStatus.recommendedCommands.length > 0 ? (
                  <div className="settings-command-list">
                    <strong>Recommended commands</strong>
                    <ul>
                      {subscriptionHostStatus.recommendedCommands.map((command) => (
                        <li key={command}>
                          <code>{command}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : null}

            {showSubscriptionAdvanced ? (
              <div className="settings-advanced-box">
                <p className="settings-copy">
                  Manual fallback is intended for headless or unsupported host
                  setups. You can generate a long-lived token with{' '}
                  <code>claude setup-token</code>, then paste it here.
                </p>
                <p className="settings-copy">
                  {
                    fieldDraftState({
                      stored: settings.hasOauthToken,
                      cleared: clearOauth,
                      draftValue: oauthDraft,
                    }).message
                  }
                </p>
                <div className="settings-form-grid">
                  <label>
                    <span>Claude Code OAuth Token</span>
                    <input
                      type="password"
                      value={oauthDraft}
                      onChange={(event) => {
                        setOauthDraft(event.target.value);
                        setClearOauth(false);
                      }}
                      placeholder={
                        settings.hasOauthToken ? 'Configured' : 'Not configured'
                      }
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
                </div>
              </div>
            ) : null}
          </>
        ) : null}

        {authModeDraft === 'api_key' ? (
          <>
            <p className="settings-copy">
              Use an Anthropic Console API key for normal API billing. Saving this
              mode auto-starts verification in the background.
            </p>
            <p className="settings-copy">
              {
                fieldDraftState({
                  stored: settings.hasApiKey,
                  cleared: clearApiKey,
                  draftValue: apiKeyDraft,
                }).message
              }
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
                  placeholder={
                    settings.hasApiKey ? 'Configured' : 'Not configured'
                  }
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
            </div>
          </>
        ) : null}

        {authModeDraft === 'advanced_bearer' ? (
          <>
            <p className="settings-copy">
              Advanced bearer mode is intended for custom bearer-token or gateway
              deployments. Saving this mode auto-starts verification in the
              background.
            </p>
            <p className="settings-copy">
              {
                fieldDraftState({
                  stored: settings.hasAuthToken,
                  cleared: clearAuthToken,
                  draftValue: authTokenDraft,
                }).message
              }
            </p>
            <div className="settings-form-grid">
              <label>
                <span>Auth Token</span>
                <input
                  type="password"
                  value={authTokenDraft}
                  onChange={(event) => {
                    setAuthTokenDraft(event.target.value);
                    setClearAuthToken(false);
                  }}
                  placeholder={
                    settings.hasAuthToken ? 'Configured' : 'Not configured'
                  }
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
          </>
        ) : null}

        {authModeDraft === 'none' ? (
          <p className="settings-copy">
            The core executor will not export Anthropic credentials while None is
            selected. Real core runs will fail fast until you choose a mode and
            configure its credential.
          </p>
        ) : null}

        {showBaseUrl ? (
          <>
            <p className="settings-copy">
              Anthropic/Gateway Base URL applies to API Key and Advanced bearer
              modes only.
            </p>
            <div className="settings-form-grid">
              <label>
                <span>Anthropic/Gateway Base URL</span>
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
          </>
        ) : null}

        <div className="settings-grid settings-status-grid">
          <div>
            <span className="settings-label">Mode to save</span>
            <strong>{formatAuthMode(authModeDraft)}</strong>
          </div>
          <div>
            <span className="settings-label">Configured</span>
            <strong>{displayedConfiguredLabel}</strong>
          </div>
          <div>
            <span className="settings-label">Status</span>
            <strong>{displayedVerificationLabel}</strong>
          </div>
          <div>
            <span className="settings-label">Last verified</span>
            <strong>{displayedLastVerifiedLabel}</strong>
          </div>
        </div>

        {hasUnsavedModeChange ? (
          <p className="settings-copy">
            <strong>Unsaved change:</strong> saving will switch the active
            Anthropic auth mode from{' '}
            <strong>{formatAuthMode(settings.executorAuthMode)}</strong> to{' '}
            <strong>{formatAuthMode(authModeDraft)}</strong>.
          </p>
        ) : null}

        <p className="settings-copy">
          <strong>Selected mode credential:</strong>{' '}
          {selectedModeCredentialState.message}
        </p>

        {standby.length > 0 ? (
          <div className="settings-standby-list">
            <strong>Stored standby credentials</strong>
            <ul>
              {standby.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {status.lastVerificationError ? (
          <p className="settings-copy">
            <strong>Current verification note:</strong>{' '}
            {status.lastVerificationError}
          </p>
        ) : null}

        <div className="settings-button-row">
          <button
            type="button"
            className="primary-btn"
            disabled={busySection === 'credentials'}
            onClick={() => void saveCredentials()}
          >
            {busySection === 'credentials'
              ? 'Saving…'
              : 'Save Credential Settings'}
          </button>
          {authModeDraft !== 'none' ? (
            <button
              type="button"
              className="secondary-btn"
              disabled={
                busySection === 'verification' ||
                status.verificationStatus === 'verifying'
              }
              onClick={() => void handleVerify()}
            >
              {busySection === 'verification'
                ? 'Starting…'
                : verifyButtonLabel}
            </button>
          ) : null}
        </div>
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
            Service restart is only available when running under the systemd
            service with <code>CLAWROCKET_SELF_RESTART=1</code>.
          </p>
        ) : null}
        {status.activeRunCount > 0 ? (
          <p className="settings-copy">
            There are {status.activeRunCount} active runs that will be interrupted
            and marked as failed on next startup.
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

      {userRole === 'owner' || userRole === 'admin' ? (
        <section className="settings-card">
          <h2>AI Agents</h2>
          <p className="settings-copy">
            Provider credentials, registered agents, and the default agent for
            new talks now live on the AI Agents page.
          </p>
          <div className="settings-section-actions">
            <a className="secondary-btn settings-nav-link" href="/app/agents">
              Open AI Agents
            </a>
          </div>
        </section>
      ) : null}
    </section>
  );
}
