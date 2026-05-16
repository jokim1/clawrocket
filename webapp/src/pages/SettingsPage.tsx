import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import {
  ApiError,
  type AgentProviderCard,
  type AiAgentsPageData,
  type ExecutorSettings,
  type RegisteredAgent,
  type SessionUser,
  getAiAgents,
  getMainRegisteredAgent,
  listRegisteredAgents,
  saveAiProviderCredential,
  UnauthorizedError,
  updateMainRegisteredAgent,
  updateSessionMe,
  verifyAiProviderCredential,
} from '../lib/api';
import { RegisteredAgentsPanel } from '../components/RegisteredAgentsPanel';

type Props = {
  user: SessionUser;
  userRole: string;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
};

type SettingsTab = 'profile' | 'api-keys' | 'agents';

type ProviderDraft = {
  apiKey: string;
  showApiKey: boolean;
  expanded: boolean;
};

const TAB_VALUES: readonly SettingsTab[] = ['profile', 'api-keys', 'agents'];

const PROVIDER_DOCS: Record<string, { url: string; label: string }> = {
  'provider.anthropic': {
    url: 'https://console.anthropic.com/settings/keys',
    label: 'Anthropic Console',
  },
  'provider.openai': {
    url: 'https://platform.openai.com/api-keys',
    label: 'OpenAI Platform',
  },
  'provider.gemini': {
    url: 'https://aistudio.google.com/app/apikey',
    label: 'Google AI Studio',
  },
  'provider.nvidia': {
    url: 'https://build.nvidia.com/',
    label: 'NVIDIA Build',
  },
};

const PROVIDER_KEY_PLACEHOLDER: Record<string, string> = {
  'provider.anthropic': 'sk-ant-...',
  'provider.openai': 'sk-...',
  'provider.gemini': 'AIza...',
  'provider.nvidia': 'nvapi-...',
};

function parseTab(value: string | null): SettingsTab {
  return TAB_VALUES.includes(value as SettingsTab)
    ? (value as SettingsTab)
    : 'profile';
}

