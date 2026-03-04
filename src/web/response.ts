import { ServerResponse } from 'http';

import { ApiEnvelope } from './types.js';

export function sendJson<T>(
  res: ServerResponse,
  statusCode: number,
  body: ApiEnvelope<T>,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendSse(
  res: ServerResponse,
  payload: string,
  statusCode = 200,
): void {
  res.writeHead(statusCode, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.end(payload);
}
