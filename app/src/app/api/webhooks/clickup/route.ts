import { NextRequest, NextResponse } from 'next/server';
import { verifyClickUpSignature, applyClickUpEvent } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// POST /api/webhooks/clickup — ClickUp pushes task status changes + deletions here
// (the ClickUp → Garely direction). HMAC-signed: we verify X-Signature against the
// webhook secret stored at connect time. Unauthenticated by design (signature IS the
// auth). Apply is awaited (fast: ≤1 ClickUp GET + a tx) so ClickUp sees a clean 200.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get('x-signature');
  if (!(await verifyClickUpSignature(raw, sig))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }
  let body: { event?: string; task_id?: string };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (body.event && body.task_id) {
    await applyClickUpEvent(body.event, body.task_id); // never throws
  }
  return NextResponse.json({ ok: true });
}
