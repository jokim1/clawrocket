import { useMemo, useState } from 'react';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';

// ───────────────────────────────────────────────────────────────────────────
// Fixture-shaped data, hardcoded inline for the 0p-a vertical slice. Real
// loads come from rocketorchestra page reads + clawrocket score_snapshots /
// discussion_sessions / point_note_blocks once those are wired up.
// ───────────────────────────────────────────────────────────────────────────

type Theme = {
  slug: string;
  name: string;
  version: number;
  topicCount: number;
  score: number;
};

type Persona = { slug: string; letter: string; name: string };

type ScoreRow = {
  persona: Persona;
  score: number;
  note: string;
};

type Topic = {
  slug: string;
  workingTitle: string;
  thesis: string;
  score: number;
  scoreRow: ScoreRow[];
  aggregate: { score: number; ssr: number; gatesPass: boolean };
  notes: NoteBlock[];
  discussion: DiscussionTurn[];
  sources: SourceCard[];
  isCounter?: boolean;
};

// Topic-scoped note types per design/02_theme_topics.md §6.4
// ('angle | stake | thought | concern | other'). Differs from the schema's
// PointNoteBlock.type enum — flagged in earlier PR descriptions; resolved
// in a future contract reconciliation.
type NoteType = 'angle' | 'stake' | 'thought' | 'concern' | 'other';
type NoteBlock = {
  id: string;
  type: NoteType;
  body: string;
  debated?: boolean;
};

type DiscussionTurn = {
  id: string;
  agent: Persona;
  timestamp: string;
  noteRefs: NoteType[];
  body: string;
  proposes: string | null;
};

type SourceCard = {
  id: string;
  index: number;
  type: 'PRIMARY' | 'ANEC' | 'SEC';
  title: string;
  detail: string;
  cited: boolean;
  disputed?: boolean;
};

const PRIMARY_PERSONAS: ReadonlyArray<Persona> = [
  { slug: 'persona/ankit-indie-dev', letter: 'A', name: 'ANKIT' },
  { slug: 'persona/ravi-studio-lead', letter: 'R', name: 'RAVI' },
  { slug: 'persona/mei-publisher', letter: 'M', name: 'MEI' },
];

const SETUP_CHIPS = {
  length: '1k–1.4k words',
  audience: 'indie devs · mid-career',
  ssrThreshold: 'SSR ≥ 0.6',
  pmfThreshold: 'PMF ≥ 7',
};

const THEMES: ReadonlyArray<Theme> = [
  {
    slug: 'ai-impact',
    name: 'AI Impact on Game Dev',
    version: 4,
    topicCount: 3,
    score: 7.4,
  },
  {
    slug: 'creative-burnout',
    name: 'Creative Burnout',
    version: 2,
    topicCount: 1,
    score: 7.1,
  },
  {
    slug: 'indie-economics-2025',
    name: 'Indie Economics 2025',
    version: 3,
    topicCount: 2,
    score: 6.8,
  },
  {
    slug: 'genre-consolidation',
    name: 'Genre Consolidation',
    version: 1,
    topicCount: 1,
    score: 6.6,
  },
  {
    slug: 'steam-discoverability',
    name: 'Steam Discoverability',
    version: 2,
    topicCount: 1,
    score: 6.2,
  },
  {
    slug: 'publisher-relations',
    name: 'Publisher Relations',
    version: 1,
    topicCount: 0,
    score: 5.4,
  },
];

