import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { readConfig } from '@/lib/config';
import { clickUpPing, decodeToken } from '@/lib/clickup';

// POST /api/settings/clickup/test — validate the saved ClickUp token via GET /team.
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const errT = await getTranslations('errors');
  const m = await readConfig(['CLICKUP_TOKEN']);
  const token = decodeToken(m.CLICKUP_TOKEN);
  if (!token) {
    return NextResponse.json({ error: errT('notConfigured') }, { status: 400 });
  }
  try {
    const { teams } = await clickUpPing(token);
    if (!teams.length) {
      return NextResponse.json({ error: 'ClickUp: no workspace visible to this token' }, { status: 502 });
    }
    return NextResponse.json({ success: true, team: teams[0].name, teamId: teams[0].id, teamCount: teams.length });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || errT('connectionFailed')).slice(0, 200) }, { status: 502 });
  }
}