function canManageAdmin(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function formatDateTime(value: string | null): string {
  if (!value) return 'Never';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function formatVerification(provider: AgentProviderCard): string {
  switch (provider.verificationStatus) {
    case 'verified':
      return 'Verified';
    case 'invalid':
      return 'Invalid';
    case 'verifying':
      return 'Verifying…';
    case 'rate_limited':
      return 'Rate limited';
    case 'unavailable':
      return 'Unavailable';
    case 'not_verified':
      return 'Needs verification';
    case 'missing':
    default:
      return 'Not configured';
  }
}

function verificationChipClass(provider: AgentProviderCard): string {
  switch (provider.verificationStatus) {
    case 'verified':
      return 'talk-agent-chip talk-agent-chip-success';
    case 'invalid':
      return 'talk-agent-chip talk-agent-chip-error';
    case 'unavailable':
    case 'rate_limited':
      return 'talk-agent-chip talk-agent-chip-warning';
    default:
      return 'talk-agent-chip';
  }
}

// The new cloud Worker has no Anthropic-container runtime, so the
// Anthropic execution preview the RegisteredAgentsPanel renders is
// derived purely from whether an Anthropic API key is on file. We
// pass a synthetic ExecutorSettings shape that drives the panel's
// "Main will use Anthropic direct HTTP" branch when the Anthropic
// card has a credential, and the "no key configured" branch otherwise.
function deriveExecutorSettings(
  providers: AgentProviderCard[],
): ExecutorSettings {
  const anthropic = providers.find((p) => p.id === 'provider.anthropic');
  const hasApiKey = anthropic?.hasCredential === true;
  return {
    configuredAliasMap: {},
    effectiveAliasMap: {},
    defaultAlias: '',
    executorAuthMode: 'api_key',
    authModeSource: 'settings',
    hasApiKey,
    hasOauthToken: false,
    hasAuthToken: false,
    apiKeySource: hasApiKey ? 'stored' : null,
    oauthTokenSource: null,
    authTokenSource: null,
    apiKeyHint: anthropic?.credentialHint ?? null,
    oauthTokenHint: null,
    authTokenHint: null,
    activeCredentialConfigured: hasApiKey,
    verificationStatus: anthropic?.verificationStatus ?? 'missing',
    lastVerifiedAt: anthropic?.lastVerifiedAt ?? null,
    lastVerificationError: anthropic?.lastVerificationError ?? null,
    anthropicBaseUrl: anthropic?.baseUrl ?? '',
    isConfigured: hasApiKey,
    configVersion: 0,
    lastUpdatedAt: null,
    lastUpdatedBy: null,
    configErrors: [],
  };
}

export function SettingsPage({
  user,
  userRole,
  onUnauthorized,
  onUserUpdated,
}: Props): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const canManage = canManageAdmin(userRole);

  const setTab = (next: SettingsTab): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'profile') {
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
    setSearchParams(params, { replace: true });
  };

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>Settings</h1>
          <p>
            Manage your profile, AI provider API keys, and the agents available
            in your talks.
          </p>
        </div>
      </header>

      <div className="talk-tabs" role="tablist" aria-label="Settings sections">
        <button
          type="button"
          role="tab"
          className={`talk-tab${tab === 'profile' ? ' talk-tab-active' : ''}`}
          aria-selected={tab === 'profile'}
          onClick={() => setTab('profile')}
        >
          Profile
        </button>
        {canManage ? (
          <>
            <button
              type="button"
              role="tab"
              className={`talk-tab${tab === 'api-keys' ? ' talk-tab-active' : ''}`}
              aria-selected={tab === 'api-keys'}
              onClick={() => setTab('api-keys')}
            >
              API Keys
            </button>
            <button
              type="button"
              role="tab"
              className={`talk-tab${tab === 'agents' ? ' talk-tab-active' : ''}`}
              aria-selected={tab === 'agents'}
              onClick={() => setTab('agents')}
            >
              Agents
            </button>
          </>
        ) : null}
      </div>

      {tab === 'profile' ? (
        <ProfileTab
          user={user}
          onUnauthorized={onUnauthorized}
          onUserUpdated={onUserUpdated}
        />
      ) : null}

      {tab === 'api-keys' && canManage ? (
        <ApiKeysTab onUnauthorized={onUnauthorized} canManage={canManage} />
      ) : null}

      {tab === 'agents' && canManage ? (
        <AgentsTab onUnauthorized={onUnauthorized} canManage={canManage} />
      ) : null}
    </section>
  );
}

// ─── Profile tab ─────────────────────────────────────────────────────

function ProfileTab({
  user,
  onUnauthorized,
  onUserUpdated,
}: {
  user: SessionUser;
  onUnauthorized: () => void;
  onUserUpdated: (user: SessionUser) => void;
}): JSX.Element {
  const [nameDraft, setNameDraft] = useState(user.displayName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setNameDraft(user.displayName);
  }, [user.displayName]);

  const hasNameChange =
    nameDraft.trim() !== '' && nameDraft.trim() !== user.displayName;

  const handleSave = async (): Promise<void> => {
    if (!hasNameChange) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await updateSessionMe({
        displayName: nameDraft.trim(),
      });
      onUserUpdated(updated);
      setNotice('Profile updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(
        err instanceof ApiError ? err.message : 'Failed to update profile.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
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

      <section className="settings-card">
        <h2>Personal Information</h2>
        <label className="profile-field">
          <span className="profile-field-label">Full name</span>
          <input
            type="text"
            className="profile-field-input"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
          />
        </label>
        <label className="profile-field">
          <span className="profile-field-label">Email address</span>
          <input
            type="text"
            className="profile-field-input profile-field-locked"
            value={user.email}
            readOnly
          />
          <span className="profile-field-hint">
            This is the email used for signing in and notifications.
          </span>
        </label>
        <div className="profile-actions">
          <button
            type="button"
            className="primary-btn"
            disabled={!hasNameChange || saving}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </section>

      <section className="settings-card">
        <h2>Role &amp; Permissions</h2>
        <div className="profile-role-row">
          <strong>{formatRole(user.role)}</strong>
          <span
            className={`profile-role-badge profile-role-badge-${user.role}`}
          >
            {user.role}
          </span>
        </div>
        <p className="settings-copy">{roleDescription(user.role)}</p>
      </section>
    </>
  );
}

