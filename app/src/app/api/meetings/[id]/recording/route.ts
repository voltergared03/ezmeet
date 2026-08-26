import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { promises as fs } from 'fs';
import { userCanAccessMeeting } from '@/lib/access';
import { withRoute } from '@/lib/with-route';
import { beginRecording, endRecording } from '@/lib/recording-orchestrator';

const RETENTION_DAYS = 7;

function serialize(rec: any) {
  return {
    id: rec.id,
    fileName: rec.fileName,
    fileSize: rec.fileSize != null ? Number(rec.fileSize) : null,
    durationSec: rec.durationSec ?? null,
    status: rec.status,
    permanent: rec.permanent,
    expiresAt: rec.expiresAt ? rec.expiresAt.toISOString() : null,
    createdAt: rec.createdAt.toISOString(),
    url: `/api/recordings/${rec.id}/file`,
  };
}

// PATCH/DELETE are destructive (keep-forever defeats retention; delete removes
// the file for everyone), so they require an admin or the meeting creator — not
// every participant. GET/stream stays at participant level.
async function requireMeetingOwner(
  meetingId: string,
  userId: string,
  role: string | null | undefined,
): Promise<Response | null> {
  if (role === 'admin') return null;
  const m = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { createdById: true },
  });
  if (!m || m.createdById !== userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  return null;
}

// GET — the meeting's latest recording in WHATEVER state it is in (or null).
//
// This used to filter to status: 'ready', which made a failed recording invisible:
// the row said "failed", the endpoint returned null, and the page rendered exactly
// what it renders for a meeting nobody recorded. On 2026-08-26 that is how a lost
// 52-minute recording went unnoticed for hours. A failure the user cannot see is a
// failure they cannot act on, so the state now travels to the client and the page
// decides what to say about it.
async function getHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!(await userCanAccessMeeting(id, session.user.id, session.user.role))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const rec = await prisma.recording.findFirst({
    where: { meetingId: id },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ recording: rec ? serialize(rec) : null });
}

// PATCH — { permanent: boolean } → keep forever (no expiry) or reset 7-day expiry
async function patchHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const forbidden = await requireMeetingOwner(id, session.user.id, session.user.role);
  if (forbidden) return forbidden;
  const body = await req.json().catch(() => ({} as any));
  const permanent = !!body.permanent;

  const t = await getTranslations('errors');
  const rec = await prisma.recording.findFirst({ where: { meetingId: id }, orderBy: { createdAt: 'desc' } });
  if (!rec) return NextResponse.json({ error: t('recordingNotFound') }, { status: 404 });

  const expiresAt = permanent ? null : new Date(Date.now() + RETENTION_DAYS * 86400000);
  const updated = await prisma.recording.update({
    where: { id: rec.id },
    data: { permanent, expiresAt },
  });
  return NextResponse.json({ recording: serialize(updated) });
}

// DELETE — remove the recording file + row (admin or meeting creator only)
async function deleteHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const forbidden = await requireMeetingOwner(id, session.user.id, session.user.role);
  if (forbidden) return forbidden;

  const t = await getTranslations('errors');
  const rec = await prisma.recording.findFirst({ where: { meetingId: id }, orderBy: { createdAt: 'desc' } });
  if (!rec) return NextResponse.json({ error: t('recordingNotFound') }, { status: 404 });

  if (rec.filePath) await fs.unlink(rec.filePath).catch(() => {});
  await prisma.recording.delete({ where: { id: rec.id } });
  return NextResponse.json({ success: true });
}

// POST — { action: 'start' | 'stop' } → on-demand recording, toggled from inside
// the meeting (admin or creator only). Each start spawns a fresh egress → its own
// Recording row/file; stop ends the current one. Idempotent on both ends.
async function postHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  const forbidden = await requireMeetingOwner(id, session.user.id, session.user.role);
  if (forbidden) return forbidden;

  const t = await getTranslations('errors');
  const body = await req.json().catch(() => ({} as any));
  const action = body.action;

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { livekitRoom: true },
  });
  if (!meeting?.livekitRoom) {
    return NextResponse.json({ error: t('meetingNotFound') }, { status: 404 });
  }

  // "Active" = an egress currently in progress for this meeting.
  const active = await prisma.recording.findFirst({
    where: { meetingId: id, status: 'processing' },
    orderBy: { createdAt: 'desc' },
  });

  if (action === 'start') {
    if (active) return NextResponse.json({ ok: true, active: true }); // already recording
    const ok = await beginRecording(id, meeting.livekitRoom);
    if (!ok) return NextResponse.json({ error: t('recordingStartFailed') }, { status: 502 });
    return NextResponse.json({ ok: true, active: true });
  }

  if (action === 'stop') {
    if (!active) return NextResponse.json({ ok: true, active: false }); // nothing to stop
    await endRecording(active);
    return NextResponse.json({ ok: true, active: false });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}

export const GET = withRoute('meetings.recording.get', getHandler);
export const POST = withRoute('meetings.recording.control', postHandler);
export const PATCH = withRoute('meetings.recording.update', patchHandler);
export const DELETE = withRoute('meetings.recording.delete', deleteHandler);
