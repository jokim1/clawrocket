// clawtalk Phase 5 (PR 2) — postgres port of accessors.ts core surface.
//
// This is the partial port covering: talks, talk_folders, talk_members,
// talk_threads (basic CRUD + helpers). The remaining slices land in
// subsequent commits on this branch:
//   - talk_messages CRUD
//   - talk_runs CRUD + status/metadata helpers
//   - event_outbox + idempotency_cache
//   - atomic multi-table transactions (enqueueTalkTurnAtomic,
//     completeRunAndPromoteNextAtomic, etc.)
//   - sidebar tree (listTalkSidebarTreeForUser, reorderTalkSidebarItem)
//   - main channel (defer — chassis-era, may be removable entirely)
//
// Behavior change vs sqlite: the sqlite-era `listTalksForUser` had an
// admin/owner-role short-circuit that returned every user's talks.
// Under postgres RLS this is impossible from the `authenticated` role
// without a policy rewrite — the cross-user view requires a
// SECURITY DEFINER admin function. Dropped here. Callers that depended
// on it must be re-routed through a future admin surface or RLS policy
// change. For now: every user sees only their own talks.
//
// Schema differences vs sqlite:
//   - is_default / is_internal / is_pinned are booleans (not 0/1).
//   - IDs are uuid; integer literals need ::uuid casts.
//   - Foreign-keyed columns enforced strictly (no missing-row inserts).
//   - talk_threads.owner_id is required (denormalized from talks for RLS).

import { getDbPg } from '../../db-pg.js';
import {
  normalizeStoredThreadTitle,
  validateEditableThreadTitle,
} from './thread-title-utils.js';

export type TalkAccessLevel = 'owner' | 'editor' | 'viewer';
export type TalkAccessRole = 'editor' | 'viewer';

// ---------------------------------------------------------------------------
// Talk records
// ---------------------------------------------------------------------------

export interface TalkRecord {
  id: string;
  owner_id: string;
  folder_id: string | null;
  sort_order: number;
  topic_title: string | null;
  project_path: string | null;
  orchestration_mode: 'ordered' | 'panel';
  status: 'active' | 'paused' | 'archived';
  version: number;
  created_at: string;
  updated_at: string;
}

