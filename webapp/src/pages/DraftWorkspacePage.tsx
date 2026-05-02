import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useEditor,
  EditorContent,
  type Content,
  type Editor,
} from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';

// ───────────────────────────────────────────────────────────────────────────
// Phase 04 DRAFT — versions tab + ⌘S manual save.
// Builds on the cursor-aware navigation cut (PR #270) by adding the Versions
// rail tab per design/04_draft.md §10.4:
//   • Named snapshots: manual_save (⌘S), phase_entry (mount), restore_from_snapshot
//     — durable, never auto-pruned at v0p
//   • Auto snapshots: every 60s if changed since last snapshot — last 20 retained
//     (FIFO prune)
//   • Restore replaces the current draft body and captures pre-restore state
//     as a named snapshot so the user can recover from a misclick
//
// Earlier cuts in this page:
//   • PR #269: three-column shell + Tiptap editor + outline rail + word count
//   • PR #270: cursor-aware status bar + scope chip + outline jump-to-segment
//
// Still deferred (per design/04_draft.md):
// - Sources tab (left rail) — scoped citation tracker
// - Panel chat scoped to active segment (right rail)
// - Quick-action chips wired to handlers (FULL DRAFT / POLISH / etc.)
// - + OPTIMIZE popover with cost preview + customize panel + run
// - Voice-lock banner, mechanical scorer, suggestion overlay
// - Markdown export, source-map round-trip
// - Compressed-diff snapshot storage (currently full JSON per snapshot)
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

type RailTab = 'outline' | 'versions';

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
  const saveTimerRef = useRef<number | null>(null);
  // Bumped on every editor onUpdate. Compared against `lastSnapshotVersionRef`
  // by the auto-snapshot interval to skip no-op snapshots.
  const editorVersionRef = useRef<number>(0);
  const lastSnapshotVersionRef = useRef<number>(-1);
  const phaseEntryDoneRef = useRef<boolean>(false);

  const editor = useEditor({
    extensions: [StarterKit],
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
  const scopeText = scopeChipText(cursor);
  const statusText = activeStatusText(cursor, orderedOutline, activePoint);

  const handleOutlineClick = (pointIndex: number): void => {
    if (!editor) return;
    jumpToPointParagraph(editor, pointIndex, buckets);
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

      <div className="editorial-po-draft-meta">
        <span className={`editorial-po-draft-words ${wordTargetStatus}`}>
          {wordCount.toLocaleString()} / {WORD_TARGET_MIN.toLocaleString()}–
          {WORD_TARGET_MAX.toLocaleString()} WORDS
        </span>
        <span className="editorial-po-meta-sep">·</span>
        <span className="editorial-po-draft-autosave">
          {lastSavedAt
            ? `LAST AUTOSAVE ${formatHHMM(lastSavedAt)}`
            : 'NO CHANGES SINCE LOAD'}
        </span>
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
        <button
          type="button"
          className="editorial-chip-button editorial-chip-button-primary"
          disabled
        >
          + OPTIMIZE ⌘O
        </button>
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
            <button type="button" className="editorial-po-rail-tab" disabled>
              Sources <span className="editorial-po-rail-tab-count">—</span>
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

          {activeRailTab === 'outline' ? (
            totalOutlinePoints === 0 ? (
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
            )
          ) : (
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
          <div className="editorial-po-draft-status-bar">{statusText}</div>
          <div className="editorial-po-draft-editor">
            <EditorContent editor={editor} />
          </div>
        </main>

        {/* RIGHT RAIL — PANEL CHAT (placeholder) */}
        <aside className="editorial-po-draft-panel">
          <h2 className="editorial-rail-heading">PANEL CHAT</h2>
          <p className="editorial-tt-empty">
            Panel chat scoped to the active draft segment lands in a follow-up
            PR. Use 03 POINTS + OUTLINE to discuss a Point with the panel for
            now.
          </p>
        </aside>
      </div>
    </div>
  );
}
