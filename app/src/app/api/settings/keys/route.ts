import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isInternalAuthed } from '@/lib/internal-auth';
import { withRoute } from '@/lib/with-route';

const ALLOWED_KEYS = ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL', 'DEEPGRAM_API_KEY', 'DEEPGRAM_MODEL', 'DEEPGRAM_LANGUAGE', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'];
const SECRET_KEYS = ['DEEPSEEK_API_KEY', 'DEEPGRAM_API_KEY', 'GOOGLE_CLIENT_SECRET'];

// GET /api/settings/keys — masked for admins (write-only secrets); full values for
// internal callers (the Python agent, authenticated by the shared secret header).
async function getHandler(req: NextRequest) {
  const internal = isInternalAuthed(req);
  if (!internal) {
    const session = await auth();
    if (!session?.user || session.user.role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }

  const t = await getTranslations('errors');
  const configs = await prisma.systemConfig.findMany({
    where: { key: { in: ALLOWED_KEYS } },
  });

  const result: Record<string, { value: string; masked: string; updatedAt: string }> = {};
  for (const c of configs) {
    const val = c.value || '';
    const isSecret = SECRET_KEYS.includes(c.key);
    const masked = !isSecret
      ? val
      : (val.length > 8 ? val.slice(0, 4) + '••••••••' + val.slice(-4) : '••••••••');
    // Internal callers get the real value; the browser never receives raw secrets.
    result[c.key] = { value: internal ? val : (isSecret ? '' : val), masked, updatedAt: c.updatedAt?.toISOString() || '' };
  }

  // Add missing keys with empty values
  for (const key of ALLOWED_KEYS) {
    if (!result[key]) {
      result[key] = { value: '', masked: t('notConfigured'), updatedAt: '' };
    }
  }

  // The Python agent needs the workspace language to generate reports / live
  // notes / action items in the admin-chosen language. Internal callers only.
  // The glossary rides along for the same reason: it feeds Deepgram term boosting.
  // Both are served here rather than via ALLOWED_KEYS because the PATCH below drops
  // empty values, which would make an emptied glossary impossible to clear.
  if (internal) {
    const [wsLang, gloss] = await Promise.all([
      prisma.systemConfig.findUnique({ where: { key: 'WS_LANGUAGE' } }),
      prisma.systemConfig.findUnique({ where: { key: 'WS_GLOSSARY' } }),
    ]);
    result['WS_LANGUAGE'] = { value: wsLang?.value || 'en', masked: '', updatedAt: '' };
    result['WS_GLOSSARY'] = { value: gloss?.value || '', masked: '', updatedAt: '' };
  }

  return NextResponse.json(result);
}

// PATCH /api/settings/keys — update API keys
async function patchHandler(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json();
  const updates: { key: string; value: string }[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_KEYS.includes(key) && typeof value === 'string' && value.trim()) {
      updates.push({ key, value: value.trim() });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No valid keys to update' }, { status: 400 });
  }

  for (const { key, value } of updates) {
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  // Update the running process env so the app picks up new values without a
  // restart. (The Python agent reads its own env — it is restarted separately.)
  for (const { key, value } of updates) {
    process.env[key] = value;
  }

  return NextResponse.json({ success: true, updated: updates.map(u => u.key) });
}

export const GET = withRoute('settings.keys.get', getHandler);
export const PATCH = withRoute('settings.keys.update', patchHandler);
