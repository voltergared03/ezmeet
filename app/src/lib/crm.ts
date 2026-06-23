import { prisma } from './prisma';
import { readConfig, publicBaseUrl } from './config';
import { decryptSecret } from './twofactor';

/**
 * CRM integration — log a finished meeting (its AI report) as an activity on the
 * matching CRM contact. One-way Garely → CRM: when a meeting's report is first
 * generated we find the contact by each participant's email and log a Meeting
 * engagement (summary + decisions + report link) associated to everyone from the
 * call who exists in the CRM. Opt-in, fire-and-forget, fail-soft — never throws
 * into or blocks report generation.
 *
 * Provider is stored in config so a second CRM (Pipedrive, Salesforce) is a
 * switch later; only HubSpot is implemented today.
 */

export type CrmProvider = 'hubspot';

export interface CrmConfig {
  provider: CrmProvider;
  token: string;
  createContact: boolean; // create a contact for an unmatched participant email
}

const HS_BASE = 'https://api.hubapi.com';
const TIMEOUT_MS = 12_000;
// HUBSPOT_DEFINED association type id: Meeting → Contact.
const MEETING_TO_CONTACT = 200;

/** Stored secrets are AES-GCM ciphertext (v1.…); tolerate a raw legacy value. */
function dec(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) { try { return decryptSecret(raw); } catch { return ''; } }
  return raw;
}

async function loadCrm(ignoreEnabled: boolean): Promise<CrmConfig | null> {
  const m = await readConfig(['CRM_ENABLED', 'CRM_PROVIDER', 'CRM_TOKEN', 'CRM_CREATE_CONTACT']);
  if (!ignoreEnabled && m.CRM_ENABLED !== 'true') return null;
  const provider: CrmProvider = 'hubspot'; // only provider today; m.CRM_PROVIDER reserved
  const token = dec(m.CRM_TOKEN);
  if (!token) return null;
  return { provider, token, createContact: m.CRM_CREATE_CONTACT === 'true' };
}

/** Active CRM config (decrypted). Null when disabled or unconfigured. */
export async function getCrmConfig(): Promise<CrmConfig | null> {
  return loadCrm(false);
}

/** Whether a CRM is configured (settings status — no secrets). */
export async function isCrmConfigured(): Promise<boolean> {
  return (await getCrmConfig()) !== null;
}

// ─────────────────────────── HubSpot transport ───────────────────────────

function hsFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${HS_BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Find a contact id by exact email. Returns null on no match or any error. */
export async function findContactIdByEmail(token: string, email: string): Promise<string | null> {
  const value = (email || '').trim().toLowerCase();
  if (!value) return null;
  try {
    const res = await hsFetch(token, '/crm/v3/objects/contacts/search', {
      method: 'POST',
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value }] }], properties: ['email'], limit: 1 }),
    });
    // Distinguish a real API error (rate limit / 5xx / auth) from a clean no-match,
    // so systemic CRM outages leave a trace instead of silently dropping contacts.
    if (!res.ok) { console.error(`[crm] contact search failed: HubSpot ${res.status}`); return null; }
    const d = await res.json().catch(() => null);
    return d?.results?.[0]?.id ?? null;
  } catch { return null; }
}

/** Create a minimal contact (email + name). Returns its id, or null on failure. */
export async function createHubspotContact(token: string, email: string, name: string): Promise<string | null> {
  const value = (email || '').trim().toLowerCase();
  if (!value) return null;
  try {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    const firstname = parts.shift() || '';
    const lastname = parts.join(' ');
    const properties: Record<string, string> = { email: value };
    if (firstname) properties.firstname = firstname;
    if (lastname) properties.lastname = lastname;
    const res = await hsFetch(token, '/crm/v3/objects/contacts', { method: 'POST', body: JSON.stringify({ properties }) });
    if (res.ok) { const d = await res.json().catch(() => null); return d?.id ?? null; }
    // A 409 means the contact already exists (race) — recover by searching.
    if (res.status === 409) return findContactIdByEmail(token, value);
    return null;
  } catch { return null; }
}

interface MeetingLog {
  title: string;
  bodyHtml: string;
  url: string;
  startISO: string;
  endISO: string;
  contactIds: string[];
}

