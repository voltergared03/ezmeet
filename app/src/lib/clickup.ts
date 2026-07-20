import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { readConfig, writeConfig, publicBaseUrl } from './config';
import { decryptSecret, encryptSecret } from './twofactor';
import { getSingletonOrgId } from './org';
import { getSystemTasksTable } from './system-tasks-table';

/**
 * ClickUp integration — ONE-WAY push of Garely's AI-generated meeting tasks into a
 * ClickUp workspace. Opt-in (no-op unless CLICKUP_ENABLED=true + a token is set),
 * non-blocking (called fire-and-forget AFTER the report transaction commits, like
 * notify()), and fail-soft (every ClickUp error is logged and swallowed; report
 * generation is never delayed or broken).
 *
 * ZERO-CONFIG by design: the admin pastes ONE thing — the ClickUp Personal API
 * token (pk_…) — in Settings → Integrations. Everything else is auto-discovered
 * from the token at runtime and cached per push-run:
 *   - team:      GET /team (use the single team, or CLICKUP_TEAM_ID override)
 *   - members:   email(lowercased) → ClickUp user id (the assignee join key)
 *   - routing:   each Space's List, matched to the Garely DEPARTMENT name (Spaces
 *                were named to mirror departments); unmatched → "Call Inbox".
 *   - Source:    the per-list "Source" dropdown → the "Garely Call" option id.
 *
 * IDEMPOTENCY: regenerate delete-then-inserts the AI Rows (Row.id is NOT stable),
 * so links key on a stable semantic tuple (meetingId + normalized title +
 * departmentId + parentTitle) hashed to dedupeKey — same task ⇒ UPDATE, not dup.
 *
 * v1 LIMITATIONS (accepted): (a) if the AI re-words a task TITLE on regenerate the
 * dedupeKey changes → a new ClickUp task is created and the old one is orphaned (no
 * stable task id exists across regenerations — title is the only semantic anchor).
 * (b) two AI tasks in one meeting with an identical title+department+parent collide
 * onto one ClickUp task (rare/degenerate). (c) tasks dropped from a later report
 * leave their ClickUp task in place (one-way push, no delete). (d) config is
 * workspace-global like DeepSeek/SMTP/Google — per-org scoping waits for Phase 5.
 * (e) the discovery endpoints (GET /team, /space, list custom-fields) are not
 * paginated by ClickUp; fine at our scale (tens of members/spaces).
 */

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const TIMEOUT_MS = 15_000;

export interface ClickUpConfig {
  token: string;
  teamId: string; // '' → auto-detect
  routingMode: 'department' | 'inbox';
  fallbackListId: string; // '' → unmapped departments are not pushed at all
  // Per-user routing (opt-in). When on, a task is split into one ClickUp task PER
  // assignee, and an assignee who belongs to 2+ departments is routed to their own
  // auto-created personal list instead of a department space. Off → legacy model
  // (one task per Garely task, all assignees, department routing).
  personalRouting: boolean;
}

/** One AI task (parent or subtask) to mirror into ClickUp. */
export interface ClickUpPushItem {
  rowId: string;
  title: string;
  priority: string | null; // high | medium | low
  dueDate: Date | null;
  departmentId: string | null;
  assigneeUserIds: string[]; // Garely user ids
  parentTitle: string | null; // set for subtasks (disambiguates dedupe)
  // "Unconfirmed" task: the AI routed it to a department with NOBODY from the meeting
  // present, so we can't confirm ownership. Force it to the shared Call Inbox as ONE
  // triage task assigned to all attendees, via the single-task path — bypassing the
  // per-user split even when personal routing is on. Set from regenerate.ts.
  forceFallback?: boolean;
}

// ─────────────────────────── pure mappers (unit-tested) ───────────────────────────

/** Garely priority → ClickUp native priority. null/unknown → omit (no priority). */
export function mapPriority(p: string | null | undefined): number | null {
  switch ((p || '').toLowerCase()) {
    case 'high': return 2; // High (1=Urgent reserved)
    case 'medium': return 3; // Normal
    case 'low': return 4; // Low
    default: return null;
  }
}

