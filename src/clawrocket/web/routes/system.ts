import { isDatabaseHealthy } from '../../db/index.js';
import { ApiEnvelope } from '../types.js';

// PR-3 of the PURGE collapsed this to editorial-only signals: process + DB.
// Container runtime, channel registry, keychain status all died with the
// chassis. /api/v1/health remains the single endpoint editorial deploy
// monitoring hits.

export interface DeepStatus {
  process: 'ok';
  db: 'ok' | 'error';
}

export async function healthResponse(
  dbHealthyCheck: () => boolean = isDatabaseHealthy,
): Promise<ApiEnvelope<{ status: 'ok' }>> {
  const dbHealthy = dbHealthyCheck();
  if (!dbHealthy) {
    return {
      ok: false,
      error: {
        code: 'db_unavailable',
        message: 'Database is not readable',
      },
    };
  }

  return {
    ok: true,
    data: { status: 'ok' },
  };
}

export async function statusResponse(): Promise<ApiEnvelope<DeepStatus>> {
  const dbHealthy = isDatabaseHealthy();
  return {
    ok: true,
    data: {
      process: 'ok',
      db: dbHealthy ? 'ok' : 'error',
    },
  };
}
