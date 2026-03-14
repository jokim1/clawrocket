/**
 * @deprecated — SCHEDULED FOR DELETION
 * Replaced by: talks/context-loader.ts
 * This file is kept temporarily while server.ts is being rewired.
 * Do not add new code here.
 */

import {
  getMessageAttachmentById,
  getTalkContextForPrompt,
  getTalkContextSourceByRef,
  listTalkAttachments,
  type AttachmentSnapshot,
  type TalkContextForPrompt,
} from '../db/context-accessors.js';

// ---------------------------------------------------------------------------
// Token estimation (must match the rough heuristic in context-assembler.ts)
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Manifest rendering
// ---------------------------------------------------------------------------

function truncateForManifest(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + '…';
}

function renderSourceManifestEntry(
  source: TalkContextForPrompt['sources'][number],
): string {
  const ref = source.sourceRef;
  const type = source.sourceType;
  const title = truncateForManifest(source.title, 80);
  const status = source.status === 'ready' ? '' : ` [${source.status}]`;
  const note = source.note ? ` — ${truncateForManifest(source.note, 120)}` : '';
  return `- ${ref} [${type}] "${title}"${note}${status}`;
}

// ---------------------------------------------------------------------------
// Tiny text inlining
// ---------------------------------------------------------------------------

const MAX_INLINE_TOKENS_PER_ITEM = 250;
const MAX_INLINE_TOKENS_TOTAL = 600;

interface InlinedSource {
  sourceRef: string;
  text: string;
}

function selectInlinedTextSources(
  sources: TalkContextForPrompt['sources'],
): InlinedSource[] {
  const inlined: InlinedSource[] = [];
  let usedTokens = 0;

  // Sources are already sorted by sortOrder from the DB query
  for (const source of sources) {
    if (source.sourceType !== 'text') continue;
    if (source.status !== 'ready') continue;
    if (!source.extractedText) continue;

    const tokens = estimateTokens(source.extractedText);
    if (tokens > MAX_INLINE_TOKENS_PER_ITEM) continue;
    if (usedTokens + tokens > MAX_INLINE_TOKENS_TOTAL) continue;

    inlined.push({
      sourceRef: source.sourceRef,
      text: source.extractedText,
    });
    usedTokens += tokens;
  }

  return inlined;
}

// ---------------------------------------------------------------------------
// Public: build the context directives string for prompt assembly
// ---------------------------------------------------------------------------

export interface TalkContextDirectivesResult {
  /** Combined system message text for goal + rules + manifest + inline text.
   *  null if nothing to inject. */
  directivesText: string | null;

  /** Whether any saved sources exist (used to decide if read_context_source tool is needed). */
  hasSources: boolean;

  /** Number of sources that are in 'ready' status. */
  readySourceCount: number;
}

export interface BuildDirectivesOptions {
  /**
   * When true (default), the source manifest includes a hint telling the
   * model to call read_context_source. Set to false when the tool will not
   * be registered (e.g. subscription-auth container execution).
   */
  includeToolHint?: boolean;
}

export function buildTalkContextDirectives(
  talkId: string,
  options?: BuildDirectivesOptions,
): TalkContextDirectivesResult {
  const context = getTalkContextForPrompt(talkId);
  return buildTalkContextDirectivesFromData(context, options);
}

export function buildTalkContextDirectivesFromData(
  context: TalkContextForPrompt,
  options?: BuildDirectivesOptions,
): TalkContextDirectivesResult {
  const includeToolHint = options?.includeToolHint ?? true;
  const parts: string[] = [];
  const hasSources = context.sources.length > 0;
  const readySourceCount = context.sources.filter(
    (s) => s.status === 'ready',
  ).length;

  // Goal
  if (context.goalText) {
    parts.push(`## Goal\n${context.goalText}`);
  }

  // Rules
  if (context.activeRules.length > 0) {
    const rulesBlock = context.activeRules
      .map((r, i) => `${i + 1}. ${r}`)
      .join('\n');
    parts.push(`## Rules\n${rulesBlock}`);
  }

  // Source manifest
  if (context.sources.length > 0) {
    const manifestEntries = context.sources.map(renderSourceManifestEntry);
    const manifestBody = manifestEntries.join('\n');
    const toolLine = includeToolHint
      ? '\nUse read_context_source(sourceRef) to read full content.'
      : '';
    parts.push(`## Saved Sources\n${manifestBody}${toolLine}`);
  }

  // Tiny text inlines
  const inlined = selectInlinedTextSources(context.sources);
  if (inlined.length > 0) {
    const inlineBlocks = inlined.map(
      (item) => `### ${item.sourceRef}\n${item.text}`,
    );
    parts.push(`## Inline Source Content\n${inlineBlocks.join('\n\n')}`);
  }

  const directivesText = parts.length > 0 ? parts.join('\n\n') : null;

  return {
    directivesText,
    hasSources,
    readySourceCount,
  };
}

