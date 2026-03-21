import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { BrowserRunPausedError } from './run-paused-error.js';
import { executeBrowserTool } from '../tools/browser-tools.js';

const BRIDGE_DIR = path.join(DATA_DIR, 'browser-bridge');
export const BROWSER_BRIDGE_SOCKET_PATH = path.join(BRIDGE_DIR, 'browser.sock');
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const runAborters = new Map<string, () => void>();

export interface BrowserBridgeRequest {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: {
    runId: string;
    userId: string;
    talkId?: string | null;
  };
}

export interface BrowserBridgeResponse {
  requestId: string;
  result: string;
  isError?: boolean;
}

function serializeResponse(response: BrowserBridgeResponse): string {
  return JSON.stringify(response);
}

function abortBrowserBridgeRun(runId: string): boolean {
  const aborter = runAborters.get(runId);
  if (!aborter) {
    return false;
  }
  try {
    aborter();
    return true;
  } catch (error) {
    logger.warn(
      { err: error, runId },
      'Browser bridge run abort callback threw unexpectedly',
    );
    return false;
  }
}

export async function executeBrowserBridgeRequest(input: {
  request: BrowserBridgeRequest;
  signal: AbortSignal;
}): Promise<BrowserBridgeResponse | null> {
  try {
    const result = await executeBrowserTool({
      toolName: input.request.toolName,
      args: input.request.args,
      context: {
        signal: input.signal,
        runId: input.request.context.runId,
        userId: input.request.context.userId,
        talkId: input.request.context.talkId ?? null,
      },
    });
    return {
      requestId: input.request.requestId,
      result: result.result,
      ...(result.isError ? { isError: true } : {}),
    };
  } catch (error) {
    if (error instanceof BrowserRunPausedError) {
      const aborted = abortBrowserBridgeRun(input.request.context.runId);
      if (!aborted) {
        logger.warn(
          { runId: input.request.context.runId },
          'Browser bridge paused a run with no registered abort callback',
        );
      }
      return null;
    }
    return {
      requestId: input.request.requestId,
      result: JSON.stringify({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }),
      isError: true,
    };
  }
}
export class BrowserBridgeServer {
  private server: net.Server | null = null;
  private startPromise: Promise<string> | null = null;

  async start(): Promise<string> {
    if (this.server) {
      return BROWSER_BRIDGE_SOCKET_PATH;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      fs.mkdirSync(BRIDGE_DIR, { recursive: true });
      try {
        fs.rmSync(BROWSER_BRIDGE_SOCKET_PATH, { force: true });
      } catch {
        // ignored
      }

      const server = net.createServer((socket) => {
        socket.setEncoding('utf8');
        socket.unref();
        let raw = '';
        let finished = false;
        let controller: AbortController | null = null;

        const writeError = (message: string) => {
          if (finished) return;
          finished = true;
          try {
            socket.end(
              serializeResponse({
                requestId: 'unknown',
                result: JSON.stringify({
                  status: 'error',
                  message,
                }),
                isError: true,
              }),
            );
          } catch {
            socket.destroy();
          }
        };

        const abortExecution = (reason: unknown) => {
          if (!controller || controller.signal.aborted) {
            return;
          }
          controller.abort(
            reason instanceof Error
              ? reason
              : new Error(
                  typeof reason === 'string'
                    ? reason
                    : 'Browser bridge request was aborted.',
                ),
          );
        };
        socket.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > MAX_REQUEST_BYTES) {
            writeError('Browser bridge request exceeded the maximum size.');
          }
        });

        socket.on('error', (error) => {
          logger.warn({ err: error }, 'Browser bridge socket error');
          abortExecution(error);
        });

        socket.on('close', () => {
          if (finished) return;
          finished = true;
          abortExecution('Browser bridge client disconnected.');
        });

        socket.on('end', async () => {
          if (finished) return;
          let request: BrowserBridgeRequest;
          try {
            request = JSON.parse(raw) as BrowserBridgeRequest;
          } catch {
            writeError('Browser bridge request was not valid JSON.');
            return;
          }

          controller = new AbortController();

          const response = await executeBrowserBridgeRequest({
            request,
            signal: controller.signal,
          });
          if (finished || socket.destroyed) {
            return;
          }
          if (!response) {
            finished = true;
            socket.destroy();
            return;
          }
          finished = true;
          socket.end(serializeResponse(response));
        });
      });

      server.unref();
      server.once('error', (error) => {
        this.server = null;
        this.startPromise = null;
        reject(error);
      });
      server.listen(BROWSER_BRIDGE_SOCKET_PATH, () => {
        this.server = server;
        this.startPromise = null;
        resolve(BROWSER_BRIDGE_SOCKET_PATH);
      });
    });

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    try {
      fs.rmSync(BROWSER_BRIDGE_SOCKET_PATH, { force: true });
    } catch {
      // ignored
    }
  }
}

let bridgeServer: BrowserBridgeServer | null = null;

export function registerBrowserBridgeRunAbort(
  runId: string,
  aborter: () => void,
): void {
  runAborters.set(runId, aborter);
}

export function unregisterBrowserBridgeRunAbort(runId: string): void {
  runAborters.delete(runId);
}
export async function ensureBrowserBridgeServer(): Promise<string> {
  if (!bridgeServer) {
    bridgeServer = new BrowserBridgeServer();
  }
  return bridgeServer.start();
}

export async function _stopBrowserBridgeServerForTests(): Promise<void> {
  if (!bridgeServer) return;
  await bridgeServer.stop();
  bridgeServer = null;
}
