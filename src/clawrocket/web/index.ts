import { logger } from '../../logger.js';
import {
  TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON,
  TALK_EXECUTOR_HAS_PROVIDER_AUTH,
  TALK_RUN_MAX_CONCURRENCY,
  TALK_RUN_POLL_MS,
  WEB_HOST,
  WEB_PORT,
} from '../config.js';
import type { TalkExecutor } from '../talks/executor.js';
import { MockTalkExecutor } from '../talks/mock-executor.js';
import {
  hasValidAliasModelMapConfig,
  RealTalkExecutor,
} from '../talks/real-executor.js';
import { TalkRunWorker } from '../talks/run-worker.js';

import { createWebServer, WebServerHandle } from './server.js';

export async function startWebServer(): Promise<WebServerHandle> {
  const hasValidAliasMap = hasValidAliasModelMapConfig(
    TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON,
  );
  const useRealExecutor = TALK_EXECUTOR_HAS_PROVIDER_AUTH && hasValidAliasMap;
  const executor: TalkExecutor = useRealExecutor
    ? new RealTalkExecutor()
    : new MockTalkExecutor();

  logger.info(
    {
      mode: useRealExecutor ? 'real' : 'mock',
      hasProviderAuth: TALK_EXECUTOR_HAS_PROVIDER_AUTH,
      hasValidAliasMap,
    },
    'Talk executor mode selected',
  );

  const runWorker = new TalkRunWorker({
    executor,
    pollMs: TALK_RUN_POLL_MS,
    maxConcurrency: TALK_RUN_MAX_CONCURRENCY,
  });
  await runWorker.start();

  const server = createWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    runWorker,
  });

  let bound: { host: string; port: number };
  try {
    bound = await server.start();
  } catch (error) {
    await runWorker.stop();
    throw error;
  }
  logger.info({ host: bound.host, port: bound.port }, 'Web API server started');

  const originalStop = server.stop.bind(server);
  server.stop = async () => {
    await runWorker.stop();
    await originalStop();
  };

  return server;
}
