import type { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { DATA_DIR } from '../../config.js';
import {
  runContainerAgent,
  type ContainerOutput,
} from '../../container-runner.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../../group-folder.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';

import type {
  ExecutorAuthMode,
  ExecutorSettingsService,
  ExecutorVerificationTarget,
  VerifiableExecutorAuthMode,
} from './executor-settings.js';

const HTTP_VERIFY_TIMEOUT_MS = 5_000;
const SUBSCRIPTION_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

type VerificationResult = {
  status: 'verified' | 'invalid' | 'unavailable';
  error?: string | null;
};

export interface ExecutorCredentialVerificationSchedule {
  scheduled: boolean;
  mode: ExecutorAuthMode;
  code:
    | 'scheduled'
    | 'already_verifying'
    | 'selection_required'
    | 'missing_credential'
    | 'mode_none';
  message: string;
}

interface InFlightVerification {
  fingerprint: string;
  promise: Promise<void>;
}

export class ExecutorCredentialVerifier {
  private readonly executorSettings: ExecutorSettingsService;
  private readonly fetchImpl: typeof fetch;
  private readonly runContainer: typeof runContainerAgent;
  private readonly inFlight = new Map<
    VerifiableExecutorAuthMode,
    InFlightVerification
  >();

  constructor(input: {
    executorSettings: ExecutorSettingsService;
    fetchImpl?: typeof fetch;
    runContainer?: typeof runContainerAgent;
  }) {
    this.executorSettings = input.executorSettings;
    this.fetchImpl = input.fetchImpl || fetch;
    this.runContainer = input.runContainer || runContainerAgent;
  }

  scheduleVerification(
    requestedMode?: ExecutorAuthMode,
  ): ExecutorCredentialVerificationSchedule {
    const selectedMode =
      requestedMode || this.executorSettings.getSettingsView().executorAuthMode;
    const target = this.executorSettings.getVerificationTarget(requestedMode);

    if (!target) {
      const blockedReason = this.executorSettings.getExecutionBlockedReason();
      if (selectedMode === 'none') {
        return {
          scheduled: false,
          mode: selectedMode,
          code: 'mode_none',
          message:
            blockedReason ||
            'Select an Anthropic auth mode before requesting verification.',
        };
      }
      return {
        scheduled: false,
        mode: selectedMode,
        code: blockedReason?.includes('Multiple Anthropic credential types')
          ? 'selection_required'
          : 'missing_credential',
        message:
          blockedReason ||
          'The selected Anthropic auth mode has no configured credential to verify.',
      };
    }

    const existing = this.inFlight.get(target.mode);
    if (existing && existing.fingerprint === target.fingerprint) {
      return {
        scheduled: false,
        mode: target.mode,
        code: 'already_verifying',
        message: 'A verification attempt is already in progress for this mode.',
      };
    }

    this.executorSettings.markVerificationStarted(
      target.mode,
      target.fingerprint,
    );

    const promise = this.performVerification(target)
      .then((result) => {
        this.executorSettings.completeVerification(
          target.mode,
          target.fingerprint,
          result,
        );
      })
      .catch((error) => {
        logger.warn(
          { err: error, mode: target.mode },
          'Unexpected executor credential verification failure',
        );
        this.executorSettings.completeVerification(
          target.mode,
          target.fingerprint,
          {
            status: 'unavailable',
            error:
              error instanceof Error
                ? error.message
                : 'Verification failed unexpectedly.',
          },
        );
      })
      .finally(() => {
        const current = this.inFlight.get(target.mode);
        if (current?.fingerprint === target.fingerprint) {
          this.inFlight.delete(target.mode);
        }
      });

    this.inFlight.set(target.mode, {
      fingerprint: target.fingerprint,
      promise,
    });

    return {
      scheduled: true,
      mode: target.mode,
      code: 'scheduled',
      message: 'Verification started.',
    };
  }

  private async performVerification(
    target: ExecutorVerificationTarget,
  ): Promise<VerificationResult> {
    switch (target.mode) {
      case 'subscription':
        return this.verifySubscription(target);
      case 'api_key':
      case 'advanced_bearer':
        return this.verifyHttpCredential(target);
    }
  }

  private async verifyHttpCredential(
    target: ExecutorVerificationTarget,
  ): Promise<VerificationResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort('verification_timeout');
    }, HTTP_VERIFY_TIMEOUT_MS);

    try {
      const endpoint = resolveAnthropicEndpoint(
        target.anthropicBaseUrl,
        '/v1/models',
      );
      const headers: Record<string, string> = {
        accept: 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (target.mode === 'api_key') {
        headers['x-api-key'] = target.credential;
      }
      if (target.mode === 'advanced_bearer') {
        headers.authorization = `Bearer ${target.credential}`;
      }

      const response = await this.fetchImpl(endpoint, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const failureMessage = await readFailureMessage(response);

      if (response.ok) {
        return { status: 'verified' };
      }
      if (
        response.status === 400 ||
        response.status === 401 ||
        response.status === 403
      ) {
        return {
          status: 'invalid',
          error:
            failureMessage || 'The provider rejected the selected credential.',
        };
      }
      return {
        status: 'unavailable',
        error:
          failureMessage ||
          `Verification endpoint returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        status: 'unavailable',
        error:
          error instanceof Error && error.name === 'AbortError'
            ? 'Verification timed out before the provider responded.'
            : error instanceof Error
              ? error.message
              : 'Verification failed before the provider could be reached.',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async verifySubscription(
    target: ExecutorVerificationTarget,
  ): Promise<VerificationResult> {
    const folder = buildVerificationFolder();
    const group: RegisteredGroup = {
      name: 'Executor Subscription Verification',
      folder,
      trigger: '@verify',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
      isMain: false,
    };

    const chunks: string[] = [];
    let processRef: ChildProcess | null = null;
    let timeout: NodeJS.Timeout | null = null;

    try {
      const verificationPromise = this.runContainer(
        group,
        {
          prompt: 'Reply with OK and nothing else.',
          model: target.model,
          toolProfile: 'web_talk',
          groupFolder: folder,
          chatJid: `verify:${folder}`,
          isMain: false,
          assistantName: 'ClawRocket Verify',
          secrets: buildVerificationSecrets(target),
        },
        (proc) => {
          processRef = proc;
        },
        async (output: ContainerOutput) => {
          if (output.result) {
            chunks.push(output.result);
          }
        },
      );

      const timeoutPromise = new Promise<ContainerOutput>((resolve) => {
        timeout = setTimeout(() => {
          if (processRef && !processRef.killed) {
            processRef.kill('SIGTERM');
          }
          resolve({
            status: 'error',
            result: null,
            error: 'Subscription verification timed out.',
          });
        }, SUBSCRIPTION_VERIFY_TIMEOUT_MS);
      });

      const result = await Promise.race([verificationPromise, timeoutPromise]);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }

      if (result.status === 'success') {
        return { status: 'verified' };
      }

      const message =
        result.error?.trim() ||
        chunks.join('\n').trim() ||
        'Subscription verification failed.';
      if (looksLikeAuthFailure(message)) {
        return { status: 'invalid', error: message };
      }
      return {
        status: 'unavailable',
        error: message,
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Subscription verification could not be completed.';
      return {
        status: looksLikeAuthFailure(message) ? 'invalid' : 'unavailable',
        error: message,
      };
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      await cleanupVerificationArtifacts(folder);
    }
  }
}

function buildVerificationFolder(): string {
  return `executorverify${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function resolveAnthropicEndpoint(baseUrl: string, pathname: string): string {
  const url = new URL(baseUrl || DEFAULT_ANTHROPIC_BASE_URL);
  const basePath = url.pathname.endsWith('/')
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${basePath}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function readFailureMessage(response: Response): Promise<string | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    return parsed.error?.message || parsed.message || text;
  } catch {
    return text;
  }
}

function looksLikeAuthFailure(message: string): boolean {
  return [
    /invalid (api key|authentication|auth|oauth|token)/i,
    /authentication (failed|required)/i,
    /auth(entication)? failed/i,
    /unauthori[sz]ed/i,
    /forbidden/i,
    /login (failed|required)/i,
    /credential(s)? (invalid|missing|rejected)/i,
    /subscription (expired|invalid|required)/i,
    /\b401\b/,
    /\b403\b/,
  ].some((pattern) => pattern.test(message));
}

function buildVerificationSecrets(
  target: ExecutorVerificationTarget,
): Record<string, string> {
  if (target.mode === 'subscription') {
    return {
      CLAUDE_CODE_OAUTH_TOKEN: target.credential,
    };
  }
  if (target.mode === 'api_key') {
    return {
      ANTHROPIC_API_KEY: target.credential,
      ANTHROPIC_BASE_URL: target.anthropicBaseUrl,
    };
  }
  return {
    ANTHROPIC_AUTH_TOKEN: target.credential,
    ANTHROPIC_BASE_URL: target.anthropicBaseUrl,
  };
}

async function cleanupVerificationArtifacts(folder: string): Promise<void> {
  const paths = [
    resolveGroupFolderPath(folder),
    path.join(DATA_DIR, 'sessions', folder),
    resolveGroupIpcPath(folder),
  ];

  for (const target of paths) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true });
    } catch (error) {
      logger.debug(
        { err: error, path: target, folder },
        'Failed to clean temporary verification artifacts',
      );
    }
  }
}
