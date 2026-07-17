import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readConfig, writeConfig, CONFIG_DEFAULTS, getAuthConfig } from '@/lib/config';
import { withRoute } from '@/lib/with-route';

const BOOL_KEYS = ['WS_GUEST_ACCESS', 'WS_AI_SUMMARY', 'WS_LIVE_TRANSCRIPTION', 'WS_RECORD_ALL', 'WS_REQUIRE_2FA'];
const STR_KEYS = ['WS_NAME', 'WS_DOMAIN', 'WS_TIMEZONE', 'WS_LANGUAGE'];
// Multi-line text: only edge-trimmed (line breaks separate terms, so no inner trim).
const TEXT_KEYS = ['WS_GLOSSARY'];
const NUM_KEYS = ['WS_MAX_PARTICIPANTS', 'WS_MAX_DURATION_MIN', 'WS_RETENTION_DAYS', 'PRICE_DEEPSEEK_IN', 'PRICE_DEEPSEEK_OUT', 'PRICE_DEEPGRAM_MIN', 'EMAIL_LIMIT'];
const ALL_KEYS = [...BOOL_KEYS, ...STR_KEYS, ...TEXT_KEYS, ...NUM_KEYS];

// GET /api/settings/workspace — workspace + pricing config (merged with defaults)
async function getHandler() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const saved = await readConfig(ALL_KEYS);
  const out: Record<string, string | boolean | number> = {};
  for (const k of STR_KEYS) out[k] = saved[k] ?? CONFIG_DEFAULTS[k];
  for (const k of TEXT_KEYS) out[k] = saved[k] ?? CONFIG_DEFAULTS[k];
  for (const k of BOOL_KEYS) out[k] = (saved[k] ?? CONFIG_DEFAULTS[k]) === 'true';
  for (const k of NUM_KEYS) out[k] = Number(saved[k] ?? CONFIG_DEFAULTS[k]);

  // Auth methods (with backward-compatible defaults).
  const authCfg = await getAuthConfig();
  out.AUTH_GOOGLE_ENABLED = authCfg.googleEnabled;
  out.AUTH_PASSWORD_ENABLED = authCfg.passwordEnabled;
  out.AUTH_SELFREG = authCfg.selfReg;
  out.AUTH_SELFREG_DOMAINS = authCfg.selfRegDomains.join(', ');

  return NextResponse.json(out);
}

// PATCH /api/settings/workspace — save workspace + pricing config
async function patchHandler(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const t = await getTranslations('errors');
  const body = await req.json().catch(() => ({} as any));
  const updates: Record<string, string> = {};

  for (const k of STR_KEYS) {
    if (typeof body[k] === 'string') updates[k] = body[k].trim();
  }
  for (const k of TEXT_KEYS) {
    // Edge-trim only, and cap the stored size so an admin can't paste a novel that then
    // rides on every STT request. ~100 terms × 60 chars, with slack.
    if (typeof body[k] === 'string') updates[k] = body[k].trim().slice(0, 8000);
  }
  for (const k of BOOL_KEYS) {
    if (body[k] !== undefined) updates[k] = body[k] ? 'true' : 'false';
  }
  for (const k of NUM_KEYS) {
    if (body[k] !== undefined && body[k] !== '') {
      const n = Number(body[k]);
      if (Number.isFinite(n) && n >= 0) updates[k] = String(n);
    }
  }

  // Guard against self-lockout: don't let an admin turn ON the 2FA requirement
  // unless they have 2FA enabled themselves. Only enforced on the false→true
  // transition, so unrelated saves while it's already on aren't blocked.
  if (updates.WS_REQUIRE_2FA === 'true') {
    const current = await readConfig(['WS_REQUIRE_2FA']);
    if (current.WS_REQUIRE_2FA !== 'true') {
      const me = (await prisma.user.findUnique({
        where: { id: session.user.id },
        select: { totpEnabled: true } as any,
      })) as any;
      if (!me?.totpEnabled) {
        return NextResponse.json(
          { error: t('enable2faFirst') },
          { status: 400 },
        );
      }
    }
  }

  // ── Auth methods ──────────────────────────────────────────
  let touchedAuth = false;
  for (const k of ['AUTH_GOOGLE_ENABLED', 'AUTH_PASSWORD_ENABLED', 'AUTH_SELFREG']) {
    if (body[k] !== undefined) { updates[k] = body[k] ? 'true' : 'false'; touchedAuth = true; }
  }
  if (typeof body.AUTH_SELFREG_DOMAINS === 'string') {
    updates.AUTH_SELFREG_DOMAINS = body.AUTH_SELFREG_DOMAINS
      .split(',').map((s: string) => s.trim()).filter(Boolean).join(',');
  }
  if (touchedAuth) {
    const cur = await getAuthConfig();
    const googleOn = updates.AUTH_GOOGLE_ENABLED !== undefined ? updates.AUTH_GOOGLE_ENABLED === 'true' : cur.googleEnabled;
    const pwOn = updates.AUTH_PASSWORD_ENABLED !== undefined ? updates.AUTH_PASSWORD_ENABLED === 'true' : cur.passwordEnabled;
    // Never allow zero sign-in methods (total lockout).
    if (!googleOn && !pwOn) {
      return NextResponse.json({ error: t('atLeastOneAuthMethod') }, { status: 400 });
    }

    // Lockout guard: at least one ACTIVE admin must be able to sign in with a
    // method that stays enabled. Otherwise disabling Google for a Google-only
    // admin (no password), or disabling password for a password-only admin,
    // would strand everyone with no way back in.
    const admins = await prisma.user.findMany({
      where: { role: 'admin', status: 'active' },
      select: {
        passwordHash: true,
        accounts: { where: { provider: 'google' }, select: { id: true } },
      } as any,
    });
    const anyAdminCanSignIn = (admins as any[]).some(
      (a) => (pwOn && !!a.passwordHash) || (googleOn && (a.accounts?.length ?? 0) > 0),
    );
    if (!anyAdminCanSignIn) {
      const msg = !googleOn
        ? t('disableGoogleLockout')
        : t('disablePasswordLockout');
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Self-registration requires the password method.
    if (!pwOn) updates.AUTH_SELFREG = 'false';
  }

  await writeConfig(updates);
  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}

export const GET = withRoute('settings.workspace.get', getHandler);
export const PATCH = withRoute('settings.workspace.update', patchHandler);
