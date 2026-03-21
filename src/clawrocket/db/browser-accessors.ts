import { randomUUID } from 'crypto';
import path from 'path';

import { getDb } from '../../db.js';
import { DATA_DIR, TIMEZONE } from '../../config.js';

export interface BrowserProfileRecord {
  id: string;
  site_key: string;
  account_label: string | null;
  profile_path: string;
  channel: string;
  locale: string;
  timezone_id: string;
  user_agent: string | null;
  viewport_json: string;
  policy_json: string | null;
  download_dir: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

export interface BrowserViewport {
  width: number;
  height: number;
}

export interface BrowserProfileSnapshot {
  id: string;
  siteKey: string;
  accountLabel: string | null;
  profilePath: string;
  channel: string;
  locale: string;
  timezoneId: string;
  userAgent: string | null;
  viewport: BrowserViewport;
  policy: Record<string, unknown> | null;
  downloadDir: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

const DEFAULT_VIEWPORT: BrowserViewport = { width: 1280, height: 720 };
const DEFAULT_CHANNEL = 'chrome';
const DEFAULT_LOCALE = 'en-US';

function normalizeSiteKey(siteKey: string): string {
  const trimmed = siteKey.trim().toLowerCase();
  if (!trimmed) {
    throw new Error('siteKey is required');
  }
  if (!/^[a-z0-9._-]+$/.test(trimmed)) {
    throw new Error(
      'siteKey must contain only lowercase letters, digits, dots, underscores, or hyphens.',
    );
  }
  return trimmed;
}

function normalizeAccountLabel(accountLabel?: string | null): string | null {
  const trimmed = accountLabel?.trim() || '';
  return trimmed ? trimmed : null;
}

function slugSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || 'default';
}

function slugForPaths(siteKey: string, accountLabel: string | null): string {
  return accountLabel ? `${siteKey}--${slugSegment(accountLabel)}` : siteKey;
}

function buildProfilePath(
  siteKey: string,
  accountLabel: string | null,
): string {
  return path.join(
    DATA_DIR,
    'browser-profiles',
    slugForPaths(siteKey, accountLabel),
  );
}

function buildDownloadDir(
  siteKey: string,
  accountLabel: string | null,
): string {
  return path.join(
    DATA_DIR,
    'browser-downloads',
    slugForPaths(siteKey, accountLabel),
  );
}

function parseViewport(valueJson: string): BrowserViewport {
  try {
    const parsed = JSON.parse(valueJson) as Partial<BrowserViewport>;
    if (
      typeof parsed.width === 'number' &&
      parsed.width > 0 &&
      typeof parsed.height === 'number' &&
      parsed.height > 0
    ) {
      return {
        width: Math.floor(parsed.width),
        height: Math.floor(parsed.height),
      };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_VIEWPORT };
}

function parsePolicy(
  valueJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!valueJson) return null;
  try {
    const parsed = JSON.parse(valueJson) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignored
  }
  return null;
}

function toSnapshot(row: BrowserProfileRecord): BrowserProfileSnapshot {
  return {
    id: row.id,
    siteKey: row.site_key,
    accountLabel: row.account_label,
    profilePath: row.profile_path,
    channel: row.channel,
    locale: row.locale,
    timezoneId: row.timezone_id,
    userAgent: row.user_agent,
    viewport: parseViewport(row.viewport_json),
    policy: parsePolicy(row.policy_json),
    downloadDir: row.download_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

export function getBrowserProfile(
  siteKey: string,
  accountLabel?: string | null,
): BrowserProfileSnapshot | null {
  const normalizedSiteKey = normalizeSiteKey(siteKey);
  const normalizedAccountLabel = normalizeAccountLabel(accountLabel);
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_profiles
      WHERE site_key = ?
        AND (
          (account_label IS NULL AND ? IS NULL)
          OR account_label = ?
        )
      LIMIT 1
    `,
    )
    .get(normalizedSiteKey, normalizedAccountLabel, normalizedAccountLabel) as
    | BrowserProfileRecord
    | undefined;
  return row ? toSnapshot(row) : null;
}

export function getBrowserProfileById(
  profileId: string,
): BrowserProfileSnapshot | null {
  const row = getDb()
    .prepare(
      `
      SELECT *
      FROM browser_profiles
      WHERE id = ?
      LIMIT 1
    `,
    )
    .get(profileId) as BrowserProfileRecord | undefined;
  return row ? toSnapshot(row) : null;
}

export function ensureBrowserProfile(input: {
  siteKey: string;
  accountLabel?: string | null;
}): { profile: BrowserProfileSnapshot; created: boolean } {
  const siteKey = normalizeSiteKey(input.siteKey);
  const accountLabel = normalizeAccountLabel(input.accountLabel);
  const existing = getBrowserProfile(siteKey, accountLabel);
  if (existing) {
    return { profile: existing, created: false };
  }

  const now = new Date().toISOString();
  const id = `bp_${randomUUID()}`;
  const profilePath = buildProfilePath(siteKey, accountLabel);
  const downloadDir = buildDownloadDir(siteKey, accountLabel);

  getDb()
    .prepare(
      `
      INSERT INTO browser_profiles (
        id,
        site_key,
        account_label,
        profile_path,
        channel,
        locale,
        timezone_id,
        user_agent,
        viewport_json,
        policy_json,
        download_dir,
        created_at,
        updated_at,
        last_used_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `,
    )
    .run(
      id,
      siteKey,
      accountLabel,
      profilePath,
      DEFAULT_CHANNEL,
      DEFAULT_LOCALE,
      TIMEZONE,
      null,
      JSON.stringify(DEFAULT_VIEWPORT),
      null,
      downloadDir,
      now,
      now,
    );

  const created = getBrowserProfileById(id);
  if (!created) {
    throw new Error('Failed to create browser profile');
  }
  return { profile: created, created: true };
}

export function touchBrowserProfileLastUsed(profileId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
      UPDATE browser_profiles
      SET last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
    )
    .run(now, now, profileId);
}
