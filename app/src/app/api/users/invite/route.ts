import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { isValidEmail } from '@/lib/form-rules';
import { prisma } from '@/lib/prisma';
import { unsuppressEmail } from '@/lib/suppression';
import { sendEmail } from '@/lib/email';
import { readConfig, CONFIG_DEFAULTS, publicBaseUrl, getAuthConfig } from '@/lib/config';
import crypto from 'node:crypto';
import { getTranslator, workspaceLocale } from '@/lib/i18n-server';
import { getCurrentOrgId, ensureMembership } from '@/lib/org';
import { withRoute } from '@/lib/with-route';

// POST /api/users/invite — invite a user by email (admin only).
// Pre-creates the user with the chosen role and emails a login link.
async function postHandler(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // The invite is sent in the workspace default language (the recipient has no
  // saved preference yet, even when pre-created).
  const locale = await workspaceLocale();
  const t = getTranslator(locale);

  const body = await req.json().catch(() => ({} as any));
  const email = String(body.email || '').trim().toLowerCase();
  const role = ['admin', 'member', 'viewer'].includes(body.role) ? body.role : 'member';

  if (!email || !isValidEmail(email)) {
    return NextResponse.json({ error: t('emails.invite.errors.invalidEmail') }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  let user;
  let created = false;
  if (existing) {
    user = await prisma.user.update({ where: { id: existing.id }, data: { role } });
  } else {
    // Apply workspace defaults (timezone / language) to the invited user.
    const cfg = await readConfig(['WS_TIMEZONE', 'WS_LANGUAGE']);
    user = await prisma.user.create({
      data: {
        email,
        role,
        name: email.split('@')[0],
        timezone: cfg.WS_TIMEZONE || CONFIG_DEFAULTS.WS_TIMEZONE,
        preferences: { language: cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE },
      },
    });
    created = true;
    // Someone re-invited after being deleted must be reachable again.
    await unsuppressEmail(email);
  }

  // Multi-tenancy: ensure the (new or existing) invited user is in the current org.
  const orgId = await getCurrentOrgId(session);
  if (orgId) await ensureMembership(orgId, user.id, role === 'admin' ? 'ADMIN' : 'MEMBER');

  const appUrl = await publicBaseUrl();
  const inviterName = session.user.name || t('emails.common.adminFallback');
  const roleLabel = role === 'admin' ? t('emails.invite.roles.admin') : role === 'viewer' ? t('emails.invite.roles.viewer') : t('emails.invite.roles.member');

  // When password auth is enabled and the invited user has no password yet, send
  // a one-time "create your password" link (which activates the account) instead
  // of the Google-SSO sign-in link. The token reuses the otherwise-unused NextAuth
  // VerificationToken table — no schema change.
  const authCfg = await getAuthConfig();
  const needsPassword = authCfg.passwordEnabled && !(user as any).passwordHash;
  let url = `${appUrl}/login`;
  if (needsPassword && appUrl) {
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.verificationToken.deleteMany({ where: { identifier: email } }).catch(() => {});
    await prisma.verificationToken.create({
      data: { identifier: email, token, expires: new Date(Date.now() + 7 * 86400000) },
    });
    url = `${appUrl}/set-password?token=${token}`;
  }

  const richB = (c: any) => `<b style="color:#e8eaed">${c}</b>`;
  const sent = await sendEmail({
    to: email,
    template: 'invite',
    subject: t('emails.invite.subject'),
    text: needsPassword
      ? t('emails.invite.setupBodyText', { inviter: inviterName, role: roleLabel, url })
      : t('emails.invite.bodyText', { inviter: inviterName, role: roleLabel, url }),
    html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f1115;border-radius:16px;color:#e8eaed">
      <div style="font-size:22px;font-weight:700;margin-bottom:8px">${t('emails.invite.heading')}</div>
      <p style="color:#9aa0a6;line-height:1.5;margin:0 0 18px">${needsPassword ? t.rich('emails.invite.setupBodyHtml', { inviter: inviterName, role: roleLabel, b: richB }) : t.rich('emails.invite.bodyHtml', { inviter: inviterName, role: roleLabel, b: richB })}</p>
      <a href="${url}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${needsPassword ? t('emails.invite.setupCta') : t('emails.invite.cta')} →</a>
    </div>`,
  });

  return NextResponse.json({
    success: true,
    created,
    emailSent: sent.ok,
    user: { id: user.id, name: user.name, email: user.email, image: user.image, role: user.role, lastLogin: user.lastLogin },
  });
}

export const POST = withRoute('users.invite', postHandler);
