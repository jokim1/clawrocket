import { useEffect, useMemo, useState } from 'react';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';

// ───────────────────────────────────────────────────────────────────────────
// Fixture-shaped data, hardcoded inline for the 0p-a vertical slice. Real
// loads come from rocketorchestra `point` page reads + clawrocket
// score_snapshots / discussion_sessions / point_note_blocks once those are
// wired up. This slice ships state `a` only (Notes-as-right-rail,
// Discussion-in-center). State `b` toggle, drag-reorder, Outline tab,
// counter-promotion, and add-note flow follow in separate PRs.
//
// CLAIM and STAKE are inline-editable. Saving an edit (a) updates the field
// on the active Point, (b) appends a system "revision" turn to the panel
// discussion preserving the prior text, and (c) marks the Point's score
// snapshots stale (UI only — recompute is a follow-up PR). Maps to
// EDITORIAL_ROOM_CONTRACT.md §4.4 (DiscussionTurn.initiator: 'system' for
// revision turns), §4.5 (ProposalKind: 'edit_point'), and §4.2
// (ScoreSnapshot.is_stale via object_content_hash divergence).
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

// Discriminated union: agent turns are LLM panel responses; revision turns
// are system-generated history cards dropped in when the user edits a Point's
// CLAIM or STAKE. Maps to EDITORIAL_ROOM_CONTRACT.md §4.4 — revision turns
// would be `initiator: 'system'` with `initiated_action: 'edit_point'`.
type AgentTurn = {
  id: string;
  kind: 'agent';
  agent: Persona;
  timestamp: string;
  body: string;
  proposes: string | null;
};

type RevisionTurn = {
  id: string;
  kind: 'revision';
  timestamp: string;
  field: 'claim' | 'stake';
  previousText: string;
};

type DiscussionTurn = AgentTurn | RevisionTurn;

type PointDetail = {
  slug: string;
  eyebrow: string;
  scoreRow: ScoreCell[];
  aggregate: { score: number; ssr: number; gatesPass: boolean };
  claim: string;
  stake: string;
  notes: Note[];
  discussion: DiscussionTurn[];
};

type DetailState = {
  claim: string;
  stake: string;
  discussion: DiscussionTurn[];
  // Stale = current claim/stake hash differs from the hash that scoreRow /
  // aggregate were computed against. Cleared by RESCORE; in production this
  // would dispatch run_skill against the scoring_pipeline and append a fresh
  // score_snapshots row (per EDITORIAL_ROOM_CONTRACT.md §4.2).
  stale: boolean;
  scoreRow: ScoreCell[];
  aggregate: { score: number; ssr: number; gatesPass: boolean };
};

type EditField = 'claim' | 'stake';
type EditingTarget = { slug: string; field: EditField } | null;

// Layout state per design/03_points_outline.md §1: 'a' = Notes-as-right-rail
// + Discussion-in-center (default), 'b' = Notes-as-center + Discussion in a
// quiet bottom drawer. Toggled by the chevron control on the divider, by
// ⌘] / ⌘[, or by ⌘O (which always returns to state 'a' so the panel is
// fully visible when the user wants to talk to it).
type LayoutState = 'a' | 'b';

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
        kind: 'agent',
        agent: PRIMARY_PERSONAS[0],
        timestamp: '11:42',
        body: 'The reclassification is the right load-bearing hook. Make sure §1 names it explicitly — readers will skim the others.',
        proposes: 'OPEN WITH THE RECLASSIFICATION',
      },
      {
        id: 't2',
        kind: 'agent',
        agent: PRIMARY_PERSONAS[1],
        timestamp: '11:43',
        body: 'Pushing back: I want a person in this paragraph. The reclassification is correct but bloodless. The Annapurna note is the human edge — use it.',
        proposes: null,
      },
      {
        id: 't3',
        kind: 'agent',
        agent: PRIMARY_PERSONAS[2],
        timestamp: '11:45',
        body: "Devolver prelim $5 is ambiguous — I'd cite Embracer 8-K only and add Devolver as 'see also'.",
        proposes: 'DOWNGRADE DEVOLVER TO SEE-ALSO',
      },
      {
        id: 't4',
        kind: 'agent',
        agent: PRIMARY_PERSONAS[0],
        timestamp: '11:47',
        body: "Ravi's right that this needs a person. But promote that note as a Counter, not as the lead — the lead is the deal shape.",
        proposes: 'PROMOTE ANNAPURNA NOTE → COUNTER',
      },
    ],
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
        kind: 'agent',
        agent: PRIMARY_PERSONAS[2],
        timestamp: '11:05',
        body: 'Worth one paragraph on IFRS 15 vs ASC 450 — even if you cut it later, the structural read should be globally true or you flag it.',
        proposes: null,
      },
    ],
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

