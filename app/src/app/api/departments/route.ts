import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireAuth, requireAdmin } from '@/lib/api-auth';
import { getCurrentOrgId, requireCurrentOrgId } from '@/lib/org';
import { withRoute } from '@/lib/with-route';
import { jsonError } from '@/lib/http';

// GET /api/departments — list departments the caller can see.
// Admins see every department; members see only the ones they belong to
// (keeps the org structure private between teams).
export const GET = withRoute('departments.list', async () => {
  const session = await requireAuth();
  if (session instanceof Response) return session;
  const isAdmin = session.user.role === 'admin';
  const where: any = isAdmin ? {} : { members: { some: { userId: session.user.id } } };
  const orgId = await getCurrentOrgId(session);
  if (orgId) where.orgId = orgId;

  const depts = await prisma.department.findMany({
    where,
    orderBy: { name: 'asc' },
    include: {
      members: {
        include: { user: { select: { id: true, name: true, email: true, image: true } } },
      },
      _count: { select: { tasks: true, meetings: true } },
    },
  });

  return NextResponse.json(
    depts.map((d) => ({
      id: d.id,
      name: d.name,
      color: d.color,
      teableBaseId: d.teableBaseId,
      // Admin-only: which ClickUp list this department pushes to is integration
      // plumbing, and members can see this route for their own departments.
      ...(isAdmin ? { clickupListId: d.clickupListId } : {}),
      taskCount: d._count.tasks,
      meetingCount: d._count.meetings,
      members: d.members.map((m) => ({
        userId: m.userId,
        isLead: m.isLead,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
      })),
    })),
  );
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().trim().max(20).nullish(),
});

// POST /api/departments — admin creates a department.
export const POST = withRoute('departments.create', async (req: NextRequest) => {
  const session = await requireAdmin();
  if (session instanceof Response) return session;
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return jsonError('invalid_body', 400);

  const dept = await prisma.department.create({
    data: { name: parsed.data.name, color: parsed.data.color ?? null, orgId: await requireCurrentOrgId(session) },
  });
  return NextResponse.json(dept, { status: 201 });
});
