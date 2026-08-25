import { prisma } from './prisma';
import { filterSuppressed } from './suppression';
import { sendEmail } from './email';
import { getTranslator, workspaceLocale } from './i18n-server';
import { publicBaseUrl } from './config';
import { esc } from './email/html';
import { tasksForReport } from './tasks';

/**
 * Build and send the latest meeting report to participants.
 * - respectPref: skip users whose preferences.emailReport === false (used by auto-send).
 */
export async function sendReportEmail(
  meetingId: string,
  opts?: { respectPref?: boolean; extraRecipient?: string },
): Promise<{ ok: boolean; recipients?: number; error?: string }> {
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: {
      createdBy: { select: { email: true } },
      participants: { include: { user: { select: { email: true, preferences: true, status: true } } } },
      reports: {
        orderBy: { generatedAt: 'desc' },
        take: 1,
      },
    },
  });
  // Report emails go out in the workspace (admin-chosen) language.
  const locale = await workspaceLocale();
  const t = getTranslator(locale);
  if (!meeting) return { ok: false, error: t('emails.report.errors.meetingNotFound') };
  const report = meeting.reports[0];
  if (!report) return { ok: false, error: t('emails.report.errors.notGenerated') };

  const emails = new Set<string>();
  if (meeting.createdBy?.email) emails.add(meeting.createdBy.email);
  for (const p of meeting.participants) {
    if (p.user?.status === 'disabled') continue; // blocked account — no meeting content by mail
    if (p.user?.email) {
      if (opts?.respectPref) {
        const prefs = (p.user.preferences as any) || {};
        if (prefs.emailReport === false) continue;
      }
      emails.add(p.user.email);
    }
    if (p.guestEmail) emails.add(p.guestEmail);
  }
  // A report carries the whole discussion, so a deleted person receiving one is the
  // costliest form of this bug. They survive on the participant list as a
  // calendar-imported guest — see lib/suppression.
  const kept = await filterSuppressed(emails);
  // An explicit "send it to this address" from an admin is a deliberate act, not a
  // stale list, so it is added after the filter rather than being subject to it.
  if (opts?.extraRecipient) kept.push(opts.extraRecipient);
  const recipients = [...new Set(kept)];
  if (recipients.length === 0) return { ok: false, error: t('emails.report.errors.noRecipients') };

  const decisions = (Array.isArray(report.decisions) ? report.decisions : []) as any[];
  const followUps = (Array.isArray(report.followUps) ? report.followUps : []) as any[];
  const tasks = await tasksForReport(report.id);
  const appUrl = await publicBaseUrl();
  const reportUrl = `${appUrl}/meetings/${meetingId}/report`;

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

  const result = await sendEmail({ to: recipients, subject: t('emails.report.subject', { title: meeting.title }), html, text, meetingId, template: 'report' });
  return result.ok ? { ok: true, recipients: recipients.length } : { ok: false, error: result.error };
}
