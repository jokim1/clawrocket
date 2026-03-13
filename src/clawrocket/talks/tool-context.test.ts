import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  createTalk,
  createTalkResourceBinding,
  replaceTalkAgents,
  replaceTalkLlmSettingsSnapshot,
  replaceTalkToolGrants,
  upsertUser,
  upsertUserGoogleCredential,
} from '../db/index.js';
import { buildTalkToolContextBlock } from './tool-context.js';

const OWNER_ID = 'owner-1';
const TALK_ID = 'talk-1';

function configureToolCapableTalk(): void {
  replaceTalkLlmSettingsSnapshot({
    defaultRouteId: 'route.primary',
    providers: [
      {
        id: 'anthropic.primary',
        name: 'Anthropic Primary',
        providerKind: 'anthropic',
        apiFormat: 'anthropic_messages',
        baseUrl: 'https://anthropic.example.test',
        authScheme: 'x_api_key',
        enabled: true,
        coreCompatibility: 'none',
        responseStartTimeoutMs: null,
        streamIdleTimeoutMs: null,
        absoluteTimeoutMs: null,
        models: [
          {
            modelId: 'claude-test',
            displayName: 'Claude Test',
            contextWindowTokens: 200000,
            defaultMaxOutputTokens: 4096,
            enabled: true,
            supportsTools: true,
          },
        ],
        credential: { apiKey: 'sk-ant-test' },
      },
    ],
    routes: [
      {
        id: 'route.primary',
        name: 'Primary Route',
        enabled: true,
        steps: [
          {
            position: 0,
            providerId: 'anthropic.primary',
            modelId: 'claude-test',
          },
        ],
      },
    ],
  });
  replaceTalkAgents(TALK_ID, [
    {
      name: 'Primary Agent',
      sourceKind: 'provider',
      personaRole: 'assistant',
      routeId: 'route.primary',
      providerId: 'anthropic.primary',
      modelId: 'claude-test',
      isPrimary: true,
      sortOrder: 0,
    },
  ]);
}

describe('buildTalkToolContextBlock', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: OWNER_ID,
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    createTalk({
      id: TALK_ID,
      ownerId: OWNER_ID,
      topicTitle: 'Accounting',
    });
    configureToolCapableTalk();
  });

  it('reflects current grants, bindings, and confirmation expectations', () => {
    replaceTalkToolGrants({
      talkId: TALK_ID,
      grants: [{ toolId: 'web_search', enabled: true }],
      updatedBy: OWNER_ID,
    });

    const initial = buildTalkToolContextBlock({
      talkId: TALK_ID,
      requestedBy: OWNER_ID,
    });
    expect(initial).toContain('Public web search and fetch are available.');
    expect(initial).not.toContain(
      'You may search within bound Google Drive resources',
    );

    replaceTalkToolGrants({
      talkId: TALK_ID,
      grants: [
        { toolId: 'web_search', enabled: true },
        { toolId: 'google_drive_search', enabled: true },
        { toolId: 'gmail_send', enabled: true },
      ],
      updatedBy: OWNER_ID,
    });
    createTalkResourceBinding({
      talkId: TALK_ID,
      bindingKind: 'google_drive_folder',
      externalId: 'folder-123',
      displayName: 'Accounting',
      createdBy: OWNER_ID,
    });
    upsertUserGoogleCredential({
      userId: OWNER_ID,
      googleSubject: 'google-owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      scopes: ['drive.readonly'],
      ciphertext: 'encrypted-google-credential',
      accessExpiresAt: null,
    });

    const updated = buildTalkToolContextBlock({
      talkId: TALK_ID,
      requestedBy: OWNER_ID,
    });
    expect(updated).toContain(
      'You may search within bound Google Drive resources: Accounting.',
    );
    expect(updated).toContain('Do not assume access outside bound resources.');
    expect(updated).toContain(
      'Some granted Google capabilities still require additional Google permissions before they can be used.',
    );
    expect(updated).toContain(
      'Email sends require user approval before execution. Compose them as final drafts.',
    );
  });
});
