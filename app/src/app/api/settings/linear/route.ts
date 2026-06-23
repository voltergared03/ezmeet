import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readConfig, writeConfig } from '@/lib/config';
import { encryptSecret } from '@/lib/twofactor';
import { enableLinearSync, disableLinearSync, decodeToken } from '@/lib/linear';

// GET /api/settings/linear — current Linear integration settings (the API key is
// never returned to the browser; only whether one is set).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const m = await readConfig(['LINEAR_ENABLED', 'LINEAR_TOKEN', 'LINEAR_ROUTING_MODE', 'LINEAR_FALLBACK_TEAM_ID', 'LINEAR_MIGRATION']);
  let migration: unknown = null;
  try { if (m.LINEAR_MIGRATION) migration = JSON.parse(m.LINEAR_MIGRATION); } catch { /* ignore */ }
  return NextResponse.json({
    enabled: m.LINEAR_ENABLED === 'true',
    tokenSet: !!(m.LINEAR_TOKEN || '').trim(),
    routingMode: m.LINEAR_ROUTING_MODE === 'inbox' ? 'inbox' : 'department',
    fallbackTeamId: m.LINEAR_FALLBACK_TEAM_ID || '',
    migration,
  });
}

// PATCH /api/settings/linear — save Linear settings. The API key is stored
// AES-256-GCM encrypted at rest (reusing the workspace secret helper).
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, string> = {};

  if (typeof body.enabled === 'boolean') updates.LINEAR_ENABLED = body.enabled ? 'true' : 'false';
  if (typeof body.routingMode === 'string') updates.LINEAR_ROUTING_MODE = body.routingMode === 'inbox' ? 'inbox' : 'department';
  if (typeof body.fallbackTeamId === 'string') updates.LINEAR_FALLBACK_TEAM_ID = body.fallbackTeamId.trim();
  if (body.teamMap && typeof body.teamMap === 'object') {
    try { updates.LINEAR_TEAM_MAP = JSON.stringify(body.teamMap); } catch { /* ignore */ }
  }
  // Only overwrite the token when a real new value is supplied (a masked
  // placeholder of dots, or empty, is ignored so a re-save doesn't wipe it).
  if (typeof body.token === 'string') {
    const tok = body.token.trim();
    if (tok && !/^[•*]+$/.test(tok)) updates.LINEAR_TOKEN = encryptSecret(tok);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  await writeConfig(updates);

  // React to connect / disconnect (fire-and-forget — never blocks the response).
  // Connect (enable, or a new token) → register the reverse webhook + migrate
  // existing tasks. Disconnect → tear down the webhook + release owned tasks.
  const tokenChanged = typeof body.token === 'string' && !!body.token.trim() && !/^[•*]+$/.test(body.token.trim());
  if (body.enabled === false) {
    void disableLinearSync();
  } else if (body.enabled === true || tokenChanged) {
    const st = await readConfig(['LINEAR_ENABLED', 'LINEAR_TOKEN']);
    if (st.LINEAR_ENABLED === 'true' && decodeToken(st.LINEAR_TOKEN)) void enableLinearSync();
  }

  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}
