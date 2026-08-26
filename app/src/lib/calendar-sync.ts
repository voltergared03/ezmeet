/**
 * Google Calendar ↔ Garely two-way sync engine.
 *
 * Scope: ONE dedicated "Garely" calendar per connected user (never their
 * personal calendars). Inbound uses incremental `events.list` with a
 * syncToken (full resync on 410); outbound writes Garely meetings into the
 * same calendar.
 *
 * Loop guard: every write WE make to Google stores the returned `etag` on the
 * meeting (`externalEtag`). Inbound skips any event whose etag equals the one
 * we stored — that change is ours (or already processed). A Garely-originated
 * event additionally carries `extendedProperties.private.garelyMeetingId`.
 *
 * v1 limits (documented): all-day events and recurring MASTERS in Google are
 * skipped (a meeting needs a concrete start time; Garely's own recurrence
 * already materializes per-occurrence and each occurrence syncs as a single
 * event). Attendee sync is add-only.
 */
import crypto from 'crypto';
import { prisma } from './prisma';
import { filterSuppressed } from './suppression';
import { generateMeetingSlug } from './utils';
import { readConfig, num, publicBaseUrl } from './config';
import { getSingletonOrgId } from './org';
import {
  gcalFetch, saveTokens, ensureGarelyCalendar, emailFromIdToken, GCAL_SCOPE,
} from './google-calendar';
import type { GoogleCalendarConnection, Meeting } from '@prisma/client';

interface GEvent {
  id: string;
  etag?: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  attendees?: { email?: string; resource?: boolean; organizer?: boolean }[];
  extendedProperties?: { private?: Record<string, string> };
}

/* ── Inbound: Google → Garely ───────────────────────────────────── */

export interface SyncResult {
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
}

/**
 * Incrementally sync one connection's Garely calendar into Garely meetings.
 * Stores the fresh syncToken + lastSyncedAt on success.
 */
export async function syncConnection(conn: GoogleCalendarConnection): Promise<SyncResult> {
  if (!conn.calendarId || conn.status === 'revoked') return { created: 0, updated: 0, cancelled: 0, skipped: 0 };
  const res: SyncResult = { created: 0, updated: 0, cancelled: 0, skipped: 0 };

  let pageToken: string | undefined;
  let syncToken = conn.syncToken || undefined;
  let nextSyncToken: string | undefined;

  for (let page = 0; page < 20; page++) {
    const p = new URLSearchParams({ maxResults: '250', showDeleted: 'true' });
    if (pageToken) p.set('pageToken', pageToken);
    else if (syncToken) p.set('syncToken', syncToken);
    const r = await gcalFetch(conn, `/calendars/${encodeURIComponent(conn.calendarId)}/events?${p.toString()}`);

    if (r.status === 410) {
      // Sync token expired — Google demands a full resync. Drop it and restart.
      syncToken = undefined;
      pageToken = undefined;
      await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { syncToken: null } });
      continue;
    }
    if (!r.ok) throw new Error(`events.list ${r.status}: ${(await r.text()).slice(0, 300)}`);

    const body = await r.json();
    for (const ev of (body.items || []) as GEvent[]) {
      try {
        const out = await applyGoogleEvent(conn, ev);
        res[out]++;
      } catch (e) {
        console.error(`gcal inbound: event ${ev.id} failed:`, e);
        res.skipped++;
      }
    }

    if (body.nextPageToken) { pageToken = body.nextPageToken; continue; }
    nextSyncToken = body.nextSyncToken;
    break;
  }

  await prisma.googleCalendarConnection.update({
    where: { id: conn.id },
    data: { syncToken: nextSyncToken || conn.syncToken, lastSyncedAt: new Date(), status: 'active', lastError: null },
  });
  return res;
}

