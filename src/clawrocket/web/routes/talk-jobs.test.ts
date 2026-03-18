import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../db.js';
import { createRegisteredAgent } from '../../db/agent-accessors.js';
import {
  _initTestDatabase,
  createTalkOutput,
  createTalkThread,
  upsertTalk,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';
import type { TalkContextSourceIngestionService } from '../../talks/source-ingestion.js';

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

async function json(res: Response) {
  return res.json() as Promise<Record<string, any>>;
}

function attachTalkAgent(talkId: string, agentId: string, nickname: string) {
  getDb()
    .prepare(
      `
      INSERT INTO talk_agents (
        id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
    )
    .run(`ta-${agentId}`, talkId, agentId, nickname);
}

describe('talk job routes', () => {
  let server: WebServerHandle;
  let sourceIngestion: TalkContextSourceIngestionService & {
    enqueueUrlSource: ReturnType<
      typeof vi.fn<(sourceId: string, url: string) => void>
    >;
  };
  let agentId: string;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'member',
    });
    upsertUser({
      id: 'outsider-1',
      email: 'outsider@example.com',
      displayName: 'Outsider',
      role: 'member',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Jobs Route Test',
    });
    createTalkThread({ talkId: 'talk-1', title: 'Default' });
    upsertTalkMember({
      talkId: 'talk-1',
      userId: 'viewer-1',
      role: 'viewer',
    });

    const agent = createRegisteredAgent({
      name: 'Growth Analyst',
      providerId: 'provider.openai',
      modelId: 'gpt-5-mini',
      systemPrompt: 'Analyze trends.',
    });
    agentId = agent.id;
    attachTalkAgent('talk-1', agent.id, agent.name);

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-viewer',
      userId: 'viewer-1',
      accessTokenHash: hashSessionToken('viewer-token'),
      refreshTokenHash: hashSessionToken('viewer-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-outsider',
      userId: 'outsider-1',
      accessTokenHash: hashSessionToken('outsider-token'),
      refreshTokenHash: hashSessionToken('outsider-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    sourceIngestion = {
      enqueueUrlSource: vi.fn<(sourceId: string, url: string) => void>(),
    };
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      sourceIngestion,
    });
  });

  it('creates a report job with createReport, lists it, and can queue it immediately', async () => {
    const createRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'POST',
      headers: authHeaders('owner-token'),
      body: JSON.stringify({
        title: 'Daily FTUE Brief',
        prompt: 'Check FTUE metrics and summarize changes.',
        targetAgentId: agentId,
        schedule: {
          kind: 'weekly',
          weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
          hour: 9,
          minute: 0,
        },
        timezone: 'America/Los_Angeles',
        deliverableKind: 'report',
        createReport: {
          title: 'FTUE Retention Report',
          contentMarkdown: '',
        },
        sourceScope: {
          connectorIds: [],
          channelBindingIds: [],
          allowWeb: true,
        },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await json(createRes);
    const jobId = created.data.job.id as string;
    expect(created.data.job.reportOutputId).toBeTruthy();

    const listRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'GET',
      headers: authHeaders('owner-token'),
    });
    expect(listRes.status).toBe(200);
    const listBody = await json(listRes);
    expect(listBody.data.jobs).toHaveLength(1);
    expect(listBody.data.jobs[0].title).toBe('Daily FTUE Brief');

    const runNowRes = await server.request(
      `/api/v1/talks/talk-1/jobs/${jobId}/run-now`,
      {
        method: 'POST',
        headers: authHeaders('owner-token'),
      },
    );
    expect(runNowRes.status).toBe(202);
    const runNowBody = await json(runNowRes);
    expect(runNowBody.data.runId).toBeTruthy();
  });

  it('blocks non-members from reading jobs and viewers from mutating them', async () => {
    const outsiderRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'GET',
      headers: authHeaders('outsider-token'),
    });
    expect(outsiderRes.status).toBe(404);

    const viewerRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'POST',
      headers: authHeaders('viewer-token'),
      body: JSON.stringify({
        title: 'Should fail',
        prompt: 'Nope',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 24 },
        timezone: 'America/Los_Angeles',
        deliverableKind: 'thread',
        sourceScope: {
          connectorIds: [],
          channelBindingIds: [],
          allowWeb: false,
        },
      }),
    });
    expect(viewerRes.status).toBe(403);
  });

  it('rejects invalid scope references and supports pause/resume for valid jobs', async () => {
    const invalidCreateRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'POST',
      headers: authHeaders('owner-token'),
      body: JSON.stringify({
        title: 'Invalid scope',
        prompt: 'Should fail',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 24 },
        timezone: 'America/Los_Angeles',
        deliverableKind: 'thread',
        sourceScope: {
          connectorIds: ['missing-connector'],
          channelBindingIds: [],
          allowWeb: false,
        },
      }),
    });
    expect(invalidCreateRes.status).toBe(400);

    const output = createTalkOutput({
      talkId: 'talk-1',
      title: 'Weekly Report',
      contentMarkdown: '',
      createdByUserId: 'owner-1',
    });
    const validCreateRes = await server.request('/api/v1/talks/talk-1/jobs', {
      method: 'POST',
      headers: authHeaders('owner-token'),
      body: JSON.stringify({
        title: 'Weekly Report Job',
        prompt: 'Write the weekly report.',
        targetAgentId: agentId,
        schedule: { kind: 'hourly_interval', everyHours: 24 },
        timezone: 'America/Los_Angeles',
        deliverableKind: 'report',
        reportOutputId: output.id,
        sourceScope: {
          connectorIds: [],
          channelBindingIds: [],
          allowWeb: false,
        },
      }),
    });
    expect(validCreateRes.status).toBe(201);
    const created = await json(validCreateRes);
    const jobId = created.data.job.id as string;

    const pauseRes = await server.request(
      `/api/v1/talks/talk-1/jobs/${jobId}/pause`,
      {
        method: 'POST',
        headers: authHeaders('owner-token'),
      },
    );
    expect(pauseRes.status).toBe(200);
    expect((await json(pauseRes)).data.job.status).toBe('paused');

    const resumeRes = await server.request(
      `/api/v1/talks/talk-1/jobs/${jobId}/resume`,
      {
        method: 'POST',
        headers: authHeaders('owner-token'),
      },
    );
    expect(resumeRes.status).toBe(200);
    expect((await json(resumeRes)).data.job.status).toBe('active');
  });
});
