import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { readConfig, writeConfig, publicBaseUrl } from './config';
import { decryptSecret, encryptSecret } from './twofactor';
import { getSingletonOrgId } from './org';
import { getSystemTasksTable } from './system-tasks-table';

/**
 * Linear integration — TWO-WAY sync of Garely's AI-generated meeting tasks with a
 * Linear workspace. Architecturally identical to the ClickUp integration (see
 * lib/clickup.ts): opt-in (no-op unless LINEAR_ENABLED=true + a token is set),
 * non-blocking (fire-and-forget after the report transaction commits), fail-soft
 * (every Linear error is logged and swallowed; report generation is never broken).
 *
 * ZERO-CONFIG: the admin pastes ONE thing — a Linear API key (lin_api_…) — in
 * Settings → Integrations. Everything else is auto-discovered from the key:
 *   - teams:    `teams` query; each Garely DEPARTMENT routes to the team whose
 *               name matches (normalized), else a configured/first fallback team.
 *   - members:  email(lowercased) → Linear user id (the assignee join key).
 *   - states:   per-team workflow states; the right state is picked by TYPE
 *               (unstarted/started/completed) when mirroring Garely status.
 *
 * OWNERSHIP / read-only mirror: a task is pushed only if ≥1 assignee resolves to a
 * Linear member (same "any assignee in Linear → owned" rule as ClickUp). Owned
 * tasks render read-only in Garely; Linear becomes the source of truth. A Linear
 * webhook (resourceTypes ["Issue"]) mirrors workflow-state changes + deletions back.
 *
 * IDEMPOTENCY: regenerate delete-then-inserts the AI Rows (Row.id is NOT stable),
 * so links key on a stable semantic tuple hashed into dedupeKey — same task ⇒
 * issueUpdate, not a duplicate.
 *
 * DIFFERENCES vs ClickUp: (a) Linear is GraphQL (not REST). (b) a Linear issue has
 * a SINGLE assignee — we use the first matched member and note the rest in the
 * description. (c) status is a per-team WorkflowState (matched by `type`), not a
 * global status name. (d) the webhook secret is one WE generate and pass to
 * webhookCreate, so verification never depends on reading it back.
 *
 * v1 LIMITATIONS (accepted, mirroring ClickUp): re-worded titles orphan the old
 * issue; identical title+dept+parent collide; dropped tasks leave their issue; the
 * users/teams discovery is first-page only (fine at our scale of tens); config is
 * workspace-global (per-org scoping waits for Phase 5).
 */

const LINEAR_API = 'https://api.linear.app/graphql';
const TIMEOUT_MS = 15_000;
const REPLAY_WINDOW_MS = 60_000; // reject webhooks older than this (replay guard)

export interface LinearConfig {
  token: string;
  routingMode: 'department' | 'inbox';
  teamMap: Record<string, string>; // explicit dept-name → team-id overrides
  fallbackTeamId: string; // '' → first team
}

/** One AI task (parent or subtask) to mirror into Linear. */
export interface LinearPushItem {
  rowId: string;
  title: string;
  priority: string | null; // high | medium | low
  dueDate: Date | null;
  departmentId: string | null;
  assigneeUserIds: string[]; // Garely user ids
  parentTitle: string | null; // set for subtasks (disambiguates dedupe)
}

// ─────────────────────────── pure mappers (unit-tested) ───────────────────────────