const REVISION_FIELD_LABEL: Record<EditField, string> = {
  claim: 'CLAIM',
  stake: 'STAKE',
};

function nowHHMM(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildInitialDetailStates(): Record<string, DetailState> {
  const out: Record<string, DetailState> = {};
  for (const [slug, d] of Object.entries(POINT_DETAILS)) {
    out[slug] = {
      claim: d.claim,
      stake: d.stake,
      discussion: [...d.discussion],
      stale: false,
      scoreRow: d.scoreRow.map((c) => ({ ...c })),
      aggregate: { ...d.aggregate },
    };
  }
  return out;
}

// Deterministic small drift on claim/stake content so RESCORE produces
// realistic, repeatable score changes in the fixture-only slice. Real
// rescore dispatches `run_skill` against the scoring_pipeline.
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function rescoreFromContent(state: DetailState): {
  scoreRow: ScoreCell[];
  aggregate: DetailState['aggregate'];
} {
  const seed = simpleHash(state.claim + '|' + state.stake);
  const scoreRow = state.scoreRow.map((cell, i) => {
    const delta = ((((seed * (i + 7)) >>> 3) % 11) - 5) / 10; // -0.5..+0.5
    const raw = cell.score + delta;
    const clamped = Math.max(0, Math.min(10, raw));
    return { ...cell, score: Math.round(clamped * 10) / 10 };
  });
  const mean = scoreRow.reduce((s, c) => s + c.score, 0) / scoreRow.length;
  const aggScore = Math.round(mean * 10) / 10;
  const ssrDelta = ((((seed * 13) >>> 5) % 11) - 5) / 100; // -0.05..+0.05
  const ssr = Math.max(0, Math.min(1, state.aggregate.ssr + ssrDelta));
  return {
    scoreRow,
    aggregate: {
      score: aggScore,
      ssr: Math.round(ssr * 100) / 100,
      gatesPass: aggScore >= 6.0,
    },
  };
}

const RESCORE_LATENCY_MS = 600;

// localStorage persistence for the per-Point editable+scored state.
// Bump the version suffix when DetailState gains required fields so older
// stored shapes get discarded instead of merged into a partial value.
const STORAGE_KEY = 'editorial-room.points-outline.detail-states-v0';

function isValidStoredState(s: unknown): s is DetailState {
  if (!s || typeof s !== 'object') return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o.claim === 'string' &&
    typeof o.stake === 'string' &&
    Array.isArray(o.discussion) &&
    typeof o.stale === 'boolean' &&
    Array.isArray(o.scoreRow) &&
    !!o.aggregate &&
    typeof o.aggregate === 'object'
  );
}

function loadDetailStates(): Record<string, DetailState> {
  const fresh = buildInitialDetailStates();
  if (typeof window === 'undefined') return fresh;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { schema_version?: unknown }).schema_version !== '0'
    ) {
      return fresh;
    }
    const states = (parsed as { states?: unknown }).states;
    if (!states || typeof states !== 'object') return fresh;
    const merged: Record<string, DetailState> = { ...fresh };
    for (const slug of Object.keys(fresh)) {
      const candidate = (states as Record<string, unknown>)[slug];
      if (isValidStoredState(candidate)) {
        merged[slug] = candidate;
      }
    }
    return merged;
  } catch {
    return fresh;
  }
}