async function applyGoogleEvent(
  conn: GoogleCalendarConnection,
  ev: GEvent,
): Promise<keyof SyncResult> {
  const existing = await prisma.meeting.findFirst({
    where: { externalId: ev.id, externalCalendarId: conn.calendarId },
  });

  // Our own write (or an already-processed revision) — nothing to do.
  if (existing && ev.etag && existing.externalEtag === ev.etag) return 'skipped';

  if (ev.status === 'cancelled') {
    if (!existing || existing.status === 'cancelled') return 'skipped';
    // Deleting the event in Google cancels the meeting — but never a meeting
    // that already ran (reports/transcripts must survive a calendar cleanup).
    if (existing.status === 'ended') return 'skipped';
    await prisma.meeting.update({
      where: { id: existing.id },
      data: { status: 'cancelled', externalEtag: ev.etag || null, externalSyncedAt: new Date() },
    });
    return 'cancelled';
  }

  // Needs a concrete start time; skip all-day events and recurring masters.
  const startIso = ev.start?.dateTime;
  if (!startIso || ev.recurrence) return 'skipped';
  const start = new Date(startIso);
  const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : new Date(start.getTime() + 60 * 60_000);
  const durationMin = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000));
  const title = (ev.summary || '').trim() || 'Meeting';

  if (existing) {
    if (['ended', 'live'].includes(existing.status)) return 'skipped'; // too late to edit
    await prisma.meeting.update({
      where: { id: existing.id },
      data: {
        title,
        scheduledAt: start,
        durationMin,
        status: 'scheduled',
        externalEtag: ev.etag || null,
        externalSyncedAt: new Date(),
      },
    });
    await upsertParticipants(existing.id, conn, ev);
    return 'updated';
  }

  // New event → new meeting, with workspace policy defaults (mirrors POST /api/meetings).
  const wsCfg = await readConfig(['WS_LIVE_TRANSCRIPTION', 'WS_AI_SUMMARY', 'WS_GUEST_ACCESS', 'WS_MAX_DURATION_MIN']);
  const maxDur = num(wsCfg, 'WS_MAX_DURATION_MIN') || 240;
  let meeting: { id: string };
  try {
    meeting = await prisma.meeting.create({
      data: {
        title,
        description: ev.description?.trim() || null,
        createdById: conn.userId,
        scheduledAt: start,
        durationMin: Math.min(durationMin, maxDur),
        livekitRoom: `meet-${generateMeetingSlug()}`,
        joinToken: generateMeetingSlug(),
        transcriptionEnabled: wsCfg.WS_LIVE_TRANSCRIPTION !== 'false',
        aiReportEnabled: wsCfg.WS_AI_SUMMARY !== 'false',
        taskCreationEnabled: true,
        allowGuests: wsCfg.WS_GUEST_ACCESS !== 'false',
        status: 'scheduled',
        orgId: conn.orgId,
        externalId: ev.id,
        externalCalendarId: conn.calendarId,
        externalEtag: ev.etag || null,
        externalSyncedAt: new Date(),
        participants: { create: [{ userId: conn.userId, role: 'host', rsvpStatus: 'accepted' }] },
      },
    });
  } catch (e) {
    // P2002 on the (externalId, externalCalendarId) unique index means another
    // runner — the push webhook, the cron, the OAuth callback — created this same
    // event a moment ago. That is the race the index exists to settle, and losing it
    // is a success: the meeting exists, built from the same event by the same code.
    if ((e as { code?: string }).code === 'P2002') return 'skipped';
    throw e;
  }
  await upsertParticipants(meeting.id, conn, ev);

  // Write the join link back INTO the Google event (location + description +
  // ownership marker) so the calendar entry is self-sufficient. The patch
  // response's etag is stored → the next inbound pass skips our own write.
  await patchEventJoinLink(conn, meeting.id, ev.id).catch((e) =>
    console.error('gcal inbound: join-link patch failed:', e));
  return 'created';
}

/** Add-only attendee → participant mapping (members by email, others guests). */
async function upsertParticipants(meetingId: string, conn: GoogleCalendarConnection, ev: GEvent): Promise<void> {
  const raw = (ev.attendees || [])
    .filter((a) => a.email && !a.resource)
    .map((a) => a.email!.toLowerCase());
  if (!raw.length) return;
  // Anyone deleted from Garely must not walk back in through the calendar. A shared
  // event keeps its attendee list long after somebody leaves the company, and the
  // guest branch below stores the raw address — so without this, every sync re-created
  // the person we had just deleted, and they carried on getting invites and reports.
  const emails = await filterSuppressed(raw);
  if (!emails.length) return;
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true, email: true } });
  const byEmail = new Map(users.map((u) => [u.email!.toLowerCase(), u.id]));
  for (const email of emails) {
    const userId = byEmail.get(email) || null;
    if (userId === conn.userId) continue; // host already present
    if (userId) {
      await prisma.meetingParticipant.upsert({
        where: { meetingId_userId: { meetingId, userId } },
        update: {},
        create: { meetingId, userId, role: 'participant' },
      }).catch(() => {});
    } else {
      const dup = await prisma.meetingParticipant.findFirst({ where: { meetingId, guestEmail: email } });
      if (!dup) {
        await prisma.meetingParticipant.create({
          data: { meetingId, guestEmail: email, role: 'participant' },
        }).catch(() => {});
      }
    }
  }
}

