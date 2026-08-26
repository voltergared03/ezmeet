import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withRoute } from '@/lib/with-route';
import { roomService } from '@/lib/livekit';
import { endRecording } from '@/lib/recording-orchestrator';

// GET /api/cron/cleanup?secret=XXX — periodic state hygiene (e.g. every 30 min).
// Backstops three cases where a webhook was lost or a process died:
//   1. Meetings stuck `live` long past their expected end (room_finished never
//      arrived) → mark ended so they leave the dashboard and enter the archive, AND
//      close the LiveKit room behind them.
//      Marking the row alone was cosmetic and actively misleading: LiveKit only
//      reaps a room once it is EMPTY (empty_timeout), and a forgotten browser tab
//      is a participant — so the room, the transcription agent and the Deepgram
//      bill all carried on while the UI showed the meeting as finished. Closing
//      the room disconnects the stragglers and the agent with them.
//   2. Recordings stuck `processing` for hours (egress crashed mid-recording) →
//      mark failed so the UI can show it instead of hanging.
//   3. RDP audit sessions stuck `active` (the browser's disconnect beacon never
//      landed) → close them so the audit trail has a real end time.
// Purely time-based so it never depends on a live LiveKit/egress API call.

const LIVE_GRACE_MS = 3 * 60 * 60 * 1000;      // 3h past scheduled end
const REC_STUCK_MS = 6 * 60 * 60 * 1000;       // 6h in "processing"
const RDP_SESSION_STALE_MS = 10 * 60 * 1000;   // ~20 missed 30s heartbeats

async function getHandler(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = Date.now();

  // 1. Orphaned live meetings. Compute expected end per-meeting from
  //    (scheduledAt ?? createdAt) + durationMin, then add the grace window.
  const liveMeetings = await prisma.meeting.findMany({
    where: { status: 'live' },
    select: { id: true, scheduledAt: true, createdAt: true, durationMin: true },
  });
  const staleIds = liveMeetings
    .filter((m) => {
      // Never auto-end a meeting whose scheduled start is still in the future — it was
      // opened early by mistake; ending it would wrongly archive a not-yet-happened meeting.
      if (m.scheduledAt && m.scheduledAt.getTime() > now) return false;
      const start = (m.scheduledAt ?? m.createdAt).getTime();
      const expectedEnd = start + (m.durationMin || 60) * 60_000;
      return expectedEnd + LIVE_GRACE_MS < now;
    })
    .map((m) => m.id);

  let endedMeetings = 0;
  let closedRooms = 0;
  if (staleIds.length > 0) {
    const stale = await prisma.meeting.findMany({
      where: { id: { in: staleIds }, status: 'live' },
      select: { id: true, livekitRoom: true, recordings: { where: { status: 'processing' }, select: { egressId: true, sourceType: true, meta: true } } },
    });
    const res = await prisma.meeting.updateMany({
      where: { id: { in: staleIds }, status: 'live' },
      data: { status: 'ended', endedAt: new Date() },
    });
    endedMeetings = res.count;

    for (const m of stale) {
      // Stop the recording first: killing the room out from under a running egress
      // leaves the Recording row stuck in "processing" until case 2 below reaps it
      // six hours later.
      for (const rec of m.recordings) {
        await endRecording(rec).catch((e) => console.error('[cleanup] endRecording failed', m.id, e));
      }
      if (!m.livekitRoom) continue;
      try {
        await roomService.deleteRoom(m.livekitRoom);
        closedRooms++;
      } catch (e) {
        // A room that LiveKit has already reaped throws here — that is the happy
        // case, not an error worth shouting about.
        const msg = (e as Error).message || '';
        if (!/not found|does not exist/i.test(msg)) {
          console.error('[cleanup] deleteRoom failed', m.livekitRoom, msg);
        }
      }
    }
  }

  // 2. Recordings stuck in "processing".
  const failedRecordings = await prisma.recording.updateMany({
    where: { status: 'processing', createdAt: { lt: new Date(now - REC_STUCK_MS) } },
    data: { status: 'failed' },
  });

  // 3. RDP audit sessions stuck "active". /disconnect closes the row, but it is a
  //    best-effort browser beacon — a killed tab or a dropped network never sends it,
  //    leaving the row `active` forever so the trail can't answer "how long was X
  //    connected". Presence is unaffected either way (it keys on heartbeat freshness,
  //    PRESENCE_STALE_MS), so this only repairs the audit row. endedAt is the last
  //    proof of life — the final heartbeat, or startedAt when the session never beat —
  //    NOT `now`, which would invent hours of session time on a long-dead row. Raw SQL
  //    because endedAt is per-row (COALESCE), which updateMany can't express.
  const endedSessions = await prisma.$executeRaw`
    UPDATE "ServerSession"
    SET status = 'ended', "endedAt" = COALESCE("lastSeenAt", "startedAt")
    WHERE status = 'active'
      AND COALESCE("lastSeenAt", "startedAt") < ${new Date(now - RDP_SESSION_STALE_MS)}
  `;

  return NextResponse.json({
    endedMeetings,
    closedRooms,
    failedRecordings: failedRecordings.count,
    endedSessions,
  });
}

export const GET = withRoute('cron.cleanup', getHandler);
