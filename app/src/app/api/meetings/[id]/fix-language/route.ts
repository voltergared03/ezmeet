import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { transcribeSpeakerFile, regenerateMeetingReport } from '@/lib/regenerate';

// Re-transcription + LLM regeneration can take a while.
export const maxDuration = 300;

// POST /api/meetings/:id/fix-language — re-transcribe one speaker's audio track
// in a corrected language, replace that speaker's transcript segments, regenerate
// the report, and remember the language on the (known) user. Host/admin only.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params;
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { id: true, createdById: true },
  });
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }
  const isAdmin = session.user.role === 'admin';
  const isHost = meeting.createdById === session.user.id;
  if (!isAdmin && !isHost) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const trackId = String(body.trackId || '');
  const language = String(body.language || '').trim().toLowerCase();
  if (!trackId || !language) {
    return NextResponse.json({ error: 'trackId and language required' }, { status: 400 });
  }

  const track = await prisma.speakerTrack.findUnique({ where: { id: trackId } });
  if (!track || track.meetingId !== meetingId) {
    return NextResponse.json({ error: 'Speaker track not found' }, { status: 404 });
  }

  // 1) Re-transcribe the speaker's audio in the corrected language.
  let segments;
  try {
    segments = await transcribeSpeakerFile(track.filePath, language);
  } catch (e: any) {
    return NextResponse.json(
      { error: `Re-transcription failed: ${e?.message || 'unknown error'}` },
      { status: 502 }
    );
  }
  if (segments.length === 0) {
    return NextResponse.json({ error: 'No speech recognized in that language' }, { status: 422 });
  }

  // 2) Replace just this speaker's transcript segments.
  const where: any = track.speakerId
    ? { meetingId, speakerId: track.speakerId }
    : { meetingId, speakerId: null, speakerName: track.speakerName };

  // Re-transcription returns times relative to THIS speaker's own WAV (zero = stream open),
  // but stored startTime is the meeting-global clock (all speakers share one zero). Writing
  // the raw WAV-relative times would drop this speaker to ~0 and scramble transcript order.
  // So preserve the speaker's position: shift the new times so their earliest lands where the
  // speaker's earliest segment already was, and rebuild the absolute epochs from the same anchor.
  const existing = await prisma.transcriptSegment.findMany({
    where,
    select: { startTime: true, startEpochMs: true },
    orderBy: { startTime: 'asc' },
  });
  const base = existing.length ? existing[0].startTime : 0; // speaker's meeting-global start
  const newMin = Math.min(...segments.map((s) => s.start));
  const shift = base - newMin;
  // WALL0 (agent connect epoch, ms) recovered from any epoch-bearing old row: it's constant
  // across a meeting, so startEpochMs - startTime*1000 yields it. Null on old meetings.
  const anchorRow = existing.find((r) => r.startEpochMs != null);
  const wall0ms = anchorRow ? (anchorRow.startEpochMs as number) - anchorRow.startTime * 1000 : null;

  await prisma.$transaction([
    prisma.transcriptSegment.deleteMany({ where }),
    prisma.transcriptSegment.createMany({
      data: segments.map((s) => {
        const st = s.start + shift;
        const en = s.end + shift;
        return {
          meetingId,
          speakerId: track.speakerId || null,
          speakerName: track.speakerName || null,
          content: s.content,
          language,
          startTime: st,
          endTime: en,
          startEpochMs: wall0ms != null ? wall0ms + st * 1000 : null,
          endEpochMs: wall0ms != null ? wall0ms + en * 1000 : null,
          confidence: s.confidence,
          isFinal: true,
        };
      }),
    }),
    prisma.speakerTrack.update({ where: { id: trackId }, data: { detectedLanguage: language } }),
  ]);

  // 3) Regenerate the report from the corrected full transcript.
  let warning: string | undefined;
  try {
    await regenerateMeetingReport(meetingId);
  } catch (e: any) {
    warning = `Segments updated, but report regeneration failed: ${e?.message || 'unknown error'}`;
  }

  // 4) Remember the corrected language on the user (manual = strong signal).
  if (track.speakerId) {
    try {
      const u = await prisma.user.findUnique({
        where: { id: track.speakerId },
        select: { preferences: true },
      });
      if (u) {
        const prefs = (u.preferences as any) || {};
        // Don't override a language the user has explicitly forced in Settings.
        if (!prefs.spokenLanguageLocked) {
          await prisma.user.update({
            where: { id: track.speakerId },
            data: {
              preferences: {
                ...prefs,
                spokenLanguage: language,
                spokenLanguageMeta: { confidence: 1, source: 'manual', at: new Date().toISOString() },
              },
            },
          });
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  return NextResponse.json({ ok: true, segments: segments.length, ...(warning ? { warning } : {}) });
}
