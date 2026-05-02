import { useMemo, useState } from 'react';

// SetupState mirrors docs/contracts/editorial-room/v0/setup_state.schema.json
// (also in EDITORIAL_ROOM_CONTRACT.md §2.1). Held in component state for the
// 0p-a vertical slice; no persistence yet.
type DeliverableType =
  | 'longform_post'
  | 'podcast_script'
  | 'book_chapter'
  | 'social_post'
  | 'memo';

type Destination =
  | 'substack_md'
  | 'google_doc'
  | 'plain_md'
  | 'youtube_script'
  | 'other';

type SetupState = {
  schema_version: '0';
  setup_version: number;
  deliverable_type: DeliverableType;
  voice_page_slug: string;
  length_target: { min_words: number; max_words: number } | null;
  destination: Destination;
  audience_persona_slugs: string[];
  llm_room_agent_profile_ids: string[];
  scoring_pipeline_slug: string;
  updated_at: string;
  updated_by_user_id: string;
};

const PHASES = [
  { id: 'setup', label: '01 SETUP' },
  { id: 'theme-topics', label: '02 THEME + TOPICS' },
  { id: 'points-outline', label: '03 POINTS + OUTLINE' },
  { id: 'draft', label: '04 DRAFT' },
  { id: 'polish', label: '05 POLISH' },
  { id: 'ship', label: '06 SHIP' },
] as const;

type SectionId = 'deliverable' | 'audience' | 'llm-room' | 'scoring';

const SECTIONS: ReadonlyArray<{ id: SectionId; num: string; name: string }> = [
  { id: 'deliverable', num: '01', name: 'Deliverable' },
  { id: 'audience', num: '02', name: 'Audience' },
  { id: 'llm-room', num: '03', name: 'LLM Room' },
  { id: 'scoring', num: '04', name: 'Scoring System' },
];

const DELIVERABLE_LABELS: Record<DeliverableType, string> = {
  longform_post: 'Longform Post',
  podcast_script: 'Podcast Script',
  book_chapter: 'Book Chapter',
  social_post: 'Social Post',
  memo: 'Memo',
};

const DESTINATION_LABELS: Record<Destination, string> = {
  substack_md: 'Substack · Markdown export',
  google_doc: 'Google Doc',
  plain_md: 'Plain Markdown',
  youtube_script: 'YouTube Script',
  other: 'Other',
};

function defaultSetupState(): SetupState {
  return {
    schema_version: '0',
    setup_version: 1,
    deliverable_type: 'longform_post',
    voice_page_slug: 'voice/gamemakers-2026',
    length_target: { min_words: 2000, max_words: 2500 },
    destination: 'substack_md',
    audience_persona_slugs: [],
    llm_room_agent_profile_ids: [],
    scoring_pipeline_slug: 'scoring_pipeline/gamemakers_default',
    updated_at: new Date().toISOString(),
    updated_by_user_id: 'user_local_joseph',
  };
}

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
  const [setup, setSetup] = useState<SetupState>(defaultSetupState);
  const [activeSection, setActiveSection] = useState<SectionId>('deliverable');
  const [pieceTitle, setPieceTitle] = useState('Untitled Piece — new');

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

  return (
    <div className="editorial-room">
      <header className="editorial-phase-strip">
        <div className="editorial-phase-strip-brand">
          <span className="editorial-phase-strip-mark">ER</span>
          <span className="editorial-phase-strip-title">
            Editorial Room <span className="editorial-version">v0P</span>
          </span>
        </div>
        <nav className="editorial-phase-strip-pills">
          {PHASES.map((p) => (
            <span
              key={p.id}
              className={`editorial-phase-pill${p.id === 'setup' ? ' editorial-phase-pill-active' : ''}`}
            >
              {p.label}
            </span>
          ))}
        </nav>
        <div className="editorial-phase-strip-actions">
          <button type="button" className="editorial-chip-button" disabled>
            ⌘K
          </button>
          <button type="button" className="editorial-chip-button" disabled>
            HISTORY
          </button>
          <button type="button" className="editorial-chip-button" disabled>
            SAVE
          </button>
        </div>
      </header>

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
            <DeliverableSection setup={setup} update={update} />
          )}
          {activeSection === 'audience' && (
            <StubSection
              num="02"
              title="Who is this for?"
              copy="Add personas from your library. Each one becomes a scoring perspective at every layer."
              note="Persona library picker, suggestions, weight editing — coming next slice."
            />
          )}
          {activeSection === 'llm-room' && (
            <StubSection
              num="03"
              title="Who is in the LLM Room?"
              copy="Pick agent profiles that critique, propose, and score during the run."
              note="Agent library + per-agent stance/cost — coming next slice."
            />
          )}
          {activeSection === 'scoring' && (
            <StubSection
              num="04"
              title="What scoring system governs gates?"
              copy="Pick a scoring pipeline. Tune scorer weights and budget caps inline."
              note="Pipeline picker · weighted-scorer editor · budget caps — coming next slice."
            />
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

function DeliverableSection({
  setup,
  update,
}: {
  setup: SetupState;
  update: (patch: Partial<SetupState>) => void;
}) {
  const target = setup.length_target;
  return (
    <section className="editorial-section-workspace">
      <p className="editorial-section-eyebrow">SECTION 01 · OF 04</p>
      <h1 className="editorial-section-heading">What are you producing?</h1>
      <p className="editorial-section-subhead">
        Define the deliverable, voice, length, and destination. These four
        fields flow into every downstream phase.
      </p>

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
          <input
            type="text"
            value={setup.voice_page_slug}
            placeholder="voice/gamemakers-2026"
            onChange={(e) => update({ voice_page_slug: e.target.value })}
          />
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

function StubSection({
  num,
  title,
  copy,
  note,
}: {
  num: string;
  title: string;
  copy: string;
  note: string;
}) {
  return (
    <section className="editorial-section-workspace">
      <p className="editorial-section-eyebrow">SECTION {num} · OF 04</p>
      <h1 className="editorial-section-heading">{title}</h1>
      <p className="editorial-section-subhead">{copy}</p>
      <div className="editorial-stub-callout">
        <strong>NEXT SLICE.</strong> {note}
      </div>
    </section>
  );
}
