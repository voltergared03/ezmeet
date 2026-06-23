import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { chatTest } from '@/lib/chat-notify';

// POST /api/settings/chat/test — send a "Garely is connected" message to the chat.
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const errT = await getTranslations('errors');
  const r = await chatTest();
  if (r.ok) return NextResponse.json({ success: true });
  if (r.error === 'not_configured') return NextResponse.json({ error: errT('notConfigured') }, { status: 400 });
  return NextResponse.json({ error: (r.error || errT('connectionFailed')).slice(0, 200) }, { status: 502 });
}
