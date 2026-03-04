import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'WEB_ENABLED',
  'WEB_HOST',
  'WEB_PORT',
  'WEB_SECURE_COOKIES',
  'AUTH_DEV_MODE',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REDIRECT_URI',
  'ACCESS_TOKEN_TTL_SEC',
  'REFRESH_TOKEN_TTL_SEC',
  'DEVICE_CODE_TTL_SEC',
  'TALK_RUN_POLL_MS',
  'TALK_RUN_MAX_CONCURRENCY',
  'TALK_MOCK_EXECUTION_MS',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const WEB_ENABLED =
  (process.env.WEB_ENABLED || envConfig.WEB_ENABLED || 'true') === 'true';
export const WEB_HOST =
  process.env.WEB_HOST || envConfig.WEB_HOST || '127.0.0.1';
export const WEB_PORT = parseInt(
  process.env.WEB_PORT || envConfig.WEB_PORT || '3210',
  10,
);
export const WEB_SECURE_COOKIES =
  (process.env.WEB_SECURE_COOKIES ||
    envConfig.WEB_SECURE_COOKIES ||
    'false') === 'true';
export const AUTH_DEV_MODE =
  (process.env.AUTH_DEV_MODE || envConfig.AUTH_DEV_MODE || 'true') === 'true';
export const GOOGLE_OAUTH_CLIENT_ID =
  process.env.GOOGLE_OAUTH_CLIENT_ID || envConfig.GOOGLE_OAUTH_CLIENT_ID || '';
export const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
  envConfig.GOOGLE_OAUTH_CLIENT_SECRET ||
  '';
export const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||
  envConfig.GOOGLE_OAUTH_REDIRECT_URI ||
  '';
export const ACCESS_TOKEN_TTL_SEC = parseInt(
  process.env.ACCESS_TOKEN_TTL_SEC || envConfig.ACCESS_TOKEN_TTL_SEC || '3600',
  10,
);
export const REFRESH_TOKEN_TTL_SEC = parseInt(
  process.env.REFRESH_TOKEN_TTL_SEC ||
    envConfig.REFRESH_TOKEN_TTL_SEC ||
    `${30 * 24 * 60 * 60}`,
  10,
);
export const DEVICE_CODE_TTL_SEC = parseInt(
  process.env.DEVICE_CODE_TTL_SEC || envConfig.DEVICE_CODE_TTL_SEC || '600',
  10,
);
const talkRunPollMs = parseInt(
  process.env.TALK_RUN_POLL_MS || envConfig.TALK_RUN_POLL_MS || '500',
  10,
);
export const TALK_RUN_POLL_MS = Number.isFinite(talkRunPollMs)
  ? Math.max(10, talkRunPollMs)
  : 500;
export const TALK_RUN_MAX_CONCURRENCY = Math.max(
  1,
  parseInt(
    process.env.TALK_RUN_MAX_CONCURRENCY ||
      envConfig.TALK_RUN_MAX_CONCURRENCY ||
      '1',
    10,
  ) || 1,
);
const talkMockExecutionMs = parseInt(
  process.env.TALK_MOCK_EXECUTION_MS ||
    envConfig.TALK_MOCK_EXECUTION_MS ||
    '300',
  10,
);
export const TALK_MOCK_EXECUTION_MS = Number.isFinite(talkMockExecutionMs)
  ? Math.max(0, talkMockExecutionMs)
  : 300;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