async function joinUrlFor(meetingId: string): Promise<string> {
  const m = await prisma.meeting.findUnique({ where: { id: meetingId }, select: { joinToken: true, id: true } });
  const base = await publicBaseUrl();
  return m?.joinToken ? `${base}/join/${m.joinToken}` : `${base}/room/${meetingId}`;
}

async function patchEventJoinLink(conn: GoogleCalendarConnection, meetingId: string, eventId: string): Promise<void> {
  const joinUrl = await joinUrlFor(meetingId);
  const r = await gcalFetch(conn, `/calendars/${encodeURIComponent(conn.calendarId!)}/events/${encodeURIComponent(eventId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      location: joinUrl,
      extendedProperties: { private: { garelyMeetingId: meetingId } },
    }),
  });
  if (r.ok) {
    const patched = await r.json();
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { externalEtag: patched.etag || null, externalSyncedAt: new Date() },
    });
  }
}

/* ── Outbound: Garely → Google ──────────────────────────────────── */

/**
 * Reflect a Garely meeting into the creator's "Garely" calendar. Best-effort:
 * callers fire-and-forget (`void syncMeetingToGoogle(...)`) — a Google outage
 * must never block scheduling.
 */
export async function syncMeetingToGoogle(
  meetingId: string,
  action: 'upsert' | 'delete',
): Promise<void> {
  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  if (!meeting) {
    if (action !== 'delete') return;
  }
  const createdById = meeting?.createdById;
  if (!createdById && action !== 'delete') return;

  const conn = createdById
    ? await prisma.googleCalendarConnection.findUnique({ where: { userId: createdById } })
    : null;
  if (!conn?.calendarId || conn.status === 'revoked') return;

  try {
    if (action === 'delete' || meeting!.status === 'cancelled') {
      if (!meeting?.externalId) return;
      const r = await gcalFetch(conn, `/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(meeting.externalId)}`, { method: 'DELETE' });
      if (r.ok || r.status === 404 || r.status === 410) {
        await prisma.meeting.update({
          where: { id: meeting.id },
          data: { externalId: null, externalEtag: null, externalSyncedAt: new Date() },
        }).catch(() => {});
      }
      return;
    }

    if (!meeting!.scheduledAt) return; // only scheduled meetings live in the calendar
    const joinUrl = await joinUrlFor(meeting!.id);
    const payload = {
      summary: meeting!.title,
      description: meeting!.description ? `${meeting!.description}\n\n${joinUrl}` : joinUrl,
      location: joinUrl,
      start: { dateTime: meeting!.scheduledAt.toISOString() },
      end: { dateTime: new Date(meeting!.scheduledAt.getTime() + (meeting!.durationMin || 60) * 60_000).toISOString() },
      extendedProperties: { private: { garelyMeetingId: meeting!.id } },
    };

    const path = meeting!.externalId
      ? `/calendars/${encodeURIComponent(conn.calendarId)}/events/${encodeURIComponent(meeting!.externalId)}`
      : `/calendars/${encodeURIComponent(conn.calendarId)}/events`;
    let r = await gcalFetch(conn, path, {
      method: meeting!.externalId ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    // The linked event vanished (deleted directly in Google) — recreate it.
    if (meeting!.externalId && (r.status === 404 || r.status === 410)) {
      r = await gcalFetch(conn, `/calendars/${encodeURIComponent(conn.calendarId)}/events`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
    }
    if (!r.ok) throw new Error(`events.${meeting!.externalId ? 'patch' : 'insert'} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const saved = await r.json();
    await prisma.meeting.update({
      where: { id: meeting!.id },
      data: {
        externalId: saved.id,
        externalCalendarId: conn.calendarId,
        externalEtag: saved.etag || null,
        externalSyncedAt: new Date(),
      },
    });
  } catch (e) {
    console.error(`gcal outbound: meeting ${meetingId} ${action} failed:`, e);
  }
}

