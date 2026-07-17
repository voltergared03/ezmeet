import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { listAllClickUpLists } from '@/lib/clickup';

// GET /api/settings/clickup/lists — every ClickUp list, for the department/user pickers.
//
// Deliberately NOT folded into the main settings GET: it walks Spaces → Folders → Lists,
// so it costs several ClickUp calls. Fetch it once when a settings tab opens, never per row.
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  try {
    return NextResponse.json({ lists: await listAllClickUpLists() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message.slice(0, 200) }, { status: 502 });
  }
}
