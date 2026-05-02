import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  EditorContent,
  FloatingMenu,
  useEditor,
  type Content,
  type Editor,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import LinkExtension from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';
import {
  getAgentProfileById,
  type AgentProfile,
} from '../lib/editorial-fixtures';
import {
  DESTINATION_CAPABILITIES,
  DESTINATION_SHORT,
  loadDestination,
  loadSetupState,
  type Destination,
  type SetupState,
} from '../lib/editorial-setup';
import { isAgentAuthed, useProviderAuth } from '../lib/llm-provider-auth';
import { serializeDocToMarkdown, type JSONNode } from '../lib/markdown-export';
import { parseMarkdownToDoc } from '../lib/markdown-import';

// ───────────────────────────────────────────────────────────────────────────
// Phase 04 DRAFT — bubble toolbar + link/underline/align/highlight.
// Adds a floating bubble menu that appears on text selection (Notion /
// Substack pattern) with a heading-style dropdown, inline-mark toggles
// (B I U S code), link insert, list/blockquote toggles, alignment, and
// highlight. Tiptap JSON is the canonical representation, so all of
// these survive in the editor's saved state and through the Versions
// ledger. The Markdown export is a lossy serialization — underline,
// alignment, and highlight don't survive MD round-trip (no standard
// markdown for them); bold/italic/strike/code/link/lists/headings/
// blockquote do round-trip cleanly via the existing exporter.
//
// Earlier cuts in this page (most recent at bottom):
//   • PR #269: three-column shell + Tiptap editor + outline rail + word count
//   • PR #270: cursor-aware status bar + scope chip + outline jump-to-segment
//   • PR #271: Versions tab + ⌘S manual save + 60s autosave snapshots
//   • PR #272: ↑ COPY MD export (Tiptap-JSON → markdown serializer)
//   • PR #273: Sources tab — fixture-only cite tracker
//   • PR #274: + OPTIMIZE popover UI shell (RUN disabled at v0p)
//   • PR #275: sub-meta polish — eyebrow + SSR + GATES + ← BACK
//   • PR #276: Panel chat right rail — mock turns + composer
//   • PR #277: 0p-b1 Markdown round-trip parser + ↓ PASTE MD
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// Phase 04 DRAFT — Panel chat right rail (mock turns).
// Fills the right rail per design/04_draft.md §8: scoped panel discussion
// with turns from the personas the user already met in Points + Outline
// (Ankit / Ravi / Mei). v0p ships fixture-only turns scoped to each
// outline point — composer is disabled until LLM wiring lands. Continuity
// summary line at the top echoes the resolved Points-phase discussion so
// the user doesn't feel a discontinuity advancing into Draft.
//
// Earlier cuts in this page (most recent at bottom):
//   • PR #269: three-column shell + Tiptap editor + outline rail + word count
//   • PR #270: cursor-aware status bar + scope chip + outline jump-to-segment
//   • PR #271: Versions tab + ⌘S manual save + 60s autosave snapshots
//   • PR #272: ↑ COPY MD export (Tiptap-JSON → markdown serializer)
//   • PR #273: Sources tab — fixture-only cite tracker
//   • PR #274: + OPTIMIZE popover UI shell (RUN disabled at v0p)
//   • PR #275: sub-meta polish — eyebrow + SSR + GATES + ← BACK
//
// Still deferred (per design/04_draft.md):
// - Real panel turns from the editorial-scoped DiscussionSession
// - Composer wired to actually queue an LLM run (`+ ASK`)
// - Action chips (`+ JUMP TO §2`, `+ ADD A PERSON`) wired to real handlers
// - Quick-action chips wired (FULL DRAFT / POLISH / etc.)
// - + OPTIMIZE actually runs an optimization round (LLM wiring)
// - CUSTOMIZE: per-stage provider/threshold/anchor-bundle config
// - Voice-lock banner, mechanical scorer, suggestion overlay
// - Markdown round-trip + source-map (0p-b1 spike)
// - Compressed-diff snapshot storage
// - Real Sources data: currently fixture-only
// - Real outline title + real GATES thresholds from Setup
//
// NOTE on the Outline-rail data source: the Points workspace owns its
// state in its own localStorage envelope. To avoid threading a shared
// module, we read the same keys directly and reconstruct the section
// grouping inline. The fixture-only fallback for slugs without an
// explicit `pointType` override is hardcoded below — the same five
// fixture slugs as in PointsOutlineWorkspacePage.tsx. When the fixture
// grows or both pages move to a real backend, factor this into a shared
// module.
// ───────────────────────────────────────────────────────────────────────────

type PointType = 'HOOK' | 'ARG' | 'CLOSE' | 'COUNTER';

type OutlineSection = 'HOOK' | 'BODY' | 'CLOSE';

type OutlineEntry = {
  slug: string;
  type: 'HOOK' | 'ARG' | 'CLOSE';
  claim: string;
  stake: string;
  score: number;
  stale: boolean;
};

type OutlineGroups = Record<OutlineSection, OutlineEntry[]>;

type ParagraphRange = {
  start: number;
  end: number;
};

type CursorState = {
  activeParaIndex: number;
  totalParas: number;
  inHeading: boolean;
  hasSelection: boolean;
};

type Bucket = {
  start: number;
  end: number;
  count: number;
};

type VersionKind = 'named' | 'auto';

type VersionTrigger =
  | 'manual_save'
  | 'phase_entry'
  | 'autosave'
  | 'restore_from_snapshot';

type VersionEntry = {
  id: string;
  kind: VersionKind;
  trigger: VersionTrigger;
  timestamp: number;
  preview: string;
  body: unknown;
};

type RailTab = 'outline' | 'sources' | 'versions';

type SourceKind = 'filing' | 'article' | 'transcript' | 'page-ref' | 'social';

type SourceEntry = {
  id: string;
  index: number;
  kind: SourceKind;
  title: string;
  publication?: string;
  date?: string;
  citation: string;
  url?: string;
};

const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  filing: 'FILING',
  article: 'ARTICLE',
  transcript: 'TRANSCRIPT',
  'page-ref': 'PAGE',
  social: 'SOCIAL',
};

// Fixture sources matching the Embracer hero example. Replaced by
// `clawrocket.source_blocks filtered by Outline ancestry` once autoresearch
// is wired up.
const FIXTURE_SOURCES: ReadonlyArray<SourceEntry> = [
  {
    id: 's1',
    index: 1,
    kind: 'filing',
    title: 'Embracer Group AB · Form 8-K',
    publication: 'SEC EDGAR',
    date: '2025-08-14',
    citation: 'Item 2.06 (impairment), pp.14–16',
    url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001877787',
  },
  {
    id: 's2',
    index: 2,
    kind: 'article',
    title: "Embracer's $2.1B writedown reshapes indie publishing terms",
    publication: 'GamesIndustry.biz',
    date: '2025-08-15',
    citation: 'Hyland — 2025-08-15',
  },
  {
    id: 's3',
    index: 3,
    kind: 'transcript',
    title: 'Embracer Q2 FY26 earnings call',
    publication: 'Embracer Group',
    date: '2025-08-14',
    citation: 'CFO comments at 23:14',
  },
  {
    id: 's4',
    index: 4,
    kind: 'social',
    title: '@indiedev_ravi: "deal terms changed overnight"',
    publication: 'X / Twitter',
    date: '2025-09-02',
    citation: 'Personal communication',
  },
];

// ─── Panel chat fixtures (right rail) ───────────────────────────────────────

type PanelTurn = {
  id: string;
  scopePointIndex: number;
  personaInitial: string;
  personaName: string;
  personaRole: string;
  body: string;
  actionLabel?: string;
  timestamp: string;
  // Set on live turns produced by the `+ ASK` composer. Fixture turns
  // never set these. `streaming` true while the turn is mid-SSE-stream;
  // `errored` true when the dispatch failed.
  streaming?: boolean;
  errored?: boolean;
};

// localStorage key for persisted live panel turns. Indexed by activePoint
// so the user's history survives reloads and the right rail picks back up
// where they left off. Fixture turns are kept as a first-time-UX fallback —
// once a point has at least one live turn, fixtures are replaced.
const LIVE_PANEL_TURNS_STORAGE_KEY = 'editorial-room.draft.panel-turns-v0';

type LivePanelTurnMap = Record<string, PanelTurn[]>;

function loadLivePanelTurns(): LivePanelTurnMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(LIVE_PANEL_TURNS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as LivePanelTurnMap;
  } catch {
    return {};
  }
}

function persistLivePanelTurns(turns: LivePanelTurnMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      LIVE_PANEL_TURNS_STORAGE_KEY,
      JSON.stringify(turns),
    );
  } catch {
    // localStorage full / disabled — non-fatal at v0p.
  }
}

// Minimal client-side SSE record parser. Mirrors the server-side parser in
// editorial-llm-call.ts; the route emits {event: text_delta|completed|error,
// data: <json>} records terminated by blank lines.
type ClientSseEvent = { event?: string; data: string };

function parseClientSseRecord(raw: string): ClientSseEvent | null {
  const lines = raw.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const valueRaw = colon === -1 ? '' : line.slice(colon + 1);
    const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw;
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && !eventName) return null;
  return { event: eventName, data: dataLines.join('\n') };
}

