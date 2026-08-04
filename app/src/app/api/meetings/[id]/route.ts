import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendMeetingInvite } from '@/lib/meeting-invite';
import { syncMeetingToGoogle } from '@/lib/calendar-sync';
import { listTasks } from '@/lib/tasks';
import { shouldReopenOnReschedule } from '@/lib/meeting-lifecycle';
import { withRoute } from '@/lib/with-route';

// GET /api/meetings/:id — get single meeting with full details
async function getHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;
  const userRole = session.user.role;

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true, email: true, image: true } },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
      transcripts: {
        orderBy: { startTime: 'asc' },
        include: {
          speaker: { select: { id: true, name: true, image: true } },
        },
      },
      // Report action items are NOT loaded here from the dormant MeetingTask
      // relation — they live in the base-engine task Rows now (Phase 3) and are
      // attached below via listTasks() in the shape the report transform expects.
      reports: {
        orderBy: { generatedAt: 'desc' },
        take: 1,
      },
      tasks: {
        include: {
          assignee: { select: { id: true, name: true, image: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }

  // Non-admin users can only view meetings they created or participate in
  if (userRole !== 'admin') {
    const isCreator = meeting.createdById === userId;
    const isParticipant = meeting.participants.some(
      (p: any) => p.userId === userId
    );
    if (!isCreator && !isParticipant) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
  }

  // Attach the report's action items from the base-engine task Rows (Phase 3),
  // shaped like the old MeetingTask relation so the report transform maps them to
  // actionItems unchanged. The viewer is already access-gated above; scope 'all'
  // returns every action item of this meeting (not just the viewer's own).
  const rep = (meeting as { reports?: { tasks?: unknown }[] }).reports?.[0];
  if (rep) {
    rep.tasks = await listTasks(session, { scope: 'all', meetingId: id, includeSubtasks: false });
  }

  return NextResponse.json(meeting);
}

// PATCH /api/meetings/:id — update meeting
async function patchHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;
  const userRole = session.user.role;

  const existing = await prisma.meeting.findUnique({
    where: { id },
    include: { participants: true },
  });

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const isAdmin = userRole === 'admin';
  const isCreator = existing.createdById === userId;
  if (!isAdmin && !isCreator) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const { participants, ...meetingData } = body;

  // Validate status against the allowed set
  const VALID_STATUS = ['scheduled', 'live', 'ended', 'cancelled'];
  if ('status' in meetingData && !VALID_STATUS.includes(meetingData.status)) {
    const t = await getTranslations('errors');
    return NextResponse.json({ error: t('invalidStatus') }, { status: 400 });
  }

  // Update meeting fields
  const allowedFields: Record<string, any> = {};
  const editable = ['title', 'description', 'scheduledAt', 'durationMin', 'recurrence',
    'transcriptionEnabled', 'aiReportEnabled', 'taskCreationEnabled', 'allowGuests', 'status', 'agenda'];
  for (const key of editable) {
    if (key in meetingData) {
      if (key === 'scheduledAt' && meetingData[key]) {
        allowedFields[key] = new Date(meetingData[key]);
      } else {
        allowedFields[key] = meetingData[key];
      }
    }
  }

  // Re-open a rescheduled meeting. If an already-done meeting (an overdue one
  // that was briefly opened then left → marked `ended`, or a cancelled one) is
  // moved to a FUTURE time, it hasn't happened yet, so it must return to the
  // upcoming state instead of staying "completed". Only when it produced nothing
  // real (no report, no transcript) — a genuine past report is never discarded.
  let reopened = false;
  if (existing.status === 'ended' || existing.status === 'cancelled') {
    const newSched = allowedFields.scheduledAt instanceof Date ? allowedFields.scheduledAt : null;
    const scheduledAtChanged = 'scheduledAt' in meetingData && newSched != null
      && (!existing.scheduledAt || existing.scheduledAt.getTime() !== newSched.getTime());
    const [reportCount, transcriptCount] = await Promise.all([
      prisma.meetingReport.count({ where: { meetingId: id } }),
      prisma.transcriptSegment.count({ where: { meetingId: id } }),
    ]);
    reopened = shouldReopenOnReschedule({
      currentStatus: existing.status,
      statusExplicitlySet: 'status' in meetingData,
      newScheduledAt: newSched,
      scheduledAtChanged,
      hasRealContent: reportCount > 0 || transcriptCount > 0,
    });
    if (reopened) {
      allowedFields.status = 'scheduled';
      allowedFields.endedAt = null;
      allowedFields.reportStatus = null;
      allowedFields.reportError = null;
    }
  }

  const meeting = await prisma.meeting.update({
    where: { id },
    data: allowedFields,
  });

  // A re-opened meeting hasn't happened yet — clear the stale attendance stamps
  // from the brief earlier open so the next real session records joins fresh
  // (participant_joined only stamps joinedAt where it is still null).
  if (reopened) {
    await prisma.meetingParticipant.updateMany({
      where: { meetingId: id },
      data: { joinedAt: null, leftAt: null },
    });
  }

  // Update participants if provided
  if (Array.isArray(participants)) {
    // Get current non-host participants
    const currentNonHost = existing.participants.filter((p: any) => p.role !== 'host');
    const currentHostIds = existing.participants.filter((p: any) => p.role === 'host').map((p: any) => p.userId);

    // New participant user IDs (excluding host)
    const newParticipantIds = participants
      .map((p: any) => p.userId)
      .filter((uid: string) => uid && !currentHostIds.includes(uid));

    // Remove participants that are no longer in the list
    const toRemove = currentNonHost.filter(
      (p: any) => p.userId && !newParticipantIds.includes(p.userId)
    );
    if (toRemove.length > 0) {
      await prisma.meetingParticipant.deleteMany({
        where: { id: { in: toRemove.map((p: any) => p.id) } },
      });
    }

    // Add new participants
    const existingUserIds = currentNonHost.map((p: any) => p.userId).filter(Boolean);
    const toAdd = newParticipantIds.filter((uid: string) => !existingUserIds.includes(uid));
    if (toAdd.length > 0) {
      await prisma.meetingParticipant.createMany({
        data: toAdd.map((uid: string) => ({
          meetingId: id,
          userId: uid,
          role: 'participant',
        })),
      });
    }
  }

  // Return updated meeting with participants
  const updated = await prisma.meeting.findUnique({
    where: { id },
    include: {
      createdBy: { select: { id: true, name: true, email: true, image: true } },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  });

  // Calendar invite: newly scheduled → invite; otherwise an update on a real change.
  const wasScheduled = !!existing.scheduledAt;
  const nowScheduled = !!updated?.scheduledAt;
  if (nowScheduled && !wasScheduled) {
    void sendMeetingInvite(id, 'invite');
  } else if (nowScheduled && updated) {
    const timeChanged = +new Date(existing.scheduledAt as Date) !== +new Date(updated.scheduledAt as Date);
    const changed = timeChanged
      || existing.durationMin !== updated.durationMin
      || existing.title !== updated.title
      || updated.participants.length > existing.participants.length;
    if (changed) void sendMeetingInvite(id, 'update');
  }

  // Reflect the change into the creator's Google "Garely" calendar (no-op when
  // not connected; cancellation deletes the event there).
  void syncMeetingToGoogle(id, 'upsert');

  return NextResponse.json(updated);
}

// DELETE /api/meetings/:id — delete meeting
async function deleteHandler(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const userId = session.user.id;
  const userRole = session.user.role;

  const meeting = await prisma.meeting.findUnique({ where: { id } });
  if (!meeting) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const isAdmin = userRole === 'admin';
  const isCreator = meeting.createdById === userId;
  if (!isAdmin && !isCreator) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Don't allow deleting live meetings
  if (meeting.status === 'live') {
    return NextResponse.json({ error: 'Cannot delete a live meeting' }, { status: 400 });
  }

  // Keep any meeting that has a recording — a recording lives on its meeting (cascade),
  // so deleting the meeting makes the recording vanish from the report. This is what made
  // quick-meeting recordings disappear. The recording must be deleted explicitly first.
  const recCount = await prisma.recording.count({
    where: { meetingId: id, status: { in: ['processing', 'ready'] } },
  });
  if (recCount > 0) {
    const t = await getTranslations('errors');
    return NextResponse.json({ error: t('meetingHasRecording') }, { status: 409 });
  }

  // Tell attendees it's cancelled before the participant rows cascade away,
  // and remove the linked Google event while the row (externalId) still exists.
  await sendMeetingInvite(id, 'cancel').catch(() => {});
  await syncMeetingToGoogle(id, 'delete').catch(() => {});
  await prisma.meeting.delete({ where: { id } });

  return NextResponse.json({ success: true });
}

export const GET = withRoute('meetings.get', getHandler);
export const PATCH = withRoute('meetings.update', patchHandler);
export const DELETE = withRoute('meetings.delete', deleteHandler);
