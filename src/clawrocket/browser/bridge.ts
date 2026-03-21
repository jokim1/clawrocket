import fs from 'fs';
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import { executeBrowserTool } from '../tools/browser-tools.js';

const BRIDGE_DIR = path.join(DATA_DIR, 'browser-bridge');
export const BROWSER_BRIDGE_SOCKET_PATH = path.join(
  BRIDGE_DIR,
  'browser.sock',
);
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

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

        socket.on('data', (chunk) => {
          raw += chunk;
          if (raw.length > MAX_REQUEST_BYTES) {
            writeError('Browser bridge request exceeded the maximum size.');
          }
        });

        socket.on('error', (error) => {
          logger.warn({ err: error }, 'Browser bridge socket error');
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

          try {
            const result = await executeBrowserTool({
              toolName: request.toolName,
              args: request.args,
              context: {
                signal: new AbortController().signal,
                runId: request.context.runId,
                userId: request.context.userId,
                talkId: request.context.talkId ?? null,
              },
            });
            finished = true;
            socket.end(
              serializeResponse({
                requestId: request.requestId,
                result: result.result,
                ...(result.isError ? { isError: true } : {}),
              }),
            );
          } catch (error) {
            finished = true;
            socket.end(
              serializeResponse({
                requestId: request.requestId,
                result: JSON.stringify({
                  status: 'error',
                  message:
                    error instanceof Error ? error.message : String(error),
                }),
                isError: true,
              }),
            );
          }
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
