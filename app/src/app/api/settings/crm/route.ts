import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readConfig, writeConfig } from '@/lib/config';
import { encryptSecret } from '@/lib/twofactor';

// GET /api/settings/crm — current CRM settings (token never returned).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const m = await readConfig(['CRM_ENABLED', 'CRM_PROVIDER', 'CRM_TOKEN', 'CRM_CREATE_CONTACT']);
  return NextResponse.json({
    enabled: m.CRM_ENABLED === 'true',
    provider: m.CRM_PROVIDER || 'hubspot',
    tokenSet: !!(m.CRM_TOKEN || '').trim(),
    createContact: m.CRM_CREATE_CONTACT === 'true',
  });
}

// PATCH /api/settings/crm — save settings. The private-app token is encrypted at rest.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, string> = {};

  if (typeof body.enabled === 'boolean') updates.CRM_ENABLED = body.enabled ? 'true' : 'false';
  if (typeof body.provider === 'string' && ['hubspot'].includes(body.provider)) updates.CRM_PROVIDER = body.provider;
  if (typeof body.createContact === 'boolean') updates.CRM_CREATE_CONTACT = body.createContact ? 'true' : 'false';
  // Only overwrite the token when a real value (not a masked placeholder) is supplied.
  const tokenIn = typeof body.token === 'string' ? body.token.trim() : '';
  if (tokenIn && !/^[•*]+$/.test(tokenIn)) {
    // Guard against accidentally overwriting a valid stored token with a partial
    // paste — HubSpot private-app tokens are long; reject an obviously truncated one.
    if (tokenIn.length < 30) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
    }
    updates.CRM_TOKEN = encryptSecret(tokenIn);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  await writeConfig(updates);
  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}
