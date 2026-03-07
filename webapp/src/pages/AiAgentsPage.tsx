import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import {
  AgentProviderCard,
  AiAgentsPageData,
  ApiError,
  createRegisteredAgent,
  deleteRegisteredAgent,
  duplicateRegisteredAgent,
  getAiAgents,
  saveAiProviderCredential,
  UnauthorizedError,
  updateRegisteredAgent,
  verifyAiProviderCredential,
} from '../lib/api';

type Props = {
  onUnauthorized: () => void;
  userRole: string;
};

type ProviderDraft = {
  apiKey: string;
  organizationId: string;
  baseUrl: string;
  authScheme: 'x_api_key' | 'bearer';
  expanded: boolean;
};

type AgentDraft = {
  name: string;
  providerId: string;
  modelId: string;
  modelDisplayName: string;
  setAsDefault: boolean;
};

function canManageAgents(userRole: string): boolean {
  return userRole === 'owner' || userRole === 'admin';
}

function buildProviderDraft(provider: AgentProviderCard): ProviderDraft {
  return {
    apiKey: '',
    organizationId: '',
    baseUrl: provider.baseUrl,
    authScheme: provider.authScheme,
    expanded: provider.hasCredential,
  };
}

function validateReturnTo(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith('/app/')) return null;
  if (value.includes('..')) return null;
  return value;
}

