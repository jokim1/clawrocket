import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  AgentProviderCard,
  AiAgentsPageData,
  ApiError,
  ExecutorSettings,
  ExecutorStatus,
  ExecutorSubscriptionHostStatus,
  getAiAgents,
  getExecutorSettings,
  getExecutorStatus,
  getExecutorSubscriptionHostStatus,
  importExecutorSubscriptionFromHost,
  saveAiProviderCredential,
  UnauthorizedError,
  updateDefaultClaudeModel,
  updateExecutorSettings,
  verifyAiProviderCredential,
  verifyExecutorCredentials,
} from '../lib/api';

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type ClaudeAuthMode = 'subscription' | 'api_key';

type ProviderDraft = {
  apiKey: string;
  expanded: boolean;
};

const PROVIDER_DOCS_URL: Record<string, string> = {
  'provider.openai': 'https://platform.openai.com/api-keys',
  'provider.gemini': 'https://aistudio.google.com/app/apikey',
  'provider.deepseek': 'https://platform.deepseek.com/api_keys',
  'provider.kimi': 'https://platform.moonshot.ai/console/api-keys',
};

function canManageAgents(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function validateReturnTo(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/app/')) return null;
  if (value.includes('..')) return null;
  return value;
}

function formatClaudeAuthMode(mode: ExecutorSettings['executorAuthMode']): string {
  switch (mode) {
    case 'subscription':
      return 'Subscription (Claude Pro/Max)';
    case 'api_key':
      return 'API';
    case 'advanced_bearer':
      return 'Advanced bearer / gateway';
    default:
      return 'None';
  }
}

function formatVerificationStatus(
  status: ExecutorStatus['verificationStatus'] | AgentProviderCard['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing';
    case 'not_verified':
      return 'Not verified';
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

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return value;
  return parsed.toLocaleString();
}

function buildProviderDraft(provider: AgentProviderCard): ProviderDraft {
  return {
    apiKey: '',
    expanded: !provider.hasCredential,
  };
}

function currentClaudeHint(
  settings: ExecutorSettings,
  mode: ClaudeAuthMode,
): string | null {
  return mode === 'subscription' ? settings.oauthTokenHint : settings.apiKeyHint;
}

function currentClaudeStored(
  settings: ExecutorSettings,
  mode: ClaudeAuthMode,
): boolean {
  return mode === 'subscription' ? settings.hasOauthToken : settings.hasApiKey;
}

function formatProviderVerificationSummary(
  provider: AgentProviderCard,
): string {
  switch (provider.verificationStatus) {
    case 'verified':
      return 'Configured';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    case 'not_verified':
      return 'Needs verification';
    case 'missing':
    default:
      return 'Not configured';
  }
}

function formatProviderSaveNotice(provider: AgentProviderCard): string {
  switch (provider.verificationStatus) {
    case 'verified':
      return `${provider.name} credential saved and verified.`;
    case 'invalid':
    case 'unavailable':
      return `${provider.name} credential saved. Verification status: ${provider.verificationStatus}.`;
    default:
      return `${provider.name} credential saved.`;
  }
}

export function AiAgentsPage({
  onUnauthorized,
  userRole,
}: Props): JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [settings, setSettings] = useState<ExecutorSettings | null>(null);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderDraft>>(
    {},
  );
  const [claudeModeDraft, setClaudeModeDraft] = useState<ClaudeAuthMode>('subscription');
  const [claudeModelDraft, setClaudeModelDraft] = useState('');
  const [claudeApiKeyDraft, setClaudeApiKeyDraft] = useState('');
  const [claudeOauthDraft, setClaudeOauthDraft] = useState('');
  const [clearClaudeApiKey, setClearClaudeApiKey] = useState(false);
  const [clearClaudeOauth, setClearClaudeOauth] = useState(false);
  const [showSubscriptionAdvanced, setShowSubscriptionAdvanced] = useState(false);
  const [subscriptionHostStatus, setSubscriptionHostStatus] =
    useState<ExecutorSubscriptionHostStatus | null>(null);
  const [subscriptionHostBusy, setSubscriptionHostBusy] = useState<
    'checking' | 'importing' | null
  >(null);
  const verificationPollAttemptsRef = useRef(0);

  const returnTo = validateReturnTo(searchParams.get('returnTo'));
  const canManage = canManageAgents(userRole);

  const syncDrafts = (
    nextData: AiAgentsPageData,
    nextSettings: ExecutorSettings,
  ): void => {
    setData(nextData);
    setSettings(nextSettings);
    setClaudeModeDraft(
      nextSettings.executorAuthMode === 'api_key' ? 'api_key' : 'subscription',
    );
    setClaudeModelDraft(nextData.defaultClaudeModelId);
    setClaudeApiKeyDraft('');
    setClaudeOauthDraft('');
    setClearClaudeApiKey(false);
    setClearClaudeOauth(false);
    setProviderDrafts((current) => {
      const nextDrafts: Record<string, ProviderDraft> = {};
      for (const provider of nextData.additionalProviders) {
        nextDrafts[provider.id] = {
          ...buildProviderDraft(provider),
          expanded: current[provider.id]?.expanded || !provider.hasCredential,
        };
      }
      return nextDrafts;
    });
  };

  const load = async (): Promise<void> => {
    try {
      const [nextData, nextSettings, nextStatus] = await Promise.all([
        getAiAgents(),
        getExecutorSettings(),
        getExecutorStatus(),
      ]);
      syncDrafts(nextData, nextSettings);
      setStatus(nextStatus);
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to load AI agents.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (status?.verificationStatus !== 'verifying') {
      verificationPollAttemptsRef.current = 0;
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const scheduleNext = (): void => {
      const attempt = verificationPollAttemptsRef.current;
      const delayMs = attempt < 5 ? 2_000 : attempt < 15 ? 5_000 : 10_000;
      timer = window.setTimeout(() => {
        void getExecutorStatus()
          .then((nextStatus) => {
            if (cancelled) return;
            verificationPollAttemptsRef.current += 1;
            setStatus(nextStatus);
            if (nextStatus.verificationStatus === 'verifying') {
              scheduleNext();
            }
          })
          .catch((err) => {
            if (cancelled) return;
            if (err instanceof UnauthorizedError) {
              onUnauthorized();
              return;
            }
            setError(
              err instanceof ApiError
                ? err.message
                : 'Failed to refresh Claude verification status.',
            );
          });
      }, delayMs);
    };

    scheduleNext();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [status?.verificationStatus, onUnauthorized]);

  const updateProviderDraft = (
    providerId: string,
    patch: Partial<ProviderDraft>,
  ): void => {
    setProviderDrafts((current) => ({
      ...current,
      [providerId]: {
        ...(current[providerId] || { apiKey: '', expanded: false }),
        ...patch,
      },
    }));
  };

  const refreshProvider = (provider: AgentProviderCard): void => {
    setData((current) =>
      current
        ? {
            ...current,
            additionalProviders: current.additionalProviders.map((entry) =>
              entry.id === provider.id ? provider : entry,
            ),
          }
        : current,
    );
    updateProviderDraft(provider.id, {
      apiKey: '',
      expanded: !provider.hasCredential,
    });
  };

  const handleApiFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const handleSaveClaude = async (): Promise<void> => {
    if (!data || !settings) return;

    setBusyKey('claude-save');
    setNotice(null);
    setError(null);
    try {
      const update: Record<string, string | null> = {
        executorAuthMode: claudeModeDraft,
      };
      if (claudeModeDraft === 'subscription') {
        if (clearClaudeOauth) {
          update.claudeOauthToken = null;
        } else if (claudeOauthDraft.trim()) {
          update.claudeOauthToken = claudeOauthDraft.trim();
        }
      } else if (clearClaudeApiKey) {
        update.anthropicApiKey = null;
      } else if (claudeApiKeyDraft.trim()) {
        update.anthropicApiKey = claudeApiKeyDraft.trim();
      }

      const [nextSettings, nextAgents] = await Promise.all([
        updateExecutorSettings(update),
        claudeModelDraft !== data.defaultClaudeModelId
          ? updateDefaultClaudeModel(claudeModelDraft)
          : Promise.resolve(data),
      ]);
      syncDrafts(nextAgents, nextSettings);
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(
        claudeModeDraft === 'subscription'
          ? 'Default Claude Agent updated for subscription mode.'
          : 'Default Claude Agent updated for API mode.',
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to save Claude settings.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerifyClaude = async (): Promise<void> => {
    setBusyKey('claude-verify');
    setNotice(null);
    setError(null);
    try {
      const result = await verifyExecutorCredentials();
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(result.message || 'Claude verification started.');
    } catch (err) {
      handleApiFailure(err, 'Failed to verify Claude credentials.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCheckSubscriptionHost = async (): Promise<void> => {
    setSubscriptionHostBusy('checking');
    setNotice(null);
    setError(null);
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
    } catch (err) {
      handleApiFailure(err, 'Failed to check Claude host login.');
    } finally {
      setSubscriptionHostBusy(null);
    }
  };

  const handleImportSubscription = async (): Promise<void> => {
    if (!subscriptionHostStatus?.hostCredentialFingerprint) return;
    setSubscriptionHostBusy('importing');
    setNotice(null);
    setError(null);
    try {
      const result = await importExecutorSubscriptionFromHost(
        subscriptionHostStatus.hostCredentialFingerprint,
      );
      const [nextAgents, nextStatus] = await Promise.all([
        getAiAgents(),
        getExecutorStatus(),
      ]);
      syncDrafts(nextAgents, result.settings);
      setStatus(nextStatus);
      setNotice(
        result.status === 'no_change'
          ? 'Claude subscription was already imported.'
          : 'Claude subscription imported from the service host.',
      );
    } catch (err) {
      handleApiFailure(err, 'Failed to import Claude subscription.');
    } finally {
      setSubscriptionHostBusy(null);
    }
  };

  const handleSaveProvider = async (providerId: string): Promise<void> => {
    const draft = providerDrafts[providerId];
    if (!draft) return;
    setBusyKey(`provider-save:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const provider = await saveAiProviderCredential({
        providerId,
        apiKey: draft.apiKey.trim() || null,
      });
      refreshProvider(provider);
      setNotice(formatProviderSaveNotice(provider));
    } catch (err) {
      handleApiFailure(err, 'Failed to save provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearProvider = async (providerId: string): Promise<void> => {
    setBusyKey(`provider-save:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const provider = await saveAiProviderCredential({
        providerId,
        apiKey: null,
      });
      refreshProvider(provider);
      setNotice(`${provider.name} credential deleted.`);
    } catch (err) {
      handleApiFailure(err, 'Failed to delete provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerifyProvider = async (providerId: string): Promise<void> => {
    setBusyKey(`provider-verify:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const provider = await verifyAiProviderCredential(providerId);
      refreshProvider(provider);
      setNotice(`${provider.name} verification updated.`);
    } catch (err) {
      handleApiFailure(err, 'Failed to verify provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const additionalProviders = data?.additionalProviders || [];
  const selectedClaudeHint = settings ? currentClaudeHint(settings, claudeModeDraft) : null;
  const selectedClaudeStored = settings
    ? currentClaudeStored(settings, claudeModeDraft)
    : false;

  const selectedClaudeStatus = useMemo(() => {
    if (!settings || !status) return 'Loading…';
    if (status.executorAuthMode !== claudeModeDraft) {
      return 'Ready to save';
    }
    if (!selectedClaudeStored) {
      return 'Not configured';
    }
    return formatVerificationStatus(status.verificationStatus);
  }, [claudeModeDraft, selectedClaudeStored, settings, status]);

  if (loading) {
    return <section className="page-state">Loading AI agents…</section>;
  }

  if (!data || !settings || !status) {
    return <section className="page-state">AI agents are unavailable.</section>;
  }

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>AI Agents</h1>
          <p>Set up your default Claude agent and any additional provider keys you want available in talks.</p>
        </div>
        {returnTo ? (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => navigate(returnTo)}
          >
            Return to talk
          </button>
        ) : null}
      </header>

      {error ? (
        <div className="inline-banner inline-banner-error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="inline-banner inline-banner-success" role="status">
          {notice}
        </div>
      ) : null}

      <section className="talk-llm-section">
        <div className="talk-llm-section-header">
          <div>
            <h3>Default Claude Agent</h3>
            <p className="talk-llm-meta">
              Every new talk starts with Claude as the default agent. You can add other agents and roles inside the talk itself.
            </p>
          </div>
        </div>

        <article className="talk-llm-card">
          <div className="talk-llm-card-header">
            <div>
              <h4>Claude</h4>
              <p className="talk-llm-meta">
                Configure the Claude capability every new talk starts with.
              </p>
            </div>
            <span className="talk-agent-chip">{selectedClaudeStatus}</span>
          </div>

          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>Billing model</span>
              <select
                value={claudeModeDraft}
                onChange={(event) =>
                  setClaudeModeDraft(event.target.value as ClaudeAuthMode)
                }
                disabled={!canManage || busyKey === 'claude-save'}
              >
                <option value="subscription">Subscription (Claude Pro/Max)</option>
                <option value="api_key">API</option>
              </select>
            </label>

            <label className="talk-llm-field-span">
              <span>Default Claude model</span>
              <select
                value={claudeModelDraft}
                onChange={(event) => setClaudeModelDraft(event.target.value)}
                disabled={!canManage || busyKey === 'claude-save'}
              >
                {data.claudeModelSuggestions.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {claudeModeDraft === 'subscription' ? (
            <div className="talk-llm-grid">
              <div className="talk-llm-field-span">
                <span>Subscription credential</span>
                {selectedClaudeStored ? (
                  <div className="talk-llm-stored-key">
                    <div>
                      <strong>{selectedClaudeHint || 'Stored in settings'}</strong>
                      <p className="talk-llm-meta">
                        Last verified {formatDateTime(status.lastVerifiedAt)}
                      </p>
                    </div>
                    <span className="talk-agent-chip">
                      {formatVerificationStatus(status.verificationStatus)}
                    </span>
                  </div>
                ) : (
                  <p className="talk-llm-meta">
                    No Claude subscription credential is stored yet.
                  </p>
                )}
                <p className="talk-llm-meta">
                  Use Claude Code on the same machine and OS user as ClawRocket. Run:
                  <code> claude config set -g forceLoginMethod claudeai </code>
                  then
                  <code> claude login</code>.
                </p>
                <p className="talk-llm-meta">
                  If host import is unavailable, you can run <code>claude setup-token</code> and paste the token manually below.
                </p>
                <div className="talk-llm-inline-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => void handleCheckSubscriptionHost()}
                    disabled={!canManage || subscriptionHostBusy === 'checking'}
                  >
                    {subscriptionHostBusy === 'checking'
                      ? 'Checking…'
                      : 'Check host Claude login'}
                  </button>
                  {subscriptionHostStatus?.importAvailable ? (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleImportSubscription()}
                      disabled={!canManage || subscriptionHostBusy === 'importing'}
                    >
                      {subscriptionHostBusy === 'importing'
                        ? 'Importing…'
                        : 'Import from host'}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={() => setShowSubscriptionAdvanced((current) => !current)}
                  >
                    {showSubscriptionAdvanced
                      ? 'Hide manual token entry'
                      : 'Paste Claude Code OAuth token manually'}
                  </button>
                </div>
                {subscriptionHostStatus ? (
                  <div className="talk-llm-host-status">
                    <p className="talk-llm-meta">
                      Checked as user {subscriptionHostStatus.serviceUser || 'unknown'} · Home{' '}
                      {subscriptionHostStatus.serviceHomePath}
                    </p>
                    <p className="talk-llm-meta">{subscriptionHostStatus.message}</p>
                    {subscriptionHostStatus.recommendedCommands.length > 0 ? (
                      <div className="talk-llm-command-list">
                        {subscriptionHostStatus.recommendedCommands.map((command) => (
                          <code key={command}>{command}</code>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {showSubscriptionAdvanced ? (
                  <label className="talk-llm-field-span">
                    <span>Claude Code OAuth token</span>
                    <input
                      type="password"
                      value={claudeOauthDraft}
                      onChange={(event) => {
                        setClaudeOauthDraft(event.target.value);
                        setClearClaudeOauth(false);
                      }}
                      placeholder="Paste token from claude setup-token"
                      disabled={!canManage || busyKey === 'claude-save'}
                    />
                  </label>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="talk-llm-grid">
              <div className="talk-llm-field-span">
                <span>Anthropic API credential</span>
                {selectedClaudeStored ? (
                  <div className="talk-llm-stored-key">
                    <div>
                      <strong>{selectedClaudeHint || 'Stored in settings'}</strong>
                      <p className="talk-llm-meta">
                        Get a key from{' '}
                        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">
                          Anthropic Console
                        </a>
                        .
                      </p>
                    </div>
                    <span className="talk-agent-chip">
                      {formatVerificationStatus(status.verificationStatus)}
                    </span>
                  </div>
                ) : (
                  <p className="talk-llm-meta">
                    Use an Anthropic Console API key for Claude in talks.
                  </p>
                )}
                <label className="talk-llm-field-span">
                  <span>Anthropic API key</span>
                  <input
                    type="password"
                    value={claudeApiKeyDraft}
                    onChange={(event) => {
                      setClaudeApiKeyDraft(event.target.value);
                      setClearClaudeApiKey(false);
                    }}
                    placeholder="sk-ant-..."
                    disabled={!canManage || busyKey === 'claude-save'}
                  />
                </label>
              </div>
            </div>
          )}

          <div className="talk-llm-inline-actions">
            {claudeModeDraft === 'subscription' && settings.hasOauthToken ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setClearClaudeOauth(true)}
                disabled={!canManage || busyKey === 'claude-save'}
              >
                Clear stored subscription token
              </button>
            ) : null}
            {claudeModeDraft === 'api_key' && settings.hasApiKey ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => setClearClaudeApiKey(true)}
                disabled={!canManage || busyKey === 'claude-save'}
              >
                Clear stored API key
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-btn"
              onClick={() => void handleVerifyClaude()}
              disabled={!canManage || busyKey === 'claude-verify'}
            >
              {busyKey === 'claude-verify' ? 'Verifying…' : 'Re-verify'}
            </button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleSaveClaude()}
              disabled={!canManage || busyKey === 'claude-save'}
            >
              {busyKey === 'claude-save' ? 'Saving…' : 'Save Claude Settings'}
            </button>
          </div>
        </article>
      </section>

      <section className="talk-llm-section">
        <div className="talk-llm-section-header">
          <div>
            <h3>Additional Providers</h3>
            <p className="talk-llm-meta">
              Add any other provider keys you want available when inviting extra agents into a talk.
            </p>
          </div>
        </div>

        <div className="talk-llm-card-list">
          {additionalProviders.map((provider) => {
            const draft = providerDrafts[provider.id] || buildProviderDraft(provider);
            const busySave = busyKey === `provider-save:${provider.id}`;
            const busyVerify = busyKey === `provider-verify:${provider.id}`;
            return (
              <article key={provider.id} className="talk-llm-card">
                <div className="talk-llm-card-header">
                  <div>
                    <h4>{provider.name}</h4>
                    <p className="talk-llm-meta">
                      {PROVIDER_DOCS_URL[provider.id] ? (
                        <a
                          href={PROVIDER_DOCS_URL[provider.id]}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Get key from {provider.name}
                        </a>
                      ) : (
                        'Configure this provider for additional talk agents.'
                      )}
                    </p>
                  </div>
                  <span className="talk-agent-chip">
                    {formatProviderVerificationSummary(provider)}
                  </span>
                </div>

                {provider.hasCredential ? (
                  <div className="talk-llm-stored-key">
                    <div>
                      <strong>{provider.credentialHint || 'Stored in settings'}</strong>
                      <p className="talk-llm-meta">
                        Last verified {formatDateTime(provider.lastVerifiedAt)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="icon-btn danger-btn"
                      onClick={() => void handleClearProvider(provider.id)}
                      disabled={!canManage || busySave}
                      aria-label={`Delete ${provider.name} credential`}
                    >
                      ×
                    </button>
                  </div>
                ) : null}

                <details
                  className="talk-llm-update-disclosure"
                  open={draft.expanded}
                  onToggle={(event) =>
                    updateProviderDraft(provider.id, {
                      expanded: (event.currentTarget as HTMLDetailsElement).open,
                    })
                  }
                >
                  <summary>{provider.hasCredential ? 'Update key' : 'Configure'}</summary>
                  <div className="talk-llm-grid">
                    <label className="talk-llm-field-span">
                      <span>API key</span>
                      <input
                        type="password"
                        value={draft.apiKey}
                        onChange={(event) =>
                          updateProviderDraft(provider.id, {
                            apiKey: event.target.value,
                          })
                        }
                        placeholder="sk-..."
                        disabled={!canManage || busySave}
                      />
                    </label>
                    <div className="talk-llm-inline-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => void handleSaveProvider(provider.id)}
                        disabled={!canManage || busySave}
                      >
                        {busySave ? 'Saving…' : provider.hasCredential ? 'Update' : 'Save'}
                      </button>
                      {provider.hasCredential ? (
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => void handleVerifyProvider(provider.id)}
                          disabled={!canManage || busyVerify}
                        >
                          {busyVerify ? 'Verifying…' : 'Re-verify'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </details>
              </article>
            );
          })}
        </div>
      </section>

      {returnTo ? (
        <section className="talk-llm-section">
          <div className="talk-llm-section-header">
            <div>
              <h3>Back to Talk</h3>
              <p className="talk-llm-meta">
                After updating Claude or provider keys, return to your talk and invite additional agents there.
              </p>
            </div>
          </div>
          <Link to={returnTo} className="primary-btn">
            Return to talk
          </Link>
        </section>
      ) : null}
    </section>
  );
}
