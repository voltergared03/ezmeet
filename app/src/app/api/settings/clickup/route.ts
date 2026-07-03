import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readConfig, writeConfig } from '@/lib/config';
import { encryptSecret } from '@/lib/twofactor';
import { enableClickUpSync, disableClickUpSync, decodeToken } from '@/lib/clickup';

// GET /api/settings/clickup — current ClickUp integration settings (token never
// returned to the browser; only whether one is set).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const m = await readConfig(['CLICKUP_ENABLED', 'CLICKUP_TOKEN', 'CLICKUP_ROUTING_MODE', 'CLICKUP_TEAM_ID', 'CLICKUP_MIGRATION', 'CLICKUP_PERSONAL_ROUTING']);
  let migration: unknown = null;
  try { if (m.CLICKUP_MIGRATION) migration = JSON.parse(m.CLICKUP_MIGRATION); } catch { /* ignore */ }
  return NextResponse.json({
    enabled: m.CLICKUP_ENABLED === 'true',
    tokenSet: !!(m.CLICKUP_TOKEN || '').trim(),
    routingMode: m.CLICKUP_ROUTING_MODE === 'inbox' ? 'inbox' : 'department',
    teamId: m.CLICKUP_TEAM_ID || '',
    personalRouting: m.CLICKUP_PERSONAL_ROUTING === 'true',
    migration,
  });
}

// PATCH /api/settings/clickup — save ClickUp settings. The token is stored
// AES-256-GCM encrypted at rest (reusing the workspace secret helper).
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, string> = {};

  if (typeof body.enabled === 'boolean') updates.CLICKUP_ENABLED = body.enabled ? 'true' : 'false';
  if (typeof body.routingMode === 'string') updates.CLICKUP_ROUTING_MODE = body.routingMode === 'inbox' ? 'inbox' : 'department';
  if (typeof body.personalRouting === 'boolean') updates.CLICKUP_PERSONAL_ROUTING = body.personalRouting ? 'true' : 'false';
  if (typeof body.teamId === 'string') updates.CLICKUP_TEAM_ID = body.teamId.trim();
  if (typeof body.fallbackListId === 'string') updates.CLICKUP_FALLBACK_LIST_ID = body.fallbackListId.trim();
  if (body.listMap && typeof body.listMap === 'object') {
    try { updates.CLICKUP_LIST_MAP = JSON.stringify(body.listMap); } catch { /* ignore */ }
  }
  // Only overwrite the token when a real new value is supplied (a masked
  // placeholder of dots, or empty, is ignored so a re-save doesn't wipe it).
  if (typeof body.token === 'string') {
    const tok = body.token.trim();
    if (tok && !/^[•*]+$/.test(tok)) updates.CLICKUP_TOKEN = encryptSecret(tok);
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  await writeConfig(updates);

  // React to connect / disconnect (fire-and-forget — never blocks the response).
  // Connect (enable, or a new token) → register the reverse webhook + migrate existing
  // tasks. Disconnect → tear down the webhook + release owned tasks back to Garely.
  const tokenChanged = typeof body.token === 'string' && !!body.token.trim() && !/^[•*]+$/.test(body.token.trim());
  if (body.enabled === false) {
    void disableClickUpSync();
  } else if (body.enabled === true || tokenChanged) {
    const st = await readConfig(['CLICKUP_ENABLED', 'CLICKUP_TOKEN']);
    if (st.CLICKUP_ENABLED === 'true' && decodeToken(st.CLICKUP_TOKEN)) void enableClickUpSync();
  }

  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}