/** Garely priority → Linear priority Int (0 none · 1 urgent · 2 high · 3 normal · 4 low). */
export function mapPriority(p: string | null | undefined): number {
  switch ((p || '').toLowerCase()) {
    case 'high': return 2;
    case 'medium': return 3;
    case 'low': return 4;
    default: return 0; // No priority
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
): string {
  const parts = [meetingId, normName(title), departmentId || '-', normName(parentTitle) || '-'];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Resolve the destination team id for a department name (honors routing mode). */
export function teamIdForDepartment(
  cfg: LinearConfig,
  teamMap: { byDept: Map<string, string>; fallbackTeamId: string | null },
  departmentName: string | null,
): string | null {
  if (cfg.routingMode === 'inbox') return teamMap.fallbackTeamId;
  if (departmentName) {
    const direct = teamMap.byDept.get(normName(departmentName));
    if (direct) return direct;
  }
  return teamMap.fallbackTeamId;
}

/** Garely status → the Linear WorkflowState TYPE to look up (open → unstarted). */
export function garelyStatusToStateType(status: string | null | undefined): 'unstarted' | 'started' | 'completed' {
  switch ((status || '').toLowerCase()) {
    case 'in_progress': return 'started';
    case 'done': return 'completed';
    default: return 'unstarted';
  }
}

/** Linear WorkflowState (type + name) → Garely 3-state status. */
export function linearStateToGarely(stateType: string | null | undefined, stateName: string | null | undefined): 'open' | 'in_progress' | 'done' {
  const type = (stateType || '').toLowerCase();
  const name = (stateName || '').toLowerCase();
  if (type === 'completed' || type === 'canceled') return 'done';
  if (type === 'started') return 'in_progress';
  if (name.includes('done') || name.includes('complete') || name.includes('cancel')) return 'done';
  if (name.includes('progress') || name.includes('review') || name.includes('blocked')) return 'in_progress';
  return 'open'; // backlog | unstarted | triage
}

// ─────────────────────────── config ───────────────────────────

/** The stored token/secret is AES-GCM ciphertext (v1.…); tolerate a raw value too. */
export function decodeToken(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) {
    try { return decryptSecret(raw); } catch { console.error('[linear] secret decrypt failed — corrupted ciphertext or AUTH_SECRET changed'); return ''; }
  }
  return raw;
}

/** Read + decrypt the Linear config. Returns null when disabled or unconfigured. */
export async function getLinearConfig(): Promise<LinearConfig | null> {
  const m = await readConfig(['LINEAR_ENABLED', 'LINEAR_TOKEN', 'LINEAR_TEAM_MAP', 'LINEAR_FALLBACK_TEAM_ID', 'LINEAR_ROUTING_MODE']);
  if (m.LINEAR_ENABLED !== 'true') return null;
  const token = decodeToken(m.LINEAR_TOKEN);
  if (!token) return null;
  let teamMap: Record<string, string> = {};
  try { if (m.LINEAR_TEAM_MAP) teamMap = JSON.parse(m.LINEAR_TEAM_MAP); } catch { teamMap = {}; }
  return {
    token,
    routingMode: m.LINEAR_ROUTING_MODE === 'inbox' ? 'inbox' : 'department',
    teamMap,
    fallbackTeamId: (m.LINEAR_FALLBACK_TEAM_ID || '').trim(),
  };
}

// ─────────────────────────── GraphQL transport ───────────────────────────

/** POST a GraphQL op to Linear. Raw API key in Authorization (NO "Bearer"). Never leaks the token. */
async function lnGraphQL<T = any>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const doFetch = () => fetch(LINEAR_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  let res = await doFetch();
  if (res.status === 429) {
    const retryAfter = Math.min(Number(res.headers.get('retry-after')) || 1, 3);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    res = await doFetch();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Linear HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  const json = await res.json() as { data?: T; errors?: { message?: string }[] };
  if (json.errors?.length) {
    throw new Error(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ').slice(0, 200)}`);
  }
  return json.data as T;
}

/** Health check used by Settings → Test connection. Returns the visible teams. */
export async function linearPing(token: string): Promise<{ teams: { id: string; name: string }[]; user: string }> {
  const data = await lnGraphQL<{ viewer?: { name?: string }; teams?: { nodes?: { id: string; name: string }[] } }>(
    token,
    '{ viewer { id name } teams(first: 100) { nodes { id name } } }',
  );
  return { teams: (data.teams?.nodes || []).map((t) => ({ id: t.id, name: t.name })), user: data.viewer?.name || '' };
}

// ─────────────────────────── runtime resolvers (cached per run) ───────────────────────────

async function resolveMembers(token: string): Promise<Map<string, string>> {
  const data = await lnGraphQL<{ users?: { nodes?: { id: string; email?: string; active?: boolean }[] } }>(
    token,
    '{ users(first: 250) { nodes { id email active } } }',
  );
  const out = new Map<string, string>();
  for (const u of data.users?.nodes || []) {
    if (u.email && u.active !== false) out.set(u.email.toLowerCase(), u.id);
  }
  return out;
}

async function resolveTeams(cfg: LinearConfig): Promise<{ byDept: Map<string, string>; fallbackTeamId: string | null }> {
  const data = await lnGraphQL<{ teams?: { nodes?: { id: string; name: string }[] } }>(
    cfg.token,
    '{ teams(first: 100) { nodes { id name } } }',
  );
  const teams = data.teams?.nodes || [];
  const byDept = new Map<string, string>();
  for (const t of teams) byDept.set(normName(t.name), t.id);
  // Explicit admin overrides win over name auto-discovery.
  for (const [dept, teamId] of Object.entries(cfg.teamMap)) {
    if (teamId) byDept.set(normName(dept), String(teamId));
  }
  const fallbackTeamId = cfg.fallbackTeamId || teams[0]?.id || null;
  return { byDept, fallbackTeamId };
}

/** Resolve a team's workflow states → map of TYPE → state id (lowest position wins). */
async function resolveTeamStates(token: string, teamId: string, cache: Map<string, Map<string, string>>): Promise<Map<string, string>> {
  const hit = cache.get(teamId);
  if (hit) return hit;
  const byType = new Map<string, string>();
  try {
    const data = await lnGraphQL<{ team?: { states?: { nodes?: { id: string; type: string; position: number }[] } } }>(
      token,
      'query($id: String!) { team(id: $id) { states { nodes { id type position } } } }',
      { id: teamId },
    );
    const states = (data.team?.states?.nodes || []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    for (const s of states) { if (!byType.has(s.type)) byType.set(s.type, s.id); } // first (lowest position) of each type
  } catch (e) {
    console.error('[linear] state discovery failed for team', teamId, (e as Error).message);
  }
  cache.set(teamId, byType);
  return byType;
}

/** Pick a state id for a Garely status within a team; falls back across compatible types. */
function stateIdForStatus(states: Map<string, string>, status: string | null | undefined): string | undefined {
  const want = garelyStatusToStateType(status);
  if (states.has(want)) return states.get(want);
  if (want === 'unstarted') return states.get('backlog') || states.get('triage');
  return undefined; // let Linear use the team default
}

// ─────────────────────────── create / update one issue ───────────────────────────

type IssueInput = {
  teamId: string;
  title: string;
  description?: string;
  assigneeId?: string;
  stateId?: string;
  priority?: number;
  dueDate?: string; // TimelessDate "YYYY-MM-DD"
};

const ISSUE_CREATE = `mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;

async function createLinearIssue(token: string, input: IssueInput): Promise<{ id: string; url: string }> {
  const run = async (vars: IssueInput) => {
    const data = await lnGraphQL<{ issueCreate?: { success: boolean; issue?: { id: string; url: string } } }>(token, ISSUE_CREATE, { input: vars });
    const issue = data.issueCreate?.issue;
    if (!data.issueCreate?.success || !issue?.id) throw new Error('issueCreate returned no issue');
    return { id: issue.id, url: issue.url };
  };
  try {
    return await run(input);
  } catch (e) {
    // A non-team assignee or a wrong stateId would reject — retry without either so
    // the issue still lands (team default state, unassigned).
    if (input.assigneeId || input.stateId) {
      console.warn('[linear] create failed, retrying without assignee/state:', (e as Error).message);
      const { assigneeId: _a, stateId: _s, ...rest } = input;
      return run(rest);
    }
    throw e;
  }
}

/** Mark a Garely task Row as Linear-owned (read-only mirror + reverse-sync anchor). */
async function markRowOwned(rowId: string, linearIssueId: string, linearUrl: string | null): Promise<void> {
  await prisma.taskRow
    .update({ where: { rowId }, data: { linearIssueId, linearUrl: linearUrl ?? undefined, linearSyncedAt: new Date() } })
    .catch((e) => console.error('[linear] mark row owned failed:', rowId, (e as Error).message));
}

/**
 * Format a Date as a Linear TimelessDate (YYYY-MM-DD) from LOCAL calendar
 * components — NOT `toISOString().slice(0,10)`, which projects to UTC and lands
 * the wrong calendar day on non-UTC servers. Local components match how Garely
 * itself renders due dates (the report board uses `new Date(...).getDate()`).
 */
function toTimelessDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDue(d: Date | null): string | undefined {
  if (!d || Number.isNaN(d.getTime())) return undefined;
  return toTimelessDate(d);
}

// ─────────────────────────── orchestrator (called from regenerate.ts) ───────────────────────────

/**
 * Push a meeting's freshly-created AI tasks into Linear. Fire-and-forget: resolve
 * everything once, then create/update each issue idempotently. Never throws.
 */
export async function pushMeetingTasksToLinear(meetingId: string, items: LinearPushItem[]): Promise<void> {
  if (!items.length) return;
  let cfg: LinearConfig | null = null;
  try {
    cfg = await getLinearConfig();
  } catch (e) {
    console.error('[linear] config read failed:', (e as Error).message);
    return;
  }
  if (!cfg) return; // disabled / unconfigured → silent no-op

  try {
    const [members, teamMap] = await Promise.all([resolveMembers(cfg.token), resolveTeams(cfg)]);

    const deptIds = [...new Set(items.map((i) => i.departmentId).filter((x): x is string => !!x))];
    const userIds = [...new Set(items.flatMap((i) => i.assigneeUserIds).filter(Boolean))];
    const [depts, users] = await Promise.all([
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : Promise.resolve([]),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));

    let created = 0;
    let updated = 0;

    for (const item of items) {
      try {
        const dName = item.departmentId ? deptName.get(item.departmentId) || null : null;
        const teamId = teamIdForDepartment(cfg, teamMap, dName);
        if (!teamId) {
          console.error('[linear] no destination team for task (no match + no fallback):', item.title);
          continue;
        }

        // Assignees by email; Linear takes a single assignee → first match wins.
        const matched: string[] = [];
        const unmatched: string[] = [];
        for (const uid of item.assigneeUserIds) {
          const email = emailById.get(uid);
          if (!email) continue;
          const lid = members.get(email);
          if (lid) matched.push(lid); else unmatched.push(email);
        }
        // OWNED gate (same rule as ClickUp): pushed only if ≥1 assignee is a Linear
        // member. Tasks with no Linear assignee stay native to Garely.
        if (!matched.length) continue;

        const extraEmails = unmatched.length ? unmatched.map((e) => `Unassigned in Linear: ${e}`).join('\n') : undefined;
        const prio = mapPriority(item.priority);
        const due = fmtDue(item.dueDate);
        const dedupeKey = dedupeKeyFor(meetingId, item.title, item.departmentId, item.parentTitle);
        const existing = await prisma.linearTaskLink.findUnique({ where: { meetingId_dedupeKey: { meetingId, dedupeKey } } });

        if (existing) {
          // Update content only — NOT state/assignee (preserve human changes made in Linear).
          const input: Record<string, unknown> = { title: item.title };
          if (extraEmails) input.description = extraEmails;
          if (prio) input.priority = prio;
          if (due) input.dueDate = due;
          await lnGraphQL(cfg.token, 'mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: existing.linearIssueId, input });
          await prisma.linearTaskLink.update({ where: { id: existing.id }, data: { syncedAt: new Date(), title: item.title, teamId } });
          await markRowOwned(item.rowId, existing.linearIssueId, existing.linearUrl);
          // Reconcile the (re-created on regenerate) row to Linear's CURRENT state, so
          // the read-only mirror isn't reset to "open" — also self-heals a webhook
          // event lost during the regenerate delete-then-insert window.
          await applyLinearEvent('update', 'Issue', existing.linearIssueId);
          updated++;
        } else {
          const input: IssueInput = { teamId, title: item.title };
          if (extraEmails) input.description = extraEmails;
          if (matched[0]) input.assigneeId = matched[0];
          if (prio) input.priority = prio;
          if (due) input.dueDate = due;
          const res = await createLinearIssue(cfg.token, input);
          await prisma.linearTaskLink.create({ data: { meetingId, dedupeKey, linearIssueId: res.id, linearUrl: res.url, teamId, title: item.title } });
          await markRowOwned(item.rowId, res.id, res.url);
          created++;
        }
      } catch (e) {
        console.error('[linear] push failed for task:', item.title, '·', (e as Error).message);
      }
    }
    console.log(`[linear] meeting ${meetingId}: ${created} created, ${updated} updated, ${items.length} total`);
  } catch (e) {
    console.error('[linear] push aborted:', (e as Error).message);
  }
}

// ─────────────────────────── webhook management (Linear → Garely) ───────────────────────────

const WEBHOOK_CREATE = `mutation($input: WebhookCreateInput!) {
  webhookCreate(input: $input) { success webhook { id enabled } }
}`;

/** Create (or verify) the Linear webhook that pushes state/deletion back to Garely. Idempotent. */
export async function ensureLinearWebhook(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await getLinearConfig();
  if (!cfg) return { ok: false, error: 'disabled' };
  const base = await publicBaseUrl();
  if (!base) return { ok: false, error: 'no_public_url' };
  const endpoint = `${base}/api/webhooks/linear`;
  try {
    const stored = await readConfig(['LINEAR_WEBHOOK_ID', 'LINEAR_WEBHOOK_SECRET']);
    if (stored.LINEAR_WEBHOOK_ID && decodeToken(stored.LINEAR_WEBHOOK_SECRET)) {
      const list = await lnGraphQL<{ webhooks?: { nodes?: { id: string; url: string; enabled: boolean }[] } }>(cfg.token, '{ webhooks(first: 100) { nodes { id url enabled } } }');
      const found = (list.webhooks?.nodes || []).find((w) => w.id === stored.LINEAR_WEBHOOK_ID);
      // Healthy only if it points at us AND is still enabled — Linear auto-disables
      // a webhook after repeated delivery failures, so an `enabled:false` one must
      // be recreated for the self-heal to actually fire (else status sync stays dead).
      if (found && found.url === endpoint && found.enabled) return { ok: true };
      if (found) await lnGraphQL(cfg.token, 'mutation($id: String!) { webhookDelete(id: $id) { success } }', { id: stored.LINEAR_WEBHOOK_ID }).catch(() => {});
    }
    // We generate the signing secret ourselves and pass it in, so verification
    // never depends on reading it back from Linear.
    const secret = randomBytes(32).toString('hex');
    const data = await lnGraphQL<{ webhookCreate?: { success: boolean; webhook?: { id: string } } }>(cfg.token, WEBHOOK_CREATE, {
      input: { url: endpoint, resourceTypes: ['Issue'], allPublicTeams: true, secret, label: 'Garely' },
    });
    const id = data.webhookCreate?.webhook?.id;
    if (!data.webhookCreate?.success || !id) throw new Error('webhookCreate returned no webhook');
    await writeConfig({ LINEAR_WEBHOOK_ID: id, LINEAR_WEBHOOK_SECRET: encryptSecret(secret) });
    return { ok: true };
  } catch (e) {
    console.error('[linear] ensure webhook failed:', (e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Delete the Linear webhook + clear its stored id/secret. Safe when already gone. */
export async function removeLinearWebhook(): Promise<void> {
  const m = await readConfig(['LINEAR_TOKEN', 'LINEAR_WEBHOOK_ID']);
  const token = decodeToken(m.LINEAR_TOKEN);
  if (token && m.LINEAR_WEBHOOK_ID) {
    await lnGraphQL(token, 'mutation($id: String!) { webhookDelete(id: $id) { success } }', { id: m.LINEAR_WEBHOOK_ID }).catch(() => {});
  }
  await writeConfig({ LINEAR_WEBHOOK_ID: '', LINEAR_WEBHOOK_SECRET: '' });
}

/** Verify a Linear webhook's Linear-Signature (hex HMAC-SHA256 of the raw body with our secret). */
export async function verifyLinearSignature(rawBody: string, signature: string | null | undefined): Promise<boolean> {
  if (!signature) return false;
  const m = await readConfig(['LINEAR_WEBHOOK_SECRET']);
  const secret = decodeToken(m.LINEAR_WEBHOOK_SECRET);
  if (!secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** True if a webhook timestamp is within the replay window (guards against replay). */
export function withinReplayWindow(webhookTimestamp: number | undefined, nowMs: number): boolean {
  if (!webhookTimestamp || Number.isNaN(webhookTimestamp)) return false;
  return Math.abs(nowMs - webhookTimestamp) <= REPLAY_WINDOW_MS;
}

// ─────────────────────────── reverse apply (a Linear event → the Garely Row) ───────────────────────────

/**
 * Apply a Linear webhook event to the owning Garely task Row. `remove` deletes the
 * Row (+ its subtasks); create/update fetch the issue's CURRENT state from Linear
 * (source of truth) and mirror it into the Row. No-op if the issue id isn't a
 * Garely-owned one. Never throws.
 */
export async function applyLinearEvent(action: string, type: string, linearIssueId: string): Promise<void> {
  if (type !== 'Issue') return;
  try {
    const tr = await prisma.taskRow.findFirst({ where: { linearIssueId }, select: { rowId: true } });
    if (!tr) return; // not a task Garely pushed → ignore

    if (action === 'remove') {
      const subs = await prisma.taskRow.findMany({ where: { parentRowId: tr.rowId }, select: { rowId: true } });
      const ids = [tr.rowId, ...subs.map((s) => s.rowId)];
      await prisma.row.deleteMany({ where: { id: { in: ids } } }); // cascades TaskRow + Row*
      console.log('[linear] issue removed → removed Garely row', tr.rowId);
      return;
    }

    // create / update: read the authoritative current state from Linear.
    const cfg = await getLinearConfig();
    if (!cfg) return;
    let stateName: string | undefined;
    let stateType: string | undefined;
    try {
      const data = await lnGraphQL<{ issue?: { id?: string; state?: { name?: string; type?: string } } }>(
        cfg.token,
        'query($id: String!) { issue(id: $id) { id state { name type } } }',
        { id: linearIssueId },
      );
      if (data.issue?.id && data.issue.id !== linearIssueId) return; // defensive
      stateName = data.issue?.state?.name;
      stateType = data.issue?.state?.type;
    } catch (e) {
      console.error('[linear] fetch issue for state failed:', (e as Error).message);
      return;
    }
    const gStatus = linearStateToGarely(stateType, stateName);

    const row = await prisma.row.findUnique({
      where: { id: tr.rowId },
      select: { data: true, table: { select: { base: { select: { orgId: true } } } } },
    });
    if (!row) return;
    const prov = await getSystemTasksTable(row.table.base.orgId);
    if (!prov) return;
    const data = { ...((row.data as Record<string, unknown>) ?? {}), [prov.fieldIds.status]: gStatus };
    await prisma.$transaction([
      prisma.row.update({ where: { id: tr.rowId }, data: { data: data as Prisma.InputJsonValue } }),
      prisma.taskRow.update({
        where: { rowId: tr.rowId },
        data: { linearStatus: stateName || null, linearSyncedAt: new Date(), completedAt: gStatus === 'done' ? new Date() : null },
      }),
    ]);
  } catch (e) {
    console.error('[linear] applyLinearEvent failed:', (e as Error).message);
  }
}

// ─────────────────────────── migration (existing Garely tasks → Linear) ───────────────────────────

/** Coerce a JSONB cell value to a string (or null) for reading task fields. */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : v == null ? null : String(v);
}

/**
 * One-time backfill on connect: push EVERY existing Garely task assigned to a Linear
 * member into Linear (incl. done/in-progress, mapped to the right workflow state),
 * mark it owned (read-only mirror), and — for meeting tasks — record a dedupe link.
 * Marker-idempotent (already-owned rows skipped) + throttled. Never throws.
 */
export async function migrateAllTasksToLinear(): Promise<{ migrated: number; skipped: number }> {
  let migrated = 0;
  let skipped = 0;
  try {
    const cfg = await getLinearConfig();
    if (!cfg) return { migrated, skipped };
    const orgId = await getSingletonOrgId();
    if (!orgId) return { migrated, skipped };
    const prov = await getSystemTasksTable(orgId);
    if (!prov) return { migrated, skipped };

    // Guard against a concurrent run (e.g. rapid re-enable): skip if one is in flight.
    const cur = await readConfig(['LINEAR_MIGRATION']);
    try { if (cur.LINEAR_MIGRATION && JSON.parse(cur.LINEAR_MIGRATION).state === 'running') return { migrated, skipped }; } catch { /* ignore */ }
    // Claim the 'running' marker IMMEDIATELY (before the expensive resolves + findMany)
    // to narrow the read-then-write window so two near-simultaneous connects don't both
    // pass the guard and double-push. (`total` is filled in once the rows are counted.)
    await writeConfig({ LINEAR_MIGRATION: JSON.stringify({ state: 'running', total: 0, migrated: 0 }) });

    const [members, teamMap] = await Promise.all([resolveMembers(cfg.token), resolveTeams(cfg)]);
    const f = prov.fieldIds;

    const rows = await prisma.row.findMany({
      where: { tableId: prov.table.id, taskMeta: { is: { linearIssueId: null } }, assignments: { some: {} } },
      select: {
        id: true, data: true,
        taskMeta: { select: { meetingId: true, departmentId: true, parentRowId: true } },
        assignments: { select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    await writeConfig({ LINEAR_MIGRATION: JSON.stringify({ state: 'running', total: rows.length, migrated: 0 }) });

    const userIds = [...new Set(rows.flatMap((r) => r.assignments.map((a) => a.userId)))];
    const deptIds = [...new Set(rows.map((r) => r.taskMeta?.departmentId).filter((x): x is string => !!x))];
    const parentIds = [...new Set(rows.map((r) => r.taskMeta?.parentRowId).filter((x): x is string => !!x))];
    const [users, depts, parents] = await Promise.all([
      userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : Promise.resolve([]),
      deptIds.length ? prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
      parentIds.length ? prisma.row.findMany({ where: { id: { in: parentIds } }, select: { id: true, data: true } }) : Promise.resolve([]),
    ]);
    const emailById = new Map(users.map((u) => [u.id, (u.email || '').toLowerCase()]));
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const parentTitle = new Map(parents.map((p) => [p.id, str((p.data as Record<string, unknown>)?.[f.title]) || null]));
    const stateCache = new Map<string, Map<string, string>>();

    let i = 0;
    for (const row of rows) {
      i++;
      try {
        const data = (row.data ?? {}) as Record<string, unknown>;
        const matched: string[] = [];
        const unmatched: string[] = [];
        for (const a of row.assignments) {
          const email = emailById.get(a.userId);
          if (!email) continue;
          const lid = members.get(email);
          if (lid) matched.push(lid); else unmatched.push(email);
        }
        if (!matched.length) { skipped++; continue; } // no Linear assignee → stays native

        const dName = row.taskMeta?.departmentId ? deptName.get(row.taskMeta.departmentId) || null : null;
        const teamId = teamIdForDepartment(cfg, teamMap, dName);
        if (!teamId) { skipped++; continue; }

        const states = await resolveTeamStates(cfg.token, teamId, stateCache);
        const input: IssueInput = { teamId, title: str(data[f.title]) || '(untitled)' };
        if (unmatched.length) input.description = unmatched.map((e) => `Unassigned in Linear: ${e}`).join('\n');
        if (matched[0]) input.assigneeId = matched[0];
        const prio = mapPriority(str(data[f.priority]));
        if (prio) input.priority = prio;
        const due = str(data[f.dueDate]);
        if (due) { const ms = Date.parse(due); if (!Number.isNaN(ms)) input.dueDate = toTimelessDate(new Date(ms)); }
        const stateId = stateIdForStatus(states, str(data[f.status]));
        if (stateId) input.stateId = stateId;

        const res = await createLinearIssue(cfg.token, input);
        await markRowOwned(row.id, res.id, res.url);
        if (row.taskMeta?.meetingId) {
          const dedupeKey = dedupeKeyFor(row.taskMeta.meetingId, input.title, row.taskMeta.departmentId ?? null, row.taskMeta.parentRowId ? parentTitle.get(row.taskMeta.parentRowId) ?? null : null);
          await prisma.linearTaskLink.upsert({
            where: { meetingId_dedupeKey: { meetingId: row.taskMeta.meetingId, dedupeKey } },
            create: { meetingId: row.taskMeta.meetingId, dedupeKey, linearIssueId: res.id, linearUrl: res.url, teamId, title: input.title },
            update: { linearIssueId: res.id, linearUrl: res.url, teamId, title: input.title, syncedAt: new Date() },
          }).catch(() => {});
        }
        migrated++;
      } catch (e) {
        console.error('[linear] migrate failed for row', row.id, (e as Error).message);
        skipped++;
      }
      if (i % 20 === 0) {
        // Bail if Linear was disconnected mid-run, so we don't keep re-owning tasks
        // that disableLinearSync() just released (leaving them owned with no webhook).
        const live = await readConfig(['LINEAR_ENABLED']);
        if (live.LINEAR_ENABLED !== 'true') { console.log('[linear] migration cancelled — disconnected mid-run'); break; }
        await writeConfig({ LINEAR_MIGRATION: JSON.stringify({ state: 'running', total: rows.length, migrated }) });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    await writeConfig({ LINEAR_MIGRATION: JSON.stringify({ state: 'done', total: rows.length, migrated, skipped }) });
    console.log(`[linear] migration done: ${migrated} migrated, ${skipped} skipped of ${rows.length}`);
  } catch (e) {
    console.error('[linear] migration aborted:', (e as Error).message);
    await writeConfig({ LINEAR_MIGRATION: JSON.stringify({ state: 'error', error: (e as Error).message }) }).catch(() => {});
  }
  return { migrated, skipped };
}

// ─────────────────────────── connect / disconnect orchestration ───────────────────────────

/** On connect (enabled + token): register the reverse webhook, then migrate existing tasks. */
export async function enableLinearSync(): Promise<void> {
  await ensureLinearWebhook();
  await migrateAllTasksToLinear();
}

/** On disconnect: remove the webhook and release every owned task back to Garely-native. */
export async function disableLinearSync(): Promise<void> {
  await removeLinearWebhook();
  await prisma.taskRow.updateMany({
    where: { linearIssueId: { not: null } },
    data: { linearIssueId: null, linearUrl: null, linearStatus: null, linearSyncedAt: null },
  });
  await writeConfig({ LINEAR_MIGRATION: '' });
}
