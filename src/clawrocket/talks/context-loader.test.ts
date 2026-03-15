import { beforeEach, describe, expect, it } from 'vitest';
import {
  _initTestDatabase,
  createMessage,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { loadTalkContext } from './context-loader.js';
import { buildToolExecutor } from './new-executor.js';
import { getDb } from '../../db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TALK_ID = 'talk-ctx-loader';

function insertSource(opts: {
  id: string;
  sourceRef: string;
  sourceType: string;
  title: string;
  extractedText?: string | null;
  sourceUrl?: string | null;
  status?: string;
  sortOrder?: number;
}) {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO talk_context_sources (
        id, talk_id, source_ref, source_type, title, source_url,
        extracted_text, status, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      opts.id,
      TALK_ID,
      opts.sourceRef,
      opts.sourceType,
      opts.title,
      opts.sourceUrl ?? null,
      opts.extractedText ?? null,
      opts.status ?? 'ready',
      opts.sortOrder ?? 0,
      now,
      now,
    );
}

function insertTalkMessage(opts: {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string;
  createdBy?: string | null;
}) {
  createMessage({
    id: opts.id,
    talkId: TALK_ID,
    role: opts.role,
    content: opts.content,
    createdBy: opts.createdBy ?? null,
    createdAt: opts.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('context-loader', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: TALK_ID,
      ownerId: 'owner-1',
      topicTitle: 'Context Loader Test Talk',
    });
  });

  // =========================================================================
  // Source manifest: stable refs from DB
  // =========================================================================

  describe('source manifest uses stable source_ref from DB', () => {
    it('uses S1, S2 refs in the system prompt, not src-1, src-2', async () => {
      insertSource({
        id: 'src-id-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Meeting Notes',
        extractedText: 'Some notes content here.',
      });
      insertSource({
        id: 'src-id-2',
        sourceRef: 'S2',
        sourceType: 'url',
        title: 'Docs page',
        sourceUrl: 'https://example.com/docs',
        extractedText: 'Page content',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // System prompt should reference stable refs
      expect(ctx.systemPrompt).toContain('[S1]');
      expect(ctx.systemPrompt).toContain('[S2]');
      expect(ctx.systemPrompt).not.toContain('[src-1]');
      expect(ctx.systemPrompt).not.toContain('[src-2]');
    });

    it('preserves non-contiguous refs after deletion (e.g., S1, S4)', async () => {
      insertSource({
        id: 'src-id-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'First Source',
        extractedText: 'Content 1',
        sortOrder: 0,
      });
      insertSource({
        id: 'src-id-4',
        sourceRef: 'S4',
        sourceType: 'text',
        title: 'Fourth Source',
        extractedText: 'Content 4',
        sortOrder: 1,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('[S1]');
      expect(ctx.systemPrompt).toContain('[S4]');
      expect(ctx.systemPrompt).not.toContain('[S2]');
      expect(ctx.systemPrompt).not.toContain('[S3]');
    });
  });

  // =========================================================================
  // Context tools: schema declares sourceRef
  // =========================================================================

  describe('context tools schema', () => {
    it('read_context_source tool requires sourceRef parameter', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000);

      const readSourceTool = ctx.contextTools.find(
        (t) => t.name === 'read_context_source',
      );
      expect(readSourceTool).toBeDefined();
      expect(readSourceTool!.inputSchema.required).toContain('sourceRef');
      expect(readSourceTool!.inputSchema.properties).toHaveProperty(
        'sourceRef',
      );
      // Should NOT have a 'ref' property — that was the old broken name
      expect(readSourceTool!.inputSchema.properties).not.toHaveProperty('ref');
    });

    it('tool description references stable S# format', async () => {
      const ctx = await loadTalkContext(TALK_ID, 128000);
      const readSourceTool = ctx.contextTools.find(
        (t) => t.name === 'read_context_source',
      );
      expect(readSourceTool!.description).toMatch(/S\d/);
      expect(readSourceTool!.description).not.toContain('src-1');
    });
  });

  // =========================================================================
  // System prompt assembly
  // =========================================================================

  describe('system prompt assembly', () => {
    it('includes goal, rules, and sources', async () => {
      // Set goal
      getDb()
        .prepare(
          `INSERT INTO talk_context_goal (talk_id, goal_text, updated_at) VALUES (?, ?, ?)`,
        )
        .run(TALK_ID, 'Help with onboarding', new Date().toISOString());

      // Add rule
      const now = new Date().toISOString();
      getDb()
        .prepare(
          `INSERT INTO talk_context_rules (id, talk_id, rule_text, is_active, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 0, ?, ?)`,
        )
        .run('rule-1', TALK_ID, 'Use simple language', now, now);

      // Add source
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Notes',
        extractedText: 'Short note.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('Help with onboarding');
      expect(ctx.systemPrompt).toContain('Use simple language');
      expect(ctx.systemPrompt).toContain('[S1] Notes');
    });

    it('inlines small text sources', async () => {
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Tiny Note',
        extractedText: 'This is tiny.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // Small text should be inlined in the system prompt
      expect(ctx.systemPrompt).toContain('This is tiny.');
    });

    it('does not inline large text sources', async () => {
      const bigText = 'x'.repeat(1100); // ~275 tokens, exceeds 250 threshold
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Big Text',
        extractedText: bigText,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      // Should be in manifest but not inlined
      expect(ctx.systemPrompt).toContain('[S1] Big Text');
      expect(ctx.systemPrompt).not.toContain(bigText);
    });

    it('inlines multiple individually-small text sources', async () => {
      const text200 = 'y'.repeat(800); // ~200 tokens each, below per-item threshold
      insertSource({
        id: 'src-a',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Text A',
        extractedText: text200,
        sortOrder: 0,
      });
      insertSource({
        id: 'src-b',
        sourceRef: 'S2',
        sourceType: 'text',
        title: 'Text B',
        extractedText: text200,
        sortOrder: 1,
      });
      insertSource({
        id: 'src-c',
        sourceRef: 'S3',
        sourceType: 'text',
        title: 'Text C',
        extractedText: text200,
        sortOrder: 2,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain('[S1] Content:');
      expect(ctx.systemPrompt).toContain('[S2] Content:');
      expect(ctx.systemPrompt).toContain('[S3] Content:');
    });

    it('does not inline URL or file sources even when extracted text is small', async () => {
      insertSource({
        id: 'src-url',
        sourceRef: 'S1',
        sourceType: 'url',
        title: 'URL Source',
        sourceUrl: 'https://example.com/url',
        extractedText: 'Small URL text',
        sortOrder: 0,
      });
      insertSource({
        id: 'src-file',
        sourceRef: 'S2',
        sourceType: 'file',
        title: 'File Source',
        extractedText: 'Small file text',
        sortOrder: 1,
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);

      expect(ctx.systemPrompt).toContain(
        '[S1] URL Source - https://example.com/url',
      );
      expect(ctx.systemPrompt).toContain('[S2] File Source');
      expect(ctx.systemPrompt).not.toContain('Small URL text');
      expect(ctx.systemPrompt).not.toContain('Small file text');
      expect(ctx.systemPrompt).not.toContain('[S1] Content:');
      expect(ctx.systemPrompt).not.toContain('[S2] Content:');
    });
  });

  // =========================================================================
  // Metadata
  // =========================================================================

  describe('metadata', () => {
    it('reports correct source and history counts', async () => {
      insertSource({
        id: 'src-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Note',
        extractedText: 'Content.',
      });

      const ctx = await loadTalkContext(TALK_ID, 128000);
      expect(ctx.metadata.sourceCount).toBe(1);
      expect(ctx.metadata.talkId).toBe(TALK_ID);
    });
  });

  // =========================================================================
  // History budgeting
  // =========================================================================

  describe('history budgeting', () => {
    it('keeps the newest messages within budget and preserves chronological order', async () => {
      insertTalkMessage({
        id: 'msg-1',
        role: 'user',
        content: 'A'.repeat(120),
        createdAt: '2026-03-14T00:00:01.000Z',
        createdBy: 'owner-1',
      });
      insertTalkMessage({
        id: 'msg-2',
        role: 'assistant',
        content: 'B'.repeat(120),
        createdAt: '2026-03-14T00:00:02.000Z',
      });
      insertTalkMessage({
        id: 'msg-3',
        role: 'user',
        content: 'C'.repeat(120),
        createdAt: '2026-03-14T00:00:03.000Z',
        createdBy: 'owner-1',
      });
      insertTalkMessage({
        id: 'msg-4',
        role: 'assistant',
        content: 'D'.repeat(120),
        createdAt: '2026-03-14T00:00:04.000Z',
      });

      const ctx = await loadTalkContext(TALK_ID, 6156);

      expect(ctx.history).toHaveLength(2);
      expect(ctx.history[0].content).toBe('C'.repeat(120));
      expect(ctx.history[1].content).toBe('D'.repeat(120));
    });

    it('returns no history when the available budget is exhausted', async () => {
      insertTalkMessage({
        id: 'msg-5',
        role: 'user',
        content: 'This message should be trimmed out by a tiny budget.',
        createdAt: '2026-03-14T00:00:05.000Z',
        createdBy: 'owner-1',
      });

      const ctx = await loadTalkContext(TALK_ID, 6000);

      expect(ctx.history).toEqual([]);
    });
  });

  // =========================================================================
  // Executor tool path: buildToolExecutor end-to-end
  // =========================================================================

  describe('buildToolExecutor (read_context_source)', () => {
    it('resolves a source by stable sourceRef and returns extracted_text', async () => {
      insertSource({
        id: 'src-uuid-1',
        sourceRef: 'S1',
        sourceType: 'text',
        title: 'Meeting Notes',
        extractedText: 'We discussed Q4 targets.',
      });

      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', { sourceRef: 'S1' });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('We discussed Q4 targets.');
    });

    it('resolves a source by row ID as fallback', async () => {
      insertSource({
        id: 'src-uuid-2',
        sourceRef: 'S2',
        sourceType: 'url',
        title: 'Docs',
        sourceUrl: 'https://example.com',
        extractedText: 'Page content here.',
      });

      // The SQL uses (id = ? OR source_ref = ?), so passing the row ID works
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', {
        sourceRef: 'src-uuid-2',
      });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('Page content here.');
    });

    it('returns error when sourceRef is missing', async () => {
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', {});

      expect(result.isError).toBe(true);
      expect(result.result).toContain('sourceRef');
    });

    it('returns error for non-existent source ref', async () => {
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', {
        sourceRef: 'S99',
      });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });

    it('returns empty string when extracted_text is null', async () => {
      insertSource({
        id: 'src-uuid-3',
        sourceRef: 'S3',
        sourceType: 'url',
        title: 'Pending URL',
        sourceUrl: 'https://example.com/pending',
        extractedText: null,
      });

      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', { sourceRef: 'S3' });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('');
    });

    it('does NOT resolve when using old "ref" parameter name', async () => {
      insertSource({
        id: 'src-uuid-4',
        sourceRef: 'S4',
        sourceType: 'text',
        title: 'Note',
        extractedText: 'Some content.',
      });

      // Simulate what a model would send if it used the old parameter name
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_context_source', { ref: 'S4' });

      // Should fail because the executor reads args.sourceRef, not args.ref
      expect(result.isError).toBe(true);
      expect(result.result).toContain('sourceRef');
    });
  });

  // =========================================================================
  // Executor tool path: buildToolExecutor (read_attachment)
  // =========================================================================

  describe('buildToolExecutor (read_attachment)', () => {
    it('resolves an attachment by ID and returns extracted_text', async () => {
      const now = new Date().toISOString();
      // Insert a parent message first (FK requirement)
      getDb()
        .prepare(
          `INSERT INTO talk_messages (id, talk_id, role, content, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('msg-1', TALK_ID, 'user', 'See attached', now);
      getDb()
        .prepare(
          `INSERT INTO talk_message_attachments (
            id, talk_id, message_id, file_name, mime_type, storage_key, extracted_text, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'att-1',
          TALK_ID,
          'msg-1',
          'report.pdf',
          'application/pdf',
          'store/att-1',
          'PDF content here.',
          now,
        );

      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_attachment', {
        attachmentId: 'att-1',
      });

      expect(result.isError).toBeFalsy();
      expect(result.result).toBe('PDF content here.');
    });

    it('returns error for non-existent attachment', async () => {
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('read_attachment', {
        attachmentId: 'no-such',
      });

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not found');
    });
  });

  // =========================================================================
  // Executor tool path: unknown tools
  // =========================================================================

  describe('buildToolExecutor (unknown tools)', () => {
    it('returns error for unknown tool names', async () => {
      const executor = buildToolExecutor(TALK_ID, AbortSignal.timeout(5000));
      const result = await executor('some_random_tool', {});

      expect(result.isError).toBe(true);
      expect(result.result).toContain('not available');
    });
  });
});
