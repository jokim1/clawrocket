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
  getMainRegisteredAgent,
  importExecutorSubscriptionFromHost,
  listRegisteredAgents,
  type RegisteredAgent,
  saveAiProviderCredential,
  UnauthorizedError,
  updateDefaultClaudeModel,
  updateExecutorSettings,
  updateMainRegisteredAgent,
  verifyAiProviderCredential,
  verifyExecutorCredentials,
} from '../lib/api';
import { RegisteredAgentsPanel } from '../components/RegisteredAgentsPanel';

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type ClaudeAuthMode = 'subscription' | 'api_key';

type ProviderDraft = {
  apiKey: string;
  expanded: boolean;
  showApiKey: boolean;
};

const PROVIDER_DOCS_URL: Record<string, string> = {
  'provider.openai': 'https://platform.openai.com/api-keys',
  'provider.gemini': 'https://aistudio.google.com/app/apikey',
  'provider.deepseek': 'https://platform.deepseek.com/api_keys',
  'provider.kimi': 'https://platform.moonshot.ai/console/api-keys',
  'provider.nvidia': 'https://build.nvidia.com/',
};

const PROVIDER_DOCS_LABEL: Record<string, string> = {
  'provider.nvidia': 'NVIDIA',
};

const PROVIDER_KEY_PLACEHOLDER: Record<string, string> = {
  'provider.nvidia': 'nvapi-...',
};

const PROVIDER_SAVE_POLL_DELAYS_MS = [
  1_500,
  1_500,
  2_500,
  3_500,
  5_000,
  5_000,
  5_000,
  5_000,
  5_000,
];

function canManageAgents(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function validateReturnTo(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/app/')) return null;
  if (value.includes('..')) return null;
  return value;
}

function formatClaudeAuthMode(
  mode: ExecutorSettings['executorAuthMode'],
): string {
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
  status:
    | ExecutorStatus['verificationStatus']
    | AgentProviderCard['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing';
    case 'not_verified':
      return 'Not verified';
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Verified';
    case 'invalid':
      return 'Invalid';
    case 'unavailable':
      return 'Unavailable';
    default:
      return status;
  }
}

function verificationStatusClass(
  status:
    | ExecutorStatus['verificationStatus']
    | AgentProviderCard['verificationStatus'],
): string {
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
    showApiKey: false,
  };
}

