import { NextRequest, NextResponse } from 'next/server';
import { verifyLinearSignature, withinReplayWindow, applyLinearEvent } from '@/lib/linear';

export const dynamic = 'force-dynamic';

// POST /api/webhooks/linear — Linear pushes Issue create/update/remove here (the
// Linear → Garely direction). HMAC-signed: we verify Linear-Signature (hex
// HMAC-SHA256 of the raw body with the secret we generated at connect time) and
// reject stale deliveries (replay guard). Unauthenticated by design (signature IS
// the auth). Apply is awaited (fast: ≤1 Linear query + a tx) so Linear sees a 200.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sig = req.headers.get('linear-signature');
  if (!(await verifyLinearSignature(raw, sig))) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }
  let body: { action?: string; type?: string; data?: { id?: string }; webhookTimestamp?: number };
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!withinReplayWindow(body.webhookTimestamp, Date.now())) {
    return NextResponse.json({ error: 'stale' }, { status: 401 });
  }
  if (body.action && body.type && body.data?.id) {
    await applyLinearEvent(body.action, body.type, body.data.id); // never throws
  }
  return NextResponse.json({ ok: true });
}