const EMBRACER_TOPIC: Topic = {
  slug: 'embracer-writedown',
  workingTitle: "How Embracer's $2.1B writedown changed indie publishing terms",
  thesis:
    "Surviving studios are signing 2022-rate deals to keep going — Embracer's writedown shifted bargaining power away from devs in a way that's locked in for 18+ months.",
  score: 7.8,
  scoreRow: [
    { persona: PRIMARY_PERSONAS[0], score: 9, note: '"lead with this"' },
    {
      persona: PRIMARY_PERSONAS[1],
      score: 9,
      note: 'needs a person · ⚑',
    },
    {
      persona: PRIMARY_PERSONAS[2],
      score: 7,
      note: '"verify Devolver $5"',
    },
  ],
  aggregate: { score: 7.8, ssr: 0.78, gatesPass: true },
  notes: [
    {
      id: 'n1',
      type: 'angle',
      body: 'What changed in MG accounting — your next deal will be different.',
      debated: true,
    },
    {
      id: 'n2',
      type: 'stake',
      body: 'Mid-tier studios pay; tiny indies get a relative tailwind.',
    },
    {
      id: 'n3',
      type: 'thought',
      body: "The 'reverts in 18 months' counter is publisher-bias — flag above.",
    },
    {
      id: 'n4',
      type: 'concern',
      body: 'Annapurna staffer (background) contradicts filings — VERIFY before draft.',
      debated: true,
    },
    {
      id: 'n5',
      type: 'thought',
      body: 'Devolver Q4 prelim ambiguous on conditional MGs.',
    },
  ],
  discussion: [
    {
      id: 't1',
      agent: PRIMARY_PERSONAS[0],
      timestamp: '11:42',
      noteRefs: ['angle'],
      body: 'The angle note is the load-bearing one. Lead with the MG-as-conditional-liability framing.',
      proposes: null,
    },
    {
      id: 't2',
      agent: PRIMARY_PERSONAS[1],
      timestamp: '11:43',
      noteRefs: ['stake'],
      body: "The stake is right but abstract. Add a thought-note: which specific solo dev got their deal repapered? That's the piece.",
      proposes: 'ADD: SOLO-DEV CASE STUDY',
    },
    {
      id: 't3',
      agent: PRIMARY_PERSONAS[2],
      timestamp: '11:43',
      noteRefs: ['concern'],
      body: 'Annapurna concern is a real falsifier — needs verification before this clears Polish. Flagged.',
      proposes: null,
    },
    {
      id: 't4',
      agent: PRIMARY_PERSONAS[0],
      timestamp: '11:47',
      noteRefs: ['stake', 'concern'],
      body: "Agreed. If Annapurna's claim holds, the 'tiny indies tailwind' stake is wrong, not just incomplete.",
      proposes: null,
    },
  ],
  sources: [
    {
      id: 's1',
      index: 1,
      type: 'PRIMARY',
      title: 'Embracer Q3 8-K',
      detail: 'pp.14-16, MG reclassification',
      cited: true,
    },
    {
      id: 's2',
      index: 2,
      type: 'PRIMARY',
      title: 'Devolver Q4 prelim',
      detail: '$5 conditional advances',
      cited: true,
      disputed: true,
    },
    {
      id: 's3',
      index: 3,
      type: 'ANEC',
      title: 'Annapurna staffer',
      detail: 'background, contradicts $2',
      cited: true,
    },
    {
      id: 's4',
      index: 4,
      type: 'SEC',
      title: 'Game Industry News',
      detail: 'Apr 2025 explainer',
      cited: false,
    },
  ],
};

const SIX_PERSON_TOPIC: Topic = {
  slug: '6-person-studio',
  workingTitle: 'The 6-person studio is the new 20-person studio',
  thesis:
    'AI-assisted pipelines compress the staffing curve so a 6-person team ships what a 20-person team did in 2022 — but only if you redesign the org.',
  score: 6.6,
  scoreRow: [
    { persona: PRIMARY_PERSONAS[0], score: 7, note: '"angle is real"' },
    {
      persona: PRIMARY_PERSONAS[1],
      score: 6,
      note: 'org-redesign hand-wave',
    },
    { persona: PRIMARY_PERSONAS[2], score: 7, note: 'reasonable framing' },
  ],
  aggregate: { score: 6.6, ssr: 0.62, gatesPass: true },
  notes: [
    {
      id: 'n1',
      type: 'angle',
      body: 'Compressed staffing curve, not just "AI makes faster" — the org has to redesign roles.',
    },
    {
      id: 'n2',
      type: 'stake',
      body: 'Founders who keep the 20-person mental model burn 2× the runway.',
    },
    {
      id: 'n3',
      type: 'concern',
      body: 'Sample of 1 (Manor Lords). Need second case before this is a Topic.',
    },
  ],
  discussion: [
    {
      id: 't1',
      agent: PRIMARY_PERSONAS[1],
      timestamp: '10:14',
      noteRefs: ['concern'],
      body: 'Sample of 1 means we either find a second case study or downgrade to a Stake note inside the Embracer Topic.',
      proposes: null,
    },
  ],
  sources: [
    {
      id: 's1',
      index: 1,
      type: 'PRIMARY',
      title: 'Manor Lords postmortem',
      detail: 'Slavic Magic blog, Mar 2025',
      cited: true,
    },
  ],
};