// ---------------------------------------------------------------------------
// Tool definition for read_context_source
// ---------------------------------------------------------------------------

export interface ContextSourceToolDefinition {
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function buildContextSourceToolDefinition(): ContextSourceToolDefinition {
  return {
    toolName: 'read_context_source',
    description:
      'Read the full extracted text of a saved source by its reference (e.g. S1, S2). Returns source metadata and up to 12,000 characters of normalized text.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceRef: {
          type: 'string',
          description:
            'The source reference from the manifest, e.g. "S1", "S2".',
        },
      },
      required: ['sourceRef'],
    },
  };
}

const READ_CONTEXT_SOURCE_MAX_CHARS = 12_000;

export interface ReadContextSourceResult {
  sourceRef: string;
  type: string;
  title: string;
  note: string | null;
  status: string;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  content: string | null;
}

export function executeReadContextSource(
  talkId: string,
  sourceRef: string,
): ReadContextSourceResult | { error: string } {
  const source = getTalkContextSourceByRef(sourceRef, talkId);
  if (!source) {
    return { error: `Source ${sourceRef} not found.` };
  }

  const totalChars = source.extractedText?.length ?? 0;
  let content = source.extractedText;
  let truncated = false;

  if (content && content.length > READ_CONTEXT_SOURCE_MAX_CHARS) {
    content = content.slice(0, READ_CONTEXT_SOURCE_MAX_CHARS);
    truncated = true;
  }

  return {
    sourceRef: source.sourceRef,
    type: source.sourceType,
    title: source.title,
    note: source.note,
    status: source.status,
    totalChars,
    returnedChars: content?.length ?? 0,
    truncated: truncated || source.isTruncated,
    content,
  };
}

// ---------------------------------------------------------------------------
// Tool definition for read_attachment
// ---------------------------------------------------------------------------

export function buildAttachmentToolDefinition(): ContextSourceToolDefinition {
  return {
    toolName: 'read_attachment',
    description:
      'Read the extracted text of a file attachment from any message in this talk. Returns up to 12,000 characters of content.',
    inputSchema: {
      type: 'object',
      properties: {
        attachmentId: {
          type: 'string',
          description:
            'The attachment ID from the attached files listing in the conversation.',
        },
      },
      required: ['attachmentId'],
    },
  };
}

const READ_ATTACHMENT_MAX_CHARS = 12_000;

export interface ReadAttachmentResult {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
  content: string | null;
}

export function executeReadAttachment(
  talkId: string,
  attachmentId: string,
): ReadAttachmentResult | { error: string } {
  const attachment = getMessageAttachmentById(attachmentId, talkId);
  if (!attachment) {
    return { error: `Attachment "${attachmentId}" not found in this talk.` };
  }

  if (attachment.extraction_status !== 'extracted') {
    return {
      error:
        `Attachment "${attachment.file_name}" extraction ${attachment.extraction_status === 'failed' ? 'failed' : 'is still pending'}. ${attachment.extraction_error || ''}`.trim(),
    };
  }

  const totalChars = attachment.extracted_text?.length ?? 0;
  let content = attachment.extracted_text;
  let truncated = false;

  if (content && content.length > READ_ATTACHMENT_MAX_CHARS) {
    content = content.slice(0, READ_ATTACHMENT_MAX_CHARS);
    truncated = true;
  }

  return {
    attachmentId: attachment.id,
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    totalChars,
    returnedChars: content?.length ?? 0,
    truncated,
    content,
  };
}

// ---------------------------------------------------------------------------
// Attachment manifest for directives (tells agent what files are available)
// ---------------------------------------------------------------------------

export function buildAttachmentManifest(talkId: string): string | null {
  const attachments = listTalkAttachments(talkId);
  if (attachments.length === 0) return null;

  const entries = attachments.map((att) => {
    const status =
      att.extractionStatus === 'extracted' ? '' : ` [${att.extractionStatus}]`;
    const size = formatAttachmentSize(att.fileSize);
    return `- ${att.id}: "${att.fileName}" (${att.mimeType}, ${size})${status}`;
  });

  return `## Message Attachments\n${entries.join('\n')}\nUse read_attachment(attachmentId) to read full content.`;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
