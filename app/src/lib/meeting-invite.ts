/**
 * Meeting invitations — an email with an attached .ics (so it drops into the
 * recipient's calendar) plus Join / Add-to-Google-Calendar / Add-to-calendar
 * buttons. Sent on schedule (invite), reschedule (update) and delete (cancel).
 * Goes to the creator + all participants/guests with an email. Best-effort.
 */
import { prisma } from "./prisma";
import { sendEmail, getSmtpConfig } from "./email";
import { getTranslator, workspaceLocale, workspaceTimezone } from "./i18n-server";
import { publicBaseUrl } from "./config";
import { esc } from "./email/html";
import { buildCalendar, googleCalendarUrl, type IcsEvent } from "./ics";

export type InviteKind = "invite" | "update" | "cancel";

export async function sendMeetingInvite(meetingId: string, kind: InviteKind = "invite"): Promise<void> {
  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true, title: true, description: true, scheduledAt: true, durationMin: true, joinToken: true, recurrence: true,
        createdBy: { select: { name: true, email: true } },
        participants: { select: { guestName: true, guestEmail: true, user: { select: { name: true, email: true } } } },
      },
    });
    if (!meeting?.scheduledAt) return; // only scheduled meetings get calendar invites

    // Recipients: creator + participants + guests, deduped by email.
    const recips = new Map<string, string | null>();
    if (meeting.createdBy?.email) recips.set(meeting.createdBy.email, meeting.createdBy.name);
    for (const p of meeting.participants) {
      if (p.user?.email) recips.set(p.user.email, p.user.name);
      else if (p.guestEmail) recips.set(p.guestEmail, p.guestName);
    }
    if (recips.size === 0) return;
    const attendees = [...recips.entries()].map(([email, name]) => ({ email, name }));

    const start = meeting.scheduledAt;
    const end = new Date(start.getTime() + (meeting.durationMin || 60) * 60_000);
    const appUrl = await publicBaseUrl();
    // ONE canonical link everywhere (email body, .ics, Google Calendar): the
    // token-based /join URL. It resolves the CURRENT occurrence of a series (the
    // token migrates forward as recurrences materialize) and works for guests AND
    // signed-in users alike. A raw /room/{id} link is a dead end for guests, so we
    // only fall back to it when a meeting somehow has no joinToken.
    const joinUrl = meeting.joinToken ? `${appUrl}/join/${meeting.joinToken}` : `${appUrl}/room/${meeting.id}`;
    const locale = await workspaceLocale();
    const tz = await workspaceTimezone();
    const t = getTranslator(locale);

    // The ORGANIZER email MUST equal the authenticated From address (the SMTP
    // sender), or Gmail/Google Calendar reject the REQUEST (DKIM/DMARC) and never
    // add the event — even with a valid calendar part. We keep the meeting
    // creator's NAME as the display CN but use the sending address as the email.
    const smtp = await getSmtpConfig();
    const organizerEmail = smtp?.from || meeting.createdBy?.email || null;

    // Recurring meetings ship a single RRULE event so Google/Outlook draw ONE
    // repeating entry (not N copies). Combined with the migrating joinToken, the
    // same /join link always points at the next live occurrence.
    const recType = (meeting.recurrence as { type?: string } | null)?.type;
    const RRULE: Record<string, string> = {
      daily: "FREQ=DAILY",
      weekly: "FREQ=WEEKLY",
      biweekly: "FREQ=WEEKLY;INTERVAL=2",
      monthly: "FREQ=MONTHLY",
    };
    const rrule = recType ? RRULE[recType] : undefined;

    const method = kind === "cancel" ? "CANCEL" : "REQUEST";
    const event: IcsEvent = {
      uid: `meeting-${meeting.id}@ezmeet`,
      start, end,
      summary: meeting.title,
      description: meeting.description ? `${meeting.description}\n\n${joinUrl}` : joinUrl,
      location: joinUrl,
      url: joinUrl,
      stamp: new Date(),
      rrule,
      // invite=0; later changes use a monotonically increasing unix-second SEQUENCE
      sequence: kind === "invite" ? 0 : Math.floor(Date.now() / 1000),
      status: kind === "cancel" ? "CANCELLED" : "CONFIRMED",
      organizer: organizerEmail ? { email: organizerEmail, name: meeting.createdBy?.name } : undefined,
      attendees,
    };
    const ics = buildCalendar({ name: meeting.title, method, events: [event] });

    const when = start.toLocaleString(locale === "uk" ? "uk-UA" : "en-US", {
      weekday: "short", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
      timeZone: tz, // render in the workspace zone, not the server's UTC
    });
    const heading =
      kind === "cancel" ? t("emails.inviteMeeting.cancelledHeading")
      : kind === "update" ? t("emails.inviteMeeting.updatedHeading")
      : t("emails.inviteMeeting.heading");
    const subject =
      kind === "cancel" ? t("emails.inviteMeeting.cancelledSubject", { title: meeting.title })
      : kind === "update" ? t("emails.inviteMeeting.updatedSubject", { title: meeting.title })
      : t("emails.inviteMeeting.subject", { title: meeting.title });

    const gcalUrl = googleCalendarUrl({ title: meeting.title, start, end, details: joinUrl, location: joinUrl });
    const icsUrl = meeting.joinToken ? `${appUrl}/api/meetings/${meeting.id}/invite.ics?token=${meeting.joinToken}` : "";
    const btn = (href: string, label: string, primary = false) =>
      `<a href="${esc(href)}" style="display:inline-block;margin:6px 8px 0 0;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;${primary ? "background:#3b82f6;color:#fff" : "background:#23262f;color:#e8eaed;border:1px solid #2a2d36"}">${esc(label)}</a>`;
    const buttons = kind === "cancel" ? "" : [
      btn(joinUrl, t("emails.inviteMeeting.join"), true),
      btn(gcalUrl, t("emails.inviteMeeting.addGoogle")),
      icsUrl ? btn(icsUrl, t("emails.inviteMeeting.addIcs")) : "",
    ].filter(Boolean).join("");

    const titleStyle = kind === "cancel" ? "text-decoration:line-through;color:#9aa0a6" : "color:#e8eaed";
    const html = `<div style="background:#0f1115;padding:28px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#181a20;border:1px solid #2a2d36;border-radius:14px;padding:24px">
    <div style="font-size:17px;font-weight:700;color:#e8eaed;margin-bottom:10px">${esc(heading)}</div>
    <div style="font-size:16px;font-weight:600;margin:0 0 4px;${titleStyle}">${esc(meeting.title)}</div>
    <div style="font-size:14px;color:#c4c9d4">${esc(when)}</div>
    ${meeting.createdBy?.name ? `<div style="font-size:12px;color:#8b90a0;margin-top:4px">${esc(t("emails.inviteMeeting.organizer", { name: meeting.createdBy.name }))}</div>` : ""}
    ${buttons ? `<div style="margin-top:16px">${buttons}</div>` : ""}
  </div>
</div>`;
    const text = `${heading}: ${meeting.title}\n${when}\n${joinUrl}`;
    // Deliver the .ics as a multipart/alternative (text/calendar; method=…) via
    // nodemailer's icalEvent — NOT a plain attachment. This is what makes Gmail /
    // Google Calendar / Outlook render the RSVP card and actually add the event;
    // a bare attachment shows "failed to load event" and never lands in calendar.
    const icalEvent = { method, content: ics };

    // One email each (don't expose the attendee list in the To header).
    await Promise.all(
      attendees.map((a) => sendEmail({ to: a.email, subject, html, text, template: `meeting_${kind}`, meetingId: meeting.id, icalEvent })),
    );
  } catch {
    /* best-effort */
  }
}
