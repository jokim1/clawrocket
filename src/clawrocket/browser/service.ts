import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { chromium, type BrowserContext, type Page } from 'playwright-core';

import { DATA_DIR } from '../../config.js';
import { logger } from '../../logger.js';
import {
  ensureBrowserProfile,
  getBrowserProfileById,
  touchBrowserProfileLastUsed,
  type BrowserProfileSnapshot,
} from '../db/browser-accessors.js';

const REF_ATTRIBUTE = 'data-nanoclaw-ref';
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_ACTION_TIMEOUT_MS = 15000;

export type BrowserResultStatus =
  | 'ok'
  | 'needs_auth'
  | 'awaiting_confirmation'
  | 'error';

export interface BrowserSessionSnapshot {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
}

export interface BrowserOpenResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  sessionId?: string;
  url: string;
  title: string;
  reusedSession: boolean;
  createdProfile: boolean;
  message: string;
}

export interface BrowserSnapshotElement {
  ref: string;
  role: string | null;
  name: string | null;
  tag: string;
  text: string | null;
  href: string | null;
  disabled: boolean;
  checked: boolean;
}

export interface BrowserSnapshotResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  message: string;
}

export interface BrowserActionResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  message: string;
  riskReason?: string;
}

export interface BrowserWaitResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  message: string;
}

export interface BrowserScreenshotResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  url: string;
  title: string;
  path: string;
  contentType: string;
  content: Buffer;
}

export interface BrowserCloseResult {
  status: BrowserResultStatus;
  siteKey: string;
  accountLabel: string | null;
  message: string;
}

export interface BrowserActionAuditInput {
  talkId?: string | null;
  runId?: string | null;
}

interface LiveSession {
  sessionId: string;
  profileId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
  context: BrowserContext;
  page: Page;
}

type PersistentContextLaunchOptions = Parameters<
  typeof chromium.launchPersistentContext
>[1];

function buildProfileMapKey(
  siteKey: string,
  accountLabel: string | null,
): string {
  return accountLabel ? `${siteKey}::${accountLabel}` : siteKey;
}

function resolveViewport(profile: BrowserProfileSnapshot): {
  width: number;
  height: number;
} {
  return profile.viewport;
}

function buildLaunchOptions(
  profile: BrowserProfileSnapshot,
  headed: boolean,
): PersistentContextLaunchOptions {
  const options: PersistentContextLaunchOptions = {
    headless: !headed,
    channel: profile.channel || undefined,
    locale: profile.locale,
    timezoneId: profile.timezoneId,
    viewport: resolveViewport(profile),
    acceptDownloads: true,
    downloadsPath: profile.downloadDir,
  };
  if (profile.userAgent) {
    options.userAgent = profile.userAgent;
  }
  return options;
}

async function ensurePrimaryPage(context: BrowserContext): Promise<Page> {
  const pages = context.pages();
  if (pages.length > 0) {
    return pages[0]!;
  }
  return context.newPage();
}

async function detectAuthState(page: Page): Promise<{
  needsAuth: boolean;
  reason?: string;
}> {
  const url = page.url();
  if (/(login|signin|sign-in|auth|checkpoint|challenge|verify)/i.test(url)) {
    return {
      needsAuth: true,
      reason: `Current page URL suggests an authentication flow: ${url}`,
    };
  }

  try {
    const authSignals = await page.evaluate(() => {
      const documentRef = (globalThis as { document?: any }).document;
      const passwordInput = documentRef?.querySelector?.(
        'input[type="password"]',
      );
      if (passwordInput) {
        return 'Page contains a password field.';
      }

      const bodyText = documentRef?.body?.innerText || '';
      if (/\b(sign in|log in|login|verify your identity)\b/i.test(bodyText)) {
        return 'Page content suggests interactive authentication.';
      }

      return null;
    });

    if (authSignals) {
      return { needsAuth: true, reason: authSignals };
    }
  } catch {
    // Ignore auth detection failures and fall back to the page state we have.
  }

  return { needsAuth: false };
}

async function describeTarget(
  page: Page,
  target: string,
): Promise<{
  ref: string;
  role: string | null;
  label: string | null;
  tag: string | null;
  href: string | null;
  type: string | null;
}> {
  const descriptor = await page
    .locator(`[${REF_ATTRIBUTE}="${target}"]`)
    .first()
    .evaluate((element, refAttribute) => {
      const ref = element.getAttribute(refAttribute) || '';
      const elementRecord = element as {
        value?: unknown;
        textContent?: string | null;
        tagName?: string;
        href?: string | null;
        type?: string | null;
      };
      const label =
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        (typeof elementRecord.value === 'string'
          ? elementRecord.value
          : null) ||
        elementRecord.textContent ||
        null;

      return {
        ref,
        role: element.getAttribute('role'),
        label: label?.trim() || null,
        tag: (elementRecord.tagName || '').toLowerCase(),
        href:
          typeof elementRecord.href === 'string' ? elementRecord.href : null,
        type:
          typeof elementRecord.type === 'string' ? elementRecord.type : null,
      };
    }, REF_ATTRIBUTE);

  return descriptor;
}

