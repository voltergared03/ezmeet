import { Prisma } from '@prisma/client';
import type { Session } from 'next-auth';
import { prisma } from './prisma';
import { coerceRowData, mergeRowData, presentRowData, type FieldLike } from './base-rows';
import { normalizeFieldOptions, type FieldType } from './base-engine';
import {
  getSystemTasksTable,
  provisionSystemTasksTable,
  type SystemTasksProvision,
  type TaskFieldIds,
} from './system-tasks-table';
import { userDepartmentIds, userCanAccessMeeting, userCanViewTask } from './access';
import { getCurrentOrgId, requireCurrentOrgId } from './org';
import { dispatchWebhook, taskWebhookPayload } from './webhooks';

/**
 * Task adapter (Phase 3.2, roadmap §15) — the single place the app reads/writes
 * "tasks", which now live as base-engine Rows in the per-org system "Tasks"
 * table (+ a TaskRow sidecar for structural FKs + RowAssignment/RowCollaborator/
 * RowComment/RowAttachment for collaboration). It assembles a MeetingTask-shaped
 * DTO so every call site (API routes, AI pipeline, calendar, ICS, notify,
 * dashboard, cron) keeps the legacy shape and changes minimally.
 *
 * Tenant isolation: Row has no orgId; it comes entirely from scoping queries to
 * the org's single system Tasks `tableId`. Always resolve the table first.
 */

// ---- DTO -------------------------------------------------------------------
type UserLite = { id: string; name: string | null; image: string | null };
export type SubtaskDTO = {
  id: string; title: string; status: string; priority: string; dueDate: string | null;
  assigneeName: string | null; assignee: UserLite | null;
  clickupManaged: boolean; clickupUrl: string | null;
  linearManaged: boolean; linearUrl: string | null;
};
export type AssigneeRow = { id: string; taskId: string; userId: string; user: UserLite | null; createdAt: string };
export type CollaboratorRow = { id: string; taskId: string; userId: string; user: UserLite | null; createdAt: string };
export type CommentRow = { id: string; taskId: string; userId: string | null; authorName: string | null; body: string; createdAt: string; user: UserLite | null };
export type AttachmentRow = { id: string; taskId: string; fileName: string; filePath: string; mimeType: string | null; fileSize: number | null; uploadedById: string | null; uploadedBy: { id: string; name: string | null } | null; createdAt: string };

export type MeetingTaskDTO = {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  dueDate: string | null;
  createdAt: string;
  completedAt: string | null;
  source: string;
  sortOrder: number;
  meetingId: string | null;
  reportId: string | null;
  departmentId: string | null;
  parentId: string | null;
  orgId: string;
  assigneeId: string | null;
  assigneeName: string | null;
  externalId: string | null;
  externalUrl: string | null;
  externalSync: string | null;
  lastSyncedAt: string | null;
  // ClickUp two-way sync: when clickupManaged, this task is "owned" by ClickUp
  // (an assignee exists there) → the board/report/detail render it read-only with
  // a "Managed in ClickUp" badge + clickupUrl link; status mirrors from ClickUp.
  clickupTaskId: string | null;
  clickupUrl: string | null;
  clickupManaged: boolean;
  // Linear two-way sync — same read-only-mirror semantics as ClickUp above.
  linearIssueId: string | null;
  linearUrl: string | null;
  linearManaged: boolean;
  assignee: UserLite | null;
  meeting: { id: string; title: string; scheduledAt: string | null } | null;
  department: { id: string; name: string; color: string | null } | null;
  parent?: { id: string; title: string } | null;
  collaborators: { userId: string }[] | CollaboratorRow[];
  assignees: { user: UserLite }[] | AssigneeRow[];
  subtasks?: SubtaskDTO[];
  comments?: CommentRow[];
  attachments?: AttachmentRow[];
  /**
   * The task Row's full cell bag (P3.3): `row.data` keyed by Field id, run
   * through `presentRowData` so `totp`/`password` custom-field cells never leak
   * their encrypted secret. Present only on board-facing reads (listTasks /
   * getTaskById / create/update responses). The 6 system fields are also keyed
   * here, but the board renders only CUSTOM fields from it (the fixed ones use
   * their projected DTO props). Pair with `listTaskFields()` for the schema.
   */
  cells?: Record<string, unknown>;
  _count: { subtasks: number; comments: number; attachments: number };
};

/**
 * Client-facing Field metadata for the system Tasks table (P3.3). Structurally
 * compatible with the Database UI's `FieldT` so the board can reuse `FieldCell`
 * to render/edit custom task fields. Returned by `listTaskFields`.
 */
export type TaskFieldDTO = {
  id: string;
  tableId: string;
  name: string;
  type: string;
  options: Prisma.JsonValue | null;
  position: number;
  width: number | null;
};

const STATUS_ORDER: Record<string, number> = { open: 0, in_progress: 1, done: 2 };

// ---- low-level helpers -----------------------------------------------------
type Cells = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const mapUser = (u: { id: string; name: string | null; image?: string | null } | undefined | null): UserLite | null =>
  u ? { id: u.id, name: u.name, image: u.image ?? null } : null;

/** Batch-resolve user lite records (RowAssignment/Collaborator/Comment use soft userIds — no FK relation). */
export async function usersByIds(ids: (string | null | undefined)[]): Promise<Map<string, UserLite>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (!uniq.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true, image: true } });
  return new Map(users.map((u) => [u.id, u as UserLite]));
}

/** The system Tasks table's Field rows (id/type/options) for coerce on writes. */
async function loadFields(tableId: string): Promise<FieldLike[]> {
  return prisma.field.findMany({ where: { tableId }, select: { id: true, type: true, options: true } });
}

/**
 * Merge custom-field cells into a task update patch, REJECTING the reserved ids
 * (the 6 system fields + the assignee field). Those each have exactly one write
 * path — the typed `updateTask` args / `setRowAssignees` — so a `cells` write
 * can never clobber them (and the assignee person cell can't drift from
 * RowAssignment). Mutates and returns `patch`. Pure (no I/O) → unit-testable.
 */
export function applyCustomCells(
  patch: Record<string, unknown>,
  cells: Record<string, unknown> | undefined,
  reservedIds: string[],
): Record<string, unknown> {
  if (!cells) return patch;
  const reserved = new Set(reservedIds);
  for (const [fid, val] of Object.entries(cells)) {
    if (reserved.has(fid)) continue;
    patch[fid] = val;
  }
  return patch;
}

