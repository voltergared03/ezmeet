import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readConfig, writeConfig } from '@/lib/config';
import { encryptSecret } from '@/lib/twofactor';

// GET /api/settings/chat — current chat-notifications settings (secrets never returned).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const m = await readConfig(['CHAT_ENABLED', 'CHAT_PROVIDER', 'CHAT_CHAT_ID', 'CHAT_BOT_TOKEN', 'CHAT_WEBHOOK_URL']);
  return NextResponse.json({
    enabled: m.CHAT_ENABLED === 'true',
    provider: m.CHAT_PROVIDER || 'telegram',
    chatId: m.CHAT_CHAT_ID || '',
    botTokenSet: !!(m.CHAT_BOT_TOKEN || '').trim(),
    webhookSet: !!(m.CHAT_WEBHOOK_URL || '').trim(),
  });
}

// PATCH /api/settings/chat — save settings. Bot token + webhook URL are encrypted at rest.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));
  const updates: Record<string, string> = {};

  if (typeof body.enabled === 'boolean') updates.CHAT_ENABLED = body.enabled ? 'true' : 'false';
  if (typeof body.provider === 'string' && ['telegram', 'slack', 'mattermost', 'discord'].includes(body.provider)) {
    updates.CHAT_PROVIDER = body.provider;
  }
  if (typeof body.chatId === 'string') updates.CHAT_CHAT_ID = body.chatId.trim();
  // Only overwrite a secret when a real value (not a masked placeholder) is supplied.
  const real = (v: unknown) => typeof v === 'string' && !!v.trim() && !/^[•*]+$/.test(v.trim());
  if (real(body.botToken)) updates.CHAT_BOT_TOKEN = encryptSecret((body.botToken as string).trim());
  if (real(body.webhookUrl)) updates.CHAT_WEBHOOK_URL = encryptSecret((body.webhookUrl as string).trim());

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
  }
  await writeConfig(updates);
  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}