export interface TalkFolderRecord {
  id: string;
  owner_id: string;
  title: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TalkWithAccessRecord extends TalkRecord {
  access_role: TalkAccessLevel;
}

export interface TalkListPage {
  limit: number;
  offset: number;
}

export function normalizeTalkListPage(input?: {
  limit?: number;
  offset?: number;
}): TalkListPage {
  const limit =
    typeof input?.limit === 'number'
      ? Math.min(200, Math.max(1, Math.floor(input.limit)))
      : 50;
  const offset =
    typeof input?.offset === 'number'
      ? Math.max(0, Math.floor(input.offset))
      : 0;
  return { limit, offset };
}

// ---------------------------------------------------------------------------
// Talks
// ---------------------------------------------------------------------------

const TALK_COLUMNS = `id, owner_id, folder_id, sort_order, topic_title,
  project_path, orchestration_mode, status, version, created_at, updated_at`;

export async function createTalk(input: {
  ownerId: string;
  id?: string;
  topicTitle?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): Promise<TalkRecord> {
  const db = getDbPg();
  // Insert at sort_order 0 and bump everyone else by 1 so the new talk
  // appears first in the sidebar. Bumping happens for both root talks and
  // root folders so the (talk, folder) ordering stays interleaved.
  await db`
    update public.talks
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  await db`
    update public.talk_folders
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid
  `;
  const inserted = input.id
    ? await db<TalkRecord[]>`
        insert into public.talks
          (id, owner_id, folder_id, sort_order, topic_title,
           orchestration_mode, status)
        values
          (${input.id}::uuid, ${input.ownerId}::uuid, null, 0,
           ${input.topicTitle ?? null},
           ${input.orchestrationMode ?? 'ordered'},
           ${input.status ?? 'active'})
        returning ${db.unsafe(TALK_COLUMNS)}
      `
    : await db<TalkRecord[]>`
        insert into public.talks
          (owner_id, folder_id, sort_order, topic_title,
           orchestration_mode, status)
        values
          (${input.ownerId}::uuid, null, 0,
           ${input.topicTitle ?? null},
           ${input.orchestrationMode ?? 'ordered'},
           ${input.status ?? 'active'})
        returning ${db.unsafe(TALK_COLUMNS)}
      `;
  const talk = inserted[0];
  // Auto-provision a default thread so the UI always has somewhere to
  // post. Schema enforces talk_threads.owner_id NOT NULL — must match the
  // talk's owner.
  await getOrCreateDefaultThread({ talkId: talk.id, ownerId: input.ownerId });
  return talk;
}

export async function getTalkById(
  talkId: string,
): Promise<TalkRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkRecord[]>`
    select ${db.unsafe(TALK_COLUMNS)}
    from public.talks
    where id = ${talkId}::uuid
    limit 1
  `;
  return rows[0];
}

export async function touchTalkUpdatedAt(
  talkId: string,
  updatedAt?: string,
): Promise<void> {
  const db = getDbPg();
  if (updatedAt) {
    await db`
      update public.talks
      set updated_at = ${updatedAt}::timestamptz
      where id = ${talkId}::uuid
    `;
  } else {
    await db`
      update public.talks
      set updated_at = now()
      where id = ${talkId}::uuid
    `;
  }
}

export async function listTalksForUser(input: {
  limit?: number;
  offset?: number;
  status?: 'active' | 'paused' | 'archived';
}): Promise<TalkWithAccessRecord[]> {
  // RLS filters to the caller automatically. No admin/owner cross-user
  // bypass — see top-of-file comment.
  const page = normalizeTalkListPage(input);
  const db = getDbPg();
  // The talk_members policy lets the talk owner see member rows for
  // their talks (and members see their own row). RLS on talks restricts
  // to owner_id = auth.uid(), so any talk visible to the caller is one
  // they own — access_role is always 'owner' under this slice. Sharing
  // (editor/viewer via talk_members) will need an `owner_id = auth.uid()
  // OR id in (select talk_id from talk_members where user_id = auth.uid())`
  // policy expansion when the sharing feature ships.
  const rows = input.status
    ? await db<TalkRecord[]>`
        select ${db.unsafe(TALK_COLUMNS)}
        from public.talks
        where status = ${input.status}
        order by updated_at desc, created_at desc
        limit ${page.limit} offset ${page.offset}
      `
    : await db<TalkRecord[]>`
        select ${db.unsafe(TALK_COLUMNS)}
        from public.talks
        order by updated_at desc, created_at desc
        limit ${page.limit} offset ${page.offset}
      `;
  return rows.map((t) => ({ ...t, access_role: 'owner' as const }));
}

export async function getTalkForUser(
  talkId: string,
): Promise<TalkWithAccessRecord | undefined> {
  const talk = await getTalkById(talkId);
  if (!talk) return undefined;
  return { ...talk, access_role: 'owner' };
}

export async function upsertTalk(input: {
  ownerId: string;
  id: string;
  topicTitle?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
  status?: 'active' | 'paused' | 'archived';
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talks
      (id, owner_id, folder_id, sort_order, topic_title,
       orchestration_mode, status, version)
    values
      (${input.id}::uuid, ${input.ownerId}::uuid, null, 0,
       ${input.topicTitle ?? null},
       ${input.orchestrationMode ?? 'ordered'},
       ${input.status ?? 'active'}, 1)
    on conflict (id) do update set
      topic_title = excluded.topic_title,
      orchestration_mode = excluded.orchestration_mode,
      status = excluded.status,
      updated_at = now(),
      version = public.talks.version + 1
  `;
}

export async function patchTalkMetadata(input: {
  ownerId: string;
  talkId: string;
  title?: string | null;
  orchestrationMode?: 'ordered' | 'panel';
}): Promise<TalkRecord | undefined> {
  // folderId moves deferred to the sidebar slice — that path touches
  // multiple tables atomically and shares helpers with reorderTalkSidebarItem.
  const db = getDbPg();
  const rows = await db<TalkRecord[]>`
    update public.talks
    set topic_title = case when ${input.title !== undefined}::boolean
                        then ${input.title ?? null} else topic_title end,
        orchestration_mode = coalesce(${input.orchestrationMode ?? null},
                                      orchestration_mode),
        updated_at = now(),
        version = version + 1
    where id = ${input.talkId}::uuid
    returning ${db.unsafe(TALK_COLUMNS)}
  `;
  return rows[0];
}

export async function updateTalkProjectPath(input: {
  talkId: string;
  projectPath: string | null;
}): Promise<TalkRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkRecord[]>`
    update public.talks
    set project_path = ${input.projectPath},
        updated_at = now(),
        version = version + 1
    where id = ${input.talkId}::uuid
    returning ${db.unsafe(TALK_COLUMNS)}
  `;
  return rows[0];
}

export async function deleteTalkForOwner(input: {
  talkId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    delete from public.talks
    where id = ${input.talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Talk folders
// ---------------------------------------------------------------------------

const TALK_FOLDER_COLUMNS = `id, owner_id, title, sort_order, created_at, updated_at`;

export async function listTalkFoldersForOwner(): Promise<TalkFolderRecord[]> {
  const db = getDbPg();
  return await db<TalkFolderRecord[]>`
    select ${db.unsafe(TALK_FOLDER_COLUMNS)}
    from public.talk_folders
    order by sort_order asc, created_at asc, id asc
  `;
}

export async function createTalkFolder(input: {
  ownerId: string;
  id?: string;
  title: string;
}): Promise<TalkFolderRecord> {
  const db = getDbPg();
  // Bump root order so the new folder appears first.
  await db`
    update public.talks
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  await db`
    update public.talk_folders
    set sort_order = sort_order + 1
    where owner_id = ${input.ownerId}::uuid
  `;
  const rows = input.id
    ? await db<TalkFolderRecord[]>`
        insert into public.talk_folders
          (id, owner_id, title, sort_order)
        values (${input.id}::uuid, ${input.ownerId}::uuid, ${input.title}, 0)
        returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
      `
    : await db<TalkFolderRecord[]>`
        insert into public.talk_folders
          (owner_id, title, sort_order)
        values (${input.ownerId}::uuid, ${input.title}, 0)
        returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
      `;
  return rows[0];
}

export async function renameTalkFolder(input: {
  id: string;
  title: string;
}): Promise<TalkFolderRecord | undefined> {
  const db = getDbPg();
  const rows = await db<TalkFolderRecord[]>`
    update public.talk_folders
    set title = ${input.title}, updated_at = now()
    where id = ${input.id}::uuid
    returning ${db.unsafe(TALK_FOLDER_COLUMNS)}
  `;
  return rows[0];
}

export async function deleteTalkFolderAndMoveTalksToTopLevel(input: {
  id: string;
  ownerId: string;
}): Promise<boolean> {
  const db = getDbPg();
  // Move every talk in the folder to top-level, append to the end. Then
  // delete the folder row. RLS USING filters protect cross-user attempts.
  const maxRootTalk = await db<{ value: number }[]>`
    select coalesce(max(sort_order), -1)::int as value
    from public.talks
    where owner_id = ${input.ownerId}::uuid and folder_id is null
  `;
  const maxRootFolder = await db<{ value: number }[]>`
    select coalesce(max(sort_order), -1)::int as value
    from public.talk_folders
    where owner_id = ${input.ownerId}::uuid
  `;
  let nextSort =
    Math.max(maxRootTalk[0]?.value ?? -1, maxRootFolder[0]?.value ?? -1) + 1;
  const folderTalks = await db<{ id: string }[]>`
    select id from public.talks
    where folder_id = ${input.id}::uuid
    order by sort_order asc, created_at asc, id asc
  `;
  for (const t of folderTalks) {
    await db`
      update public.talks
      set folder_id = null, sort_order = ${nextSort}, updated_at = now()
      where id = ${t.id}::uuid
    `;
    nextSort += 1;
  }
  const result = await db<{ id: string }[]>`
    delete from public.talk_folders
    where id = ${input.id}::uuid
    returning id
  `;
  return result.length > 0;
}

// ---------------------------------------------------------------------------
// Talk members + access helpers
// ---------------------------------------------------------------------------

export async function upsertTalkMember(input: {
  talkId: string;
  userId: string;
  role: TalkAccessRole;
}): Promise<void> {
  const db = getDbPg();
  await db`
    insert into public.talk_members (talk_id, user_id, role)
    values (${input.talkId}::uuid, ${input.userId}::uuid, ${input.role})
    on conflict (talk_id, user_id) do update set role = excluded.role
  `;
}

export async function deleteTalkMember(input: {
  talkId: string;
  userId: string;
}): Promise<boolean> {
  const db = getDbPg();
  const rows = await db<{ talk_id: string }[]>`
    delete from public.talk_members
    where talk_id = ${input.talkId}::uuid
      and user_id = ${input.userId}::uuid
    returning talk_id
  `;
  return rows.length > 0;
}

export async function canUserAccessTalk(talkId: string): Promise<boolean> {
  // Under RLS, "can the caller see this talk?" reduces to "does the
  // SELECT return a row?" — the policy filters on owner_id = auth.uid()
  // OR membership. Sharing is not in the talks RLS policy yet (only
  // owner_id), so this currently only returns true for the owner. When
  // sharing ships, expand the talks policy and this helper becomes
  // correct automatically.
  const talk = await getTalkById(talkId);
  return talk !== undefined;
}

export async function canUserEditTalk(talkId: string): Promise<boolean> {
  // Same caveat: RLS-defined edit access. Owner-only for now.
  const talk = await getTalkById(talkId);
  return talk !== undefined;
}

export async function getTalkIdsAccessibleByUser(): Promise<string[]> {
  const db = getDbPg();
  const rows = await db<{ id: string }[]>`
    select id from public.talks
  `;
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Talk threads
// ---------------------------------------------------------------------------

export interface TalkThreadRecord {
  id: string;
  talk_id: string;
  owner_id: string;
  title: string | null;
  is_default: boolean;
  is_internal: boolean;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

const TALK_THREAD_COLUMNS = `id, talk_id, owner_id, title, is_default,
  is_internal, is_pinned, created_at, updated_at`;

export async function getOrCreateDefaultThread(input: {
  talkId: string;
  ownerId: string;
}): Promise<string> {
  const db = getDbPg();
  const existing = await db<{ id: string }[]>`
    select id from public.talk_threads
    where talk_id = ${input.talkId}::uuid and is_default = true
    limit 1
  `;
  if (existing[0]) return existing[0].id;

  const inserted = await db<{ id: string }[]>`
    insert into public.talk_threads
      (talk_id, owner_id, title, is_default, is_internal)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, null, true, false)
    returning id
  `;
  return inserted[0].id;
}

export interface TalkThreadWithMetrics extends TalkThreadRecord {
  message_count: number;
  last_message_at: string | null;
}

export async function listTalkThreads(input: {
  talkId: string;
  ownerId: string;
}): Promise<TalkThreadWithMetrics[]> {
  // Heal-on-read: ensure a default thread exists so the UI always has
  // somewhere to post.
  await getOrCreateDefaultThread(input);
  const db = getDbPg();
  const rows = await db<
    Array<
      TalkThreadRecord & {
        message_count: number;
        last_message_at: string | null;
      }
    >
  >`
    select t.id, t.talk_id, t.owner_id, t.title, t.is_default, t.is_internal,
           t.is_pinned, t.created_at, t.updated_at,
           coalesce(m.message_count, 0)::int as message_count,
           m.last_message_at
    from public.talk_threads t
    left join (
      select thread_id, count(*)::int as message_count,
             max(created_at) as last_message_at
      from public.talk_messages
      where talk_id = ${input.talkId}::uuid
      group by thread_id
    ) m on m.thread_id = t.id
    where t.talk_id = ${input.talkId}::uuid and t.is_internal = false
    order by t.is_pinned desc, coalesce(m.last_message_at, t.created_at) desc
  `;
  return rows;
}

export async function createTalkThread(input: {
  ownerId: string;
  talkId: string;
  title?: string | null;
  isInternal?: boolean;
}): Promise<TalkThreadRecord> {
  const normalizedTitle = normalizeStoredThreadTitle(input.title ?? null);
  const db = getDbPg();
  const rows = await db<TalkThreadRecord[]>`
    insert into public.talk_threads
      (talk_id, owner_id, title, is_default, is_internal)
    values
      (${input.talkId}::uuid, ${input.ownerId}::uuid, ${normalizedTitle},
       false, ${input.isInternal ?? false})
    returning ${db.unsafe(TALK_THREAD_COLUMNS)}
  `;
  return rows[0];
}

export async function updateTalkThreadMetadata(input: {
  talkId: string;
  threadId: string;
  title?: string;
  pinned?: boolean;
}): Promise<TalkThreadRecord | null> {
  const normalizedTitle =
    input.title === undefined
      ? undefined
      : validateEditableThreadTitle(input.title);
  const db = getDbPg();
  const rows = await db<TalkThreadRecord[]>`
    update public.talk_threads
    set title = case when ${normalizedTitle !== undefined}::boolean
                  then ${normalizedTitle ?? null} else title end,
        is_pinned = coalesce(${input.pinned ?? null}::boolean, is_pinned),
        updated_at = now()
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    returning ${db.unsafe(TALK_THREAD_COLUMNS)}
  `;
  return rows[0] ?? null;
}

export async function updateTalkThreadTitle(input: {
  talkId: string;
  threadId: string;
  title: string;
}): Promise<TalkThreadRecord | null> {
  const updated = await updateTalkThreadMetadata(input);
  if (!updated || updated.title === null) return null;
  return updated;
}

export async function deleteTalkThread(input: {
  talkId: string;
  threadId: string;
}): Promise<boolean> {
  // Refuse to delete the default thread — UI invariant.
  const db = getDbPg();
  const thread = await db<{ is_default: boolean }[]>`
    select is_default from public.talk_threads
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    limit 1
  `;
  if (!thread[0]) return false;
  if (thread[0].is_default) {
    throw new Error('Cannot delete the default thread');
  }
  const rows = await db<{ id: string }[]>`
    delete from public.talk_threads
    where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
    returning id
  `;
  return rows.length > 0;
}

export async function resolveThreadIdForTalk(input: {
  talkId: string;
  threadId?: string | null;
  ownerId: string;
}): Promise<string> {
  if (input.threadId) {
    const db = getDbPg();
    const exists = await db<{ id: string }[]>`
      select id from public.talk_threads
      where id = ${input.threadId}::uuid and talk_id = ${input.talkId}::uuid
      limit 1
    `;
    if (exists[0]) return exists[0].id;
  }
  return await getOrCreateDefaultThread({
    talkId: input.talkId,
    ownerId: input.ownerId,
  });
}