/** Resolve the org's system Tasks scaffold for a READ (null if unprovisioned — never creates). */
async function resolveRead(orgId: string | null | undefined): Promise<SystemTasksProvision | null> {
  return orgId ? getSystemTasksTable(orgId) : null;
}
/** Resolve (provisioning if needed) for a WRITE. */
async function resolveWrite(orgId: string): Promise<SystemTasksProvision> {
  return provisionSystemTasksTable(orgId);
}

/**
 * The system Tasks table's full Field metadata (P3.3) in the client `FieldT`
 * shape, so the board can render/edit CUSTOM task fields with the engine's
 * `FieldCell`. Read-only resolve → `[]` if the org hasn't been provisioned yet.
 */
export async function listTaskFields(session: Session): Promise<TaskFieldDTO[]> {
  const orgId = await getCurrentOrgId(session);
  const prov = await resolveRead(orgId);
  if (!prov) return [];
  const fields = await prisma.field.findMany({
    where: { tableId: prov.table.id },
    select: { id: true, tableId: true, name: true, type: true, options: true, position: true, width: true },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return fields.map((f) => ({ ...f, width: f.width ?? null }));
}

// Shapes Prisma returns when we eager-load a task Row + its relations.
type LoadedRow = {
  id: string;
  data: Prisma.JsonValue;
  position: number;
  createdAt: Date;
  taskMeta: { meetingId: string | null; reportId: string | null; departmentId: string | null; parentRowId: string | null; source: string; completedAt: Date | null; clickupTaskId: string | null; clickupUrl: string | null; clickupStatus: string | null; clickupSyncedAt: Date | null; linearIssueId: string | null; linearUrl: string | null; linearStatus: string | null; linearSyncedAt: Date | null } | null;
  assignments?: { id: string; userId: string; createdAt: Date }[];
  collaborators?: { id: string; userId: string; createdAt: Date }[];
  _count?: { comments: number; attachments: number };
};

const rowInclude = {
  taskMeta: true,
  assignments: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  collaborators: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  _count: { select: { comments: true, attachments: true } },
};

/**
 * Pure projector: Row + relations → MeetingTask-shaped DTO. The lead assignee is
 * the earliest RowAssignment (mirrors the legacy denormalized assigneeId).
 */
function assembleTaskDTO(
  row: LoadedRow,
  f: TaskFieldIds,
  orgId: string,
  users: Map<string, UserLite>,
  extras: {
    meeting?: { id: string; title: string; scheduledAt: Date | null } | null;
    department?: { id: string; name: string; color: string | null } | null;
    parent?: { id: string; title: string } | null;
    subtasks?: SubtaskDTO[];
    subtaskCount?: number;
    comments?: CommentRow[];
    attachments?: AttachmentRow[];
    /** When provided, attach a client-safe `cells` bag (custom-field payoff). */
    fields?: FieldLike[];
    detail?: boolean;
  } = {},
): MeetingTaskDTO {
  const data = (row.data ?? {}) as Cells;
  const meta = row.taskMeta;
  const assignments = row.assignments ?? [];
  const collaborators = row.collaborators ?? [];
  const lead = assignments[0] ? users.get(assignments[0].userId) ?? null : null;

  return {
    id: row.id,
    title: str(data[f.title]) ?? '',
    description: str(data[f.description]),
    status: str(data[f.status]) ?? 'open',
    priority: str(data[f.priority]) ?? 'medium',
    dueDate: str(data[f.dueDate]),
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(meta?.completedAt),
    source: meta?.source ?? 'manual',
    sortOrder: row.position,
    meetingId: meta?.meetingId ?? null,
    reportId: meta?.reportId ?? null,
    departmentId: meta?.departmentId ?? null,
    parentId: meta?.parentRowId ?? null,
    orgId,
    assigneeId: assignments[0]?.userId ?? null,
    assigneeName: lead?.name ?? null,
    externalId: null,
    externalUrl: null,
    externalSync: null,
    lastSyncedAt: null,
    clickupTaskId: meta?.clickupTaskId ?? null,
    clickupUrl: meta?.clickupUrl ?? null,
    clickupManaged: !!meta?.clickupTaskId,
    linearIssueId: meta?.linearIssueId ?? null,
    linearUrl: meta?.linearUrl ?? null,
    linearManaged: !!meta?.linearIssueId,
    assignee: lead,
    meeting: extras.meeting ? { id: extras.meeting.id, title: extras.meeting.title, scheduledAt: iso(extras.meeting.scheduledAt) } : null,
    department: extras.department ?? null,
    parent: extras.parent ?? null,
    collaborators: extras.detail
      ? collaborators.map((c) => ({ id: c.id, taskId: row.id, userId: c.userId, user: users.get(c.userId) ?? null, createdAt: c.createdAt.toISOString() }))
      : collaborators.map((c) => ({ userId: c.userId })),
    assignees: extras.detail
      ? assignments.map((a) => ({ id: a.id, taskId: row.id, userId: a.userId, user: users.get(a.userId) ?? null, createdAt: a.createdAt.toISOString() }))
      : assignments.map((a) => ({ user: users.get(a.userId) ?? { id: a.userId, name: null, image: null } })),
    subtasks: extras.subtasks,
    comments: extras.comments,
    attachments: extras.attachments,
    cells: extras.fields ? presentRowData(data as Record<string, unknown>, extras.fields) : undefined,
    _count: {
      subtasks: extras.subtaskCount ?? 0,
      comments: row._count?.comments ?? 0,
      attachments: row._count?.attachments ?? 0,
    },
  };
}

function buildSubtaskDTO(row: LoadedRow, f: TaskFieldIds, users: Map<string, UserLite>): SubtaskDTO {
  const data = (row.data ?? {}) as Cells;
  const lead = row.assignments?.[0] ? users.get(row.assignments[0].userId) ?? null : null;
  return {
    id: row.id,
    title: str(data[f.title]) ?? '',
    status: str(data[f.status]) ?? 'open',
    priority: str(data[f.priority]) ?? 'medium',
    dueDate: str(data[f.dueDate]),
    assigneeName: lead?.name ?? null,
    assignee: lead,
    clickupManaged: !!row.taskMeta?.clickupTaskId,
    clickupUrl: row.taskMeta?.clickupUrl ?? null,
    linearManaged: !!row.taskMeta?.linearIssueId,
    linearUrl: row.taskMeta?.linearIssueId ? (row.taskMeta?.linearUrl ?? null) : null,
  };
}

// ---- assignee denorm keeper ------------------------------------------------
/**
 * Set a task Row's assignees: rewrite RowAssignment to exactly `userIds` AND the
 * person cell (`Row.data[assignee]`) so the engine grid/kanban person column
 * matches. Lead = userIds[0]; insert in order so [0] gets the earliest createdAt.
 */
export async function setRowAssignees(rowId: string, userIds: string[]): Promise<void> {
  const ids = [...new Set(userIds.filter(Boolean))];
  const row = await prisma.row.findUnique({ where: { id: rowId }, select: { table: { select: { base: { select: { orgId: true } } } } } });
  const orgId = row?.table.base.orgId;
  await prisma.rowAssignment.deleteMany({ where: { rowId, userId: { notIn: ids.length ? ids : [' '] } } });
  for (const userId of ids) {
    await prisma.rowAssignment.upsert({ where: { rowId_userId: { rowId, userId } }, create: { rowId, userId }, update: {} });
  }
  if (orgId) {
    const prov = await getSystemTasksTable(orgId);
    if (prov) {
      const data = ((await prisma.row.findUnique({ where: { id: rowId }, select: { data: true } }))?.data ?? {}) as Cells;
      const next = { ...data };
      if (ids.length) next[prov.fieldIds.assignee] = ids;
      else delete next[prov.fieldIds.assignee];
      await prisma.row.update({ where: { id: rowId }, data: { data: next as Prisma.InputJsonValue } });
    }
  }
}

// ---- reads -----------------------------------------------------------------
export type ListTaskParams = {
  scope?: string; meetingId?: string | null; priority?: string | null; status?: string | null;
  department?: string | null; q?: string | null; parentId?: string | null; includeSubtasks?: boolean;
};

export async function listTasks(session: Session, params: ListTaskParams): Promise<MeetingTaskDTO[]> {
  const orgId = await getCurrentOrgId(session);
  const prov = await resolveRead(orgId);
  if (!prov || !orgId) return [];
  const f = prov.fieldIds;
  const userId = session.user.id;
  const isAdmin = session.user.role === 'admin';

  const and: Prisma.RowWhereInput[] = [{ tableId: prov.table.id }];
  if (params.parentId) and.push({ taskMeta: { is: { parentRowId: params.parentId } } });
  else if (!params.includeSubtasks) and.push({ taskMeta: { is: { parentRowId: null } } });
  if (params.department) and.push({ taskMeta: { is: { departmentId: params.department } } });
  if (params.meetingId) and.push({ taskMeta: { is: { meetingId: params.meetingId } } });

  const scope = params.scope || 'mine';
  if (scope === 'mine') {
    and.push({ assignments: { some: { userId } } });
  } else if (!isAdmin) {
    const myDeptIds = await userDepartmentIds(userId);
    const accessibleMeetings = await prisma.meeting.findMany({
      where: { OR: [{ createdById: userId }, { participants: { some: { userId } } }] },
      select: { id: true },
    });
    const accessibleMeetingIds = accessibleMeetings.map((m) => m.id);
    const deptUserIds = myDeptIds.length
      ? [...new Set((await prisma.departmentMember.findMany({ where: { departmentId: { in: myDeptIds } }, select: { userId: true } })).map((m) => m.userId))]
      : [];
    and.push({
      OR: [
        { assignments: { some: { userId } } },
        { collaborators: { some: { userId } } },
        ...(myDeptIds.length ? [{ taskMeta: { is: { departmentId: { in: myDeptIds } } } }] : []),
        ...(accessibleMeetingIds.length ? [{ taskMeta: { is: { meetingId: { in: accessibleMeetingIds } } } }] : []),
        ...(deptUserIds.length ? [{ assignments: { some: { userId: { in: deptUserIds } } } }] : []),
      ],
    });
  }

  let rows = (await prisma.row.findMany({ where: { AND: and }, include: rowInclude })) as unknown as LoadedRow[];

  // App-side cell filters (status/priority/search), matching the legacy equality/contains.
  if (params.status) rows = rows.filter((r) => ((r.data as Cells)?.[f.status]) === params.status);
  if (params.priority) rows = rows.filter((r) => ((r.data as Cells)?.[f.priority]) === params.priority);
  if (params.q) {
    const q = params.q.toLowerCase();
    rows = rows.filter((r) => {
      const d = r.data as Cells;
      return String(d?.[f.title] ?? '').toLowerCase().includes(q) || String(d?.[f.description] ?? '').toLowerCase().includes(q);
    });
  }

  // Sort: status (open<in_progress<done) then createdAt desc — matches legacy orderBy.
  rows.sort((a, b) => {
    const sa = STATUS_ORDER[String((a.data as Cells)?.[f.status] ?? 'open')] ?? 0;
    const sb = STATUS_ORDER[String((b.data as Cells)?.[f.status] ?? 'open')] ?? 0;
    if (sa !== sb) return sa - sb;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  // Inline subtasks + subtask counts for the top-level rows.
  const topIds = rows.map((r) => r.id);
  const subRows = topIds.length
    ? ((await prisma.row.findMany({
        where: { tableId: prov.table.id, taskMeta: { is: { parentRowId: { in: topIds } } } },
        include: { taskMeta: true, assignments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })) as unknown as LoadedRow[])
    : [];
  const subsByParent = new Map<string, LoadedRow[]>();
  for (const s of subRows) {
    const p = s.taskMeta?.parentRowId;
    if (!p) continue;
    (subsByParent.get(p) ?? subsByParent.set(p, []).get(p)!).push(s);
  }

  // Batch users + meetings + departments.
  const allUserIds = [
    ...rows.flatMap((r) => (r.assignments ?? []).map((a) => a.userId)),
    ...subRows.flatMap((r) => (r.assignments ?? []).map((a) => a.userId)),
  ];
  const users = await usersByIds(allUserIds);
  const meetingIds = [...new Set(rows.map((r) => r.taskMeta?.meetingId).filter((x): x is string => !!x))];
  const deptIds = [...new Set(rows.map((r) => r.taskMeta?.departmentId).filter((x): x is string => !!x))];
  const meetings = meetingIds.length
    ? new Map((await prisma.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, title: true, scheduledAt: true } })).map((m) => [m.id, m]))
    : new Map();
  const depts = deptIds.length
    ? new Map((await prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true, color: true } })).map((d) => [d.id, d]))
    : new Map();
  const flds = await loadFields(prov.table.id);

  return rows.map((r) => {
    const subs = (subsByParent.get(r.id) ?? []).map((s) => buildSubtaskDTO(s, f, users));
    return assembleTaskDTO(r, f, orgId, users, {
      meeting: r.taskMeta?.meetingId ? meetings.get(r.taskMeta.meetingId) ?? null : null,
      department: r.taskMeta?.departmentId ? depts.get(r.taskMeta.departmentId) ?? null : null,
      subtasks: subs,
      subtaskCount: subs.length,
      fields: flds,
    });
  });
}