/* ── Push channel (events.watch) ────────────────────────────────── */

/** (Re)start the push channel for a connection. Quietly tolerated to fail —
 *  the cron poller still syncs every few minutes without it. */
export async function startWatch(conn: GoogleCalendarConnection): Promise<boolean> {
  if (!conn.calendarId) return false;
  // Stop the previous channel first (best-effort) to avoid duplicates.
  if (conn.channelId && conn.resourceId) {
    await gcalFetch(conn, '/channels/stop', {
      method: 'POST',
      body: JSON.stringify({ id: conn.channelId, resourceId: conn.resourceId }),
    }).catch(() => {});
  }
  const channelId = crypto.randomUUID();
  const channelToken = crypto.randomBytes(16).toString('base64url');
  const address = `${await publicBaseUrl()}/api/webhooks/google-calendar`;
  const r = await gcalFetch(conn, `/calendars/${encodeURIComponent(conn.calendarId)}/events/watch`, {
    method: 'POST',
    body: JSON.stringify({ id: channelId, type: 'web_hook', address, token: channelToken }),
  });
  if (!r.ok) {
    console.warn(`gcal watch failed (${r.status}) — falling back to cron polling:`, (await r.text()).slice(0, 200));
    return false;
  }
  const body = await r.json();
  await prisma.googleCalendarConnection.update({
    where: { id: conn.id },
    data: {
      channelId,
      channelToken,
      resourceId: body.resourceId || null,
      channelExpiry: body.expiration ? new Date(Number(body.expiration)) : null,
    },
  });
  return true;
}

/* ── SSO auto-connect ───────────────────────────────────────────── */

/**
 * Establish (or refresh) a user's Google Calendar connection straight from the
 * tokens NextAuth captured during Google SSO sign-in — so logging in with
 * Google auto-enables two-way sync, no separate "Connect" step. Best-effort and
 * fire-and-forget from the auth callback: it must NEVER throw into the login
 * flow. `account` is NextAuth's provider account (access_token, refresh_token?,
 * expires_at unix-sec, scope, id_token). No-op unless the calendar scope was
 * granted (older sessions / password users are unaffected).
 *
 * The heavy calendar bootstrap (find-or-create "Garely", initial sync, push
 * channel) runs detached — the persistent Node server keeps it alive — and the
 * cron poller self-heals any connection still missing a calendarId.
 */
export async function linkGoogleCalendarFromSSO(
  userId: string,
  account: { access_token?: string; refresh_token?: string; expires_at?: number; scope?: string; id_token?: string } | null | undefined,
): Promise<void> {
  try {
    if (!account?.access_token || !account.scope?.includes(GCAL_SCOPE)) return;

    const membership = await prisma.membership.findFirst({ where: { userId }, select: { orgId: true } });
    const orgId = membership?.orgId ?? (await getSingletonOrgId());
    if (!orgId) return;

    const existing = await prisma.googleCalendarConnection.findUnique({ where: { userId } });
    const nowSec = Math.floor(Date.now() / 1000);
    const conn = await saveTokens(
      { userId, orgId },
      {
        access_token: account.access_token,
        refresh_token: account.refresh_token, // absent on repeat logins — saveTokens keeps the stored one
        expires_in: account.expires_at ? Math.max(60, account.expires_at - nowSec) : 3600,
        scope: account.scope,
        id_token: account.id_token,
      },
      existing?.googleEmail ? {} : { googleEmail: emailFromIdToken(account.id_token) },
    );

    // Detached bootstrap — never blocks (or breaks) login.
    void (async () => {
      try {
        let calId = conn.calendarId;
        if (!calId) {
          calId = await ensureGarelyCalendar(conn);
          await prisma.googleCalendarConnection.update({ where: { id: conn.id }, data: { calendarId: calId } });
        }
        const ready = { ...conn, calendarId: calId };
        await syncConnection(ready);
        await startWatch(ready);
      } catch (e) {
        console.error('gcal SSO bootstrap failed (cron will retry):', e);
      }
    })();
  } catch (e) {
    console.error('gcal SSO link failed:', e);
  }
}
