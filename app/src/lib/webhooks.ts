import { createHmac, randomUUID } from 'crypto';
import { prisma } from './prisma';
import { readConfig, writeConfig, publicBaseUrl } from './config';
import { encryptSecret, decryptSecret } from './twofactor';

/**
 * Generic outbound webhooks — one connector, hundreds of integrations. Each
 * configured endpoint receives a signed JSON POST whenever a subscribed Garely
 * event fires (an AI report is ready, a meeting reminder goes out, a task is
 * created/updated). Designed to drop straight into Zapier / Make / n8n or any
 * custom receiver. Delivery is opt-in, fire-and-forget and fail-soft — a slow or
 * broken endpoint never throws into, or blocks, the app flow that triggered it.
 *
 * Security: the body is signed with HMAC-SHA256 using the endpoint's shared
 * secret and sent as `X-Garely-Signature: sha256=<hex>` (GitHub-compatible), so
 * receivers can verify authenticity. Secrets are AES-GCM encrypted at rest and
 * never returned to the browser (the API exposes only `secretSet: boolean`).
 */

export const WEBHOOK_EVENTS = ['report.ready', 'meeting.reminder', 'task.created', 'task.updated'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEndpoint {
  id: string;
  url: string;
  secret: string; // decrypted — internal use only, never serialized to the client
  enabled: boolean;
  events: WebhookEvent[]; // empty ⇒ subscribed to every event
}

/** Client-safe projection (no secret material). */
export interface WebhookEndpointPublic {
  id: string;
  url: string;
  enabled: boolean;
  events: WebhookEvent[];
  secretSet: boolean;
}

/** Shape the PATCH route accepts for each row (id absent ⇒ a brand-new endpoint). */
export interface WebhookEndpointInput {
  id?: string;
  url: string;
  enabled?: boolean;
  events?: string[];
  secret?: string; // a masked placeholder or empty ⇒ keep the stored secret
}

const CONFIG_KEY = 'WEBHOOKS_JSON';
const TIMEOUT_MS = 10_000;
const MAX_ENDPOINTS = 20;
const UA = 'Garely-Webhooks/1.0';

/** Stored secrets are AES-GCM ciphertext (v1.…); tolerate a raw legacy value. */
function dec(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) { try { return decryptSecret(raw); } catch { return ''; } }
  return raw;
}

function isMasked(v: unknown): boolean {
  return typeof v === 'string' && /^[•*]+$/.test(v.trim());
}

function sanitizeEvents(events: unknown): WebhookEvent[] {
  if (!Array.isArray(events)) return [];
  const allowed = new Set<string>(WEBHOOK_EVENTS);
  const out: WebhookEvent[] = [];
  for (const e of events) if (typeof e === 'string' && allowed.has(e) && !out.includes(e as WebhookEvent)) out.push(e as WebhookEvent);
  return out;
}

/** A URL is acceptable only if it is a syntactically valid http(s) endpoint. */
export function isValidWebhookUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface StoredEndpoint { id: string; url: string; secret: string; enabled: boolean; events: WebhookEvent[] }

/** Parse the raw config JSON → stored rows (secret still encrypted). */
function parseStored(raw: string | undefined): StoredEndpoint[] {
  if (!raw) return [];
  let arr: unknown;
  try { arr = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: StoredEndpoint[] = [];
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : '';
    if (!url) continue;
    out.push({
      // Deterministic id. saveWebhooks persists a real UUID for genuinely new
      // endpoints; a positional fallback only applies to hand-edited/legacy config
      // and MUST stay identical across reads so the GET→PATCH secret-merge holds
      // (a random id per read would silently drop the stored secret on save).
      id: typeof o.id === 'string' && o.id ? o.id : `wh-${i}`,
      url,
      secret: typeof o.secret === 'string' ? o.secret : '',
      enabled: o.enabled !== false,
      events: sanitizeEvents(o.events),
    });
  }
  return out;
}

async function loadStored(): Promise<StoredEndpoint[]> {
  const m = await readConfig([CONFIG_KEY]);
  return parseStored(m[CONFIG_KEY]);
}

/** Full endpoints with DECRYPTED secrets — internal (dispatch) use only. */
export async function getWebhookEndpoints(): Promise<WebhookEndpoint[]> {
  return (await loadStored()).map((e) => ({ id: e.id, url: e.url, secret: dec(e.secret), enabled: e.enabled, events: e.events }));
}

/** Client-safe list for the settings API (no secrets). */
export async function getWebhooksForApi(): Promise<WebhookEndpointPublic[]> {
  return (await loadStored()).map((e) => ({ id: e.id, url: e.url, enabled: e.enabled, events: e.events, secretSet: !!dec(e.secret) }));
}

/** Whether at least one enabled endpoint exists (settings status — no secrets). */
export async function isWebhooksConfigured(): Promise<boolean> {
  return (await loadStored()).some((e) => e.enabled);
}

/**
 * Validate + persist the incoming endpoint list. Secrets are merged: an omitted
 * or masked secret on an existing id keeps the stored ciphertext; a real new
 * value is encrypted; a new endpoint with no secret is stored unsigned. Returns
 * the client-safe list, or an error string on invalid input.
 */