function formatRole(role: string): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'member':
      return 'Member';
    default:
      return role;
  }
}

function roleDescription(role: string): string {
  switch (role) {
    case 'owner':
      return 'Full access to all settings and billing.';
    case 'admin':
      return 'Can manage agents, connectors, and settings.';
    case 'member':
      return 'Can create and participate in talks.';
    default:
      return '';
  }
}

// ─── API Keys tab ────────────────────────────────────────────────────

const PROVIDER_SAVE_POLL_DELAYS_MS = [
  1_500, 1_500, 2_500, 3_500, 5_000, 5_000, 5_000,
];

function ApiKeysTab({
  onUnauthorized,
  canManage,
}: {
  onUnauthorized: () => void;
  canManage: boolean;
}): JSX.Element {
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await getAiAgents();
        if (cancelled) return;
        setData(next);
        setDrafts(initDrafts(next.additionalProviders));
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError
            ? err.message
            : 'Failed to load AI provider settings.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const updateDraft = (
    providerId: string,
    patch: Partial<ProviderDraft>,
  ): void => {
    setDrafts((current) => ({
      ...current,
      [providerId]: {
        ...(current[providerId] || {
          apiKey: '',
          showApiKey: false,
          expanded: false,
        }),
        ...patch,
      },
    }));
  };

  const refreshProvider = (next: AgentProviderCard): void => {
    setData((current) =>
      current
        ? {
            ...current,
            additionalProviders: current.additionalProviders.map((entry) =>
              entry.id === next.id ? next : entry,
            ),
          }
        : current,
    );
    updateDraft(next.id, {
      apiKey: '',
      expanded: !next.hasCredential,
    });
  };

  const pollAfterSave = async (providerId: string): Promise<void> => {
    for (const delayMs of PROVIDER_SAVE_POLL_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        const next = await getAiAgents();
        const provider = next.additionalProviders.find(
          (entry) => entry.id === providerId,
        );
        if (!provider) return;
        refreshProvider(provider);
        if (
          provider.verificationStatus === 'verifying' ||
          provider.verificationStatus === 'not_verified'
        ) {
          continue;
        }
        if (provider.verificationStatus === 'verified') {
          setNotice(`${provider.name} verified.`);
        }
        return;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
        }
        return;
      }
    }
  };

  const handleFailure = (err: unknown, fallback: string): void => {
    if (err instanceof UnauthorizedError) {
      onUnauthorized();
      return;
    }
    setError(err instanceof ApiError ? err.message : fallback);
  };

  const handleSave = async (providerId: string): Promise<void> => {
    const draft = drafts[providerId];
    if (!draft) return;
    const apiKey = draft.apiKey.trim();
    if (!apiKey) {
      setError('Enter an API key before saving.');
      return;
    }
    setBusyKey(`save:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        apiKey,
      });
      refreshProvider(updated);
      setNotice(`${updated.name} credential saved.`);
      if (
        updated.verificationStatus === 'verifying' ||
        updated.verificationStatus === 'not_verified'
      ) {
        void pollAfterSave(providerId);
      }
    } catch (err) {
      handleFailure(err, 'Failed to save provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleClear = async (providerId: string): Promise<void> => {
    setBusyKey(`save:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await saveAiProviderCredential({
        providerId,
        apiKey: null,
      });
      refreshProvider(updated);
      setNotice(`${updated.name} credential cleared.`);
    } catch (err) {
      handleFailure(err, 'Failed to clear provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleVerify = async (providerId: string): Promise<void> => {
    setBusyKey(`verify:${providerId}`);
    setNotice(null);
    setError(null);
    try {
      const updated = await verifyAiProviderCredential(providerId);
      refreshProvider(updated);
      setNotice(`${updated.name} verification updated.`);
    } catch (err) {
      handleFailure(err, 'Failed to verify provider credential.');
    } finally {
      setBusyKey(null);
    }
  };

  if (loading) {
    return <section className="page-state">Loading API keys…</section>;
  }

  if (error && !data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error}
      </section>
    );
  }

  const providers = data?.additionalProviders ?? [];

  return (
    <>
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

      <section className="settings-card">
        <h2>Provider API Keys</h2>
        <p className="settings-copy">
          Add API keys for the providers you want to use in talks. Keys are
          encrypted at rest and verified against the provider on save.
        </p>

        {providers.length === 0 ? (
          <p className="settings-copy">
            No providers are enabled for this workspace.
          </p>
        ) : (
          <div className="talk-llm-card-list">
            {providers.map((provider) => (
              <ProviderCredentialCard
                key={provider.id}
                provider={provider}
                draft={drafts[provider.id] || emptyDraft(provider)}
                canManage={canManage}
                busySave={busyKey === `save:${provider.id}`}
                busyVerify={busyKey === `verify:${provider.id}`}
                onDraftChange={(patch) => updateDraft(provider.id, patch)}
                onSave={() => void handleSave(provider.id)}
                onClear={() => void handleClear(provider.id)}
                onVerify={() => void handleVerify(provider.id)}
              />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function initDrafts(
  providers: AgentProviderCard[],
): Record<string, ProviderDraft> {
  const drafts: Record<string, ProviderDraft> = {};
  for (const provider of providers) {
    drafts[provider.id] = emptyDraft(provider);
  }
  return drafts;
}

function emptyDraft(provider: AgentProviderCard): ProviderDraft {
  return {
    apiKey: '',
    showApiKey: false,
    expanded: !provider.hasCredential,
  };
}

function ProviderCredentialCard({
  provider,
  draft,
  canManage,
  busySave,
  busyVerify,
  onDraftChange,
  onSave,
  onClear,
  onVerify,
}: {
  provider: AgentProviderCard;
  draft: ProviderDraft;
  canManage: boolean;
  busySave: boolean;
  busyVerify: boolean;
  onDraftChange: (patch: Partial<ProviderDraft>) => void;
  onSave: () => void;
  onClear: () => void;
  onVerify: () => void;
}): JSX.Element {
  const docs = PROVIDER_DOCS[provider.id];
  const placeholder = PROVIDER_KEY_PLACEHOLDER[provider.id] || 'sk-...';
  const disabled = !canManage || busySave;

  if (provider.credentialMode === 'host_login') {
    return (
      <article className="talk-llm-card">
        <div className="talk-llm-card-header">
          <div>
            <h4>{provider.name}</h4>
            <p className="talk-llm-meta">
              Host-login providers are not configurable in the cloud workspace.
            </p>
          </div>
          <span className={verificationChipClass(provider)}>
            {formatVerification(provider)}
          </span>
        </div>
      </article>
    );
  }

  return (
    <article className="talk-llm-card">
      <div className="talk-llm-card-header">
        <div>
          <h4>{provider.name}</h4>
          <p className="talk-llm-meta">
            {docs ? (
              <a href={docs.url} target="_blank" rel="noreferrer">
                Get key from {docs.label}
              </a>
            ) : (
              'Configure an API key to use this provider in talks.'
            )}
          </p>
        </div>
        <span className={verificationChipClass(provider)}>
          {formatVerification(provider)}
        </span>
      </div>

      {provider.hasCredential ? (
        <div className="talk-llm-stored-key">
          <div>
            <strong>{provider.credentialHint || 'Stored in settings'}</strong>
            <p className="talk-llm-meta">
              Last verified {formatDateTime(provider.lastVerifiedAt)}
            </p>
            {provider.lastVerificationError ? (
              <p className="talk-llm-meta">{provider.lastVerificationError}</p>
            ) : null}
          </div>
          <button
            type="button"
            className="icon-btn danger-btn"
            onClick={onClear}
            disabled={disabled}
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
          onDraftChange({
            expanded: (event.currentTarget as HTMLDetailsElement).open,
          })
        }
      >
        <summary>{provider.hasCredential ? 'Update key' : 'Configure'}</summary>
        <div className="talk-llm-grid">
          <label className="talk-llm-field-span">
            <span>API key</span>
            <div className="talk-llm-secret-input">
              <input
                type={draft.showApiKey ? 'text' : 'password'}
                value={draft.apiKey}
                placeholder={placeholder}
                onChange={(event) =>
                  onDraftChange({ apiKey: event.target.value })
                }
                disabled={disabled}
              />
              <button
                type="button"
                className="talk-llm-eye-toggle"
                onClick={() => onDraftChange({ showApiKey: !draft.showApiKey })}
                disabled={disabled}
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
              onClick={onSave}
              disabled={disabled || !draft.apiKey.trim()}
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
                onClick={onVerify}
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
}

// ─── Agents tab ──────────────────────────────────────────────────────

function AgentsTab({
  onUnauthorized,
  canManage,
}: {
  onUnauthorized: () => void;
  canManage: boolean;
}): JSX.Element {
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [agents, setAgents] = useState<RegisteredAgent[]>([]);
  const [mainAgentId, setMainAgentId] = useState<string | null>(null);
  const [mainAgentDraft, setMainAgentDraft] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [nextData, nextAgents, mainAgent] = await Promise.all([
          getAiAgents(),
          listRegisteredAgents(),
          getMainRegisteredAgent().catch(() => null),
        ]);
        if (cancelled) return;
        setData(nextData);
        setAgents(nextAgents);
        if (mainAgent) {
          setMainAgentId(mainAgent.id);
          setMainAgentDraft(mainAgent.id);
        } else {
          setMainAgentId(null);
          setMainAgentDraft('');
        }
        setError(null);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        setError(
          err instanceof ApiError ? err.message : 'Failed to load agents.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [onUnauthorized]);

  const executorSettings = useMemo(
    () => deriveExecutorSettings(data?.additionalProviders ?? []),
    [data?.additionalProviders],
  );

  const handleSaveMain = async (): Promise<void> => {
    if (!mainAgentDraft || mainAgentDraft === mainAgentId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
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
      setBusy(false);
    }
  };

  if (loading) {
    return <section className="page-state">Loading agents…</section>;
  }

  if (!data) {
    return (
      <section className="settings-banner settings-banner-error" role="alert">
        {error || 'Agents are unavailable.'}
      </section>
    );
  }

  const selectedMain = agents.find((agent) => agent.id === mainAgentDraft);

  return (
    <>
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

      <section className="settings-card">
        <RegisteredAgentsPanel
          providers={data.additionalProviders}
          executorSettings={executorSettings}
          containerRuntimeAvailability="unavailable"
          onUnauthorized={onUnauthorized}
          canManage={canManage}
          mainAgentId={mainAgentId}
          onAgentsChanged={setAgents}
        />
      </section>

      {agents.length > 0 ? (
        <section className="settings-card">
          <h2>Main Agent</h2>
          <p className="settings-copy">
            The main agent is the default participant when a Talk doesn't
            specify one.
          </p>
          <div className="talk-llm-grid">
            <label className="talk-llm-field-span">
              <span>Select main agent</span>
              <select
                value={mainAgentDraft}
                onChange={(event) => setMainAgentDraft(event.target.value)}
                disabled={!canManage || busy}
              >
                <option value="" disabled>
                  Choose an agent…
                </option>
                {agents
                  .filter((agent) => agent.enabled)
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
                onClick={() => void handleSaveMain()}
                disabled={
                  !canManage ||
                  busy ||
                  !mainAgentDraft ||
                  mainAgentDraft === mainAgentId
                }
              >
                {busy ? 'Saving…' : 'Set as Main Agent'}
              </button>
            </div>
          </div>
          {selectedMain && !selectedMain.executionPreview.ready ? (
            <p className="talk-llm-meta error-text">
              {selectedMain.executionPreview.message}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
