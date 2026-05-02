import { useEffect, useMemo, useRef, useState } from 'react';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';
import {
  FIXTURE_AGENT_PROFILES,
  FIXTURE_PERSONAS,
  FIXTURE_PIPELINES,
  getAgentProfileById,
  getPersonaBySlug,
  getPipelineBySlug,
  type AgentProfile,
  type Persona,
  type ScoringPipeline,
} from '../lib/editorial-fixtures';
import {
  DELIVERABLE_LABELS,
  DESTINATION_LABELS,
  loadSetupState,
  saveSetupState,
  type DeliverableType,
  type Destination,
  type SetupState,
} from '../lib/editorial-setup';

// SetupState mirrors docs/contracts/editorial-room/v0/setup_state.schema.json
// (also in EDITORIAL_ROOM_CONTRACT.md §2.1). Persisted to localStorage via
// `lib/editorial-setup.ts` so other phases (Draft, Polish, Ship) can read
// destination + deliverable_type and adapt their surfaces.

type SectionId = 'deliverable' | 'audience' | 'llm-room' | 'scoring';

const SECTIONS: ReadonlyArray<{ id: SectionId; num: string; name: string }> = [
  { id: 'deliverable', num: '01', name: 'Deliverable' },
  { id: 'audience', num: '02', name: 'Audience' },
  { id: 'llm-room', num: '03', name: 'LLM Room' },
  { id: 'scoring', num: '04', name: 'Scoring System' },
];

// Voice library shown in the Deliverable section's voice picker. In production
// this list comes from rocketorchestra's voice page library; for 0p we
// hardcode the seeded voice plus a few plausible siblings so the dropdown
// has options to choose from. The first slug matches `seeds/voice/
// gamemakers_2026.md`; the rest are placeholders that will resolve once
// rocketorchestra is wired up.
const AVAILABLE_VOICES: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'voice/gamemakers-2026', label: 'GameMakers (2026)' },
  { slug: 'voice/longform-essay-2026', label: 'Longform Essay (2026)' },
  {
    slug: 'voice/podcast-conversational-2026',
    label: 'Podcast · Conversational (2026)',
  },
  { slug: 'voice/memo-tight-2026', label: 'Memo · Tight (2026)' },
];

function sectionStatus(
  id: SectionId,
  s: SetupState,
): 'done' | 'in_progress' | 'not_started' {
  switch (id) {
    case 'deliverable':
      return s.voice_page_slug && s.deliverable_type ? 'done' : 'not_started';
    case 'audience':
      if (s.audience_persona_slugs.length >= 1) return 'done';
      return 'not_started';
    case 'llm-room':
      if (s.llm_room_agent_profile_ids.length >= 2) return 'done';
      return 'not_started';
    case 'scoring':
      return s.scoring_pipeline_slug ? 'done' : 'not_started';
  }
}

type Props = {
  onUnauthorized?: () => void;
};

