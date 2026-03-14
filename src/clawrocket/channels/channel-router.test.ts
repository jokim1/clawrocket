import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  claimNextChannelIngressRow,
  createTalkChannelBinding,
  ensureSystemManagedTelegramConnection,
  upsertTalk,
  upsertUser,
} from '../db/index.js';
import { TalkChannelRouter } from './channel-router.js';

describe('TalkChannelRouter', () => {
  beforeEach(() => {
    _initTestDatabase();
    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertTalk({
      id: 'talk-1',
      ownerId: 'owner-1',
      topicTitle: 'Channel Test Talk',
    });
    // resetTalkAgentsToDefault('talk-1', '2024-01-01T00:00:00.000Z');
  });

  it('enforces the per-binding inbound rate limit before queue insert', async () => {
    const connection = ensureSystemManagedTelegramConnection(
      '2024-01-01T00:00:01.000Z',
    );
    const binding = createTalkChannelBinding({
      talkId: 'talk-1',
      connectionId: connection.id,
      targetKind: 'chat',
      targetId: 'tg:chat:123',
      displayName: 'Telegram Chat',
      createdBy: 'owner-1',
      inboundRateLimitPerMinute: 1,
      now: '2024-01-01T00:00:02.000Z',
    });
    const wake = vi.fn();
    const router = new TalkChannelRouter(connection.id, { wake });

    const firstAccepted = await router.handleInboundEvent({
      platform: 'telegram',
      target_kind: 'chat',
      target_id: 'tg:chat:123',
      platform_event_id: 'evt-1',
      external_message_id: 'msg-1',
      sender_id: 'sender-1',
      sender_name: 'Alice',
      content: '@Andy hello',
      timestamp: '2024-01-01T00:00:03.000Z',
      target_display_name: 'Telegram Chat',
      is_mentioned: true,
      metadata: { isGroup: true },
    });
    const secondAccepted = await router.handleInboundEvent({
      platform: 'telegram',
      target_kind: 'chat',
      target_id: 'tg:chat:123',
      platform_event_id: 'evt-2',
      external_message_id: 'msg-2',
      sender_id: 'sender-2',
      sender_name: 'Bob',
      content: '@Andy again',
      timestamp: '2024-01-01T00:00:20.000Z',
      target_display_name: 'Telegram Chat',
      is_mentioned: true,
      metadata: { isGroup: true },
    });

    expect(firstAccepted).toBe(true);
    expect(secondAccepted).toBe(true);
    expect(wake).toHaveBeenCalledTimes(1);

    const firstRow = claimNextChannelIngressRow('2024-01-01T00:00:21.000Z');
    const secondRow = claimNextChannelIngressRow('2024-01-01T00:00:21.000Z');
    expect(firstRow?.binding_id).toBe(binding.id);
    expect(firstRow?.platform_event_id).toBe('evt-1');
    expect(secondRow).toBeNull();
  });
});
