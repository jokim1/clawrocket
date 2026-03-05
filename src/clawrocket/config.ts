import { readEnvFile } from '../env.js';

const envConfig = readEnvFile([
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
  'TALK_EXECUTOR_DEFAULT_ALIAS',
  'TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON',
  'TALK_EXECUTOR_WEB_GROUP_FOLDER',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

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

export const TALK_EXECUTOR_DEFAULT_ALIAS =
  process.env.TALK_EXECUTOR_DEFAULT_ALIAS ||
  envConfig.TALK_EXECUTOR_DEFAULT_ALIAS ||
  'Mock';

export const TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON =
  process.env.TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON ||
  envConfig.TALK_EXECUTOR_ALIAS_MODEL_MAP_JSON ||
  '';

export const TALK_EXECUTOR_WEB_GROUP_FOLDER =
  process.env.TALK_EXECUTOR_WEB_GROUP_FOLDER ||
  envConfig.TALK_EXECUTOR_WEB_GROUP_FOLDER ||
  'web-talks';

const TALK_EXECUTOR_ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY || envConfig.ANTHROPIC_API_KEY || '';
const TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN =
  process.env.CLAUDE_CODE_OAUTH_TOKEN ||
  envConfig.CLAUDE_CODE_OAUTH_TOKEN ||
  '';

export const TALK_EXECUTOR_HAS_PROVIDER_AUTH =
  TALK_EXECUTOR_ANTHROPIC_API_KEY.length > 0 ||
  TALK_EXECUTOR_CLAUDE_OAUTH_TOKEN.length > 0;