/** Normalize a name for matching/dedup: trim, lowercase, collapse whitespace. */
export function normName(s: string | null | undefined): string {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Stable idempotency key surviving report regeneration (Row.id is not stable). */
export function dedupeKeyFor(
  meetingId: string,
  title: string,
  departmentId: string | null,
  parentTitle: string | null,
  assigneeUserId?: string | null,
): string {
  const parts = [meetingId, normName(title), departmentId || '-', normName(parentTitle) || '-'];
  // Per-user split: append the assignee so each of a task's N copies has its own
  // stable key. Omitted (legacy 4-arg calls) → identical key to before, so
  // existing links keep matching and nothing re-duplicates.
  if (assigneeUserId) parts.push(`u:${assigneeUserId}`);
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/**
 * Resolve the destination list for a department: the admin's explicit mapping, else the
 * fallback list. That is the whole rule.
 *
 * This used to match the department's NAME against ClickUp Space names (plus a table of
 * hardcoded aliases, plus "first list in the Space"), which failed in every direction:
 * renaming either side stranded a department, a Space with several lists picked whichever
 * one ClickUp's sidebar happened to order first, and a customer's naming drift had to be
 * patched into our source. None of it was ever visible to the admin. Now the mapping is
 * chosen in the UI from the real list, so it cannot be guessed wrong.
 */
export function listIdForDepartment(
  cfg: ClickUpConfig,
  fallbackListId: string | null,
  mappedListId: string | null,
): string | null {
  if (cfg.routingMode === 'inbox') return fallbackListId;
  return mappedListId || fallbackListId;
}

// ─────────────────────────── config ───────────────────────────

/** Read + decrypt the ClickUp config. Returns null when disabled or unconfigured. */
export async function getClickUpConfig(): Promise<ClickUpConfig | null> {
  const m = await readConfig([
    'CLICKUP_ENABLED', 'CLICKUP_TOKEN', 'CLICKUP_TEAM_ID',
    'CLICKUP_FALLBACK_LIST_ID', 'CLICKUP_ROUTING_MODE', 'CLICKUP_PERSONAL_ROUTING',
  ]);
  if (m.CLICKUP_ENABLED !== 'true') return null;
  const token = decodeToken(m.CLICKUP_TOKEN);
  if (!token) return null;
  return {
    token,
    teamId: (m.CLICKUP_TEAM_ID || '').trim(),
    routingMode: m.CLICKUP_ROUTING_MODE === 'inbox' ? 'inbox' : 'department',
    fallbackListId: (m.CLICKUP_FALLBACK_LIST_ID || '').trim(),
    personalRouting: m.CLICKUP_PERSONAL_ROUTING === 'true',
  };
}

/** The stored token is AES-GCM ciphertext (v1.…); tolerate a raw token too. */
export function decodeToken(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) {
    try { return decryptSecret(raw); } catch { console.error('[clickup] token decrypt failed — corrupted ciphertext or AUTH_SECRET changed'); return ''; }
  }
  return raw;
}

// ─────────────────────────── HTTP ───────────────────────────

function cuHeaders(token: string): Record<string, string> {
  // ClickUp wants the RAW personal token in Authorization (NO "Bearer" prefix).
  return { Authorization: token, 'Content-Type': 'application/json' };
}

async function cuFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CLICKUP_API}${path}`, {
    ...init,
    headers: { ...cuHeaders(token), ...(init?.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * A ClickUp HTTP error carrying the status, so callers can tell a REJECTED request
 * (4xx — nothing was created) from a request that may well have SUCCEEDED server-side
 * (timeout / 5xx). Retrying a POST is only safe in the former case.
 */
export class ClickUpHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`ClickUp ${method} ${path} → ${status}: ${body.slice(0, 160)}`);
    this.name = 'ClickUpHttpError';
    this.status = status;
    this.body = body;
  }
}

async function cuJson<T = any>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res = await cuFetch(token, path, init);
  if (res.status === 429) {
    // Respect the rate limit (~100 req/min): wait out Retry-After once, then retry.
    // Safe even for POST: a 429 means the request was rejected, so nothing was created.
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 1, 3);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await cuFetch(token, path, init);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never include the token; truncate the body.
    throw new ClickUpHttpError(init?.method || 'GET', path, res.status, body);
  }
  return res.json() as Promise<T>;
}

/** Health check used by Settings → Test connection. Returns the team names. */
export async function clickUpPing(token: string): Promise<{ teams: { id: string; name: string }[] }> {
  const data = await cuJson<{ teams?: { id: string; name: string }[] }>(token, '/team');
  return { teams: (data.teams || []).map((t) => ({ id: t.id, name: t.name })) };
}

/**
 * How much the fallback list is actually catching — so an admin can judge whether their
 * department mapping has holes. Counts pushed tasks whose destination was the fallback
 * list. Null when disabled, or when no fallback list is configured.
 */
export async function getFallbackStats(): Promise<{ listName: string; last30d: number; total: number } | null> {
  const cfg = await getClickUpConfig();
  if (!cfg) return null;
  try {
    const fallbackListId = cfg.fallbackListId || null;
    if (!fallbackListId) return null;
    const info = await cuJson<{ name?: string; space?: { name?: string } }>(cfg.token, `/list/${fallbackListId}`).catch(() => null);
    // The LIST's own name first: this stat is about a list the admin picked by name.
    const listName = info?.name || info?.space?.name || 'fallback list';
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [last30d, total] = await Promise.all([
      prisma.clickUpTaskLink.count({ where: { listId: fallbackListId, syncedAt: { gte: since } } }),
      prisma.clickUpTaskLink.count({ where: { listId: fallbackListId } }),
    ]);
    return { listName, last30d, total };
  } catch (e) {
    console.error('[clickup] fallback stats failed:', (e as Error).message);
    return null;
  }
}

// ─────────────────────────── runtime resolvers (cached per push-run) ───────────────────────────

async function resolveTeamId(cfg: ClickUpConfig): Promise<string> {
  if (cfg.teamId) return cfg.teamId;
  const data = await cuJson<{ teams?: { id: string }[] }>(cfg.token, '/team');
  const teams = data.teams || [];
  if (!teams.length) throw new Error('ClickUp: no teams visible to this token');
  return teams[0].id; // single-workspace tokens → the only team
}

async function resolveMembers(token: string): Promise<Map<string, number>> {
  const data = await cuJson<{ teams?: { members?: { user?: { id: number; email?: string } }[] }[] }>(token, '/team');
  const out = new Map<string, number>();
  for (const team of data.teams || []) {
    for (const m of team.members || []) {
      const email = m.user?.email;
      const id = m.user?.id;
      if (email && typeof id === 'number') out.set(email.toLowerCase(), id);
    }
  }
  return out;
}

/** One selectable ClickUp list, labelled with its full path so the choice is unambiguous. */
export interface ClickUpListOption {
  listId: string;
  label: string; // "Space / Folder / List"
  spaceName: string;
}

/**
 * Every list in the workspace, for the admin's department/user pickers.
 *
 * The label carries the FULL path because list names are not unique — a real workspace can
 * have two lists both called "Tasks" in different Spaces, and picking between them by name
 * alone is a coin flip.
 */
export async function listAllClickUpLists(): Promise<ClickUpListOption[]> {
  const cfg = await getClickUpConfig();
  if (!cfg) return [];
  const teamId = await resolveTeamId(cfg);
  const spaces = await cuJson<{ spaces?: { id: string; name: string }[] }>(cfg.token, `/team/${teamId}/space?archived=false`);
  const out: ClickUpListOption[] = [];
  for (const space of spaces.spaces || []) {
    try {
      for (const l of await listsInSpace(cfg.token, space.id)) {
        out.push({
          listId: l.id,
          label: [space.name, l.folderName, l.name].filter(Boolean).join(' / '),
          spaceName: space.name,
        });
      }
    } catch (e) {
      console.error('[clickup] list discovery failed for space', space.name, (e as Error).message);
    }
  }
  return out;
}

/**
 * Every list a Space exposes — folderless AND folder-nested.
 *
 * `GET /space/{id}/list` is ClickUp's "Get Folderless Lists": it returns NOTHING for a
 * Space whose lists live inside Folders. We only used that endpoint, so such a department
 * looked empty to us — no mapping, no error — and 100% of its tasks silently went to the
 * Call Inbox even though the department plainly existed in ClickUp. Folders are read too.
 *
 * Folderless lists come first, so a Space's own lists are offered ahead of its folders'.
 */
interface SpaceList { id: string; name: string; folderName?: string }

async function listsInSpace(token: string, spaceId: string): Promise<SpaceList[]> {
  const out: SpaceList[] = [];

  const folderless = await cuJson<{ lists?: { id: string; name: string }[] }>(token, `/space/${spaceId}/list?archived=false`);
  out.push(...(folderless.lists || []));

  const folders = await cuJson<{ folders?: { id: string; name: string; lists?: { id: string; name: string }[] }[] }>(
    token,
    `/space/${spaceId}/folder?archived=false`,
  );
  for (const folder of folders.folders || []) {
    // The folder payload usually embeds its lists; fall back to a fetch if it doesn't.
    if (folder.lists?.length) {
      out.push(...folder.lists.map((l) => ({ ...l, folderName: folder.name })));
      continue;
    }
    try {
      const inFolder = await cuJson<{ lists?: { id: string; name: string }[] }>(token, `/folder/${folder.id}/list?archived=false`);
      out.push(...(inFolder.lists || []).map((l) => ({ ...l, folderName: folder.name })));
    } catch (e) {
      console.error('[clickup] list discovery failed for folder', folder.name, (e as Error).message);
    }
  }

  return out;
}

/** Resolve a list's "Source" dropdown field id + the "Garely Call" option id. */
async function resolveSourceField(
  token: string,
  listId: string,
  cache: Map<string, { fieldId: string; optionId: string } | null>,
): Promise<{ fieldId: string; optionId: string } | null> {
  if (cache.has(listId)) return cache.get(listId)!;
  let result: { fieldId: string; optionId: string } | null = null;
  try {
    const data = await cuJson<{ fields?: { id: string; name: string; type: string; type_config?: { options?: { id: string; name: string }[] } }[] }>(token, `/list/${listId}/field`);
    const field = (data.fields || []).find((f) => normName(f.name) === 'source' && f.type === 'drop_down');
    const option = field?.type_config?.options?.find((o) => normName(o.name) === 'garely call');
    if (field && option) result = { fieldId: field.id, optionId: option.id };
  } catch (e) {
    console.error('[clickup] source-field discovery failed for list', listId, (e as Error).message);
  }
  cache.set(listId, result);
  return result;
}

// ─────────────────────────── create / update one task ───────────────────────────

type CreateBody = {
  name: string;
  description?: string;
  assignees?: number[];
  priority?: number;
  due_date?: number;
  due_date_time?: boolean;
  status?: string; // status NAME (migration sets it for done/in-progress; omit → list default "New")
  custom_fields?: { id: string; value: string }[];
};

const cuPost = (token: string, listId: string, body: CreateBody) =>
  cuJson<{ id: string; url: string }>(token, `/list/${listId}/task`, { method: 'POST', body: JSON.stringify(body) });

/**
 * Create one task, degrading gracefully ONLY when ClickUp actually rejected the request.
 *
 * A retry is safe exclusively on a 400: the request was refused, so no task exists. On a
 * timeout (AbortSignal, TIMEOUT_MS) or a 5xx the task may already have been created — the
 * old code retried there too, which is what produced the reported pairs of duplicates
 * (one WITH the assignee, orphaned; one WITHOUT, linked). Those errors now propagate.
 *
 * The two rejectable fields are also dropped separately: a status name the list doesn't
 * define must never cost a valid assignee (dropping both together silently de-assigned).
 */
async function createClickUpTask(token: string, listId: string, body: CreateBody): Promise<{ id: string; url: string }> {
  const rejected = (e: unknown) => e instanceof ClickUpHttpError && e.status === 400;
  try {
    return await cuPost(token, listId, body);
  } catch (e) {
    if (!rejected(e)) throw e; // may have landed server-side — never blind-retry
    // 1) Drop only the status (list may not define it), keeping the assignees.
    if (body.status) {
      const { status: _s, ...noStatus } = body;
      try {
        console.warn('[clickup] create rejected, retrying without status:', (e as Error).message);
        return await cuPost(token, listId, noStatus);
      } catch (e2) {
        if (!rejected(e2)) throw e2;
      }
    }
    // 2) Still rejected → the assignee isn't a member of this (private) list. Don't
    //    auto-add them; land the task unassigned rather than losing it.
    if (body.assignees?.length) {
      const { assignees: _a, status: _s2, ...rest } = body;
      console.warn('[clickup] create rejected, retrying without assignees:', (e as Error).message);
      return cuPost(token, listId, rest);
    }
    throw e;
  }
}

/** Mark a Garely task Row as ClickUp-owned (read-only mirror + reverse-sync anchor). */
async function markRowOwned(rowId: string, clickupTaskId: string, clickupUrl: string | null): Promise<void> {
  await prisma.taskRow
    .update({ where: { rowId }, data: { clickupTaskId, clickupUrl: clickupUrl ?? undefined, clickupSyncedAt: new Date() } })
    .catch((e) => console.error('[clickup] mark row owned failed:', rowId, (e as Error).message));
}

// ─────────────────────────── per-user routing (opt-in) ───────────────────────────

const PERSONAL_SPACE_NAME = 'Garely Personal';

/** Garely user ids that belong to 2+ departments → route them to a personal list. */
async function multiDeptUserIds(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const rows = await prisma.departmentMember
    .findMany({ where: { userId: { in: userIds } }, select: { userId: true } })
    .catch(() => [] as { userId: string }[]);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.userId, (counts.get(r.userId) || 0) + 1);
  return new Set([...counts.entries()].filter(([, c]) => c >= 2).map(([u]) => u));
}

interface PersonalRouter {
  /** Resolve (create + cache) the personal list id for a user; null on failure. */
  listForUser(email: string, displayName: string): Promise<string | null>;
  /** Persist any newly-created space/list ids back to config. */
  persist(): Promise<void>;
}

/** Auto-creates & caches a "Garely Personal" space + one list per user (by email). */
async function makePersonalRouter(cfg: ClickUpConfig, teamId: string): Promise<PersonalRouter> {
  const m = await readConfig(['CLICKUP_PERSONAL_SPACE_ID', 'CLICKUP_PERSONAL_LISTS']);
  let spaceId = (m.CLICKUP_PERSONAL_SPACE_ID || '').trim() || null;
  let cache: Record<string, string> = {};
  try { if (m.CLICKUP_PERSONAL_LISTS) cache = JSON.parse(m.CLICKUP_PERSONAL_LISTS); } catch { cache = {}; }
  let dirty = false;

  // Lowest-id "Garely Personal" space, so concurrent creators converge on ONE.
  const findSpaceByName = async (): Promise<string | null> => {
    const spaces = await cuJson<{ spaces?: { id: string; name: string }[] }>(cfg.token, `/team/${teamId}/space?archived=false`);
    const ids = (spaces.spaces || []).filter((s) => normName(s.name) === normName(PERSONAL_SPACE_NAME)).map((s) => s.id);
    return ids.length ? ids.sort((a, b) => Number(a) - Number(b))[0] : null;
  };
  const ensureSpace = async (): Promise<string | null> => {
    if (spaceId) return spaceId;
    try {
      const found = await findSpaceByName();
      if (found) { spaceId = found; dirty = true; return spaceId; }
      await cuJson<{ id: string }>(cfg.token, `/team/${teamId}/space`, { method: 'POST', body: JSON.stringify({ name: PERSONAL_SPACE_NAME, multiple_assignees: true }) });
      // Re-resolve by name so a duplicate created by a concurrent push converges here.
      spaceId = await findSpaceByName();
      dirty = !!spaceId;
      return spaceId;
    } catch (e) {
      console.error('[clickup] personal space ensure failed:', (e as Error).message);
      return null;
    }
  };

  return {
    async listForUser(email, displayName) {
      const key = email.toLowerCase();
      if (cache[key]) return cache[key];
      const sp = await ensureSpace();
      if (!sp) return null;
      const name = displayName || email.split('@')[0] || email; // avoid naming a list by a raw email
      try {
        const created = await cuJson<{ id: string }>(cfg.token, `/space/${sp}/list`, { method: 'POST', body: JSON.stringify({ name }) });
        cache[key] = created.id; dirty = true; return created.id;
      } catch (e) {
        console.error('[clickup] personal list create failed for', email, (e as Error).message);
        return null;
      }
    },
    async persist() {
      if (!dirty) return;
      await writeConfig({ CLICKUP_PERSONAL_SPACE_ID: spaceId || '', CLICKUP_PERSONAL_LISTS: JSON.stringify(cache) }).catch(() => {});
    },
  };
}

interface AssigneeTarget { garelyUserId: string; clickupUserId: number; listId: string }

/** Per-assignee destinations for a task, in precedence order: the admin's explicit list for
 *  this user → their personal list (multi-department users) → the task's department list.
 *  Assignees not in ClickUp are dropped. */
async function resolveAssigneeTargets(
  assigneeUserIds: string[],
  ctx: {
    members: Map<string, number>;
    emailById: Map<string, string>;
    nameById: Map<string, string>;
    multiDept: Set<string>;
    overrideByUser: Map<string, string>;
    deptListId: string | null;
    personal: PersonalRouter | null;
  },
): Promise<AssigneeTarget[]> {
  const out: AssigneeTarget[] = [];
  const seen = new Set<string>();
  for (const uid of assigneeUserIds) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    const email = ctx.emailById.get(uid);
    if (!email) continue;
    const clickupUserId = ctx.members.get(email);
    if (!clickupUserId) continue; // not in ClickUp → skip (no task for them)
    let listId = ctx.deptListId;
    const override = ctx.overrideByUser.get(uid);
    if (override) {
      // An admin named this list for this person. It beats the multi-dept heuristic below,
      // which is only a `count >= 2` inference with no human intent behind it.
      listId = override;
    } else if (ctx.personal && ctx.multiDept.has(uid)) {
      const personalList = await ctx.personal.listForUser(email, ctx.nameById.get(uid) || '');
      if (personalList) listId = personalList;
    }
    if (!listId) { console.warn('[clickup] no destination list for assignee', uid, '— skipped'); continue; }
    out.push({ garelyUserId: uid, clickupUserId, listId });
  }
  // Deterministic order → the "lead" copy (row.clickupTaskId anchor) is stable across
  // regenerations regardless of the incoming assignee order.
  out.sort((a, b) => (a.garelyUserId < b.garelyUserId ? -1 : a.garelyUserId > b.garelyUserId ? 1 : 0));
  return out;
}

interface SplitMeetingTask {
  meetingId: string;
  rowId: string;
  title: string;
  departmentId: string | null;
  parentTitle: string | null;
  priority: number | null;
  dueDateMs: number | null;
  statusName?: string | null; // migrate carries the current status name for done/in-progress
}

/**
 * Create/update one ClickUp task PER assignee target for a meeting task, keyed by a
 * per-(row × assignee) dedupe link so regeneration updates instead of duplicating.
 * Marks the Garely row owned via the first copy. One target failing doesn't stop the rest.
 */
/**
 * Convert a pre-split (shared) link into this task's first per-assignee link.
 *
 * The legacy path keys a link by the task alone; the split path keys it by task + assignee.
 * So the first time a task takes the split path, its 5-arg lookup MISSES the existing 4-arg
 * link, creates a fresh ClickUp task and orphans the old one — the duplicate pairs users
 * reported. Adopting the old link (rewriting its key in place) makes the switch a rename,
 * not a re-creation. Idempotent: once adopted, the 4-arg key no longer exists.
 */
async function adoptLegacyLink(cfg: ClickUpConfig, item: SplitMeetingTask, targets: AssigneeTarget[]): Promise<void> {
  if (!targets.length) return;
  const legacyKey = dedupeKeyFor(item.meetingId, item.title, item.departmentId, item.parentTitle);
  const legacy = await prisma.clickUpTaskLink
    .findUnique({ where: { meetingId_dedupeKey: { meetingId: item.meetingId, dedupeKey: legacyKey } } })
    .catch(() => null);
  if (!legacy) return;

  // Prefer the target already sitting in the shared task's list, so the task stays
  // physically where it is (v2 PUT cannot move it) and the link never lies about location.
  const t = targets.find((x) => x.listId === legacy.listId) ?? targets[0];
  const newKey = dedupeKeyFor(item.meetingId, item.title, item.departmentId, item.parentTitle, t.garelyUserId);

  // Collision guard: if the chosen target already owns its 5-arg link (a partial prior
  // adoption), rewriting to that key would violate @@unique([meetingId, dedupeKey]) and
  // throw — leaving the legacy task orphaned. The legacy link is redundant in that case,
  // so drop it and let the loop update the existing per-assignee link.
  const clash = await prisma.clickUpTaskLink
    .findUnique({ where: { meetingId_dedupeKey: { meetingId: item.meetingId, dedupeKey: newKey } } })
    .catch(() => null);
  if (clash && clash.id !== legacy.id) {
    await prisma.clickUpTaskLink.delete({ where: { id: legacy.id } }).catch(() => {});
    return;
  }

  // Reconcile assignees on the shared task BEFORE committing the key rewrite: the rewrite is
  // the point of no return (the 4-arg key is gone afterwards), so a failed PUT here must NOT
  // leave the co-assignees on the shared task AND holding their own copy. Do it first; if it
  // fails on anything but a 400 (task may be half-updated / unknown), abort so the next run
  // retries the whole adoption instead of committing a half-done state.
  const rem = targets.filter((x) => x.garelyUserId !== t.garelyUserId).map((x) => x.clickupUserId);
  if (rem.length) {
    try {
      await cuJson(cfg.token, `/task/${legacy.clickupTaskId}`, {
        method: 'PUT',
        body: JSON.stringify({ assignees: { add: [t.clickupUserId], rem } }),
      });
    } catch (e) {
      if (!(e instanceof ClickUpHttpError && e.status === 400)) {
        console.warn('[clickup] adoption assignee rewrite failed — retrying next run:', (e as Error).message);
        return;
      }
    }
  }

  await prisma.clickUpTaskLink.update({
    where: { id: legacy.id },
    data: { dedupeKey: newKey, rowId: item.rowId, assigneeUserId: t.garelyUserId },
  }).catch((e) => console.error('[clickup] legacy link adoption commit failed for row', item.rowId, (e as Error).message));
}

async function syncSplitMeetingTask(
  cfg: ClickUpConfig,
  fieldCache: Map<string, { fieldId: string; optionId: string } | null>,
  item: SplitMeetingTask,
  targets: AssigneeTarget[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  let lead: { id: string; url: string } | null = null;

  await adoptLegacyLink(cfg, item, targets);

  for (const t of targets) {
    try {
      const dedupeKey = dedupeKeyFor(item.meetingId, item.title, item.departmentId, item.parentTitle, t.garelyUserId);
      const existing = await prisma.clickUpTaskLink.findUnique({ where: { meetingId_dedupeKey: { meetingId: item.meetingId, dedupeKey } } });
      if (existing) {
        // Update content only (preserve human status/assignee changes on the ClickUp side).
        const body: Record<string, unknown> = { name: item.title };
        if (item.priority != null) body.priority = item.priority;
        if (item.dueDateMs != null) { body.due_date = item.dueDateMs; body.due_date_time = false; }
        await cuJson(cfg.token, `/task/${existing.clickupTaskId}`, { method: 'PUT', body: JSON.stringify(body) });
        // listId is deliberately NOT rewritten: this PUT changes content only, and ClickUp's
        // v2 API cannot re-home a task anyway. Writing t.listId here would make the link
        // claim a move that never happened, which is what made getFallbackStats mis-report.
        await prisma.clickUpTaskLink.update({ where: { id: existing.id }, data: { syncedAt: new Date(), title: item.title, rowId: item.rowId, assigneeUserId: t.garelyUserId } });
        await applyClickUpEvent('taskStatusUpdated', existing.clickupTaskId);
        if (!lead) lead = { id: existing.clickupTaskId, url: existing.clickupUrl };
        updated++;
      } else {
        const source = await resolveSourceField(cfg.token, t.listId, fieldCache);
        const body: CreateBody = { name: item.title, assignees: [t.clickupUserId] };
        if (item.priority != null) body.priority = item.priority;
        if (item.dueDateMs != null) { body.due_date = item.dueDateMs; body.due_date_time = false; }
        if (item.statusName) body.status = item.statusName;
        if (source) body.custom_fields = [{ id: source.fieldId, value: source.optionId }];
        const res = await createClickUpTask(cfg.token, t.listId, body);
        await prisma.clickUpTaskLink.create({ data: { meetingId: item.meetingId, dedupeKey, clickupTaskId: res.id, clickupUrl: res.url, listId: t.listId, title: item.title, rowId: item.rowId, assigneeUserId: t.garelyUserId } });
        if (!lead) lead = { id: res.id, url: res.url };
        created++;
      }
    } catch (e) {
      console.error('[clickup] split task sync failed for row', item.rowId, 'assignee', t.garelyUserId, (e as Error).message);
    }
  }
  if (lead) await markRowOwned(item.rowId, lead.id, lead.url);
  return { created, updated };
}

// ─────────────────────────── orchestrator (called from regenerate.ts) ───────────────────────────

/**
 * Push a meeting's freshly-created AI tasks into ClickUp. Fire-and-forget: resolve
 * everything once, then create/update each task idempotently. Never throws.
 */
export async function pushMeetingTasksToClickUp(meetingId: string, items: ClickUpPushItem[]): Promise<void> {
  if (!items.length) return;
  let cfg: ClickUpConfig | null = null;
  try {
    cfg = await getClickUpConfig();
  } catch (e) {
    console.error('[clickup] config read failed:', (e as Error).message);
    return;
  }
  if (!cfg) return; // disabled / unconfigured → silent no-op

  try {
    const teamId = await resolveTeamId(cfg);
    const members = await resolveMembers(cfg.token);
    const fallbackListId = cfg.fallbackListId || null;

    // Resolve Garely entity names/emails for the items in batch.
    const deptIds = [...new Set(items.map((i) => i.departmentId).filter((x): x is string => !!x))];
    const userIds = [...new Set(items.flatMap((i) => i.assigneeUserIds).filter(Boolean))];
    const [depts, users] = await Promise.all([
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true, clickupListId: true } }) : Promise.resolve([]),
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true, clickupListId: true } }) : Promise.resolve([]),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const deptListId = new Map(depts.map((d) => [d.id, d.clickupListId ?? null]));
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));
    const nameById = new Map(users.map((u) => [u.id, u.name || '']));
    // Admin-set per-user destinations ("this person's tasks always go here").
    const overrideByUser = new Map(
      users.filter((u) => u.clickupListId).map((u) => [u.id, u.clickupListId as string]),
    );

    // Per-user routing prerequisites. The personal-list router is only for the multi-dept
    // heuristic, so it is only needed when that mode is on — an override needs no router.
    const personal = cfg.personalRouting ? await makePersonalRouter(cfg, teamId) : null;
    const multiDept = cfg.personalRouting ? await multiDeptUserIds(userIds) : new Set<string>();

    const fieldCache = new Map<string, { fieldId: string; optionId: string } | null>();
    let created = 0;
    let updated = 0;

    for (const item of items) {
      try {
        if (item.departmentId && !deptName.has(item.departmentId)) {
          console.warn('[clickup] department not found, routing to fallback:', item.departmentId, '· task:', item.title);
        }
        const mapped = item.departmentId ? deptListId.get(item.departmentId) ?? null : null;
        // Unconfirmed tasks (routed to a department with nobody from the meeting present)
        // are forced to the shared Call Inbox and handled by the legacy single-task path
        // below (one triage task, all attendees), NOT the per-user split.
        const listId = item.forceFallback
          ? fallbackListId
          : listIdForDepartment(cfg, fallbackListId, mapped);
        if (!item.forceFallback && item.departmentId && !mapped && listId === fallbackListId) {
          console.warn('[clickup] department is not mapped to a list — task goes to the fallback:', deptName.get(item.departmentId) || item.departmentId, '· task:', item.title);
        }

        // Per-user split path: one task per assignee. Reachable when the global mode is on,
        // OR when someone on this task has an admin-set list of their own — otherwise their
        // override would silently do nothing whenever the mode is off.
        const hasOverride = item.assigneeUserIds.some((u) => overrideByUser.has(u));
        if ((cfg.personalRouting || hasOverride) && !item.forceFallback) {
          const targets = await resolveAssigneeTargets(item.assigneeUserIds, {
            members, emailById, nameById, multiDept, overrideByUser, deptListId: listId, personal,
          });
          if (!targets.length) {
            // Nobody resolves to ClickUp now → release the row if it was owned before,
            // so it isn't stuck read-only pointing at a stale/removed copy.
            await prisma.taskRow.updateMany({ where: { rowId: item.rowId, clickupTaskId: { not: null } }, data: { clickupTaskId: null, clickupUrl: null, clickupStatus: null, clickupSyncedAt: null } }).catch(() => {});
            continue;
          }
          const c = await syncSplitMeetingTask(cfg, fieldCache, {
            meetingId, rowId: item.rowId, title: item.title, departmentId: item.departmentId,
            parentTitle: item.parentTitle, priority: mapPriority(item.priority),
            dueDateMs: item.dueDate ? item.dueDate.getTime() : null,
          }, targets);
          created += c.created; updated += c.updated;
          continue;
        }

        if (!listId) {
          console.error('[clickup] task not pushed — its department is unmapped and no fallback list is set:', item.title);
          continue;
        }

        // Assignees by email; collect notes for unmatched emails.
        const assignees: number[] = [];
        const unmatched: string[] = [];
        for (const uid of item.assigneeUserIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          const cuId = members.get(email);
          if (cuId) assignees.push(cuId);
          else unmatched.push(email);
        }
        // OWNED gate (mixed-assignee rule = "any assignee in ClickUp → owned"): a
        // task is pushed only if ≥1 assignee resolved to a ClickUp member. Tasks
        // with no ClickUp assignee stay native to Garely (not pushed, not marked).
        if (!assignees.length) continue;

        const description = unmatched.length ? unmatched.map((e) => `Unassigned in ClickUp: ${e}`).join('\n') : undefined;

        const source = await resolveSourceField(cfg.token, listId, fieldCache);
        const prio = mapPriority(item.priority);
        const dedupeKey = dedupeKeyFor(meetingId, item.title, item.departmentId, item.parentTitle);
        const existing = await prisma.clickUpTaskLink.findUnique({
          where: { meetingId_dedupeKey: { meetingId, dedupeKey } },
        });

        if (existing) {
          // Update content only — NOT assignees/status/Source (preserve any human
          // changes made on the ClickUp side; those were set at create time).
          const body: Record<string, unknown> = { name: item.title };
          if (description) body.description = description;
          if (prio != null) body.priority = prio;
          if (item.dueDate) { body.due_date = item.dueDate.getTime(); body.due_date_time = false; }
          await cuJson(cfg.token, `/task/${existing.clickupTaskId}`, { method: 'PUT', body: JSON.stringify(body) });
          // listId not rewritten: content-only PUT, and the task never moved (v2 can't).
          // rowId IS refreshed: regeneration deletes+recreates the Garely row, so a link that
          // survives a regenerate would otherwise keep pointing at a deleted rowId — and
          // taskDeleted prefers the link's rowId, which would then orphan the live row.
          await prisma.clickUpTaskLink.update({
            where: { id: existing.id },
            data: { syncedAt: new Date(), title: item.title, rowId: item.rowId },
          });
          await markRowOwned(item.rowId, existing.clickupTaskId, existing.clickupUrl);
          // Reconcile the (re-created on regenerate) row to ClickUp's CURRENT status,
          // so the read-only mirror isn't reset to "open" — also self-heals any webhook
          // event lost during the regenerate delete-then-insert window.
          await applyClickUpEvent('taskStatusUpdated', existing.clickupTaskId);
          updated++;
        } else {
          const body: CreateBody = { name: item.title };
          if (description) body.description = description;
          if (assignees.length) body.assignees = assignees;
          if (prio != null) body.priority = prio;
          if (item.dueDate) { body.due_date = item.dueDate.getTime(); body.due_date_time = false; }
          if (source) body.custom_fields = [{ id: source.fieldId, value: source.optionId }];
          const res = await createClickUpTask(cfg.token, listId, body);
          // rowId matters even on this shared/legacy link: taskDeleted only keeps the Garely
          // row when another link with the same rowId survives, and adoption makes mixed
          // legacy+split states real. Without it, deleting one ClickUp copy could delete the
          // Garely row (and its subtasks) for everyone.
          await prisma.clickUpTaskLink.create({
            data: { meetingId, dedupeKey, clickupTaskId: res.id, clickupUrl: res.url, listId, title: item.title, rowId: item.rowId },
          });
          await markRowOwned(item.rowId, res.id, res.url);
          created++;
        }
      } catch (e) {
        // One task failing must not stop the rest.
        console.error('[clickup] push failed for task:', item.title, '·', (e as Error).message);
      }
    }
    await personal?.persist(); // save any newly-created personal space/list ids
    console.log(`[clickup] meeting ${meetingId}: ${created} created, ${updated} updated, ${items.length} total`);
  } catch (e) {
    console.error('[clickup] push aborted:', (e as Error).message);
  }
}

// ─────────────────────────── status mapping (both directions) ───────────────────────────

/** Garely status → ClickUp status NAME (for create/migration). open → undefined (list default "New"). */
export function garelyStatusToClickUp(status: string | null | undefined): string | undefined {
  switch ((status || '').toLowerCase()) {
    case 'in_progress': return 'in progress';
    case 'done': return 'done';
    default: return undefined;
  }
}

/** ClickUp status (type + name) → Garely 3-state status. "Blocked" maps to in_progress. */
export function clickUpStatusToGarely(statusType: string | null | undefined, statusName: string | null | undefined): 'open' | 'in_progress' | 'done' {
  const type = (statusType || '').toLowerCase();
  const name = (statusName || '').toLowerCase();
  // Prefer ClickUp's own semantic TYPE — it is language-agnostic. A list has exactly one
  // 'open' status (the initial one) and one 'closed'/'done'; everything a team adds in
  // between is type 'custom'. A task parked in one of those was deliberately moved off
  // "to do" and is not finished, so it is work in progress — whatever the stage is called
  // ("in control", "routine", "На перевірці"). Matching English status names instead would
  // silently report every non-English workspace's active work as untouched.
  if (type === 'done' || type === 'closed') return 'done';
  if (type === 'open') return 'open';
  if (type === 'custom') return 'in_progress';
  // No type at all (older payloads) → fall back to name hints.
  if (name.includes('done') || name.includes('complete') || name.includes('closed')) return 'done';
  if (name.includes('progress') || name.includes('blocked') || name.includes('review')) return 'in_progress';
  return 'open';
}

// ─────────────────────────── webhook management (ClickUp → Garely) ───────────────────────────

/** Events we need pushed back. `taskUpdated` carries renames — without it a task renamed in
 *  ClickUp keeps its original AI-generated title in Garely forever, which reads as a stale
 *  or missing task. */
const WEBHOOK_EVENTS = ['taskStatusUpdated', 'taskUpdated', 'taskDeleted'];

/** Create (or verify) the ClickUp webhook that pushes status/rename/deletion back to Garely.
 *  Idempotent, and re-creates whenever the endpoint OR the event set drifts from what we need. */
export async function ensureClickUpWebhook(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getClickUpConfig();
  if (!cfg) return { ok: false, error: 'disabled' };
  const base = await publicBaseUrl();
  if (!base) return { ok: false, error: 'no_public_url' };
  const endpoint = `${base}/api/webhooks/clickup`;
  try {
    const teamId = await resolveTeamId(cfg);
    const stored = await readConfig(['CLICKUP_WEBHOOK_ID']);
    if (stored.CLICKUP_WEBHOOK_ID) {
      // Verify the stored webhook still exists, points at us, AND subscribes to everything we
      // need. Comparing the endpoint alone used to be enough — but then adding an event to
      // WEBHOOK_EVENTS was a silent no-op: the existing hook matched on endpoint and was never
      // re-created, so the new event simply never arrived.
      const list = await cuJson<{ webhooks?: { id: string; endpoint: string; events?: string[] }[] }>(cfg.token, `/team/${teamId}/webhook`);
      const found = (list.webhooks || []).find((w) => w.id === stored.CLICKUP_WEBHOOK_ID);
      const subscribed = new Set(found?.events || []);
      const hasAllEvents = WEBHOOK_EVENTS.every((e) => subscribed.has(e));
      if (found && found.endpoint === endpoint && hasAllEvents) return { ok: true };
      // Endpoint or event set drifted → drop the stale webhook before re-creating.
      if (found) await cuJson(cfg.token, `/webhook/${stored.CLICKUP_WEBHOOK_ID}`, { method: 'DELETE' }).catch(() => {});
    }
    const res = await cuJson<{ id?: string; webhook?: { id: string; secret: string } }>(cfg.token, `/team/${teamId}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ endpoint, events: WEBHOOK_EVENTS }),
    });
    const wh = res.webhook || (res as { id?: string; secret?: string });
    await writeConfig({
      CLICKUP_WEBHOOK_ID: (wh as { id?: string }).id || '',
      CLICKUP_WEBHOOK_SECRET: (wh as { secret?: string }).secret ? encryptSecret((wh as { secret?: string }).secret!) : '',
    });
    return { ok: true };
  } catch (e) {
    console.error('[clickup] ensure webhook failed:', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Delete the ClickUp webhook + clear its stored id/secret. Safe when already gone. */
export async function removeClickUpWebhook(): Promise<void> {
  const m = await readConfig(['CLICKUP_TOKEN', 'CLICKUP_WEBHOOK_ID']);
  const token = decodeToken(m.CLICKUP_TOKEN);
  if (token && m.CLICKUP_WEBHOOK_ID) {
    await cuJson(token, `/webhook/${m.CLICKUP_WEBHOOK_ID}`, { method: 'DELETE' }).catch(() => {});
  }
  await writeConfig({ CLICKUP_WEBHOOK_ID: '', CLICKUP_WEBHOOK_SECRET: '' });
}

/** Verify a ClickUp webhook's X-Signature (HMAC-SHA256 of the raw body with the webhook secret). */
export async function verifyClickUpSignature(rawBody: string, signature: string | null | undefined): Promise<boolean> {
  if (!signature) return false;
  const m = await readConfig(['CLICKUP_WEBHOOK_SECRET']);
  const secret = decodeToken(m.CLICKUP_WEBHOOK_SECRET); // decrypts the stored v1.… ciphertext
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─────────────────────────── reverse apply (a ClickUp event → the Garely Row) ───────────────────────────

/**
 * Mirror a ClickUp task's current status + name onto its Garely Row. Shared by the webhook
 * and the reconcile sweep so both apply exactly the same rules.
 *
 * ClickUp is the source of truth here: a task renamed there (e.g. an AI title corrected by
 * hand) must win, or Garely keeps showing the stale wording and the task reads as missing.
 * Writes are skipped when nothing actually changed — `taskUpdated` fires on every edit
 * (assignee, priority, custom field), so most events are no-ops and shouldn't churn the DB.
 */
async function applyClickUpTaskState(
  rowId: string,
  clickupTaskId: string,
  s: { statusName?: string; statusType?: string; taskName?: string },
): Promise<void> {
  const gStatus = clickUpStatusToGarely(s.statusType, s.statusName);
  const row = await prisma.row.findUnique({
    where: { id: rowId },
    select: { data: true, table: { select: { base: { select: { orgId: true } } } } },
  });
  if (!row) return;
  const prov = await getSystemTasksTable(row.table.base.orgId);
  if (!prov) return;

  const current = (row.data as Record<string, unknown>) ?? {};
  const data: Record<string, unknown> = { ...current, [prov.fieldIds.status]: gStatus };
  // Only take the name when ClickUp actually has one — never blank a Garely title.
  const renamed = !!s.taskName && s.taskName !== String(current[prov.fieldIds.title] ?? '');
  if (renamed) data[prov.fieldIds.title] = s.taskName;

  const statusChanged = String(current[prov.fieldIds.status] ?? '') !== gStatus;
  if (!statusChanged && !renamed) {
    // Nothing to mirror — just record that we checked, so the sweep can report freshness.
    await prisma.taskRow.updateMany({ where: { rowId }, data: { clickupSyncedAt: new Date() } }).catch(() => {});
    return;
  }

  await prisma.$transaction([
    prisma.row.update({ where: { id: rowId }, data: { data: data as Prisma.InputJsonValue } }),
    prisma.taskRow.update({
      where: { rowId },
      data: { clickupStatus: s.statusName || null, clickupSyncedAt: new Date(), completedAt: gStatus === 'done' ? new Date() : null },
    }),
  ]);
  if (renamed) {
    await prisma.clickUpTaskLink.updateMany({ where: { clickupTaskId }, data: { title: s.taskName! } }).catch(() => {});
  }
}

/**
 * Apply a ClickUp webhook event to the owning Garely task Row. `taskDeleted`
 * deletes the Row (+ its subtasks); status events fetch the task's CURRENT status
 * from ClickUp (source of truth) and mirror it into the Row. No-op if the task id
 * isn't a Garely-owned one. Never throws.
 */
export async function applyClickUpEvent(event: string, clickupTaskId: string): Promise<void> {
  try {
    // Resolve the Garely row: a per-user split copy carries rowId on its link;
    // a legacy/lead task resolves via TaskRow.clickupTaskId.
    const link = await prisma.clickUpTaskLink.findFirst({ where: { clickupTaskId }, select: { rowId: true } });
    let rowId = link?.rowId ?? null;
    if (!rowId) {
      const tr = await prisma.taskRow.findFirst({ where: { clickupTaskId }, select: { rowId: true } });
      rowId = tr?.rowId ?? null;
    }
    if (!rowId) return; // not a task Garely pushed → ignore

    if (event === 'taskDeleted') {
      // Drop this ClickUp task's link(s), then decide by what's LEFT for the row:
      // any OTHER ClickUp copy still bound to this row (split copies carry rowId) → keep
      // the row; none left → this was the sole/last copy → remove the row. Deleting one
      // admin's split copy must never nuke the task for everyone else. Counting by rowId
      // (not by link.rowId presence) is robust to a mixed legacy+split link state.
      await prisma.clickUpTaskLink.deleteMany({ where: { clickupTaskId } });
      const remaining = await prisma.clickUpTaskLink.findMany({
        where: { rowId, NOT: { clickupTaskId } },
        select: { clickupTaskId: true, clickupUrl: true }, take: 1,
      });
      if (remaining.length) {
        // Re-point the row's lead pointer only if we just deleted the lead.
        await prisma.taskRow.updateMany({
          where: { rowId, clickupTaskId },
          data: { clickupTaskId: remaining[0].clickupTaskId, clickupUrl: remaining[0].clickupUrl },
        }).catch(() => {});
        console.log('[clickup] taskDeleted → detached one copy, row kept', rowId);
        return;
      }
      const subs = await prisma.taskRow.findMany({ where: { parentRowId: rowId }, select: { rowId: true } });
      const ids = [rowId, ...subs.map((s) => s.rowId)];
      await prisma.row.deleteMany({ where: { id: { in: ids } } }); // cascades TaskRow + Row*
      console.log('[clickup] taskDeleted → removed Garely row', rowId);
      return;
    }

    // Status / rename / generic update: read the authoritative current state from ClickUp.
    const cfg = await getClickUpConfig();
    if (!cfg) return;
    let statusName: string | undefined;
    let statusType: string | undefined;
    let taskName: string | undefined;
    try {
      const task = await cuJson<{ id?: string; name?: string; status?: { status?: string; type?: string } }>(cfg.token, `/task/${clickupTaskId}`);
      if (task.id && task.id !== clickupTaskId) return; // defensive: ClickUp returned a different task
      statusName = task.status?.status;
      statusType = task.status?.type;
      taskName = typeof task.name === 'string' ? task.name.trim() : undefined;
    } catch (e) {
      console.error('[clickup] fetch task for status failed:', (e as Error).message);
      return;
    }
    await applyClickUpTaskState(rowId, clickupTaskId, { statusName, statusType, taskName });
  } catch (e) {
    console.error('[clickup] applyClickUpEvent failed:', (e as Error).message);
  }
}

// ─────────────────────────── reconcile (catch-up sweep, ClickUp → Garely) ───────────────────────────

/** How many rows one sweep may delete. A ClickUp outage that 404s everything must not be
 *  able to wipe the task list; anything above this is a bug or an incident, not a cleanup. */
const RECONCILE_MAX_DELETES = 25;

/**
 * Pull the CURRENT state of every linked ClickUp task and mirror it into Garely.
 *
 * The webhook is the fast path, but it is fire-and-forget: a delivery missed while we were
 * redeploying, rate-limited or the hook was disabled is never retried, so a task's status or
 * name silently drifts for good. This sweep is the safety net that converges that drift.
 *
 * Fetches per LIST rather than per task — a workspace with hundreds of linked tasks lives in
 * a handful of lists, so this is a few requests instead of one per task (ClickUp allows
 * ~100/min). A task missing from its list is re-checked individually before anything is
 * deleted: it may simply have been MOVED to another list, and treating a move as a deletion
 * would destroy the Garely row and its subtasks.
 */
export async function reconcileClickUpTasks(): Promise<{ checked: number; updated: number; deleted: number; pruned: number; skipped: number }> {
  // `deleted` = Garely tasks removed because their ClickUp copy is gone (counts against the
  // cap). `pruned` = dead link rows cleaned up, which touches no user data.
  const out = { checked: 0, updated: 0, deleted: 0, pruned: 0, skipped: 0 };
  const cfg = await getClickUpConfig();
  if (!cfg) return out;

  const links = await prisma.clickUpTaskLink.findMany({
    select: { clickupTaskId: true, listId: true, rowId: true },
  });
  if (!links.length) return out;

  // Group by list so each list is fetched once.
  const byList = new Map<string, typeof links>();
  for (const l of links) {
    if (!l.listId) continue;
    const arr = byList.get(l.listId) || [];
    arr.push(l);
    byList.set(l.listId, arr);
  }

  const seen = new Map<string, { name?: string; status?: string; type?: string }>();
  // Lists we could NOT read in full. A list we failed to enumerate tells us nothing about its
  // tasks, so its links are skipped wholesale: falling through to a per-task check would both
  // storm the rate limit (one GET per link) and risk reading an outage as "deleted".
  const incompleteLists = new Set<string>();
  for (const [listId] of byList) {
    let complete = false;
    for (let page = 0; page < 20; page++) { // hard page cap — never loop forever on a bad API
      let res: { tasks?: { id: string; name?: string; status?: { status?: string; type?: string } }[]; last_page?: boolean };
      try {
        res = await cuJson(cfg.token, `/list/${listId}/task?include_closed=true&subtasks=true&page=${page}`);
      } catch (e) {
        console.error('[clickup] reconcile: list fetch failed', listId, (e as Error).message);
        break; // leave complete=false → this list's links are skipped below
      }
      for (const t of res.tasks || []) {
        seen.set(t.id, { name: t.name, status: t.status?.status, type: t.status?.type });
      }
      if (res.last_page || !(res.tasks || []).length) { complete = true; break; }
    }
    if (!complete) incompleteLists.add(listId); // includes hitting the page cap mid-list
  }

  // Resolve rowIds in ONE query (legacy links carry none) and learn each row's "lead" copy.
  const taskRows = await prisma.taskRow.findMany({
    where: { clickupTaskId: { in: links.map((l) => l.clickupTaskId) } },
    select: { rowId: true, clickupTaskId: true },
  });
  const rowIdByTaskId = new Map(taskRows.filter((t) => t.clickupTaskId).map((t) => [t.clickupTaskId!, t.rowId]));
  const leadTaskIdByRow = new Map(taskRows.filter((t) => t.clickupTaskId).map((t) => [t.rowId, t.clickupTaskId!]));
  const rowIdFor = (l: { clickupTaskId: string; rowId: string | null }) =>
    l.rowId ?? rowIdByTaskId.get(l.clickupTaskId) ?? null;

  // Per-assignee split puts N ClickUp copies on ONE Garely row. Mirroring every copy would be
  // last-writer-wins: a rename on one copy gets reverted by another copy's stale name on the
  // very same sweep, and completedAt would flip. So collect first, then apply ONE copy per row.
  type State = { name?: string; status?: string; type?: string };
  const byRow = new Map<string, { taskId: string; state: State }[]>();
  const collect = (rowId: string, taskId: string, state: State) => {
    const arr = byRow.get(rowId) || [];
    arr.push({ taskId, state });
    byRow.set(rowId, arr);
  };

  for (const link of links) {
    const found = seen.get(link.clickupTaskId);
    const rowId = rowIdFor(link);
    if (found) {
      out.checked++;
      if (!rowId) { out.skipped++; continue; }
      collect(rowId, link.clickupTaskId, found);
      continue;
    }

    // Not in its list. If we couldn't read that list in full, we know nothing — skip.
    if (!link.listId || incompleteLists.has(link.listId)) { out.skipped++; continue; }
    // Could be moved, archived (the list query returns neither), or genuinely deleted.
    try {
      const t = await cuJson<{ name?: string; status?: { status?: string; type?: string } }>(cfg.token, `/task/${link.clickupTaskId}`);
      out.checked++;
      // Alive after all — mirror it rather than discarding the response we already paid for.
      // This is the only path that reaches ARCHIVED tasks, which the list query never returns.
      if (rowId) collect(rowId, link.clickupTaskId, { name: t.name, status: t.status?.status, type: t.status?.type });
      else out.skipped++;
    } catch (e) {
      // 404 = gone. Anything else (401 no-access, timeout, 5xx) is unclear → never destructive.
      if (!(e instanceof ClickUpHttpError && e.status === 404)) { out.skipped++; continue; }
      if (!rowId) {
        // Orphan: the ClickUp task is gone AND no Garely row claims this link. The link is
        // pure bookkeeping garbage — prune it, or every sweep re-probes a dead id forever and
        // pins the delete cap, masking real deletions. Deletes no user data by construction.
        await prisma.clickUpTaskLink.deleteMany({ where: { clickupTaskId: link.clickupTaskId } }).catch(() => {});
        out.pruned++;
        continue;
      }
      // A real Garely task whose ClickUp copy is gone. Only THIS counts against the cap.
      if (out.deleted >= RECONCILE_MAX_DELETES) { out.skipped++; continue; }
      await applyClickUpEvent('taskDeleted', link.clickupTaskId);
      out.deleted++;
    }
  }

  // One authoritative copy per row: the lead that markRowOwned recorded, else a deterministic
  // pick so the choice never depends on DB row order.
  for (const [rowId, copies] of byRow) {
    const lead = leadTaskIdByRow.get(rowId);
    const chosen =
      copies.find((c) => c.taskId === lead) ??
      [...copies].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))[0];
    try {
      await applyClickUpTaskState(rowId, chosen.taskId, {
        statusName: chosen.state.status, statusType: chosen.state.type, taskName: chosen.state.name?.trim(),
      });
      out.updated++;
    } catch (e) {
      console.error('[clickup] reconcile: apply failed', chosen.taskId, (e as Error).message);
      out.skipped++;
    }
  }

  if (out.deleted >= RECONCILE_MAX_DELETES) {
    console.warn('[clickup] reconcile hit the delete cap — stopping deletions this run:', RECONCILE_MAX_DELETES);
  }
  return out;
}

// ─────────────────────────── migration (existing Garely tasks → ClickUp) ───────────────────────────

/**
 * One-time backfill run on connect: push EVERY existing Garely task assigned to a
 * ClickUp member into ClickUp (incl. done/in-progress, with the right status), mark
 * it owned (read-only mirror), and — for meeting tasks — record a dedupe link so a
 * later report regeneration UPDATES instead of duplicating. Marker-idempotent
 * (already-owned rows are skipped) + throttled for the rate limit. Never throws.
 */
/** Coerce a JSONB cell value to a string (or null) for reading task fields. */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}