const AI_ART_TOPIC: Topic = {
  slug: 'ai-art-pl',
  workingTitle: 'Why AI-art P&L wins on paper, loses at funding time',
  thesis:
    'Investors discount AI-asset pipelines because the IP-defensibility story is unsettled — the savings are real but the cap-table impact is negative.',
  score: 6.1,
  scoreRow: [
    { persona: PRIMARY_PERSONAS[0], score: 7, note: 'punchy framing' },
    { persona: PRIMARY_PERSONAS[1], score: 6, note: 'thin on data' },
    {
      persona: PRIMARY_PERSONAS[2],
      score: 5,
      note: '"name 3 funds that say this"',
    },
  ],
  aggregate: { score: 6.1, ssr: 0.59, gatesPass: false },
  notes: [
    {
      id: 'n1',
      type: 'angle',
      body: 'Cap-table discount is real — investors are pricing legal risk into AI-asset studios.',
    },
    {
      id: 'n2',
      type: 'thought',
      body: 'Need at least 3 named funds for this to clear the gate.',
    },
  ],
  discussion: [],
  sources: [],
};

const COUNTER_TOPIC: Topic = {
  slug: 'ai-tooling-overhyped',
  workingTitle: 'Why AI tooling is overhyped for solo devs',
  thesis:
    'For solo devs the productivity gains are real but the pipeline overhead eats most of them — the marginal hire is still cheaper than the marginal AI subscription.',
  score: 5.8,
  scoreRow: [
    { persona: PRIMARY_PERSONAS[0], score: 6, note: 'contrarian — keep' },
    { persona: PRIMARY_PERSONAS[1], score: 5, note: 'overstated' },
    { persona: PRIMARY_PERSONAS[2], score: 6, note: 'useful counter' },
  ],
  aggregate: { score: 5.8, ssr: 0.52, gatesPass: false },
  notes: [],
  discussion: [],
  sources: [],
  isCounter: true,
};

const TOPICS_BY_THEME: Record<string, ReadonlyArray<Topic>> = {
  'ai-impact': [EMBRACER_TOPIC, SIX_PERSON_TOPIC, AI_ART_TOPIC, COUNTER_TOPIC],
  'creative-burnout': [],
  'indie-economics-2025': [],
  'genre-consolidation': [],
  'steam-discoverability': [],
  'publisher-relations': [],
};

// ───────────────────────────────────────────────────────────────────────────
// Page
// ───────────────────────────────────────────────────────────────────────────

const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  angle: 'ANGLE',
  stake: 'STAKE',
  thought: 'THOUGHT',
  concern: 'CONCERN',
  other: 'OTHER',
};

const NOTE_TYPES: ReadonlyArray<NoteType> = [
  'angle',
  'stake',
  'thought',
  'concern',
  'other',
];

type Props = {
  onUnauthorized?: () => void;
};

