import { NextRequest, NextResponse } from 'next/server';
import { getClickUpConfig, reconcileClickUpTasks } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// GET /api/cron/clickup-reconcile?secret= — catch-up sweep for the ClickUp → Garely mirror.
//
// The webhook is fire-and-forget: any delivery missed while we were redeploying, rate-limited,
// or while ClickUp had the hook disabled is never retried, so a task's status or name drifts
// permanently. This pulls the current state for every linked task and converges it. No-op when
// ClickUp is off.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const cfg = await getClickUpConfig();
  if (!cfg) return NextResponse.json({ skipped: 'disabled' });
  const result = await reconcileClickUpTasks();
  return NextResponse.json(result);
}
