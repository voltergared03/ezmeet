import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendMeetingInvite } from '@/lib/meeting-invite';
import { syncMeetingToGoogle } from '@/lib/calendar-sync';
import { generateMeetingSlug } from '@/lib/utils';
import { readConfig, num } from '@/lib/config';
import { getCurrentOrgId, requireCurrentOrgId } from '@/lib/org';
import { isInternalAuthed } from '@/lib/internal-auth';

// GET /api/meetings — list meetings
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  // Internal agent lookup by livekitRoom — requires the shared internal secret.
  const livekitRoom = searchParams.get('livekitRoom');
  if (livekitRoom) {
    if (!isInternalAuthed(req)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const meetings = await prisma.meeting.findMany({
      where: { livekitRoom },
      // transcriptionEnabled is what the STT agent gates on when it joins the room
      // (agent.py get_meeting). Omit it and the agent reads undefined, the gate never
      // fires, and turning transcription off in the form silently does nothing.
      select: { id: true, livekitRoom: true, status: true, title: true, transcriptionEnabled: true },
      take: 1,
    });
    return NextResponse.json(meetings);
  }

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = session.user.id;
  const userRole = session.user.role;

  const status = searchParams.get('status');
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  // Bound the result set so a long-lived workspace can't fetch thousands of
  // meetings (with participants) in one call. Newest first, so the cap keeps the
  // most recent. Callers can raise it with ?limit= up to 500.
  const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '200', 10) || 200, 1), 500);

  const where: any = {};
  if (status) where.status = status;
  if (from || to) {
    where.scheduledAt = {};
    if (from) where.scheduledAt.gte = new Date(from);
    if (to) where.scheduledAt.lte = new Date(to);
  }

  // Regular members can only see meetings they created or participate in
  if (userRole !== 'admin') {
    where.OR = [
      { createdById: userId },
      { participants: { some: { userId: userId } } },
    ];
  }

  // Tenant scope: this org's meetings (+ any not-yet-attributed rows during Phase 1).
  const orgId = await getCurrentOrgId(session);
  if (orgId) where.AND = [...(where.AND || []), { orgId }];

  const meetings = await prisma.meeting.findMany({
    where,
    include: {
      createdBy: { select: { id: true, name: true, email: true, image: true } },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
      reports: { select: { id: true }, take: 1 },
      _count: { select: { transcripts: true, tasks: true } },
    },
    orderBy: { scheduledAt: 'desc' },
    take: limit,
  });

  return NextResponse.json(meetings);
}

// POST /api/meetings — create meeting
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const t = await getTranslations('errors');
  try {
    const body = await req.json();
    const {
      title,
      description,
      scheduledAt,
      durationMin = 60,
      recurrence,
      participants = [],
      transcriptionEnabled,
      aiReportEnabled,
      taskCreationEnabled,
      allowGuests,
      agenda = null,
      departmentId = null,
    } = body;

    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    if (!cleanTitle) {
      return NextResponse.json({ error: t('titleRequired') }, { status: 400 });
    }

    // Apply workspace policy defaults when the client doesn't explicitly set them
    const wsCfg = await readConfig(['WS_LIVE_TRANSCRIPTION', 'WS_AI_SUMMARY', 'WS_GUEST_ACCESS', 'WS_MAX_DURATION_MIN']);
    const effTranscription = transcriptionEnabled ?? (wsCfg.WS_LIVE_TRANSCRIPTION !== 'false');
    const effAiReport = aiReportEnabled ?? (wsCfg.WS_AI_SUMMARY !== 'false');
    // No workspace-level key yet: tasks follow the report unless set per meeting.
    const effTaskCreation = taskCreationEnabled ?? true;
    const effAllowGuests = allowGuests ?? (wsCfg.WS_GUEST_ACCESS !== 'false');
    const maxDur = num(wsCfg, 'WS_MAX_DURATION_MIN') || 240;
    const dur = Math.min(Math.max(parseInt(String(durationMin), 10) || 60, 5), maxDur);
    const safeParticipants = Array.isArray(participants) ? participants : [];

    const roomSlug = generateMeetingSlug();
    const joinToken = generateMeetingSlug();

    const meeting = await prisma.meeting.create({
      data: {
        title: cleanTitle,
        description: description || null,
        createdById: session.user.id,
        scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
        durationMin: dur,
        recurrence:
          recurrence && typeof recurrence === 'object' && recurrence.type
            ? { type: String(recurrence.type), seriesId: recurrence.seriesId || generateMeetingSlug() }
            : undefined,
        livekitRoom: `meet-${roomSlug}`,
        joinToken,
        transcriptionEnabled: effTranscription,
        aiReportEnabled: effAiReport,
        taskCreationEnabled: effTaskCreation,
        allowGuests: effAllowGuests,
        agenda,
        departmentId: typeof departmentId === 'string' && departmentId ? departmentId : null,
        orgId: await requireCurrentOrgId(session),
        participants: {
          create: [
            // Creator as host
            { userId: session.user.id, role: 'host', rsvpStatus: 'accepted' },
            // Other participants
            ...safeParticipants.map((p: { userId?: string; guestEmail?: string; guestName?: string }) => ({
              userId: p.userId || null,
              guestEmail: p.guestEmail || null,
              guestName: p.guestName || null,
              role: 'participant',
            })),
          ],
        },
      },
      include: {
        createdBy: { select: { id: true, name: true, email: true, image: true } },
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
      },
    });

    // Scheduled meeting → email everyone a calendar invite (.ics + add buttons)
    // + mirror it into the creator's Google "Garely" calendar when connected.
    if (meeting.scheduledAt) {
      void sendMeetingInvite(meeting.id, 'invite');
      void syncMeetingToGoogle(meeting.id, 'upsert');
    }

    return NextResponse.json(meeting, { status: 201 });
  } catch (e) {
    console.error('create meeting error:', e);
    return NextResponse.json({ error: t('createMeetingFailed') }, { status: 500 });
  }
}
