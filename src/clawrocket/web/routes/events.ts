import {
  getOutboxEventsForTopics,
  getOutboxMinEventIdForTopics,
  getTalkIdsAccessibleByUser,
} from '../../db/index.js';

export function formatOutboxEventAsSse(event: {
  event_id: number;
  event_type: string;
  payload: string;
}): string {
  return `id: ${event.event_id}\nevent: ${event.event_type}\ndata: ${event.payload}\n\n`;
}

export function getUserScopedEventTopics(userId: string): string[] {
  const talkIds = getTalkIdsAccessibleByUser(userId);
  return [`user:${userId}`, ...talkIds.map((id) => `talk:${id}`)];
}

export function getTalkScopedEventTopics(talkId: string): string[] {
  return [`talk:${talkId}`];
}

export function buildUserScopedSseStream(input: {
  userId: string;
  lastEventId: number;
}): string {
  const topics = getUserScopedEventTopics(input.userId);
  return buildSseStreamForTopics(topics, input.lastEventId);
}

export function buildTalkScopedSseStream(input: {
  talkId: string;
  lastEventId: number;
}): string {
  return buildSseStreamForTopics(
    getTalkScopedEventTopics(input.talkId),
    input.lastEventId,
  );
}

function buildSseStreamForTopics(
  topics: string[],
  lastEventId: number,
): string {
  let output = '';

  const minId = getOutboxMinEventIdForTopics(topics);
  if (lastEventId > 0 && minId !== null && lastEventId < minId - 1) {
    output +=
      'event: replay_gap\ndata: {"message":"Requested replay position is outside retention window"}\n\n';
  }

  const events = getOutboxEventsForTopics(topics, lastEventId);
  for (const event of events) {
    output += formatOutboxEventAsSse(event);
  }

  if (!output) {
    output = ': keepalive\n\n';
  }

  return output;
}