export function EditorialSetupPage(_props: Props) {
  const [setup, setSetup] = useState<SetupState>(loadSetupState);
  const [activeSection, setActiveSection] = useState<SectionId>('deliverable');
  const [pieceTitle, setPieceTitle] = useState('Untitled Piece — new');

  // Persist on every change so other phases (Draft, Polish, Ship) see the
  // current SetupState immediately.
  useEffect(() => {
    saveSetupState(setup);
  }, [setup]);

  const update = (patch: Partial<SetupState>) =>
    setSetup((s) => ({
      ...s,
      ...patch,
      setup_version: s.setup_version + 1,
      updated_at: new Date().toISOString(),
    }));

  const sectionsDone = useMemo(
    () => SECTIONS.filter((s) => sectionStatus(s.id, setup) === 'done').length,
    [setup],
  );

  const sectionIdx = SECTIONS.findIndex((s) => s.id === activeSection);
  const prevSection = sectionIdx > 0 ? SECTIONS[sectionIdx - 1] : null;
  const nextSection =
    sectionIdx >= 0 && sectionIdx < SECTIONS.length - 1
      ? SECTIONS[sectionIdx + 1]
      : null;
  const navProps = {
    prev: prevSection
      ? {
          name: prevSection.name,
          onClick: () => setActiveSection(prevSection.id),
        }
      : null,
    next: nextSection
      ? {
          name: nextSection.name,
          onClick: () => setActiveSection(nextSection.id),
        }
      : null,
  };

  return (
    <div className="editorial-room">
      <EditorialPhaseStrip activePhase="setup" />

      <div className="editorial-meta-bar">
        <span className="editorial-meta-prefix">SETUP</span>
        <input
          className="editorial-meta-title"
          value={pieceTitle}
          onChange={(e) => setPieceTitle(e.target.value)}
          aria-label="Piece title"
        />
        <span className="editorial-meta-pip">
          {sectionsDone} OF {SECTIONS.length} SECTIONS DONE
        </span>
        <span className="editorial-meta-pip editorial-meta-pip-muted">
          {SECTIONS.find((s) => s.id === activeSection)?.name.toUpperCase()}{' '}
          OPEN
        </span>
        <div className="editorial-meta-actions">
          <button type="button" className="editorial-chip-button" disabled>
            ↻ CLONE FROM PRIOR PIECE
          </button>
          <button type="button" className="editorial-chip-button" disabled>
            LOAD PRESET
          </button>
        </div>
      </div>

      <div className="editorial-setup-grid">
        <aside className="editorial-setup-rail">
          <h2 className="editorial-rail-heading">SETUP SECTIONS</h2>
          <ul className="editorial-section-list">
            {SECTIONS.map((s) => {
              const status = sectionStatus(s.id, setup);
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    className={`editorial-section-row${activeSection === s.id ? ' editorial-section-row-active' : ''}`}
                    onClick={() => setActiveSection(s.id)}
                  >
                    <span
                      className={`editorial-status-dot editorial-status-${status}`}
                      aria-hidden="true"
                    />
                    <span className="editorial-section-name">{s.name}</span>
                    <span className="editorial-section-status">
                      {status === 'done'
                        ? 'configured'
                        : status === 'in_progress'
                          ? 'in progress'
                          : 'not yet'}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <h2 className="editorial-rail-heading editorial-rail-heading-spaced">
            OR LOAD PRESET
          </h2>
          <ul className="editorial-preset-list">
            <li className="editorial-preset-row">
              <span className="editorial-preset-name">GameMakers default</span>
              <span className="editorial-preset-sub">
                3 personas · A R M · default scoring
              </span>
            </li>
            <li className="editorial-preset-row">
              <span className="editorial-preset-name">Memo · short form</span>
              <span className="editorial-preset-sub">
                1 persona · 1 agent · rubric only
              </span>
            </li>
          </ul>
        </aside>

        <main className="editorial-setup-content">
          {activeSection === 'deliverable' && (
            <DeliverableSection setup={setup} update={update} nav={navProps} />
          )}
          {activeSection === 'audience' && (
            <AudienceSection setup={setup} update={update} nav={navProps} />
          )}
          {activeSection === 'llm-room' && (
            <LLMRoomSection setup={setup} update={update} nav={navProps} />
          )}
          {activeSection === 'scoring' && (
            <ScoringSection setup={setup} update={update} nav={navProps} />
          )}
        </main>

        <aside className="editorial-setup-preview">
          <h2 className="editorial-rail-heading">LIVE PREVIEW</h2>
          <p className="editorial-preview-blurb">
            How this Setup surfaces downstream.
          </p>

          <section className="editorial-preview-card">
            <h3 className="editorial-preview-card-title">
              CONTEXT BAR · THEME PHASE
            </h3>
            <p className="editorial-preview-mock">
              {DELIVERABLE_LABELS[setup.deliverable_type].toUpperCase()}
              {setup.length_target
                ? ` · ${setup.length_target.min_words.toLocaleString()}–${setup.length_target.max_words.toLocaleString()} words`
                : ' · no length target'}
            </p>
            <p className="editorial-preview-mock">
              {setup.audience_persona_slugs.length > 0
                ? setup.audience_persona_slugs.join(' · ')
                : '⚠ no personas yet'}
            </p>
            <p className="editorial-preview-mock">
              {setup.scoring_pipeline_slug
                ? setup.scoring_pipeline_slug
                : '⚠ scoring not set'}
            </p>
          </section>

          <section className="editorial-preview-card">
            <h3 className="editorial-preview-card-title">SETUP IMPACT</h3>
            <ul className="editorial-preview-bullets">
              <li>every Theme/Topic gets a per-persona score column</li>
              <li>cohort-targeted sub-loops in optimization</li>
              <li>counter-audience pass at Polish (drafts only)</li>
              <li>cost ≈ $2.10 per Topic round (3 personas)</li>
            </ul>
          </section>

          <section className="editorial-preview-card editorial-preview-debug">
            <h3 className="editorial-preview-card-title">
              SETUP STATE · v{setup.setup_version}
            </h3>
            <pre className="editorial-preview-json">
              {JSON.stringify(setup, null, 2)}
            </pre>
          </section>
        </aside>
      </div>
    </div>
  );
}

type SectionNavProps = {
  prev: { name: string; onClick: () => void } | null;
  next: { name: string; onClick: () => void } | null;
};

function SectionNav({ prev, next }: SectionNavProps) {
  if (!prev && !next) return null;
  return (
    <div className="editorial-section-nav">
      {prev ? (
        <button
          type="button"
          className="editorial-chip-button"
          onClick={prev.onClick}
        >
          ← {prev.name.toUpperCase()}
        </button>
      ) : null}
      {next ? (
        <button
          type="button"
          className="editorial-chip-button editorial-chip-button-primary"
          onClick={next.onClick}
        >
          {next.name.toUpperCase()} →
        </button>
      ) : null}
    </div>
  );
}

function SectionHeader({
  num,
  title,
  copy,
  nav,
}: {
  num: string;
  title: string;
  copy: string;
  nav: SectionNavProps;
}) {
  return (
    <header className="editorial-section-header">
      <div className="editorial-section-header-text">
        <p className="editorial-section-eyebrow">SECTION {num} · OF 04</p>
        <h1 className="editorial-section-heading">{title}</h1>
        <p className="editorial-section-subhead">{copy}</p>
      </div>
      <SectionNav prev={nav.prev} next={nav.next} />
    </header>
  );
}

function DeliverableSection({
  setup,
  update,
  nav,
}: {
  setup: SetupState;
  update: (patch: Partial<SetupState>) => void;
  nav: SectionNavProps;
}) {
  const target = setup.length_target;
  return (
    <section className="editorial-section-workspace">
      <SectionHeader
        num="01"
        title="What are you producing?"
        copy="Define the deliverable, voice, length, and destination. These four fields flow into every downstream phase."
        nav={nav}
      />

      <div className="editorial-field-grid">
        <label className="editorial-field">
          <span className="editorial-field-label">TYPE</span>
          <select
            value={setup.deliverable_type}
            onChange={(e) =>
              update({ deliverable_type: e.target.value as DeliverableType })
            }
          >
            {(Object.keys(DELIVERABLE_LABELS) as DeliverableType[]).map((k) => (
              <option key={k} value={k}>
                {DELIVERABLE_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <label className="editorial-field">
          <span className="editorial-field-label">VOICE</span>
          <select
            value={setup.voice_page_slug}
            onChange={(e) => update({ voice_page_slug: e.target.value })}
          >
            {AVAILABLE_VOICES.map((v) => (
              <option key={v.slug} value={v.slug}>
                {v.label}
              </option>
            ))}
            {AVAILABLE_VOICES.every((v) => v.slug !== setup.voice_page_slug) ? (
              <option value={setup.voice_page_slug}>
                {setup.voice_page_slug} (custom)
              </option>
            ) : null}
          </select>
        </label>

        <label className="editorial-field">
          <span className="editorial-field-label">DESTINATION</span>
          <select
            value={setup.destination}
            onChange={(e) =>
              update({ destination: e.target.value as Destination })
            }
          >
            {(Object.keys(DESTINATION_LABELS) as Destination[]).map((k) => (
              <option key={k} value={k}>
                {DESTINATION_LABELS[k]}
              </option>
            ))}
          </select>
        </label>

        <fieldset className="editorial-field editorial-field-range">
          <legend className="editorial-field-label">LENGTH TARGET</legend>
          <label className="editorial-field-inline">
            <span>min</span>
            <input
              type="number"
              min={0}
              value={target?.min_words ?? ''}
              onChange={(e) =>
                update({
                  length_target: {
                    min_words: Number(e.target.value),
                    max_words: target?.max_words ?? Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="editorial-field-inline">
            <span>max</span>
            <input
              type="number"
              min={0}
              value={target?.max_words ?? ''}
              onChange={(e) =>
                update({
                  length_target: {
                    min_words: target?.min_words ?? Number(e.target.value),
                    max_words: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <button
            type="button"
            className="editorial-field-clear"
            onClick={() => update({ length_target: null })}
            disabled={target === null}
          >
            clear
          </button>
        </fieldset>
      </div>

      <div className="editorial-section-footer">
        <span className="editorial-section-footer-meta">
          setup_version {setup.setup_version} · changes stale dependent scores
        </span>
      </div>
    </section>
  );
}

function matchesPersonaSearch(p: Persona, query: string): boolean {
  const q = query.toLowerCase().trim();
  if (q === '') return true;
  return (
    p.name.toLowerCase().includes(q) ||
    p.occupation.toLowerCase().includes(q) ||
    p.cohortTag.toLowerCase().includes(q) ||
    p.location.toLowerCase().includes(q)
  );
}

function AudienceSection({
  setup,
  update,
  nav,
}: {
  setup: SetupState;
  update: (patch: Partial<SetupState>) => void;
  nav: SectionNavProps;
}) {
  const [search, setSearch] = useState('');

  const selected = useMemo<Persona[]>(
    () =>
      setup.audience_persona_slugs
        .map((slug) => getPersonaBySlug(slug))
        .filter((p): p is Persona => p !== null),
    [setup.audience_persona_slugs],
  );

  const available = useMemo<Persona[]>(
    () =>
      FIXTURE_PERSONAS.filter(
        (p) =>
          !setup.audience_persona_slugs.includes(p.slug) &&
          matchesPersonaSearch(p, search),
      ),
    [setup.audience_persona_slugs, search],
  );

  const suggested = useMemo<Persona | null>(
    () =>
      available.find(
        (p) => p.suggested === 'yellow' || p.suggested === 'red',
      ) ?? null,
    [available],
  );

  const addPersona = (slug: string): void => {
    if (setup.audience_persona_slugs.includes(slug)) return;
    update({
      audience_persona_slugs: [...setup.audience_persona_slugs, slug],
    });
  };

  const removePersona = (slug: string): void => {
    update({
      audience_persona_slugs: setup.audience_persona_slugs.filter(
        (s) => s !== slug,
      ),
    });
  };

  return (
    <section className="editorial-section-workspace">
      <SectionHeader
        num="02"
        title="Who is this for?"
        copy="Add personas from your library. Each one becomes a scoring perspective at every layer."
        nav={nav}
      />

      <div className="editorial-personas-selected">
        <h3 className="editorial-personas-section-label">
          SELECTED · {selected.length}
        </h3>
        {selected.length === 0 ? (
          <p className="editorial-personas-empty">
            No personas added yet — pick from the library below.
          </p>
        ) : (
          <ul className="editorial-personas-selected-list">
            {selected.map((p) => (
              <li key={p.slug} className="editorial-persona-row">
                <span
                  className={`editorial-persona-avatar editorial-persona-avatar-${p.color}`}
                  aria-hidden="true"
                >
                  {p.monogram}
                </span>
                <div className="editorial-persona-row-text">
                  <div className="editorial-persona-row-headline">
                    <span className="editorial-persona-name">{p.name}</span>
                    <span className="editorial-persona-cohort">
                      {p.cohortTag}
                    </span>
                  </div>
                  <span className="editorial-persona-subtitle">
                    {p.occupation} · {p.location}
                  </span>
                </div>
                <span className="editorial-persona-weight">PRIMARY</span>
                <div className="editorial-persona-row-actions">
                  <button
                    type="button"
                    className="editorial-chip-button"
                    disabled
                    title="Per-persona weight editing coming next slice"
                  >
                    EDIT WEIGHT
                  </button>
                  <button
                    type="button"
                    className="editorial-chip-button"
                    onClick={() => removePersona(p.slug)}
                  >
                    REMOVE
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="editorial-personas-library">
        <header className="editorial-personas-library-header">
          <h3 className="editorial-personas-section-label">
            ADD FROM PERSONA LIBRARY
          </h3>
          <p className="editorial-personas-library-blurb">
            {FIXTURE_PERSONAS.length} personas in library · suggested by
            deliverable + theme tag
          </p>
          <input
            type="search"
            className="editorial-personas-search"
            placeholder="search personas…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search persona library"
          />
        </header>

        {available.length === 0 ? (
          <p className="editorial-personas-empty">
            {search.trim() === ''
              ? 'All personas already added.'
              : `No personas match "${search}".`}
          </p>
        ) : (
          <ul className="editorial-personas-library-grid">
            {available.map((p) => (
              <li
                key={p.slug}
                className={`editorial-persona-card${
                  p.suggested ? ' editorial-persona-card-suggested' : ''
                }`}
              >
                {p.suggested ? (
                  <span
                    className={`editorial-persona-suggested editorial-persona-suggested-${p.suggested}`}
                  >
                    ● SUGGESTED
                  </span>
                ) : null}
                <div className="editorial-persona-card-body">
                  <span
                    className={`editorial-persona-avatar editorial-persona-avatar-${p.color}`}
                    aria-hidden="true"
                  >
                    {p.monogram}
                  </span>
                  <h4 className="editorial-persona-name">{p.name}</h4>
                  <p className="editorial-persona-subtitle">
                    {p.occupation} · {p.location}
                  </p>
                  <span className="editorial-persona-cohort">
                    {p.cohortTag}
                  </span>
                  <p className="editorial-persona-quote">“{p.voiceQuote}”</p>
                </div>
                <footer className="editorial-persona-card-footer">
                  <span className="editorial-persona-lastedit">
                    LAST EDIT · {p.lastEditDays}D
                  </span>
                  <button
                    type="button"
                    className={`editorial-chip-button${
                      p.suggested ? ' editorial-chip-button-primary' : ''
                    }`}
                    onClick={() => addPersona(p.slug)}
                  >
                    + ADD
                  </button>
                </footer>
              </li>
            ))}
          </ul>
        )}
      </div>

      {suggested ? (
        <div className="editorial-personas-suggestion">
          <p className="editorial-personas-suggestion-text">
            <strong>{suggested.name}</strong> is suggested — your deliverable
            tags include <code>publishing_economics</code> and your library has
            a <code>{suggested.cohortTag}</code> persona.
          </p>
          <div className="editorial-personas-suggestion-actions">
            <button
              type="button"
              className="editorial-chip-button"
              disabled
              title="Persona authoring lands when rocketorchestra wires up"
            >
              + NEW PERSONA
            </button>
            <button
              type="button"
              className="editorial-chip-button editorial-chip-button-primary"
              onClick={() => addPersona(suggested.slug)}
            >
              ADD SUGGESTED
            </button>
          </div>
        </div>
      ) : null}

      <div className="editorial-section-footer">
        <span className="editorial-section-footer-meta">
          setup_version {setup.setup_version} · changes stale dependent scores
        </span>
      </div>
    </section>
  );
}

type OAuthStatus = {
  connected: boolean;
  kind: 'oauth_subscription' | 'api_key' | 'none';
  expiresAt: string | null;
  expiringSoon: boolean;
};

function AnthropicOAuthCard() {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [pasteOpen, setPasteOpen] = useState<boolean>(false);
  const [pendingState, setPendingState] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState<string>('');
  const [working, setWorking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch(
        '/api/v1/agents/providers/anthropic/oauth/status',
        { credentials: 'include' },
      );
      const json = (await res.json()) as
        | { ok: true; data: OAuthStatus }
        | { ok: false; error: { message: string } };
      if (json.ok) setStatus(json.data);
    } catch {
      // best-effort; keep last status
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleSignIn = async (): Promise<void> => {
    setError(null);
    setWorking(true);
    try {
      const res = await fetch(
        '/api/v1/agents/providers/anthropic/oauth/initiate',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const json = (await res.json()) as
        | {
            ok: true;
            data: { authorizeUrl: string; state: string };
          }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      setPendingState(json.data.state);
      setPasteOpen(true);
      window.open(json.data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to start the Claude sign-in flow.',
      );
    } finally {
      setWorking(false);
    }
  };

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    if (!pendingState) {
      setError(
        'No active OAuth flow. Click Sign in with Claude to start a fresh one.',
      );
      return;
    }
    // Anthropic's console displays the code as `code#state`. If the user
    // pasted the whole blob, split it; otherwise treat the whole input as
    // the code and rely on the stored state.
    const trimmed = pasteValue.trim();
    let code: string;
    let stateFromPaste: string | null = null;
    if (trimmed.includes('#')) {
      const idx = trimmed.indexOf('#');
      code = trimmed.slice(0, idx).trim();
      stateFromPaste = trimmed.slice(idx + 1).trim();
    } else {
      code = trimmed;
    }
    if (!code) {
      setError('Paste the code+state blob from console.anthropic.com.');
      return;
    }
    const state = stateFromPaste || pendingState;

    setWorking(true);
    try {
      const res = await fetch(
        '/api/v1/agents/providers/anthropic/oauth/submit',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, state }),
        },
      );
      const json = (await res.json()) as
        | { ok: true; data: OAuthStatus }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      setStatus(json.data);
      setPasteOpen(false);
      setPendingState(null);
      setPasteValue('');
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to submit the OAuth code.',
      );
    } finally {
      setWorking(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    setError(null);
    setWorking(true);
    try {
      const res = await fetch(
        '/api/v1/agents/providers/anthropic/oauth/disconnect',
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      const json = (await res.json()) as
        | { ok: true; data: OAuthStatus }
        | { ok: false; error: { message: string } };
      if (json.ok) setStatus(json.data);
      else setError(json.error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setWorking(false);
    }
  };

  const expiresLabel = (() => {
    if (!status?.expiresAt) return null;
    const ms = Date.parse(status.expiresAt);
    if (Number.isNaN(ms)) return null;
    const minutes = Math.round((ms - Date.now()) / 60000);
    if (minutes < 0) return 'expired';
    if (minutes < 60) return `expires in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    return `expires in ${hours}h`;
  })();

  const isConnectedOAuth =
    status?.connected && status.kind === 'oauth_subscription';

  return (
    <div className="editorial-oauth-card">
      <div className="editorial-oauth-row">
        <div className="editorial-oauth-row-text">
          <span className="editorial-oauth-label">ANTHROPIC AUTH</span>
          <span
            className={`editorial-oauth-status${
              isConnectedOAuth ? ' editorial-oauth-status-connected' : ''
            }`}
          >
            {loading
              ? 'CHECKING…'
              : isConnectedOAuth
                ? `● CONNECTED (Claude.ai subscription${expiresLabel ? ` · ${expiresLabel}` : ''})`
                : status?.kind === 'api_key'
                  ? '● CONNECTED (API key)'
                  : '○ NOT CONNECTED — agents will fail without an Anthropic credential'}
          </span>
        </div>
        <div className="editorial-oauth-actions">
          {!isConnectedOAuth ? (
            <button
              type="button"
              className="editorial-chip-button editorial-chip-button-primary"
              onClick={() => {
                void handleSignIn();
              }}
              disabled={working}
            >
              {working ? 'STARTING…' : 'SIGN IN WITH CLAUDE'}
            </button>
          ) : (
            <button
              type="button"
              className="editorial-chip-button"
              onClick={() => {
                void handleDisconnect();
              }}
              disabled={working}
            >
              DISCONNECT
            </button>
          )}
        </div>
      </div>

      {pasteOpen ? (
        <div className="editorial-oauth-paste">
          <p className="editorial-oauth-paste-blurb">
            A new tab opened to claude.ai. Sign in, then{' '}
            <strong>console.anthropic.com</strong> will display a code. Paste
            the entire <code>code#state</code> blob below.
          </p>
          <textarea
            className="editorial-oauth-paste-textarea"
            placeholder="code#state"
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            rows={2}
            spellCheck={false}
          />
          <div className="editorial-oauth-paste-actions">
            <button
              type="button"
              className="editorial-chip-button"
              onClick={() => {
                setPasteOpen(false);
                setPendingState(null);
                setPasteValue('');
                setError(null);
              }}
              disabled={working}
            >
              CANCEL
            </button>
            <button
              type="button"
              className="editorial-chip-button editorial-chip-button-primary"
              onClick={() => {
                void handleSubmit();
              }}
              disabled={working || !pasteValue.trim()}
            >
              {working ? 'EXCHANGING…' : 'COMPLETE SIGN-IN'}
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="editorial-oauth-error">{error}</p> : null}
    </div>
  );
}

type OpenAIStatus = {
  connected: boolean;
  kind: 'oauth_subscription' | 'api_key' | 'none';
  expiresAt: string | null;
};

function OpenAICodexOAuthCard() {
  const [status, setStatus] = useState<OpenAIStatus | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [working, setWorking] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  // Active device-code flow state.
  const [pending, setPending] = useState<{
    state: string;
    userCode: string;
    verificationUrl: string;
    intervalMs: number;
    expiresAtMs: number;
  } | null>(null);
  const [pollMessage, setPollMessage] = useState<string>('');
  const pollTimerRef = useRef<number | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch('/api/v1/agents/providers/openai/oauth/status', {
        credentials: 'include',
      });
      const json = (await res.json()) as
        | { ok: true; data: OpenAIStatus }
        | { ok: false; error: { message: string } };
      if (json.ok) setStatus(json.data);
    } catch {
      // best-effort
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    return () => {
      if (pollTimerRef.current !== null) {
        window.clearTimeout(pollTimerRef.current);
      }
    };
  }, []);

  const stopPolling = (): void => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  const startPolling = (
    state: string,
    intervalMs: number,
    expiresAtMs: number,
  ): void => {
    const tick = async (): Promise<void> => {
      if (Date.now() > expiresAtMs) {
        setError('OpenAI device code expired before authorization. Try again.');
        setPending(null);
        setPollMessage('');
        return;
      }
      try {
        const res = await fetch('/api/v1/agents/providers/openai/oauth/poll', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state }),
        });
        const json = (await res.json()) as
          | {
              ok: true;
              data:
                | { status: 'pending' }
                | { status: 'authorized'; expiresAt: string }
                | { status: 'expired' }
                | { status: 'error'; message: string };
            }
          | { ok: false; error: { message: string } };
        if (!json.ok) {
          setError(json.error.message);
          setPending(null);
          setPollMessage('');
          return;
        }
        if (json.data.status === 'pending') {
          setPollMessage('Waiting for browser authorization…');
          pollTimerRef.current = window.setTimeout(() => {
            void tick();
          }, intervalMs);
          return;
        }
        if (json.data.status === 'expired') {
          setError(
            'OpenAI device code expired or not found. Try Sign in again.',
          );
          setPending(null);
          setPollMessage('');
          return;
        }
        if (json.data.status === 'error') {
          setError(json.data.message);
          setPending(null);
          setPollMessage('');
          return;
        }
        // authorized
        setPending(null);
        setPollMessage('');
        setError(null);
        await refresh();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to poll OpenAI for authorization status.',
        );
        setPending(null);
        setPollMessage('');
      }
    };
    pollTimerRef.current = window.setTimeout(() => {
      void tick();
    }, intervalMs);
  };

  const handleSignIn = async (): Promise<void> => {
    setError(null);
    setWorking(true);
    stopPolling();
    try {
      const res = await fetch(
        '/api/v1/agents/providers/openai/oauth/initiate',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        },
      );
      const json = (await res.json()) as
        | {
            ok: true;
            data: {
              state: string;
              userCode: string;
              verificationUrl: string;
              intervalMs: number;
              expiresAtMs: number;
            };
          }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      setPending(json.data);
      setPollMessage('Open the link below + enter the code…');
      window.open(json.data.verificationUrl, '_blank', 'noopener,noreferrer');
      startPolling(
        json.data.state,
        json.data.intervalMs,
        json.data.expiresAtMs,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to start the ChatGPT sign-in flow.',
      );
    } finally {
      setWorking(false);
    }
  };

  const handleCancel = (): void => {
    stopPolling();
    setPending(null);
    setPollMessage('');
    setError(null);
  };

  const handleDisconnect = async (): Promise<void> => {
    setError(null);
    setWorking(true);
    try {
      const res = await fetch(
        '/api/v1/agents/providers/openai/oauth/disconnect',
        { method: 'POST', credentials: 'include' },
      );
      const json = (await res.json()) as
        | { ok: true; data: OpenAIStatus }
        | { ok: false; error: { message: string } };
      if (json.ok) setStatus(json.data);
      else setError(json.error.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect.');
    } finally {
      setWorking(false);
    }
  };

  const expiresLabel = (() => {
    if (!status?.expiresAt) return null;
    const ms = Date.parse(status.expiresAt);
    if (Number.isNaN(ms)) return null;
    const minutes = Math.round((ms - Date.now()) / 60000);
    if (minutes < 0) return 'expired';
    if (minutes < 60) return `expires in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    return `expires in ${hours}h`;
  })();

  const isConnectedOAuth =
    status?.connected && status.kind === 'oauth_subscription';

  return (
    <div className="editorial-oauth-card">
      <div className="editorial-oauth-row">
        <div className="editorial-oauth-row-text">
          <span className="editorial-oauth-label">OPENAI AUTH</span>
          <span
            className={`editorial-oauth-status${
              isConnectedOAuth ? ' editorial-oauth-status-connected' : ''
            }`}
          >
            {loading
              ? 'CHECKING…'
              : isConnectedOAuth
                ? `● CONNECTED (ChatGPT subscription${expiresLabel ? ` · ${expiresLabel}` : ''})`
                : status?.kind === 'api_key'
                  ? '● CONNECTED (API key)'
                  : '○ NOT CONNECTED — OpenAI agents will fail without a credential'}
          </span>
        </div>
        <div className="editorial-oauth-actions">
          {!isConnectedOAuth && !pending ? (
            <button
              type="button"
              className="editorial-chip-button editorial-chip-button-primary"
              onClick={() => {
                void handleSignIn();
              }}
              disabled={working}
            >
              {working ? 'STARTING…' : 'SIGN IN WITH CHATGPT'}
            </button>
          ) : null}
          {isConnectedOAuth ? (
            <button
              type="button"
              className="editorial-chip-button"
              onClick={() => {
                void handleDisconnect();
              }}
              disabled={working}
            >
              DISCONNECT
            </button>
          ) : null}
          {pending ? (
            <button
              type="button"
              className="editorial-chip-button"
              onClick={handleCancel}
            >
              CANCEL
            </button>
          ) : null}
        </div>
      </div>

      {pending ? (
        <div className="editorial-oauth-paste">
          <p className="editorial-oauth-paste-blurb">
            A new tab opened to <strong>auth.openai.com/codex/device</strong>.
            Sign in with your ChatGPT account, then enter this code:
          </p>
          <div className="editorial-oauth-usercode">
            <code>{pending.userCode}</code>
            <a
              href={pending.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="editorial-chip-button"
            >
              OPEN VERIFICATION URL ↗
            </a>
          </div>
          {pollMessage ? (
            <p className="editorial-oauth-poll-message">⌛ {pollMessage}</p>
          ) : null}
        </div>
      ) : null}

      {error ? <p className="editorial-oauth-error">{error}</p> : null}
    </div>
  );
}

function LLMRoomSection({
  setup,
  update,
  nav,
}: {
  setup: SetupState;
  update: (patch: Partial<SetupState>) => void;
  nav: SectionNavProps;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  const selected = useMemo<AgentProfile[]>(
    () =>
      setup.llm_room_agent_profile_ids
        .map((id) => getAgentProfileById(id))
        .filter((a): a is AgentProfile => a !== null),
    [setup.llm_room_agent_profile_ids],
  );

  const available = useMemo<AgentProfile[]>(
    () =>
      FIXTURE_AGENT_PROFILES.filter(
        (a) => !setup.llm_room_agent_profile_ids.includes(a.id),
      ),
    [setup.llm_room_agent_profile_ids],
  );

  const totalCostPerTurn = useMemo(
    () => selected.reduce((sum, a) => sum + a.costPerTurnUsd, 0),
    [selected],
  );

  const addAgent = (id: string): void => {
    if (setup.llm_room_agent_profile_ids.includes(id)) return;
    update({
      llm_room_agent_profile_ids: [...setup.llm_room_agent_profile_ids, id],
    });
  };

  const removeAgent = (id: string): void => {
    update({
      llm_room_agent_profile_ids: setup.llm_room_agent_profile_ids.filter(
        (i) => i !== id,
      ),
    });
  };

  return (
    <section className="editorial-section-workspace">
      <SectionHeader
        num="03"
        title="Who is in the LLM Room?"
        copy="Pick agent profiles that critique, propose, and score during the run. Each one is a named voice with a surface model, a stance, and a per-turn cost — never an anonymous chip."
        nav={nav}
      />

      <AnthropicOAuthCard />
      <OpenAICodexOAuthCard />

      <div className="editorial-agents-selected">
        <h3 className="editorial-personas-section-label">
          ACTIVE · {selected.length}
        </h3>
        {selected.length === 0 ? (
          <p className="editorial-personas-empty">
            No agents in the room yet — pick at least two so a panel turn can
            run.
          </p>
        ) : (
          <ul className="editorial-agents-list">
            {selected.map((a) => (
              <li key={a.id} className="editorial-agent-row">
                <span
                  className={`editorial-persona-avatar editorial-persona-avatar-${a.color}`}
                  aria-hidden="true"
                >
                  {a.monogram}
                </span>
                <div className="editorial-agent-row-text">
                  <div className="editorial-agent-headline">
                    <span className="editorial-persona-name">{a.name}</span>
                    <span className="editorial-agent-role">{a.role}</span>
                  </div>
                  <p className="editorial-agent-stance">{a.stance}</p>
                </div>
                <span className="editorial-agent-model">
                  {a.model} · {a.provider}
                </span>
                <span className="editorial-agent-cost">
                  ~${a.costPerTurnUsd.toFixed(2)}/TURN
                </span>
                <button
                  type="button"
                  className="editorial-chip-button"
                  onClick={() => removeAgent(a.id)}
                >
                  REMOVE
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="editorial-agents-footer">
        <span className="editorial-agents-footer-meta">
          {selected.length} ACTIVE · ALL PROFILES FROM AGENT-PROFILE LIBRARY ·
          EST. ~${totalCostPerTurn.toFixed(2)} PER PANEL TURN
        </span>
        <div className="editorial-agents-footer-actions">
          <button
            type="button"
            className="editorial-chip-button editorial-chip-button-primary"
            onClick={() => setPickerOpen((open) => !open)}
            disabled={available.length === 0}
          >
            {pickerOpen ? '✕ CLOSE PICKER' : '+ ADD AGENT'}
          </button>
          <button type="button" className="editorial-chip-button" disabled>
            BROWSE LIBRARY
          </button>
        </div>
      </div>

      {pickerOpen && available.length > 0 ? (
        <div className="editorial-agents-picker">
          <h3 className="editorial-personas-section-label">
            AGENT LIBRARY · {available.length} AVAILABLE
          </h3>
          <ul className="editorial-agents-picker-grid">
            {available.map((a) => (
              <li
                key={a.id}
                className={`editorial-agent-card${
                  a.suggested ? ' editorial-agent-card-suggested' : ''
                }`}
              >
                {a.suggested ? (
                  <span className="editorial-persona-suggested editorial-persona-suggested-yellow">
                    ● SUGGESTED
                  </span>
                ) : null}
                <div className="editorial-agent-card-body">
                  <div className="editorial-agent-card-headline">
                    <span
                      className={`editorial-persona-avatar editorial-persona-avatar-${a.color}`}
                      aria-hidden="true"
                    >
                      {a.monogram}
                    </span>
                    <div>
                      <h4 className="editorial-persona-name">{a.name}</h4>
                      <span className="editorial-agent-role">{a.role}</span>
                    </div>
                  </div>
                  <span className="editorial-agent-model">
                    {a.model} · {a.provider}
                  </span>
                  <p className="editorial-agent-stance">{a.stance}</p>
                </div>
                <footer className="editorial-agent-card-footer">
                  <span className="editorial-agent-cost">
                    ~${a.costPerTurnUsd.toFixed(2)}/TURN
                  </span>
                  <button
                    type="button"
                    className={`editorial-chip-button${
                      a.suggested ? ' editorial-chip-button-primary' : ''
                    }`}
                    onClick={() => {
                      addAgent(a.id);
                      if (available.length === 1) setPickerOpen(false);
                    }}
                  >
                    + ADD
                  </button>
                </footer>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="editorial-section-footer">
        <span className="editorial-section-footer-meta">
          setup_version {setup.setup_version} · changes stale dependent scores
        </span>
      </div>
    </section>
  );
}

function ScoringSection({
  setup,
  update,
  nav,
}: {
  setup: SetupState;
  update: (patch: Partial<SetupState>) => void;
  nav: SectionNavProps;
}) {
  const pipeline: ScoringPipeline =
    getPipelineBySlug(setup.scoring_pipeline_slug) ?? FIXTURE_PIPELINES[0];

  return (
    <section className="editorial-section-workspace">
      <SectionHeader
        num="04"
        title="What scoring system governs gates?"
        copy="Pick a scoring pipeline. Each pipeline bundles weighted scorers and budget caps that govern Theme/Topic/Draft optimization. Inline tuning lands when SetupState extends with per-piece overrides."
        nav={nav}
      />

      <div className="editorial-scoring-grid">
        {/* Column 1 — PIPELINE */}
        <div className="editorial-scoring-col">
          <h3 className="editorial-personas-section-label">PIPELINE</h3>
          <select
            className="editorial-scoring-pipeline-select"
            value={setup.scoring_pipeline_slug}
            onChange={(e) => update({ scoring_pipeline_slug: e.target.value })}
            aria-label="Scoring pipeline"
          >
            {FIXTURE_PIPELINES.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="editorial-scoring-pipeline-desc">
            {pipeline.description}
          </p>
          <p className="editorial-scoring-pipeline-meta">
            slug: <code>{pipeline.slug}</code>
          </p>
        </div>

        {/* Column 2 — SCORERS */}
        <div className="editorial-scoring-col">
          <h3 className="editorial-personas-section-label">
            SCORERS · WEIGHTS
          </h3>
          <ul className="editorial-scoring-scorers">
            {pipeline.scorers.map((s) => (
              <li key={s.name} className="editorial-scoring-scorer">
                <div className="editorial-scoring-scorer-row">
                  <span className="editorial-scoring-scorer-name">
                    {s.name}
                  </span>
                  <div className="editorial-scoring-scorer-bar">
                    <div
                      className="editorial-scoring-scorer-fill"
                      style={{ width: `${Math.round(s.weight * 100)}%` }}
                    />
                  </div>
                  <span className="editorial-scoring-scorer-weight">
                    ×{s.weight.toFixed(2)}
                  </span>
                </div>
                <p className="editorial-scoring-scorer-desc">{s.description}</p>
                {s.note ? (
                  <p className="editorial-scoring-scorer-note">{s.note}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="editorial-scoring-tuning-note">
            Inline weight tuning is read-only at v0p. Per-piece scorer overrides
            land when SetupState extends to carry them.
          </p>
        </div>

        {/* Column 3 — BUDGET CAPS */}
        <div className="editorial-scoring-col">
          <h3 className="editorial-personas-section-label">BUDGET CAPS</h3>
          <ul className="editorial-scoring-caps">
            {pipeline.budgetCaps.map((cap) => (
              <li key={cap.label} className="editorial-scoring-cap">
                <span className="editorial-scoring-cap-label">{cap.label}</span>
                <span className="editorial-scoring-cap-value">{cap.value}</span>
              </li>
            ))}
          </ul>
          <p className="editorial-scoring-tuning-note">
            Hard caps for OPTIMIZATION_LOOP §5 cost guardrails. Inline editing
            lands with SetupState overrides.
          </p>
        </div>
      </div>

      <div className="editorial-section-footer">
        <span className="editorial-section-footer-meta">
          setup_version {setup.setup_version} · changes stale dependent scores
        </span>
      </div>
    </section>
  );
}

function StubSection({
  num,
  title,
  copy,
  note,
  nav,
}: {
  num: string;
  title: string;
  copy: string;
  note: string;
  nav: SectionNavProps;
}) {
  return (
    <section className="editorial-section-workspace">
      <SectionHeader num={num} title={title} copy={copy} nav={nav} />
      <div className="editorial-stub-callout">
        <strong>NEXT SLICE.</strong> {note}
      </div>
    </section>
  );
}
