import { NextRequest, NextResponse } from 'next/server';
import { getClickUpConfig, ensureClickUpWebhook } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// GET /api/cron/clickup-health?secret= — re-ensure the ClickUp reverse webhook exists.
// ClickUp auto-disables a webhook after repeated delivery failures; this recreates it
// so the ClickUp → Garely status/deletion sync self-heals. No-op when ClickUp is off.
export async function GET(req: NextRequest) {
  const secret = new URL(req.url).searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const cfg = await getClickUpConfig();
  if (!cfg) return NextResponse.json({ skipped: 'disabled' });
  const result = await ensureClickUpWebhook();
  return NextResponse.json(result);
}
