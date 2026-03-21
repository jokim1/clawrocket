import { randomUUID } from 'crypto';

import { getDb } from '../../db.js';
import type {
  BrowserBlockMetadata,
  ExecutionDecisionMetadata,
  BrowserResumeMetadata,
} from '../browser/metadata.js';
import {
  appendOutboxEvent,
  getTalkRunById,
  type TalkRunRecord,
} from './accessors.js';

function parseMetadata(
  metadataJson: string | null | undefined,
): Record<string, unknown> {
  if (!metadataJson) return {};
  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return {};
}

function parseMetadataField<T>(
  metadataJson: string | null | undefined,
  key: string,
): T | null {
  const metadata = parseMetadata(metadataJson);
  const value = metadata[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as T;
}

function runTopic(run: TalkRunRecord): string {
  return run.talk_id ? `talk:${run.talk_id}` : `user:${run.requested_by}`;
}

function serializeMetadata(
  run: TalkRunRecord,
  updater: (current: Record<string, unknown>) => Record<string, unknown>,
): string {
  const nextValue = updater(parseMetadata(run.metadata_json));
  return JSON.stringify(nextValue);
}

export function createRunConfirmation(input: {
  runId: string;
  talkId?: string | null;
  toolId: string;
  actionSummary: string;
  metadata?: Record<string, unknown> | null;
}): string {
  const id = `confirm_${randomUUID()}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      INSERT INTO run_confirmations (
        id,
        run_id,
        talk_id,
        tool_id,
        action_summary,
        status,
        metadata_json,
        created_at,
        resolved_at,
        resolved_by
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
    `,
    )
    .run(
      id,
      input.runId,
      input.talkId ?? null,
      input.toolId,
      input.actionSummary,
      input.metadata ? JSON.stringify(input.metadata) : null,
      now,
    );
  return id;
}

export function getBrowserBlockForRun(
  runId: string,
): BrowserBlockMetadata | null {
  const run = getTalkRunById(runId);
  if (!run) return null;
  return parseMetadataField<BrowserBlockMetadata>(
    run.metadata_json,
    'browserBlock',
  );
}

export function getExecutionDecisionForRun(
  runId: string,
): ExecutionDecisionMetadata | null {
  const run = getTalkRunById(runId);
  if (!run) return null;
  return parseMetadataField<ExecutionDecisionMetadata>(
    run.metadata_json,
    'executionDecision',
  );
}

export function pauseRunForBrowserBlock(input: {
  runId: string;
  browserBlock: BrowserBlockMetadata;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run) {
        return { applied: false, run: null };
      }
      if (
        run.status !== 'running' &&
        run.status !== 'queued' &&
        run.status !== 'awaiting_confirmation'
      ) {
        return { applied: false, run };
      }

      const metadataJson = serializeMetadata(run, (current) => ({
        ...current,
        browserBlock: txInput.browserBlock,
      }));

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'awaiting_confirmation',
              metadata_json = ?,
              cancel_reason = NULL
          WHERE id = ?
        `,
        )
        .run(metadataJson, run.id);

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_blocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserBlock: txInput.browserBlock,
        }),
      });

      return {
        applied: true,
        run: {
          ...run,
          status: 'awaiting_confirmation',
          metadata_json: metadataJson,
        },
      };
    },
  );

  return tx(input);
}

export function resumeBrowserBlockedRun(input: {
  runId: string;
  resumedBy: string;
  browserResume: BrowserResumeMetadata;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.status !== 'awaiting_confirmation') {
        return { applied: false, run: run || null };
      }

      const metadataJson = serializeMetadata(run, (current) => {
        const next = { ...current };
        delete next.browserBlock;
        return {
          ...next,
          browserResume: txInput.browserResume,
        };
      });

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'queued',
              cancel_reason = NULL,
              ended_at = NULL,
              metadata_json = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `,
        )
        .run(metadataJson, run.id);

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_unblocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserResume: txInput.browserResume,
        }),
      });
      appendOutboxEvent({
        topic: runTopic(run),
        eventType: run.talk_id ? 'talk_run_queued' : 'main_run_queued',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          status: 'queued',
        }),
      });

      return {
        applied: true,
        run: {
          ...run,
          status: 'queued',
          metadata_json: metadataJson,
          cancel_reason: null,
          ended_at: null,
        },
      };
    },
  );
  return tx(input);
}

export function rejectBrowserBlockedRun(input: {
  runId: string;
  rejectedBy: string;
  browserResume: BrowserResumeMetadata;
  cancelReason?: string;
}): { applied: boolean; run: TalkRunRecord | null } {
  const tx = getDb().transaction(
    (
      txInput: typeof input,
    ): { applied: boolean; run: TalkRunRecord | null } => {
      const run = getTalkRunById(txInput.runId);
      if (!run || run.status !== 'awaiting_confirmation') {
        return { applied: false, run: run || null };
      }

      const metadataJson = serializeMetadata(run, (current) => {
        const next = { ...current };
        delete next.browserBlock;
        return {
          ...next,
          browserResume: txInput.browserResume,
        };
      });
      const now = new Date().toISOString();

      getDb()
        .prepare(
          `
          UPDATE talk_runs
          SET status = 'cancelled',
              ended_at = ?,
              cancel_reason = ?,
              metadata_json = ?
          WHERE id = ? AND status = 'awaiting_confirmation'
        `,
        )
        .run(
          now,
          txInput.cancelReason || 'browser_confirmation_rejected',
          metadataJson,
          run.id,
        );

      appendOutboxEvent({
        topic: runTopic(run),
        eventType: 'browser_unblocked',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          browserResume: txInput.browserResume,
        }),
      });
      appendOutboxEvent({
        topic: runTopic(run),
        eventType: run.talk_id ? 'talk_run_cancelled' : 'main_run_cancelled',
        payload: JSON.stringify({
          runId: run.id,
          talkId: run.talk_id,
          threadId: run.thread_id,
          cancelReason: txInput.cancelReason || 'browser_confirmation_rejected',
        }),
      });

      return {
        applied: true,
        run: {
          ...run,
          status: 'cancelled',
          ended_at: now,
          cancel_reason:
            txInput.cancelReason || 'browser_confirmation_rejected',
          metadata_json: metadataJson,
        },
      };
    },
  );
  return tx(input);
}

export function resolveRunConfirmation(input: {
  confirmationId: string;
  status: 'approved' | 'rejected';
  resolvedBy: string;
}): boolean {
  const now = new Date().toISOString();
  const result = getDb()
    .prepare(
      `
      UPDATE run_confirmations
      SET status = ?,
          resolved_at = ?,
          resolved_by = ?
      WHERE id = ? AND status = 'pending'
    `,
    )
    .run(input.status, now, input.resolvedBy, input.confirmationId);
  return result.changes === 1;
}

export function getPendingRunConfirmationById(confirmationId: string): {
  id: string;
  run_id: string;
  talk_id: string | null;
  tool_id: string;
  action_summary: string;
  metadata_json: string | null;
} | null {
  const row = getDb()
    .prepare(
      `
      SELECT id, run_id, talk_id, tool_id, action_summary, metadata_json
      FROM run_confirmations
      WHERE id = ? AND status = 'pending'
      LIMIT 1
    `,
    )
    .get(confirmationId) as
    | {
        id: string;
        run_id: string;
        talk_id: string | null;
        tool_id: string;
        action_summary: string;
        metadata_json: string | null;
      }
    | undefined;
  return row || null;
}
