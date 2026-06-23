import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { readConfig } from '@/lib/config';
import { linearPing, decodeToken } from '@/lib/linear';

// POST /api/settings/linear/test — validate the saved Linear API key (viewer + teams).
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const errT = await getTranslations('errors');
  const m = await readConfig(['LINEAR_TOKEN']);
  const token = decodeToken(m.LINEAR_TOKEN);
  if (!token) {
    return NextResponse.json({ error: errT('notConfigured') }, { status: 400 });
  }
  try {
    const { teams } = await linearPing(token);
    if (!teams.length) {
      return NextResponse.json({ error: 'Linear: no team visible to this API key' }, { status: 502 });
    }
    return NextResponse.json({ success: true, team: teams[0].name, teamCount: teams.length });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || errT('connectionFailed')).slice(0, 200) }, { status: 502 });
  }
}
