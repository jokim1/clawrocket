const INTERNAL_TAG_PATTERN = /<internal>[\s\S]*?(?:<\/internal>|$)/g;

export function stripInternalTalkResponseText(text: string): string {
  if (!text) return '';
  return text.replace(INTERNAL_TAG_PATTERN, '');
}

export interface TalkResponseStreamSanitizer {
  push(chunk: string): string;
}

export function createTalkResponseStreamSanitizer(): TalkResponseStreamSanitizer {
  let rawText = '';
  let visibleText = '';

  return {
    push(chunk: string): string {
      rawText += chunk;
      const nextVisibleText = stripInternalTalkResponseText(rawText);
      const nextDeltaText = nextVisibleText.slice(visibleText.length);
      visibleText = nextVisibleText;
      return nextDeltaText;
    },
  };
}
