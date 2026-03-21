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
const HUMAN_ONLY_CHECKPOINT_REGEX =
  /\b(captcha|not a robot|verify you are human|security check|complete the challenge|press and hold)\b/i;
const INTERACTIVE_AUTH_CHECKPOINT_REGEX =
  /\b(sign in|log in|login|verify your identity|approve sign[- ]?in|check your phone|check your device|open (the )?(linkedin )?app|authentication app|verification code|enter the code|two-step verification|2-step verification|two factor authentication|two-factor authentication|2fa|confirm (that )?it'?s you|use your passkey)\b/i;

export type BrowserResultStatus =
  | 'ok'
  | 'needs_auth'
  | 'human_step_required'
  | 'awaiting_confirmation'
  | 'error';

export type BrowserBlockedKind =
  | 'auth_required'
  | 'confirmation_required'
  | 'human_step_required';

export type BrowserSessionState =
  | 'active'
  | 'blocked'
  | 'takeover'
  | 'closed'
  | 'dead';

export type BrowserSessionOwner = 'agent' | 'user';

export interface BrowserSessionSnapshot {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  headed: boolean;
}

export interface BrowserSessionStatusSnapshot extends BrowserSessionSnapshot {
  state: BrowserSessionState;
  owner: BrowserSessionOwner;
  blockedKind: BrowserBlockedKind | null;
  blockedMessage: string | null;
  currentUrl: string;
  currentTitle: string;
  lastUpdatedAt: string;
}

export interface BrowserRunCarriedSession {
  sessionId: string;
  siteKey: string;
  accountLabel: string | null;
  lastKnownState: BrowserSessionState;
  blockedKind: BrowserBlockedKind | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
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
  state: BrowserSessionState;
  owner: BrowserSessionOwner;
  blockedKind: BrowserBlockedKind | null;
  blockedMessage: string | null;
  lastKnownUrl: string;
  lastKnownTitle: string;
  lastUpdatedAt: string;
  touchedRunIds: Set<string>;
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

async function detectBlockedState(page: Page): Promise<{
  kind: BrowserBlockedKind | null;
  reason?: string;
}> {
  const url = page.url();
  if (/(login|signin|sign-in|auth|checkpoint|challenge|verify)/i.test(url)) {
    return {
      kind: 'auth_required',
      reason: `Current page URL suggests an authentication flow: ${url}`,
    };
  }

  try {
    const passwordFieldCount = await page
      .locator('input[type="password"]')
      .count();
    if (passwordFieldCount > 0) {
      return {
        kind: 'auth_required',
        reason: 'Page contains a password field.',
      };
    }

    const bodyText = await page.locator('body').innerText();
    if (HUMAN_ONLY_CHECKPOINT_REGEX.test(bodyText)) {
      return {
        kind: 'human_step_required',
        reason: 'Page content suggests a human-only verification step.',
      };
    }
    if (INTERACTIVE_AUTH_CHECKPOINT_REGEX.test(bodyText)) {
      return {
        kind: 'auth_required',
        reason:
          'Page content suggests interactive authentication or device verification.',
      };
    }
  } catch {
    // Ignore auth detection failures and fall back to the page state we have.
  }

  return { kind: null };
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

function nowIso(): string {
  return new Date().toISOString();
}

export class BrowserService {
  private readonly sessionsById = new Map<string, LiveSession>();
  private readonly profileSessionIds = new Map<string, string>();
  private readonly runSessionIds = new Map<string, Set<string>>();

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

  private async buildStatusSnapshot(
    session: LiveSession,
  ): Promise<BrowserSessionStatusSnapshot> {
    session.lastKnownUrl = session.page.url();
    session.lastKnownTitle = await session.page.title();
    session.lastUpdatedAt = nowIso();
    return {
      sessionId: session.sessionId,
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      headed: session.headed,
      state: session.state,
      owner: session.owner,
      blockedKind: session.blockedKind,
      blockedMessage: session.blockedMessage,
      currentUrl: session.lastKnownUrl,
      currentTitle: session.lastKnownTitle,
      lastUpdatedAt: session.lastUpdatedAt,
    };
  }

  getRunTouchedSessions(runId: string): BrowserRunCarriedSession[] {
    const sessionIds = this.runSessionIds.get(runId);
    if (!sessionIds || sessionIds.size === 0) {
      return [];
    }

    const carried: BrowserRunCarriedSession[] = [];
    for (const sessionId of sessionIds) {
      const session = this.sessionsById.get(sessionId);
      if (!session) continue;
      carried.push({
        sessionId: session.sessionId,
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        lastKnownState: session.state,
        blockedKind: session.blockedKind,
        lastKnownUrl: session.lastKnownUrl,
        lastKnownTitle: session.lastKnownTitle,
        lastUpdatedAt: session.lastUpdatedAt,
      });
    }
    return carried;
  }

  recordRunSessionTouch(
    runId: string | null | undefined,
    sessionId: string,
  ): void {
    if (!runId) return;
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    session.touchedRunIds.add(runId);
    const current = this.runSessionIds.get(runId) || new Set<string>();
    current.add(sessionId);
    this.runSessionIds.set(runId, current);
  }

  getSessionTouchedRunIds(sessionId: string): string[] {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      return [];
    }
    return Array.from(session.touchedRunIds);
  }

  async getSessionStatus(
    sessionId: string,
  ): Promise<BrowserSessionStatusSnapshot | null> {
    const session = this.sessionsById.get(sessionId);
    if (!session) return null;
    return this.buildStatusSnapshot(session);
  }

  private async createSession(input: {
    profile: BrowserProfileSnapshot;
    headed: boolean;
    sessionId?: string;
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
      sessionId: input.sessionId || `bs_${randomUUID()}`,
      profileId: input.profile.id,
      siteKey: input.profile.siteKey,
      accountLabel: input.profile.accountLabel,
      headed: input.headed,
      state: 'active',
      owner: 'agent',
      blockedKind: null,
      blockedMessage: null,
      lastKnownUrl: page.url(),
      lastKnownTitle: '',
      lastUpdatedAt: nowIso(),
      touchedRunIds: new Set<string>(),
      context,
      page,
    };

    context.once('close', () => {
      this.profileSessionIds.delete(
        buildProfileMapKey(session.siteKey, session.accountLabel),
      );
      this.sessionsById.delete(session.sessionId);
      for (const runId of session.touchedRunIds) {
        const sessions = this.runSessionIds.get(runId);
        if (!sessions) continue;
        sessions.delete(session.sessionId);
        if (sessions.size === 0) {
          this.runSessionIds.delete(runId);
        }
      }
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
    const {
      sessionId,
      state,
      owner,
      blockedKind,
      blockedMessage,
      lastKnownUrl,
      lastKnownTitle,
      touchedRunIds,
    } = liveSession;
    await liveSession.context.close();
    const relaunched = await this.createSession({
      profile,
      headed,
      sessionId,
    });
    relaunched.state = state;
    relaunched.owner = owner;
    relaunched.blockedKind = blockedKind;
    relaunched.blockedMessage = blockedMessage;
    relaunched.lastKnownUrl = lastKnownUrl;
    relaunched.lastKnownTitle = lastKnownTitle;
    relaunched.lastUpdatedAt = nowIso();
    relaunched.touchedRunIds = new Set(touchedRunIds);
    for (const runId of touchedRunIds) {
      const sessions = this.runSessionIds.get(runId) || new Set<string>();
      sessions.add(relaunched.sessionId);
      this.runSessionIds.set(runId, sessions);
    }
    return relaunched;
  }

  private getSessionOrThrow(sessionId: string): LiveSession {
    const session = this.sessionsById.get(sessionId);
    if (!session) {
      throw new Error(`Browser session ${sessionId} not found`);
    }
    if (session.state === 'takeover' || session.owner === 'user') {
      throw new Error(
        `Browser session ${sessionId} is currently under user takeover and must be resumed before the agent can continue.`,
      );
    }
    return session;
  }

  private markSessionActive(session: LiveSession): void {
    session.state = 'active';
    session.owner = 'agent';
    session.blockedKind = null;
    session.blockedMessage = null;
    session.lastUpdatedAt = nowIso();
  }

  private markSessionBlocked(
    session: LiveSession,
    kind: BrowserBlockedKind,
    message: string,
  ): void {
    session.state = 'blocked';
    session.owner = 'agent';
    session.blockedKind = kind;
    session.blockedMessage = message;
    session.lastUpdatedAt = nowIso();
  }

  private async refreshSessionLocation(session: LiveSession): Promise<void> {
    session.lastKnownUrl = session.page.url();
    session.lastKnownTitle = await session.page.title();
    session.lastUpdatedAt = nowIso();
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
    await this.refreshSessionLocation(session);

    touchBrowserProfileLastUsed(profile.id);
    const blockedState = await detectBlockedState(session.page);
    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason || '',
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: profile.siteKey,
        accountLabel: profile.accountLabel,
        sessionId: session.sessionId,
        url: session.page.url(),
        title: await session.page.title(),
        reusedSession: !created && Boolean(existingSessionId && reuseSession),
        createdProfile: created,
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This site requires a human-only browser step before the agent can continue.'
            : 'This site requires interactive authentication for this profile.'),
      };
    }

    this.markSessionActive(session);

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
    await this.refreshSessionLocation(session);

    touchBrowserProfileLastUsed(profile.id);
    session.state = 'takeover';
    session.owner = 'user';
    session.blockedKind = null;
    session.blockedMessage = null;
    session.lastUpdatedAt = nowIso();
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
    await this.refreshSessionLocation(session);

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
      this.markSessionBlocked(
        session,
        'confirmation_required',
        'Action requires confirmation before proceeding.',
      );
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
    const blockedState = await detectBlockedState(session.page);
    const urlAfter = session.page.url();
    await this.refreshSessionLocation(session);
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

    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This action led to a human-only browser step.'
            : 'This action led to an interactive authentication step.'),
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: urlAfter,
        title: await session.page.title(),
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This action led to a human-only browser step.'
            : 'This action led to an interactive authentication step.'),
      };
    }

    this.markSessionActive(session);

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

    const blockedState = await detectBlockedState(session.page);
    await this.refreshSessionLocation(session);
    if (blockedState.kind) {
      this.markSessionBlocked(
        session,
        blockedState.kind,
        blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This page now requires a human-only browser step.'
            : 'This page now requires interactive authentication.'),
      );
      return {
        status:
          blockedState.kind === 'human_step_required'
            ? 'human_step_required'
            : 'needs_auth',
        siteKey: session.siteKey,
        accountLabel: session.accountLabel,
        url: session.page.url(),
        title: await session.page.title(),
        message:
          blockedState.reason ||
          (blockedState.kind === 'human_step_required'
            ? 'This page now requires a human-only browser step.'
            : 'This page now requires interactive authentication.'),
      };
    }

    this.markSessionActive(session);

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
    await this.refreshSessionLocation(session);

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
    session.state = 'closed';
    session.lastUpdatedAt = nowIso();
    await session.context.close();
    return {
      status: 'ok',
      siteKey: session.siteKey,
      accountLabel: session.accountLabel,
      message: 'Browser session closed.',
    };
  }

  async startTakeover(input: {
    sessionId: string;
  }): Promise<BrowserSessionStatusSnapshot> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session) {
      throw new Error(`Browser session ${input.sessionId} not found`);
    }

    const activeSession = session.headed
      ? session
      : await this.relaunchSession(session, true);
    await this.refreshSessionLocation(activeSession);
    activeSession.state = 'takeover';
    activeSession.owner = 'user';
    activeSession.blockedKind = null;
    activeSession.blockedMessage = null;
    activeSession.lastUpdatedAt = nowIso();
    return this.buildStatusSnapshot(activeSession);
  }

  async resumeTakeover(input: {
    sessionId: string;
  }): Promise<BrowserSessionStatusSnapshot> {
    const session = this.sessionsById.get(input.sessionId);
    if (!session) {
      throw new Error(`Browser session ${input.sessionId} not found`);
    }
    this.markSessionActive(session);
    await this.refreshSessionLocation(session);
    return this.buildStatusSnapshot(session);
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

export const _testOnly = {
  detectBlockedState,
  classifyRisk,
};
