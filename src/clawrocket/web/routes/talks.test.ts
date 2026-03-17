import { beforeEach, describe, expect, it, vi } from 'vitest';

const executionPlannerMocks = vi.hoisted(() => {
  class MockExecutionPlannerError extends Error {
    constructor(
      message: string,
      public readonly code:
        | 'CONTAINER_BROWSER_REQUIRES_SHELL'
        | 'CONTAINER_PROVIDER_INCOMPATIBLE'
        | 'CONTAINER_BACKEND_UNAVAILABLE'
        | 'CONTAINER_CREDENTIAL_MISSING'
        | 'DIRECT_EXECUTION_UNAVAILABLE',
      public readonly details?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'ExecutionPlannerError';
    }
  }

  return {
    planExecutionMock: vi.fn(),
    MockExecutionPlannerError,
  };
});

vi.mock('../../agents/execution-planner.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../agents/execution-planner.js')
  >('../../agents/execution-planner.js');
  return {
    ...actual,
    ExecutionPlannerError: executionPlannerMocks.MockExecutionPlannerError,
    planExecution: executionPlannerMocks.planExecutionMock,
  };
});

vi.mock('../../../mount-security.js', () => ({
  validateMount: (mount: { hostPath?: string }) => {
    const hostPath = mount.hostPath?.trim() || '';
    if (!hostPath) {
      return { allowed: false, reason: 'Project path is required' };
    }
    if (hostPath.includes('/blocked/')) {
      return { allowed: false, reason: 'Path matches blocked pattern' };
    }
    if (hostPath.endsWith('/missing')) {
      return { allowed: false, reason: 'Path does not exist' };
    }
    return {
      allowed: true,
      reason: 'Allowed',
      realHostPath: hostPath,
      effectiveReadonly: true,
      resolvedContainerPath: 'project',
    };
  },
}));