/** Create a Meeting engagement associated to the given contacts. Returns its id. */
export async function logHubspotMeeting(token: string, m: MeetingLog): Promise<string | null> {
  try {
    const properties: Record<string, string> = {
      hs_timestamp: m.endISO,
      hs_meeting_title: m.title,
      hs_meeting_body: m.bodyHtml,
      hs_meeting_start_time: m.startISO,
      hs_meeting_end_time: m.endISO,
      hs_meeting_outcome: 'COMPLETED',
    };
    if (m.url) properties.hs_meeting_external_url = m.url;
    const associations = m.contactIds.map((id) => ({ to: { id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: MEETING_TO_CONTACT }] }));
    const res = await hsFetch(token, '/crm/v3/objects/meetings', { method: 'POST', body: JSON.stringify({ properties, associations }) });
    if (!res.ok) return null;
    const d = await res.json().catch(() => null);
    return d?.id ?? null;
  } catch { return null; }
}

/** Validate the token + read scope. Works even before the toggle is on. */
export async function testCrm(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadCrm(true);
  if (!cfg) return { ok: false, error: 'not_configured' };
  try {
    const res = await hsFetch(cfg.token, '/crm/v3/objects/contacts?limit=1', { method: 'GET' });
    if (res.ok) return { ok: true };
    // Don't echo HubSpot's raw response body back to the browser — status is enough.
    return { ok: false, error: `HubSpot ${res.status}` };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

// ─────────────────────────── event payload (called from app flows) ───────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build the meeting-engagement body (HubSpot renders hs_meeting_body as HTML). */
export function buildMeetingBody(summary: string, decisions: string[], url: string): string {
  const parts: string[] = [];
  if (summary.trim()) parts.push(`<p>${esc(summary.trim()).replace(/\n+/g, '<br>')}</p>`);
  if (decisions.length) parts.push(`<p><b>Decisions</b></p><ul>${decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`);
  if (url) parts.push(`<p><a href="${esc(url)}">View full report in Garely</a></p>`);
  return parts.join('') || '<p>Meeting completed in Garely.</p>';
}

/**
 * Log a freshly-generated meeting report to the CRM. Resolves each participant's
 * email to a contact (optionally creating one), then logs a single Meeting
 * engagement associated to all matched contacts. No-op when disabled, when no
 * participant is in the CRM, or on any error.
 */
export async function pushMeetingToCrm(meetingId: string): Promise<void> {
  try {
    const cfg = await getCrmConfig();
    if (!cfg) return;
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: {
        id: true, title: true, scheduledAt: true, endedAt: true,
        participants: { select: { guestEmail: true, guestName: true, user: { select: { email: true, name: true } } } },
        reports: { orderBy: { generatedAt: 'desc' }, take: 1, select: { summary: true, decisions: true } },
      },
    });
    if (!meeting) return;

    // Collect unique participant emails (registered users + guests) with a display name.
    const people = new Map<string, string>();
    for (const p of meeting.participants) {
      const email = (p.user?.email || p.guestEmail || '').trim().toLowerCase();
      if (!email) continue;
      if (!people.has(email)) people.set(email, p.user?.name || p.guestName || '');
    }
    if (people.size === 0) return;

    const contactIds: string[] = [];
    for (const [email, name] of people) {
      let id = await findContactIdByEmail(cfg.token, email);
      if (!id && cfg.createContact) id = await createHubspotContact(cfg.token, email, name);
      if (id) contactIds.push(id);
    }
    // Two participant emails can resolve to the SAME contact (merged/alias) — dedupe
    // so the engagement isn't associated to one contact twice.
    const uniqueContactIds = [...new Set(contactIds)];
    if (uniqueContactIds.length === 0) return; // nobody from the call is in the CRM

    const rep = meeting.reports[0];
    const decisions = Array.isArray(rep?.decisions)
      ? (rep!.decisions as unknown[]).filter((d): d is string => typeof d === 'string' && !!d.trim())
      : [];
    const base = await publicBaseUrl();
    const url = base ? `${base}/meetings/${meeting.id}/report` : '';
    const start = meeting.scheduledAt ?? meeting.endedAt ?? new Date();
    const end = meeting.endedAt ?? new Date();

    await logHubspotMeeting(cfg.token, {
      title: meeting.title,
      bodyHtml: buildMeetingBody(rep?.summary || '', decisions, url),
      url,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      contactIds: uniqueContactIds,
    });
  } catch (e) {
    console.error('[crm] push failed:', (e as Error).message);
  }
}
