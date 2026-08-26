import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/prisma';
import { isValidEmail } from '@/lib/form-rules';
import { verifySetupToken, markSetupComplete, provisionFirstOrg } from '@/lib/setup';
import { hashPassword, passwordPolicyError } from '@/lib/password';
import { readConfig, CONFIG_DEFAULTS } from '@/lib/config';
import { withRoute } from '@/lib/with-route';

// POST /api/setup/admin { token, email, name, password }
// Password-auth setup path: create the first admin from email+password and
// finalize setup. (Google-auth setup uses /api/setup/complete instead.)
async function postHandler(req: NextRequest) {
  const { token, email, name, password } = await req.json().catch(() => ({}));
  const t = await getTranslations('errors');

  if (!(await verifySetupToken(token))) {
    return NextResponse.json({ error: 'Invalid or expired setup token' }, { status: 403 });
  }

  const e = String(email || '').trim().toLowerCase();
  if (!e || !isValidEmail(e)) {
    return NextResponse.json({ error: t('invalidEmail') }, { status: 400 });
  }
  const pwErr = passwordPolicyError(password);
  if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

  const existing = await prisma.user.findUnique({ where: { email: e } });
  if (existing) {
    return NextResponse.json({ error: t('emailExists') }, { status: 409 });
  }

  const cfg = await readConfig(['WS_TIMEZONE', 'WS_LANGUAGE']);
  const passwordHash = await hashPassword(String(password));

  const admin = await prisma.user.create({
    data: {
      email: e,
      name: (name && String(name).trim()) || e.split('@')[0],
      role: 'admin',
      status: 'active',
      passwordHash,
      timezone: cfg.WS_TIMEZONE || CONFIG_DEFAULTS.WS_TIMEZONE,
      preferences: { language: cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE },
    } as any,
  });

  // Multi-tenancy: create org #1 and make this first admin its OWNER (fresh
  // install). Shared with the Google-auth path so the two can't drift.
  await provisionFirstOrg(admin.id);

  // Burns the setup token and flips SETUP_COMPLETE → /setup is now locked.
  await markSetupComplete();

  return NextResponse.json({ ok: true });
}

export const POST = withRoute('setup.admin', postHandler);
