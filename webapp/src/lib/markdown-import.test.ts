import { describe, expect, it } from 'vitest';

import { serializeDocToMarkdown, type JSONNode } from './markdown-export';
import { parseInline, parseMarkdownToDoc } from './markdown-import';

describe('parseMarkdownToDoc — block coverage', () => {
  it('returns an empty doc for empty input', () => {
    expect(parseMarkdownToDoc('')).toEqual({ type: 'doc', content: [] });
  });

  it('parses a heading with the right level', () => {
    expect(parseMarkdownToDoc('## Hello')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Hello' }],
        },
      ],
    });
  });

  it('parses paragraphs separated by blank lines', () => {
    const out = parseMarkdownToDoc('First paragraph.\n\nSecond paragraph.');
    expect(out.content).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'First paragraph.' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Second paragraph.' }],
      },
    ]);
  });

  it('parses a horizontal rule', () => {
    const out = parseMarkdownToDoc('above\n\n---\n\nbelow');
    expect(out.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
      { type: 'horizontalRule' },
      { type: 'paragraph', content: [{ type: 'text', text: 'below' }] },
    ]);
  });

  it('parses a bullet list', () => {
    const out = parseMarkdownToDoc('- one\n- two\n- three');
    expect(out.content?.[0].type).toBe('bulletList');
    expect(out.content?.[0].content).toHaveLength(3);
  });

  it('parses an ordered list and preserves the start index', () => {
    const out = parseMarkdownToDoc('3. three\n4. four');
    expect(out.content?.[0]).toEqual({
      type: 'orderedList',
      attrs: { start: 3 },
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'three' }],
            },
          ],
        },
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'four' }],
            },
          ],
        },
      ],
    });
  });

  it('parses a blockquote with multiple lines', () => {
    const out = parseMarkdownToDoc('> First.\n>\n> Second.');
    const quote = out.content?.[0];
    expect(quote?.type).toBe('blockquote');
    expect(quote?.content).toHaveLength(2);
    expect(quote?.content?.[0].type).toBe('paragraph');
  });

  it('parses a fenced code block with language', () => {
    const out = parseMarkdownToDoc('```ts\nconst x = 1;\n```');
    expect(out.content?.[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'ts' },
      content: [{ type: 'text', text: 'const x = 1;' }],
    });
  });

  it('parses a fenced code block without language', () => {
    const out = parseMarkdownToDoc('```\nplain\n```');
    expect(out.content?.[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: null },
      content: [{ type: 'text', text: 'plain' }],
    });
  });
});

describe('parseInline — mark coverage', () => {
  it('returns a plain text node for unmarked content', () => {
    expect(parseInline('hello world')).toEqual([
      { type: 'text', text: 'hello world' },
    ]);
  });

  it('parses a single bold span', () => {
    expect(parseInline('say **hi** there')).toEqual([
      { type: 'text', text: 'say ' },
      { type: 'text', text: 'hi', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' there' },
    ]);
  });

  it('parses a single italic span', () => {
    expect(parseInline('be *brave*')).toEqual([
      { type: 'text', text: 'be ' },
      { type: 'text', text: 'brave', marks: [{ type: 'italic' }] },
    ]);
  });

  it('parses an inline code span', () => {
    expect(parseInline('use `editor`')).toEqual([
      { type: 'text', text: 'use ' },
      { type: 'text', text: 'editor', marks: [{ type: 'code' }] },
    ]);
  });

  it('parses a strike span', () => {
    expect(parseInline('not ~~old~~ new')).toEqual([
      { type: 'text', text: 'not ' },
      { type: 'text', text: 'old', marks: [{ type: 'strike' }] },
      { type: 'text', text: ' new' },
    ]);
  });

  it('parses a link', () => {
    expect(parseInline('see [docs](https://example.com)')).toEqual([
      { type: 'text', text: 'see ' },
      {
        type: 'text',
        text: 'docs',
        marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
      },
    ]);
  });

  it('does not split mark inside inline code', () => {
    expect(parseInline('`**not bold**`')).toEqual([
      { type: 'text', text: '**not bold**', marks: [{ type: 'code' }] },
    ]);
  });
});

describe('round-trip — Tiptap → MD → Tiptap', () => {
  function rt(doc: JSONNode): JSONNode {
    const md = serializeDocToMarkdown(doc);
    return parseMarkdownToDoc(md);
  }

  it('round-trips a single paragraph', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Just one paragraph.' }],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips multiple paragraphs', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Third.' }] },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips headings + paragraphs', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Body line.' }],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Section' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'More body.' }],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips a bullet list', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'one' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'two' }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips an ordered list with custom start', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 5 },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'five' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'six' }],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips a code block', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'codeBlock',
          attrs: { language: 'ts' },
          content: [{ type: 'text', text: 'const x = 1;\nconst y = 2;' }],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips a horizontal rule', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
        { type: 'horizontalRule' },
        { type: 'paragraph', content: [{ type: 'text', text: 'below' }] },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips single inline marks (bold, italic, code, strike)', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' more ' },
            { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
            { type: 'text', text: ' more ' },
            { type: 'text', text: 'code', marks: [{ type: 'code' }] },
            { type: 'text', text: ' more ' },
            { type: 'text', text: 'strike', marks: [{ type: 'strike' }] },
          ],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips a link', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'see ' },
            {
              type: 'text',
              text: 'docs',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });

  it('round-trips the kickoff Embracer-style mixed document', () => {
    const doc: JSONNode = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Embracer reclassification' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'When Embracer wrote down 2.1B last quarter, indie studios noticed.',
            },
          ],
        },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: 'Three structural shifts' }],
        },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'MG reclassification' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Cohort split' }],
                },
              ],
            },
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'Recoupment creep' }],
                },
              ],
            },
          ],
        },
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'The reclassification IS the story.',
                },
              ],
            },
          ],
        },
        { type: 'horizontalRule' },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Closing thought.' }],
        },
      ],
    };
    expect(rt(doc)).toEqual(doc);
  });
});
