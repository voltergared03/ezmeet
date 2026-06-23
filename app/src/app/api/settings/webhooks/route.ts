import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getWebhooksForApi, saveWebhooks, WEBHOOK_EVENTS, type WebhookEndpointInput } from '@/lib/webhooks';

// GET /api/settings/webhooks — configured endpoints (secrets never returned).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const endpoints = await getWebhooksForApi();
  return NextResponse.json({ endpoints, events: WEBHOOK_EVENTS });
}

// PATCH /api/settings/webhooks — replace the endpoint list. Secrets encrypted at rest.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  if (!Array.isArray(body?.endpoints)) {
    return NextResponse.json({ error: 'invalid_payload' }, { status: 400 });
  }
  const result = await saveWebhooks(body.endpoints as WebhookEndpointInput[]);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ success: true, endpoints: result.endpoints });
}