const PANEL_TURNS: ReadonlyArray<PanelTurn> = [
  // Point 0 — HOOK
  {
    id: 't0a',
    scopePointIndex: 0,
    personaInitial: 'A',
    personaName: 'ANKIT',
    personaRole: 'STRATEGIST',
    body: 'the lede works. but §2 needs a person — Ravi called this in POINTS too.',
    actionLabel: '+ JUMP TO §2',
    timestamp: '11:54',
  },
  {
    id: 't0b',
    scopePointIndex: 0,
    personaInitial: 'R',
    personaName: 'RAVI',
    personaRole: 'NARRATIVE',
    body: 'the second paragraph is bloodless. who is signing? name them.',
    actionLabel: '+ ADD A PERSON',
    timestamp: '11:53',
  },
  {
    id: 't0c',
    scopePointIndex: 0,
    personaInitial: 'M',
    personaName: 'MEI',
    personaRole: 'ANALYST',
    body: "8-K cite is correct. ¶3 is where I'd put pp.14–16.",
    timestamp: '11:51',
  },
  // Point 1 — ARG (MG conditional liability)
  {
    id: 't1a',
    scopePointIndex: 1,
    personaInitial: 'M',
    personaName: 'MEI',
    personaRole: 'ANALYST',
    body: 'the accounting framing is solid. consider citing ASC 810 directly so the reader can verify.',
    timestamp: '11:48',
  },
  {
    id: 't1b',
    scopePointIndex: 1,
    personaInitial: 'A',
    personaName: 'ANKIT',
    personaRole: 'STRATEGIST',
    body: "this is the load-bearing paragraph. don't soften it — the reclassification IS the story.",
    timestamp: '11:46',
  },
  // Point 2 — ARG (cohort split)
  {
    id: 't2a',
    scopePointIndex: 2,
    personaInitial: 'R',
    personaName: 'RAVI',
    personaRole: 'NARRATIVE',
    body: 'the cohort split needs a name — pick someone who got squeezed and someone who got the tailwind.',
    actionLabel: '+ ADD A PERSON',
    timestamp: '11:42',
  },
  {
    id: 't2b',
    scopePointIndex: 2,
    personaInitial: 'M',
    personaName: 'MEI',
    personaRole: 'ANALYST',
    body: '10-person cutoff — empirical or arbitrary? cite a source if you have one, otherwise hedge.',
    timestamp: '11:40',
  },
  // Point 3 — ARG (18-month lock-in)
  {
    id: 't3a',
    scopePointIndex: 3,
    personaInitial: 'A',
    personaName: 'ANKIT',
    personaRole: 'STRATEGIST',
    body: 'this is your strongest counter-cyclical argument. lead the section with it.',
    timestamp: '11:35',
  },
  {
    id: 't3b',
    scopePointIndex: 3,
    personaInitial: 'R',
    personaName: 'RAVI',
    personaRole: 'NARRATIVE',
    body: 'tighten this — "structural, not cyclical" is the headline phrase. use it.',
    timestamp: '11:33',
  },
  // Point 4 — CLOSE (recoupment creep)
  {
    id: 't4a',
    scopePointIndex: 4,
    personaInitial: 'M',
    personaName: 'MEI',
    personaRole: 'ANALYST',
    body: 'you\'re forecasting here. say so explicitly: "next 6 months, watch for…" — readers value the framing.',
    timestamp: '11:28',
  },
  {
    id: 't4b',
    scopePointIndex: 4,
    personaInitial: 'A',
    personaName: 'ANKIT',
    personaRole: 'STRATEGIST',
    body: "good closer. don't pad it — end on the question.",
    timestamp: '11:25',
  },
];

const PANEL_PRIOR_PHASE_SUMMARIES: Record<number, string> = {
  0: 'Earlier in Points + Outline: panel debated 4 turns; resolved with "open with reclassification."',
  1: 'Earlier in Points + Outline: panel debated 3 turns; resolved with "MG-as-conditional-liability is the load-bearing thread."',
  2: 'Earlier in Points + Outline: panel debated 5 turns; resolved with "cohort split is real, not anecdotal."',
  3: 'Earlier in Points + Outline: panel debated 2 turns; resolved with "18-month lock-in is structural."',
  4: 'Earlier in Points + Outline: panel debated 3 turns; resolved with "recoupment creep is the next shoe."',
};

const SECTION_ORDER: ReadonlyArray<OutlineSection> = ['HOOK', 'BODY', 'CLOSE'];

const SECTION_LABEL: Record<OutlineSection, string> = {
  HOOK: 'HOOK',
  BODY: 'BODY',
  CLOSE: 'CLOSE',
};

const POINTS_DETAIL_STATES_KEY =
  'editorial-room.points-outline.detail-states-v1';
const POINTS_ORDER_KEY = 'editorial-room.points-outline.points-order-v0';
const DRAFT_CONTENT_KEY = 'editorial-room.draft.content-v0';
const DRAFT_VERSIONS_KEY = 'editorial-room.draft.versions-v0';

const AUTO_SNAPSHOT_INTERVAL_MS = 60_000;
const AUTO_VERSIONS_RETENTION = 20;

const TRIGGER_LABELS: Record<VersionTrigger, string> = {
  manual_save: 'MANUAL ⌘S',
  phase_entry: 'PHASE ENTRY',
  autosave: 'AUTOSAVE',
  restore_from_snapshot: 'PRE-RESTORE',
};

const FIXTURE_POINT_TYPES: Record<string, 'HOOK' | 'ARG' | 'CLOSE'> = {
  'p1-deal-term-lockdown': 'HOOK',
  'p2-mg-conditional-liability': 'ARG',
  'p3-cohort-split': 'ARG',
  'p4-eighteen-month-lockin': 'ARG',
  'p5-recoupment-creep': 'CLOSE',
};

const FIXTURE_POINT_DEFAULTS: Record<
  string,
  { claim: string; stake: string; score: number }
> = {
  'p1-deal-term-lockdown': {
    claim:
      'Deal-term lockdown: 2022-rate MGs are now the ceiling, not the floor.',
    stake: 'Hook — open with reclassification.',
    score: 8.1,
  },
  'p2-mg-conditional-liability': {
    claim: 'MG-as-conditional-liability is the load-bearing accounting change.',
    stake: 'The accounting that holds the lockdown in place.',
    score: 7.6,
  },
  'p3-cohort-split': {
    claim: 'Mid-tier studios pay; sub-10-person studios get a tailwind.',
    stake: 'Stakes paragraph — name the cohort split.',
    score: 7.2,
  },
  'p4-eighteen-month-lockin': {
    claim: 'The 18-month lock-in is structural, not cyclical.',
    stake: 'Counter the cyclical read.',
    score: 6.8,
  },
  'p5-recoupment-creep': {
    claim: 'Recoupment-rate creep is the next shoe to drop.',
    stake: 'Forward-looking close.',
    score: 6.2,
  },
};

const FIXTURE_SLUGS_IN_ORDER: ReadonlyArray<string> = [
  'p1-deal-term-lockdown',
  'p2-mg-conditional-liability',
  'p3-cohort-split',
  'p4-eighteen-month-lockin',
  'p5-recoupment-creep',
];

function pointTypeToSection(t: PointType): OutlineSection | null {
  if (t === 'HOOK') return 'HOOK';
  if (t === 'ARG') return 'BODY';
  if (t === 'CLOSE') return 'CLOSE';
  return null;
}

function loadOutlineGroups(): OutlineGroups {
  const groups: OutlineGroups = { HOOK: [], BODY: [], CLOSE: [] };
  if (typeof window === 'undefined') {
    for (const slug of FIXTURE_SLUGS_IN_ORDER) {
      const t = FIXTURE_POINT_TYPES[slug];
      const def = FIXTURE_POINT_DEFAULTS[slug];
      const sec = pointTypeToSection(t);
      if (sec) {
        groups[sec].push({
          slug,
          type: t,
          claim: def.claim,
          stake: def.stake,
          score: def.score,
          stale: false,
        });
      }
    }
    return groups;
  }
  let order: string[] = [];
  let states: Record<string, unknown> = {};
  try {
    const orderRaw = window.localStorage.getItem(POINTS_ORDER_KEY);
    if (orderRaw) {
      const parsed = JSON.parse(orderRaw);
      if (Array.isArray(parsed)) {
        order = parsed.filter((s): s is string => typeof s === 'string');
      }
    }
  } catch {
    // ignore
  }
  if (order.length === 0) {
    order = [...FIXTURE_SLUGS_IN_ORDER];
  }
  try {
    const statesRaw = window.localStorage.getItem(POINTS_DETAIL_STATES_KEY);
    if (statesRaw) {
      const parsed = JSON.parse(statesRaw);
      if (parsed && typeof parsed === 'object') {
        const obj = (parsed as { states?: unknown }).states;
        if (obj && typeof obj === 'object') {
          states = obj as Record<string, unknown>;
        }
      }
    }
  } catch {
    // ignore
  }
  for (const slug of order) {
    if (!FIXTURE_POINT_TYPES[slug]) continue;
    const stored = states[slug] as Record<string, unknown> | undefined;
    const inOutline =
      stored && typeof stored.inOutline === 'boolean' ? stored.inOutline : true;
    if (!inOutline) continue;
    const overrideType = stored?.pointType as PointType | undefined;
    const fixtureType = FIXTURE_POINT_TYPES[slug];
    const effective: PointType = overrideType ?? fixtureType;
    if (effective === 'COUNTER') continue;
    const sec = pointTypeToSection(effective);
    if (!sec) continue;
    const def = FIXTURE_POINT_DEFAULTS[slug];
    const claim = (stored?.claim as string | undefined) ?? def.claim;
    const stake = (stored?.stake as string | undefined) ?? def.stake;
    const aggregate = stored?.aggregate as { score?: unknown } | undefined;
    const score =
      typeof aggregate?.score === 'number' ? aggregate.score : def.score;
    const stale = stored && stored.stale === true ? true : false;
    groups[sec].push({
      slug,
      type: effective === 'ARG' ? 'ARG' : effective,
      claim,
      stake,
      score,
      stale,
    });
  }
  return groups;
}

const DEFAULT_DRAFT_CONTENT = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 1 },
      content: [
        {
          type: 'text',
          text: "How Embracer's $2.1B writedown changed indie publishing terms",
        },
      ],
    },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Start drafting from your Outline on the left. Markdown shortcuts work: ⌘B bold, ⌘I italic, ## heading, * bullet, ` code.',
        },
      ],
    },
  ],
};

