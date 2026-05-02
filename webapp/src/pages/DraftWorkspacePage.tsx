import { useEffect, useMemo, useRef, useState } from 'react';
import { useEditor, EditorContent, type Content } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';

import { EditorialPhaseStrip } from '../components/EditorialPhaseStrip';

// ───────────────────────────────────────────────────────────────────────────
// Phase 04 DRAFT — first cut.
// Three-column shell + a basic Tiptap editor (StarterKit only). The Outline
// rail (left) reads the same localStorage written by the Points + Outline
// workspace, so the user's claims/stakes show up here automatically. Editor
// content autosaves to its own localStorage key; word count and a fake
// "LAST AUTOSAVE" timestamp render in the sub-meta bar.
//
// Deferred to follow-up PRs (per kickoff item 17 + design/04_draft.md):
// - Tabs in left rail (Outline / Sources / Versions); right now only Outline
// - Per-segment scoring inside the editor
// - Active segment selection + Panel chat scoped to it (right rail is a
//   placeholder card for now)
// - Top action toolbar's quick chips (FULL DRAFT / POLISH / EXPAND / →
//   CONTINUE / ? MISSING) — rendered but disabled
// - + OPTIMIZE popover with cost preview + customize panel + run
// - Voice-lock banner, mechanical scorer, suggestion overlay, source-map
// - Markdown export (Substack/Google Doc), revision history
// - Tiptap → Markdown round-trip + canonical subset (0p-b1 spike)
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
    // SSR fallback — seed from fixture so the rail isn't empty.
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
  const saveTimerRef = useRef<number | null>(null);

  const editor = useEditor({
    extensions: [StarterKit],
    content: loadDraftContent(),
    onCreate: ({ editor }) => {
      setWordCount(countWords(editor.state.doc.textContent));
    },
    onUpdate: ({ editor }) => {
      setWordCount(countWords(editor.state.doc.textContent));
      // Debounced save
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        saveDraftContent(editor.getJSON());
        setLastSavedAt(new Date());
        saveTimerRef.current = null;
      }, 500);
    },
  });

  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  const totalOutlinePoints = useMemo(
    () =>
      outlineGroups.HOOK.length +
      outlineGroups.BODY.length +
      outlineGroups.CLOSE.length,
    [outlineGroups],
  );

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
        <span className="editorial-po-draft-scope">SCOPE: WHOLE DRAFT</span>
      </div>

      <div className="editorial-po-draft-grid">
        {/* LEFT RAIL — OUTLINE */}
        <aside className="editorial-po-draft-rail">
          <div className="editorial-po-rail-tabs">
            <button
              type="button"
              className="editorial-po-rail-tab editorial-po-rail-tab-active"
            >
              Outline{' '}
              <span className="editorial-po-rail-tab-count">
                {totalOutlinePoints}/5–7
              </span>
            </button>
            <button type="button" className="editorial-po-rail-tab" disabled>
              Sources <span className="editorial-po-rail-tab-count">—</span>
            </button>
            <button type="button" className="editorial-po-rail-tab" disabled>
              Versions <span className="editorial-po-rail-tab-count">—</span>
            </button>
          </div>

          {totalOutlinePoints === 0 ? (
            <p className="editorial-tt-empty">
              No Points in the Outline yet. Visit{' '}
              <a href="/editorial/points-outline">03 POINTS + OUTLINE</a> to add
              some.
            </p>
          ) : (
            (() => {
              let runningPos = 0;
              return SECTION_ORDER.map((section) => {
                const points = outlineGroups[section];
                const startPos = runningPos + 1;
                runningPos += points.length;
                if (points.length === 0) return null;
                return (
                  <section key={section} className="editorial-po-draft-section">
                    <h3 className="editorial-po-outline-section-header">
                      <span className="editorial-po-outline-section-label">
                        {SECTION_LABEL[section]}
                      </span>
                      <span className="editorial-po-outline-section-count">
                        {points.length}
                      </span>
                    </h3>
                    <ul className="editorial-po-draft-outline-list">
                      {points.map((p, idx) => (
                        <li
                          key={p.slug}
                          className="editorial-po-draft-outline-item"
                        >
                          <div className="editorial-po-draft-outline-row">
                            <span className="editorial-po-point-position">
                              {String(startPos + idx).padStart(2, '0')}
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
                          </div>
                          <p className="editorial-po-draft-outline-claim">
                            {p.claim}
                          </p>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              });
            })()
          )}
        </aside>

        {/* CENTER — TIPTAP EDITOR */}
        <main className="editorial-po-draft-center">
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