function saveDetailStates(states: Record<string, DetailState>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ schema_version: '0', states }),
    );
  } catch {
    // Quota exceeded / private mode / disabled — degrade silently.
  }
}

const LAYOUT_STORAGE_KEY = 'editorial-room.points-outline.layout-state-v0';

function loadLayoutState(): LayoutState {
  if (typeof window === 'undefined') return 'a';
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw === 'b' ? 'b' : 'a';
  } catch {
    return 'a';
  }
}

function saveLayoutState(s: LayoutState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, s);
  } catch {
    // ignore
  }
}

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

  const [detailStates, setDetailStates] =
    useState<Record<string, DetailState>>(loadDetailStates);

  useEffect(() => {
    saveDetailStates(detailStates);
  }, [detailStates]);

  const [editing, setEditing] = useState<EditingTarget>(null);
  const [draft, setDraft] = useState<string>('');
  const [rescoringSlug, setRescoringSlug] = useState<string | null>(null);
  const [layoutState, setLayoutState] = useState<LayoutState>(loadLayoutState);

  useEffect(() => {
    saveLayoutState(layoutState);
  }, [layoutState]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      // Don't hijack shortcuts while the user is typing in CLAIM/STAKE
      // editor or any other text input.
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === ']') {
        e.preventDefault();
        setLayoutState('b');
      } else if (e.key === '[') {
        e.preventDefault();
        setLayoutState('a');
      } else if (e.key === 'o' || e.key === 'O') {
        // ⌘O always returns to state 'a' so the panel is fully visible.
        e.preventDefault();
        setLayoutState('a');
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function toggleLayout() {
    setLayoutState((s) => (s === 'a' ? 'b' : 'a'));
  }

  function selectPoint(slug: string) {
    if (editing && editing.slug !== slug) {
      // Switching Points cancels any in-flight edit on the prior Point.
      setEditing(null);
      setDraft('');
    }
    setActivePointSlug(slug);
  }

  const fixture = POINT_DETAILS[activePoint.slug];
  const state = detailStates[activePoint.slug];
  const detail: PointDetail | null =
    fixture && state
      ? {
          ...fixture,
          claim: state.claim,
          stake: state.stake,
          discussion: state.discussion,
          scoreRow: state.scoreRow,
          aggregate: state.aggregate,
        }
      : null;
  const stale = state?.stale ?? false;
  const rescoring = rescoringSlug === activePoint.slug;

  function rescorePoint(slug: string) {
    if (rescoringSlug) return;
    const cur = detailStates[slug];
    if (!cur || !cur.stale) return;
    setRescoringSlug(slug);
    setTimeout(() => {
      setDetailStates((prev) => {
        const s = prev[slug];
        if (!s) return prev;
        const next = rescoreFromContent(s);
        return {
          ...prev,
          [slug]: { ...s, stale: false, ...next },
        };
      });
      setRescoringSlug(null);
    }, RESCORE_LATENCY_MS);
  }

  function startEdit(field: EditField) {
    if (!detail) return;
    setDraft(field === 'claim' ? detail.claim : detail.stake);
    setEditing({ slug: activePoint.slug, field });
  }

  function cancelEdit() {
    setEditing(null);
    setDraft('');
  }

  function saveEdit() {
    if (!editing) return;
    const slug = editing.slug;
    const field = editing.field;
    const newText = draft.trim();
    if (!newText) {
      return;
    }
    setDetailStates((prev) => {
      const cur = prev[slug];
      if (!cur) return prev;
      const oldText = field === 'claim' ? cur.claim : cur.stake;
      if (oldText === newText) return prev;
      const revisionTurn: RevisionTurn = {
        id: `rev-${slug}-${Date.now()}`,
        kind: 'revision',
        timestamp: nowHHMM(),
        field,
        previousText: oldText,
      };
      return {
        ...prev,
        [slug]: {
          ...cur,
          [field]: newText,
          discussion: [...cur.discussion, revisionTurn],
          stale: true,
        },
      };
    });
    setEditing(null);
    setDraft('');
  }

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

      <div
        className={`editorial-po-grid editorial-po-grid-state-${layoutState}`}
      >
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
              <PointCard
                key={p.slug}
                point={p}
                state={detailStates[p.slug]}
                isActive={p.slug === activePointSlug}
                onSelect={() => selectPoint(p.slug)}
              />
            ))}
          </ul>

          {COUNTER_POINTS.length > 0 ? (
            <>
              <h2 className="editorial-rail-heading editorial-rail-heading-spaced editorial-rail-heading-counter">
                COUNTER-POINTS · {COUNTER_POINTS.length}
              </h2>
              <ul className="editorial-po-point-list">
                {COUNTER_POINTS.map((p) => (
                  <PointCard
                    key={p.slug}
                    point={p}
                    state={detailStates[p.slug]}
                    isActive={p.slug === activePointSlug}
                    isCounter
                    onSelect={() => selectPoint(p.slug)}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </aside>

        {/* CENTER — ACTIVE POINT DETAIL + PANEL DISCUSSION */}
        <main className="editorial-po-center">
          {detail ? (
            <PointDetailView
              detail={detail}
              stale={stale}
              rescoring={rescoring}
              editing={editing}
              draft={draft}
              setDraft={setDraft}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSaveEdit={saveEdit}
              onRescore={() => rescorePoint(activePoint.slug)}
              layoutState={layoutState}
              onToggleLayout={toggleLayout}
            />
          ) : null}
        </main>

        {/* RIGHT RAIL — NOTES (state `a` only; in state `b` notes move to center) */}
        {layoutState === 'a' ? (
          <aside className="editorial-po-notes-rail">
            <NotesRail notes={detail?.notes ?? []} />
          </aside>
        ) : null}
      </div>
    </div>
  );
}

function PointCard({
  point,
  state,
  isActive,
  isCounter,
  onSelect,
}: {
  point: Point;
  state: DetailState | undefined;
  isActive: boolean;
  isCounter?: boolean;
  onSelect: () => void;
}) {
  const claim = state?.claim ?? point.claim;
  const stake = state?.stake ?? point.stake;
  const cardStale = state?.stale ?? false;
  const className =
    'editorial-po-point-card' +
    (isCounter ? ' editorial-po-point-card-counter' : '') +
    (isActive ? ' editorial-po-point-card-active' : '') +
    (cardStale ? ' editorial-po-point-card-stale' : '');
  return (
    <li>
      <button type="button" className={className} onClick={onSelect}>
        <div className="editorial-po-point-row">
          <span className="editorial-po-point-position">{point.position}</span>
          <span
            className={`editorial-po-point-type editorial-po-point-type-${point.type.toLowerCase()}`}
          >
            {POINT_TYPE_LABEL[point.type]}
          </span>
          <span className="editorial-po-point-score">
            {(state?.aggregate.score ?? point.score).toFixed(1)}
          </span>
        </div>
        <p className="editorial-po-point-claim">{claim}</p>
        {stake ? <p className="editorial-po-point-stake">{stake}</p> : null}
        <span className="editorial-po-point-notes">
          {point.noteCount} NOTES
          {cardStale ? ' · STALE' : ''}
        </span>
      </button>
    </li>
  );
}

function PointDetailView({
  detail,
  stale,
  rescoring,
  editing,
  draft,
  setDraft,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onRescore,
  layoutState,
  onToggleLayout,
}: {
  detail: PointDetail;
  stale: boolean;
  rescoring: boolean;
  editing: EditingTarget;
  draft: string;
  setDraft: (v: string) => void;
  onStartEdit: (field: EditField) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onRescore: () => void;
  layoutState: LayoutState;
  onToggleLayout: () => void;
}) {
  const editingClaim =
    editing?.slug === detail.slug && editing.field === 'claim';
  const editingStake =
    editing?.slug === detail.slug && editing.field === 'stake';
  const lastTurnAt =
    detail.discussion.length > 0
      ? detail.discussion[detail.discussion.length - 1].timestamp
      : '—';
  const lastAgentTurn = [...detail.discussion]
    .reverse()
    .find((t): t is AgentTurn => t.kind === 'agent');

  return (
    <article className="editorial-po-detail">
      <header className="editorial-po-detail-header">
        <span className="editorial-po-detail-eyebrow">{detail.eyebrow}</span>
        <button
          type="button"
          className="editorial-po-layout-toggle"
          onClick={onToggleLayout}
          title={
            layoutState === 'a'
              ? 'Expand notes to center (⌘])'
              : 'Collapse notes to rail (⌘[)'
          }
        >
          {layoutState === 'a'
            ? '‹ EXPAND NOTES · ⌘]'
            : '› COLLAPSE TO RAIL · ⌘['}
        </button>
      </header>

      {stale || rescoring ? (
        <div
          className={
            'editorial-po-stale-banner' +
            (rescoring ? ' editorial-po-stale-banner-rescoring' : '')
          }
          role="status"
          aria-live="polite"
        >
          <span className="editorial-po-stale-icon" aria-hidden="true">
            {rescoring ? '⟳' : '⚠'}
          </span>
          <span className="editorial-po-stale-text">
            {rescoring
              ? 'RESCORING…'
              : 'STALE — claim or stake changed since last score'}
          </span>
          {!rescoring ? (
            <button
              type="button"
              className="editorial-po-stale-rescore"
              onClick={onRescore}
            >
              RESCORE →
            </button>
          ) : null}
        </div>
      ) : null}

      <div
        className={
          'editorial-tt-score-row' +
          (stale && !rescoring ? ' editorial-po-score-row-stale' : '') +
          (rescoring ? ' editorial-po-score-row-rescoring' : '')
        }
      >
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
        <header className="editorial-po-section-head">
          <h3 className="editorial-tt-section-label">CLAIM</h3>
          {!editingClaim ? (
            <button
              type="button"
              className="editorial-po-edit-trigger"
              onClick={() => onStartEdit('claim')}
            >
              ✎ EDIT
            </button>
          ) : null}
        </header>

        {editingClaim ? (
          <ClaimStakeEditor
            value={draft}
            onChange={setDraft}
            onSave={onSaveEdit}
            onCancel={onCancelEdit}
            multiline
            ariaLabel="Edit claim"
          />
        ) : (
          <p
            className="editorial-po-claim-body editorial-po-claim-body-clickable"
            role="button"
            tabIndex={0}
            onClick={() => onStartEdit('claim')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onStartEdit('claim');
              }
            }}
          >
            {detail.claim}
          </p>
        )}

        <div className="editorial-po-stake-row">
          <span className="editorial-po-stake-label">STAKE</span>
          {editingStake ? (
            <ClaimStakeEditor
              value={draft}
              onChange={setDraft}
              onSave={onSaveEdit}
              onCancel={onCancelEdit}
              multiline={false}
              ariaLabel="Edit stake"
            />
          ) : (
            <p
              className="editorial-po-stake-body editorial-po-stake-body-clickable"
              role="button"
              tabIndex={0}
              onClick={() => onStartEdit('stake')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onStartEdit('stake');
                }
              }}
            >
              {detail.stake}
            </p>
          )}
          <span className="editorial-po-notes-badge">
            {detail.notes.length} NOTES
          </span>
        </div>
      </section>

      {layoutState === 'a' ? (
        <section className="editorial-po-discussion">
          <header className="editorial-po-discussion-header">
            <h3 className="editorial-tt-section-label">
              PANEL DISCUSSION · {detail.discussion.length} TURNS
            </h3>
            <div className="editorial-po-discussion-meta">
              <span className="editorial-po-discussion-last">
                LAST {lastTurnAt}
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
              {detail.discussion.map((t) =>
                t.kind === 'agent' ? (
                  <AgentTurnView key={t.id} turn={t} />
                ) : (
                  <RevisionTurnView key={t.id} turn={t} />
                ),
              )}
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
      ) : (
        <>
          <section className="editorial-po-notes-center">
            <NotesRail notes={detail.notes} />
          </section>
          <DiscussionDrawer
            lastTurnAt={lastTurnAt}
            lastAgentSummary={lastAgentTurn?.body ?? null}
            onExpand={onToggleLayout}
          />
        </>
      )}
    </article>
  );
}

