import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { getTranslator, workspaceLocale, reportLocale, languageName } from '@/lib/i18n-server';
import { publicBaseUrl } from '@/lib/config';
import { esc } from '@/lib/email/html';
import { withRoute } from '@/lib/with-route';
import { getSingletonOrgId } from '@/lib/org';
import { digestTaskTitlesForUser } from '@/lib/tasks';
import { aiWeeklyRollup } from '@/lib/ai-rollup';

// GET /api/cron/digest?secret=XXX — weekly digest for users who enabled it.
async function getHandler(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret');
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const now = new Date();
  const weekStart = new Date(now.getTime() - 7 * 86400000);
  const appUrl = await publicBaseUrl();

  const users = await prisma.user.findMany({
    where: {
      email: { not: null },
      preferences: { path: ['weeklyDigest'], equals: true },
    },
    select: { id: true, email: true, name: true },
  });

  // Digest emails go out in the workspace (admin-chosen) UI language...
  const locale = await workspaceLocale();
  const t = getTranslator(locale);
  // ...but the AI "where to focus" rollup follows the AI-output language.
  const rollupLang = languageName(await reportLocale());
  const orgId = (await getSingletonOrgId()) || '';

  // One user's digest. Extracted so the per-user AI rollups run in bounded-
  // concurrency batches (below) rather than strictly serially — N×(AI timeout)
  // serial would exceed the cron request timeout.
  const sendOne = async (u: (typeof users)[number]): Promise<boolean> => {
    if (!u.email) return false;
    const [tasks, meetingCount] = await Promise.all([
      digestTaskTitlesForUser(orgId, u.id, 25),
      prisma.meetingParticipant.count({
        where: { userId: u.id, meeting: { endedAt: { gte: weekStart } } },
      }),
    ]);

    if (tasks.length === 0 && meetingCount === 0) return false;

    // P4.3: a short AI "where to focus this week" rollup (best-effort — null on
    // any error/timeout/no-key, so the digest always still sends its task list).
    const rollup = await aiWeeklyRollup({
      name: u.name,
      taskTitles: tasks.map((tk) => tk.title),
      meetingCount,
      langName: rollupLang,
    });

    const tasksHtml = tasks.length
      ? `<ul style="margin:0;padding-left:18px;color:#c4c9d4;font-size:14px;line-height:1.6">${tasks.map((tk) => `<li>${esc(tk.title)}</li>`).join('')}</ul>`
      : `<p style="color:#9aa0a6;margin:0">${esc(t('emails.digest.noOpenTasks'))}</p>`;

    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:28px 26px;background:#0f1115;border-radius:16px;color:#e8eaed">
      <div style="font-size:13px;color:#60a5fa;text-transform:uppercase;letter-spacing:.08em;font-weight:700">${esc(t('emails.digest.eyebrow'))}</div>
      <div style="font-size:21px;font-weight:700;margin:4px 0 14px">${esc(u.name ? t('emails.digest.greetingNamed', { name: u.name }) : t('emails.digest.greeting'))}</div>
      ${rollup ? `<p style="color:#dfe3ea;font-size:14px;line-height:1.6;margin:0 0 16px;padding:12px 14px;background:#171a21;border-left:3px solid #60a5fa;border-radius:8px">${esc(rollup)}</p>` : ''}
      <p style="color:#c4c9d4;font-size:14px;margin:0 0 16px">${t.rich('emails.digest.meetingsLine', { count: meetingCount, b: (c: any) => `<b style="color:#e8eaed">${c}</b>` })}</p>
      <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">${esc(t('emails.digest.openTasksHeading', { count: tasks.length }))}</div>
      ${tasksHtml}
      ${appUrl ? `<a href="${appUrl}/tasks" style="display:inline-block;margin-top:22px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">${esc(t('emails.digest.cta'))} →</a>` : ''}
    </div>`;

    const text = `${t('emails.digest.eyebrow')}\n\n${rollup ? `${rollup}\n\n` : ''}${t('emails.digest.meetingsLineText', { count: meetingCount })}\n${t('emails.digest.openTasksHeading', { count: tasks.length })}:\n${tasks.map((tk) => `- ${tk.title}`).join('\n')}${appUrl ? `\n\n${appUrl}/tasks` : ''}`;

    const r = await sendEmail({ to: u.email, subject: t('emails.digest.subject'), html, text, template: 'digest' });
    return r.ok;
  };

  // Bounded-concurrency batches: rollup AI calls overlap, so the whole digest
  // stays well under the cron request timeout regardless of user count.
  let sent = 0;
  const BATCH = 8;
  for (let i = 0; i < users.length; i += BATCH) {
    const results = await Promise.all(users.slice(i, i + BATCH).map(sendOne));
    sent += results.filter(Boolean).length;
  }

  return NextResponse.json({ users: users.length, sent });
}

export const GET = withRoute('cron.digest', getHandler);
