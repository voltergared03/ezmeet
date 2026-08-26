import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { prisma } from '@/lib/prisma';
import { isValidEmail } from '@/lib/form-rules';
import { hashPassword, passwordPolicyError } from '@/lib/password';
import { getAuthConfig, emailAllowedForSelfReg, publicBaseUrl } from '@/lib/config';
import { sendEmail } from '@/lib/email';
import { getTranslator, workspaceLocale } from '@/lib/i18n-server';
import { notify } from '@/lib/notify';
import { rateLimit } from '@/lib/rate-limit';
import { requireSingletonOrgId } from '@/lib/org';

export const dynamic = 'force-dynamic';

function ipOf(req: NextRequest): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
}

// POST /api/register { email, name, password } — PUBLIC self-registration.
// Creates a pending RegistrationRequest for admin approval. Security-hardened:
// rate-limited, domain-allowlisted, and anti-enumeration (never reveals whether
// an email already exists).
export async function POST(req: NextRequest) {
  const t = await getTranslations('errors');

  // Throttle hard — this is unauthenticated.
  if (!(await rateLimit(`register:${ipOf(req)}`, 5, 10 * 60_000)).ok) {
    return NextResponse.json({ error: t('tooManyAttempts') }, { status: 429 });
  }

  const authCfg = await getAuthConfig();
  if (!authCfg.selfReg) {
    return NextResponse.json({ error: t('selfRegDisabled') }, { status: 403 });
  }

  const body = await req.json().catch(() => ({} as any));
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim().slice(0, 120) || null;
  const password = String(body.password || '');

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: t('invalidEmail') }, { status: 400 });
  }
  if (!emailAllowedForSelfReg(email, authCfg.selfRegDomains)) {
    return NextResponse.json({ error: t('domainNotAllowed') }, { status: 400 });
  }
  const pwErr = passwordPolicyError(password);
  if (pwErr) return NextResponse.json({ error: pwErr }, { status: 400 });

  // Anti-enumeration: if the email is already a user, pretend success without
  // creating anything (don't leak account existence).
  const existingUser = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existingUser) {
    return NextResponse.json({ ok: true });
  }

  const passwordHash = await hashPassword(password);
  const expiresAt = new Date(Date.now() + authCfg.requestTtlDays * 86_400_000);

  // Upsert so a re-submission refreshes the request instead of erroring.
  const orgId = await requireSingletonOrgId();
  await prisma.registrationRequest.upsert({
    where: { email },
    create: { email, name, passwordHash, status: 'pending', expiresAt, orgId },
    update: { name, passwordHash, status: 'pending', expiresAt, decidedAt: null, decidedById: null },
  });

  // Notify admins (in-app + push + email-if-SMTP via notify()).
  try {
    const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
    await notify({
      userIds: admins.map((a) => a.id),
      type: 'registration',
      titleKey: 'registrationTitle',
      body: email,
      link: '/settings',
    });
  } catch {
    /* non-fatal */
  }

  // Email admins too — best-effort. In-app + push above only reach an open or
  // push-subscribed session, so the email is what actually "arrives" off-app.
  try {
    const adminEmails = (
      await prisma.user.findMany({ where: { role: 'admin', email: { not: null } }, select: { email: true } })
    )
      .map((a) => a.email!)
      .filter(Boolean);
    if (adminEmails.length) {
      const et = getTranslator(await workspaceLocale());
      const appUrl = await publicBaseUrl();
      const link = appUrl ? `${appUrl}/settings` : '';
      await sendEmail({
        to: adminEmails,
        template: 'registration-request',
        subject: et('emails.registrationRequest.subject'),
        text: `${et('emails.registrationRequest.body', { email })}${link ? `\n\n${link}` : ''}`,
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;background:#0f1115;border-radius:14px;color:#e8eaed">
          <div style="font-size:20px;font-weight:700;margin-bottom:8px">${et('emails.registrationRequest.heading')}</div>
          <p style="color:#9aa0a6;margin:0 0 16px;line-height:1.5">${et('emails.registrationRequest.body', { email })}</p>
          ${link ? `<a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${et('emails.registrationRequest.cta')} →</a>` : ''}
        </div>`,
      });
    }
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true });
}