function DiscussionDrawer({
  lastTurnAt,
  lastAgentSummary,
  onExpand,
}: {
  lastTurnAt: string;
  lastAgentSummary: string | null;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      className="editorial-po-drawer"
      onClick={onExpand}
      aria-label="Expand panel discussion (⌘O)"
    >
      <span className="editorial-po-drawer-toggle" aria-hidden="true">
        ▼
      </span>
      <span className="editorial-po-drawer-status">
        PANEL DISCUSSION · last turn {lastTurnAt}
      </span>
      <span className="editorial-po-drawer-summary">
        {lastAgentSummary
          ? `“${lastAgentSummary}”`
          : 'No panel turns yet — open the panel to ask.'}
      </span>
      <span className="editorial-po-drawer-hint">⌘O</span>
    </button>
  );
}

function AgentTurnView({ turn }: { turn: AgentTurn }) {
  return (
    <li className="editorial-po-turn">
      <div className="editorial-po-turn-head">
        <span
          className="editorial-persona-avatar editorial-persona-avatar-sm"
          data-persona={turn.agent.letter}
        >
          {turn.agent.letter}
        </span>
        <span className="editorial-po-turn-name">{turn.agent.name}</span>
        <span className="editorial-po-turn-role">{turn.agent.role}</span>
        <span className="editorial-po-turn-timestamp">{turn.timestamp}</span>
      </div>
      <p className="editorial-po-turn-body">{turn.body}</p>
      {turn.proposes ? (
        <button type="button" className="editorial-po-turn-proposes" disabled>
          + {turn.proposes}
        </button>
      ) : null}
    </li>
  );
}

