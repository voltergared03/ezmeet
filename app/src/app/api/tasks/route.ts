import { NextRequest, NextResponse } from "next/server";
import { getTranslations } from "next-intl/server";
import { requireAuth } from "@/lib/api-auth";
import { userCanViewTask, userCanAccessMeeting } from "@/lib/access";
import { notifyTaskAssigned, notifyTaskUpdated } from "@/lib/task-notify";
import { listTasks, createTask, updateTask, deleteTask, authorizeTaskMutation, listTaskFields, isClickUpManaged, taskMirrors, taskRowIdsWithSubtasks } from "@/lib/tasks";
import { clickUpCopiesForRows, deleteClickUpCopies, purgeClickUpLinksForRows } from "@/lib/clickup";
import { z } from "zod";
import { validateBody } from "@/lib/validate";

const taskCreateSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().nullish(),
  meetingId: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeIds: z.array(z.string()).optional(),
  priority: z.string().nullish(),
  dueDate: z.string().nullish(),
  departmentId: z.string().nullish(),
  parentId: z.string().nullish(),
  // Custom-field cells set at creation (P3.3); the adapter rejects system/assignee ids.
  cells: z.record(z.string(), z.unknown()).optional(),
});

// PATCH accepts ONLY these fields; zod strips everything else, so a client can
// never write meetingId / reportId / source / external* / completedAt directly.
const taskUpdateSchema = z.object({
  taskId: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  description: z.string().nullish(),
  status: z.enum(["open", "in_progress", "done"]).optional(),
  priority: z.string().optional(),
  dueDate: z.string().nullish(),
  assigneeId: z.string().nullish(),
  assigneeIds: z.array(z.string()).optional(),
  departmentId: z.string().nullish(),
  sortOrder: z.number().int().optional(),
  // Custom-field cells (P3.3); the adapter rejects the 6 system/assignee ids.
  cells: z.record(z.string(), z.unknown()).optional(),
});

// GET /api/tasks — list tasks with filters (now base-engine Rows via the adapter).
export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const url = new URL(req.url);
  const tasks = await listTasks(session, {
    scope: url.searchParams.get("scope") || "mine",
    meetingId: url.searchParams.get("meetingId"),
    priority: url.searchParams.get("priority"),
    status: url.searchParams.get("status"),
    department: url.searchParams.get("department"),
    q: url.searchParams.get("q"),
    parentId: url.searchParams.get("parentId"),
    includeSubtasks: !!url.searchParams.get("includeSubtasks"),
  });
  // P3.3: the board passes ?withFields=1 to also get the system Tasks table's
  // Field schema (for rendering CUSTOM columns). Bare callers (dashboard widget,
  // myOpenTasks consumers) still receive a plain array — back-compatible.
  if (url.searchParams.get("withFields")) {
    return NextResponse.json({ tasks, fields: await listTaskFields(session) });
  }
  return NextResponse.json(tasks);
}

