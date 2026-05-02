// ───────────────────────────────────────────────────────────────────────────
// Markdown → Tiptap-JSON parser (StarterKit subset).
//
// Companion to `markdown-export.ts`. The Editorial Room Phase 04 DRAFT
// flow runs Tiptap → MD on export; this module covers the inverse so we
// can prove round-trip viability for the 0p-b1 spike (kickoff item 5).
//
// Block coverage:
//   doc, paragraph, heading (#–######), blockquote (`> `),
//   codeBlock (fenced ```), bulletList (`-`/`*`/`+`), orderedList (`N.`),
//   horizontalRule (`---`)
//
// Inline coverage (best-effort, single-pass):
//   bold `**text**`, italic `*text*`, strike `~~text~~`,
//   code `\`text\``, link `[text](url)`
//
// Caveats — the parser is intentionally small and prioritizes block
// fidelity for the spike. Known rough edges:
//   - Nested combined marks like `***bold-italic***` survive the parse but
//     may not produce the exact same JSON as the original Tiptap doc.
//   - Nested lists are not parsed (each list item is treated as a
//     single paragraph).
//   - Tables are not in StarterKit, so out of scope.
// Document round-trip results live in markdown-export.test.ts.
// ───────────────────────────────────────────────────────────────────────────

import type { JSONMark, JSONNode } from './markdown-export';

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const FENCE_RE = /^```\s*([a-zA-Z0-9_+-]*)\s*$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const BULLET_RE = /^[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\d+)\.\s+(.*)$/;
const LINK_RE = /^\[([^\]]+)\]\(([^)\s]+)\)/;

function isBlockStart(line: string): boolean {
  return (
    HEADING_RE.test(line) ||
    HR_RE.test(line.trim()) ||
    FENCE_RE.test(line) ||
    BLOCKQUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    ORDERED_RE.test(line)
  );
}

function pushText(out: JSONNode[], text: string, marks?: JSONMark[]): void {
  if (text === '') return;
  if (!marks || marks.length === 0) {
    const last = out[out.length - 1];
    if (last && last.type === 'text' && !last.marks) {
      last.text = (last.text ?? '') + text;
      return;
    }
    out.push({ type: 'text', text });
    return;
  }
  out.push({ type: 'text', text, marks });
}

function withAddedMark(node: JSONNode, mark: JSONMark): JSONNode {
  if (node.type !== 'text') return node;
  const existing = node.marks ?? [];
  // Don't duplicate the same mark twice.
  if (existing.some((m) => m.type === mark.type)) return node;
  return { ...node, marks: [...existing, mark] };
}

export function parseInline(text: string): JSONNode[] {
  const out: JSONNode[] = [];
  let pos = 0;
  while (pos < text.length) {
    const char = text[pos];

    // Inline code — never recurse into mark parsing inside a code span.
    if (char === '`') {
      const end = text.indexOf('`', pos + 1);
      if (end !== -1) {
        out.push({
          type: 'text',
          text: text.slice(pos + 1, end),
          marks: [{ type: 'code' }],
        });
        pos = end + 1;
        continue;
      }
    }

    // Strike — `~~text~~`.
    if (char === '~' && text[pos + 1] === '~') {
      const end = text.indexOf('~~', pos + 2);
      if (end !== -1) {
        const inner = parseInline(text.slice(pos + 2, end));
        for (const node of inner) {
          out.push(withAddedMark(node, { type: 'strike' }));
        }
        pos = end + 2;
        continue;
      }
    }

    // Bold — `**text**`. Match before italic so `**` doesn't get eaten by
    // the italic path.
    if (char === '*' && text[pos + 1] === '*') {
      const end = text.indexOf('**', pos + 2);
      if (end !== -1 && end > pos + 2) {
        const inner = parseInline(text.slice(pos + 2, end));
        for (const node of inner) {
          out.push(withAddedMark(node, { type: 'bold' }));
        }
        pos = end + 2;
        continue;
      }
    }

    // Italic — `*text*`. Skip if next char is `*` (would be bold) or
    // previous char is `*` (mid-bold-token).
    if (char === '*') {
      let scan = pos + 1;
      while (scan < text.length && text[scan] !== '*') scan++;
      if (scan < text.length && scan > pos + 1) {
        const inner = parseInline(text.slice(pos + 1, scan));
        for (const node of inner) {
          out.push(withAddedMark(node, { type: 'italic' }));
        }
        pos = scan + 1;
        continue;
      }
    }

    // Link — `[text](url)`.
    if (char === '[') {
      const slice = text.slice(pos);
      const m = LINK_RE.exec(slice);
      if (m) {
        out.push({
          type: 'text',
          text: m[1],
          marks: [{ type: 'link', attrs: { href: m[2] } }],
        });
        pos += m[0].length;
        continue;
      }
    }

    // Hard break — `  \n` collapsed to `<br>` not currently supported in
    // single-line inline parse (the line-break is consumed by the block
    // parser already). Plain text fallback.

    // Default: accumulate until next special character.
    const SPECIAL = '`*~[';
    let plainEnd = pos + 1;
    while (plainEnd < text.length && !SPECIAL.includes(text[plainEnd])) {
      plainEnd++;
    }
    pushText(out, text.slice(pos, plainEnd));
    pos = plainEnd;
  }
  return out;
}

