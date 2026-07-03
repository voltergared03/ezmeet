import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getFallbackStats } from '@/lib/clickup';

// GET /api/settings/clickup/fallback-stats — how many tasks land in the fallback
// (Call Inbox) list, so an admin can judge whether it's still needed. Lazy: this
// hits the ClickUp API, so it's fetched on demand (not on the main settings GET).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const stats = await getFallbackStats();
  return NextResponse.json({ stats });
}
