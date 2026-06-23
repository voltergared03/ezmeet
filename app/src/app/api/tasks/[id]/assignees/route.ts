import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { withRoute } from "@/lib/with-route";
import { userCanViewTask } from "@/lib/access";
import { jsonError } from "@/lib/http";
import { setRowAssignees, usersByIds, isClickUpManaged } from "@/lib/tasks";
import { notifyTaskAssigned } from "@/lib/task-notify";

// Manage a task's (or subtask's) set of assignees. Tasks are base-engine Rows;
// writes go through setRowAssignees, which keeps RowAssignment + the person cell
// in sync (lead = first id). RowAssignment.userId is a soft ref → resolve users.
type Ctx = { params: Promise<{ id: string }> };
const postSchema = z.object({ userId: z.string().trim().min(1) });

async function listAssignees(rowId: string) {
  const rows = await prisma.rowAssignment.findMany({ where: { rowId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const users = await usersByIds(rows.map((r) => r.userId));
  return rows.map((r) => ({ id: r.id, taskId: rowId, userId: r.userId, createdAt: r.createdAt, user: users.get(r.userId) ?? null }));
}

// GET /api/tasks/[id]/assignees — list (view-gated).
export const GET = withRoute("tasks.assignees.list", async (_req: NextRequest, ctx: Ctx) => {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!(await userCanViewTask(id, session.user.id, session.user.role))) return jsonError("forbidden", 403);
  return NextResponse.json(await listAssignees(id));
});

// POST /api/tasks/[id]/assignees { userId } — add an assignee + notify them.
export const POST = withRoute("tasks.assignees.add", async (req: NextRequest, ctx: Ctx) => {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!(await userCanViewTask(id, session.user.id, session.user.role))) return jsonError("forbidden", 403);

  if (await isClickUpManaged(id)) return jsonError("clickup_managed", 409);
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError("invalid_body", 400);
  const u = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { id: true } });
  if (!u) return jsonError("user_not_found", 404);

  const existing = await prisma.rowAssignment.findMany({ where: { rowId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { userId: true } });
  const ids = existing.map((r) => r.userId);
  if (!ids.includes(parsed.data.userId)) {
    await setRowAssignees(id, [...ids, parsed.data.userId]);
    void notifyTaskAssigned(id, parsed.data.userId, { id: session.user.id, name: session.user.name });
  }
  return NextResponse.json(await listAssignees(id), { status: 201 });
});

// DELETE /api/tasks/[id]/assignees?userId=... — remove an assignee.
export const DELETE = withRoute("tasks.assignees.remove", async (req: NextRequest, ctx: Ctx) => {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!(await userCanViewTask(id, session.user.id, session.user.role))) return jsonError("forbidden", 403);

  if (await isClickUpManaged(id)) return jsonError("clickup_managed", 409);
  const userId = new URL(req.url).searchParams.get("userId");
  if (!userId) return jsonError("userId required", 400);
  const existing = await prisma.rowAssignment.findMany({ where: { rowId: id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { userId: true } });
  await setRowAssignees(id, existing.map((r) => r.userId).filter((x) => x !== userId));
  return NextResponse.json({ ok: true });
});
