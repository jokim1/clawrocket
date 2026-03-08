import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalkMessage,
  createTalkRun,
  getQueuedTalkRuns,
  getRunningTalkRun,
  upsertTalk,
  upsertTalkLlmPolicy,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { hashSessionToken } from '../../identity/session.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../server.js';

describe('talk routes', () => {
  let server: WebServerHandle;
  let wakeCalls = 0;
  let abortCalls: string[] = [];

  beforeEach(async () => {
    _initTestDatabase();
    _resetRateLimitStateForTests();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertUser({
      id: 'member-1',
      email: 'member@example.com',
      displayName: 'Member',
      role: 'member',
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
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
    });
    upsertTalk({
      id: 'talk-member',
      ownerId: 'member-1',
      topicTitle: 'Member Talk',
    });
    upsertTalk({
      id: 'talk-private',
      ownerId: 'owner-1',
      topicTitle: 'Private Talk',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-owner',
      llmPolicy: '{"agents":["Gemini","Opus4.6"]}',
    });

    upsertTalkMember({
      talkId: 'talk-owner',
      userId: 'member-1',
      role: 'editor',
    });
    upsertTalkMember({
      talkId: 'talk-owner',
      userId: 'viewer-1',
      role: 'viewer',
    });

    upsertWebSession({
      id: 's-owner',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('owner-token'),
      refreshTokenHash: hashSessionToken('owner-refresh'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    upsertWebSession({
      id: 's-member',
      userId: 'member-1',
      accessTokenHash: hashSessionToken('member-token'),
      refreshTokenHash: hashSessionToken('member-refresh'),
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

    wakeCalls = 0;
    abortCalls = [];
    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      runWorker: {
        wake: () => {
          wakeCalls += 1;
        },
        abortTalk: (talkId: string) => {
          abortCalls.push(talkId);
        },
      },
    });
  });

  it('lists talks scoped to the authenticated user', async () => {
    const memberRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(200);
    const memberBody = (await memberRes.json()) as any;
    expect(memberBody.ok).toBe(true);
    expect(memberBody.data.talks.map((talk: any) => talk.id).sort()).toEqual([
      'talk-member',
      'talk-owner',
    ]);
    const ownTalk = memberBody.data.talks.find(
      (talk: any) => talk.id === 'talk-member',
    );
    expect(ownTalk.agents).toEqual(['Claude']);
    const sharedTalk = memberBody.data.talks.find(
      (talk: any) => talk.id === 'talk-owner',
    );
    expect(sharedTalk.agents).toEqual(['Gemini', 'Opus4.6']);

    const ownerRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    expect(ownerBody.data.talks).toHaveLength(3);
  });

  it('parses supported llm_policy shapes and caps agent badges', async () => {
    upsertTalk({
      id: 'talk-models-array',
      ownerId: 'owner-1',
      topicTitle: 'Models Array',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-models-array',
      llmPolicy: '{"models":["GPT-4o","Opus"]}',
    });

    upsertTalk({
      id: 'talk-json-string',
      ownerId: 'owner-1',
      topicTitle: 'JSON String',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-json-string',
      llmPolicy: '"Gemini"',
    });

    upsertTalk({
      id: 'talk-delimited',
      ownerId: 'owner-1',
      topicTitle: 'Delimited',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-delimited',
      llmPolicy: 'Gemini | Opus4.6',
    });

    upsertTalk({
      id: 'talk-invalid-shape',
      ownerId: 'owner-1',
      topicTitle: 'Invalid Shape',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-invalid-shape',
      llmPolicy: '{"model":42}',
    });

    upsertTalk({
      id: 'talk-many-agents',
      ownerId: 'owner-1',
      topicTitle: 'Many Agents',
    });
    upsertTalkLlmPolicy({
      talkId: 'talk-many-agents',
      llmPolicy: '{"agents":["A1","A2","A3","A4","A5","A6","A7","A8"]}',
    });

    const ownerRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(ownerRes.status).toBe(200);
    const ownerBody = (await ownerRes.json()) as any;
    const byId = Object.fromEntries(
      ownerBody.data.talks.map((talk: any) => [talk.id, talk]),
    );

    expect(byId['talk-models-array'].agents).toEqual(['GPT-4o', 'Opus']);
    expect(byId['talk-json-string'].agents).toEqual(['Gemini']);
    expect(byId['talk-delimited'].agents).toEqual(['Gemini', 'Opus4.6']);
    expect(byId['talk-invalid-shape'].agents).toEqual(['Claude']);
    expect(byId['talk-many-agents'].agents).toEqual([
      'A1',
      'A2',
      'A3',
      'A4',
      'A5',
      'A6',
    ]);
  });

  it('normalizes talk list pagination in query and response metadata', async () => {
    const res = await server.request('/api/v1/talks?limit=500&offset=1', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as any;
    expect(body.data.page.limit).toBe(200);
    expect(body.data.page.offset).toBe(1);
    expect(body.data.page.count).toBe(2);
  });

  it('creates a talk and supports idempotent replay', async () => {
    const first = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-1',
      },
      body: JSON.stringify({ title: 'Roadmap' }),
    });

    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.talk.title).toBe('Roadmap');
    const talkId = firstBody.data.talk.id as string;

    const replay = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-create-1',
      },
      body: JSON.stringify({ title: 'Roadmap' }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    const replayBody = (await replay.json()) as any;
    expect(replayBody.data.talk.id).toBe(talkId);

    const detail = await server.request(`/api/v1/talks/${talkId}`, {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(detail.status).toBe(200);
  });

  it('requires csrf for cookie-authenticated create talk', async () => {
    const res = await server.request('/api/v1/talks', {
      method: 'POST',
      headers: {
        Cookie: 'cr_access_token=owner-token; cr_csrf_token=csrf-a',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Cookie Talk' }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('csrf_failed');
  });

  it('returns talk detail only for authorized users', async () => {
    const memberRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberRes.status).toBe(200);

    const outsiderRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer outsider-token',
      },
    });
    expect(outsiderRes.status).toBe(404);
  });

  it('returns talk policy for authorized users and 404 for outsiders', async () => {
    const viewerRes = await server.request('/api/v1/talks/talk-owner/policy', {
      headers: {
        Authorization: 'Bearer viewer-token',
      },
    });
    expect(viewerRes.status).toBe(200);
    const viewerBody = (await viewerRes.json()) as any;
    expect(viewerBody.ok).toBe(true);
    expect(viewerBody.data.agents).toEqual(['Gemini', 'Opus4.6']);
    expect(viewerBody.data.limits).toEqual({
      maxAgents: 12,
      maxAgentChars: 80,
    });

    const outsiderRes = await server.request(
      '/api/v1/talks/talk-owner/policy',
      {
        headers: {
          Authorization: 'Bearer outsider-token',
        },
      },
    );
    expect(outsiderRes.status).toBe(404);
  });

  it('updates talk policy for editor and blocks viewer', async () => {
    const viewerRes = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: ['Gemini'] }),
    });
    expect(viewerRes.status).toBe(403);

    const editorRes = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: ['Gemini', 'Opus4.6', 'Gemini'] }),
    });
    expect(editorRes.status).toBe(200);
    const editorBody = (await editorRes.json()) as any;
    expect(editorBody.ok).toBe(true);
    expect(editorBody.data.agents).toEqual(['Gemini', 'Opus4.6']);
    expect(editorBody.data.limits.maxAgents).toBe(12);
    expect(editorBody.data.limits.maxAgentChars).toBe(80);

    const readBackRes = await server.request(
      '/api/v1/talks/talk-owner/policy',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(readBackRes.status).toBe(200);
    const readBackBody = (await readBackRes.json()) as any;
    expect(readBackBody.data.agents).toEqual(['Gemini', 'Opus4.6']);
  });

  it('validates talk policy payload and supports clearing policy', async () => {
    const invalidRes = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: 'Gemini' }),
    });
    expect(invalidRes.status).toBe(400);
    const invalidBody = (await invalidRes.json()) as any;
    expect(invalidBody.ok).toBe(false);
    expect(invalidBody.error.code).toBe('invalid_agents');

    const clearRes = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ agents: [] }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as any;
    expect(clearBody.data.agents).toEqual(['Claude Opus 4.6']);

    const listRes = await server.request('/api/v1/talks', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    const talk = listBody.data.talks.find(
      (row: any) => row.id === 'talk-owner',
    );
    expect(talk.agents).toEqual(['Claude Opus 4.6']);
  });

  it('replays idempotent policy updates', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-policy-1',
      },
      body: JSON.stringify({ agents: ['Gemini', 'Opus4.6'] }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.agents).toEqual(['Gemini', 'Opus4.6']);

    const replay = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-policy-1',
      },
      body: JSON.stringify({ agents: ['Gemini', 'Opus4.6'] }),
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    const replayBody = (await replay.json()) as any;
    expect(replayBody.data.agents).toEqual(['Gemini', 'Opus4.6']);
  });

  it('rejects policy idempotency key reuse when body changes', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-policy-body-mismatch',
      },
      body: JSON.stringify({ agents: ['Gemini', 'Opus4.6'] }),
    });
    expect(first.status).toBe(200);

    const second = await server.request('/api/v1/talks/talk-owner/policy', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-policy-body-mismatch',
      },
      body: JSON.stringify({ agents: ['Gemini', 'Haiku'] }),
    });
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as any;
    expect(secondBody.ok).toBe(false);
    expect(secondBody.error.code).toBe('idempotency_error');

    const policyRes = await server.request('/api/v1/talks/talk-owner/policy', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(policyRes.status).toBe(200);
    const policyBody = (await policyRes.json()) as any;
    expect(policyBody.data.agents).toEqual(['Gemini', 'Opus4.6']);
  });

  it('enqueues chat runs and persists user messages', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'First message' }),
    });
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as any;
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.runs).toHaveLength(1);
    expect(firstBody.data.runs[0].status).toBe('queued');
    expect(firstBody.data.runs[0].targetAgentNickname).toBeTruthy();

    const second = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Second message' }),
    });
    expect(second.status).toBe(409);
    const secondBody = (await second.json()) as any;
    expect(secondBody.ok).toBe(false);
    expect(secondBody.error.code).toBe('talk_round_active');

    const messagesRes = await server.request(
      '/api/v1/talks/talk-owner/messages',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as any;
    expect(messagesBody.data.messages.map((m: any) => m.content)).toEqual([
      'First message',
    ]);

    expect(getRunningTalkRun('talk-owner')).toBeNull();
    expect(getQueuedTalkRuns('talk-owner').map((row) => row.id)).toEqual([
      firstBody.data.runs[0].id,
    ]);
    expect(wakeCalls).toBe(1);
  });

  it('returns real run error codes and target nicknames in run history', async () => {
    const agentsRes = await server.request('/api/v1/talks/talk-owner/agents', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(agentsRes.status).toBe(200);
    const agentsBody = (await agentsRes.json()) as any;
    const targetAgent = agentsBody.data.agents[0];

    createTalkMessage({
      id: 'msg-run-history',
      talkId: 'talk-owner',
      role: 'user',
      content: 'Show me the run history error',
      createdBy: 'owner-1',
      createdAt: '2026-03-07T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-history-failed',
      talk_id: 'talk-owner',
      requested_by: 'owner-1',
      status: 'failed',
      trigger_message_id: 'msg-run-history',
      target_agent_id: targetAgent.id,
      idempotency_key: null,
      executor_alias: 'claude',
      executor_model: 'claude-sonnet-4-6',
      created_at: '2026-03-07T00:00:01.000Z',
      started_at: '2026-03-07T00:00:01.500Z',
      ended_at: '2026-03-07T00:00:02.000Z',
      cancel_reason: 'trigger_message_missing: Trigger message not found',
    });

    const runsRes = await server.request('/api/v1/talks/talk-owner/runs', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(runsRes.status).toBe(200);
    const runsBody = (await runsRes.json()) as any;
    const failedRun = runsBody.data.runs.find(
      (run: any) => run.id === 'run-history-failed',
    );
    expect(failedRun).toBeDefined();
    expect(failedRun.errorCode).toBe('trigger_message_missing');
    expect(failedRun.errorMessage).toBe('Trigger message not found');
    expect(failedRun.targetAgentNickname).toBe(targetAgent.nickname);
  });

  it('returns parsed talk message metadata for runtime messages', async () => {
    createTalkRun({
      id: 'run-runtime-meta',
      talk_id: 'talk-owner',
      requested_by: 'owner-1',
      status: 'completed',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2026-03-07T00:59:59.000Z',
      started_at: '2026-03-07T00:59:59.500Z',
      ended_at: '2026-03-07T01:00:01.000Z',
      cancel_reason: null,
    });

    createTalkMessage({
      id: 'msg-runtime-meta',
      talkId: 'talk-owner',
      role: 'assistant',
      content: 'Checking PostHog',
      createdBy: null,
      runId: 'run-runtime-meta',
      metadataJson: JSON.stringify({
        kind: 'assistant_tool_use',
        agentId: 'agent-runtime',
        agentNickname: 'Opus',
        displaySummary: 'Checking FTUE funnel',
      }),
      createdAt: '2026-03-07T01:00:00.000Z',
    });

    const messagesRes = await server.request('/api/v1/talks/talk-owner/messages', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(messagesRes.status).toBe(200);
    const messagesBody = (await messagesRes.json()) as any;
    const runtimeMessage = messagesBody.data.messages.find(
      (message: any) => message.id === 'msg-runtime-meta',
    );

    expect(runtimeMessage).toMatchObject({
      id: 'msg-runtime-meta',
      agentId: 'agent-runtime',
      agentNickname: 'Opus',
      metadata: {
        kind: 'assistant_tool_use',
        displaySummary: 'Checking FTUE funnel',
      },
    });
  });

  it('requires editor permission to enqueue chat', async () => {
    const viewerRes = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer viewer-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'viewer message' }),
    });
    expect(viewerRes.status).toBe(403);
    const viewerBody = (await viewerRes.json()) as any;
    expect(viewerBody.ok).toBe(false);
    expect(viewerBody.error.code).toBe('forbidden');

    const editorRes = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer member-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'editor message' }),
    });
    expect(editorRes.status).toBe(202);
  });

  it('supports chat idempotent replay', async () => {
    const first = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-chat-1',
      },
      body: JSON.stringify({ content: 'Hello idempotent world' }),
    });
    expect(first.status).toBe(202);

    const replay = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idem-chat-1',
      },
      body: JSON.stringify({ content: 'Hello idempotent world' }),
    });
    expect(replay.status).toBe(202);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');

    const messagesRes = await server.request(
      '/api/v1/talks/talk-owner/messages',
      {
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    const messagesBody = (await messagesRes.json()) as any;
    expect(
      messagesBody.data.messages.filter(
        (message: any) => message.content === 'Hello idempotent world',
      ),
    ).toHaveLength(1);
    expect(wakeCalls).toBe(1);
  });

  it('rejects oversized chat content with message_too_large', async () => {
    const oversized = 'x'.repeat(20_001);
    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: oversized }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('message_too_large');
  });

  it('supports cancel on existing talk and validates talk id encoding', async () => {
    const queued = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Cancelable message' }),
    });
    expect(queued.status).toBe(202);

    const cancelRes = await server.request(
      '/api/v1/talks/talk-owner/chat/cancel',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(cancelRes.status).toBe(200);
    expect(abortCalls).toEqual([]);

    const badTalkRes = await server.request('/api/v1/talks/%ZZ/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'bad path' }),
    });
    expect(badTalkRes.status).toBe(400);
    const badTalkBody = (await badTalkRes.json()) as any;
    expect(badTalkBody.error.code).toBe('invalid_talk_id');
  });
});
