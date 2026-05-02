import { useMemo, useState } from 'react';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';

// ───────────────────────────────────────────────────────────────────────────
// Fixture-shaped data, hardcoded inline for the 0p-a vertical slice. Real
// loads come from rocketorchestra `point` page reads + clawrocket
// score_snapshots / discussion_sessions / point_note_blocks once those are
// wired up. This slice ships state `a` only (Notes-as-right-rail,
// Discussion-in-center). State `b` toggle, drag-reorder, Outline tab,
// counter-promotion, and add-note flow follow in separate PRs.
//
// NOTE on the note-type enum (contract gap #4): design/03_points_outline.md
// uses {claim, evidence, thought, question, counter, other}; the schema's
// PointNoteBlock.type uses {thought, claim, evidence, question, counterpoint}
// — `counterpoint` vs `counter`, and the schema is missing `other`. The UI
// follows the design (filter chips T/C/E/Q/!/O) because that's the
// user-facing contract. Reconciliation is the deferred doc-only PR.
// ───────────────────────────────────────────────────────────────────────────

type Persona = { slug: string; letter: string; name: string; role: string };

type ScoreCell = { persona: Persona; score: number; note: string };

type PointType = 'HOOK' | 'ARG' | 'CLOSE' | 'COUNTER';

type Point = {
  slug: string;
  position: string;
  type: PointType;
  score: number;
  claim: string;
  stake: string;
  noteCount: number;
};

type NoteType =
  | 'claim'
  | 'evidence'
  | 'thought'
  | 'question'
  | 'counter'
  | 'other';

type Note = {
  id: string;
  type: NoteType;
  timestamp: string;
  body: string;
  bodyExpanded?: string;
  promotable?: boolean;
  highlighted?: boolean;
};

type DiscussionTurn = {
  id: string;
  agent: Persona;
  timestamp: string;
  body: string;
  proposes: string | null;
};

type PointDetail = {
  slug: string;
  eyebrow: string;
  scoreRow: ScoreCell[];
  aggregate: { score: number; ssr: number; gatesPass: boolean };
  claim: string;
  stake: string;
  notes: Note[];
  discussion: DiscussionTurn[];
  lastTurnAt: string;
};

const PRIMARY_PERSONAS: ReadonlyArray<Persona> = [
  {
    slug: 'persona/ankit-indie-dev',
    letter: 'A',
    name: 'ANKIT',
    role: 'STRATEGIST',
  },
  {
    slug: 'persona/ravi-studio-lead',
    letter: 'R',
    name: 'RAVI',
    role: 'NARRATIVE',
  },
  {
    slug: 'persona/mei-publisher',
    letter: 'M',
    name: 'MEI',
    role: 'ANALYST',
  },
];

const TOPIC_TITLE =
  "How Embracer's $2.1B writedown changed indie publishing terms";

const POINT_COUNTS = { points: 5, counter: 1, rejected: 2 };

const POINTS: ReadonlyArray<Point> = [
  {
    slug: 'p1-deal-term-lockdown',
    position: '01',
    type: 'HOOK',
    score: 8.1,
    claim:
      'Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor.',
    stake: 'Hook — open with reclassification.',
    noteCount: 4,
  },
  {
    slug: 'p2-mg-conditional-liability',
    position: '02',
    type: 'ARG',
    score: 7.6,
    claim: 'MG-as-conditional-liability is the load-bearing accounting change.',
    stake: 'The accounting that holds the lockdown in place.',
    noteCount: 3,
  },
  {
    slug: 'p3-cohort-split',
    position: '03',
    type: 'ARG',
    score: 7.2,
    claim: 'Mid-tier studios pay; sub-10-person studios get a tailwind.',
    stake: 'Stakes paragraph — name the cohort split.',
    noteCount: 2,
  },
  {
    slug: 'p4-eighteen-month-lockin',
    position: '04',
    type: 'ARG',
    score: 6.8,
    claim: 'The 18-month lock-in is structural, not cyclical.',
    stake: 'Counter the cyclical read.',
    noteCount: 2,
  },
  {
    slug: 'p5-recoupment-creep',
    position: '05',
    type: 'CLOSE',
    score: 6.2,
    claim: 'Recoupment-rate creep is the next shoe to drop.',
    stake: 'Forward-looking close.',
    noteCount: 1,
  },
];

