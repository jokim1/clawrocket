import net from 'net';
import { randomUUID } from 'crypto';

interface BrowserBridgeRequest {
  requestId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: {
    runId: string;
    userId: string;
    talkId?: string | null;
    timeoutProfile?: 'default' | 'fast_lane';
  };
}

interface BrowserBridgeResponse {
  requestId: string;
  result: string;
  isError?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function executeBrowserBridgeTool(input: {
  socketPath: string;
  toolName: string;
  args: Record<string, unknown>;
  runId: string;
  userId: string;
  talkId?: string | null;
  timeoutProfile?: 'default' | 'fast_lane';
  timeoutMs?: number;
}): Promise<BrowserBridgeResponse> {
  const request: BrowserBridgeRequest = {
    requestId: `bridge_${randomUUID()}`,
    toolName: input.toolName,
    args: input.args,
    context: {
      runId: input.runId,
      userId: input.userId,
      talkId: input.talkId ?? null,
      timeoutProfile: input.timeoutProfile ?? 'default',
    },
  };

  return new Promise<BrowserBridgeResponse>((resolve, reject) => {
    const socket = net.createConnection(input.socketPath);
    socket.setEncoding('utf8');
    let responseRaw = '';
    let settled = false;

    const finish = (
      fn: (value: BrowserBridgeResponse | Error) => void,
      value: BrowserBridgeResponse | Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `Browser bridge request timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`,
        ),
      );
    }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.end(JSON.stringify(request));
    });

    socket.on('data', (chunk) => {
      responseRaw += chunk;
    });

    socket.on('error', (error) => {
      finish(reject, error);
    });

    socket.on('close', () => {
      if (settled) return;
      try {
        const response = JSON.parse(responseRaw) as BrowserBridgeResponse;
        finish(resolve, response);
      } catch (error) {
        finish(
          reject,
          error instanceof Error
            ? error
            : new Error('Browser bridge returned invalid JSON.'),
        );
      }
    });
  });
}
