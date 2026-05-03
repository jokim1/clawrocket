import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from '../../db/index.js';
import { _resetRateLimitStateForTests } from '../middleware/rate-limit.js';
import { createWebServer, WebServerHandle } from '../editorial-app.js';
import { healthResponse } from './system.js';

describe('system routes', () => {
  let server: WebServerHandle;

  beforeEach(() => {
    _initTestDatabase();
    _resetRateLimitStateForTests();
    server = createWebServer({ host: '127.0.0.1', port: 0 });
  });

  afterEach(async () => {
    await server?.stop();
  });

  it('serves shallow health without auth', async () => {
    const res = await server.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { status: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe('ok');
  });

  it('returns db_unavailable when health check fails', async () => {
    const failed = await healthResponse(() => false);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('db_unavailable');
    }
  });

  it('serves SPA index fallback with CSP from configured dist directory', async () => {
    const distDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'editorialboard-web-'),
    );
    try {
      fs.writeFileSync(
        path.join(distDir, 'index.html'),
        '<!doctype html><html><body><div id="root"></div></body></html>',
      );
      fs.mkdirSync(path.join(distDir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(distDir, 'assets', 'app-abc123.js'),
        'console.log(1);',
      );
      fs.writeFileSync(path.join(distDir, 'robots.txt'), 'User-agent: *');

      const webServer = createWebServer({
        host: '127.0.0.1',
        port: 0,
        webAppDistDir: distDir,
      });

      const routeRes = await webServer.request('/');
      expect(routeRes.status).toBe(200);
      expect(routeRes.headers.get('content-type')).toContain('text/html');
      expect(routeRes.headers.get('cache-control')).toBe('no-cache');
      const csp = routeRes.headers.get('content-security-policy') || '';
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");

      const assetRes = await webServer.request('/assets/app-abc123.js');
      expect(assetRes.status).toBe(200);
      expect(assetRes.headers.get('content-type')).toContain(
        'application/javascript',
      );
      expect(assetRes.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );

      const plainStaticRes = await webServer.request('/robots.txt');
      expect(plainStaticRes.status).toBe(200);
      expect(plainStaticRes.headers.get('cache-control')).toBe(
        'public, max-age=3600',
      );
    } finally {
      fs.rmSync(distDir, { recursive: true, force: true });
    }
  });

  it('returns 404 for SPA routes when dist directory is unavailable', async () => {
    const missingDir = path.join(
      os.tmpdir(),
      `editorialboard-web-missing-${Date.now()}`,
    );
    const webServer = createWebServer({
      host: '127.0.0.1',
      port: 0,
      webAppDistDir: missingDir,
    });

    const res = await webServer.request('/');
    expect(res.status).toBe(404);
  });
});