// POST /api/tasks — create task manually.
export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const v = await validateBody(req, taskCreateSchema);
  if (!v.ok) return v.response;

  // Subtask: the caller must be able to see the parent (matches legacy gate).
  if (v.data.parentId && !(await userCanViewTask(v.data.parentId, session.user.id, session.user.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Can't add a subtask under a ClickUp-managed parent (read-only mirror in Garely).
  if (v.data.parentId && (await isClickUpManaged(v.data.parentId))) {
    return NextResponse.json({ error: (await getTranslations("errors"))("clickupManaged") }, { status: 409 });
  }
  // meetingId came straight from the body and was only checked for EXISTENCE, so anyone
  // could file a task into a meeting they cannot open: it renders as an action item in
  // that meeting's report, and self-assigning then exposes the meeting's title and time
  // back through GET /api/tasks/[id]. Same gate the parentId path already uses.
  if (v.data.meetingId && !(await userCanAccessMeeting(v.data.meetingId, session.user.id, session.user.role))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const result = await createTask(session, v.data);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.status });

  // Multi-assignee notifications (the set was persisted by the adapter).
  const actor = { id: session.user.id, name: session.user.name };
  for (const uid of result.assignees) if (uid !== session.user.id) void notifyTaskAssigned(result.task.id, uid, actor);

  return NextResponse.json(result.task, { status: 201 });
}

// PATCH /api/tasks — update task (whitelisted fields only).
export async function PATCH(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const t = await getTranslations("errors");
  const v = await validateBody(req, taskUpdateSchema);
  if (!v.ok) return v.response;
  const { taskId, ...fields } = v.data;

  const authz = await authorizeTaskMutation(taskId, session.user.id, session.user.role);
  if ("error" in authz) {
    return NextResponse.json({ error: authz.error === "taskNotFound" ? t("taskNotFound") : authz.error }, { status: authz.status });
  }

  if (await isClickUpManaged(taskId)) return NextResponse.json({ error: t("clickupManaged") }, { status: 409 });

  const result = await updateTask(taskId, fields);
  if (!result) return NextResponse.json({ error: t("taskNotFound") }, { status: 404 });

  // Best-effort task notifications, only on a real change.
  const actor = { id: session.user.id, name: session.user.name };
  for (const uid of result.addedAssignees) if (uid !== session.user.id) void notifyTaskAssigned(taskId, uid, actor);
  if (result.statusChanged || result.dueChanged) {
    void notifyTaskUpdated(
      taskId,
      {
        status: result.statusChanged ? fields.status : undefined,
        dueDate: result.dueChanged ? (fields.dueDate ? new Date(fields.dueDate) : null) : undefined,
      },
      actor,
    );
  }

  return NextResponse.json(result.task);
}

// DELETE /api/tasks — delete task (explicit subtask cascade inside the adapter).
export async function DELETE(req: NextRequest) {
  const session = await requireAuth();
  if (session instanceof Response) return session;

  const t = await getTranslations("errors");
  const { taskId } = await req.json();
  if (!taskId) return NextResponse.json({ error: "taskId required" }, { status: 400 });

  const authz = await authorizeTaskMutation(taskId, session.user.id, session.user.role);
  if ("error" in authz) {
    return NextResponse.json({ error: authz.error === "taskNotFound" ? t("taskNotFound") : authz.error }, { status: authz.status });
  }

  // Linear has no delete path (lib/linear.ts never deletes an issue), so a
  // Linear-mirrored task stays blocked — otherwise the Garely row would vanish and
  // leave the issue orphaned.
  // The whole tree, because deleteTask() takes the subtask rows with the parent.
  const rowIds = await taskRowIdsWithSubtasks(taskId);
  const mirrors = await taskMirrors(rowIds);
  if (mirrors.linear) return NextResponse.json({ error: t("clickupManaged") }, { status: 409 });

  // Deleting a mirrored task destroys work in someone else's ClickUp list, under the
  // admin's API token. Meeting access alone is too broad a key for that (any attendee
  // of a cross-team call would qualify), so narrow it to admin or the task's own lead
  // assignee. Local-only tasks keep the ordinary permission model.
  if (mirrors.clickup) {
    const isAdmin = session.user.role === "admin";
    if (!isAdmin && authz.assigneeId !== session.user.id) {
      return NextResponse.json({ error: t("clickupDeleteForbidden") }, { status: 403 });
    }
  }

  try {
    if (mirrors.clickup) {
      // ClickUp FIRST, and only then the local rows: the reverse order orphans copies
      // in several people's lists with no Garely task left to find them by. Subtasks
      // are swept with the parent because deleteTask() deletes their rows too.
      const copies = await clickUpCopiesForRows(rowIds);
      const { deleted, failed } = await deleteClickUpCopies(copies);
      if (failed.length) {
        console.error("[tasks] ClickUp delete failed for", taskId, failed);
        return NextResponse.json(
          { error: t("clickupDeletePartial", { done: deleted.length, total: copies.length }) },
          { status: 502 },
        );
      }
      // Links are keyed to rows that are about to disappear; drop them here so no link
      // outlives its Row and strands the reconcile sweep.
      await purgeClickUpLinksForRows(rowIds);
    }
    await deleteTask(taskId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[tasks] delete failed", taskId, e);
    return NextResponse.json({ error: t("taskNotFound") }, { status: 404 });
  }
}
