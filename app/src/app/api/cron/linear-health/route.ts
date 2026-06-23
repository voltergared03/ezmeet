import { NextRequest, NextResponse } from 'next/server';
import { getLinearConfig, ensureLinearWebhook } from '@/lib/linear';

export const dynamic = 'force-dynamic';

// GET /api/cron/linear-health?secret= — re-ensure the Linear reverse webhook exists.
// Linear disables a webhook after repeated delivery failures; this recreates it so
// the Linear → Garely state/deletion sync self-heals. No-op when Linear is off.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const cfg = await getLinearConfig();
  if (!cfg) return NextResponse.json({ skipped: 'disabled' });
  const result = await ensureLinearWebhook();
  return NextResponse.json(result);
}
