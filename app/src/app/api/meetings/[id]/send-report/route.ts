import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { sendEmail } from '@/lib/email';
import { userCanAccessMeeting } from '@/lib/access';
import { publicBaseUrl } from '@/lib/config';
import { getTranslator, workspaceLocale } from '@/lib/i18n-server';
import { esc } from '@/lib/email/html';
import { withRoute } from '@/lib/with-route';
import { tasksForReport } from '@/lib/tasks';
import { filterSuppressed } from '@/lib/suppression';

// POST — email the meeting report (summary, decisions, action items, follow-ups) to participants
async function postHandler(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id } = await params;
  if (!(await userCanAccessMeeting(id, session.user.id, session.user.role))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // The report email goes out in the workspace (admin-chosen) language.
  const locale = await workspaceLocale();
  const t = getTranslator(locale);

  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      createdBy: { select: { email: true } },
      participants: { include: { user: { select: { email: true, status: true } } } },
      reports: {
        orderBy: { generatedAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!meeting) return NextResponse.json({ error: t('emails.report.errors.meetingNotFound') }, { status: 404 });
  const report = meeting.reports[0];
  if (!report) return NextResponse.json({ error: t('emails.report.errors.notGenerated') }, { status: 400 });

  // Recipients: creator + participant users + guest emails + requester
  const emails = new Set<string>();
  if (meeting.createdBy?.email) emails.add(meeting.createdBy.email);
  for (const p of meeting.participants) {
    if (p.user?.status === 'disabled') continue; // blocked account — no meeting content by mail
    if (p.user?.email) emails.add(p.user.email);
    if (p.guestEmail) emails.add(p.guestEmail);
  }
  // Deleted people survive on the participant list as calendar-imported guests, and a
  // report is the whole discussion — see lib/suppression.
  const kept = await filterSuppressed(emails);
  // The requester asked for this copy, so they get it regardless of the list.
  const reqEmail = session.user.email;
  if (reqEmail) kept.push(reqEmail);
  const recipients = [...new Set(kept)];
  if (recipients.length === 0) return NextResponse.json({ error: t('emails.report.errors.noRecipients') }, { status: 400 });

  const decisions = (Array.isArray(report.decisions) ? report.decisions : []) as any[];
  const followUps = (Array.isArray(report.followUps) ? report.followUps : []) as any[];
  const tasks = await tasksForReport(report.id);
  const appUrl = await publicBaseUrl();
  const reportUrl = `${appUrl}/meetings/${id}/report`;

  const section = (title: string, inner: string) =>
    inner ? `<div style="margin:18px 0 0"><div style="font-size:13px;font-weight:700;color:#e8eaed;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">${title}</div>${inner}</div>` : '';
  const list = (items: string[]) =>
    items.length ? `<ul style="margin:0;padding-left:18px;color:#c4c9d4;font-size:14px;line-height:1.6">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '';

  const tasksHtml = tasks.length
    ? `<ul style="margin:0;padding-left:18px;color:#c4c9d4;font-size:14px;line-height:1.6">${tasks
        .map((tk) => `<li>${esc(tk.title)}${tk.assigneeName ? ` — <b style="color:#e8eaed">${esc(tk.assigneeName)}</b>` : ''}</li>`)
        .join('')}</ul>`
    : '';

  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:620px;margin:0 auto;padding:28px 26px;background:#0f1115;border-radius:16px;color:#e8eaed">
    <div style="font-size:13px;color:#60a5fa;text-transform:uppercase;letter-spacing:.08em;font-weight:700">${esc(t('emails.report.eyebrow'))}</div>
    <div style="font-size:22px;font-weight:700;margin:4px 0 2px">${esc(meeting.title)}</div>
    ${report.summary ? `<p style="color:#c4c9d4;font-size:14px;line-height:1.6;margin:14px 0 0">${esc(report.summary)}</p>` : ''}
    ${section(esc(t('emails.report.sections.decisions')), list(decisions.map((d) => (typeof d === 'string' ? d : d?.text || ''))))}
    ${section(esc(t('emails.report.sections.actionItems')), tasksHtml)}
    ${section(esc(t('emails.report.sections.followUps')), list(followUps.map((f) => (typeof f === 'string' ? f : f?.text || ''))))}
    ${appUrl ? `<a href="${reportUrl}" style="display:inline-block;margin-top:22px;background:#2563eb;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:10px">${esc(t('emails.report.cta'))} →</a>` : ''}
  </div>`;

  const text = [
    `${t('emails.report.subject', { title: meeting.title })}`,
    report.summary ? `\n${report.summary}` : '',
    decisions.length ? `\n${t('emails.report.sections.decisions')}:\n${decisions.map((d) => `- ${typeof d === 'string' ? d : d?.text || ''}`).join('\n')}` : '',
    tasks.length ? `\n${t('emails.report.sections.actionItems')}:\n${tasks.map((tk) => `- ${tk.title}${tk.assigneeName ? ` (${tk.assigneeName})` : ''}`).join('\n')}` : '',
    followUps.length ? `\n${t('emails.report.sections.followUps')}:\n${followUps.map((f) => `- ${typeof f === 'string' ? f : f?.text || ''}`).join('\n')}` : '',
    appUrl ? `\n\n${t('emails.report.fullReport')}: ${reportUrl}` : '',
  ].filter(Boolean).join('\n');

  const result = await sendEmail({ to: recipients, subject: t('emails.report.subject', { title: meeting.title }), html, text, meetingId: id, template: 'report' });
  if (!result.ok) return NextResponse.json({ error: result.error || t('emails.common.sendFailed') }, { status: 502 });
  return NextResponse.json({ success: true, recipients: recipients.length });
}

export const POST = withRoute('meetings.send-report', postHandler);
