import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { testWebhook } from '@/lib/webhooks';

// POST /api/settings/webhooks/test — send a sample `ping` to one endpoint (by id).
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const id = typeof body?.id === 'string' ? body.id : '';
  if (!id) return NextResponse.json({ error: 'missing_id' }, { status: 400 });
  const r = await testWebhook(id);
  if (!r.ok) return NextResponse.json({ error: r.error || 'failed' }, { status: 502 });
  return NextResponse.json({ success: true });
}