/** Report action-items: top-level tasks for a meeting, ordered like the legacy include. */
export async function listMeetingTasks(meetingId: string): Promise<MeetingTaskDTO[]> {
  const metas = await prisma.taskRow.findMany({ where: { meetingId, parentRowId: null }, select: { rowId: true } });
  const ids = metas.map((m) => m.rowId);
  if (!ids.length) return [];
  const rows = (await prisma.row.findMany({ where: { id: { in: ids } }, include: { ...rowInclude, table: { select: { base: { select: { orgId: true } } } } }, orderBy: { createdAt: 'asc' } })) as unknown as (LoadedRow & { table: { base: { orgId: string } } })[];
  if (!rows.length) return [];
  const orgId = rows[0].table.base.orgId;
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return [];
  const users = await usersByIds(rows.flatMap((r) => (r.assignments ?? []).map((a) => a.userId)));
  return rows.map((r) => assembleTaskDTO(r, prov.fieldIds, orgId, users));
}

/** Report action-items for emails: top-level task Rows by reportId → {title, lead name}. */
export async function tasksForReport(reportId: string): Promise<{ title: string; assigneeName: string | null }[]> {
  const metas = await prisma.taskRow.findMany({ where: { reportId, parentRowId: null }, select: { rowId: true } });
  const ids = metas.map((m) => m.rowId);
  if (!ids.length) return [];
  const rows = await prisma.row.findMany({
    where: { id: { in: ids } },
    select: {
      data: true,
      assignments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 1, select: { userId: true } },
      table: { select: { base: { select: { orgId: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  if (!rows.length) return [];
  const prov = await getSystemTasksTable(rows[0].table.base.orgId);
  if (!prov) return [];
  const users = await usersByIds(rows.map((r) => r.assignments[0]?.userId));
  return rows.map((r) => ({
    title: str((r.data as Cells)?.[prov.fieldIds.title]) ?? "",
    assigneeName: r.assignments[0] ? users.get(r.assignments[0].userId)?.name ?? null : null,
  }));
}

/** A user's open tasks with a deadline (assignee or collaborator) — for the ICS feed. */
export async function icsTasksForUser(orgId: string, userId: string): Promise<{ id: string; title: string; dueDate: Date; createdAt: Date }[]> {
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return [];
  const f = prov.fieldIds;
  const rows = await prisma.row.findMany({
    where: { tableId: prov.table.id, OR: [{ assignments: { some: { userId } } }, { collaborators: { some: { userId } } }] },
    select: { id: true, data: true, createdAt: true },
  });
  const out: { id: string; title: string; dueDate: Date; createdAt: Date }[] = [];
  for (const r of rows) {
    const d = (r.data ?? {}) as Cells;
    if (d[f.status] === "done") continue;
    const due = typeof d[f.dueDate] === "string" ? (d[f.dueDate] as string) : null;
    if (!due) continue;
    out.push({ id: r.id, title: str(d[f.title]) ?? "", dueDate: new Date(due), createdAt: r.createdAt });
  }
  return out;
}

/** A user's open task titles (assignee) — for the weekly digest. */
export async function digestTaskTitlesForUser(orgId: string, userId: string, take = 25): Promise<{ title: string }[]> {
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return [];
  const f = prov.fieldIds;
  const rows = await prisma.row.findMany({ where: { tableId: prov.table.id, assignments: { some: { userId } } }, select: { data: true } });
  return rows
    .filter((r) => ((r.data as Cells)?.[f.status]) !== "done")
    .map((r) => ({ title: str((r.data as Cells)?.[f.title]) ?? "" }))
    .slice(0, take);
}

/** Count task Rows in an org's system Tasks table (optionally created since a date). */
export async function countTasks(orgId: string | null | undefined, since?: Date): Promise<number> {
  const prov = await resolveRead(orgId);
  if (!prov) return 0;
  return prisma.row.count({ where: { tableId: prov.table.id, ...(since ? { createdAt: { gte: since } } : {}) } });
}

/** The session user's open tasks for the dashboard widget (lead/co-assignee). */
// Severity order for the dashboard's "my tasks" list. A plain string sort put
// low ('l') before medium ('m'), burying the more urgent task; rank by severity
// instead (high first). Unknown/empty priorities sort last.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
function priorityRank(v: unknown): number {
  const r = PRIORITY_RANK[String(v ?? '').toLowerCase()];
  return r === undefined ? 3 : r;
}

export async function myOpenTasks(session: Session, take = 8): Promise<MeetingTaskDTO[]> {
  const orgId = await getCurrentOrgId(session);
  const prov = await resolveRead(orgId);
  if (!prov || !orgId) return [];
  const f = prov.fieldIds;
  const userId = session.user.id;
  let rows = (await prisma.row.findMany({ where: { tableId: prov.table.id, assignments: { some: { userId } } }, include: rowInclude })) as unknown as LoadedRow[];
  rows = rows.filter((r) => ((r.data as Cells)?.[f.status]) !== "done");
  rows.sort((a, b) => {
    const pa = priorityRank((a.data as Cells)?.[f.priority]);
    const pb = priorityRank((b.data as Cells)?.[f.priority]);
    if (pa !== pb) return pa - pb; // high → medium → low (was an alphabetical string sort)
    const da = (a.data as Cells)?.[f.dueDate] as string | undefined;
    const db = (b.data as Cells)?.[f.dueDate] as string | undefined;
    if (da && db && da !== db) return da < db ? -1 : 1;
    if (da && !db) return -1;
    if (!da && db) return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  rows = rows.slice(0, take);
  const users = await usersByIds(rows.flatMap((r) => (r.assignments ?? []).map((a) => a.userId)));
  const meetingIds = [...new Set(rows.map((r) => r.taskMeta?.meetingId).filter((x): x is string => !!x))];
  const meetings = meetingIds.length
    ? new Map((await prisma.meeting.findMany({ where: { id: { in: meetingIds } }, select: { id: true, title: true, scheduledAt: true } })).map((m) => [m.id, m]))
    : new Map();
  return rows.map((r) => assembleTaskDTO(r, f, orgId, users, { meeting: r.taskMeta?.meetingId ? meetings.get(r.taskMeta.meetingId) ?? null : null }));
}

export async function getTaskById(id: string, opts: { detail?: boolean } = {}): Promise<MeetingTaskDTO | null> {
  const detail = !!opts.detail;
  const row = (await prisma.row.findUnique({
    where: { id },
    include: {
      ...rowInclude,
      table: { select: { base: { select: { orgId: true } } } },
      ...(detail
        ? {
            comments: { orderBy: { createdAt: 'asc' as const } },
            attachments: { orderBy: { createdAt: 'desc' as const } },
          }
        : {}),
    },
  })) as unknown as (LoadedRow & {
    table: { base: { orgId: string } };
    comments?: { id: string; userId: string | null; authorName: string | null; body: string; createdAt: Date }[];
    attachments?: { id: string; fileName: string; filePath: string; mimeType: string | null; fileSize: bigint | null; uploadedById: string | null; createdAt: Date }[];
  }) | null;
  if (!row || !row.taskMeta) return null;
  const orgId = row.table.base.orgId;
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return null;
  const f = prov.fieldIds;

  // subtasks (detail only)
  const subRows = detail
    ? ((await prisma.row.findMany({
        where: { taskMeta: { is: { parentRowId: id } } },
        include: { taskMeta: true, assignments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      })) as unknown as LoadedRow[])
    : [];

  const userIds = [
    ...(row.assignments ?? []).map((a) => a.userId),
    ...(row.collaborators ?? []).map((c) => c.userId),
    ...subRows.flatMap((s) => (s.assignments ?? []).map((a) => a.userId)),
    ...(row.comments ?? []).map((c) => c.userId),
    ...(row.attachments ?? []).map((a) => a.uploadedById),
  ];
  const users = await usersByIds(userIds);

  const meeting = row.taskMeta.meetingId
    ? await prisma.meeting.findUnique({ where: { id: row.taskMeta.meetingId }, select: { id: true, title: true, scheduledAt: true } })
    : null;
  const department = row.taskMeta.departmentId
    ? await prisma.department.findUnique({ where: { id: row.taskMeta.departmentId }, select: { id: true, name: true, color: true } })
    : null;
  let parent: { id: string; title: string } | null = null;
  if (row.taskMeta.parentRowId) {
    const p = await prisma.row.findUnique({ where: { id: row.taskMeta.parentRowId }, select: { id: true, data: true } });
    if (p) parent = { id: p.id, title: str((p.data as Cells)?.[f.title]) ?? '' };
  }

  const comments: CommentRow[] | undefined = detail
    ? (row.comments ?? []).map((c) => ({ id: c.id, taskId: id, userId: c.userId, authorName: c.authorName, body: c.body, createdAt: c.createdAt.toISOString(), user: c.userId ? mapUser(users.get(c.userId)) : null }))
    : undefined;
  const attachments: AttachmentRow[] | undefined = detail
    ? (row.attachments ?? []).map((a) => ({ id: a.id, taskId: id, fileName: a.fileName, filePath: a.filePath, mimeType: a.mimeType, fileSize: a.fileSize == null ? null : Number(a.fileSize), uploadedById: a.uploadedById, uploadedBy: a.uploadedById ? (users.get(a.uploadedById) ? { id: a.uploadedById, name: users.get(a.uploadedById)!.name } : { id: a.uploadedById, name: null }) : null, createdAt: a.createdAt.toISOString() }))
    : undefined;

  return assembleTaskDTO(row, f, orgId, users, {
    meeting,
    department,
    parent,
    subtasks: detail ? subRows.map((s) => buildSubtaskDTO(s, f, users)) : undefined,
    subtaskCount: subRows.length,
    comments,
    attachments,
    fields: await loadFields(prov.table.id),
    detail,
  });
}

// ---- writes ----------------------------------------------------------------
export type CreateTaskInput = {
  title: string; description?: string | null; meetingId?: string | null; assigneeId?: string | null;
  assigneeIds?: string[]; priority?: string | null; dueDate?: string | null; departmentId?: string | null; parentId?: string | null;
  /** Custom-field cells to set at creation (P3.3); the 6 system + assignee ids are rejected. */
  cells?: Record<string, unknown>;
};

export async function createTask(session: Session, input: CreateTaskInput): Promise<{ task: MeetingTaskDTO; assignees: string[] } | { error: string; status: number }> {
  const orgId = (session.user as { orgId?: string }).orgId;
  if (!orgId) return { error: 'no_org', status: 403 };
  const prov = await resolveWrite(orgId);
  const f = prov.fieldIds;
  const fields = await loadFields(prov.table.id);

  let resolvedMeetingId = input.meetingId || null;
  let resolvedDeptId = input.departmentId || null;

  if (input.parentId) {
    const parent = await prisma.taskRow.findUnique({ where: { rowId: input.parentId }, select: { meetingId: true, departmentId: true, parentRowId: true } });
    if (!parent) return { error: 'Parent task not found', status: 404 };
    if (parent.parentRowId) return { error: 'Cannot nest subtasks more than one level', status: 400 };
    resolvedMeetingId = parent.meetingId;
    if (!resolvedDeptId) resolvedDeptId = parent.departmentId;
  } else if (resolvedMeetingId) {
    const meeting = await prisma.meeting.findUnique({ where: { id: resolvedMeetingId }, select: { id: true, departmentId: true } });
    if (!meeting) return { error: 'Meeting not found', status: 404 };
    if (!resolvedDeptId) resolvedDeptId = meeting.departmentId;
  }

  const finalAssignees = [...new Set((input.assigneeIds?.length ? input.assigneeIds : input.assigneeId ? [input.assigneeId] : []).filter(Boolean))];
  const cellInput: Cells = {
    [f.title]: input.title,
    [f.description]: input.description ?? undefined,
    [f.status]: 'open',
    [f.priority]: input.priority || 'medium',
    [f.dueDate]: input.dueDate ?? undefined,
    [f.assignee]: finalAssignees,
  };
  // Custom-field cells at creation — same single-write-path guard as updateTask.
  applyCustomCells(cellInput, input.cells, [f.title, f.description, f.status, f.priority, f.dueDate, f.assignee]);
  const data = coerceRowData(fields, cellInput);

  const row = await prisma.$transaction(async (tx) => {
    const r = await tx.row.create({ data: { tableId: prov.table.id, data: data as Prisma.InputJsonValue, position: 0 } });
    await tx.taskRow.create({ data: { rowId: r.id, meetingId: resolvedMeetingId, reportId: null, departmentId: resolvedDeptId, parentRowId: input.parentId || null, source: 'manual', completedAt: null } });
    for (const userId of finalAssignees) await tx.rowAssignment.create({ data: { rowId: r.id, userId } });
    return r;
  });

  const task = await getTaskById(row.id, { detail: false });
  // Outbound webhook (opt-in; fire-and-forget). AI-extracted tasks are intentionally
  // not fired here — they're covered by the report.ready event.
  if (task) void dispatchWebhook('task.created', taskWebhookPayload(task));
  return { task: task!, assignees: finalAssignees };
}

/** Field types the AI is allowed to auto-fill from a transcript. Excludes
 *  person (name→id is the assignee path), date (ambiguous timeframes), and
 *  file/totp/password/link (no transcript-derivable / safe representation). */
export const AI_FILLABLE_TYPES = new Set<string>([
  'text', 'longText', 'number', 'currency', 'percent', 'rating', 'checkbox',
  'url', 'email', 'phone', 'singleSelect', 'multiSelect',
]);

type AiFillField = { id: string; name: string; type: string; options: Prisma.JsonValue | null };

function choiceIdByName(options: Prisma.JsonValue | null, name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  const choices = (options as { choices?: { id?: string; name?: string }[] } | null)?.choices;
  if (!Array.isArray(choices)) return undefined;
  const n = name.trim().toLowerCase();
  return choices.find((c) => c && typeof c.name === 'string' && c.name.trim().toLowerCase() === n)?.id;
}

/**
 * Project an AI-returned per-task `fields` object (keyed by field NAME, values
 * in human terms) → engine cells (keyed by field id, engine shape) for the
 * org's CUSTOM task fields. Only AI-fillable types; singleSelect/multiSelect
 * values are resolved from choice NAME → id; anything unmatched/empty is
 * dropped. `coerceRowData`/`coerceCell` re-validate downstream, so this is a
 * best-effort projector. Pure (no I/O) → unit-testable.
 */
export function aiCellsFromModel(fields: AiFillField[], modelFields: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!modelFields || typeof modelFields !== 'object') return out;
  const m = modelFields as Record<string, unknown>;
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(m)) lower.set(k.trim().toLowerCase(), v);
  const seenName = new Set<string>();
  for (const f of fields) {
    if (!AI_FILLABLE_TYPES.has(f.type)) continue;
    const nameKey = f.name.trim().toLowerCase();
    if (seenName.has(nameKey)) continue; // duplicate field name → first wins, no fan-out into multiple ids
    seenName.add(nameKey);
    // Object.hasOwn (not `in`) so an inherited prototype key can't be pulled in.
    const raw = Object.hasOwn(m, f.name) ? m[f.name] : lower.get(nameKey);
    if (raw == null || raw === '') continue;
    let v: unknown;
    switch (f.type) {
      case 'number': case 'currency': case 'percent': case 'rating': {
        const n = typeof raw === 'number' ? raw : Number(raw);
        v = Number.isFinite(n) ? n : undefined;
        break;
      }
      case 'checkbox':
        v = raw === true || raw === 'true' || raw === 'yes' ? true
          : raw === false || raw === 'false' || raw === 'no' ? false : undefined;
        break;
      case 'singleSelect':
        v = choiceIdByName(f.options, raw);
        break;
      case 'multiSelect': {
        const arr = Array.isArray(raw) ? raw : [raw];
        const ids = arr.map((x) => choiceIdByName(f.options, x)).filter((x): x is string => !!x);
        v = ids.length ? ids : undefined;
        break;
      }
      default: // text | longText | url | email | phone
        v = String(raw);
    }
    if (v !== undefined) out[f.id] = v;
  }
  return out;
}

/**
 * Transactional Row+TaskRow+RowAssignment creator for the AI pipeline. Caller
 * passes the resolved fieldIds + tx; mirrors the cell shapes of createTask.
 */
export async function createTaskFromAI(
  tx: Prisma.TransactionClient,
  args: { tableId: string; fieldIds: TaskFieldIds; fields: FieldLike[]; meetingId: string | null; reportId: string | null; departmentId: string | null; parentRowId: string | null; title: string; description?: string | null; priority?: string | null; dueDate?: Date | string | null; regIds: string[]; cells?: Record<string, unknown> },
): Promise<{ rowId: string }> {
  const f = args.fieldIds;
  const regIds = [...new Set(args.regIds.filter(Boolean))];
  const base: Cells = {
    [f.title]: args.title,
    [f.description]: args.description ?? undefined,
    [f.status]: 'open',
    [f.priority]: args.priority || 'medium',
    [f.dueDate]: args.dueDate ? (args.dueDate instanceof Date ? args.dueDate.toISOString() : args.dueDate) : undefined,
    [f.assignee]: regIds,
  };
  // AI-filled CUSTOM cells (P4.1) — same single-write-path guard: the 6 system +
  // assignee ids are rejected, so the model can never overwrite them.
  applyCustomCells(base, args.cells, [f.title, f.description, f.status, f.priority, f.dueDate, f.assignee]);
  const data = coerceRowData(args.fields, base);
  const r = await tx.row.create({ data: { tableId: args.tableId, data: data as Prisma.InputJsonValue, position: 0 } });
  await tx.taskRow.create({ data: { rowId: r.id, meetingId: args.meetingId, reportId: args.reportId, departmentId: args.departmentId, parentRowId: args.parentRowId, source: 'ai', completedAt: null } });
  for (const userId of regIds) await tx.rowAssignment.create({ data: { rowId: r.id, userId } });
  return { rowId: r.id };
}

export type UpdateTaskFields = {
  title?: string; description?: string | null; status?: string; priority?: string; dueDate?: string | null;
  assigneeId?: string | null; assigneeIds?: string[]; departmentId?: string | null; sortOrder?: number;
  /** Arbitrary CUSTOM-field cells (P3.3), keyed by Field id. The 6 system field
   *  ids + the assignee field id are REJECTED here so each has one write path. */
  cells?: Record<string, unknown>;
};

export async function updateTask(
  taskId: string,
  fields: UpdateTaskFields,
): Promise<{ task: MeetingTaskDTO; before: { status: string | null; dueDate: string | null }; addedAssignees: string[]; statusChanged: boolean; dueChanged: boolean } | null> {
  const row = await prisma.row.findUnique({ where: { id: taskId }, select: { id: true, data: true, table: { select: { id: true, base: { select: { orgId: true } } } } } });
  if (!row) return null;
  const orgId = row.table.base.orgId;
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return null;
  const f = prov.fieldIds;
  const flds = await loadFields(prov.table.id);
  const before = (row.data ?? {}) as Cells;
  const beforeStatus = str(before[f.status]);
  const beforeDue = str(before[f.dueDate]);

  const nextAssignees: string[] | undefined =
    fields.assigneeIds !== undefined ? [...new Set(fields.assigneeIds.filter(Boolean))]
      : fields.assigneeId !== undefined ? (fields.assigneeId ? [fields.assigneeId] : [])
        : undefined;
  const prevAssigneeIds = nextAssignees !== undefined
    ? (await prisma.rowAssignment.findMany({ where: { rowId: taskId }, select: { userId: true } })).map((a) => a.userId)
    : [];

  const patch: Cells = {};
  if (fields.title !== undefined) patch[f.title] = fields.title;
  if (fields.description !== undefined) patch[f.description] = fields.description ?? '';
  if (fields.priority !== undefined) patch[f.priority] = fields.priority;
  if (fields.status !== undefined) patch[f.status] = fields.status;
  if (fields.dueDate !== undefined) patch[f.dueDate] = fields.dueDate ?? '';
  applyCustomCells(patch, fields.cells, [f.title, f.description, f.status, f.priority, f.dueDate, f.assignee]);

  await prisma.$transaction(async (tx) => {
    // Merge under a row lock. `data` is ONE JSON blob keyed by field id, so reading it
    // outside the transaction (as this did) and writing the whole blob back loses a
    // concurrent edit to a DIFFERENT cell — the same last-writer-wins bug already fixed
    // for /api/rows, which never got applied to the task path. SELECT … FOR UPDATE
    // serialises writers so each merge runs against the freshest committed data.
    const locked = await tx.$queryRaw<{ data: unknown }[]>(
      Prisma.sql`SELECT data FROM "Row" WHERE id = ${taskId} FOR UPDATE`,
    );
    const fresh = (locked[0]?.data ?? {}) as Cells;
    const mergedData = mergeRowData(flds, fresh, patch);
    await tx.row.update({
      where: { id: taskId },
      data: { data: mergedData as Prisma.InputJsonValue, ...(fields.sortOrder !== undefined ? { position: fields.sortOrder } : {}) },
    });
    const metaUpdate: Prisma.TaskRowUncheckedUpdateInput = {};
    if (fields.departmentId !== undefined) metaUpdate.departmentId = fields.departmentId || null;
    if (fields.status !== undefined) metaUpdate.completedAt = fields.status === 'done' ? new Date() : null;
    if (Object.keys(metaUpdate).length) await tx.taskRow.update({ where: { rowId: taskId }, data: metaUpdate });
  });

  if (nextAssignees !== undefined) await setRowAssignees(taskId, nextAssignees);

  const addedAssignees = nextAssignees !== undefined ? nextAssignees.filter((u) => !prevAssigneeIds.includes(u)) : [];
  const statusChanged = fields.status !== undefined && fields.status !== beforeStatus;
  const newDue = fields.dueDate !== undefined ? (fields.dueDate || null) : undefined;
  const dueChanged = newDue !== undefined && (newDue ?? null) !== (beforeDue ?? null);

  const task = await getTaskById(taskId, { detail: false });
  // Outbound webhook (opt-in; fire-and-forget).
  if (task) void dispatchWebhook('task.updated', taskWebhookPayload(task));
  return { task: task!, before: { status: beforeStatus, dueDate: beforeDue }, addedAssignees, statusChanged, dueChanged };
}

/** Delete a task Row. Subtasks have NO FK cascade (TaskRow.parentRowId is soft) — delete them explicitly first. */
/**
 * Delete a task Row and its subtask Rows. LOCAL ONLY — never call ClickUp from here.
 *
 * This is not the only delete path: report regeneration wipes every source:'ai' Row of
 * a meeting before rebuilding them (lib/regenerate.ts). If ClickUp propagation lived in
 * this function, a single Regenerate click would hard-delete every mirrored ClickUp task
 * of that meeting — with its comments and time tracking. Propagation therefore belongs
 * to the user-intent HTTP path alone (api/tasks DELETE), and must stay there.
 */
export async function deleteTask(taskId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const subs = await tx.taskRow.findMany({ where: { parentRowId: taskId }, select: { rowId: true } });
    const subIds = subs.map((s) => s.rowId);
    if (subIds.length) await tx.row.deleteMany({ where: { id: { in: subIds } } }); // cascades each sub's TaskRow + Row*
    await tx.row.delete({ where: { id: taskId } }); // cascades this row's TaskRow + Row*
  });
}

/** True if the task Row is "owned" by an external tracker — ClickUp OR Linear (an
 *  assignee exists there). Owned tasks are a read-only mirror in Garely: user
 *  edits/deletes are rejected (they're managed externally; status/deletion flow
 *  back via the webhook). Name kept for back-compat; gate now covers both. */
export async function isClickUpManaged(taskId: string): Promise<boolean> {
  const tr = await prisma.taskRow.findUnique({ where: { rowId: taskId }, select: { clickupTaskId: true, linearIssueId: true } });
  return !!(tr?.clickupTaskId || tr?.linearIssueId);
}

/**
 * Which external tracker owns this task.
 *
 * `isClickUpManaged` above answers "either", which was fine while both trackers were
 * equally undeletable. Deletion is not symmetric: ClickUp copies can now be deleted,
 * Linear issues cannot (lib/linear.ts has no delete call), so a Linear-mirrored task
 * must stay blocked or its issue would be orphaned by a Garely delete.
 */
export async function taskMirrors(rowIds: string[]): Promise<{ clickup: boolean; linear: boolean }> {
  if (!rowIds.length) return { clickup: false, linear: false };
  // Across the WHOLE tree, not just the row the user clicked. deleteTask() removes the
  // subtask rows too, so a mirrored SUBTASK under a local parent would otherwise skip
  // both the Linear block and the narrower delete permission — and its ClickUp copies
  // would be orphaned with the parent reported as un-mirrored.
  const rows = await prisma.taskRow.findMany({
    where: { rowId: { in: rowIds } },
    select: { clickupTaskId: true, linearIssueId: true },
  });
  return {
    clickup: rows.some((r) => !!r.clickupTaskId),
    linear: rows.some((r) => !!r.linearIssueId),
  };
}

/** The task's own row id plus its subtask row ids (nesting is capped at one level). */
export async function taskRowIdsWithSubtasks(taskId: string): Promise<string[]> {
  const subs = await prisma.taskRow.findMany({ where: { parentRowId: taskId }, select: { rowId: true } });
  return [taskId, ...subs.map((s) => s.rowId)];
}

/**
 * Authorize a mutation of a single task (same gate as the legacy route):
 * meeting-tied → meeting access; standalone → admin/lead/userCanViewTask.
 */
export async function authorizeTaskMutation(
  taskId: string,
  userId: string,
  role: string | null | undefined,
): Promise<{ meetingId: string | null; assigneeId: string | null } | { error: string; status: number }> {
  const meta = await prisma.taskRow.findUnique({ where: { rowId: taskId }, select: { meetingId: true } });
  if (!meta) return { error: 'taskNotFound', status: 404 };
  const lead = await prisma.rowAssignment.findFirst({ where: { rowId: taskId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { userId: true } });
  const assigneeId = lead?.userId ?? null;
  if (meta.meetingId) {
    if (!(await userCanAccessMeeting(meta.meetingId, userId, role))) return { error: 'Forbidden', status: 403 };
  } else if (role !== 'admin' && assigneeId !== userId) {
    if (!(await userCanViewTask(taskId, userId, role))) return { error: 'Forbidden', status: 403 };
  }
  return { meetingId: meta.meetingId, assigneeId };
}

// ---- custom task fields (P3.3) ---------------------------------------------
/**
 * Field-schema management for the system Tasks table. The generic /api/fields
 * routes refuse system tables (the 3.2 guard), so these are the ONLY way to add
 * custom columns to tasks — admin-gated at the route, scoped here to the org's
 * own system table (the table id is resolved from orgId, never from the client).
 * Field schema is org-wide and carries NO row-level data, so it adds no
 * task-authz surface. `link` is rejected in v1 (its cross-table reverse pairing
 * would target a hidden system table).
 */
const TASK_FIELD_DENY_TYPES = new Set<string>(['link']);

type TaskFieldRow = { id: string; tableId: string; name: string; type: string; options: Prisma.JsonValue | null; position: number; width: number | null };
const toTaskFieldDTO = (f: TaskFieldRow): TaskFieldDTO => ({ id: f.id, tableId: f.tableId, name: f.name, type: f.type, options: f.options, position: f.position, width: f.width ?? null });
const taskFieldSelect = { id: true, tableId: true, name: true, type: true, options: true, position: true, width: true } as const;

export async function createTaskField(orgId: string, input: { name: string; type: FieldType; options?: unknown }): Promise<{ field: TaskFieldDTO } | { error: string; status: number }> {
  if (TASK_FIELD_DENY_TYPES.has(input.type)) return { error: 'unsupported_field_type', status: 400 };
  const prov = await resolveWrite(orgId);
  const position = await prisma.field.count({ where: { tableId: prov.table.id } });
  const field = await prisma.field.create({
    data: { tableId: prov.table.id, name: input.name, type: input.type, options: normalizeFieldOptions(input.type, input.options), position },
    select: taskFieldSelect,
  });
  return { field: toTaskFieldDTO(field) };
}

/** Resolve a field that MUST belong to the org's system Tasks table AND be a custom (non-system) field. */
async function resolveCustomTaskField(orgId: string, fieldId: string): Promise<{ prov: SystemTasksProvision; field: { type: string; options: Prisma.JsonValue | null } } | { error: string; status: number }> {
  const prov = await getSystemTasksTable(orgId);
  if (!prov) return { error: 'not_found', status: 404 };
  const field = await prisma.field.findUnique({ where: { id: fieldId }, select: { tableId: true, type: true, options: true } });
  if (!field || field.tableId !== prov.table.id) return { error: 'not_found', status: 404 };
  if ((Object.values(prov.fieldIds) as string[]).includes(fieldId)) return { error: 'system_field', status: 403 };
  return { prov, field: { type: field.type, options: field.options } };
}

export async function updateTaskField(orgId: string, fieldId: string, patch: { name?: string; type?: FieldType; options?: unknown; width?: number | null; position?: number }): Promise<{ field: TaskFieldDTO } | { error: string; status: number }> {
  const r = await resolveCustomTaskField(orgId, fieldId);
  if ('error' in r) return r;
  const nextType = (patch.type ?? r.field.type) as FieldType;
  if (TASK_FIELD_DENY_TYPES.has(nextType)) return { error: 'unsupported_field_type', status: 400 };
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.type !== undefined) data.type = patch.type;
  if (patch.position !== undefined) data.position = patch.position;
  if (patch.width !== undefined) data.width = patch.width;
  if (patch.options !== undefined || patch.type !== undefined) {
    const opts = normalizeFieldOptions(nextType, patch.options ?? r.field.options);
    if (opts !== undefined) data.options = opts;
  }
  const field = await prisma.field.update({ where: { id: fieldId }, data, select: taskFieldSelect });
  return { field: toTaskFieldDTO(field) };
}

export async function deleteTaskField(orgId: string, fieldId: string): Promise<{ ok: true } | { error: string; status: number }> {
  const r = await resolveCustomTaskField(orgId, fieldId);
  if ('error' in r) return r;
  await prisma.field.delete({ where: { id: fieldId } });
  return { ok: true };
}
