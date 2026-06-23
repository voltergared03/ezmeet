import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { notify } from '@/lib/notify';
import { notifyChatMeetingReminder } from '@/lib/chat-notify';
import { notifyWebhookMeetingReminder } from '@/lib/webhooks';
import { getTranslator, workspaceLocale } from '@/lib/i18n-server';
import { publicBaseUrl } from '@/lib/config';
import { esc } from '@/lib/email/html';
import { withRoute } from '@/lib/with-route';

// GET /api/cron/reminders?secret=XXX — called by system cron (every few minutes).
// Sends "meeting starting soon" in-app notifications + emails ~15 min before start.
async function getHandler(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();
  const in15 = new Date(now.getTime() + 15 * 60000);

  const meetings = await prisma.meeting.findMany({
    where: {
      status: 'scheduled',
      reminderSent: false,
      scheduledAt: { gt: now, lte: in15 },
    },
    include: {
      participants: { include: { user: { select: { id: true, email: true, preferences: true } } } },
    },
  });

  const appUrl = await publicBaseUrl();
  // Reminder emails are a single batched send to mixed recipients (members +
  // guests), so they go out in the workspace's default language.
  const locale = await workspaceLocale();
  const t = getTranslator(locale);
  let notified = 0;
  let emailed = 0;

  for (const m of meetings) {
    const startStr = m.scheduledAt
      ? new Date(m.scheduledAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
      : '';

    // In-app notifications for participant users
    const userIds = m.participants.map((p) => p.user?.id).filter((x): x is string => !!x);
    if (userIds.length > 0) {
      await notify({
        userIds,
        type: 'meeting_starting',
        titleKey: 'meetingStartingTitle',
        bodyKey: 'meetingStartingBody',
        values: { title: m.title, time: startStr },
        link: `/lobby/${m.id}`,
        meetingId: m.id,
      });
      notified += userIds.length;
    }

    // Emails — respect each user's emailReminder preference; always send to guests
    const emails = new Set<string>();
    for (const p of m.participants) {
      if (p.user?.email) {
        const prefs = (p.user.preferences as any) || {};
        if (prefs.emailReminder !== false) emails.add(p.user.email);
      }
      if (p.guestEmail) emails.add(p.guestEmail);
    }
    if (emails.size > 0) {
      const joinUrl = `${appUrl}/lobby/${m.id}`;
      await sendEmail({
        to: [...emails],
        template: 'reminder',
        meetingId: m.id,
        subject: t('emails.reminder.subject', { title: m.title, time: startStr }),
        text: t('emails.reminder.text', { title: m.title, time: startStr, url: joinUrl }),
        html: `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0f1115;border-radius:16px;color:#e8eaed">
          <div style="font-size:13px;color:#60a5fa;text-transform:uppercase;letter-spacing:.08em;font-weight:700">${t('emails.reminder.label')}</div>
          <div style="font-size:21px;font-weight:700;margin:4px 0 6px">${esc(m.title)}</div>
          <p style="color:#9aa0a6;margin:0 0 18px">${t('emails.reminder.startsBefore')} <b style="color:#e8eaed">${startStr}</b> ${t('emails.reminder.startsAfter')}</p>
          ${appUrl ? `<a href="${joinUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;padding:10px 18px;border-radius:10px">${t('emails.reminder.joinButton')}</a>` : ''}
        </div>`,
      }).catch(() => {});
      emailed += emails.size;
    }

    // Team chat reminder (opt-in; fire-and-forget).
    void notifyChatMeetingReminder(m.id, m.title, startStr);
    // Outbound webhook reminder (opt-in; fire-and-forget).
    void notifyWebhookMeetingReminder(m.id, m.title, startStr);

    await prisma.meeting.update({ where: { id: m.id }, data: { reminderSent: true } }).catch(() => {});
  }

  return NextResponse.json({ processed: meetings.length, notified, emailed });
}

export const GET = withRoute('cron.reminders', getHandler);
