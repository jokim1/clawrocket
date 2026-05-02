import { useEffect, useMemo, useState } from 'react';

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