const COUNTER_POINTS: ReadonlyArray<Point> = [
  {
    slug: 'cp1-one-off',
    position: '06',
    type: 'COUNTER',
    score: 3.4,
    claim: "Embracer's writedown is a one-off; nothing structural changed.",
    stake: 'Steel-man the cyclical read.',
    noteCount: 0,
  },
];

const POINT_DETAILS: Record<string, PointDetail> = {
  'p1-deal-term-lockdown': {
    slug: 'p1-deal-term-lockdown',
    eyebrow: 'POINT 1 · HOOK · SCOPED TO → DEBATE ACTIVE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 8,
        note: 'lead-with material — strongest hook',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 8,
        note: 'Make the deal-shape concrete.',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 8,
        note: '8-K supports it cleanly. Cite pp.14-16.',
      },
    ],
    aggregate: { score: 8.1, ssr: 0.81, gatesPass: true },
    claim:
      'Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor.',
    stake: 'Hook — open with reclassification.',
    notes: [
      {
        id: 'n1',
        type: 'claim',
        timestamp: '11:32',
        body: 'MG itself is now reclassified as a conditional liability under the post-Embracer framework.',
        bodyExpanded:
          "MG itself is now reclassified as a conditional liability under the post-Embracer accounting framework. That's the structural change, not the writedown itself.",
      },
      {
        id: 'n2',
        type: 'evidence',
        timestamp: '11:38',
        body: 'Embracer Q3 8-K · pp.14-16: explicit reclassification language. Devolver Q4 prelim $5 echoes.',
        bodyExpanded:
          'Embracer Q3 8-K · pp.14-16: explicit reclassification language. Devolver Q4 prelim $5 echoes the change. Take-Two K-1 silent (different acct treatment).',
      },
      {
        id: 'n3',
        type: 'counter',
        timestamp: '11:41',
        body: 'Annapurna staffer (background): this is overstated — still signing pre-Embracer-shape deals.',
        bodyExpanded:
          "Annapurna staffer (background): this is overstated — they're still signing pre-Embracer-shape deals at unchanged MG ratios. The reclassification may not be universal.",
        promotable: true,
        highlighted: true,
      },
      {
        id: 'n4',
        type: 'question',
        timestamp: '11:43',
        body: 'Holds for sub-$200K MG deals, or only mid-tier where Embracer was active?',
        bodyExpanded:
          'Does this hold for sub-$200K MG deals, or only mid-tier where Embracer was active? Worth a sidebar to a small-studio publisher.',
      },
    ],
    discussion: [
      {
        id: 't1',
        agent: PRIMARY_PERSONAS[0],
        timestamp: '11:42',
        body: 'The reclassification is the right load-bearing hook. Make sure §1 names it explicitly — readers will skim the others.',
        proposes: 'OPEN WITH THE RECLASSIFICATION',
      },
      {
        id: 't2',
        agent: PRIMARY_PERSONAS[1],
        timestamp: '11:43',
        body: 'Pushing back: I want a person in this paragraph. The reclassification is correct but bloodless. The Annapurna note is the human edge — use it.',
        proposes: null,
      },
      {
        id: 't3',
        agent: PRIMARY_PERSONAS[2],
        timestamp: '11:45',
        body: "Devolver prelim $5 is ambiguous — I'd cite Embracer 8-K only and add Devolver as 'see also'.",
        proposes: 'DOWNGRADE DEVOLVER TO SEE-ALSO',
      },
      {
        id: 't4',
        agent: PRIMARY_PERSONAS[0],
        timestamp: '11:47',
        body: "Ravi's right that this needs a person. But promote that note as a Counter, not as the lead — the lead is the deal shape.",
        proposes: 'PROMOTE ANNAPURNA NOTE → COUNTER',
      },
    ],
    lastTurnAt: '11:47',
  },
  'p2-mg-conditional-liability': {
    slug: 'p2-mg-conditional-liability',
    eyebrow: 'POINT 2 · ARGUMENT · SCOPED TO → IDLE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 8,
        note: 'accounting framing is sharp',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 7,
        note: 'needs a one-line plain-english gloss',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 8,
        note: '8-K language matches your read',
      },
    ],
    aggregate: { score: 7.6, ssr: 0.74, gatesPass: true },
    claim: 'MG-as-conditional-liability is the load-bearing accounting change.',
    stake: 'The accounting that holds the lockdown in place.',
    notes: [
      {
        id: 'n1',
        type: 'evidence',
        timestamp: '10:51',
        body: 'FASB ASC 450 framing — conditional liability recognition tightens after Q3.',
      },
      {
        id: 'n2',
        type: 'thought',
        timestamp: '10:54',
        body: 'Plain-english version: publishers can no longer pretend MGs are pure expense.',
      },
      {
        id: 'n3',
        type: 'question',
        timestamp: '11:02',
        body: 'Do non-US publishers get a different treatment under IFRS 15?',
      },
    ],
    discussion: [
      {
        id: 't1',
        agent: PRIMARY_PERSONAS[2],
        timestamp: '11:05',
        body: 'Worth one paragraph on IFRS 15 vs ASC 450 — even if you cut it later, the structural read should be globally true or you flag it.',
        proposes: null,
      },
    ],
    lastTurnAt: '11:05',
  },
  'p3-cohort-split': {
    slug: 'p3-cohort-split',
    eyebrow: 'POINT 3 · ARGUMENT · SCOPED TO → IDLE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 7,
        note: 'cohort split is the stakes line',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 7,
        note: 'name the cohorts concretely',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 7,
        note: 'sub-10 tailwind is real but evidence is thin',
      },
    ],
    aggregate: { score: 7.2, ssr: 0.7, gatesPass: true },
    claim: 'Mid-tier studios pay; sub-10-person studios get a tailwind.',
    stake: 'Stakes paragraph — name the cohort split.',
    notes: [
      {
        id: 'n1',
        type: 'thought',
        timestamp: '09:48',
        body: 'Mid-tier = 11–60 person studios with one shipped title. They have the worst BATNA.',
      },
      {
        id: 'n2',
        type: 'question',
        timestamp: '09:53',
        body: 'What about the 60–200 band? They might be in either bucket depending on past hits.',
      },
    ],
    discussion: [],
    lastTurnAt: '—',
  },
  'p4-eighteen-month-lockin': {
    slug: 'p4-eighteen-month-lockin',
    eyebrow: 'POINT 4 · ARGUMENT · SCOPED TO → IDLE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 7,
        note: 'structural-not-cyclical is the contrarian lever',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 6,
        note: '18 months is precise — back it up',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 7,
        note: 'next-pub-cycle is roughly Q3 2027',
      },
    ],
    aggregate: { score: 6.8, ssr: 0.66, gatesPass: true },
    claim: 'The 18-month lock-in is structural, not cyclical.',
    stake: 'Counter the cyclical read.',
    notes: [
      {
        id: 'n1',
        type: 'thought',
        timestamp: '08:30',
        body: 'Structural = the accounting framework. Cyclical = funding climate. Conflating these is the common publisher pushback.',
      },
      {
        id: 'n2',
        type: 'evidence',
        timestamp: '08:42',
        body: 'Pub-cycle data: Embracer/Devolver/Take-Two earnings calls Q4 2025 → Q3 2027 next normalization window.',
      },
    ],
    discussion: [],
    lastTurnAt: '—',
  },
  'p5-recoupment-creep': {
    slug: 'p5-recoupment-creep',
    eyebrow: 'POINT 5 · CLOSE · SCOPED TO → IDLE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 7,
        note: 'forward-looking close — keep punchy',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 6,
        note: 'recoupment creep is jargon — define it',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 6,
        note: 'one paragraph max',
      },
    ],
    aggregate: { score: 6.2, ssr: 0.6, gatesPass: false },
    claim: 'Recoupment-rate creep is the next shoe to drop.',
    stake: 'Forward-looking close.',
    notes: [
      {
        id: 'n1',
        type: 'thought',
        timestamp: '07:14',
        body: 'Recoupment-rate creep: the % of revenue assigned to MG recovery before royalty splits kick in.',
      },
    ],
    discussion: [],
    lastTurnAt: '—',
  },
  'cp1-one-off': {
    slug: 'cp1-one-off',
    eyebrow: 'POINT 6 · COUNTER · SCOPED TO → IDLE',
    scoreRow: [
      {
        persona: PRIMARY_PERSONAS[0],
        score: 4,
        note: 'steel-man — but argue it down',
      },
      {
        persona: PRIMARY_PERSONAS[1],
        score: 3,
        note: 'this is the publisher pushback',
      },
      {
        persona: PRIMARY_PERSONAS[2],
        score: 3,
        note: 'falsifiable; you can address',
      },
    ],
    aggregate: { score: 3.4, ssr: 0.35, gatesPass: false },
    claim: "Embracer's writedown is a one-off; nothing structural changed.",
    stake: 'Steel-man the cyclical read.',
    notes: [],
    discussion: [],
    lastTurnAt: '—',
  },
};