export async function migrateAllTasksToClickUp(): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  try {
    const cfg = await getClickUpConfig();
    if (!cfg) return { migrated, skipped };
    const orgId = await getSingletonOrgId();
    if (!orgId) return { migrated, skipped };
    const prov = await getSystemTasksTable(orgId);
    if (!prov) return { migrated, skipped };

    // Guard against a concurrent run (e.g. rapid re-enable): skip if one is in flight.
    const cur = await readConfig(['CLICKUP_MIGRATION']);
    try { if (cur.CLICKUP_MIGRATION && JSON.parse(cur.CLICKUP_MIGRATION).state === 'running') return { migrated, skipped }; } catch { /* ignore */ }

    const teamId = await resolveTeamId(cfg);
    const members = await resolveMembers(cfg.token);
    const fallbackListId = cfg.fallbackListId || null;
    const f = prov.fieldIds;

    // Eligible = task Rows not yet owned that have at least one assignee.
    const rows = await prisma.row.findMany({
      where: { tableId: prov.table.id, taskMeta: { is: { clickupTaskId: null } }, assignments: { some: {} } },
      select: {
        id: true, data: true,
        taskMeta: { select: { meetingId: true, departmentId: true, parentRowId: true } },
        assignments: { select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    await writeConfig({ CLICKUP_MIGRATION: JSON.stringify({ state: 'running', total: rows.length, migrated: 0 }) });

    // Resolve id→email, id→deptName, parentRowId→title once.
    const userIds = [...new Set(rows.flatMap((r) => r.assignments.map((a) => a.userId)))];
    const deptIds = [...new Set(rows.map((r) => r.taskMeta?.departmentId).filter((x): x is string => !!x))];
    const parentIds = [...new Set(rows.map((r) => r.taskMeta?.parentRowId).filter((x): x is string => !!x))];
    const [users, depts, parents] = await Promise.all([
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true, clickupListId: true } }) : Promise.resolve([]),
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true, clickupListId: true } }) : Promise.resolve([]),
      parentIds.length ? prisma.row.findMany({ where: { id: { in: parentIds } }, select: { id: true, data: true } }) : Promise.resolve([]),
    ]);
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));
    const nameById = new Map(users.map((u) => [u.id, u.name || '']));
    const deptListMap = new Map(depts.map((d) => [d.id, d.clickupListId ?? null]));
    const overrideByUser = new Map(
      users.filter((u) => u.clickupListId).map((u) => [u.id, u.clickupListId as string]),
    );
    const parentTitle = new Map(parents.map((p) => [p.id, str((p.data as Record<string, unknown>)?.[f.title]) || null]));
    const fieldCache = new Map<string, { fieldId: string; optionId: string } | null>();

    // Per-user routing prerequisites (only when the mode is on).
    const personal = cfg.personalRouting ? await makePersonalRouter(cfg, teamId) : null;
    const multiDept = cfg.personalRouting ? await multiDeptUserIds(userIds) : new Set<string>();

    let i = 0;
    for (const row of rows) {
      i++;
      try {
        const data = (row.data ?? {}) as Record<string, unknown>;

        // Per-user split path (meeting tasks only — they carry the meetingId the
        // dedupe link needs; manual tasks keep the legacy single-task path below).
        const rowUserIds = row.assignments.map((a) => a.userId);
        const rowHasOverride = rowUserIds.some((u) => overrideByUser.has(u));
        if ((cfg.personalRouting || rowHasOverride) && row.taskMeta?.meetingId) {
          const mappedP = row.taskMeta.departmentId ? deptListMap.get(row.taskMeta.departmentId) ?? null : null;
          const deptListId = listIdForDepartment(cfg, fallbackListId, mappedP);
          const targets = await resolveAssigneeTargets(rowUserIds, {
            members, emailById, nameById, multiDept, overrideByUser, deptListId, personal,
          });
          if (!targets.length) { skipped++; continue; }
          const dueStr = str(data[f.dueDate]);
          const dueMs = dueStr ? (Number.isNaN(Date.parse(dueStr)) ? null : Date.parse(dueStr)) : null;
          const c = await syncSplitMeetingTask(cfg, fieldCache, {
            meetingId: row.taskMeta.meetingId, rowId: row.id, title: str(data[f.title]) || '(untitled)',
            departmentId: row.taskMeta.departmentId ?? null,
            parentTitle: row.taskMeta.parentRowId ? parentTitle.get(row.taskMeta.parentRowId) ?? null : null,
            priority: mapPriority(str(data[f.priority])), dueDateMs: dueMs,
            statusName: garelyStatusToClickUp(str(data[f.status])) ?? null,
          }, targets);
          if (c.created || c.updated) migrated++; else skipped++;
          if (i % 20 === 0) {
            await writeConfig({ CLICKUP_MIGRATION: JSON.stringify({ state: 'running', total: rows.length, migrated }) });
            await new Promise((r) => setTimeout(r, 1500));
          }
          continue;
        }

        // Assignees: matched ClickUp ids + unmatched notes.
        const assignees: number[] = [];
        const unmatched: string[] = [];
        for (const a of row.assignments) {
          const email = emailById.get(a.userId);
          if (!email) continue;
          const cuId = members.get(email);
          if (cuId) assignees.push(cuId); else unmatched.push(email);
        }
        if (!assignees.length) { skipped++; continue; } // no ClickUp assignee → stays native

        const mapped = row.taskMeta?.departmentId ? deptListMap.get(row.taskMeta.departmentId) ?? null : null;
        const listId = listIdForDepartment(cfg, fallbackListId, mapped);
        if (!listId) { skipped++; continue; }

        const source = await resolveSourceField(cfg.token, listId, fieldCache);
        const body: CreateBody = { name: str(data[f.title]) || '(untitled)' };
        if (unmatched.length) body.description = unmatched.map((e) => `Unassigned in ClickUp: ${e}`).join('\n');
        if (assignees.length) body.assignees = assignees;
        const prio = mapPriority(str(data[f.priority]));
        if (prio != null) body.priority = prio;
        const due = str(data[f.dueDate]);
        if (due) { const ms = Date.parse(due); if (!Number.isNaN(ms)) { body.due_date = ms; body.due_date_time = false; } }
        const st = garelyStatusToClickUp(str(data[f.status]));
        if (st) body.status = st;
        if (source) body.custom_fields = [{ id: source.fieldId, value: source.optionId }];

        const res = await createClickUpTask(cfg.token, listId, body);
        await markRowOwned(row.id, res.id, res.url);
        // Meeting tasks: record a dedupe link so report regeneration updates (not dups).
        if (row.taskMeta?.meetingId) {
          const dedupeKey = dedupeKeyFor(row.taskMeta.meetingId, body.name, row.taskMeta.departmentId ?? null, row.taskMeta.parentRowId ? parentTitle.get(row.taskMeta.parentRowId) ?? null : null);
          await prisma.clickUpTaskLink.upsert({
            where: { meetingId_dedupeKey: { meetingId: row.taskMeta.meetingId, dedupeKey } },
            create: { meetingId: row.taskMeta.meetingId, dedupeKey, clickupTaskId: res.id, clickupUrl: res.url, listId, title: body.name },
            update: { clickupTaskId: res.id, clickupUrl: res.url, listId, title: body.name, syncedAt: new Date() },
          }).catch(() => {});
        }
        migrated++;
      } catch (e) {
        console.error('[clickup] migrate failed for row', row.id, (e as Error).message);
        skipped++;
      }
      // Throttle for the ~100 req/min rate limit (each task = ~1-2 calls).
      if (i % 20 === 0) {
        await writeConfig({ CLICKUP_MIGRATION: JSON.stringify({ state: 'running', total: rows.length, migrated }) });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    await personal?.persist(); // save any newly-created personal space/list ids
    await writeConfig({ CLICKUP_MIGRATION: JSON.stringify({ state: 'done', total: rows.length, migrated, skipped }) });
    console.log(`[clickup] migration done: ${migrated} migrated, ${skipped} skipped of ${rows.length}`);
  } catch (e) {
    console.error('[clickup] migration aborted:', (e as Error).message);
    await writeConfig({ CLICKUP_MIGRATION: JSON.stringify({ state: 'error', error: (e as Error).message }) }).catch(() => {});
  }
  return { migrated, skipped };
}

// ─────────────────────────── connect / disconnect orchestration ───────────────────────────

/** On connect (enabled + token): register the reverse webhook, then migrate existing tasks. */
export async function enableClickUpSync(): Promise<void> {
  await ensureClickUpWebhook();
  await migrateAllTasksToClickUp();
}

/** On disconnect: remove the webhook and release every owned task back to Garely-native (editable). */
export async function disableClickUpSync(): Promise<void> {
  await removeClickUpWebhook();
  await prisma.taskRow.updateMany({
    where: { clickupTaskId: { not: null } },
    data: { clickupTaskId: null, clickupUrl: null, clickupStatus: null, clickupSyncedAt: null },
  });
  // Clear the per-user routing cache too — a reconnect to a DIFFERENT workspace must
  // re-resolve the personal space/lists rather than reuse stale ids.
  await writeConfig({ CLICKUP_MIGRATION: '', CLICKUP_PERSONAL_SPACE_ID: '', CLICKUP_PERSONAL_LISTS: '' });
}
