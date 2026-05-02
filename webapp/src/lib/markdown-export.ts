// ───────────────────────────────────────────────────────────────────────────
// Tiptap-JSON → Markdown serializer (StarterKit subset).
//
// Used by the Editorial Room Draft phase to export a Tiptap document to
// Substack-paste-ready markdown without round-tripping through the LLM.
// Handles the StarterKit node and mark types we actually emit:
//   nodes:  doc, paragraph, heading, blockquote, codeBlock, bulletList,
//           orderedList, listItem, horizontalRule, hardBreak, text
//   marks:  bold, italic, strike, code, link
// Unknown nodes/marks fall through to their content (best-effort, no throw).
// ───────────────────────────────────────────────────────────────────────────

export type JSONMark = {
  type: string;
  attrs?: Record<string, unknown>;
};

export type JSONNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: JSONNode[];
  text?: string;
  marks?: JSONMark[];
};

const MARK_ORDER: Record<string, number> = {
  // Apply outermost-first so the rendered string nests correctly.
  // E.g. for [bold, italic] we want `**_text_**`, so italic wraps first.
  link: 0,
  bold: 1,
  italic: 2,
  strike: 3,
  code: 4,
};

function applyMark(text: string, mark: JSONMark): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'code':
      return `\`${text}\``;
    case 'link': {
      const href =
        typeof mark.attrs?.href === 'string' ? mark.attrs.href : null;
      if (!href) return text;
      return `[${text}](${href})`;
    }
    default:
      return text;
  }
}

function serializeText(text: string, marks: JSONMark[] | undefined): string {
  if (!marks || marks.length === 0) return text;
  // Apply marks innermost → outermost so the outermost wrapper is applied last.
  const sorted = [...marks].sort(
    (a, b) => (MARK_ORDER[b.type] ?? 99) - (MARK_ORDER[a.type] ?? 99),
  );
  let out = text;
  for (const mark of sorted) {
    out = applyMark(out, mark);
  }
  return out;
}

function serializeInline(content: JSONNode[] | undefined): string {
  if (!content || content.length === 0) return '';
  let out = '';
  for (const node of content) {
    if (node.type === 'text') {
      out += serializeText(node.text ?? '', node.marks);
    } else if (node.type === 'hardBreak') {
      out += '  \n';
    } else if (node.content) {
      // Unexpected nested block inside inline — fall through to its inline.
      out += serializeInline(node.content);
    }
  }
  return out;
}

function serializeListItem(node: JSONNode, marker: string): string {
  // List items contain block children (usually a single paragraph). Render the
  // first child inline, and subsequent blocks indented as continuation lines.
  const children = node.content ?? [];
  if (children.length === 0) return `${marker} \n`;
  const indentSize = marker.length + 1;
  const indent = ' '.repeat(indentSize);
  const parts: string[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const block = serializeBlock(child).trimEnd();
    const lines = block.split('\n');
    if (i === 0) {
      parts.push(`${marker} ${lines[0] ?? ''}`);
      for (let l = 1; l < lines.length; l++) {
        parts.push(`${indent}${lines[l]}`);
      }
    } else {
      parts.push('');
      for (const line of lines) {
        parts.push(line === '' ? '' : `${indent}${line}`);
      }
    }
  }
  return parts.join('\n') + '\n';
}

function serializeBlock(node: JSONNode): string {
  switch (node.type) {
    case 'paragraph':
      return `${serializeInline(node.content)}\n`;
    case 'heading': {
      const rawLevel =
        typeof node.attrs?.level === 'number' ? node.attrs.level : 1;
      const level = Math.max(1, Math.min(6, rawLevel));
      const hashes = '#'.repeat(level);
      return `${hashes} ${serializeInline(node.content)}\n`;
    }
    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((n) => serializeBlock(n))
        .join('\n')
        .trim();
      if (!inner) return '> \n';
      return (
        inner
          .split('\n')
          .map((l) => (l === '' ? '>' : `> ${l}`))
          .join('\n') + '\n'
      );
    }
    case 'codeBlock': {
      const language =
        typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const text = (node.content ?? [])
        .map((n) => n.text ?? '')
        .join('')
        .replace(/\n$/, '');
      return `\`\`\`${language}\n${text}\n\`\`\`\n`;
    }
    case 'bulletList': {
      const items = (node.content ?? [])
        .filter((n) => n.type === 'listItem')
        .map((n) => serializeListItem(n, '-').trimEnd());
      return items.join('\n') + '\n';
    }
    case 'orderedList': {
      const start =
        typeof node.attrs?.start === 'number' ? node.attrs.start : 1;
      const items = (node.content ?? [])
        .filter((n) => n.type === 'listItem')
        .map((n, idx) => serializeListItem(n, `${start + idx}.`).trimEnd());
      return items.join('\n') + '\n';
    }
    case 'horizontalRule':
      return '---\n';
    case 'listItem':
      // Stray listItem outside a list — render as a bullet.
      return serializeListItem(node, '-');
    default:
      // Unknown block — best-effort: serialize children as blocks.
      return (node.content ?? []).map((n) => serializeBlock(n)).join('');
  }
}

export function serializeDocToMarkdown(
  doc: JSONNode | null | undefined,
): string {
  if (!doc || doc.type !== 'doc') return '';
  const blocks = doc.content ?? [];
  // Join blocks with a blank line so paragraphs/headings/etc. are
  // separated as readers expect.
  const out = blocks.map((n) => serializeBlock(n).trimEnd()).join('\n\n');
  return out.trim() + (out.trim() ? '\n' : '');
}