export function ThemeTopicsWorkspacePage(_props: Props) {
  const [activeThemeSlug, setActiveThemeSlug] = useState<string>('ai-impact');
  const [activeTopicSlug, setActiveTopicSlug] =
    useState<string>('embracer-writedown');

  const topics = useMemo(
    () => TOPICS_BY_THEME[activeThemeSlug] ?? [],
    [activeThemeSlug],
  );
  const mainTopics = useMemo(
    () => topics.filter((t) => !t.isCounter),
    [topics],
  );
  const counterTopics = useMemo(
    () => topics.filter((t) => t.isCounter),
    [topics],
  );

  const activeTopic =
    topics.find((t) => t.slug === activeTopicSlug) ?? topics[0] ?? null;

  const activeTheme = THEMES.find((t) => t.slug === activeThemeSlug);

  return (
    <div className="editorial-room">
      <EditorialPhaseStrip activePhase="theme-topics" />

      <div className="editorial-tt-chipbar">
        <div className="editorial-tt-chipbar-personas">
          {PRIMARY_PERSONAS.map((p) => (
            <span
              key={p.slug}
              className="editorial-persona-avatar"
              data-persona={p.letter}
            >
              {p.letter}
            </span>
          ))}
          <span className="editorial-tt-chipbar-text">
            {PRIMARY_PERSONAS.length} personas
          </span>
        </div>
        <span className="editorial-tt-chipbar-sep">·</span>
        <span className="editorial-tt-chipbar-text">{SETUP_CHIPS.length}</span>
        <span className="editorial-tt-chipbar-sep">·</span>
        <span className="editorial-tt-chipbar-text">
          {SETUP_CHIPS.audience}
        </span>
        <span className="editorial-tt-chipbar-sep">·</span>
        <span className="editorial-tt-chipbar-pip">
          {SETUP_CHIPS.ssrThreshold}
        </span>
        <span className="editorial-tt-chipbar-pip">
          {SETUP_CHIPS.pmfThreshold}
        </span>
        <button
          type="button"
          className="editorial-chip-button editorial-tt-chipbar-edit"
          disabled
        >
          edit setup
        </button>
      </div>

      <div className="editorial-tt-grid">
        {/* THEMES COLUMN */}
        <aside className="editorial-tt-themes">
          <h2 className="editorial-rail-heading">THEMES · {THEMES.length}</h2>
          <ul className="editorial-tt-theme-list">
            {THEMES.map((t) => (
              <li key={t.slug}>
                <button
                  type="button"
                  className={
                    'editorial-tt-theme-card' +
                    (t.slug === activeThemeSlug
                      ? ' editorial-tt-theme-card-active'
                      : '')
                  }
                  onClick={() => {
                    setActiveThemeSlug(t.slug);
                    const next = TOPICS_BY_THEME[t.slug] ?? [];
                    if (next.length > 0) {
                      setActiveTopicSlug(next[0].slug);
                    }
                  }}
                >
                  <span className="editorial-tt-theme-name">{t.name}</span>
                  <span className="editorial-tt-theme-meta">
                    V{t.version} · {t.topicCount} TOPICS
                  </span>
                  <span className="editorial-tt-theme-score">
                    {t.score.toFixed(1)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="editorial-tt-propose-button"
            disabled
          >
            + PROPOSE THEMES
          </button>
        </aside>

        {/* TOPICS COLUMN */}
        <aside className="editorial-tt-topics">
          <h2 className="editorial-rail-heading">
            TOPICS · UNDER{' '}
            <span className="editorial-tt-topics-theme">
              {activeTheme?.name.toUpperCase().replace(/ /g, ' ')}
            </span>
            <span className="editorial-rail-heading-count">
              · {mainTopics.length}
            </span>
          </h2>
          {mainTopics.length === 0 ? (
            <p className="editorial-tt-empty">
              No Topics under this Theme yet.
            </p>
          ) : (
            <ul className="editorial-tt-topic-list">
              {mainTopics.map((t) => (
                <li key={t.slug}>
                  <button
                    type="button"
                    className={
                      'editorial-tt-topic-card' +
                      (t.slug === activeTopicSlug
                        ? ' editorial-tt-topic-card-active'
                        : '')
                    }
                    onClick={() => setActiveTopicSlug(t.slug)}
                  >
                    <span className="editorial-tt-topic-title">
                      {t.workingTitle}
                    </span>
                    <span className="editorial-tt-topic-score">
                      {t.score.toFixed(1)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="editorial-tt-propose-button"
            disabled
          >
            + PROPOSE TOPICS
          </button>

          {counterTopics.length > 0 ? (
            <>
              <h2 className="editorial-rail-heading editorial-rail-heading-spaced editorial-rail-heading-counter">
                COUNTER-TOPIC · {counterTopics.length}
              </h2>
              <ul className="editorial-tt-topic-list">
                {counterTopics.map((t) => (
                  <li key={t.slug}>
                    <button
                      type="button"
                      className={
                        'editorial-tt-topic-card editorial-tt-topic-card-counter' +
                        (t.slug === activeTopicSlug
                          ? ' editorial-tt-topic-card-active'
                          : '')
                      }
                      onClick={() => setActiveTopicSlug(t.slug)}
                    >
                      <span className="editorial-tt-topic-title">
                        {t.workingTitle}
                      </span>
                      <span className="editorial-tt-topic-score">
                        {t.score.toFixed(1)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        {/* CENTER: TOPIC DETAIL */}
        <main className="editorial-tt-center">
          {activeTopic ? (
            <TopicDetail topic={activeTopic} />
          ) : (
            <div className="editorial-tt-center-empty">
              Pick a Theme with Topics to start.
            </div>
          )}
        </main>

        {/* SOURCES RAIL */}
        <aside className="editorial-tt-sources">
          <div className="editorial-tt-sources-header">
            <h2 className="editorial-rail-heading">
              SOURCES · {activeTopic?.sources.length ?? 0}
            </h2>
            <button type="button" className="editorial-chip-button" disabled>
              + ADD
            </button>
          </div>
          {activeTopic && activeTopic.sources.length > 0 ? (
            <ul className="editorial-tt-source-list">
              {activeTopic.sources.map((s) => (
                <li key={s.id} className="editorial-tt-source-card">
                  <div className="editorial-tt-source-row">
                    <span className="editorial-tt-source-index">
                      SRC #{s.index}
                    </span>
                    <span className="editorial-tt-source-type">{s.type}</span>
                  </div>
                  <div className="editorial-tt-source-title">{s.title}</div>
                  <div className="editorial-tt-source-detail">{s.detail}</div>
                  <div className="editorial-tt-source-badges">
                    {s.cited ? (
                      <span className="editorial-tt-source-badge editorial-tt-source-badge-cited">
                        ✓ CITED
                      </span>
                    ) : null}
                    {s.disputed ? (
                      <span className="editorial-tt-source-badge editorial-tt-source-badge-disputed">
                        ! DISPUTED
                      </span>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="editorial-tt-empty">No sources yet.</p>
          )}

          <div className="editorial-tt-source-dropzone">
            DROP FILE OR PASTE URL
          </div>
        </aside>
      </div>
    </div>
  );
}

function TopicDetail({ topic }: { topic: Topic }) {
  return (
    <article className="editorial-tt-topic-detail">
      <header className="editorial-tt-topic-header">
        <span className="editorial-tt-topic-eyebrow">TOPIC</span>
        <h1 className="editorial-tt-topic-heading">{topic.workingTitle}</h1>
        <div className="editorial-tt-topic-actions">
          <button type="button" className="editorial-chip-button" disabled>
            + POINT
          </button>
          <button
            type="button"
            className="editorial-chip-button editorial-chip-button-primary"
            disabled
          >
            OPTIMIZE TOPIC →
          </button>
        </div>
      </header>

      <div className="editorial-tt-score-row">
        {topic.scoreRow.map((cell) => (
          <div key={cell.persona.slug} className="editorial-tt-score-cell">
            <div className="editorial-tt-score-cell-head">
              <span
                className="editorial-persona-avatar editorial-persona-avatar-sm"
                data-persona={cell.persona.letter}
              >
                {cell.persona.letter}
              </span>
              <span className="editorial-tt-score-cell-name">
                {cell.persona.name}
              </span>
            </div>
            <div
              className={
                'editorial-tt-score-cell-number' +
                (cell.score < 5
                  ? ' editorial-tt-score-cell-number-low'
                  : cell.score >= 7
                    ? ' editorial-tt-score-cell-number-high'
                    : '')
              }
            >
              {cell.score}
            </div>
            <div className="editorial-tt-score-cell-note">{cell.note}</div>
          </div>
        ))}
        <div className="editorial-tt-score-cell editorial-tt-score-cell-aggregate">
          <div className="editorial-tt-score-cell-head">
            <span className="editorial-tt-score-cell-name">AGGREGATE</span>
          </div>
          <div className="editorial-tt-score-cell-number">
            {topic.aggregate.score.toFixed(1)}
          </div>
          <div className="editorial-tt-score-cell-note">
            SSR {topic.aggregate.ssr.toFixed(2)} ·{' '}
            {topic.aggregate.gatesPass ? '✓ GATES' : '✗ GATES'}
          </div>
        </div>
      </div>

      <section className="editorial-tt-oneliner">
        <h3 className="editorial-tt-section-label">ONE-LINER</h3>
        <p className="editorial-tt-oneliner-body">{topic.thesis}</p>
      </section>

      <section className="editorial-tt-notes">
        <header className="editorial-tt-notes-header">
          <h3 className="editorial-tt-section-label">
            NOTES · {topic.notes.length}
          </h3>
          <div className="editorial-tt-notes-add">
            {NOTE_TYPES.map((nt) => (
              <button
                key={nt}
                type="button"
                className={`editorial-chip-button editorial-tt-note-chip editorial-tt-note-chip-${nt}`}
                disabled
              >
                + {NOTE_TYPE_LABEL[nt]}
              </button>
            ))}
          </div>
        </header>
        {topic.notes.length === 0 ? (
          <p className="editorial-tt-empty">
            No notes yet — pick a type to start.
          </p>
        ) : (
          <ul className="editorial-tt-note-grid">
            {topic.notes.map((n) => (
              <li
                key={n.id}
                className={`editorial-tt-note-card editorial-tt-note-card-${n.type}`}
              >
                <div className="editorial-tt-note-head">
                  <span
                    className={`editorial-tt-note-dot editorial-tt-note-dot-${n.type}`}
                  />
                  <span className="editorial-tt-note-type">
                    {NOTE_TYPE_LABEL[n.type]}
                  </span>
                  {n.debated ? (
                    <span className="editorial-tt-note-debated">DEBATED</span>
                  ) : null}
                </div>
                <p className="editorial-tt-note-body">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="editorial-tt-discussion">
        <header className="editorial-tt-discussion-header">
          <h3 className="editorial-tt-section-label">
            PANEL DISCUSSION · {topic.discussion.length} TURNS
            {topic.discussion.length > 0 ? ' DEBATING NOTES ABOVE' : ''}
          </h3>
          <span className="editorial-tt-discussion-last">
            {topic.discussion.length > 0
              ? `LAST ${topic.discussion[topic.discussion.length - 1].timestamp}`
              : '—'}
          </span>
        </header>
        {topic.discussion.length === 0 ? (
          <p className="editorial-tt-empty">
            No discussion yet — ask the panel.
          </p>
        ) : (
          <ol className="editorial-tt-turn-list">
            {topic.discussion.map((t) => (
              <li key={t.id} className="editorial-tt-turn">
                <div className="editorial-tt-turn-head">
                  <span
                    className="editorial-persona-avatar editorial-persona-avatar-sm"
                    data-persona={t.agent.letter}
                  >
                    {t.agent.letter}
                  </span>
                  <span className="editorial-tt-turn-name">{t.agent.name}</span>
                  <span className="editorial-tt-turn-timestamp">
                    {t.timestamp}
                  </span>
                  {t.noteRefs.map((nr) => (
                    <span
                      key={nr}
                      className={`editorial-tt-turn-noteref editorial-tt-turn-noteref-${nr}`}
                    >
                      ↑ note: {nr}
                    </span>
                  ))}
                </div>
                <p className="editorial-tt-turn-body">{t.body}</p>
                {t.proposes ? (
                  <p className="editorial-tt-turn-proposes">
                    PROPOSES: {t.proposes}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <div className="editorial-tt-discussion-input">
          <input
            type="text"
            placeholder="Ask the panel — or @reference a note above…"
            disabled
          />
          <div className="editorial-tt-discussion-mentions">
            {['@ALL', '@A', '@R', '@M', '#NOTE'].map((m) => (
              <span key={m} className="editorial-tt-discussion-mention">
                {m}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="editorial-chip-button editorial-chip-button-primary"
            disabled
          >
            SEND ⌥↵
          </button>
        </div>
      </section>
    </article>
  );
}
