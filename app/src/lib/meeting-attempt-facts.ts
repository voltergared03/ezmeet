import { prisma } from './prisma';
import { endRecording } from './recording-orchestrator';
import { classifyAttempt, RECORDING_MIN_SEC, type AttemptFacts, type Verdict } from './meeting-attempt';

/** Gather everything classifyAttempt needs. Scoped to the CURRENT attempt via startedAt. */
export async function collectAttemptFacts(meetingId: string): Promise<AttemptFacts> {
  const m = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { startedAt: true, endedAt: true, heldConfirmedAt: true },
  });
  if (!m) {
    // Unknown meeting: never judge it. classifyAttempt turns this into 'held'.
    return { heldConfirmedAt: null, sessionSec: null, spokenChars: 0, hasSpeakerTrack: false, hasRecording: false, recordingSec: null };
  }

  const [segments, speakerTracks, recording] = await Promise.all([
    prisma.transcriptSegment.findMany({ where: { meetingId }, select: { content: true } }),
    prisma.speakerTrack.count({ where: { meetingId } }),
    prisma.recording.findFirst({
      where: {
        meetingId,
        status: { in: ['processing', 'ready'] },
        // Attempt-scoped: a recording from an EARLIER attempt must not vouch for this one.
        ...(m.startedAt ? { createdAt: { gte: m.startedAt } } : {}),
      },
      select: { durationSec: true },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return {
    heldConfirmedAt: m.heldConfirmedAt,
    sessionSec: m.startedAt ? Math.max(0, Math.round((((m.endedAt ?? new Date()).getTime()) - m.startedAt.getTime()) / 1000)) : null,
    spokenChars: segments.reduce((n, s) => n + (s.content?.length || 0), 0),
    hasSpeakerTrack: speakerTracks > 0,
    hasRecording: !!recording,
    recordingSec: recording?.durationSec ?? null,
  };
}

export async function classifyMeetingAttempt(meetingId: string): Promise<{ verdict: Verdict; reason: string }> {
  return classifyAttempt(await collectAttemptFacts(meetingId));
}

/**
 * Stop and mark aside any recording this abandoned attempt started.
 *
 * Marked `discarded`, never `failed` (which the UI shows as an error) and never
 * hard-deleted inline. This also un-blocks the real meeting: the auto-record dedup
 * guard only looks for `processing|ready`, so without this a junk 40-second recording
 * would silently stop the actual meeting from being recorded later in the same row.
 */
export async function discardAttemptRecordings(meetingId: string, startedAt: Date | null): Promise<number> {
  const recs = await prisma.recording.findMany({
    where: {
      meetingId,
      status: { in: ['processing', 'ready'] },
      ...(startedAt ? { createdAt: { gte: startedAt } } : {}),
    },
    select: { id: true, status: true, egressId: true, sourceType: true, meta: true, durationSec: true },
  });
  let discarded = 0;
  for (const r of recs) {
    if (r.status === 'processing') {
      await endRecording({ egressId: r.egressId, sourceType: r.sourceType, meta: r.meta }).catch(() => {});
    }
    if (r.status === 'processing' || (r.durationSec ?? 0) < RECORDING_MIN_SEC) {
      await prisma.recording.update({
        where: { id: r.id },
        // Let the existing retention sweep collect the file rather than deleting here.
        data: { status: 'discarded', expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) },
      }).catch(() => {});
      discarded++;
    }
  }
  return discarded;
}