function currentClaudeHint(
  settings: ExecutorSettings,
  mode: ClaudeAuthMode,
): string | null {
  return mode === 'subscription'
    ? settings.oauthTokenHint
    : settings.apiKeyHint;
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
    case 'verifying':
      return 'Verifying…';
    case 'verified':
      return 'Verified';
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
    case 'verifying':
    case 'not_verified':
      return `${provider.name} credential saved. Verification is running in the background.`;
    case 'verified':
      return `${provider.name} credential saved and verified.`;
    case 'invalid':
    case 'unavailable':
      return `${provider.name} credential saved. Verification status: ${provider.verificationStatus}.`;
    default:
      return `${provider.name} credential saved.`;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function AiAgentsPage({ onUnauthorized, userRole }: Props): JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [settings, setSettings] = useState<ExecutorSettings | null>(null);
  const [status, setStatus] = useState<ExecutorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<
    Record<string, ProviderDraft>
  >({});
  const [claudeModeDraft, setClaudeModeDraft] =
    useState<ClaudeAuthMode>('subscription');
  const [claudeModelDraft, setClaudeModelDraft] = useState('');
  const [claudeApiKeyDraft, setClaudeApiKeyDraft] = useState('');
  const [claudeOauthDraft, setClaudeOauthDraft] = useState('');
  const [showClaudeApiKey, setShowClaudeApiKey] = useState(false);
  const [showClaudeOauthToken, setShowClaudeOauthToken] = useState(false);
  const [subscriptionHostStatus, setSubscriptionHostStatus] =
    useState<ExecutorSubscriptionHostStatus | null>(null);
  const [subscriptionHostBusy, setSubscriptionHostBusy] = useState<
    'checking' | 'importing' | null
  >(null);
  const verificationPollAttemptsRef = useRef(0);
  const [registeredAgents, setRegisteredAgents] = useState<RegisteredAgent[]>(
    [],
  );
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [mainAgentDraft, setMainAgentDraft] = useState<string>('');

  const returnTo = validateReturnTo(searchParams.get('returnTo'));
  const canManage = canManageAgents(userRole);

  // Build a complete providers list for the registered-agents panel,
  // including Claude (which AiAgentsPageData treats separately).
  //
  // v1 scope: Registered agents using provider.anthropic can ONLY execute
  // via direct HTTP with an Anthropic API key (x-api-key auth).
  // Subscription/OAuth credentials are NOT compatible with this path —
  // they require container execution, which is a separate flow.
  //
  // The synthetic card must honestly show Claude as "ready" only when
  // an API key is configured.  In subscription/OAuth mode, the card is
  // still shown (agents may exist that reference it) but marked as not
  // having a usable credential for direct execution.
  const allProvidersForPanel = useMemo((): AgentProviderCard[] => {
    if (!data || !settings) return [];
    const isApiKeyMode = settings.executorAuthMode === 'api_key';
    // Only API key mode is compatible with direct HTTP execution.
    // Subscription/OAuth users see Claude as "no credential" for agent
    // creation — their Claude access works through container execution,
    // not through the registered-agents direct path.
    const claudeDirectHttpReady = isApiKeyMode && settings.hasApiKey;
    const claudeCard: AgentProviderCard = {
      id: 'provider.anthropic',
      name: 'Claude (Anthropic)',
      providerKind: 'anthropic',
      apiFormat: 'anthropic_messages',
      baseUrl: settings.anthropicBaseUrl || 'https://api.anthropic.com',
      authScheme: 'x_api_key',
      enabled: true,
      hasCredential: claudeDirectHttpReady,
      credentialHint: claudeDirectHttpReady ? settings.apiKeyHint : null,
      verificationStatus: claudeDirectHttpReady
        ? settings.verificationStatus
        : 'missing',
      lastVerifiedAt: claudeDirectHttpReady ? settings.lastVerifiedAt : null,
      lastVerificationError: claudeDirectHttpReady
        ? settings.lastVerificationError
        : null,
      modelSuggestions: data.claudeModelSuggestions,
    };
    return [claudeCard, ...data.additionalProviders];
  }, [data, settings]);

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
    setShowClaudeApiKey(false);
    setShowClaudeOauthToken(false);
    setProviderDrafts((current) => {
      const nextDrafts: Record<string, ProviderDraft> = {};
      for (const provider of nextData.additionalProviders) {
        nextDrafts[provider.id] = {
          ...buildProviderDraft(provider),
          expanded: current[provider.id]?.expanded || !provider.hasCredential,
          showApiKey: current[provider.id]?.showApiKey || false,
        };
      }
      return nextDrafts;
    });
  };

  const load = async (): Promise<void> => {
    try {
      const [nextData, nextSettings, nextStatus, agents, mainAgent] =
        await Promise.all([
          getAiAgents(),
          getExecutorSettings(),
          getExecutorStatus(),
          listRegisteredAgents(),
          getMainRegisteredAgent().catch(() => null),
        ]);
      syncDrafts(nextData, nextSettings);
      setStatus(nextStatus);
      setRegisteredAgents(agents);
      if (mainAgent) {
        setMainAgentId(mainAgent.id);
        setMainAgentDraft(mainAgent.id);
      }
      setError(null);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to load AI agents.',
      );
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

  useEffect(() => {
    if (claudeModeDraft !== 'subscription') {
      setSubscriptionHostStatus(null);
      return;
    }

    let cancelled = false;
    setSubscriptionHostBusy('checking');
    void getExecutorSubscriptionHostStatus()
      .then((nextHostStatus) => {
        if (cancelled) return;
        setSubscriptionHostStatus(nextHostStatus);
      })
      .catch((err) => {
        if (cancelled) return;
        handleApiFailure(err, 'Failed to check Claude host login.');
      })
      .finally(() => {
        if (!cancelled) {
          setSubscriptionHostBusy(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [claudeModeDraft, onUnauthorized]);

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

  const pollProviderAfterSave = async (providerId: string): Promise<void> => {
    for (const delayMs of PROVIDER_SAVE_POLL_DELAYS_MS) {
      await delay(delayMs);
      try {
        const nextData = await getAiAgents();
        const nextProvider = nextData.additionalProviders.find(
          (entry) => entry.id === providerId,
        );
        if (!nextProvider) return;

        refreshProvider(nextProvider);
        if (
          nextProvider.verificationStatus === 'not_verified' ||
          nextProvider.verificationStatus === 'verifying'
        ) {
          continue;
        }

        if (nextProvider.verificationStatus === 'verified') {
          setNotice(`${nextProvider.name} credential verified.`);
        } else if (nextProvider.verificationStatus !== 'missing') {
          setNotice(
            `${nextProvider.name} verification status: ${formatVerificationStatus(nextProvider.verificationStatus)}.`,
          );
          return;
        }
        return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        return;
      }
    }
  };

  const handleSaveMainAgent = async (): Promise<void> => {
    if (!mainAgentDraft || mainAgentDraft === mainAgentId) return;
    setBusyKey('main-agent-save');
    setNotice(null);
    setError(null);
    try {
      const updated = await updateMainRegisteredAgent(mainAgentDraft);
      setMainAgentId(updated.id);
      setMainAgentDraft(updated.id);
      setNotice('Main agent updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update main agent.',
      );
    } finally {
      setBusyKey(null);
    }
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
      const shouldAutoVerify =
        (claudeModeDraft === 'subscription' &&
          claudeOauthDraft.trim().length > 0) ||
        (claudeModeDraft === 'api_key' && claudeApiKeyDraft.trim().length > 0);
      if (claudeModeDraft === 'subscription') {
        if (claudeOauthDraft.trim()) {
          update.claudeOauthToken = claudeOauthDraft.trim();
        }
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
      let verifyMessage: string | null = null;
      if (shouldAutoVerify) {
        const result = await verifyExecutorCredentials();
        verifyMessage = result.message || 'Claude verification started.';
      }
      const nextStatus = await getExecutorStatus();
      setStatus(nextStatus);
      setNotice(
        verifyMessage ||
          (claudeModeDraft === 'subscription'
            ? 'Default Claude Agent updated for subscription mode.'
            : 'Default Claude Agent updated for API mode.'),
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
      if (
        provider.hasCredential &&
        (provider.verificationStatus === 'not_verified' ||
          provider.verificationStatus === 'verifying')
      ) {
        void pollProviderAfterSave(provider.id);
      }
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
  const selectedClaudeHint = settings
    ? currentClaudeHint(settings, claudeModeDraft)
    : null;
  const selectedClaudeStored = settings
    ? currentClaudeStored(settings, claudeModeDraft)
    : false;
  const hasUnsavedClaudeCredentialDraft =
    claudeModeDraft === 'subscription'
      ? claudeOauthDraft.trim().length > 0
      : claudeApiKeyDraft.trim().length > 0;
  const showManualTokenFlow =
    claudeModeDraft === 'subscription' &&
    !!subscriptionHostStatus?.hostLoginDetected &&
    !subscriptionHostStatus.importAvailable;
  const showHostLoginFlow =
    claudeModeDraft === 'subscription' && !showManualTokenFlow;
  const canVerifyStoredClaude =
    canManage && selectedClaudeStored && !hasUnsavedClaudeCredentialDraft;

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
          <p>
            Set up your default Claude agent and any additional provider keys
            you want available in talks.
          </p>
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
              Every new talk starts with Claude as the default agent. You can
              add other agents and roles inside the talk itself.
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
            <span
              className={verificationStatusClass(
                status.executorAuthMode !== claudeModeDraft ||
                  !selectedClaudeStored
                  ? 'not_verified'
                  : status.verificationStatus,
              )}
            >
              {selectedClaudeStatus}
            </span>
          </div>

          <div className="talk-llm-grid">
            <fieldset className="talk-llm-field-span talk-llm-radio-group">
              <span>Billing model</span>
              <div className="talk-llm-radio-options">
                <label className="talk-llm-radio-option">
                  <input
                    type="radio"
                    name="claude-billing-model"
                    value="subscription"
                    checked={claudeModeDraft === 'subscription'}
                    onChange={() => setClaudeModeDraft('subscription')}
                    disabled={!canManage || busyKey === 'claude-save'}
                  />
                  <span>Subscription</span>
                </label>
                <label className="talk-llm-radio-option">
                  <input
                    type="radio"
                    name="claude-billing-model"
                    value="api_key"
                    checked={claudeModeDraft === 'api_key'}
                    onChange={() => setClaudeModeDraft('api_key')}
                    disabled={!canManage || busyKey === 'claude-save'}
                  />
                  <span>API</span>
                </label>
              </div>
            </fieldset>

            <label className="talk-llm-field-span">
              <span>Model for new talks</span>
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
                      <strong>
                        {selectedClaudeHint || 'Stored in settings'}
                      </strong>
                      <p className="talk-llm-meta">
                        Last verified {formatDateTime(status.lastVerifiedAt)}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="talk-llm-meta">
                    No Claude subscription credential is stored yet.
                  </p>
                )}
                {showHostLoginFlow ? (
                  <p className="talk-llm-meta">
                    Use Claude Code on the same machine and OS user as
                    ClawRocket. Run{' '}
                    <code>claude config set -g forceLoginMethod claudeai</code>{' '}
                    and then <code>claude login</code>. If host import is
                    unavailable, you can still run{' '}
                    <code>claude setup-token</code> and paste the token manually
                    below.
                  </p>
                ) : (
                  <p className="talk-llm-meta">
                    Automatic host import is unavailable for this Claude login.
                    Run <code>claude setup-token</code>, paste the token below,
                    and save to verify it.
                  </p>
                )}
                <p className="talk-llm-meta">
                  Saving a new token stores it and immediately verifies it.
                  Verify stored credential only re-checks the subscription
                  login/token already saved in ClawRocket.
                </p>
                <div className="talk-llm-inline-actions">
                  {subscriptionHostStatus?.importAvailable ? (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleImportSubscription()}
                      disabled={
                        !canManage || subscriptionHostBusy === 'importing'
                      }
                    >
                      {subscriptionHostBusy === 'importing'
                        ? 'Importing…'
                        : 'Import from host'}
                    </button>
                  ) : null}
                </div>
                {subscriptionHostBusy === 'checking' ? (
                  <p className="talk-llm-meta">
                    Checking Claude login on this host…
                  </p>
                ) : null}
                {subscriptionHostStatus ? (
                  <div className="talk-llm-host-status">
                    <p className="talk-llm-meta">
                      Checked as user{' '}
                      {subscriptionHostStatus.serviceUser || 'unknown'} · Home{' '}
                      {subscriptionHostStatus.serviceHomePath}
                    </p>
                    <p className="talk-llm-meta">
                      {subscriptionHostStatus.message}
                    </p>
                    {!showManualTokenFlow &&
                    subscriptionHostStatus.recommendedCommands.length > 0 ? (
                      <div className="talk-llm-command-list">
                        {subscriptionHostStatus.recommendedCommands.map(
                          (command) => (
                            <code key={command}>{command}</code>
                          ),
                        )}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <label className="talk-llm-field-span">
                  <span>Claude Code OAuth token</span>
                  <div className="talk-llm-secret-input">
                    <input
                      type={showClaudeOauthToken ? 'text' : 'password'}
                      value={claudeOauthDraft}
                      onChange={(event) => {
                        setClaudeOauthDraft(event.target.value);
                      }}
                      placeholder="Paste token from claude setup-token"
                      disabled={!canManage || busyKey === 'claude-save'}
                    />
                    <button
                      type="button"
                      className="talk-llm-eye-toggle"
                      onClick={() =>
                        setShowClaudeOauthToken((current) => !current)
                      }
                      disabled={!canManage || busyKey === 'claude-save'}
                      aria-label={
                        showClaudeOauthToken
                          ? 'Hide Claude Code OAuth token'
                          : 'Show Claude Code OAuth token'
                      }
                    >
                      {showClaudeOauthToken ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
              </div>
            </div>
          ) : (
            <div className="talk-llm-grid">
              <div className="talk-llm-field-span">
                <span>Anthropic API credential</span>
                {selectedClaudeStored ? (
                  <div className="talk-llm-stored-key">
                    <div>
                      <strong>
                        {selectedClaudeHint || 'Stored in settings'}
                      </strong>
                      <p className="talk-llm-meta">
                        Get a key from{' '}
                        <a
                          href="https://console.anthropic.com/settings/keys"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Anthropic Console
                        </a>
                        .
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="talk-llm-meta">
                    Use an Anthropic Console API key for Claude in talks.
                  </p>
                )}
                <label className="talk-llm-field-span">
                  <span>Anthropic API key</span>
                  <div className="talk-llm-secret-input">
                    <input
                      type={showClaudeApiKey ? 'text' : 'password'}
                      value={claudeApiKeyDraft}
                      onChange={(event) => {
                        setClaudeApiKeyDraft(event.target.value);
                      }}
                      placeholder="sk-ant-..."
                      disabled={!canManage || busyKey === 'claude-save'}
                    />
                    <button
                      type="button"
                      className="talk-llm-eye-toggle"
                      onClick={() => setShowClaudeApiKey((current) => !current)}
                      disabled={!canManage || busyKey === 'claude-save'}
                      aria-label={
                        showClaudeApiKey
                          ? 'Hide Anthropic API key'
                          : 'Show Anthropic API key'
                      }
                    >
                      {showClaudeApiKey ? 'Hide' : 'Show'}
                    </button>
                  </div>
                </label>
              </div>
            </div>
          )}

          <div className="talk-llm-inline-actions">
            {canVerifyStoredClaude ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => void handleVerifyClaude()}
                disabled={busyKey === 'claude-verify'}
              >
                {busyKey === 'claude-verify'
                  ? 'Verifying…'
                  : 'Verify stored credential'}
              </button>
            ) : null}
            <button
              type="button"
              className="primary-btn"
              onClick={() => void handleSaveClaude()}
              disabled={!canManage || busyKey === 'claude-save'}
            >
              {busyKey === 'claude-save'
                ? hasUnsavedClaudeCredentialDraft
                  ? 'Saving and verifying…'
                  : 'Saving…'
                : hasUnsavedClaudeCredentialDraft
                  ? 'Save and verify Claude'
                  : 'Save Claude Settings'}
            </button>
          </div>
        </article>
      </section>

      <section className="talk-llm-section">
        <div className="talk-llm-section-header">
          <div>
            <h3>Additional Providers</h3>
            <p className="talk-llm-meta">
              Add any other provider keys you want available when inviting extra
              agents into a talk.
            </p>
          </div>
        </div>

        <div className="talk-llm-card-list">
          {additionalProviders.map((provider) => {
            const draft =
              providerDrafts[provider.id] || buildProviderDraft(provider);
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
                          Get key from{' '}
                          {PROVIDER_DOCS_LABEL[provider.id] || provider.name}
                        </a>
                      ) : (
                        'Configure this provider for additional talk agents.'
                      )}
                    </p>
                  </div>
                  <span
                    className={verificationStatusClass(
                      provider.verificationStatus,
                    )}
                  >
                    {formatProviderVerificationSummary(provider)}
                  </span>
                </div>

                {provider.hasCredential ? (
                  <div className="talk-llm-stored-key">
                    <div>
                      <strong>
                        {provider.credentialHint || 'Stored in settings'}
                      </strong>
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
                      expanded: (event.currentTarget as HTMLDetailsElement)
                        .open,
                    })
                  }
                >
                  <summary>
                    {provider.hasCredential ? 'Update key' : 'Configure'}
                  </summary>
                  <div className="talk-llm-grid">
                    <label className="talk-llm-field-span">
                      <span>API key</span>
                      <div className="talk-llm-secret-input">
                        <input
                          type={draft.showApiKey ? 'text' : 'password'}
                          value={draft.apiKey}
                          onChange={(event) =>
                            updateProviderDraft(provider.id, {
                              apiKey: event.target.value,
                            })
                          }
                          placeholder={
                            PROVIDER_KEY_PLACEHOLDER[provider.id] || 'sk-...'
                          }
                          disabled={!canManage || busySave}
                        />
                        <button
                          type="button"
                          className="talk-llm-eye-toggle"
                          onClick={() =>
                            updateProviderDraft(provider.id, {
                              showApiKey: !draft.showApiKey,
                            })
                          }
                          disabled={!canManage || busySave}
                          aria-label={
                            draft.showApiKey
                              ? `Hide ${provider.name} API key`
                              : `Show ${provider.name} API key`
                          }
                        >
                          {draft.showApiKey ? 'Hide' : 'Show'}
                        </button>
                      </div>
                    </label>
                    <div className="talk-llm-inline-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => void handleSaveProvider(provider.id)}
                        disabled={!canManage || busySave}
                      >
                        {busySave
                          ? 'Saving…'
                          : provider.hasCredential
                            ? 'Update'
                            : 'Save'}
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

      <RegisteredAgentsPanel
        providers={allProvidersForPanel}
        onUnauthorized={onUnauthorized}
        canManage={canManage}
        onAgentsChanged={setRegisteredAgents}
      />

      {registeredAgents.length > 0 ? (
        <section className="talk-llm-section">
          <div className="talk-llm-section-header">
            <div>
              <h3>Main Agent</h3>
              <p className="talk-llm-meta">
                The main agent is used for the home channel and as the default
                when no Talk-specific agent is assigned.
              </p>
            </div>
          </div>
          <article className="talk-llm-card">
            <div className="talk-llm-grid">
              <label className="talk-llm-field-span">
                <span>Select main agent</span>
                <select
                  value={mainAgentDraft}
                  onChange={(event) => setMainAgentDraft(event.target.value)}
                  disabled={!canManage || busyKey === 'main-agent-save'}
                >
                  <option value="" disabled>
                    Choose an agent…
                  </option>
                  {registeredAgents
                    .filter((a) => a.enabled)
                    .map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.modelId})
                      </option>
                    ))}
                </select>
              </label>
              <div className="talk-llm-inline-actions">
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => void handleSaveMainAgent()}
                  disabled={
                    !canManage ||
                    busyKey === 'main-agent-save' ||
                    !mainAgentDraft ||
                    mainAgentDraft === mainAgentId
                  }
                >
                  {busyKey === 'main-agent-save'
                    ? 'Saving…'
                    : 'Set as Main Agent'}
                </button>
              </div>
            </div>
          </article>
        </section>
      ) : null}

      {returnTo ? (
        <section className="talk-llm-section">
          <div className="talk-llm-section-header">
            <div>
              <h3>Back to Talk</h3>
              <p className="talk-llm-meta">
                After updating Claude or provider keys, return to your talk and
                invite additional agents there.
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
