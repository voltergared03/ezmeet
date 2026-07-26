import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

// A generation should finish in a couple of minutes; well past the in-process hard cap
// (12m) means the process died mid-run (deploy/crash) and no catch block ever fired.
const STUCK_AGE_MS = 20 * 60 * 1000;

// GET /api/cron/report-backstop?secret= — release meeting reports stuck in `generating`.
// The in-process idle/hard timeout catches a stalled provider, but a killed process leaves
// the meeting on `generating` forever (permanent spinner, no retry). This fails those so the
// report page shows the retry action.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const cutoff = new Date(Date.now() - STUCK_AGE_MS);
  const res = await prisma.meeting.updateMany({
    where: {
      reportStatus: 'generating',
      // Only touch clearly-stale ones. A null reportStartedAt is a pre-fix row — also stale
      // if it's still 'generating' now, but guard on the timestamp when we have it.
      OR: [{ reportStartedAt: { lt: cutoff } }, { reportStartedAt: null }],
    },
    data: {
      reportStatus: 'failed',
      reportError: 'Report generation was interrupted (the server restarted or it timed out). Open the report and retry.',
    },
  });
  return NextResponse.json({ released: res.count });
}
