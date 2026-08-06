import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { userCanAccessMeeting } from '@/lib/access';
import { createLivekitToken, createRoom } from '@/lib/livekit';
import { generateMeetingSlug } from '@/lib/utils';
import { readConfig } from '@/lib/config';
import { requireCurrentOrgId } from '@/lib/org';

// POST /api/meetings/:id/join-token — get LiveKit JWT to join meeting
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = await auth();
    const body = await req.json().catch(() => ({}));
    const t = await getTranslations('errors');

    let meeting: any;

    if (id === 'quick') {
      if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const roomName = `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const joinSlug = generateMeetingSlug();
      meeting = await prisma.meeting.create({
        data: {
          title: t('quickMeetingTitle'),
          createdById: session.user.id,
          livekitRoom: roomName,
          joinToken: joinSlug,
          status: 'live',
          startedAt: new Date(), // quick meetings are born live — stamp the attempt now
          scheduledAt: new Date(),
          durationMin: 60,
          orgId: await requireCurrentOrgId(session),
        },
      });
    } else {
      meeting = await prisma.meeting.findUnique({
        where: { id },
        select: { id: true, title: true, description: true, agenda: true, livekitRoom: true, joinToken: true, status: true, allowGuests: true, createdById: true, scheduledAt: true, recurrence: true },
      });
    }

    if (!meeting) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }

    // A finished or cancelled occurrence is NOT joinable — re-entering would
    // resurrect a dead LiveKit room (and split colleagues across the live one).
    // For a recurring series, point the caller at the next live/upcoming
    // occurrence (which now holds the migrated joinToken) so they land together.
    if (id !== 'quick' && (meeting.status === 'ended' || meeting.status === 'cancelled')) {
      let nextToken: string | null = null;
      const seriesId = (meeting.recurrence as { seriesId?: string } | null)?.seriesId;
      if (seriesId) {
        const next = await prisma.meeting.findFirst({
          where: {
            id: { not: meeting.id },
            status: { in: ['scheduled', 'live'] },
            recurrence: { path: ['seriesId'], equals: seriesId },
          },
          orderBy: { scheduledAt: 'asc' },
          select: { joinToken: true },
        }).catch(() => null);
        nextToken = next?.joinToken ?? null;
      }
      return NextResponse.json(
        { error: t('meetingEnded'), ended: true, nextToken },
        { status: 410 },
      );
    }

    // Entry time gate: a still-scheduled meeting opens 5 minutes before its start.
    // Before that, only the host/admin may START it explicitly (body.startNow). This
    // stops an early visitor from flipping a FUTURE meeting to 'live' — once live, an
    // empty room's room_finished webhook ends it, which wrongly drops it into the archive.
    if (id !== 'quick' && meeting.status === 'scheduled' && meeting.scheduledAt) {
      const opensAtMs = new Date(meeting.scheduledAt).getTime() - 5 * 60_000;
      if (Date.now() < opensAtMs) {
        const hostOrAdmin = !!session?.user &&
          (meeting.createdById === session.user.id || session.user.role === 'admin');
        if (!(hostOrAdmin && body.startNow === true)) {
          return NextResponse.json(
            { error: t('meetingNotStarted'), tooEarly: true, canStart: hostOrAdmin, scheduledAt: meeting.scheduledAt },
            { status: 403 },
          );
        }
      }
    }

    if (meeting.status === 'scheduled') {
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: { status: 'live', ...(meeting.startedAt ? {} : { startedAt: new Date() }) },
      }).catch(() => {});
    }

    if (!meeting.livekitRoom) {
      // Deterministic name (NOT Date.now()) so two people clicking "join" in the
      // same second on a legacy room can't race into two different LiveKit rooms.
      const roomName = `meet-${meeting.id}`;
      meeting = await prisma.meeting.update({
        where: { id: meeting.id },
        data: { livekitRoom: roomName, status: 'live', ...(meeting.startedAt ? {} : { startedAt: new Date() }) },
      });
    }

    let participantName: string;
    let participantId: string;
    let isHost = false;
    let isAdmin = false;
    // Per-speaker transcription language, embedded in the LiveKit token metadata
    // so the agent starts this participant's STT in the right language.
    let metadata: Record<string, unknown> | undefined;

    if (session?.user) {
      participantName = session.user.name || 'User';
      participantId = session.user.id;
      isHost = meeting.createdById === participantId || id === 'quick';
      isAdmin = session.user.role === 'admin';
      // A private meeting (guests disabled) is not open to just any signed-in member:
      // being logged in is not the same as being invited. This mirrors the invite route
      // (join/[token]) — an open meeting (allowGuests !== false, the default) stays
      // joinable by anyone with the link, which is how invites are meant to work.
      if (id !== 'quick' && !isHost && !isAdmin && meeting.allowGuests === false) {
        const ok = await userCanAccessMeeting(meeting.id, participantId, session.user.role);
        if (!ok) {
          return NextResponse.json({ error: 'You do not have access to this meeting' }, { status: 403 });
        }
      }
      // Learned spokenLanguage wins; otherwise the user's UI language is a prior
      // (helps Deepgram break the uk↔ru tie). Guests have neither → agent uses
      // the workspace default (WS_LANGUAGE).
      const u = await prisma.user.findUnique({
        where: { id: participantId },
        select: { preferences: true },
      });
      const prefs = (u?.preferences as any) || {};
      const lang = prefs.spokenLanguage || prefs.language;
      if (typeof lang === 'string' && lang.trim()) metadata = { lang: lang.trim() };
    } else if (body.guestName) {
      if (meeting.allowGuests === false) {
        return NextResponse.json({ error: 'This meeting does not allow guests' }, { status: 403 });
      }
      // Waiting room: guests must be approved by a participant before joining
      const reqId = body.requestId as string | undefined;
      if (reqId) {
        const jr = await prisma.joinRequest.findUnique({ where: { id: reqId } });
        if (!jr || jr.meetingId !== meeting.id) {
          return NextResponse.json({ error: t('joinRequestNotFound') }, { status: 404 });
        }
        if (jr.status === 'denied') {
          return NextResponse.json({ denied: true }, { status: 403 });
        }
        if (jr.status !== 'approved') {
          return NextResponse.json({ pending: true, requestId: jr.id }, { status: 202 });
        }
        participantName = jr.guestName;
        participantId = `guest-${jr.id.slice(0, 8)}`;
      } else {
        const jr = await prisma.joinRequest.create({
          data: { meetingId: meeting.id, guestName: body.guestName, status: 'pending' },
        });
        return NextResponse.json({ pending: true, requestId: jr.id }, { status: 202 });
      }
    } else {
      return NextResponse.json({ error: 'Unauthorized — please provide a guest name or sign in' }, { status: 401 });
    }

    // Ensure LiveKit room exists (lazy creation) with workspace participant limit
    const wsLimit = await readConfig(['WS_MAX_PARTICIPANTS']);
    const maxP = parseInt(wsLimit.WS_MAX_PARTICIPANTS || '20', 10) || 20;
    await createRoom(meeting.livekitRoom, maxP);

    const token = await createLivekitToken(
      meeting.livekitRoom,
      participantName,
      participantId,
      isHost || isAdmin,
      metadata
    );

    const wsUrl = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';

    // Initial recording state for joiners — the in-room toggle keeps everyone in
    // sync afterwards via the 'recording' data channel.
    const activeRec = await prisma.recording.findFirst({
      where: { meetingId: meeting.id, status: 'processing' },
      select: { id: true },
    });

    return NextResponse.json({
      token,
      wsUrl,
      roomName: meeting.livekitRoom,
      meetingId: meeting.id,
      joinToken: meeting.joinToken || null,
      isHost,
      isAdmin,
      canKick: isHost || isAdmin,
      recordingActive: !!activeRec,
      // Meeting briefing — lets participants review the description + agenda
      // ("питання") right inside the call via the Agenda side-panel.
      title: meeting.title ?? null,
      description: meeting.description ?? null,
      agenda: Array.isArray(meeting.agenda) ? meeting.agenda : null,
    });
  } catch (error: any) {
    console.error('Join token error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
