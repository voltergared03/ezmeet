import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { testCrm } from '@/lib/crm';

// POST /api/settings/crm/test — validate the CRM token (works before the toggle is on).
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const r = await testCrm();
  if (!r.ok) return NextResponse.json({ error: r.error || 'failed' }, { status: 502 });
  return NextResponse.json({ success: true });
}
