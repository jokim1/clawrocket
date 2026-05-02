// ───────────────────────────────────────────────────────────────────────────
// Editorial Room — shared SetupState persistence + destination capabilities.
//
// Setup is the source of truth for `deliverable_type`, `destination`, voice,
// and length target. Other phases (Draft, Polish, Ship) read from here so
// the editing surface adapts to what the destination actually supports
// without duplicating input controls.
//
// Persistence is localStorage at v0p; replaced by the rocketorchestra
// `setup` page lookup once that's wired.
// ───────────────────────────────────────────────────────────────────────────

export type DeliverableType =
  | 'longform_post'
  | 'podcast_script'
  | 'book_chapter'
  | 'social_post'
  | 'memo';

export type Destination =
  | 'substack_md'
  | 'google_doc'
  | 'plain_md'
  | 'youtube_script'
  | 'other';

export type SetupState = {
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

const SETUP_STATE_KEY = 'editorial-room.setup.state-v0';

export const DELIVERABLE_LABELS: Record<DeliverableType, string> = {
  longform_post: 'Longform Post',
  podcast_script: 'Podcast Script',
  book_chapter: 'Book Chapter',
  social_post: 'Social Post',
  memo: 'Memo',
};

export const DESTINATION_LABELS: Record<Destination, string> = {
  substack_md: 'Substack · Markdown export',
  google_doc: 'Google Doc',
  plain_md: 'Plain Markdown',
  youtube_script: 'YouTube Script',
  other: 'Other',
};

// Compact label for the Draft eyebrow row.
export const DESTINATION_SHORT: Record<Destination, string> = {
  substack_md: 'SUBSTACK',
  google_doc: 'GOOGLE DOC',
  plain_md: 'PLAIN MD',
  youtube_script: 'YOUTUBE',
  other: 'OTHER',
};

// Per-destination toolbar capabilities. Marks/attrs that won't survive the
// destination's export are hidden from the toolbar — the canonical Tiptap
// JSON still carries them if previously applied, but the user isn't
// encouraged to add new ones for this destination.
//
// Bold / italic / strike / code / link / lists / blockquote / headings are
// always on (universal markdown subset).
export type ToolbarCapabilities = {
  underline: boolean;
  highlight: boolean;
  align: boolean;
  exportFormat: 'markdown' | 'html';
  exportButtonLabel: string;
  exportSuccessLabel: string;
};

export const DESTINATION_CAPABILITIES: Record<
  Destination,
  ToolbarCapabilities
> = {
  substack_md: {
    underline: false,
    highlight: false,
    align: false,
    exportFormat: 'markdown',
    exportButtonLabel: '↑ COPY MD',
    exportSuccessLabel: 'COPIED MD ✓',
  },
  google_doc: {
    underline: true,
    highlight: true,
    align: true,
    exportFormat: 'html',
    exportButtonLabel: '↑ COPY RICH',
    exportSuccessLabel: 'COPIED RICH ✓',
  },
  plain_md: {
    underline: false,
    highlight: false,
    align: false,
    exportFormat: 'markdown',
    exportButtonLabel: '↑ COPY MD',
    exportSuccessLabel: 'COPIED MD ✓',
  },
  youtube_script: {
    underline: false,
    highlight: false,
    align: false,
    exportFormat: 'markdown',
    exportButtonLabel: '↑ COPY MD',
    exportSuccessLabel: 'COPIED MD ✓',
  },
  other: {
    underline: true,
    highlight: true,
    align: true,
    exportFormat: 'markdown',
    exportButtonLabel: '↑ COPY MD',
    exportSuccessLabel: 'COPIED MD ✓',
  },
};

export function defaultSetupState(): SetupState {
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

function isValidSetupState(v: unknown): v is SetupState {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (obj.schema_version !== '0') return false;
  if (typeof obj.setup_version !== 'number') return false;
  if (typeof obj.deliverable_type !== 'string') return false;
  if (typeof obj.destination !== 'string') return false;
  return true;
}

export function loadSetupState(): SetupState {
  if (typeof window === 'undefined') return defaultSetupState();
  try {
    const raw = window.localStorage.getItem(SETUP_STATE_KEY);
    if (!raw) return defaultSetupState();
    const parsed = JSON.parse(raw);
    if (!isValidSetupState(parsed)) return defaultSetupState();
    // Merge with default to backfill any new fields we add later.
    return { ...defaultSetupState(), ...parsed };
  } catch {
    return defaultSetupState();
  }
}

export function saveSetupState(state: SetupState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETUP_STATE_KEY, JSON.stringify(state));
  } catch {
    // localStorage quota errors silently dropped at v0p
  }
}

export function loadDestination(): Destination {
  return loadSetupState().destination;
}
