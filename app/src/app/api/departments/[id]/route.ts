import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/api-auth';
import { withRoute } from '@/lib/with-route';
import { jsonError } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.string().trim().max(20).nullish(),
  // '' / null → unmapped (tasks fall back to the Inbox list).
  clickupListId: z.string().trim().max(64).nullish(),
});

// PATCH /api/departments/[id] — admin renames / recolors a department, or points it at
// the ClickUp list its tasks should go to.
export const PATCH = withRoute('departments.update', async (req: NextRequest, ctx: Ctx) => {
  const session = await requireAdmin();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError('invalid_body', 400);

  const data: { name?: string; color?: string | null; clickupListId?: string | null } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.color !== undefined) data.color = parsed.data.color ?? null;
  if (parsed.data.clickupListId !== undefined) data.clickupListId = parsed.data.clickupListId?.trim() || null;
  if (Object.keys(data).length === 0) return jsonError('invalid_body', 400);

  const dept = await prisma.department.update({ where: { id }, data });
  return NextResponse.json(dept);
});

// DELETE /api/departments/[id] — admin deletes a department.
// Tasks/meetings keep existing but lose the department link (onDelete: SetNull);
// memberships cascade away.
export const DELETE = withRoute('departments.delete', async (_req: NextRequest, ctx: Ctx) => {
  const session = await requireAdmin();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  await prisma.department.delete({ where: { id } });
  return NextResponse.json({ ok: true });
});