function takeListBlock(
  lines: string[],
  startIdx: number,
  ordered: boolean,
): { node: JSONNode; nextIdx: number } {
  const items: JSONNode[] = [];
  let i = startIdx;
  let firstStart = 1;
  while (i < lines.length) {
    const m = ordered ? ORDERED_RE.exec(lines[i]) : BULLET_RE.exec(lines[i]);
    if (!m) break;
    if (ordered && items.length === 0) {
      firstStart = parseInt(m[1], 10);
    }
    const itemText = ordered ? m[2] : m[1];
    items.push({
      type: 'listItem',
      content: [
        {
          type: 'paragraph',
          content: parseInline(itemText),
        },
      ],
    });
    i++;
  }
  const node: JSONNode = ordered
    ? {
        type: 'orderedList',
        attrs: { start: firstStart },
        content: items,
      }
    : {
        type: 'bulletList',
        content: items,
      };
  return { node, nextIdx: i };
}

function takeBlockquote(
  lines: string[],
  startIdx: number,
): { node: JSONNode; nextIdx: number } {
  const quoteLines: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const m = BLOCKQUOTE_RE.exec(lines[i]);
    if (m) {
      quoteLines.push(m[1]);
      i++;
      continue;
    }
    if (lines[i].trim() === '' && i + 1 < lines.length) {
      const next = BLOCKQUOTE_RE.exec(lines[i + 1]);
      if (next) {
        quoteLines.push('');
        i++;
        continue;
      }
    }
    break;
  }
  const inner = parseMarkdownToDoc(quoteLines.join('\n'));
  return {
    node: { type: 'blockquote', content: inner.content ?? [] },
    nextIdx: i,
  };
}

function takeCodeBlock(
  lines: string[],
  startIdx: number,
): { node: JSONNode; nextIdx: number } {
  const fence = FENCE_RE.exec(lines[startIdx]);
  const language = fence ? fence[1] : '';
  const codeLines: string[] = [];
  let i = startIdx + 1;
  while (i < lines.length && !/^```\s*$/.test(lines[i])) {
    codeLines.push(lines[i]);
    i++;
  }
  // Skip closing fence if present.
  if (i < lines.length) i++;
  const text = codeLines.join('\n');
  const content: JSONNode[] = text === '' ? [] : [{ type: 'text', text }];
  return {
    node: {
      type: 'codeBlock',
      attrs: language ? { language } : { language: null },
      content,
    },
    nextIdx: i,
  };
}

function takeParagraph(
  lines: string[],
  startIdx: number,
): { node: JSONNode; nextIdx: number } {
  const paraLines: string[] = [lines[startIdx]];
  let i = startIdx + 1;
  while (
    i < lines.length &&
    lines[i].trim() !== '' &&
    !isBlockStart(lines[i])
  ) {
    paraLines.push(lines[i]);
    i++;
  }
  return {
    node: {
      type: 'paragraph',
      content: parseInline(paraLines.join(' ')),
    },
    nextIdx: i,
  };
}

export function parseMarkdownToDoc(md: string): JSONNode {
  const lines = md.split('\n');
  // Strip trailing-only empty lines so we don't generate empty trailing
  // paragraphs but keep internal blank lines intact for block grouping.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const blocks: JSONNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }

    const headingMatch = HEADING_RE.exec(line);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInline(headingMatch[2]),
      });
      i++;
      continue;
    }

    if (HR_RE.test(line.trim())) {
      blocks.push({ type: 'horizontalRule' });
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      const { node, nextIdx } = takeCodeBlock(lines, i);
      blocks.push(node);
      i = nextIdx;
      continue;
    }

    if (BLOCKQUOTE_RE.test(line)) {
      const { node, nextIdx } = takeBlockquote(lines, i);
      blocks.push(node);
      i = nextIdx;
      continue;
    }

    if (BULLET_RE.test(line)) {
      const { node, nextIdx } = takeListBlock(lines, i, false);
      blocks.push(node);
      i = nextIdx;
      continue;
    }

    if (ORDERED_RE.test(line)) {
      const { node, nextIdx } = takeListBlock(lines, i, true);
      blocks.push(node);
      i = nextIdx;
      continue;
    }

    const { node, nextIdx } = takeParagraph(lines, i);
    blocks.push(node);
    i = nextIdx;
  }

  return { type: 'doc', content: blocks };
}