export async function saveWebhooks(incoming: WebhookEndpointInput[]): Promise<{ endpoints: WebhookEndpointPublic[] } | { error: string }> {
  if (!Array.isArray(incoming)) return { error: 'invalid_payload' };
  if (incoming.length > MAX_ENDPOINTS) return { error: 'too_many_endpoints' };

  const prevById = new Map((await loadStored()).map((e) => [e.id, e]));
  const stored: StoredEndpoint[] = [];
  const seenIds = new Set<string>();

  for (const row of incoming) {
    if (!row || typeof row !== 'object') return { error: 'invalid_endpoint' };
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    if (!isValidWebhookUrl(url)) return { error: 'invalid_url' };

    const id = typeof row.id === 'string' && row.id ? row.id : randomUUID();
    if (seenIds.has(id)) continue; // drop duplicate ids defensively
    seenIds.add(id);
    const prev = prevById.get(id);

    // Secret: a real new value wins; otherwise preserve the stored ciphertext.
    let secret = prev?.secret ?? '';
    if (typeof row.secret === 'string' && row.secret.trim() && !isMasked(row.secret)) {
      secret = encryptSecret(row.secret.trim());
    }

    stored.push({
      id,
      url,
      secret,
      enabled: row.enabled !== false,
      events: sanitizeEvents(row.events),
    });
  }

  await writeConfig({ [CONFIG_KEY]: JSON.stringify(stored) });
  return { endpoints: stored.map((e) => ({ id: e.id, url: e.url, enabled: e.enabled, events: e.events, secretSet: !!dec(e.secret) })) };
}

// ─────────────────────────── delivery ───────────────────────────

/** GitHub-style signature: `sha256=` + hex HMAC-SHA256(rawBody) under the secret. */
export function signBody(secret: string, rawBody: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

function subscribed(ep: WebhookEndpoint, event: WebhookEvent): boolean {
  return ep.enabled && (ep.events.length === 0 || ep.events.includes(event));
}

/** POST one signed delivery to one endpoint. Never throws. */
async function deliver(ep: WebhookEndpoint, event: WebhookEvent, body: { event: WebhookEvent; timestamp: string; data: unknown }): Promise<{ ok: boolean; status?: number; error?: string }> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': UA,
    'X-Garely-Event': event,
    'X-Garely-Delivery': randomUUID(),
    'X-Garely-Timestamp': String(Math.floor(Date.now() / 1000)),
  };
  if (ep.secret) headers['X-Garely-Signature'] = signBody(ep.secret, raw);
  try {
    const res = await fetch(ep.url, { method: 'POST', headers, body: raw, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Fan a single event out to every enabled, subscribed endpoint. Fire-and-forget:
 * loads config first and returns immediately when nothing is configured, so the
 * cost on an unconfigured workspace is one cheap KV read. Never throws.
 */
export async function dispatchWebhook(event: WebhookEvent, data: unknown): Promise<void> {
  try {
    const all = await getWebhookEndpoints();
    const targets = all.filter((ep) => subscribed(ep, event));
    if (targets.length === 0) return;
    const body = { event, timestamp: new Date().toISOString(), data };
    await Promise.all(
      targets.map(async (ep) => {
        const r = await deliver(ep, event, body);
        if (!r.ok) console.error(`[webhook] ${event} → ${ep.url} failed: ${r.error}`);
      }),
    );
  } catch (e) {
    console.error('[webhook] dispatch failed:', (e as Error).message);
  }
}

/** Send a sample `ping` to one endpoint (by id) — works even when disabled. */
export async function testWebhook(id: string): Promise<{ ok: boolean; error?: string }> {
  const ep = (await getWebhookEndpoints()).find((e) => e.id === id);
  if (!ep) return { ok: false, error: 'not_found' };
  const base = await publicBaseUrl();
  const body = { event: 'report.ready' as WebhookEvent, timestamp: new Date().toISOString(), data: { ping: true, message: 'Garely webhook test', source: base || 'garely' } };
  const r = await deliver(ep, 'report.ready', body);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

// ─────────────────────────── event payloads (called from app flows) ───────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** Emit `report.ready` with the meeting's freshly-generated AI report. */
export async function notifyWebhookReportReady(meetingId: string): Promise<void> {
  try {
    const all = await getWebhookEndpoints();
    if (!all.some((ep) => subscribed(ep, 'report.ready'))) return; // skip the DB read when no one is listening
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { id: true, title: true, endedAt: true, reports: { orderBy: { generatedAt: 'desc' }, take: 1, select: { id: true, summary: true, decisions: true } } },
    });
    if (!meeting) return;
    const rep = meeting.reports[0];
    const base = await publicBaseUrl();
    const decisions = Array.isArray(rep?.decisions)
      ? (rep!.decisions as unknown[]).filter((d): d is string => typeof d === 'string' && !!d.trim())
      : [];
    await dispatchWebhook('report.ready', {
      meeting: {
        id: meeting.id,
        title: meeting.title,
        endedAt: meeting.endedAt ? meeting.endedAt.toISOString() : null,
        url: base ? `${base}/meetings/${meeting.id}/report` : null,
      },
      report: rep
        ? { id: rep.id, summary: rep.summary ? truncate(rep.summary, 4000) : '', decisions }
        : null,
    });
  } catch (e) {
    console.error('[webhook] report-ready failed:', (e as Error).message);
  }
}

/** Emit `meeting.reminder` for a meeting starting soon. */
export async function notifyWebhookMeetingReminder(meetingId: string, title: string, time: string): Promise<void> {
  try {
    const base = await publicBaseUrl();
    await dispatchWebhook('meeting.reminder', {
      meeting: { id: meetingId, title, time, url: base ? `${base}/lobby/${meetingId}` : null },
    });
  } catch (e) {
    console.error('[webhook] reminder failed:', (e as Error).message);
  }
}

/** Compact, stable task payload shared by task.created / task.updated. */
export function taskWebhookPayload(task: {
  id: string; title: string; status: string; priority: string; dueDate: string | null;
  assigneeName: string | null; meetingId: string | null; departmentId: string | null; source: string;
}): { task: Record<string, unknown> } {
  return {
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate,
      assignee: task.assigneeName,
      meetingId: task.meetingId,
      departmentId: task.departmentId,
      source: task.source,
    },
  };
}