function loadDraftContent(): Content {
  if (typeof window === 'undefined') return DEFAULT_DRAFT_CONTENT as Content;
  try {
    const raw = window.localStorage.getItem(DRAFT_CONTENT_KEY);
    if (!raw) return DEFAULT_DRAFT_CONTENT as Content;
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { type?: unknown }).type === 'doc'
    ) {
      return parsed as Content;
    }
    return DEFAULT_DRAFT_CONTENT as Content;
  } catch {
    return DEFAULT_DRAFT_CONTENT as Content;
  }
}

function saveDraftContent(content: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DRAFT_CONTENT_KEY, JSON.stringify(content));
  } catch {
    // ignore
  }
}

function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).filter(Boolean).length;
}

// ─── version + snapshot helpers ─────────────────────────────────────────────

function isValidVersion(v: unknown): v is VersionEntry {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.id !== 'string') return false;
  if (obj.kind !== 'named' && obj.kind !== 'auto') return false;
  if (
    obj.trigger !== 'manual_save' &&
    obj.trigger !== 'phase_entry' &&
    obj.trigger !== 'autosave' &&
    obj.trigger !== 'restore_from_snapshot'
  ) {
    return false;
  }
  if (typeof obj.timestamp !== 'number') return false;
  if (typeof obj.preview !== 'string') return false;
  if (obj.body === undefined) return false;
  return true;
}

function loadVersions(): VersionEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(DRAFT_VERSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidVersion);
  } catch {
    return [];
  }
}

function saveVersionsToStorage(versions: VersionEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DRAFT_VERSIONS_KEY, JSON.stringify(versions));
  } catch {
    // localStorage quota errors silently dropped at v0p
  }
}

function pruneAutoVersions(versions: VersionEntry[]): VersionEntry[] {
  const named = versions.filter((v) => v.kind === 'named');
  const auto = [...versions].filter((v) => v.kind === 'auto');
  // Keep the most recent N auto-snapshots.
  auto.sort((a, b) => b.timestamp - a.timestamp);
  const keepAuto = auto.slice(0, AUTO_VERSIONS_RETENTION);
  return [...named, ...keepAuto].sort((a, b) => a.timestamp - b.timestamp);
}

function makeVersionId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '(empty)';
  return collapsed.length > 80 ? `${collapsed.slice(0, 80)}…` : collapsed;
}

function createVersionEntry(
  editor: Editor,
  kind: VersionKind,
  trigger: VersionTrigger,
): VersionEntry {
  return {
    id: makeVersionId(),
    kind,
    trigger,
    timestamp: Date.now(),
    preview: buildPreview(editor.state.doc.textContent),
    body: editor.getJSON(),
  };
}

function latestVersion(versions: VersionEntry[]): VersionEntry | null {
  if (versions.length === 0) return null;
  let latest = versions[0];
  for (let i = 1; i < versions.length; i++) {
    if (versions[i].timestamp > latest.timestamp) latest = versions[i];
  }
  return latest;
}

function bodiesEqual(a: unknown, b: unknown): boolean {
  // Cheap structural compare via JSON. Fine for a v0p draft (~10KB).
  return JSON.stringify(a) === JSON.stringify(b);
}

function formatVersionDay(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'TODAY';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'YESTERDAY';
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ─── cursor + paragraph helpers ─────────────────────────────────────────────

function getDocParagraphs(editor: Editor): ParagraphRange[] {
  const result: ParagraphRange[] = [];
  editor.state.doc.content.forEach((node, offset) => {
    if (node.type.name === 'paragraph') {
      result.push({ start: offset, end: offset + node.nodeSize });
    }
  });
  return result;
}

function computeCursorState(editor: Editor): CursorState {
  const { state } = editor;
  const { from, to } = state.selection;
  const hasSelection = from !== to;
  const paragraphs = getDocParagraphs(editor);
  let activeParaIndex = -1;
  for (let i = 0; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (from >= p.start && from <= p.end) {
      activeParaIndex = i;
      break;
    }
  }
  let inHeading = false;
  state.doc.content.forEach((node, offset) => {
    if (
      node.type.name === 'heading' &&
      from >= offset &&
      from <= offset + node.nodeSize
    ) {
      inHeading = true;
    }
  });
  return {
    activeParaIndex,
    totalParas: paragraphs.length,
    inHeading,
    hasSelection,
  };
}

// Heuristic paragraph → Outline-Point binding: evenly distribute paragraphs
// across the ordered Outline list (HOOK → BODY → CLOSE), giving extra
// paragraphs to the earliest buckets when the divide isn't even. This is a
// stand-in until custom Tiptap node markers pin paragraphs to specific
// Points (deferred PR). For 12 paragraphs / 5 Points the heuristic happens
// to match the design's example allocation (3,3,2,2,2).
function distributeParagraphs(
  totalParas: number,
  pointCount: number,
): Bucket[] {
  if (pointCount === 0) return [];
  if (totalParas === 0) {
    return Array.from({ length: pointCount }, () => ({
      start: 0,
      end: 0,
      count: 0,
    }));
  }
  const base = Math.floor(totalParas / pointCount);
  const remainder = totalParas % pointCount;
  const buckets: Bucket[] = [];
  let cursor = 0;
  for (let i = 0; i < pointCount; i++) {
    const count = base + (i < remainder ? 1 : 0);
    buckets.push({ start: cursor, end: cursor + count, count });
    cursor += count;
  }
  return buckets;
}

function findActivePoint(activeParaIndex: number, buckets: Bucket[]): number {
  if (activeParaIndex < 0) return -1;
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b.count > 0 && activeParaIndex >= b.start && activeParaIndex < b.end) {
      return i;
    }
  }
  return -1;
}

// ─── bubble toolbar helpers ─────────────────────────────────────────────────

function getActiveStyle(editor: Editor): string {
  for (let level = 1; level <= 4; level++) {
    if (editor.isActive('heading', { level })) return `h${level}`;
  }
  return 'paragraph';
}

function applyStyle(editor: Editor, style: string): void {
  if (style === 'paragraph') {
    editor.chain().focus().setParagraph().run();
    return;
  }
  const m = /^h([1-6])$/.exec(style);
  if (!m) return;
  const level = parseInt(m[1], 10) as 1 | 2 | 3 | 4 | 5 | 6;
  editor.chain().focus().toggleHeading({ level }).run();
}

function getActiveAlign(editor: Editor): string {
  if (editor.isActive({ textAlign: 'center' })) return 'center';
  if (editor.isActive({ textAlign: 'right' })) return 'right';
  if (editor.isActive({ textAlign: 'justify' })) return 'justify';
  return 'left';
}