function classifyRisk(input: {
  action: string;
  descriptor: {
    role: string | null;
    label: string | null;
    tag: string | null;
    href: string | null;
    type: string | null;
  } | null;
  currentUrl: string;
}): string | null {
  const action = input.action;
  if (
    !['click', 'dblclick'].includes(action) &&
    !(action === 'press' && input.descriptor)
  ) {
    return null;
  }

  const descriptor = input.descriptor;
  if (!descriptor) {
    return null;
  }

  const combined = [
    descriptor.label || '',
    descriptor.role || '',
    descriptor.tag || '',
    descriptor.type || '',
    descriptor.href || '',
    input.currentUrl,
  ]
    .join(' ')
    .toLowerCase();

  if (
    /\b(pay|purchase|checkout|book|order|place order|confirm|accept|approve|delete|remove|submit|send|sign)\b/.test(
      combined,
    )
  ) {
    return `Target appears to be a likely final-action control (${descriptor.label || descriptor.tag || descriptor.role || 'unknown target'}).`;
  }

  if (descriptor.type === 'submit') {
    return 'Target is a submit control.';
  }

  return null;
}

async function collectSnapshot(
  page: Page,
  interactiveOnly: boolean,
  maxElements: number,
): Promise<BrowserSnapshotElement[]> {
  return page.evaluate(
    ({ interactiveOnly, maxElements, refAttribute }) => {
      const windowRef = globalThis as { getComputedStyle?: (node: any) => any };
      const documentRef = (globalThis as { document?: any }).document;
      const isVisible = (element: any): boolean => {
        const style = windowRef.getComputedStyle?.(element);
        if (style.visibility === 'hidden' || style.display === 'none') {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };

      const selector = interactiveOnly
        ? [
            'a',
            'button',
            'input',
            'select',
            'textarea',
            '[role="button"]',
            '[role="link"]',
            '[role="checkbox"]',
            '[role="tab"]',
            '[contenteditable="true"]',
          ].join(',')
        : 'body *';

      documentRef
        ?.querySelectorAll?.(`[${refAttribute}]`)
        .forEach((node: any) => node.removeAttribute(refAttribute));

      const nodes = (
        Array.from(documentRef?.querySelectorAll?.(selector) ?? []) as any[]
      )
        .filter((node) => isVisible(node))
        .slice(0, maxElements);

      return nodes.map((node: any, index) => {
        const element = node as {
          tagName?: string;
          textContent?: string | null;
          href?: string | null;
          disabled?: boolean;
          checked?: boolean;
        };
        const ref = `e${index + 1}`;
        node.setAttribute(refAttribute, ref);

        const tag = (element.tagName || '').toLowerCase();
        const role = node.getAttribute('role');
        const text =
          node.getAttribute('aria-label') ||
          node.getAttribute('title') ||
          element.textContent ||
          null;
        const href = typeof element.href === 'string' ? element.href : null;
        const disabled =
          typeof element.disabled === 'boolean'
            ? element.disabled
            : node.getAttribute('aria-disabled') === 'true';
        const checked =
          typeof element.checked === 'boolean'
            ? element.checked
            : node.getAttribute('aria-checked') === 'true';

        return {
          ref,
          role,
          name:
            node.getAttribute('aria-label') ||
            node.getAttribute('name') ||
            node.getAttribute('title') ||
            null,
          tag,
          text: text?.trim() || null,
          href,
          disabled,
          checked,
        };
      });
    },
    {
      interactiveOnly,
      maxElements,
      refAttribute: REF_ATTRIBUTE,
    },
  );
}

function basenameList(files?: string[]): string[] | undefined {
  if (!files) return undefined;
  return files.map((file) => path.basename(file));
}

export class BrowserService {
  private readonly sessionsById = new Map<string, LiveSession>();
  private readonly profileSessionIds = new Map<string, string>();

  getSessionSnapshot(sessionId: string): BrowserSessionSnapshot | null {
    const session = this.sessionsById.get(sessionId);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      headed: session.headed,
    };
  }

  private async createSession(input: {
    profile: BrowserProfileSnapshot;
    headed: boolean;
  }): Promise<LiveSession> {
    fs.mkdirSync(input.profile.profilePath, { recursive: true });
    fs.mkdirSync(input.profile.downloadDir, { recursive: true });

    const context = await chromium.launchPersistentContext(
      input.profile.profilePath,
      buildLaunchOptions(input.profile, input.headed),
    );
    const page = await ensurePrimaryPage(context);
    page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
    page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS);

    const session: LiveSession = {
      sessionId: `bs_${randomUUID()}`,
      profileId: input.profile.id,
      siteKey: input.profile.siteKey,
      accountLabel: input.profile.accountLabel,
      headed: input.headed,
      context,
      page,
    };

    context.once('close', () => {
      this.profileSessionIds.delete(
        buildProfileMapKey(session.siteKey, session.accountLabel),
      );
      this.sessionsById.delete(session.sessionId);
    });

    this.sessionsById.set(session.sessionId, session);
    this.profileSessionIds.set(
      buildProfileMapKey(session.siteKey, session.accountLabel),
      session.sessionId,
    );
    return session;
  }

  private async relaunchSession(
    liveSession: LiveSession,
    headed: boolean,
  ): Promise<LiveSession> {
    const profile = getBrowserProfileById(liveSession.profileId);
    if (!profile) {
      throw new Error('Browser profile not found for live session');
    }
    await liveSession.context.close();
    return this.createSession({ profile, headed });
  }

  private getSessionOrThrow(sessionId: string): LiveSession {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw new Error(`Browser session ${sessionId} not found`);
    }
    return session;
  }

  async open(input: {
    siteKey: string;
    url: string;
    accountLabel?: string | null;
    headed?: boolean;
    reuseSession?: boolean;
  }): Promise<BrowserOpenResult> {
    const { profile, created } = ensureBrowserProfile({
      siteKey: input.siteKey,
      accountLabel: input.accountLabel,
    });
    const profileKey = buildProfileMapKey(
      profile.siteKey,
      profile.accountLabel,
    );
    const headed = input.headed === true;
    const reuseSession = input.reuseSession !== false;

    let session: LiveSession | null = null;
    const existingSessionId = this.profileSessionIds.get(profileKey);
    if (existingSessionId) {
      const liveSession = this.sessionsById.get(existingSessionId) || null;
      if (liveSession) {
        if (!reuseSession) {
          return {
            status: 'error',
            siteKey: profile.siteKey,
            accountLabel: profile.accountLabel,
            url: liveSession.page.url(),
            title: await liveSession.page.title(),
            reusedSession: false,
            createdProfile: created,
            message:
              'A live browser session already exists for this profile. Reuse it or close it before opening another session.',
          };
        }

        session =
          liveSession.headed === headed
            ? liveSession
            : await this.relaunchSession(liveSession, headed);
      }
    }

    if (!session) {
      session = await this.createSession({ profile, headed });
    }

    await session.page.goto(input.url, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
    });

    touchBrowserProfileLastUsed(profile.id);
    const authState = await detectAuthState(session.page);
    if (authState.needsAuth) {
      return {
        status: 'needs_auth',
        siteKey: profile.siteKey,
        accountLabel: profile.accountLabel,
        sessionId: session.sessionId,
        url: session.page.url(),
        title: await session.page.title(),
        reusedSession: !created && Boolean(existingSessionId && reuseSession),
        createdProfile: created,
        message:
          authState.reason ||
          'This site requires interactive authentication for this profile.',
      };
    }

    return {
      status: 'ok',
      siteKey: profile.siteKey,
      accountLabel: profile.accountLabel,
      sessionId: session.sessionId,
      url: session.page.url(),
      title: await session.page.title(),
      reusedSession: !created && Boolean(existingSessionId && reuseSession),
      createdProfile: created,
      message: 'Browser session ready.',
    };
  }

  async openSetupSession(input: {
    siteKey: string;
    accountLabel?: string | null;
    url?: string | null;
  }): Promise<BrowserOpenResult> {
    const { profile, created } = ensureBrowserProfile({
      siteKey: input.siteKey,
      accountLabel: input.accountLabel,
    });
    const profileKey = buildProfileMapKey(
      profile.siteKey,
      profile.accountLabel,
    );

    const existingSessionId = this.profileSessionIds.get(profileKey);
    const existingSession = existingSessionId
      ? this.sessionsById.get(existingSessionId) || null
      : null;

    const session =
      existingSession && existingSession.headed
        ? existingSession
        : existingSession
          ? await this.relaunchSession(existingSession, true)
          : await this.createSession({ profile, headed: true });

    if (input.url) {
      await session.page.goto(input.url, {
        waitUntil: 'domcontentloaded',
        timeout: DEFAULT_NAVIGATION_TIMEOUT_MS,
      });
    }

    touchBrowserProfileLastUsed(profile.id);
    return {
      status: 'ok',
      siteKey: profile.siteKey,
      accountLabel: profile.accountLabel,
      sessionId: session.sessionId,
      url: session.page.url(),
      title: await session.page.title(),
      reusedSession: Boolean(existingSession),
      createdProfile: created,
      message:
        'Setup session opened. Complete authentication in the browser, then return to the terminal.',
    };
  }

  async snapshot(input: {
    sessionId: string;
    interactiveOnly?: boolean;
    maxElements?: number;
  }): Promise<BrowserSnapshotResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const elements = await collectSnapshot(
      session.page,
      input.interactiveOnly !== false,
      input.maxElements && input.maxElements > 0
        ? Math.floor(input.maxElements)
        : 200,
    );

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      elements,
      message: 'Snapshot collected.',
    };
  }

  async act(
    input: {
      sessionId: string;
      action: string;
      target?: string;
      value?: string;
      files?: string[];
      confirm?: boolean;
      timeoutMs?: number;
    },
    audit: BrowserActionAuditInput = {},
  ): Promise<BrowserActionResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const urlBefore = session.page.url();
    let targetDescriptor: Awaited<ReturnType<typeof describeTarget>> | null =
      null;
    let gatingDecision = 'auto_allowed';
    let riskReason: string | null = null;

    try {
      if (input.target) {
        targetDescriptor = await describeTarget(session.page, input.target);
      }
    } catch {
      targetDescriptor = null;
    }

    riskReason = classifyRisk({
      action: input.action,
      descriptor: targetDescriptor,
      currentUrl: urlBefore,
    });
    if (riskReason && input.confirm !== true) {
      gatingDecision = 'blocked_confirmation';
      await this.logAudit({
        event: 'browser_action_audit',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        sessionId: session.sessionId,
        action: input.action,
        targetRef: targetDescriptor?.ref ?? input.target ?? null,
        targetRole: targetDescriptor?.role ?? null,
        targetLabel: targetDescriptor?.label ?? null,
        urlBefore,
        urlAfter: urlBefore,
        confirmFlag: false,
        gatingDecision,
        riskReason,
        talkId: audit.talkId ?? null,
        runId: audit.runId ?? null,
        valueProvided: input.value !== undefined,
        valueLength: input.value?.length ?? null,
        uploadFiles: basenameList(input.files) ?? null,
      });

      return {
        status: 'awaiting_confirmation',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: urlBefore,
        title: await session.page.title(),
        message: 'Action requires confirmation before proceeding.',
        riskReason,
      };
    }

    if (riskReason && input.confirm === true) {
      gatingDecision = 'confirmed';
    }

    const timeout = input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
    const locator = input.target
      ? session.page.locator(`[${REF_ATTRIBUTE}="${input.target}"]`).first()
      : null;

    switch (input.action) {
      case 'navigate':
        if (!input.value) {
          throw new Error('navigate requires value');
        }
        await session.page.goto(input.value, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        break;
      case 'click':
        if (!locator) throw new Error('click requires target');
        await locator.click({ timeout });
        break;
      case 'dblclick':
        if (!locator) throw new Error('dblclick requires target');
        await locator.dblclick({ timeout });
        break;
      case 'fill':
        if (!locator) throw new Error('fill requires target');
        await locator.fill(input.value ?? '', { timeout });
        break;
      case 'type':
        if (!locator) throw new Error('type requires target');
        await locator.type(input.value ?? '', { timeout });
        break;
      case 'press':
        if (locator) {
          await locator.press(input.value || 'Enter', { timeout });
        } else {
          await session.page.keyboard.press(input.value || 'Enter');
        }
        break;
      case 'select':
        if (!locator) throw new Error('select requires target');
        await locator.selectOption(input.value ?? '', { timeout });
        break;
      case 'check':
        if (!locator) throw new Error('check requires target');
        await locator.check({ timeout });
        break;
      case 'uncheck':
        if (!locator) throw new Error('uncheck requires target');
        await locator.uncheck({ timeout });
        break;
      case 'hover':
        if (!locator) throw new Error('hover requires target');
        await locator.hover({ timeout });
        break;
      case 'scroll':
        await session.page.evaluate(
          (value) => {
            (
              globalThis as { scrollBy?: (x: number, y: number) => void }
            ).scrollBy?.(0, value);
          },
          Number.parseInt(input.value || '600', 10),
        );
        break;
      case 'upload':
        if (!locator) throw new Error('upload requires target');
        if (!input.files?.length) {
          throw new Error('upload requires files');
        }
        await locator.setInputFiles(input.files);
        break;
      case 'back':
        await session.page.goBack({ timeout, waitUntil: 'domcontentloaded' });
        break;
      case 'forward':
        await session.page.goForward({
          timeout,
          waitUntil: 'domcontentloaded',
        });
        break;
      case 'reload':
        await session.page.reload({ timeout, waitUntil: 'domcontentloaded' });
        break;
      default:
        throw new Error(`Unsupported browser action: ${input.action}`);
    }

    touchBrowserProfileLastUsed(session.profileId);
    const authState = await detectAuthState(session.page);
    const urlAfter = session.page.url();
    await this.logAudit({
      event: 'browser_action_audit',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      sessionId: session.sessionId,
      action: input.action,
      targetRef: targetDescriptor?.ref ?? input.target ?? null,
      targetRole: targetDescriptor?.role ?? null,
      targetLabel: targetDescriptor?.label ?? null,
      urlBefore,
      urlAfter,
      confirmFlag: input.confirm === true,
      gatingDecision,
      riskReason,
      talkId: audit.talkId ?? null,
      runId: audit.runId ?? null,
      valueProvided: input.value !== undefined,
      valueLength: input.value?.length ?? null,
      uploadFiles: basenameList(input.files) ?? null,
    });

    if (authState.needsAuth) {
      return {
        status: 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: urlAfter,
        title: await session.page.title(),
        message:
          authState.reason ||
          'This action led to an interactive authentication step.',
      };
    }

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: urlAfter,
      title: await session.page.title(),
      message: 'Browser action completed.',
      ...(riskReason ? { riskReason } : {}),
    };
  }

  private async logAudit(payload: Record<string, unknown>): Promise<void> {
    logger.info(payload, 'browser_action_audit');
  }

  async wait(input: {
    sessionId: string;
    conditionType: 'url' | 'text' | 'element' | 'load';
    value?: string;
    timeoutMs?: number;
  }): Promise<BrowserWaitResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const timeout = input.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

    switch (input.conditionType) {
      case 'url':
        if (!input.value) {
          throw new Error('browser_wait(url) requires value');
        }
        await session.page.waitForURL(input.value, { timeout });
        break;
      case 'text':
        if (!input.value) {
          throw new Error('browser_wait(text) requires value');
        }
        await session.page
          .locator(`text=${input.value}`)
          .first()
          .waitFor({ timeout });
        break;
      case 'element':
        if (!input.value) {
          throw new Error('browser_wait(element) requires value');
        }
        await session.page
          .locator(`[${REF_ATTRIBUTE}="${input.value}"]`)
          .first()
          .waitFor({ timeout });
        break;
      case 'load':
        await session.page.waitForLoadState(
          (input.value as 'load' | 'domcontentloaded' | 'networkidle') ||
            'load',
          { timeout },
        );
        break;
      default:
        throw new Error(
          `Unsupported browser_wait condition: ${input.conditionType}`,
        );
    }

    const authState = await detectAuthState(session.page);
    if (authState.needsAuth) {
      return {
        status: 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: session.page.url(),
        title: await session.page.title(),
        message:
          authState.reason ||
          'This page now requires interactive authentication.',
      };
    }

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      message: 'Wait condition satisfied.',
    };
  }

  async screenshot(input: {
    sessionId: string;
    fullPage?: boolean;
    label?: string;
  }): Promise<BrowserScreenshotResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    const content = await session.page.screenshot({
      type: 'png',
      fullPage: input.fullPage === true,
    });
    const label = input.label?.trim() || 'screenshot';
    const dir = path.join(DATA_DIR, 'browser-artifacts', session.siteKey);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(
      dir,
      `${Date.now()}-${label.replace(/[^a-zA-Z0-9._-]+/g, '-')}.png`,
    );
    fs.writeFileSync(filePath, content);

    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      url: session.page.url(),
      title: await session.page.title(),
      path: filePath,
      contentType: 'image/png',
      content,
    };
  }

  async close(input: {
    sessionId: string;
    keepProfile?: boolean;
  }): Promise<BrowserCloseResult> {
    const session = this.getSessionOrThrow(input.sessionId);
    await session.context.close();
    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      message: 'Browser session closed.',
    };
  }
}

let browserService: BrowserService | null = null;

export function getBrowserService(): BrowserService {
  if (!browserService) {
    browserService = new BrowserService();
  }
  return browserService;
}

export function _resetBrowserServiceForTests(): void {
  browserService = null;
}
