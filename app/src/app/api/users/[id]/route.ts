import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { withRoute } from '@/lib/with-route';

// PATCH /api/users/[id] — update user (role, etc.)
async function patchHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Only admins can change roles
  const currentUser = await prisma.user.findUnique({
    where: { email: session.user.email! },
    select: { id: true, role: true },
  });

  if (!currentUser || currentUser.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  const { id } = await params;
  const body = await req.json();
  const { role, spokenLanguage, spokenLanguageLocked, name, clickupListId } = body;

  const data: any = {};

  // Admin can rename any user.
  if (name !== undefined) {
    const n = String(name).trim().slice(0, 120);
    if (!n) return NextResponse.json({ error: 'Name required' }, { status: 400 });
    data.name = n;
  }

  if (role !== undefined) {
    if (!role || !['admin', 'member', 'viewer'].includes(role)) {
      return NextResponse.json({ error: 'Invalid role' }, { status: 400 });
    }
    // Prevent removing the last admin
    if (role !== 'admin' && currentUser.id === id) {
      const adminCount = await prisma.user.count({ where: { role: 'admin' } });
      if (adminCount <= 1) {
        return NextResponse.json(
          { error: 'Cannot remove the last admin' },
          { status: 400 },
        );
      }
    }
    data.role = role;
  }

  // Admin can force a user's spoken transcription language (or unlock = Auto).
  if (spokenLanguage !== undefined || spokenLanguageLocked !== undefined) {
    const target = await prisma.user.findUnique({ where: { id }, select: { preferences: true } });
    if (!target) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const prefs = (target.preferences as any) || {};
    const next: any = { ...prefs };
    if (spokenLanguageLocked !== undefined) next.spokenLanguageLocked = !!spokenLanguageLocked;
    if (typeof spokenLanguage === 'string' && spokenLanguage.trim()) {
      next.spokenLanguage = spokenLanguage.trim().toLowerCase().slice(0, 8);
    }
    next.spokenLanguageMeta = { source: 'admin', at: new Date().toISOString() };
    data.preferences = next;
  }

  // Admin can pin a user's tasks to one ClickUp list, whatever call they came from.
  // Its own column, NOT `preferences` — that JSON is only merged inside the spoken-language
  // branch above, so a field added there would be dropped unless the languages changed too.
  if (clickupListId !== undefined) {
    data.clickupListId = typeof clickupListId === 'string' && clickupListId.trim()
      ? clickupListId.trim().slice(0, 64)
      : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 });
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, name: true, email: true, role: true, preferences: true },
  });

  return NextResponse.json({
    id: updated.id,
    name: updated.name,
    email: updated.email,
    role: updated.role,
    spokenLanguage: (updated.preferences as any)?.spokenLanguage ?? null,
    spokenLanguageLocked: !!(updated.preferences as any)?.spokenLanguageLocked,
  });
}

// DELETE /api/users/[id] — delete a user (admin only). Created meetings are
// reassigned to the requesting admin so reports survive; optional relations
// (participants, task assignees, transcript speakers) auto-null; accounts/
// sessions/notifications cascade.
async function deleteHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const currentUser = await prisma.user.findUnique({
    where: { email: session.user.email! },
    select: { id: true, role: true },
  });

  if (!currentUser || currentUser.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden: admin only' }, { status: 403 });
  }

  const t = await getTranslations('errors');
  const { id } = await params;

  if (id === currentUser.id) {
    return NextResponse.json({ error: t('cannotDeleteOwnAccount') }, { status: 400 });
  }

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) {
    return NextResponse.json({ error: t('userNotFound') }, { status: 404 });
  }

  if (target.role === 'admin') {
    const adminCount = await prisma.user.count({ where: { role: 'admin' } });
    if (adminCount <= 1) {
      return NextResponse.json({ error: t('cannotDeleteLastAdmin') }, { status: 400 });
    }
  }

  await prisma.$transaction([
    prisma.meeting.updateMany({ where: { createdById: id }, data: { createdById: currentUser.id } }),
    prisma.user.delete({ where: { id } }),
  ]);

  return NextResponse.json({ success: true });
}

export const PATCH = withRoute('users.update', patchHandler);
export const DELETE = withRoute('users.delete', deleteHandler);
