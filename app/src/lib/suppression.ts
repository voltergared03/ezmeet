import { prisma } from './prisma';

/**
 * Email suppression list — addresses Garely must never mail again.
 *
 * Deleting a user does not, by itself, stop their mail. Two things keep it flowing:
 * their MeetingParticipant rows survive the delete with `userId` nulled (SetNull), and
 * the Google Calendar sync re-imports every event attendee it cannot match to a User as
 * an ordinary GUEST — storing the raw address on the participant row. A deleted person
 * was therefore back as a guest within one sync cycle, receiving invites, reminders and
 * reports, with no user record left for an admin to delete a second time.
 *
 * A tombstone written at deletion time is what breaks that loop, because it outlives the
 * User row that the rest of the system keys on. It doubles as the answer for an address
 * that was never a user at all — an old company domain still sitting on shared calendar
 * events, say — which is why `reason` is free-form rather than a boolean.
 */

/** Stop mailing this address. Idempotent. */
export async function suppressEmail(email: string | null | undefined, reason = 'user_deleted'): Promise<void> {
  const e = norm(email);
  if (!e) return;
  try {
    await prisma.suppressedEmail.upsert({
      where: { email: e },
      update: { reason },
      create: { email: e, reason },
    });
  } catch {
    // Best-effort: failing to write the tombstone must not fail the deletion itself.
  }
}

/** Allow this address again — called whenever a user is (re-)created with it. */
export async function unsuppressEmail(email: string | null | undefined): Promise<void> {
  const e = norm(email);
  if (!e) return;
  try {
    await prisma.suppressedEmail.deleteMany({ where: { email: e } });
  } catch {
    // Best-effort: never block creating a user over the tombstone table.
  }
}

/**
 * Drop every suppressed address from a recipient list. One query for the whole list —
 * these run on the send path, which fans out to every participant of a meeting.
 * Fails OPEN: a database hiccup must not silently swallow a meeting invitation.
 */
export async function filterSuppressed(emails: Iterable<string>): Promise<string[]> {
  const list = [...new Set([...emails].map(norm).filter((e): e is string => !!e))];
  if (list.length === 0) return [];
  try {
    const hits = await prisma.suppressedEmail.findMany({ where: { email: { in: list } }, select: { email: true } });
    if (hits.length === 0) return list;
    const blocked = new Set(hits.map((h) => h.email));
    return list.filter((e) => !blocked.has(e));
  } catch {
    return list;
  }
}

/** True when this one address is suppressed. Fails OPEN, as above. */
export async function isSuppressed(email: string | null | undefined): Promise<boolean> {
  const e = norm(email);
  if (!e) return false;
  try {
    return !!(await prisma.suppressedEmail.findUnique({ where: { email: e }, select: { email: true } }));
  } catch {
    return false;
  }
}

function norm(email: string | null | undefined): string | null {
  const e = (email || '').trim().toLowerCase();
  return e || null;
}
