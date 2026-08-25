import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { unsuppressEmail } from '@/lib/suppression';
import { sendEmail } from '@/lib/email';
import { readConfig, CONFIG_DEFAULTS, publicBaseUrl } from '@/lib/config';
import { getTranslator } from '@/lib/i18n-server';
import { getCurrentOrgId, ensureMembership } from '@/lib/org';
import { withRoute } from '@/lib/with-route';

export const dynamic = 'force-dynamic';

async function admin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') return null;
  return session;
}

// GET /api/users/requests — pending (non-expired) self-registration requests.
async function getHandler() {
  if (!(await admin())) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  const requests = await prisma.registrationRequest.findMany({
    where: { status: 'pending', expiresAt: { gt: new Date() } },
    select: { id: true, email: true, name: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'asc' },
  });
  return NextResponse.json(requests);
}

// POST /api/users/requests { id, action: 'approve' | 'deny' }
async function postHandler(req: NextRequest) {
  const session = await admin();
  if (!session) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const t = await getTranslations('errors');
  const { id, action } = await req.json().catch(() => ({} as any));
  const reqRow = await prisma.registrationRequest.findUnique({ where: { id: String(id || '') } });
  if (!reqRow || reqRow.status !== 'pending') {
    return NextResponse.json({ error: t('requestNotFound') }, { status: 404 });
  }

  const decidedById = session.user.id as string;
  const cfg = await readConfig(['WS_TIMEZONE', 'WS_LANGUAGE', 'WS_NAME']);
  const wsName = cfg.WS_NAME || CONFIG_DEFAULTS.WS_NAME;
  const appUrl = await publicBaseUrl();
  const loginUrl = appUrl ? `${appUrl}/login` : '/login';
  // The applicant is brand-new → their email goes out in the workspace language.
  const et = getTranslator(cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE);

  if (action === 'approve') {
    // The applicant already chose their password — provision an active member.
    // If an account with this email already exists, don't silently "approve"
    // (that discarded the password and created nothing) — surface it to the admin.
    const exists = await prisma.user.findUnique({ where: { email: reqRow.email }, select: { id: true } });
    if (exists) {
      return NextResponse.json({ error: t('emailExists') }, { status: 409 });
    }
    const user = await prisma.user.create({
      data: {
        email: reqRow.email,
        name: reqRow.name || reqRow.email.split('@')[0],
        role: 'member',
        status: 'active',
        passwordHash: reqRow.passwordHash,
        timezone: cfg.WS_TIMEZONE || CONFIG_DEFAULTS.WS_TIMEZONE,
        preferences: { language: cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE },
      } as any,
      select: { id: true, name: true, email: true, image: true, role: true, lastLogin: true, createdAt: true },
    });
    // Someone re-approved after being deleted must be reachable again.
    await unsuppressEmail(reqRow.email);
    const orgId = await getCurrentOrgId(session);
    if (orgId) await ensureMembership(orgId, user.id, 'MEMBER');
    await prisma.registrationRequest.update({
      where: { id: reqRow.id },
      data: { status: 'approved', decidedAt: new Date(), decidedById },
    });
    sendEmail({
      to: reqRow.email,
      template: 'registration-approved',
      subject: et('emails.registrationApproved.subject', { ws: wsName }),
      text: et('emails.registrationApproved.text', { url: loginUrl }),
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;background:#0f1115;border-radius:14px;color:#e8eaed"><div style="font-size:20px;font-weight:700;margin-bottom:8px">${wsName}</div><p style="color:#9aa0a6;margin:0 0 16px">${et('emails.registrationApproved.body')}</p>${appUrl ? `<a href="${loginUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${et('emails.registrationApproved.signInButton')}</a>` : ''}</div>`,
    }).catch(() => {});
    return NextResponse.json({ ok: true, user });
  }

  if (action === 'deny') {
    await prisma.registrationRequest.update({
      where: { id: reqRow.id },
      data: { status: 'denied', decidedAt: new Date(), decidedById },
    });
    sendEmail({
      to: reqRow.email,
      template: 'registration-denied',
      subject: et('emails.registrationDenied.subject', { ws: wsName }),
      text: et('emails.registrationDenied.text'),
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:28px 24px;background:#0f1115;border-radius:14px;color:#e8eaed"><div style="font-size:20px;font-weight:700;margin-bottom:8px">${wsName}</div><p style="color:#9aa0a6;margin:0">${et('emails.registrationDenied.body')}</p></div>`,
    }).catch(() => {});
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: t('unknownAction') }, { status: 400 });
}

export const GET = withRoute('users.requests.list', getHandler);
export const POST = withRoute('users.requests.decide', postHandler);
