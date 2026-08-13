import { NextRequest, NextResponse } from 'next/server';
import { verifyClickUpSignature, enqueueClickUpEvent } from '@/lib/clickup';

export const dynamic = 'force-dynamic';

// POST /api/webhooks/clickup — ClickUp pushes task status changes + deletions here
// (the ClickUp → Garely direction). HMAC-signed: we verify X-Signature against the
// webhook secret stored at connect time. Unauthenticated by design (signature IS the auth).
//
// The response is an ACK, not a result. Applying the event inline used to hold the
// connection open for a ClickUp API round trip; ClickUp gives a delivery a few seconds and
// counts anything slower as a failure, so a burst on 2026-08-13 racked up 407 failures and
// ClickUp SUSPENDED the webhook — two-way sync went dark for five hours. Verify, ack, then
// apply on the queue, which coalesces per task and drains inside the API rate limit.
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
    enqueueClickUpEvent(body.event, body.task_id); // returns immediately; never throws
  }
  return NextResponse.json({ ok: true });
}
