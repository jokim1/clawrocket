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
import { CleanTalkExecutor } from '../talks/new-executor.js';
import { TalkRunWorker } from '../talks/run-worker.js';

import { createWebServer, WebServerHandle } from './server.js';

export interface StartWebServerOptions {
  onTalkTerminal?: (talkId: string) => void;
  onChannelDeliveryQueued?: () => void;
  sendChannelTestMessage?: (bindingId: string, text: string) => Promise<void>;
}

export async function startWebServer(
  input?: StartWebServerOptions,
): Promise<WebServerHandle> {
  const executorSettings = new ExecutorSettingsService();
  executorSettings.runBootstrapMigration();
  const effectiveConfig = executorSettings.resolveEffectiveConfig();
  // Feature flag: set NANOCLAW_USE_CLEAN_EXECUTOR=1 to use the new architecture
  const useCleanExecutor = process.env.NANOCLAW_USE_CLEAN_EXECUTOR === '1';
  const executor: TalkExecutor = useCleanExecutor
    ? new CleanTalkExecutor()
    : new DirectTalkExecutor();

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
      executor: useCleanExecutor ? 'clean' : 'legacy',
    },
    'Talk executor mode selected',
  );

  const runWorker = new TalkRunWorker({
    executor,
    pollMs: TALK_RUN_POLL_MS,
    maxConcurrency: TALK_RUN_MAX_CONCURRENCY,
    onTalkTerminal: input?.onTalkTerminal,
    onChannelDeliveryQueued: input?.onChannelDeliveryQueued,
  });
  await runWorker.start();

  const server = createWebServer({
    host: WEB_HOST,
    port: WEB_PORT,
    runWorker,
    executorSettings,
    executorVerifier,
    sendChannelTestMessage: input?.sendChannelTestMessage,
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
  server.runWorker = runWorker;

  return server;
}