import { getDb } from '../../../db.js';
import {
  _initTestDatabase,
  createTalkThread,
  createTalkMessage,
  createTalkRun,
  getQueuedTalkRuns,
  getRunningTalkRun,
  getTalkExecutorSession,
  upsertTalk,
  upsertTalkExecutorSession,
  upsertTalkLlmPolicy,
  upsertTalkMember,
  upsertUser,
  upsertWebSession,
} from '../../db/index.js';
import { createRegisteredAgent } from '../../db/agent-accessors.js';
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
    executionPlannerMocks.planExecutionMock.mockReset();
    executionPlannerMocks.planExecutionMock.mockReturnValue({
      backend: 'direct_http',
    });

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

    // Create a default registered agent
    const agent = createRegisteredAgent({
      name: 'Claude Opus 4.6',
      providerId: 'provider.anthropic',
      modelId: 'claude-opus-4-6',
      toolPermissionsJson: '{}',
    });

    upsertTalk({
      id: 'talk-owner',
      ownerId: 'owner-1',
      topicTitle: 'Owner Talk',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_threads (id, talk_id, title, is_default, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('thread-talk-owner', 'talk-owner', 'Default Thread');
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-owner', 'talk-owner', agent.id, agent.name);

    upsertTalk({
      id: 'talk-member',
      ownerId: 'member-1',
      topicTitle: 'Member Talk',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_threads (id, talk_id, title, is_default, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('thread-talk-member', 'talk-member', 'Default Thread');
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-member', 'talk-member', agent.id, agent.name);

    upsertTalk({
      id: 'talk-private',
      ownerId: 'owner-1',
      topicTitle: 'Private Talk',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_threads (id, talk_id, title, is_default, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('thread-talk-private', 'talk-private', 'Default Thread');
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-private', 'talk-private', agent.id, agent.name);
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
        abortThread: (threadId: string) => {
          abortCalls.push(`thread:${threadId}`);
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
    expect(ownTalk.agents).toEqual(['Claude Opus 4.6']);
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

  it('returns csrf_failed for cookie-authenticated attachment uploads', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    );

    const res = await server.request('/api/v1/talks/talk-owner/attachments', {
      method: 'POST',
      headers: {
        Cookie: 'cr_access_token=owner-token; cr_csrf_token=csrf-a',
      },
      body: form,
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

  it('includes orchestrationMode in talk detail and allows patching it', async () => {
    const detailRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as any;
    expect(detailBody.data.talk.orchestrationMode).toBe('ordered');

    const patchRes = await server.request('/api/v1/talks/talk-owner', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orchestrationMode: 'panel' }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as any;
    expect(patchBody.ok).toBe(true);
    expect(patchBody.data.talk.orchestrationMode).toBe('panel');
  });

  it('exposes projectPath to owners and lets them update and clear it', async () => {
    const detailRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer owner-token',
      },
    });
    expect(detailRes.status).toBe(200);
    const detailBody = (await detailRes.json()) as any;
    expect(detailBody.data.talk.projectPath).toBeNull();

    const saveRes = await server.request(
      '/api/v1/talks/talk-owner/project-mount',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectPath: '/tmp/project-alpha' }),
      },
    );
    expect(saveRes.status).toBe(200);
    const saveBody = (await saveRes.json()) as any;
    expect(saveBody.data.talk.projectPath).toBe('/tmp/project-alpha');

    const clearRes = await server.request(
      '/api/v1/talks/talk-owner/project-mount',
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer owner-token',
        },
      },
    );
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as any;
    expect(clearBody.data.talk.projectPath).toBeNull();
  });

  it('rejects invalid project paths and hides them from non-owner editors', async () => {
    const saveRes = await server.request(
      '/api/v1/talks/talk-owner/project-mount',
      {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ projectPath: '/blocked/project' }),
      },
    );
    expect(saveRes.status).toBe(400);
    const saveBody = (await saveRes.json()) as any;
    expect(saveBody.error.code).toBe('invalid_project_path');

    getDb()
      .prepare(`UPDATE talks SET project_path = ? WHERE id = ?`)
      .run('/tmp/secret-project', 'talk-owner');

    const memberDetailRes = await server.request('/api/v1/talks/talk-owner', {
      headers: {
        Authorization: 'Bearer member-token',
      },
    });
    expect(memberDetailRes.status).toBe(200);
    const memberDetailBody = (await memberDetailRes.json()) as any;
    expect(memberDetailBody.data.talk.projectPath).toBeNull();

    const memberProjectRes = await server.request(
      '/api/v1/talks/talk-owner/project-mount',
      {
        headers: {
          Authorization: 'Bearer member-token',
        },
      },
    );
    expect(memberProjectRes.status).toBe(403);
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

  it('rejects multi-agent turns when any selected agent would require container routing', async () => {
    const heavyAgent = createRegisteredAgent({
      name: 'Heavy Claude',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: '{"shell":true,"filesystem":true}',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-owner-heavy', 'talk-owner', heavyAgent.id, heavyAgent.name);

    executionPlannerMocks.planExecutionMock.mockImplementation(
      (agent: { id: string }) =>
        agent.id === heavyAgent.id
          ? { backend: 'container' }
          : { backend: 'direct_http' },
    );

    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: 'Run the full panel' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('multi_agent_container_unsupported');
    expect(body.error.message).toContain('Heavy Claude');
    expect(body.error.message).toContain('Target that agent alone');
    expect(getQueuedTalkRuns('talk-owner')).toHaveLength(0);
    expect(wakeCalls).toBe(0);
  });

  it('allows targeted single-agent turns even when that agent requires container routing', async () => {
    const heavyAgent = createRegisteredAgent({
      name: 'Heavy Claude',
      providerId: 'provider.anthropic',
      modelId: 'claude-sonnet-4-6',
      toolPermissionsJson: '{"shell":true,"filesystem":true}',
    });
    getDb()
      .prepare(
        `
      INSERT INTO talk_agents (id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
    `,
      )
      .run('ta-talk-owner-heavy', 'talk-owner', heavyAgent.id, heavyAgent.name);

    executionPlannerMocks.planExecutionMock.mockImplementation(
      (agent: { id: string }) =>
        agent.id === heavyAgent.id
          ? { backend: 'container' }
          : { backend: 'direct_http' },
    );

    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Target only the heavy agent',
        targetAgentIds: [heavyAgent.id],
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(1);
    expect(body.data.runs[0].targetAgentId).toBe(heavyAgent.id);
    expect(getQueuedTalkRuns('talk-owner')).toHaveLength(1);
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
      threadId: 'thread-talk-owner',
      role: 'user',
      content: 'Show me the run history error',
      createdBy: 'owner-1',
      createdAt: '2026-03-07T00:00:00.000Z',
    });
    createTalkRun({
      id: 'run-history-failed',
      talk_id: 'talk-owner',
      thread_id: 'thread-talk-owner',
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
      thread_id: 'thread-talk-owner',
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
      threadId: 'thread-talk-owner',
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

  it('deletes selected talk messages and clears the cached executor session', async () => {
    createTalkMessage({
      id: 'msg-edit-1',
      talkId: 'talk-owner',
      threadId: 'thread-talk-owner',
      role: 'user',
      content: 'Remove me',
      createdBy: 'owner-1',
      createdAt: '2026-03-07T01:00:00.000Z',
    });
    createTalkMessage({
      id: 'msg-edit-2',
      talkId: 'talk-owner',
      threadId: 'thread-talk-owner',
      role: 'assistant',
      content: 'Remove me too',
      createdBy: null,
      createdAt: '2026-03-07T01:00:01.000Z',
    });
    createTalkMessage({
      id: 'msg-edit-3',
      talkId: 'talk-owner',
      threadId: 'thread-talk-owner',
      role: 'user',
      content: 'Keep me',
      createdBy: 'owner-1',
      createdAt: '2026-03-07T01:00:02.000Z',
    });
    upsertTalkExecutorSession({
      talkId: 'talk-owner',
      sessionId: 'session-edit-1',
      executorAlias: 'Claude',
      executorModel: 'claude-sonnet-4-6',
      sessionCompatKey: 'Claude:claude-sonnet-4-6',
      updatedAt: '2026-03-07T01:00:03.000Z',
    });

    const res = await server.request(
      '/api/v1/talks/talk-owner/messages/delete',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageIds: ['msg-edit-1', 'msg-edit-2'],
          threadId: 'thread-talk-owner',
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      talkId: 'talk-owner',
      deletedCount: 2,
      deletedMessageIds: ['msg-edit-1', 'msg-edit-2'],
    });
    expect(getTalkExecutorSession('talk-owner')).toBeUndefined();

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
      messagesBody.data.messages.map((message: any) => message.id),
    ).toEqual(['msg-edit-3']);
  });

  it('rejects history edits while a talk round is active', async () => {
    createTalkMessage({
      id: 'msg-edit-active',
      talkId: 'talk-owner',
      threadId: 'thread-talk-owner',
      role: 'user',
      content: 'Still here',
      createdBy: 'owner-1',
      createdAt: '2026-03-07T01:10:00.000Z',
    });
    createTalkRun({
      id: 'run-edit-active',
      talk_id: 'talk-owner',
      thread_id: 'thread-talk-owner',
      requested_by: 'owner-1',
      status: 'queued',
      trigger_message_id: 'msg-edit-active',
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2026-03-07T01:10:01.000Z',
      started_at: null,
      ended_at: null,
      cancel_reason: null,
    });

    const res = await server.request(
      '/api/v1/talks/talk-owner/messages/delete',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messageIds: ['msg-edit-active'],
          threadId: 'thread-talk-owner',
        }),
      },
    );

    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('thread_active_round');
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

  it('creates grouped ordered runs for multi-agent chat turns', async () => {
    const secondAgent = createRegisteredAgent({
      name: 'GPT-5',
      providerId: 'provider.openai',
      modelId: 'gpt-5',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
      `,
      )
      .run('ta-talk-owner-2', 'talk-owner', secondAgent.id, secondAgent.name);

    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'compare these options',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(2);
    expect(body.data.runs[0].responseGroupId).toBeTruthy();
    expect(body.data.runs[0].responseGroupId).toBe(
      body.data.runs[1].responseGroupId,
    );
    expect(body.data.runs.map((run: any) => run.sequenceIndex)).toEqual([0, 1]);
  });

  it('creates grouped panel runs without ordered sequence indexes', async () => {
    const patchRes = await server.request('/api/v1/talks/talk-owner', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orchestrationMode: 'panel' }),
    });
    expect(patchRes.status).toBe(200);

    const secondAgent = createRegisteredAgent({
      name: 'GPT-5 Critic',
      providerId: 'provider.openai',
      modelId: 'gpt-5',
      toolPermissionsJson: '{}',
    });
    getDb()
      .prepare(
        `
        INSERT INTO talk_agents (
          id, talk_id, registered_agent_id, nickname, is_primary, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, 0, 1, datetime('now'), datetime('now'))
      `,
      )
      .run(
        'ta-talk-owner-panel-2',
        'talk-owner',
        secondAgent.id,
        secondAgent.name,
      );

    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'compare these options in parallel',
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.runs).toHaveLength(2);
    expect(body.data.runs[0].responseGroupId).toBeTruthy();
    expect(body.data.runs[0].responseGroupId).toBe(
      body.data.runs[1].responseGroupId,
    );
    expect(body.data.runs.map((run: any) => run.sequenceIndex)).toEqual([
      null,
      null,
    ]);
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

  it('rejects thread ids that do not belong to the target talk', async () => {
    upsertTalk({
      id: 'talk-other',
      ownerId: 'owner-1',
      topicTitle: 'Other Talk',
    });
    const foreignThread = createTalkThread({
      talkId: 'talk-other',
      title: 'Foreign Thread',
    });

    const res = await server.request('/api/v1/talks/talk-owner/chat', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer owner-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'hello from wrong thread',
        threadId: foreignThread.id,
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('thread_not_found');
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

    const malformedCancelRes = await server.request(
      '/api/v1/talks/talk-owner/chat/cancel',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: '{"threadId"',
      },
    );
    expect(malformedCancelRes.status).toBe(400);
    const malformedCancelBody = (await malformedCancelRes.json()) as any;
    expect(malformedCancelBody.error.code).toBe('invalid_json');

    const threadA = createTalkThread({ talkId: 'talk-owner', title: 'A' });
    createTalkRun({
      id: 'run-thread-cancel-a',
      talk_id: 'talk-owner',
      thread_id: threadA.id,
      requested_by: 'owner-1',
      status: 'running',
      trigger_message_id: null,
      target_agent_id: null,
      idempotency_key: null,
      executor_alias: null,
      executor_model: null,
      created_at: '2026-03-07T02:00:00.000Z',
      started_at: '2026-03-07T02:00:00.500Z',
      ended_at: null,
      cancel_reason: null,
    });

    const threadCancelRes = await server.request(
      '/api/v1/talks/talk-owner/chat/cancel',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer owner-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ threadId: threadA.id }),
      },
    );
    expect(threadCancelRes.status).toBe(200);
    expect(abortCalls).toContain(`thread:${threadA.id}`);

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