function formatVerificationStatus(
  status: AgentProviderCard['verificationStatus'],
): string {
  switch (status) {
    case 'missing':
      return 'Missing';
    case 'not_verified':
      return 'Not verified';
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

export function AiAgentsPage({
  onUnauthorized,
  userRole,
}: Props): JSX.Element {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [data, setData] = useState<AiAgentsPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [providerDrafts, setProviderDrafts] = useState<Record<string, ProviderDraft>>(
    {},
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>({
    name: '',
    providerId: 'provider.anthropic',
    modelId: '',
    modelDisplayName: '',
    setAsDefault: false,
  });
  const [duplicateSourceId, setDuplicateSourceId] = useState<string | null>(null);

  const returnTo = validateReturnTo(searchParams.get('returnTo'));
  const focus = searchParams.get('focus');
  const canManage = canManageAgents(userRole);

  const load = async (): Promise<void> => {
    try {
      const next = await getAiAgents();
      setData(next);
      setProviderDrafts((current) => {
        const nextDrafts: Record<string, ProviderDraft> = {};
        for (const provider of next.providers) {
          nextDrafts[provider.id] = {
            ...buildProviderDraft(provider),
            expanded:
              current[provider.id]?.expanded ||
              (focus === 'providers' && provider.id === 'provider.anthropic'),
          };
        }
        return nextDrafts;
      });
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

  const configuredProviders = useMemo(
    () => (data?.providers || []).filter((provider) => provider.hasCredential),
    [data?.providers],
  );

  const selectedProvider =
    data?.providers.find((provider) => provider.id === agentDraft.providerId) || null;

  const modelSuggestions = selectedProvider?.modelSuggestions || [];

  useEffect(() => {
    if (!data) return;
    if (data.registeredAgents.length === 0) {
      setAgentDraft((current) => ({
        ...current,
        providerId: 'provider.anthropic',
      }));
    } else if (
      currentProviderMissing(data.providers, agentDraft.providerId) &&
      configuredProviders[0]
    ) {
      setAgentDraft((current) => ({
        ...current,
        providerId: configuredProviders[0].id,
      }));
    }
  }, [agentDraft.providerId, configuredProviders, data]);

  const updateProviderDraft = (
    providerId: string,
    patch: Partial<ProviderDraft>,
  ): void => {
    setProviderDrafts((current) => ({
      ...current,
      [providerId]: {
        ...(current[providerId] || {
          apiKey: '',
          organizationId: '',
          baseUrl: '',
          authScheme: 'bearer',
          expanded: false,
        }),
        ...patch,
      },
    }));
  };

  const refreshProvider = (provider: AgentProviderCard): void => {
    setData((current) =>
      current
        ? {
            ...current,
            providers: current.providers.map((entry) =>
              entry.id === provider.id ? provider : entry,
            ),
          }
        : current,
    );
    updateProviderDraft(provider.id, {
      apiKey: '',
      organizationId: '',
      baseUrl: provider.baseUrl,
      authScheme: provider.authScheme,
      expanded: provider.hasCredential,
    });
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
        organizationId: draft.organizationId.trim() || null,
        baseUrl: draft.baseUrl.trim() || null,
        authScheme: draft.authScheme,
      });
      refreshProvider(provider);
      if (!provider.hasCredential) {
        setNotice(`${provider.name} credential cleared.`);
      } else if (provider.verificationStatus === 'verified') {
        setNotice(`${provider.name} credential saved and verified.`);
      } else {
        setNotice(
          `${provider.name} credential saved. Verification status: ${formatVerificationStatus(
            provider.verificationStatus,
          ).toLowerCase()}.`,
        );
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to save provider.');
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
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to verify provider.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleCreateAgent = async (event: FormEvent) => {
    event.preventDefault();
    setBusyKey('agent-create');
    setNotice(null);
    setError(null);
    try {
      if (!agentDraft.name.trim() || !agentDraft.providerId || !agentDraft.modelId.trim()) {
        throw new Error('Agent name, provider, and model are required.');
      }
      const result = duplicateSourceId
        ? await duplicateRegisteredAgent({
            sourceAgentId: duplicateSourceId,
            name: agentDraft.name.trim(),
            providerId: agentDraft.providerId,
            modelId: agentDraft.modelId.trim(),
            modelDisplayName: agentDraft.modelDisplayName.trim() || null,
          })
        : await createRegisteredAgent({
            name: agentDraft.name.trim(),
            providerId: agentDraft.providerId,
            modelId: agentDraft.modelId.trim(),
            modelDisplayName: agentDraft.modelDisplayName.trim() || null,
            setAsDefault: agentDraft.setAsDefault,
          });

      const next = await getAiAgents();
      setData(next);
      setAgentDraft({
        name: '',
        providerId: configuredProviders[0]?.id || 'provider.anthropic',
        modelId: '',
        modelDisplayName: '',
        setAsDefault: false,
      });
      setDuplicateSourceId(null);
      setNotice(
        duplicateSourceId
          ? 'AI agent duplicated successfully.'
          : 'AI agent created successfully.',
      );
      if ('defaultRegisteredAgentId' in result) {
        // noop; subsequent reload already applied the latest default.
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to save AI agent.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleSetDefaultAgent = async (agentId: string): Promise<void> => {
    setBusyKey(`default:${agentId}`);
    setNotice(null);
    setError(null);
    try {
      await updateRegisteredAgent({ agentId, setAsDefault: true });
      const next = await getAiAgents();
      setData(next);
      setNotice('Default agent updated.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to update default agent.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleAgent = async (
    agentId: string,
    enabled: boolean,
  ): Promise<void> => {
    setBusyKey(`toggle:${agentId}`);
    setNotice(null);
    setError(null);
    try {
      await updateRegisteredAgent({ agentId, enabled });
      const next = await getAiAgents();
      setData(next);
      setNotice(enabled ? 'AI agent re-enabled.' : 'AI agent archived.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to update AI agent.');
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteAgent = async (agentId: string): Promise<void> => {
    if (!window.confirm('Delete this AI agent?')) return;
    setBusyKey(`delete:${agentId}`);
    setNotice(null);
    setError(null);
    try {
      await deleteRegisteredAgent(agentId);
      const next = await getAiAgents();
      setData(next);
      setNotice('AI agent deleted.');
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Failed to delete AI agent.');
    } finally {
      setBusyKey(null);
    }
  };

  const startDuplicate = (agentId: string): void => {
    const agent = data?.registeredAgents.find((entry) => entry.id === agentId);
    if (!agent) return;
    setDuplicateSourceId(agent.id);
    setAgentDraft({
      name: `${agent.name} (copy)`,
      providerId: agent.providerId,
      modelId: agent.modelId,
      modelDisplayName: agent.modelDisplayName,
      setAsDefault: false,
    });
  };

  if (loading) {
    return <section className="page-state">Loading AI agents…</section>;
  }

  if (!data) {
    return <section className="page-state">AI agents are unavailable.</section>;
  }

  return (
    <section className="page-shell">
      <header className="page-header">
        <div>
          <h1>AI Agents</h1>
          <p>Register provider credentials, create reusable agents, and choose the default for new talks.</p>
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
            <h3>Default Agent</h3>
            <p className="talk-llm-meta">
              {data.defaultRegisteredAgentId
                ? 'This agent seeds new talks.'
                : 'No default agent is configured yet.'}
            </p>
          </div>
        </div>
        {data.registeredAgents.length > 0 ? (
          <label className="talk-llm-field-span">
            <span>Default for new talks</span>
            <select
              value={data.defaultRegisteredAgentId || ''}
              onChange={(event) => void handleSetDefaultAgent(event.target.value)}
              disabled={!canManage}
            >
              {data.registeredAgents
                .filter((agent) => agent.enabled)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} · {agent.providerName} · {agent.modelDisplayName}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <p className="talk-llm-meta">Set up your first provider credential and agent below.</p>
        )}
      </section>

      {data.onboardingRequired ? (
        <section className="talk-llm-section">
          <div className="talk-llm-section-header">
            <div>
              <h3>First Agent Setup</h3>
              <p className="talk-llm-meta">
                Configure Anthropic first, then create the initial agent that new talks will use by default.
              </p>
            </div>
          </div>
          <button
            type="button"
            className="secondary-btn"
            onClick={() =>
              updateProviderDraft('provider.anthropic', { expanded: true })
            }
          >
            Configure Anthropic
          </button>
        </section>
      ) : null}

      <section className="talk-llm-section">
        <div className="talk-llm-section-header">
          <div>
            <h3>Provider Credentials</h3>
            <p className="talk-llm-meta">
              Provider credentials are stored once per provider account and reused by registered agents.
            </p>
          </div>
        </div>

        <div className="talk-llm-card-list">
          {data.providers.map((provider) => {
            const draft = providerDrafts[provider.id] || buildProviderDraft(provider);
            const busySave = busyKey === `provider-save:${provider.id}`;
            const busyVerify = busyKey === `provider-verify:${provider.id}`;
            return (
              <article key={provider.id} className="talk-llm-card">
                <div className="talk-llm-card-header">
                  <div>
                    <h4>{provider.name}</h4>
                    <p className="talk-llm-meta">
                      {provider.hasCredential
                        ? `${provider.credentialHint || 'Configured'} · ${formatVerificationStatus(
                            provider.verificationStatus,
                          )}`
                        : 'Not configured'}
                    </p>
                  </div>
                  <div className="talk-llm-inline-actions">
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() =>
                        updateProviderDraft(provider.id, {
                          expanded: !draft.expanded,
                        })
                      }
                    >
                      {draft.expanded ? 'Collapse' : provider.hasCredential ? 'Update' : 'Configure'}
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

                {draft.expanded ? (
                  <div className="talk-llm-grid">
                    <label className="talk-llm-field-span">
                      <span>{provider.authScheme === 'x_api_key' ? 'API key' : 'Token'}</span>
                      <input
                        type="password"
                        value={draft.apiKey}
                        onChange={(event) =>
                          updateProviderDraft(provider.id, {
                            apiKey: event.target.value,
                          })
                        }
                        placeholder={
                          provider.authScheme === 'x_api_key' ? 'sk-ant-…' : 'Bearer token'
                        }
                        disabled={!canManage || busySave}
                      />
                    </label>
                    {provider.id === 'provider.openai' ? (
                      <label>
                        <span>Organization ID</span>
                        <input
                          type="text"
                          value={draft.organizationId}
                          onChange={(event) =>
                            updateProviderDraft(provider.id, {
                              organizationId: event.target.value,
                            })
                          }
                          disabled={!canManage || busySave}
                        />
                      </label>
                    ) : null}
                    <label className="talk-llm-field-span">
                      <span>Base URL</span>
                      <input
                        type="text"
                        value={draft.baseUrl}
                        onChange={(event) =>
                          updateProviderDraft(provider.id, {
                            baseUrl: event.target.value,
                          })
                        }
                        disabled={!canManage || busySave}
                      />
                    </label>
                    {provider.id === 'provider.custom' ? (
                      <label>
                        <span>Auth Scheme</span>
                        <select
                          value={draft.authScheme}
                          onChange={(event) =>
                            updateProviderDraft(provider.id, {
                              authScheme: event.target.value as 'x_api_key' | 'bearer',
                            })
                          }
                          disabled={!canManage || busySave}
                        >
                          <option value="bearer">Bearer</option>
                          <option value="x_api_key">X-API-Key</option>
                        </select>
                      </label>
                    ) : null}
                    <div className="talk-llm-inline-actions">
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={() => void handleSaveProvider(provider.id)}
                        disabled={!canManage || busySave}
                      >
                        {busySave ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="talk-llm-section">
        <div className="talk-llm-section-header">
          <div>
            <h3>Registered Agents</h3>
            <p className="talk-llm-meta">
              Registered agents are reusable identities backed by one provider and model. Role stays talk-local.
            </p>
          </div>
        </div>

        <form className="talk-llm-card" onSubmit={handleCreateAgent}>
          <div className="talk-llm-card-header">
            <div>
              <h4>{duplicateSourceId ? 'Duplicate as new' : 'Create AI Agent'}</h4>
              <p className="talk-llm-meta">
                {duplicateSourceId
                  ? 'Create a new agent with a different provider or model.'
                  : 'Create a global agent identity to invite into talks.'}
              </p>
            </div>
          </div>
          <div className="talk-llm-grid">
            <label>
              <span>Name</span>
              <input
                type="text"
                value={agentDraft.name}
                onChange={(event) =>
                  setAgentDraft((current) => ({ ...current, name: event.target.value }))
                }
                disabled={!canManage || busyKey === 'agent-create'}
              />
            </label>
            <label>
              <span>Provider</span>
              <select
                value={agentDraft.providerId}
                onChange={(event) =>
                  setAgentDraft((current) => ({
                    ...current,
                    providerId: event.target.value,
                    modelId: '',
                    modelDisplayName: '',
                  }))
                }
                disabled={!canManage || busyKey === 'agent-create'}
              >
                {configuredProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Model</span>
              <input
                list="registered-agent-model-suggestions"
                value={agentDraft.modelId}
                onChange={(event) =>
                  setAgentDraft((current) => ({
                    ...current,
                    modelId: event.target.value,
                    modelDisplayName: event.target.value,
                  }))
                }
                disabled={!canManage || busyKey === 'agent-create'}
              />
            </label>
            <label>
              <span>Display name</span>
              <input
                type="text"
                value={agentDraft.modelDisplayName}
                onChange={(event) =>
                  setAgentDraft((current) => ({
                    ...current,
                    modelDisplayName: event.target.value,
                  }))
                }
                disabled={!canManage || busyKey === 'agent-create'}
              />
            </label>
            <label className="talk-llm-checkbox">
              <input
                type="checkbox"
                checked={agentDraft.setAsDefault}
                onChange={(event) =>
                  setAgentDraft((current) => ({
                    ...current,
                    setAsDefault: event.target.checked,
                  }))
                }
                disabled={!canManage || busyKey === 'agent-create'}
              />
              <span>Default for new talks</span>
            </label>
          </div>

          <datalist id="registered-agent-model-suggestions">
            {modelSuggestions.map((model) => (
              <option key={model.modelId} value={model.modelId}>
                {model.displayName}
              </option>
            ))}
          </datalist>

          <div className="talk-llm-inline-actions">
            <button
              type="submit"
              className="primary-btn"
              disabled={!canManage || configuredProviders.length === 0 || busyKey === 'agent-create'}
            >
              {busyKey === 'agent-create'
                ? 'Saving…'
                : duplicateSourceId
                  ? 'Duplicate agent'
                  : 'Create agent'}
            </button>
            {duplicateSourceId ? (
              <button
                type="button"
                className="secondary-btn"
                onClick={() => {
                  setDuplicateSourceId(null);
                  setAgentDraft((current) => ({ ...current, name: '' }));
                }}
              >
                Cancel duplicate
              </button>
            ) : null}
          </div>
        </form>

        {data.registeredAgents.length === 0 ? (
          <p className="talk-llm-meta">Create your first agent once a provider credential is configured.</p>
        ) : (
          <div className="talk-llm-card-list">
            {data.registeredAgents.map((agent) => (
              <article key={agent.id} className="talk-llm-card">
                <div className="talk-llm-card-header">
                  <div>
                    <h4>{agent.name}</h4>
                    <p className="talk-llm-meta">
                      {agent.providerName} · {agent.modelDisplayName} · Used in {agent.usageCount}{' '}
                      talk{agent.usageCount === 1 ? '' : 's'}
                      {!agent.enabled ? ' · Archived' : ''}
                    </p>
                  </div>
                  <div className="talk-llm-inline-actions">
                    {data.defaultRegisteredAgentId === agent.id ? (
                      <span className="talk-agent-chip">Default</span>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => startDuplicate(agent.id)}
                      disabled={!canManage}
                    >
                      Duplicate as new
                    </button>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void handleToggleAgent(agent.id, !agent.enabled)}
                      disabled={!canManage || busyKey === `toggle:${agent.id}`}
                    >
                      {agent.enabled ? 'Archive' : 'Restore'}
                    </button>
                    {agent.usageCount === 0 ? (
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => void handleDeleteAgent(agent.id)}
                        disabled={!canManage || busyKey === `delete:${agent.id}`}
                      >
                        Delete
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}

function currentProviderMissing(
  providers: AgentProviderCard[],
  providerId: string,
): boolean {
  return !providers.some((provider) => provider.id === providerId);
}
