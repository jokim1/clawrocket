import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserServiceMocks = vi.hoisted(() => ({
  service: {
    open: vi.fn(),
    snapshot: vi.fn(),
    act: vi.fn(),
    wait: vi.fn(),
    screenshot: vi.fn(),
    close: vi.fn(),
  },
}));

vi.mock('../browser/service.js', () => ({
  getBrowserService: () => browserServiceMocks.service,
}));

import { getDb } from '../../db.js';
import {
  _initTestDatabase,
  createTalkRun,
  getTalkStateEntry,
  listTalkOutputs,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { executeBrowserTool } from './browser-tools.js';

const TALK_ID = 'talk-browser-tools';
const THREAD_ID = 'thread-browser-tools';

function createRun(runId: string): void {
  const now = new Date().toISOString();
  createTalkRun({
    id: runId,
    talk_id: TALK_ID,
    thread_id: THREAD_ID,
    requested_by: 'owner-1',
    status: 'running',
    trigger_message_id: null,
    target_agent_id: null,
    idempotency_key: null,
    response_group_id: null,
    sequence_index: null,
    executor_alias: null,
    executor_model: null,
    source_binding_id: null,
    source_external_message_id: null,
    source_thread_key: null,
    created_at: now,
    started_at: now,
    ended_at: null,
    cancel_reason: null,
  });
}

describe('browser-tools', () => {
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
      topicTitle: 'Browser Tool Tests',
    });

    browserServiceMocks.service.open.mockReset();
    browserServiceMocks.service.snapshot.mockReset();
    browserServiceMocks.service.act.mockReset();
    browserServiceMocks.service.wait.mockReset();
    browserServiceMocks.service.screenshot.mockReset();
    browserServiceMocks.service.close.mockReset();
  });

  it('returns setupCommand and records Talk state when browser_open needs auth', async () => {
    createRun('run-browser-open');
    browserServiceMocks.service.open.mockResolvedValue({
      status: 'needs_auth',
      siteKey: 'linkedin',
      accountLabel: null,
      sessionId: 'bs_linkedin',
      url: 'https://www.linkedin.com/checkpoint/challenge',
      title: 'LinkedIn Login',
      reusedSession: false,
      createdProfile: true,
      message:
        'This site requires interactive authentication for this profile.',
    });

    const result = await executeBrowserTool({
      toolName: 'browser_open',
      args: {
        siteKey: 'linkedin',
        url: 'https://www.linkedin.com/messaging/',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-open',
        userId: 'owner-1',
        talkId: TALK_ID,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.result)).toMatchObject({
      status: 'needs_auth',
      siteKey: 'linkedin',
      setupCommand: expect.stringContaining(
        "src/clawrocket/browser/setup.ts --site 'linkedin'",
      ),
    });

    expect(getTalkStateEntry(TALK_ID, 'browser.profile')?.value).toMatchObject({
      siteKey: 'linkedin',
      accountLabel: null,
    });
    expect(getTalkStateEntry(TALK_ID, 'browser.last')?.value).toMatchObject({
      status: 'needs_auth',
      url: 'https://www.linkedin.com/checkpoint/challenge',
    });
    expect(getTalkStateEntry(TALK_ID, 'browser.pending')?.value).toMatchObject({
      reason: 'auth_required',
      siteKey: 'linkedin',
      actionSummary: 'Open https://www.linkedin.com/checkpoint/challenge',
    });
    expect(listTalkOutputs(TALK_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Browser auth required: linkedin',
        }),
      ]),
    );
  });

  it('records confirmation-required browser_act results in Talk state and outputs', async () => {
    createRun('run-browser-act');
    browserServiceMocks.service.act.mockResolvedValue({
      status: 'awaiting_confirmation',
      siteKey: 'delta',
      accountLabel: null,
      url: 'https://www.delta.com/checkout/review',
      title: 'Review Trip',
      message: 'Action requires confirmation before proceeding.',
      riskReason: 'Target appears to be a likely final-action control.',
    });

    const result = await executeBrowserTool({
      toolName: 'browser_act',
      args: {
        sessionId: 'bs_delta',
        action: 'click',
        target: 'e12',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-act',
        userId: 'owner-1',
        talkId: TALK_ID,
      },
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.result)).toMatchObject({
      status: 'awaiting_confirmation',
      siteKey: 'delta',
      riskReason: 'Target appears to be a likely final-action control.',
    });

    expect(getTalkStateEntry(TALK_ID, 'browser.pending')?.value).toMatchObject({
      reason: 'confirmation_required',
      siteKey: 'delta',
      actionSummary: 'click target=e12',
      riskReason: 'Target appears to be a likely final-action control.',
    });
    expect(listTalkOutputs(TALK_ID)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Browser confirmation required: delta',
        }),
      ]),
    );
  });

  it('persists browser screenshots into Talk attachments when requested', async () => {
    createRun('run-browser-screenshot');
    browserServiceMocks.service.screenshot.mockResolvedValue({
      status: 'ok',
      siteKey: 'irs',
      accountLabel: null,
      url: 'https://www.irs.gov/forms',
      title: 'IRS Forms',
      path: '/tmp/browser-screenshot.png',
      contentType: 'image/png',
      content: Buffer.from('png-bytes'),
    });

    const result = await executeBrowserTool({
      toolName: 'browser_screenshot',
      args: {
        sessionId: 'bs_irs',
        saveToTalk: true,
        label: 'irs-form',
      },
      context: {
        signal: new AbortController().signal,
        runId: 'run-browser-screenshot',
        userId: 'owner-1',
        talkId: TALK_ID,
      },
    });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.result) as {
      artifact: { attachmentId: string; fileName: string };
    };
    expect(parsed.artifact.fileName).toBe('irs-form.png');

    const attachmentRow = getDb()
      .prepare(
        `SELECT mime_type, file_name, extraction_status FROM talk_message_attachments WHERE id = ?`,
      )
      .get(parsed.artifact.attachmentId) as
      | {
          mime_type: string;
          file_name: string;
          extraction_status: string;
        }
      | undefined;

    expect(attachmentRow).toEqual({
      mime_type: 'image/png',
      file_name: 'irs-form.png',
      extraction_status: 'ready',
    });
  });
});
