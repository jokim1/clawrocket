import { logger } from '../../logger.js';
import {
  TALK_RUN_MAX_CONCURRENCY,
  TALK_RUN_POLL_MS,
  WEB_HOST,
  WEB_PORT,
} from '../config.js';
import type { TalkExecutor } from '../talks/executor.js';
import {
  ExecutorSettingsService,
  setActiveExecutorSettingsService,
} from '../talks/executor-settings.js';
import { ExecutorCredentialVerifier } from '../talks/executor-credentials-verifier.js';
import { DirectTalkExecutor } from '../talks/direct-executor.js';
import { TalkRunWorker } from '../talks/run-worker.js';

import { createWebServer, WebServerHandle } from './server.js';

export async function startWebServer(): Promise<WebServerHandle> {
  const executorSettings = new ExecutorSettingsService();
  executorSettings.runBootstrapMigration();
  const effectiveConfig = executorSettings.resolveEffectiveConfig();
  const executor: TalkExecutor = new DirectTalkExecutor();

  executorSettings.captureRunningSnapshot(
    effectiveConfig,
    executorSettings.getConfigVersion(),
  );
  setActiveExecutorSettingsService(executorSettings);
  const executorVerifier = new ExecutorCredentialVerifier({
    executorSettings,
  });

  logger.info(
    {
      mode: 'direct_http',
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
    executorSettings,
    executorVerifier,
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
