// editorialboard standalone bootstrap.
//
// PR-2 of the PURGE adds this minimal entry point that boots the Hono web
// server directly, without going through the NanoClaw `src/index.ts`
// orchestrator (containers, scheduler, channels, IPC, group queues).
//
// During the PURGE window both bootstraps coexist:
//   - `npm run dev`           → tsx src/index.ts  (legacy NanoClaw)
//   - `npm run dev:editorial` → tsx src/server.ts (this file)
//
// PR-5 deletes src/index.ts and promotes this to the only entry.
// PR-6 swaps `npm run dev` to point at this file.

import { initDatabase } from './db.js';
import { logger } from './logger.js';
import { WEB_HOST, WEB_PORT } from './clawrocket/config.js';
import { createWebServer } from './clawrocket/web/server.js';

async function main(): Promise<void> {
  initDatabase();
  logger.info('Database initialized');

  const server = createWebServer({ host: WEB_HOST, port: WEB_PORT });

  let bound: { host: string; port: number };
  try {
    bound = await server.start();
  } catch (err) {
    logger.error({ err }, 'Failed to start editorialboard web server');
    process.exit(1);
  }
  logger.info(
    { host: bound.host, port: bound.port },
    'editorialboard server ready',
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'editorialboard shutting down');
    try {
      await server.stop();
    } catch (err) {
      logger.error({ err }, 'Error during web server shutdown');
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'editorialboard bootstrap failed');
  process.exit(1);
});
