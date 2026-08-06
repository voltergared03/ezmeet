import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireMeetingAccess } from '@/lib/api-auth';
import { withRoute } from '@/lib/with-route';
import { jsonError, jsonOk } from '@/lib/http';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/meetings/[id]/end — the participant explicitly says "this meeting is over".
 *
 * Exists because leaving the room is ambiguous: stepping out of a call you are alone in
 * usually means "I'll be back", not "we're done". Everything else in the product infers
 * the end of a meeting; this is the one place a human states it.
 *
 * Stamping heldConfirmedAt is the point: it is the absolute override in the
 * abandoned-attempt check, so a deliberately ended meeting always produces its report
 * even if it was short and quiet.
 */
async function postHandler(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const r = await requireMeetingAccess(id);
  if (r instanceof Response) return r;

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    select: { id: true, status: true },
  });
  if (!meeting) return jsonError('not_found', 404);
  if (meeting.status === 'ended' || meeting.status === 'cancelled') return jsonOk();

  await prisma.meeting.update({
    where: { id },
    // endedAt is left to the normal path (room_finished / report generation) so it
    // records when the room actually closed, not when the button was pressed.
    data: { heldConfirmedAt: new Date(), noShowAt: null },
  });
  return jsonOk();
}

export const POST = withRoute('meetings.end', postHandler);
