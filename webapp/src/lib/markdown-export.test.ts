import { describe, expect, it } from 'vitest';

import { serializeDocToMarkdown, type JSONNode } from './markdown-export';

function doc(...content: JSONNode[]): JSONNode {
  return { type: 'doc', content };
}

function p(...content: JSONNode[]): JSONNode {
  return { type: 'paragraph', content };
}

function text(
  value: string,
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>,
): JSONNode {
  return marks
    ? { type: 'text', text: value, marks }
    : { type: 'text', text: value };
}

describe('serializeDocToMarkdown', () => {
  it('returns empty string for null/undefined/non-doc', () => {
    expect(serializeDocToMarkdown(null)).toBe('');
    expect(serializeDocToMarkdown(undefined)).toBe('');
    expect(serializeDocToMarkdown({ type: 'paragraph' })).toBe('');
  });

  it('serializes empty doc to empty string', () => {
    expect(serializeDocToMarkdown(doc())).toBe('');
  });

  it('renders a heading at the requested level', () => {
    const out = serializeDocToMarkdown(
      doc({ type: 'heading', attrs: { level: 2 }, content: [text('Hello')] }),
    );
    expect(out).toBe('## Hello\n');
  });

  it('clamps heading levels to [1, 6]', () => {
    const tooHigh = serializeDocToMarkdown(
      doc({ type: 'heading', attrs: { level: 9 }, content: [text('X')] }),
    );
    expect(tooHigh).toBe('###### X\n');
    const tooLow = serializeDocToMarkdown(
      doc({ type: 'heading', attrs: { level: 0 }, content: [text('X')] }),
    );
    expect(tooLow).toBe('# X\n');
  });

  it('renders paragraphs separated by blank lines', () => {
    const out = serializeDocToMarkdown(
      doc(p(text('First.')), p(text('Second.'))),
    );
    expect(out).toBe('First.\n\nSecond.\n');
  });

  it('applies bold, italic, code, strike, and link marks', () => {
    const out = serializeDocToMarkdown(
      doc(
        p(
          text('plain '),
          text('bold', [{ type: 'bold' }]),
          text(' '),
          text('italic', [{ type: 'italic' }]),
          text(' '),
          text('code', [{ type: 'code' }]),
          text(' '),
          text('strike', [{ type: 'strike' }]),
          text(' '),
          text('link', [
            { type: 'link', attrs: { href: 'https://example.com' } },
          ]),
        ),
      ),
    );
    expect(out).toBe(
      'plain **bold** *italic* `code` ~~strike~~ [link](https://example.com)\n',
    );
  });

  it('nests combined marks in a stable order', () => {
    const out = serializeDocToMarkdown(
      doc(p(text('hi', [{ type: 'bold' }, { type: 'italic' }]))),
    );
    // Italic is innermost (applied first), bold wraps it.
    expect(out).toBe('***hi***\n');
  });

  it('drops link mark when href is missing', () => {
    const out = serializeDocToMarkdown(
      doc(p(text('orphan', [{ type: 'link', attrs: {} }]))),
    );
    expect(out).toBe('orphan\n');
  });

  it('renders hard breaks as two trailing spaces + newline', () => {
    const out = serializeDocToMarkdown(
      doc(p(text('line one'), { type: 'hardBreak' }, text('line two'))),
    );
    expect(out).toBe('line one  \nline two\n');
  });

  it('renders blockquotes with line prefixes', () => {
    const out = serializeDocToMarkdown(
      doc({
        type: 'blockquote',
        content: [p(text('First.')), p(text('Second.'))],
      }),
    );
    expect(out).toBe('> First.\n>\n> Second.\n');
  });

  it('renders fenced code blocks with language', () => {
    const out = serializeDocToMarkdown(
      doc({
        type: 'codeBlock',
        attrs: { language: 'ts' },
        content: [text('const x = 1;')],
      }),
    );
    expect(out).toBe('```ts\nconst x = 1;\n```\n');
  });

  it('renders fenced code blocks without language', () => {
    const out = serializeDocToMarkdown(
      doc({ type: 'codeBlock', content: [text('plain')] }),
    );
    expect(out).toBe('```\nplain\n```\n');
  });

  it('renders bullet lists', () => {
    const out = serializeDocToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(text('one'))] },
          { type: 'listItem', content: [p(text('two'))] },
        ],
      }),
    );
    expect(out).toBe('- one\n- two\n');
  });

  it('renders ordered lists with a custom start', () => {
    const out = serializeDocToMarkdown(
      doc({
        type: 'orderedList',
        attrs: { start: 3 },
        content: [
          { type: 'listItem', content: [p(text('three'))] },
          { type: 'listItem', content: [p(text('four'))] },
        ],
      }),
    );
    expect(out).toBe('3. three\n4. four\n');
  });

  it('renders horizontal rules', () => {
    const out = serializeDocToMarkdown(
      doc(p(text('above')), { type: 'horizontalRule' }, p(text('below'))),
    );
    expect(out).toBe('above\n\n---\n\nbelow\n');
  });

  it('round-trips a small mixed document', () => {
    const out = serializeDocToMarkdown(
      doc(
        { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
        p(text('Intro paragraph.')),
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [p(text('First'))] },
            { type: 'listItem', content: [p(text('Second'))] },
          ],
        },
        {
          type: 'blockquote',
          content: [p(text('Quoted line.'))],
        },
        { type: 'horizontalRule' },
        p(text('Closing.')),
      ),
    );
    expect(out).toBe(
      [
        '# Title',
        '',
        'Intro paragraph.',
        '',
        '- First',
        '- Second',
        '',
        '> Quoted line.',
        '',
        '---',
        '',
        'Closing.',
        '',
      ].join('\n'),
    );
  });
});