function promptLink(editor: Editor): void {
  const previous = editor.getAttributes('link').href as string | undefined;
  // window.prompt is intentional — a small inline popup is a follow-up
  // PR. The flow still works for v0p: paste-or-type URL, blank to remove.
  const url = window.prompt('Link URL', previous ?? '');
  if (url === null) return;
  if (url.trim() === '') {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor
    .chain()
    .focus()
    .extendMarkRange('link')
    .setLink({ href: url.trim() })
    .run();
}

function jumpToPointParagraph(
  editor: Editor,
  pointIndex: number,
  buckets: Bucket[],
): void {
  const bucket = buckets[pointIndex];
  if (!bucket) return;
  const paragraphs = getDocParagraphs(editor);
  if (bucket.count === 0 || bucket.start >= paragraphs.length) {
    const endPos = editor.state.doc.content.size;
    editor.chain().focus().setTextSelection(endPos).scrollIntoView().run();
    return;
  }
  const para = paragraphs[bucket.start];
  if (!para) return;
  // Position cursor inside the paragraph (offset + 1 enters the node).
  editor
    .chain()
    .focus()
    .setTextSelection(para.start + 1)
    .scrollIntoView()
    .run();
}

function scopeChipText(cursor: CursorState): string {
  if (cursor.hasSelection) return 'SELECTION';
  if (cursor.activeParaIndex >= 0) {
    return `PARAGRAPH ${cursor.activeParaIndex + 1}`;
  }
  return 'WHOLE DRAFT';
}

function activeStatusText(
  cursor: CursorState,
  orderedOutline: OutlineEntry[],
  activePoint: number,
): string {
  if (cursor.hasSelection) {
    return 'SELECTION · OPTIMIZE WILL TARGET HIGHLIGHTED TEXT';
  }
  if (cursor.activeParaIndex < 0) {
    if (cursor.inHeading) {
      return cursor.totalParas > 0
        ? `TITLE · ${cursor.totalParas} ¶ TOTAL`
        : 'TITLE · NO PARAGRAPHS YET';
    }
    return cursor.totalParas > 0
      ? `${cursor.totalParas} ¶ TOTAL · NO ACTIVE PARAGRAPH`
      : 'EMPTY DRAFT';
  }
  const base = `PARAGRAPH ${cursor.activeParaIndex + 1} OF ${cursor.totalParas}`;
  if (activePoint < 0 || !orderedOutline[activePoint]) {
    return base;
  }
  const point = orderedOutline[activePoint];
  const typeLabel = point.type === 'ARG' ? 'ARGUMENT' : point.type;
  return `${base} · POINT ${activePoint + 1} · ${typeLabel}`;
}

// ─── + OPTIMIZE popover content ─────────────────────────────────────────────

type OptimizeStageId = 'autoresearch' | 'autonovel' | 'panel_pass' | 'propose';

type OptimizeStage = {
  id: OptimizeStageId;
  label: string;
  description: string;
  active: boolean;
};

type OptimizeCostEstimate = {
  tokens: string;
  wall: string;
  dollars: string;
};

function optimizeScopeLabel(cursor: CursorState): string {
  if (cursor.hasSelection) return 'SELECTION';
  if (cursor.activeParaIndex >= 0) {
    return `PARAGRAPH ${cursor.activeParaIndex + 1}`;
  }
  return 'WHOLE DRAFT';
}

function optimizeDescription(cursor: CursorState): string {
  if (cursor.hasSelection) {
    return 'Optimize selection: 2–3 alternative phrasings of the highlighted text, panel-rate, return top.';
  }
  if (cursor.activeParaIndex >= 0) {
    return `Targeted optimize on ¶${cursor.activeParaIndex + 1}: 2–3 alternative phrasings, panel-rate, return top.`;
  }
  return 'Multi-pass: research supporting + counter angles, propose 2–3 alternatives, panel-rate, return top.';
}

// Stage activity per design §5.3:
//   AUTORESEARCH — skipped when scope is paragraph or short selection
//   AUTONOVEL    — always active
//   PANEL PASS   — always active for whole-draft / point; skippable for
//                  paragraph / selection
//   PROPOSE 2–3  — always active
function getOptimizeStages(cursor: CursorState): OptimizeStage[] {
  const isWholeDraft = !cursor.hasSelection && cursor.activeParaIndex < 0;
  return [
    {
      id: 'autoresearch',
      label: 'AUTORESEARCH',
      description: 'gather supporting + counter sources',
      active: isWholeDraft,
    },
    {
      id: 'autonovel',
      label: 'AUTONOVEL',
      description: 'draft 2–3 alternative versions',
      active: true,
    },
    {
      id: 'panel_pass',
      label: 'PANEL PASS',
      description: 'score with full panel + SSR',
      active: isWholeDraft,
    },
    {
      id: 'propose',
      label: 'PROPOSE 2–3',
      description: 'pick top by aggregate; show side-by-side',
      active: true,
    },
  ];
}

// Mock cost preview by scope. Real estimate uses scoring-pipeline metadata
// + per-stage multipliers from the optimization_cost_calibration ledger
// (design §10.1). Numbers below are rough order-of-magnitude defaults so the
// popover doesn't render blank.
function optimizeCostEstimate(cursor: CursorState): OptimizeCostEstimate {
  if (cursor.hasSelection) {
    return { tokens: '≈2K TOKENS', wall: '2S WALL', dollars: '≈$0.01' };
  }
  if (cursor.activeParaIndex >= 0) {
    return { tokens: '≈3K TOKENS', wall: '3S WALL', dollars: '≈$0.01' };
  }
  return { tokens: '≈28K TOKENS', wall: '12S WALL', dollars: '≈$0.08' };
}

// Fixture outline title for the Embracer working example. Will be replaced
// with `outline.compiled_truth.title` from the Points + Outline workspace
// once that field is plumbed through localStorage.
const FIXTURE_OUTLINE_TITLE =
  "How Embracer's $2.1B writedown changed indie publishing terms";

type GateStatus = 'pass' | 'warn' | 'unknown';

function computeSsrAggregate(orderedOutline: OutlineEntry[]): number | null {
  if (orderedOutline.length === 0) return null;
  const sum = orderedOutline.reduce((acc, p) => acc + p.score, 0);
  return sum / orderedOutline.length;
}

function computeGateStatus(
  orderedOutline: OutlineEntry[],
  ssr: number | null,
): GateStatus {
  if (ssr === null) return 'unknown';
  if (ssr < 6.0) return 'warn';
  if (orderedOutline.some((p) => p.score < 5.0)) return 'warn';
  return 'pass';
}

const WORD_TARGET_MIN = 1200;
const WORD_TARGET_MAX = 1400;

type Props = {
  onUnauthorized?: () => void;
};

export function DraftWorkspacePage(_props: Props) {
  // Outline data is read once on mount. Switching to Points and back
  // refreshes via a remount. Live updates are deferred.
  const [outlineGroups] = useState<OutlineGroups>(loadOutlineGroups);
  const [wordCount, setWordCount] = useState<number>(0);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [cursor, setCursor] = useState<CursorState>({
    activeParaIndex: -1,
    totalParas: 0,
    inHeading: false,
    hasSelection: false,
  });
  const [versions, setVersions] = useState<VersionEntry[]>(loadVersions);
  const [activeRailTab, setActiveRailTab] = useState<RailTab>('outline');
  const [showAutosaves, setShowAutosaves] = useState<boolean>(false);
  const [exportState, setExportState] = useState<'idle' | 'copied' | 'error'>(
    'idle',
  );
  const [importState, setImportState] = useState<'idle' | 'pasted' | 'error'>(
    'idle',
  );
  const [optimizeOpen, setOptimizeOpen] = useState<boolean>(false);
  const [destination, setDestination] = useState<Destination>(loadDestination);
  const [setup, setSetup] = useState<SetupState>(loadSetupState);
  // Provider auth state — drives the agent picker for `+ ASK`. Refetches on
  // mount; the composer's panel size reflects which providers are connected
  // right now, not what the user picked in Setup.
  const { authed: providerAuthed } = useProviderAuth();

  // Live panel turns produced by the `+ ASK` composer, keyed by activePoint.
  // Persisted to localStorage so they survive reloads. Fixture turns are
  // kept as a first-time-UX fallback when a given point has no live turns.
  const [livePanelTurns, setLivePanelTurns] =
    useState<LivePanelTurnMap>(loadLivePanelTurns);
  const [composerValue, setComposerValue] = useState<string>('');
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerSubmitting, setComposerSubmitting] = useState<boolean>(false);

  const saveTimerRef = useRef<number | null>(null);
  const exportResetTimerRef = useRef<number | null>(null);
  const importResetTimerRef = useRef<number | null>(null);
  const optimizeAnchorRef = useRef<HTMLDivElement | null>(null);
  // Bumped on every editor onUpdate. Compared against `lastSnapshotVersionRef`
  // by the auto-snapshot interval to skip no-op snapshots.
  const editorVersionRef = useRef<number>(0);
  const lastSnapshotVersionRef = useRef<number>(-1);
  const phaseEntryDoneRef = useRef<boolean>(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Highlight,
      LinkExtension.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      TextAlign.configure({
        types: ['heading', 'paragraph'],
        alignments: ['left', 'center', 'right', 'justify'],
        defaultAlignment: 'left',
      }),
    ],
    content: loadDraftContent(),
    onCreate: ({ editor }) => {
      setWordCount(countWords(editor.state.doc.textContent));
      setCursor(computeCursorState(editor));
    },
    onUpdate: ({ editor }) => {
      editorVersionRef.current += 1;
      setWordCount(countWords(editor.state.doc.textContent));
      setCursor(computeCursorState(editor));
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveDraftContent(editor.getJSON());
        setLastSavedAt(new Date());
        saveTimerRef.current = null;
      }, 500);
    },
    onSelectionUpdate: ({ editor }) => {
      setCursor(computeCursorState(editor));
    },
  });

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      if (exportResetTimerRef.current !== null) {
        window.clearTimeout(exportResetTimerRef.current);
      }
      if (importResetTimerRef.current !== null) {
        window.clearTimeout(importResetTimerRef.current);
      }
    };
  }, []);

  // Persist versions whenever they change.
  useEffect(() => {
    saveVersionsToStorage(versions);
  }, [versions]);

  // Phase-entry snapshot — fires once per page mount, but skip if the latest
  // existing snapshot already matches the current draft body (avoids the
  // "open page → close → reopen" duplicate-spam case).
  useEffect(() => {
    if (!editor || phaseEntryDoneRef.current) return;
    phaseEntryDoneRef.current = true;
    const currentBody = editor.getJSON();
    setVersions((prev) => {
      const last = latestVersion(prev);
      if (last && bodiesEqual(last.body, currentBody)) {
        return prev;
      }
      return pruneAutoVersions([
        ...prev,
        createVersionEntry(editor, 'named', 'phase_entry'),
      ]);
    });
    lastSnapshotVersionRef.current = editorVersionRef.current;
  }, [editor]);

  // Auto-snapshot on a 60s cadence, but only if the editor changed since the
  // last snapshot. Bounded retention via FIFO prune to AUTO_VERSIONS_RETENTION.
  useEffect(() => {
    if (!editor) return;
    const intervalId = window.setInterval(() => {
      if (editorVersionRef.current === lastSnapshotVersionRef.current) {
        return;
      }
      lastSnapshotVersionRef.current = editorVersionRef.current;
      setVersions((prev) =>
        pruneAutoVersions([
          ...prev,
          createVersionEntry(editor, 'auto', 'autosave'),
        ]),
      );
    }, AUTO_SNAPSHOT_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [editor]);

  // ⌘S / Ctrl+S → manual named snapshot. Always creates a snapshot — user
  // intent is explicit. The Versions tab pill count bumps to give the user
  // a quiet visual receipt; we don't auto-flip the rail tab.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 's' && e.key !== 'S') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      lastSnapshotVersionRef.current = editorVersionRef.current;
      setVersions((prev) =>
        pruneAutoVersions([
          ...prev,
          createVersionEntry(editor, 'named', 'manual_save'),
        ]),
      );
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor]);

  // ⌘O / Ctrl+O toggles the + OPTIMIZE popover. Esc closes it. Cmd+O is the
  // browser default for "open file" — we preventDefault to claim the key.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && optimizeOpen) {
        e.preventDefault();
        setOptimizeOpen(false);
        return;
      }
      if (
        (e.key === 'o' || e.key === 'O') &&
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        !e.altKey
      ) {
        e.preventDefault();
        setOptimizeOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [optimizeOpen]);

  // ⌘K / Ctrl+K → prompt for link URL on the current selection.
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'k' && e.key !== 'K') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey) return;
      e.preventDefault();
      promptLink(editor);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor]);

  // Click outside the popover closes it. Anchor-relative; we ignore clicks
  // inside the anchor wrapper (which contains both the button and popover).
  useEffect(() => {
    if (!optimizeOpen) return;
    const handler = (e: MouseEvent): void => {
      const anchor = optimizeAnchorRef.current;
      if (!anchor) return;
      if (e.target instanceof Node && anchor.contains(e.target)) return;
      setOptimizeOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [optimizeOpen]);

  // Refresh destination + setup when window regains focus or another tab
  // updates Setup. Cheap, and keeps the toolbar + composer's active-agent
  // pick in sync without polling.
  useEffect(() => {
    const refresh = (): void => {
      const next = loadSetupState();
      setSetup(next);
      setDestination(next.destination);
    };
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const capabilities = DESTINATION_CAPABILITIES[destination];

  const orderedOutline = useMemo<OutlineEntry[]>(
    () => [
      ...outlineGroups.HOOK,
      ...outlineGroups.BODY,
      ...outlineGroups.CLOSE,
    ],
    [outlineGroups],
  );

  const buckets = useMemo(
    () => distributeParagraphs(cursor.totalParas, orderedOutline.length),
    [cursor.totalParas, orderedOutline.length],
  );

  const activePoint = useMemo(
    () => findActivePoint(cursor.activeParaIndex, buckets),
    [cursor.activeParaIndex, buckets],
  );

  const totalOutlinePoints = orderedOutline.length;
  const ssrAggregate = useMemo(
    () => computeSsrAggregate(orderedOutline),
    [orderedOutline],
  );
  const gateStatus = useMemo(
    () => computeGateStatus(orderedOutline, ssrAggregate),
    [orderedOutline, ssrAggregate],
  );
  // Real turns replace fixtures once the user has used `+ ASK` for this
  // point — the picker is "what's been asked", not "what could be asked".
  // Fixtures stay as a first-time-UX fallback so the empty state is never
  // bare on a brand-new workspace.
  const scopedPanelTurns = useMemo<PanelTurn[]>(() => {
    if (activePoint < 0) return [];
    const live = livePanelTurns[String(activePoint)];
    if (live && live.length > 0) return live;
    return PANEL_TURNS.filter((t) => t.scopePointIndex === activePoint);
  }, [activePoint, livePanelTurns]);

  // Selected agent profiles — the full set the user picked in Setup → LLM
  // Room, including any whose provider has since lost auth (those still
  // show up in Setup as ⚠ AUTH MISSING). `panelAgents` is the subset we'll
  // actually fan `+ ASK` out to: connected providers only.
  const selectedAgents = useMemo<AgentProfile[]>(
    () =>
      setup.llm_room_agent_profile_ids
        .map((id) => getAgentProfileById(id))
        .filter((a): a is AgentProfile => a !== null),
    [setup.llm_room_agent_profile_ids],
  );
  const panelAgents = useMemo<AgentProfile[]>(
    () => selectedAgents.filter((a) => isAgentAuthed(a, providerAuthed)),
    [selectedAgents, providerAuthed],
  );
  const skippedAgentCount = selectedAgents.length - panelAgents.length;

  const scopeText = scopeChipText(cursor);
  const statusText = activeStatusText(cursor, orderedOutline, activePoint);

  const handleOutlineClick = (pointIndex: number): void => {
    if (!editor) return;
    jumpToPointParagraph(editor, pointIndex, buckets);
  };

  // ─── + ASK composer dispatch ──────────────────────────────────────────
  // Fans a single user message out to every authed panel agent in parallel.
  // Each agent gets its own placeholder turn that streams independently;
  // one agent's failure does not affect the others (matches the contract's
  // partial_provider_failures semantics in EDITORIAL_ROOM_CONTRACT.md §4.4).
  // Live turns are persisted under editorial-room.draft.panel-turns-v0
  // keyed by activePoint.
  // Clear all live panel turns for the active point. Fixtures reappear
  // afterward (they're the first-time-UX fallback). Per-point because the
  // whole-history nuke is rarely what the user wants — usually they're
  // clearing a single bad/errored point.
  const handleClearPanelHistory = (): void => {
    if (activePoint < 0) return;
    const pointKey = String(activePoint);
    setLivePanelTurns((prev) => {
      if (!prev[pointKey]) return prev;
      const next = { ...prev };
      delete next[pointKey];
      persistLivePanelTurns(next);
      return next;
    });
    setComposerError(null);
  };

  // True iff the active point has at least one live (non-fixture) turn.
  // The CLEAR chip in the panel header only renders when this is true.
  const hasLiveTurnsForActivePoint =
    activePoint >= 0 && (livePanelTurns[String(activePoint)]?.length ?? 0) > 0;

  const handleSubmitPanelTurn = async (): Promise<void> => {
    if (panelAgents.length === 0) return;
    if (activePoint < 0) return;
    if (composerSubmitting) return;
    const userMessage = composerValue.trim();
    if (!userMessage) return;

    setComposerSubmitting(true);
    setComposerError(null);

    // Build segment context once — same for every agent in the panel.
    const segmentContext = (() => {
      if (!editor) return '';
      const paragraphs = getDocParagraphs(editor);
      const bucket = buckets[activePoint];
      if (!bucket || bucket.count === 0) return '';
      const text: string[] = [];
      for (let i = bucket.start; i < bucket.end; i++) {
        const range = paragraphs[i];
        if (!range) continue;
        const node = editor.state.doc.nodeAt(range.start);
        if (node) text.push(node.textContent);
      }
      return text.join('\n\n');
    })();

    const pointKey = String(activePoint);
    const submittedAt = Date.now();
    const timestamp = new Date(submittedAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    type PlannedTurn = { agent: AgentProfile; turnId: string };
    const planned: PlannedTurn[] = panelAgents.map((agent, idx) => ({
      agent,
      turnId: `live-${submittedAt}-${idx}`,
    }));
    const placeholders: PanelTurn[] = planned.map(({ agent, turnId }) => ({
      id: turnId,
      scopePointIndex: activePoint,
      personaInitial: agent.monogram,
      personaName: agent.name.toUpperCase(),
      personaRole: agent.role.toUpperCase(),
      body: '',
      timestamp,
      streaming: true,
    }));

    setLivePanelTurns((prev) => {
      const existing = prev[pointKey] ?? [];
      return { ...prev, [pointKey]: [...placeholders, ...existing] };
    });
    setComposerValue('');

    const updateTurn = (turnId: string, patch: Partial<PanelTurn>): void => {
      setLivePanelTurns((prev) => {
        const arr = prev[pointKey] ?? [];
        return {
          ...prev,
          [pointKey]: arr.map((t) =>
            t.id === turnId ? { ...t, ...patch } : t,
          ),
        };
      });
    };

    const streamForAgent = async ({
      agent,
      turnId,
    }: PlannedTurn): Promise<void> => {
      try {
        const res = await fetch('/api/v1/editorial/panel-turn', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fixtureProvider: agent.provider,
            agentName: agent.name,
            agentRole: agent.role,
            userMessage,
            segmentContext,
            scopePointIndex: activePoint,
          }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
          );
        }
        if (!res.body) {
          throw new Error('Response had no stream body.');
        }

        const decoder = new TextDecoder('utf-8');
        const reader = res.body.getReader();
        let buffer = '';
        let accumulated = '';
        let streamErrorMessage: string | null = null;

        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = parseClientSseRecord(raw);
            if (!event) continue;

            if (event.event === 'text_delta') {
              try {
                const data = JSON.parse(event.data) as { text?: string };
                if (typeof data.text === 'string') {
                  accumulated += data.text;
                  updateTurn(turnId, { body: accumulated });
                }
              } catch {
                // ignore malformed SSE record
              }
            } else if (event.event === 'completed') {
              try {
                const data = JSON.parse(event.data) as { text?: string };
                if (typeof data.text === 'string' && data.text.length > 0) {
                  accumulated = data.text;
                }
              } catch {
                // ignore
              }
            } else if (event.event === 'error') {
              try {
                const data = JSON.parse(event.data) as { message?: string };
                streamErrorMessage = data.message ?? 'Panel turn errored.';
              } catch {
                streamErrorMessage = 'Panel turn errored.';
              }
            }
          }
        }

        if (streamErrorMessage) throw new Error(streamErrorMessage);
        // Drained-from-completed text wins over the accumulator so the
        // persisted turn matches the server's authoritative final value.
        updateTurn(turnId, { body: accumulated, streaming: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Panel turn failed.';
        updateTurn(turnId, {
          body: msg,
          streaming: false,
          errored: true,
        });
        throw err;
      }
    };

    const results = await Promise.allSettled(planned.map(streamForAgent));

    // Composer-level error fires only when EVERY agent failed. Per-agent
    // errors already render inside the failed agent's own turn.
    if (results.length > 0 && results.every((r) => r.status === 'rejected')) {
      const first = results[0] as PromiseRejectedResult;
      const msg =
        first.reason instanceof Error
          ? first.reason.message
          : 'Panel turn failed.';
      setComposerError(msg);
    }

    setComposerSubmitting(false);
    // Persist the final state regardless of per-agent outcomes so the user
    // sees what happened on reload.
    setLivePanelTurns((prev) => {
      persistLivePanelTurns(prev);
      return prev;
    });
  };

  const namedVersions = useMemo(
    () =>
      [...versions]
        .filter((v) => v.kind === 'named')
        .sort((a, b) => b.timestamp - a.timestamp),
    [versions],
  );
  const autoVersions = useMemo(
    () =>
      [...versions]
        .filter((v) => v.kind === 'auto')
        .sort((a, b) => b.timestamp - a.timestamp),
    [versions],
  );

  const handleExportMarkdown = async (): Promise<void> => {
    if (!editor) return;
    const finish = (state: 'copied' | 'error'): void => {
      setExportState(state);
      if (exportResetTimerRef.current !== null) {
        window.clearTimeout(exportResetTimerRef.current);
      }
      exportResetTimerRef.current = window.setTimeout(() => {
        setExportState('idle');
        exportResetTimerRef.current = null;
      }, 1500);
    };
    try {
      if (capabilities.exportFormat === 'html') {
        // Rich-text export for Google Doc — copy as text/html so paste
        // targets that understand HTML (Google Docs, Notion, etc.) preserve
        // marks/alignment/etc. Plain text fallback alongside.
        const html = editor.getHTML();
        const plain = editor.state.doc.textContent;
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof ClipboardItem !== 'undefined' &&
          typeof navigator.clipboard.write === 'function'
        ) {
          const item = new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' }),
          });
          await navigator.clipboard.write([item]);
          finish('copied');
          return;
        }
        // Fallback: copy raw HTML as plain text.
        if (
          typeof navigator !== 'undefined' &&
          navigator.clipboard &&
          typeof navigator.clipboard.writeText === 'function'
        ) {
          await navigator.clipboard.writeText(html);
          finish('copied');
          return;
        }
        finish('error');
        return;
      }

      // Markdown export for Substack / Plain Markdown / etc.
      const json = editor.getJSON() as JSONNode;
      const md = serializeDocToMarkdown(json);
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(md);
        finish('copied');
        return;
      }
      // Older-browser fallback: textarea + execCommand. Best-effort only.
      const textarea = document.createElement('textarea');
      textarea.value = md;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      finish(ok ? 'copied' : 'error');
    } catch {
      finish('error');
    }
  };

  const handleImportMarkdown = async (): Promise<void> => {
    if (!editor) return;
    const finish = (state: 'pasted' | 'error'): void => {
      setImportState(state);
      if (importResetTimerRef.current !== null) {
        window.clearTimeout(importResetTimerRef.current);
      }
      importResetTimerRef.current = window.setTimeout(() => {
        setImportState('idle');
        importResetTimerRef.current = null;
      }, 1500);
    };
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.clipboard ||
        typeof navigator.clipboard.readText !== 'function'
      ) {
        finish('error');
        return;
      }
      const md = await navigator.clipboard.readText();
      if (!md.trim()) {
        finish('error');
        return;
      }
      // Capture pre-import snapshot so the user can recover via Versions.
      const preImport = createVersionEntry(editor, 'named', 'manual_save');
      setVersions((prev) => pruneAutoVersions([...prev, preImport]));
      const parsed = parseMarkdownToDoc(md);
      editor.commands.setContent(parsed as Content);
      saveDraftContent(parsed);
      setLastSavedAt(new Date());
      lastSnapshotVersionRef.current = editorVersionRef.current;
      finish('pasted');
    } catch {
      finish('error');
    }
  };

  const handleRestoreVersion = (version: VersionEntry): void => {
    if (!editor) return;
    // Per design/04_draft.md §10.4: capture pre-restore state as a named
    // snapshot so the user can recover from a misclick. Then replace the
    // editor body with the picked snapshot.
    const preRestore = createVersionEntry(
      editor,
      'named',
      'restore_from_snapshot',
    );
    setVersions((prev) => pruneAutoVersions([...prev, preRestore]));
    // setContent isn't currently undoable through Tiptap's history, so the
    // pre-restore named snapshot above IS the user's recovery path.
    editor.commands.setContent(version.body as Content);
    // Push the per-edit content store too, so a subsequent reload picks up
    // the restored body.
    saveDraftContent(version.body);
    setLastSavedAt(new Date());
    lastSnapshotVersionRef.current = editorVersionRef.current;
  };

  const wordTargetStatus = (() => {
    if (wordCount < WORD_TARGET_MIN) return 'editorial-po-draft-words-under';
    if (wordCount > WORD_TARGET_MAX) return 'editorial-po-draft-words-over';
    return 'editorial-po-draft-words-on';
  })();

  return (
    <div className="editorial-room">
      <EditorialPhaseStrip activePhase="draft" />

      <div className="editorial-po-draft-meta editorial-po-draft-meta-eyebrow">
        <span className="editorial-po-draft-meta-eyebrow-label">
          UNDER OUTLINE:
        </span>
        <Link
          to="/editorial/points-outline"
          className="editorial-po-draft-meta-title"
        >
          {FIXTURE_OUTLINE_TITLE}
        </Link>
        <span className="editorial-po-meta-sep">·</span>
        <span>
          {totalOutlinePoints} {totalOutlinePoints === 1 ? 'POINT' : 'POINTS'}
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <Link
          to="/editorial/setup"
          className="editorial-po-draft-destination"
          title={`Destination: ${DESTINATION_CAPABILITIES[destination].exportButtonLabel.replace('↑ ', '')} export — change in Setup`}
        >
          → {DESTINATION_SHORT[destination]}
        </Link>
      </div>

      <div className="editorial-po-draft-meta">
        <span className={`editorial-po-draft-words ${wordTargetStatus}`}>
          {wordCount.toLocaleString()} / {WORD_TARGET_MIN.toLocaleString()}–
          {WORD_TARGET_MAX.toLocaleString()} WORDS
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span
          className={`editorial-po-draft-ssr${
            ssrAggregate === null ? ' editorial-po-draft-ssr-empty' : ''
          }`}
          title="Mean of outline-point scores (no scoring pipeline at v0p)"
        >
          {ssrAggregate === null ? '—.— SSR' : `${ssrAggregate.toFixed(1)} SSR`}
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span
          className={`editorial-po-draft-gates editorial-po-draft-gates-${gateStatus}`}
          title={
            gateStatus === 'pass'
              ? 'Heuristic gate: all outline scores ≥ 5.0 and SSR mean ≥ 6.0 (v0p heuristic)'
              : gateStatus === 'warn'
                ? 'Heuristic gate: SSR mean below 6.0 or a point below 5.0 (v0p heuristic)'
                : 'No outline points yet — gate status unknown'
          }
        >
          {gateStatus === 'pass'
            ? '✓ GATES'
            : gateStatus === 'warn'
              ? '⚠ GATES'
              : '— GATES'}
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span className="editorial-po-draft-autosave">
          {lastSavedAt
            ? `LAST AUTOSAVE ${formatHHMM(lastSavedAt)}`
            : 'NO CHANGES SINCE LOAD'}
        </span>
        <button
          type="button"
          className={`editorial-po-draft-export${
            exportState === 'copied' ? ' editorial-po-draft-export-copied' : ''
          }${
            exportState === 'error' ? ' editorial-po-draft-export-error' : ''
          }`}
          onClick={() => {
            void handleExportMarkdown();
          }}
          disabled={!editor}
          aria-live="polite"
          title="Copy the draft as Substack-ready markdown"
        >
          {exportState === 'copied' && capabilities.exportSuccessLabel}
          {exportState === 'error' && 'COPY FAILED'}
          {exportState === 'idle' && capabilities.exportButtonLabel}
        </button>
        {capabilities.showPasteMarkdown ? (
          <button
            type="button"
            className={`editorial-po-draft-import${
              importState === 'pasted'
                ? ' editorial-po-draft-import-pasted'
                : ''
            }${
              importState === 'error' ? ' editorial-po-draft-import-error' : ''
            }`}
            onClick={() => {
              void handleImportMarkdown();
            }}
            disabled={!editor}
            aria-live="polite"
            title="Replace the draft with markdown from your clipboard (a pre-paste snapshot is captured to Versions)"
          >
            {importState === 'pasted' && 'PASTED ✓'}
            {importState === 'error' && 'PASTE FAILED'}
            {importState === 'idle' && '↓ PASTE MD'}
          </button>
        ) : null}
        <Link
          to="/editorial/points-outline"
          className="editorial-po-draft-back"
          title="Back to Points + Outline"
        >
          ← BACK
        </Link>
      </div>

      <div className="editorial-po-draft-toolbar">
        <button type="button" className="editorial-chip-button" disabled>
          FULL DRAFT ⌘D
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          POLISH ⌘P
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          EXPAND ⌘E
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          → CONTINUE ⌘\
        </button>
        <button type="button" className="editorial-chip-button" disabled>
          ? MISSING ⌘M
        </button>
        <span className="editorial-po-draft-toolbar-sep">┃</span>
        <div
          ref={optimizeAnchorRef}
          className="editorial-po-draft-optimize-anchor"
        >
          <button
            type="button"
            className="editorial-chip-button editorial-chip-button-primary"
            onClick={() => setOptimizeOpen((open) => !open)}
            aria-haspopup="dialog"
            aria-expanded={optimizeOpen}
            disabled={!editor}
          >
            + OPTIMIZE ⌘O
          </button>
          {optimizeOpen ? (
            <div
              className="editorial-po-draft-optimize-popover"
              role="dialog"
              aria-label="Optimize draft"
            >
              <header className="editorial-po-draft-optimize-header">
                <span className="editorial-po-draft-optimize-title">
                  OPTIMIZE
                </span>
                <span className="editorial-po-draft-optimize-scope">
                  · scope: {optimizeScopeLabel(cursor)}
                </span>
                <button
                  type="button"
                  className="editorial-po-draft-optimize-close"
                  onClick={() => setOptimizeOpen(false)}
                  aria-label="Close popover"
                >
                  ✕
                </button>
              </header>
              <p className="editorial-po-draft-optimize-description">
                {optimizeDescription(cursor)}
              </p>
              <section className="editorial-po-draft-optimize-stages">
                <h4 className="editorial-po-draft-optimize-section-title">
                  STAGES
                </h4>
                <ul className="editorial-po-draft-optimize-stage-list">
                  {getOptimizeStages(cursor).map((stage) => (
                    <li
                      key={stage.id}
                      className={`editorial-po-draft-optimize-stage${
                        stage.active
                          ? ''
                          : ' editorial-po-draft-optimize-stage-inactive'
                      }`}
                    >
                      <span
                        className="editorial-po-draft-optimize-stage-mark"
                        aria-hidden="true"
                      >
                        {stage.active ? '✓' : '◌'}
                      </span>
                      <span className="editorial-po-draft-optimize-stage-label">
                        {stage.label}
                      </span>
                      <span className="editorial-po-draft-optimize-stage-desc">
                        {stage.description}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="editorial-po-draft-optimize-cost">
                <h4 className="editorial-po-draft-optimize-section-title">
                  COST PREVIEW
                </h4>
                <p className="editorial-po-draft-optimize-cost-line">
                  {(() => {
                    const c = optimizeCostEstimate(cursor);
                    return `${c.tokens} · ${c.wall} · ${c.dollars}`;
                  })()}
                </p>
                <p className="editorial-po-draft-optimize-cost-note">
                  Estimates only — real numbers replace these once the
                  scoring-pipeline metadata is wired up.
                </p>
              </section>
              <footer className="editorial-po-draft-optimize-footer">
                <button
                  type="button"
                  className="editorial-po-draft-optimize-customize"
                  disabled
                  title="Per-stage provider/threshold config — coming soon"
                >
                  CUSTOMIZE
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-optimize-run"
                  disabled
                  title="LLM provider not yet wired into Draft at v0p"
                >
                  RUN ⌥↵
                </button>
              </footer>
            </div>
          ) : null}
        </div>
        <span className="editorial-po-draft-scope">SCOPE: {scopeText}</span>
      </div>

      <div className="editorial-po-draft-grid">
        {/* LEFT RAIL — OUTLINE */}
        <aside className="editorial-po-draft-rail">
          <div className="editorial-po-rail-tabs">
            <button
              type="button"
              className={`editorial-po-rail-tab${
                activeRailTab === 'outline'
                  ? ' editorial-po-rail-tab-active'
                  : ''
              }`}
              onClick={() => setActiveRailTab('outline')}
            >
              Outline{' '}
              <span className="editorial-po-rail-tab-count">
                {totalOutlinePoints}/5–7
              </span>
            </button>
            <button
              type="button"
              className={`editorial-po-rail-tab${
                activeRailTab === 'sources'
                  ? ' editorial-po-rail-tab-active'
                  : ''
              }`}
              onClick={() => setActiveRailTab('sources')}
            >
              Sources{' '}
              <span className="editorial-po-rail-tab-count">
                {FIXTURE_SOURCES.length}
              </span>
            </button>
            <button
              type="button"
              className={`editorial-po-rail-tab${
                activeRailTab === 'versions'
                  ? ' editorial-po-rail-tab-active'
                  : ''
              }`}
              onClick={() => setActiveRailTab('versions')}
            >
              Versions{' '}
              <span className="editorial-po-rail-tab-count">
                {namedVersions.length}
              </span>
            </button>
          </div>

          {activeRailTab === 'outline' &&
            (totalOutlinePoints === 0 ? (
              <p className="editorial-tt-empty">
                No Points in the Outline yet. Visit{' '}
                <a href="/editorial/points-outline">03 POINTS + OUTLINE</a> to
                add some.
              </p>
            ) : (
              (() => {
                let runningPos = 0;
                return SECTION_ORDER.map((section) => {
                  const points = outlineGroups[section];
                  const startPos = runningPos;
                  runningPos += points.length;
                  if (points.length === 0) return null;
                  return (
                    <section
                      key={section}
                      className="editorial-po-draft-section"
                    >
                      <h3 className="editorial-po-outline-section-header">
                        <span className="editorial-po-outline-section-label">
                          {SECTION_LABEL[section]}
                        </span>
                        <span className="editorial-po-outline-section-count">
                          {points.length}
                        </span>
                      </h3>
                      <ul className="editorial-po-draft-outline-list">
                        {points.map((p, idx) => {
                          const orderIndex = startPos + idx;
                          const isActive = orderIndex === activePoint;
                          const paraCount = buckets[orderIndex]?.count ?? 0;
                          return (
                            <li
                              key={p.slug}
                              className={`editorial-po-draft-outline-item${
                                isActive
                                  ? ' editorial-po-draft-outline-item-active'
                                  : ''
                              }`}
                            >
                              <button
                                type="button"
                                className="editorial-po-draft-outline-button"
                                onClick={() => handleOutlineClick(orderIndex)}
                                aria-pressed={isActive}
                              >
                                <div className="editorial-po-draft-outline-row">
                                  <span
                                    className="editorial-po-draft-outline-indicator"
                                    aria-hidden="true"
                                  >
                                    {isActive ? '◉' : '◌'}
                                  </span>
                                  <span className="editorial-po-point-position">
                                    {String(orderIndex + 1).padStart(2, '0')}
                                  </span>
                                  <span
                                    className={`editorial-po-point-type editorial-po-point-type-${p.type.toLowerCase()}`}
                                  >
                                    {p.type === 'ARG' ? 'ARGUMENT' : p.type}
                                  </span>
                                  <span className="editorial-po-point-score">
                                    {p.score.toFixed(1)}
                                    {p.stale ? '·' : ''}
                                  </span>
                                  <span className="editorial-po-draft-outline-paracount">
                                    {paraCount} ¶
                                  </span>
                                </div>
                                <p className="editorial-po-draft-outline-claim">
                                  {p.claim}
                                </p>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  );
                });
              })()
            ))}
          {activeRailTab === 'sources' && (
            <div className="editorial-po-draft-sources-list">
              {FIXTURE_SOURCES.map((s) => (
                <article key={s.id} className="editorial-po-draft-source-item">
                  <header className="editorial-po-draft-source-header">
                    <span className="editorial-po-draft-source-index">
                      [{s.index}]
                    </span>
                    <span
                      className={`editorial-po-draft-source-kind editorial-po-draft-source-kind-${s.kind}`}
                    >
                      {SOURCE_KIND_LABELS[s.kind]}
                    </span>
                    {s.date ? (
                      <span className="editorial-po-draft-source-date">
                        {s.date}
                      </span>
                    ) : null}
                  </header>
                  <h4 className="editorial-po-draft-source-title">{s.title}</h4>
                  <p className="editorial-po-draft-source-citation">
                    {s.publication ? (
                      <span className="editorial-po-draft-source-publication">
                        {s.publication}
                      </span>
                    ) : null}
                    {s.publication ? ' · ' : null}
                    {s.citation}
                  </p>
                  {s.url ? (
                    <a
                      className="editorial-po-draft-source-url"
                      href={s.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      OPEN ↗
                    </a>
                  ) : null}
                </article>
              ))}
              <p className="editorial-po-draft-source-note">
                Fixture sources for v0p. Real source_blocks land with the
                autoresearch wiring.
              </p>
            </div>
          )}
          {activeRailTab === 'versions' && (
            <div className="editorial-po-draft-versions-list">
              {namedVersions.length === 0 && autoVersions.length === 0 ? (
                <p className="editorial-tt-empty">
                  No saved versions yet. Press ⌘S to save a named snapshot.
                  Auto-snapshots fire every 60 seconds while editing.
                </p>
              ) : (
                <>
                  {namedVersions.map((v) => (
                    <article
                      key={v.id}
                      className="editorial-po-draft-version-item editorial-po-draft-version-item-named"
                    >
                      <header className="editorial-po-draft-version-header">
                        <span className="editorial-po-draft-version-time">
                          {formatVersionDay(v.timestamp)}{' '}
                          {formatHHMM(new Date(v.timestamp))}
                        </span>
                        <span className="editorial-po-draft-version-trigger">
                          {TRIGGER_LABELS[v.trigger]}
                        </span>
                      </header>
                      <p className="editorial-po-draft-version-preview">
                        {v.preview}
                      </p>
                      <button
                        type="button"
                        className="editorial-po-draft-version-restore"
                        onClick={() => handleRestoreVersion(v)}
                      >
                        RESTORE →
                      </button>
                    </article>
                  ))}
                  {autoVersions.length > 0 && (
                    <button
                      type="button"
                      className="editorial-po-draft-versions-toggle"
                      onClick={() => setShowAutosaves((s) => !s)}
                    >
                      {showAutosaves ? '▾ HIDE' : '▸ SHOW'}{' '}
                      {autoVersions.length} AUTOSAVE
                      {autoVersions.length === 1 ? '' : 'S'}
                    </button>
                  )}
                  {showAutosaves &&
                    autoVersions.map((v) => (
                      <article
                        key={v.id}
                        className="editorial-po-draft-version-item editorial-po-draft-version-item-auto"
                      >
                        <header className="editorial-po-draft-version-header">
                          <span className="editorial-po-draft-version-time">
                            {formatVersionDay(v.timestamp)}{' '}
                            {formatHHMM(new Date(v.timestamp))}
                          </span>
                          <span className="editorial-po-draft-version-trigger">
                            {TRIGGER_LABELS[v.trigger]}
                          </span>
                        </header>
                        <p className="editorial-po-draft-version-preview">
                          {v.preview}
                        </p>
                        <button
                          type="button"
                          className="editorial-po-draft-version-restore"
                          onClick={() => handleRestoreVersion(v)}
                        >
                          RESTORE →
                        </button>
                      </article>
                    ))}
                </>
              )}
            </div>
          )}
        </aside>

        {/* CENTER — TIPTAP EDITOR */}
        <main className="editorial-po-draft-center">
          <div className="editorial-po-draft-header">
            <div className="editorial-po-draft-status-bar">{statusText}</div>
            {editor ? (
              <div className="editorial-po-draft-format-toolbar">
                <select
                  className="editorial-po-draft-toolbar-style"
                  value={getActiveStyle(editor)}
                  onChange={(e) => applyStyle(editor, e.target.value)}
                  aria-label="Text style"
                >
                  <option value="paragraph">Normal</option>
                  <option value="h1">Heading 1</option>
                  <option value="h2">Heading 2</option>
                  <option value="h3">Heading 3</option>
                  <option value="h4">Heading 4</option>
                </select>
                <span className="editorial-po-draft-toolbar-divider" />
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('bold')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  title="Bold (⌘B)"
                  aria-label="Bold"
                >
                  <strong>B</strong>
                </button>
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('italic')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() => editor.chain().focus().toggleItalic().run()}
                  title="Italic (⌘I)"
                  aria-label="Italic"
                >
                  <em>I</em>
                </button>
                {capabilities.underline ? (
                  <button
                    type="button"
                    className={`editorial-po-draft-toolbar-btn${
                      editor.isActive('underline')
                        ? ' editorial-po-draft-toolbar-btn-active'
                        : ''
                    }`}
                    onClick={() =>
                      editor.chain().focus().toggleUnderline().run()
                    }
                    title="Underline (⌘U)"
                    aria-label="Underline"
                  >
                    <u>U</u>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('strike')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                  title="Strikethrough"
                  aria-label="Strikethrough"
                >
                  <s>S</s>
                </button>
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('code')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() => editor.chain().focus().toggleCode().run()}
                  title="Inline code (⌘E)"
                  aria-label="Inline code"
                >
                  &lt;/&gt;
                </button>
                {capabilities.highlight ? (
                  <button
                    type="button"
                    className={`editorial-po-draft-toolbar-btn${
                      editor.isActive('highlight')
                        ? ' editorial-po-draft-toolbar-btn-active'
                        : ''
                    }`}
                    onClick={() =>
                      editor.chain().focus().toggleHighlight().run()
                    }
                    title="Highlight"
                    aria-label="Highlight"
                  >
                    <span className="editorial-po-draft-toolbar-hl">H</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('link')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() => promptLink(editor)}
                  title="Link (⌘K)"
                  aria-label="Link"
                >
                  🔗
                </button>
                <span className="editorial-po-draft-toolbar-divider" />
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('bulletList')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() =>
                    editor.chain().focus().toggleBulletList().run()
                  }
                  title="Bullet list"
                  aria-label="Bullet list"
                >
                  •
                </button>
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('orderedList')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() =>
                    editor.chain().focus().toggleOrderedList().run()
                  }
                  title="Numbered list"
                  aria-label="Numbered list"
                >
                  1.
                </button>
                <button
                  type="button"
                  className={`editorial-po-draft-toolbar-btn${
                    editor.isActive('blockquote')
                      ? ' editorial-po-draft-toolbar-btn-active'
                      : ''
                  }`}
                  onClick={() =>
                    editor.chain().focus().toggleBlockquote().run()
                  }
                  title="Blockquote"
                  aria-label="Blockquote"
                >
                  ❝
                </button>
                {capabilities.align ? (
                  <>
                    <span className="editorial-po-draft-toolbar-divider" />
                    <select
                      className="editorial-po-draft-toolbar-align"
                      value={getActiveAlign(editor)}
                      onChange={(e) =>
                        editor
                          .chain()
                          .focus()
                          .setTextAlign(e.target.value)
                          .run()
                      }
                      aria-label="Text alignment"
                      title="Text alignment"
                    >
                      <option value="left">⇤ Left</option>
                      <option value="center">≡ Center</option>
                      <option value="right">⇥ Right</option>
                      <option value="justify">≣ Justify</option>
                    </select>
                  </>
                ) : null}
                <span className="editorial-po-draft-toolbar-divider" />
                <button
                  type="button"
                  className="editorial-po-draft-toolbar-btn"
                  onClick={() => editor.chain().focus().undo().run()}
                  disabled={!editor.can().undo()}
                  title="Undo (⌘Z)"
                  aria-label="Undo"
                >
                  ↺
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-toolbar-btn"
                  onClick={() => editor.chain().focus().redo().run()}
                  disabled={!editor.can().redo()}
                  title="Redo (⌘⇧Z)"
                  aria-label="Redo"
                >
                  ↻
                </button>
              </div>
            ) : null}
          </div>
          <div className="editorial-po-draft-editor">
            {editor ? (
              <FloatingMenu
                editor={editor}
                className="editorial-po-draft-floating"
                shouldShow={({ editor: e, state }) => {
                  const { $from } = state.selection;
                  const isEmptyParagraph =
                    $from.parent.type.name === 'paragraph' &&
                    $from.parent.content.size === 0;
                  if (!isEmptyParagraph) return false;
                  if (e.isActive('codeBlock')) return false;
                  if (e.isActive('blockquote')) return false;
                  return true;
                }}
              >
                <span className="editorial-po-draft-floating-label">
                  + INSERT
                </span>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 1 }).run()
                  }
                  title="Heading 1"
                >
                  H1
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 2 }).run()
                  }
                  title="Heading 2"
                >
                  H2
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleHeading({ level: 3 }).run()
                  }
                  title="Heading 3"
                >
                  H3
                </button>
                <span className="editorial-po-draft-floating-divider" />
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleBulletList().run()
                  }
                  title="Bullet list"
                  aria-label="Bullet list"
                >
                  •
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleOrderedList().run()
                  }
                  title="Numbered list"
                  aria-label="Numbered list"
                >
                  1.
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().toggleBlockquote().run()
                  }
                  title="Blockquote"
                  aria-label="Blockquote"
                >
                  ❝
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() => editor.chain().focus().toggleCodeBlock().run()}
                  title="Code block"
                  aria-label="Code block"
                >
                  &lt;/&gt;
                </button>
                <button
                  type="button"
                  className="editorial-po-draft-floating-btn"
                  onClick={() =>
                    editor.chain().focus().setHorizontalRule().run()
                  }
                  title="Divider"
                  aria-label="Divider"
                >
                  ―
                </button>
              </FloatingMenu>
            ) : null}
            <EditorContent editor={editor} />
          </div>
        </main>

        {/* RIGHT RAIL — PANEL CHAT */}
        <aside className="editorial-po-draft-panel">
          <header className="editorial-po-draft-panel-header">
            <span className="editorial-po-draft-panel-title">PANEL</span>
            <span className="editorial-po-draft-panel-scope">
              {activePoint >= 0 ? `@POINT ${activePoint + 1}` : '@DRAFT'}
            </span>
            {scopedPanelTurns.length > 0 ? (
              <span className="editorial-po-draft-panel-last">
                LAST {scopedPanelTurns[0].timestamp}
              </span>
            ) : null}
            {hasLiveTurnsForActivePoint ? (
              <button
                type="button"
                className="editorial-po-draft-panel-clear"
                onClick={handleClearPanelHistory}
                title="Clear live panel turns for this point. Fixture turns will reappear."
              >
                ✕ CLEAR
              </button>
            ) : null}
          </header>

          {activePoint >= 0 && PANEL_PRIOR_PHASE_SUMMARIES[activePoint] ? (
            <div className="editorial-po-draft-panel-summary">
              {PANEL_PRIOR_PHASE_SUMMARIES[activePoint]}
            </div>
          ) : null}

          <div className="editorial-po-draft-panel-turns">
            {scopedPanelTurns.length === 0 ? (
              <p className="editorial-tt-empty">
                {activePoint >= 0
                  ? 'No panel turns for this point yet.'
                  : 'Click into a paragraph to see panel turns scoped to that segment.'}
              </p>
            ) : (
              scopedPanelTurns.map((turn) => (
                <article
                  key={turn.id}
                  className="editorial-po-draft-panel-turn"
                >
                  <header className="editorial-po-draft-panel-turn-head">
                    <span
                      className={`editorial-po-draft-panel-avatar editorial-po-draft-panel-avatar-${turn.personaInitial.toLowerCase()}`}
                      aria-hidden="true"
                    >
                      {turn.personaInitial}
                    </span>
                    <span className="editorial-po-draft-panel-name">
                      {turn.personaName}
                    </span>
                    <span className="editorial-po-draft-panel-role">
                      {turn.personaRole}
                    </span>
                    <span className="editorial-po-draft-panel-time">
                      {turn.timestamp}
                    </span>
                  </header>
                  <p
                    className={`editorial-po-draft-panel-body${
                      turn.errored
                        ? ' editorial-po-draft-panel-body-errored'
                        : ''
                    }`}
                  >
                    {turn.body}
                    {turn.streaming ? (
                      <span
                        className="editorial-po-draft-panel-cursor"
                        aria-hidden="true"
                      >
                        ▍
                      </span>
                    ) : null}
                  </p>
                  {turn.actionLabel ? (
                    <button
                      type="button"
                      className="editorial-po-draft-panel-action"
                      disabled
                      title="Action chip wiring lands with LLM panel turns"
                    >
                      {turn.actionLabel}
                    </button>
                  ) : null}
                </article>
              ))
            )}
          </div>

          <div className="editorial-po-draft-panel-composer">
            <textarea
              className="editorial-po-draft-panel-input"
              placeholder={
                panelAgents.length === 0
                  ? selectedAgents.length === 0
                    ? 'Add an agent in Setup → LLM Room to ask the panel…'
                    : 'No connected providers — reconnect in Setup → LLM Room.'
                  : activePoint < 0
                    ? 'Click into a paragraph to scope your question…'
                    : panelAgents.length === 1
                      ? `Ask ${panelAgents[0].name} (${panelAgents[0].role})…`
                      : `Ask the panel (${panelAgents.length} agents)…`
              }
              value={composerValue}
              onChange={(e) => setComposerValue(e.target.value)}
              disabled={
                panelAgents.length === 0 ||
                activePoint < 0 ||
                composerSubmitting
              }
              rows={2}
              onKeyDown={(e) => {
                if (
                  (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ||
                  (e.key === 'Enter' && !e.shiftKey)
                ) {
                  e.preventDefault();
                  void handleSubmitPanelTurn();
                }
              }}
            />
            <button
              type="button"
              className="editorial-po-draft-panel-ask"
              disabled={
                panelAgents.length === 0 ||
                activePoint < 0 ||
                composerSubmitting ||
                !composerValue.trim()
              }
              onClick={() => {
                void handleSubmitPanelTurn();
              }}
              title={
                panelAgents.length === 0
                  ? selectedAgents.length === 0
                    ? 'No agent selected — add one in Setup → LLM Room.'
                    : 'No connected providers — reconnect in Setup → LLM Room.'
                  : activePoint < 0
                    ? 'Click into a paragraph to scope the turn.'
                    : composerSubmitting
                      ? 'Streaming the panel…'
                      : panelAgents.length === 1
                        ? `Ask ${panelAgents[0].name}`
                        : `Ask all ${panelAgents.length} agents in parallel`
              }
            >
              {composerSubmitting
                ? '… STREAMING'
                : panelAgents.length >= 2
                  ? `+ ASK PANEL (${panelAgents.length})`
                  : '+ ASK'}
            </button>
          </div>
          {panelAgents.length > 0 ? (
            <p className="editorial-po-draft-panel-hint">
              {panelAgents.map((a) => a.name).join(' · ')}
              {skippedAgentCount > 0
                ? ` · ${skippedAgentCount} skipped (auth missing)`
                : ''}
            </p>
          ) : null}
          {composerError ? (
            <p className="editorial-po-draft-panel-error">{composerError}</p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
