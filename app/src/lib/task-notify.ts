/**
 * Task notifications — in-app (via notify) + email — for assignment and key
 * changes. Email is gated per-recipient on `preferences.actionItemNotif` and
 * rendered in the workspace locale. All functions are best-effort (never throw).
 */
import { prisma } from "./prisma";
import { sendEmail } from "./email";
import { notify } from "./notify";
import { getTranslator, workspaceLocale, workspaceTimezone } from "./i18n-server";
import { publicBaseUrl } from "./config";
import { esc } from "./email/html";
import { getSystemTasksTable } from "./system-tasks-table";

/** Load a task Row's notify essentials (it's a base-engine Row now). */
async function loadTaskForNotify(taskId: string) {
  const row = await prisma.row.findUnique({
    where: { id: taskId },
    select: {
      data: true,
      taskMeta: { select: { meetingId: true } },
      assignments: { select: { userId: true } },
      collaborators: { select: { userId: true } },
      table: { select: { base: { select: { orgId: true } } } },
    },
  });
  if (!row) return null;
  const prov = await getSystemTasksTable(row.table.base.orgId);
  if (!prov) return null;
  const data = (row.data ?? {}) as Record<string, unknown>;
  const dueRaw = data[prov.fieldIds.dueDate];
  return {
    title: String(data[prov.fieldIds.title] ?? ""),
    dueDate: typeof dueRaw === "string" && dueRaw ? new Date(dueRaw) : null,
    meetingId: row.taskMeta?.meetingId ?? null,
    assigneeIds: row.assignments.map((a) => a.userId),
    collaboratorIds: row.collaborators.map((c) => c.userId),
  };
}

export interface Actor {
  id: string;
  name?: string | null;
}

type Recipient = { id: string; email: string | null; preferences: unknown };

/** Who should receive a task email: not the actor, has an address, hasn't muted task notifications. */
export function pickEmailRecipients(users: Recipient[], actorId: string): string[] {
  const seen = new Set<string>();
  for (const u of users) {
    if (u.id === actorId || !u.email) continue;
    if ((u.preferences as Record<string, unknown> | null)?.actionItemNotif === false) continue;
    seen.add(u.email);
  }
  return [...seen];
}

function fmtDate(d: Date, locale: string, tz?: string): string {
  try {
    return new Date(d).toLocaleDateString(locale === "uk" ? "uk-UA" : "en-US", {
      day: "numeric", month: "short", year: "numeric",
      ...(tz ? { timeZone: tz } : {}), // a due date can shift a day if formatted in UTC
    });
  } catch {
    return new Date(d).toISOString().slice(0, 10);
  }
}

type T = ReturnType<typeof getTranslator>;

function shell(t: T, opts: { heading: string; sub: string; rows: string[]; ctaUrl: string }): string {
  const rows = opts.rows.filter(Boolean).map((r) => `<div style="font-size:14px;color:#c4c9d4;line-height:1.6;margin:5px 0">${r}</div>`).join("");
  return `<div style="background:#0f1115;padding:28px 16px;font-family:-apple-system,'Segoe UI',Roboto,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#181a20;border:1px solid #2a2d36;border-radius:14px;padding:24px">
    <div style="font-size:17px;font-weight:700;color:#e8eaed;margin-bottom:6px">${esc(opts.heading)}</div>
    <div style="font-size:13px;color:#8b90a0;margin-bottom:16px">${esc(opts.sub)}</div>
    ${rows}
    <a href="${esc(opts.ctaUrl)}" style="display:inline-block;margin-top:20px;background:#3b82f6;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 20px;border-radius:8px">${esc(t("emails.task.cta"))}</a>
  </div>
</div>`;
}

function statusLabel(t: T, s: string): string {
  return s === "done" ? t("tasks.statusDone") : s === "in_progress" ? t("tasks.statusInProgress") : t("tasks.statusOpenSingular");
}

