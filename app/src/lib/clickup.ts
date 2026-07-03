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

// Known Garely-department → ClickUp-Space name aliases (normalized, lowercased).
// The live workspace has "Account Manager" (Garely) vs "Account Management"
// (ClickUp Space). Add more here if names drift; admins can also override the
// whole mapping via CLICKUP_LIST_MAP.
const DEPT_ALIASES: Record<string, string> = {
  'account manager': 'account management',
  'account managers': 'account management',
};

export interface ClickUpConfig {
  token: string;
  teamId: string; // '' → auto-detect
  routingMode: 'department' | 'inbox';
  listMap: Record<string, string>; // explicit dept-name → list-id overrides
  fallbackListId: string; // '' → auto-detect "Call Inbox"
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

/** Resolve the destination list for a department name (honors routing mode + aliases). */
export function listIdForDepartment(
  cfg: ClickUpConfig,
  listMap: { byDept: Map<string, string>; fallbackListId: string | null },
  departmentName: string | null,
): string | null {
  if (cfg.routingMode === 'inbox') return listMap.fallbackListId;
  if (departmentName) {
    const n = normName(departmentName);
    const direct = listMap.byDept.get(n);
    if (direct) return direct;
    const alias = DEPT_ALIASES[n];
    if (alias && listMap.byDept.get(alias)) return listMap.byDept.get(alias)!;
  }
  return listMap.fallbackListId;
}

// ─────────────────────────── config ───────────────────────────

/** Read + decrypt the ClickUp config. Returns null when disabled or unconfigured. */
export async function getClickUpConfig(): Promise<ClickUpConfig | null> {
  const m = await readConfig([
    'CLICKUP_ENABLED', 'CLICKUP_TOKEN', 'CLICKUP_TEAM_ID',
    'CLICKUP_LIST_MAP', 'CLICKUP_FALLBACK_LIST_ID', 'CLICKUP_ROUTING_MODE', 'CLICKUP_PERSONAL_ROUTING',
  ]);
  if (m.CLICKUP_ENABLED !== 'true') return null;
  const token = decodeToken(m.CLICKUP_TOKEN);
  if (!token) return null;
  let listMap: Record<string, string> = {};
  try { if (m.CLICKUP_LIST_MAP) listMap = JSON.parse(m.CLICKUP_LIST_MAP); } catch { listMap = {}; }
  return {
    token,
    teamId: (m.CLICKUP_TEAM_ID || '').trim(),
    routingMode: m.CLICKUP_ROUTING_MODE === 'inbox' ? 'inbox' : 'department',
    listMap,
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

async function cuJson<T = any>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res = await cuFetch(token, path, init);
  if (res.status === 429) {
    // Respect the rate limit (~100 req/min): wait out Retry-After once, then retry.
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 1, 3);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await cuFetch(token, path, init);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Never include the token; truncate the body.
    throw new Error(`ClickUp ${init?.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json() as Promise<T>;
}

/** Health check used by Settings → Test connection. Returns the team names. */
export async function clickUpPing(token: string): Promise<{ teams: { id: string; name: string }[] }> {
  const data = await cuJson<{ teams?: { id: string; name: string }[] }>(token, '/team');
  return { teams: (data.teams || []).map((t) => ({ id: t.id, name: t.name })) };
}

/**
 * How much the fallback list (auto-detected "Call Inbox", or an explicit fallback)
 * is actually catching — so an admin can judge whether it's still needed. Counts
 * pushed tasks whose destination was the fallback list. Null when disabled/unresolvable.
 */
export async function getFallbackStats(): Promise<{ listName: string; last30d: number; total: number } | null> {
  const cfg = await getClickUpConfig();
  if (!cfg) return null;
  try {
    const teamId = await resolveTeamId(cfg);
    const { fallbackListId } = await resolveListMap(cfg, teamId);
    if (!fallbackListId) return null;
    const info = await cuJson<{ name?: string; space?: { name?: string } }>(cfg.token, `/list/${fallbackListId}`).catch(() => null);
    const listName = info?.space?.name || info?.name || 'fallback list';
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

/** Walk Spaces → Lists, mapping normalized Space name → its (first) list id. */
async function resolveListMap(
  cfg: ClickUpConfig,
  teamId: string,
): Promise<{ byDept: Map<string, string>; fallbackListId: string | null }> {
  const byDept = new Map<string, string>();
  let fallbackListId: string | null = cfg.fallbackListId || null;

  const spacesRes = await cuJson<{ spaces?: { id: string; name: string }[] }>(cfg.token, `/team/${teamId}/space?archived=false`);
  for (const space of spacesRes.spaces || []) {
    try {
      const listsRes = await cuJson<{ lists?: { id: string; name: string }[] }>(cfg.token, `/space/${space.id}/list?archived=false`);
      const first = (listsRes.lists || [])[0];
      if (!first) continue;
      byDept.set(normName(space.name), first.id);
      if (!cfg.fallbackListId && normName(space.name) === 'call inbox') fallbackListId = first.id;
    } catch (e) {
      console.error('[clickup] list discovery failed for space', space.name, (e as Error).message);
    }
  }
  // Explicit admin overrides win over auto-discovery.
  for (const [dept, listId] of Object.entries(cfg.listMap)) {
    if (listId) byDept.set(normName(dept), String(listId));
  }
  return { byDept, fallbackListId };
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

async function createClickUpTask(token: string, listId: string, body: CreateBody): Promise<{ id: string; url: string }> {
  try {
    return await cuJson<{ id: string; url: string }>(token, `/list/${listId}/task`, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // Private lists: a matched assignee may not be a member of THIS list → ClickUp
    // rejects. Don't auto-add them — retry once unassigned (task still lands).
    if (body.assignees?.length || body.status) {
      // A private-list non-member assignee OR a status name the list doesn't have
      // would reject — retry without either so the task still lands (defaults New).
      console.warn('[clickup] create failed, retrying without assignees/status:', (e as Error).message);
      const { assignees: _a, status: _s, ...rest } = body;
      return cuJson<{ id: string; url: string }>(token, `/list/${listId}/task`, { method: 'POST', body: JSON.stringify(rest) });
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

/** Per-assignee destinations for a task: personal list for a multi-department user,
 *  else the task's department list. Assignees not in ClickUp are dropped. */
async function resolveAssigneeTargets(
  assigneeUserIds: string[],
  ctx: {
    members: Map<string, number>;
    emailById: Map<string, string>;
    nameById: Map<string, string>;
    multiDept: Set<string>;
    deptListId: string | null;
    personal: PersonalRouter;
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
    // Multi-dept user → personal list; on failure fall back to the department list.
    let listId = ctx.deptListId;
    if (ctx.multiDept.has(uid)) {
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
async function syncSplitMeetingTask(
  cfg: ClickUpConfig,
  fieldCache: Map<string, { fieldId: string; optionId: string } | null>,
  item: SplitMeetingTask,
  targets: AssigneeTarget[],
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  let lead: { id: string; url: string } | null = null;
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
        await prisma.clickUpTaskLink.update({ where: { id: existing.id }, data: { syncedAt: new Date(), title: item.title, listId: t.listId, rowId: item.rowId, assigneeUserId: t.garelyUserId } });
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
    const [members, listMap] = await Promise.all([
      resolveMembers(cfg.token),
      resolveListMap(cfg, teamId),
    ]);

    // Resolve Garely entity names/emails for the items in batch.
    const deptIds = [...new Set(items.map((i) => i.departmentId).filter((x): x is string => !!x))];
    const userIds = [...new Set(items.flatMap((i) => i.assigneeUserIds).filter(Boolean))];
    const [depts, users] = await Promise.all([
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : Promise.resolve([]),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));
    const nameById = new Map(users.map((u) => [u.id, u.name || '']));

    // Per-user routing prerequisites (only when the mode is on).
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
        const dName = item.departmentId ? deptName.get(item.departmentId) || null : null;
        const listId = listIdForDepartment(cfg, listMap, dName);

        // Per-user split path: one task per assignee, personal list for multi-dept users.
        if (cfg.personalRouting && personal) {
          const targets = await resolveAssigneeTargets(item.assigneeUserIds, {
            members, emailById, nameById, multiDept, deptListId: listId, personal,
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
          console.error('[clickup] no destination list for task (no match + no fallback):', item.title);
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
          await prisma.clickUpTaskLink.update({
            where: { id: existing.id },
            data: { syncedAt: new Date(), title: item.title, listId },
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
          await prisma.clickUpTaskLink.create({
            data: { meetingId, dedupeKey, clickupTaskId: res.id, clickupUrl: res.url, listId, title: item.title },
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
  if (type === 'done' || type === 'closed') return 'done';
  if (name.includes('done') || name.includes('complete') || name.includes('closed')) return 'done';
  if (name.includes('progress') || name.includes('blocked') || name.includes('review')) return 'in_progress';
  return 'open';
}

// ─────────────────────────── webhook management (ClickUp → Garely) ───────────────────────────

/** Create (or verify) the ClickUp webhook that pushes status/deletion back to Garely. Idempotent. */
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
      // Verify the stored webhook still exists + points at us.
      const list = await cuJson<{ webhooks?: { id: string; endpoint: string }[] }>(cfg.token, `/team/${teamId}/webhook`);
      const found = (list.webhooks || []).find((w) => w.id === stored.CLICKUP_WEBHOOK_ID);
      if (found && found.endpoint === endpoint) return { ok: true };
      // Endpoint changed (e.g. domain move) → drop the stale webhook before re-creating.
      if (found) await cuJson(cfg.token, `/webhook/${stored.CLICKUP_WEBHOOK_ID}`, { method: 'DELETE' }).catch(() => {});
    }
    const res = await cuJson<{ id?: string; webhook?: { id: string; secret: string } }>(cfg.token, `/team/${teamId}/webhook`, {
      method: 'POST',
      body: JSON.stringify({ endpoint, events: ['taskStatusUpdated', 'taskDeleted'] }),
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

    // Status (or generic update): read the authoritative current status from ClickUp.
    const cfg = await getClickUpConfig();
    if (!cfg) return;
    let statusName: string | undefined;
    let statusType: string | undefined;
    try {
      const task = await cuJson<{ id?: string; status?: { status?: string; type?: string } }>(cfg.token, `/task/${clickupTaskId}`);
      if (task.id && task.id !== clickupTaskId) return; // defensive: ClickUp returned a different task
      statusName = task.status?.status;
      statusType = task.status?.type;
    } catch (e) {
      console.error('[clickup] fetch task for status failed:', (e as Error).message);
      return;
    }
    const gStatus = clickUpStatusToGarely(statusType, statusName);

    const row = await prisma.row.findUnique({
      where: { id: rowId },
      select: { data: true, table: { select: { base: { select: { orgId: true } } } } },
    });
    if (!row) return;
    const prov = await getSystemTasksTable(row.table.base.orgId);
    if (!prov) return;
    const data = { ...((row.data as Record<string, unknown>) ?? {}), [prov.fieldIds.status]: gStatus };
    await prisma.$transaction([
      prisma.row.update({ where: { id: rowId }, data: { data: data as Prisma.InputJsonValue } }),
      prisma.taskRow.update({
        where: { rowId },
        data: { clickupStatus: statusName || null, clickupSyncedAt: new Date(), completedAt: gStatus === 'done' ? new Date() : null },
      }),
    ]);
  } catch (e) {
    console.error('[clickup] applyClickUpEvent failed:', (e as Error).message);
  }
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
    const [members, listMap] = await Promise.all([resolveMembers(cfg.token), resolveListMap(cfg, teamId)]);
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
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true, name: true } }) : Promise.resolve([]),
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      parentIds.length ? prisma.row.findMany({ where: { id: { in: parentIds } }, select: { id: true, data: true } }) : Promise.resolve([]),
    ]);
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));
    const nameById = new Map(users.map((u) => [u.id, u.name || '']));
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
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
        if (cfg.personalRouting && personal && row.taskMeta?.meetingId) {
          const dNameP = row.taskMeta.departmentId ? deptName.get(row.taskMeta.departmentId) || null : null;
          const deptListId = listIdForDepartment(cfg, listMap, dNameP);
          const targets = await resolveAssigneeTargets(row.assignments.map((a) => a.userId), {
            members, emailById, nameById, multiDept, deptListId, personal,
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

        const dName = row.taskMeta?.departmentId ? deptName.get(row.taskMeta.departmentId) || null : null;
        const listId = listIdForDepartment(cfg, listMap, dName);
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