// One-letter codes per design §6: T(thought) / C(claim) / E(evidence) /
// Q(question) / !(counter) / O(other).
const NOTE_TYPE_CODE: Record<NoteType, string> = {
  claim: 'C',
  evidence: 'E',
  thought: 'T',
  question: 'Q',
  counter: '!',
  other: 'O',
};

const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  claim: 'CLAIM',
  evidence: 'EVIDENCE',
  thought: 'THOUGHT',
  question: 'QUESTION',
  counter: 'COUNTER',
  other: 'OTHER',
};

// Order matches the design filter row: T C E Q ! O
const NOTE_FILTER_ORDER: ReadonlyArray<NoteType> = [
  'thought',
  'claim',
  'evidence',
  'question',
  'counter',
  'other',
];

const POINT_TYPE_LABEL: Record<PointType, string> = {
  HOOK: 'HOOK',
  ARG: 'ARGUMENT',
  CLOSE: 'CLOSE',
  COUNTER: 'COUNTER',
};

type Props = {
  onUnauthorized?: () => void;
};

export function PointsOutlineWorkspacePage(_props: Props) {
  // Default active = Point 01 to match the design's center-detail content.
  // (Design §1.1 left-rail draws "(active)" on Point 03 but §1.2 detail content
  // is Point 01 — the center detail wins because it carries the panel
  // discussion fixtures.)
  const [activePointSlug, setActivePointSlug] = useState<string>(
    'p1-deal-term-lockdown',
  );

  const allPoints = useMemo(() => [...POINTS, ...COUNTER_POINTS], []);
  const activePoint =
    allPoints.find((p) => p.slug === activePointSlug) ?? allPoints[0];
  const detail = POINT_DETAILS[activePoint.slug];

  return (
    <div className="editorial-room">
      <EditorialPhaseStrip activePhase="points-outline" />

      <div className="editorial-po-meta">
        <span className="editorial-po-meta-eyebrow">UNDER TOPIC:</span>
        <span className="editorial-po-meta-title">{TOPIC_TITLE}</span>
        <span className="editorial-po-meta-pip">
          {POINT_COUNTS.points} POINTS
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span className="editorial-po-meta-pip">
          {POINT_COUNTS.counter} COUNTER
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span className="editorial-po-meta-pip">
          {POINT_COUNTS.rejected} REJECTED
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span className="editorial-po-meta-hint">DRAG TO REORDER</span>
        <button type="button" className="editorial-po-meta-back" disabled>
          ← BACK
        </button>
      </div>

      <div className="editorial-po-grid">
        {/* LEFT RAIL — POINTS LIST */}
        <aside className="editorial-po-rail">
          <div className="editorial-po-rail-tabs">
            <button
              type="button"
              className="editorial-po-rail-tab editorial-po-rail-tab-active"
            >
              Points{' '}
              <span className="editorial-po-rail-tab-count">
                {allPoints.length}
              </span>
            </button>
            <button type="button" className="editorial-po-rail-tab" disabled>
              Outline <span className="editorial-po-rail-tab-count">5/5–7</span>
            </button>
            <button
              type="button"
              className="editorial-po-rail-tab editorial-po-rail-tab-action"
              disabled
            >
              + POINT
            </button>
            <button
              type="button"
              className="editorial-po-rail-tab editorial-po-rail-tab-action"
              disabled
            >
              OPT…
            </button>
          </div>

          <ul className="editorial-po-point-list">
            {POINTS.map((p) => (
              <li key={p.slug}>
                <button
                  type="button"
                  className={
                    'editorial-po-point-card' +
                    (p.slug === activePointSlug
                      ? ' editorial-po-point-card-active'
                      : '')
                  }
                  onClick={() => setActivePointSlug(p.slug)}
                >
                  <div className="editorial-po-point-row">
                    <span className="editorial-po-point-position">
                      {p.position}
                    </span>
                    <span
                      className={`editorial-po-point-type editorial-po-point-type-${p.type.toLowerCase()}`}
                    >
                      {POINT_TYPE_LABEL[p.type]}
                    </span>
                    <span className="editorial-po-point-score">
                      {p.score.toFixed(1)}
                    </span>
                  </div>
                  <p className="editorial-po-point-claim">{p.claim}</p>
                  <p className="editorial-po-point-stake">{p.stake}</p>
                  <span className="editorial-po-point-notes">
                    {p.noteCount} NOTES
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {COUNTER_POINTS.length > 0 ? (
            <>
              <h2 className="editorial-rail-heading editorial-rail-heading-spaced editorial-rail-heading-counter">
                COUNTER-POINTS · {COUNTER_POINTS.length}
              </h2>
              <ul className="editorial-po-point-list">
                {COUNTER_POINTS.map((p) => (
                  <li key={p.slug}>
                    <button
                      type="button"
                      className={
                        'editorial-po-point-card editorial-po-point-card-counter' +
                        (p.slug === activePointSlug
                          ? ' editorial-po-point-card-active'
                          : '')
                      }
                      onClick={() => setActivePointSlug(p.slug)}
                    >
                      <div className="editorial-po-point-row">
                        <span className="editorial-po-point-position">
                          {p.position}
                        </span>
                        <span
                          className={`editorial-po-point-type editorial-po-point-type-${p.type.toLowerCase()}`}
                        >
                          {POINT_TYPE_LABEL[p.type]}
                        </span>
                        <span className="editorial-po-point-score">
                          {p.score.toFixed(1)}
                        </span>
                      </div>
                      <p className="editorial-po-point-claim">{p.claim}</p>
                      {p.stake ? (
                        <p className="editorial-po-point-stake">{p.stake}</p>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        {/* CENTER — ACTIVE POINT DETAIL + PANEL DISCUSSION */}
        <main className="editorial-po-center">
          {detail ? <PointDetailView detail={detail} /> : null}
        </main>

        {/* RIGHT RAIL — NOTES (state `a`) */}
        <aside className="editorial-po-notes-rail">
          <NotesRail notes={detail?.notes ?? []} />
        </aside>
      </div>
    </div>
  );
}

function PointDetailView({ detail }: { detail: PointDetail }) {
  return (
    <article className="editorial-po-detail">
      <header className="editorial-po-detail-header">
        <span className="editorial-po-detail-eyebrow">{detail.eyebrow}</span>
      </header>

      <div className="editorial-tt-score-row">
        {detail.scoreRow.map((cell) => (
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
            {detail.aggregate.score.toFixed(1)}
          </div>
          <div className="editorial-tt-score-cell-note">
            SSR {detail.aggregate.ssr.toFixed(2)} ·{' '}
            {detail.aggregate.gatesPass ? '✓ GATES' : '✗ GATES'}
          </div>
        </div>
      </div>

      <section className="editorial-po-claim-stake">
        <h3 className="editorial-tt-section-label">CLAIM</h3>
        <p className="editorial-po-claim-body">{detail.claim}</p>
        <div className="editorial-po-stake-row">
          <span className="editorial-po-stake-label">STAKE</span>
          <p className="editorial-po-stake-body">{detail.stake}</p>
          <span className="editorial-po-notes-badge">
            {detail.notes.length} NOTES
          </span>
        </div>
      </section>

      <section className="editorial-po-discussion">
        <header className="editorial-po-discussion-header">
          <h3 className="editorial-tt-section-label">
            PANEL DISCUSSION · {detail.discussion.length} TURNS
          </h3>
          <div className="editorial-po-discussion-meta">
            <span className="editorial-po-discussion-last">
              LAST {detail.lastTurnAt}
            </span>
            <span className="editorial-po-discussion-mentions">
              {['@ALL', '@A', '@R', '@M'].map((m) => (
                <span key={m} className="editorial-po-discussion-mention">
                  {m}
                </span>
              ))}
            </span>
          </div>
        </header>

        {detail.discussion.length === 0 ? (
          <p className="editorial-tt-empty">
            No discussion yet — ask the panel.
          </p>
        ) : (
          <ol className="editorial-po-turn-list">
            {detail.discussion.map((t) => (
              <li key={t.id} className="editorial-po-turn">
                <div className="editorial-po-turn-head">
                  <span
                    className="editorial-persona-avatar editorial-persona-avatar-sm"
                    data-persona={t.agent.letter}
                  >
                    {t.agent.letter}
                  </span>
                  <span className="editorial-po-turn-name">{t.agent.name}</span>
                  <span className="editorial-po-turn-role">{t.agent.role}</span>
                  <span className="editorial-po-turn-timestamp">
                    {t.timestamp}
                  </span>
                </div>
                <p className="editorial-po-turn-body">{t.body}</p>
                {t.proposes ? (
                  <button
                    type="button"
                    className="editorial-po-turn-proposes"
                    disabled
                  >
                    + {t.proposes}
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}

        <div className="editorial-po-discussion-input">
          <input
            type="text"
            placeholder="Ask the panel — or @reference a note…"
            disabled
          />
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

function NotesRail({ notes }: { notes: ReadonlyArray<Note> }) {
  return (
    <>
      <div className="editorial-po-notes-rail-header">
        <h2 className="editorial-rail-heading">NOTES · {notes.length}</h2>
        <span className="editorial-po-notes-sort">↓ CHRONO</span>
      </div>

      <div className="editorial-po-notes-filter">
        {NOTE_FILTER_ORDER.map((nt) => (
          <button
            key={nt}
            type="button"
            className={`editorial-po-notes-filter-chip editorial-po-notes-filter-chip-${nt}`}
            disabled
            title={NOTE_TYPE_LABEL[nt]}
          >
            {NOTE_TYPE_CODE[nt]}
          </button>
        ))}
        <button
          type="button"
          className="editorial-po-notes-filter-chip editorial-po-notes-filter-chip-add"
          disabled
          aria-label="Add note"
        >
          +
        </button>
      </div>

      {notes.length === 0 ? (
        <p className="editorial-tt-empty">
          No notes yet — pick a type to start.
        </p>
      ) : (
        <ul className="editorial-po-note-list">
          {notes.map((n) => (
            <li
              key={n.id}
              className={
                `editorial-po-note-card editorial-po-note-card-${n.type}` +
                (n.highlighted ? ' editorial-po-note-card-highlighted' : '')
              }
            >
              <div className="editorial-po-note-head">
                <span
                  className={`editorial-po-note-code editorial-po-note-code-${n.type}`}
                >
                  {NOTE_TYPE_CODE[n.type]}
                </span>
                <span className="editorial-po-note-type">
                  {NOTE_TYPE_LABEL[n.type]}
                </span>
                {n.promotable ? (
                  <button
                    type="button"
                    className="editorial-po-note-promote"
                    disabled
                  >
                    PROMOTE ›
                  </button>
                ) : null}
                <span className="editorial-po-note-timestamp">
                  {n.timestamp}
                </span>
              </div>
              <p className="editorial-po-note-body">{n.body}</p>
            </li>
          ))}
        </ul>
      )}

      <button type="button" className="editorial-po-note-add" disabled>
        + NOTE · PICK TYPE ABOVE
      </button>
    </>
  );
}
