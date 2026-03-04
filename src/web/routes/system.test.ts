import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, upsertUser, upsertWebSession } from '../../db.js';
import { hashSessionToken } from '../../identity/session.js';
import { noopKeychainBridge } from '../../secrets/keychain.js';
import { TalkRunQueue } from '../../talks/run-queue.js';
import { createWebServer, WebServerHandle } from '../server.js';
import { healthResponse } from './system.js';

describe('system routes', () => {
  let server: WebServerHandle | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    _initTestDatabase();

    upsertUser({
      id: 'owner-1',
      email: 'owner@example.com',
      displayName: 'Owner',
      role: 'owner',
    });
    upsertWebSession({
      id: 'session-1',
      userId: 'owner-1',
      accessTokenHash: hashSessionToken('token-owner-1'),
      refreshTokenHash: hashSessionToken('refresh-owner-1'),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    server = createWebServer({
      host: '127.0.0.1',
      port: 0,
      keychain: noopKeychainBridge,
      runQueue: new TalkRunQueue(),
    });

    const bound = await server.start();
    baseUrl = `http://${bound.host}:${bound.port}`;
  });

  afterEach(async () => {
    if (!server) return;
    await server.stop();
    server = undefined;
  });

  it('serves shallow health without auth', async () => {
    const res = await fetch(`${baseUrl}/api/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('serves deep status with auth', async () => {
    const res = await fetch(`${baseUrl}/api/v1/status`, {
      headers: {
        Authorization: 'Bearer token-owner-1',
      },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.data.db).toBe('ok');
    expect(body.data.keychain).toBe('ok');
  });

  it('returns db_unavailable when health check fails', async () => {
    const failed = await healthResponse(() => false);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('db_unavailable');
    }
  });
});