/** A task was assigned to `assigneeId`. Notifies + emails them (unless they are the actor). */
export async function notifyTaskAssigned(taskId: string, assigneeId: string | null | undefined, actor: Actor): Promise<void> {
  try {
    if (!assigneeId || assigneeId === actor.id) return;
    const task = await loadTaskForNotify(taskId);
    if (!task) return;
    const meetingTitle = task.meetingId
      ? (await prisma.meeting.findUnique({ where: { id: task.meetingId }, select: { title: true } }))?.title ?? null
      : null;

    await notify({
      userIds: [assigneeId],
      type: "task_assigned",
      titleKey: "taskAssignedTitle",
      body: task.title,
      link: `/tasks?task=${taskId}`,
    });

    const u = await prisma.user.findUnique({ where: { id: assigneeId }, select: { email: true, preferences: true } });
    if (!u?.email || (u.preferences as Record<string, unknown> | null)?.actionItemNotif === false) return;

    const locale = await workspaceLocale();
    const tz = await workspaceTimezone();
    const t = getTranslator(locale);
    const url = `${await publicBaseUrl()}/tasks?task=${taskId}`;
    const rows = [
      `<strong style="color:#e8eaed">${esc(task.title)}</strong>`,
      task.dueDate ? `${esc(t("emails.task.dueLabel"))}: ${esc(fmtDate(task.dueDate, locale, tz))}` : "",
      meetingTitle ? `${esc(t("emails.task.meetingLabel"))}: ${esc(meetingTitle)}` : "",
    ];
    await sendEmail({
      to: u.email,
      template: "task_assigned",
      subject: t("emails.task.assignedSubject", { title: task.title }),
      html: shell(t, { heading: t("emails.task.assignedHeading"), sub: t("emails.task.assignedBy", { name: actor.name || "" }), rows, ctaUrl: url }),
      text: `${t("emails.task.assignedHeading")}: ${task.title}\n${url}`,
    });
  } catch {
    /* best-effort */
  }
}

/** A task's status and/or due date changed. Notifies + emails assignee + collaborators (minus the actor). */
export async function notifyTaskUpdated(
  taskId: string,
  changes: { status?: string; dueDate?: Date | null },
  actor: Actor,
): Promise<void> {
  try {
    if (changes.status === undefined && changes.dueDate === undefined) return;
    const task = await loadTaskForNotify(taskId);
    if (!task) return;

    // Recipients = ALL assignees (multi-assignee) + collaborators, minus the actor.
    const ids = new Set<string>();
    for (const uid of task.assigneeIds) ids.add(uid);
    for (const uid of task.collaboratorIds) ids.add(uid);
    ids.delete(actor.id);
    if (ids.size === 0) return;

    await notify({
      userIds: [...ids],
      type: "task_updated",
      titleKey: "taskUpdatedTitle",
      body: task.title,
      link: `/tasks?task=${taskId}`,
    });

    const users = await prisma.user.findMany({ where: { id: { in: [...ids] } }, select: { id: true, email: true, preferences: true } });
    const emails = pickEmailRecipients(users, actor.id);
    if (emails.length === 0) return;

    const locale = await workspaceLocale();
    const tz = await workspaceTimezone();
    const t = getTranslator(locale);
    const url = `${await publicBaseUrl()}/tasks?task=${taskId}`;
    const rows = [`<strong style="color:#e8eaed">${esc(task.title)}</strong>`];
    if (changes.status !== undefined) rows.push(esc(t("emails.task.changeStatus", { value: statusLabel(t, changes.status) })));
    if (changes.dueDate !== undefined) rows.push(esc(t("emails.task.changeDue", { value: changes.dueDate ? fmtDate(changes.dueDate, locale, tz) : "—" })));

    const html = shell(t, { heading: t("emails.task.updatedHeading"), sub: t("emails.task.updatedBy", { name: actor.name || "" }), rows, ctaUrl: url });
    const text = `${t("emails.task.updatedHeading")}: ${task.title}\n${url}`;
    // One email each — don't expose teammates' addresses to one another.
    await Promise.all(
      emails.map((to) => sendEmail({ to, template: "task_updated", subject: t("emails.task.updatedSubject", { title: task.title }), html, text })),
    );
  } catch {
    /* best-effort */
  }
}
