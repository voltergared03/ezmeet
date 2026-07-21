import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { isInternalAuthed } from '@/lib/internal-auth';

// Transcript-segment coalescing thresholds (see POST handler). Deepgram runs
// with endpointing_ms=500, so one continuous turn arrives as many short FINALs;
// we merge contiguous same-speaker/same-language finals into readable rows.
const MERGE_GAP_MIN_SEC = -1; // tolerate minor out-of-order / overlap jitter
const MERGE_GAP_MAX_SEC = 3; // max silence between finals to still be "one turn"
const MERGE_MAX_DUR_SEC = 30; // cap a merged row's spanned time
const MERGE_MAX_CHARS = 800; // cap a merged row's length (keeps citations granular)

// POST /api/webhooks/transcript — store transcript segment (called by Python agent)
export async function POST(req: NextRequest) {
  // Internal-only: require the shared secret header (sent by the agent).
  if (!isInternalAuthed(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { meetingId, speakerName, speakerId, content, language, startTime, endTime, confidence, startEpochMs, endEpochMs } = body;

    if (!meetingId || !content) {
      return NextResponse.json({ error: 'meetingId and content required' }, { status: 400 });
    }

    const newStart = typeof startTime === 'number' ? startTime : 0;
    const newEnd = typeof endTime === 'number' ? endTime : 0;
    const newConf = typeof confidence === 'number' ? confidence : null;
    const newLang = language || null;
    // Absolute UTC millis (new-agent only; null from older agents / pre-fix rows).
    const newStartEpoch = typeof startEpochMs === 'number' ? startEpochMs : null;
    const newEndEpoch = typeof endEpochMs === 'number' ? endEpochMs : null;

    // Coalesce this final into the most-recent row when it's the SAME speaker,
    // SAME language and temporally contiguous — turning a stream of 0.5s
    // fragments into paragraph-sized rows for the stored transcript, archive and
    // AI report (which numbers/cites these rows). We only ever touch the latest
    // row, so the agent's separately-broadcast live captions are unaffected, and
    // already-generated reports — whose citations are stored as timestamps —
    // keep resolving to the row that now contains that moment. Same-language is
    // required so a uk↔ru code-switch stays its own row (core to this product).
    const last = await prisma.transcriptSegment.findFirst({
      where: { meetingId },
      orderBy: { startTime: 'desc' },
    });

    const sameSpeaker =
      !!last &&
      (speakerId
        ? last.speakerId === speakerId
        : !last.speakerId && last.speakerName === (speakerName ?? null));
    const gap = last ? newStart - last.endTime : Infinity;
    const mergedDur = last ? newEnd - last.startTime : Infinity;
    const mergedLen = last ? last.content.length + 1 + content.length : Infinity;

    if (
      last &&
      sameSpeaker &&
      (last.language || null) === newLang &&
      gap >= MERGE_GAP_MIN_SEC &&
      gap <= MERGE_GAP_MAX_SEC &&
      mergedDur <= MERGE_MAX_DUR_SEC &&
      mergedLen <= MERGE_MAX_CHARS
    ) {
      const merged = await prisma.transcriptSegment.update({
        where: { id: last.id },
        data: {
          content: `${last.content} ${content}`.replace(/\s+/g, ' ').trim(),
          endTime: Math.max(last.endTime, newEnd),
          // The row keeps its own (earlier) start; extend only the end. Mirror that for the
          // absolute epochs so the merged row spans start(first)..end(latest).
          endEpochMs: last.endEpochMs != null && newEndEpoch != null ? Math.max(last.endEpochMs, newEndEpoch) : (newEndEpoch ?? last.endEpochMs),
          confidence:
            last.confidence != null && newConf != null
              ? (last.confidence + newConf) / 2
              : newConf ?? last.confidence,
        },
      });
      return NextResponse.json(merged, { status: 200 });
    }

    const segment = await prisma.transcriptSegment.create({
      data: {
        meetingId,
        speakerName,
        speakerId: speakerId || null,
        content,
        language: newLang,
        startTime: newStart,
        endTime: newEnd,
        startEpochMs: newStartEpoch,
        endEpochMs: newEndEpoch,
        confidence: newConf,
        isFinal: true,
      },
    });

    return NextResponse.json(segment, { status: 201 });
  } catch (e) {
    console.error('transcript webhook error:', e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