function RevisionTurnView({ turn }: { turn: RevisionTurn }) {
  return (
    <li className="editorial-po-turn editorial-po-revision-turn">
      <div className="editorial-po-revision-head">
        <span className="editorial-po-revision-icon" aria-hidden="true">
          ⟲
        </span>
        <span className="editorial-po-revision-label">
          REVISION · {REVISION_FIELD_LABEL[turn.field]} CHANGED
        </span>
        <span className="editorial-po-turn-timestamp">{turn.timestamp}</span>
      </div>
      <blockquote className="editorial-po-revision-prev">
        “{turn.previousText}”
      </blockquote>
    </li>
  );
}

function ClaimStakeEditor({
  value,
  onChange,
  onSave,
  onCancel,
  multiline,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  multiline: boolean;
  ariaLabel: string;
}) {
  return (
    <div
      className={
        'editorial-po-edit' +
        (multiline
          ? ' editorial-po-edit-multiline'
          : ' editorial-po-edit-inline')
      }
    >
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSave();
          }
        }}
        aria-label={ariaLabel}
        rows={multiline ? 3 : 1}
        className={
          multiline
            ? 'editorial-po-edit-textarea-multiline'
            : 'editorial-po-edit-textarea-inline'
        }
      />
      <div className="editorial-po-edit-actions">
        <button
          type="button"
          className="editorial-po-edit-save"
          onClick={onSave}
          disabled={!value.trim()}
        >
          SAVE ⌘↵
        </button>
        <button
          type="button"
          className="editorial-po-edit-cancel"
          onClick={onCancel}
        >
          CANCEL · ESC
        </button>
      </div>
    </div>
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
