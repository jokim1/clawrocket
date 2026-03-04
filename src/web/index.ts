import { logger } from '../logger.js';
import { TalkRunQueue } from '../talks/run-queue.js';
import { WEB_HOST, WEB_PORT } from '../config.js';

import { createWebServer, WebServerHandle } from './server.js';

export async function startWebServer(): Promise<WebServerHandle> {
  const server = createWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    runQueue: new TalkRunQueue(),
  });

  const bound = await server.start();
  logger.info({ host: bound.host, port: bound.port }, 'Web API server started');

  return server;
}
