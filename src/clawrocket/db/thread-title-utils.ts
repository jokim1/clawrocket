export const LEGACY_DEFAULT_TALK_THREAD_TITLE = 'Default Thread';

const MAX_THREAD_TITLE_CHARS = 48;

export function normalizeStoredThreadTitle(
  title: string | null | undefined,
): string | null {
  if (typeof title !== 'string') return null;
  const compact = title.replace(/\s+/g, ' ').trim();
  return compact ? compact : null;
}

export function isLegacyPlaceholderTalkThreadTitle(
  title: string | null | undefined,
): boolean {
  return normalizeStoredThreadTitle(title) === LEGACY_DEFAULT_TALK_THREAD_TITLE;
}

export function inferThreadTitleFromContent(
  content: string | null | undefined,
): string | null {
  const compact = normalizeStoredThreadTitle(content);
  if (!compact) return null;

  const unquoted = compact.replace(/^["'`]+|["'`]+$/g, '').trim() || compact;
  if (unquoted.length <= MAX_THREAD_TITLE_CHARS) {
    return unquoted;
  }
  return `${unquoted.slice(0, MAX_THREAD_TITLE_CHARS - 1).trimEnd()}…`;
}
