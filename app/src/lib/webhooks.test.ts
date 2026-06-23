import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { readConfig, writeConfig } from '@/lib/config';
import {
  signBody, isValidWebhookUrl, saveWebhooks, getWebhooksForApi, getWebhookEndpoints,
  isWebhooksConfigured, dispatchWebhook, notifyWebhookReportReady, taskWebhookPayload,
  WEBHOOK_EVENTS,
} from '@/lib/webhooks';

vi.mock('@/lib/prisma');
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({})),
  writeConfig: vi.fn(async () => {}),
  publicBaseUrl: vi.fn(async () => 'https://meet.example.com'),
}));
// Mock ciphertext uses the real `v1.` prefix so dec()'s decrypt guard fires.
vi.mock('@/lib/twofactor', () => ({ encryptSecret: vi.fn((x: string) => `v1.${x}`), decryptSecret: vi.fn((x: string) => x.replace(/^v1\./, '')) }));

const mockReadConfig = vi.mocked(readConfig);
const mockWriteConfig = vi.mocked(writeConfig);

/** Point readConfig at a fixed WEBHOOKS_JSON for the dispatch/list tests. */
function setStored(endpoints: unknown[]) {
  mockReadConfig.mockResolvedValue({ WEBHOOKS_JSON: JSON.stringify(endpoints) } as any);
}

function installFetch(ok = true, status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers as Record<string, string>) || {}, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok, status, json: async () => ({}), text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

beforeEach(() => { mockReset(prismaMock); vi.unstubAllGlobals(); vi.clearAllMocks(); mockReadConfig.mockResolvedValue({} as any); });

describe('signBody', () => {
  it('produces a stable GitHub-style sha256= hex signature', () => {
    const sig = signBody('s3cr3t', '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // deterministic for the same input
    expect(signBody('s3cr3t', '{"a":1}')).toBe(sig);
    // changes with the secret
    expect(signBody('other', '{"a":1}')).not.toBe(sig);
  });
});

describe('isValidWebhookUrl', () => {
  it('accepts http/https only', () => {
    expect(isValidWebhookUrl('https://x.com/hook')).toBe(true);
    expect(isValidWebhookUrl('http://localhost:9000')).toBe(true);
    expect(isValidWebhookUrl('ftp://x.com')).toBe(false);
    expect(isValidWebhookUrl('not a url')).toBe(false);
    expect(isValidWebhookUrl('')).toBe(false);
    expect(isValidWebhookUrl(123)).toBe(false);
  });
});

describe('saveWebhooks', () => {
  it('rejects an invalid url', async () => {
    const r = await saveWebhooks([{ url: 'ftp://nope' }]);
    expect(r).toEqual({ error: 'invalid_url' });
    expect(mockWriteConfig).not.toHaveBeenCalled();
  });
  it('rejects too many endpoints', async () => {
    const many = Array.from({ length: 21 }, () => ({ url: 'https://x.com' }));
    expect(await saveWebhooks(many)).toEqual({ error: 'too_many_endpoints' });
  });
  it('encrypts a new secret and never returns it', async () => {
    const r = await saveWebhooks([{ url: 'https://x.com/h', secret: 'topsecret', events: ['task.created'] }]);
    expect('endpoints' in r).toBe(true);
    const wrote = JSON.parse((mockWriteConfig.mock.calls[0][0] as any).WEBHOOKS_JSON);
    expect(wrote[0].secret).toBe('v1.topsecret'); // encrypted at rest
    expect(wrote[0].events).toEqual(['task.created']);
    // public projection has no secret material
    expect((r as any).endpoints[0]).toMatchObject({ url: 'https://x.com/h', secretSet: true });
    expect((r as any).endpoints[0].secret).toBeUndefined();
  });
  it('preserves the stored secret when the incoming one is masked/blank', async () => {
    setStored([{ id: 'ep1', url: 'https://x.com/h', secret: 'v1.keepme', enabled: true, events: [] }]);
    await saveWebhooks([{ id: 'ep1', url: 'https://x.com/h', secret: '••••••••' }]);
    const wrote = JSON.parse((mockWriteConfig.mock.calls[0][0] as any).WEBHOOKS_JSON);
    expect(wrote[0].secret).toBe('v1.keepme');
  });
  it('drops only invalid event names', async () => {
    const r = await saveWebhooks([{ url: 'https://x.com/h', events: ['task.created', 'bogus.event'] }]);
    expect((r as any).endpoints[0].events).toEqual(['task.created']);
  });
});

describe('getWebhooksForApi / getWebhookEndpoints', () => {
  it('API list hides secrets but flags secretSet; internal list decrypts', async () => {
    setStored([
      { id: 'a', url: 'https://a.com', secret: 'v1.sa', enabled: true, events: ['report.ready'] },
      { id: 'b', url: 'https://b.com', secret: '', enabled: false, events: [] },
    ]);
    const api = await getWebhooksForApi();
    expect(api).toEqual([
      { id: 'a', url: 'https://a.com', enabled: true, events: ['report.ready'], secretSet: true },
      { id: 'b', url: 'https://b.com', enabled: false, events: [], secretSet: false },
    ]);
    const internal = await getWebhookEndpoints();
    expect(internal[0].secret).toBe('sa');
    expect(internal[1].secret).toBe('');
  });
  it('assigns a STABLE id to an id-less stored endpoint and preserves its secret on save', async () => {
    // Hand-edited / legacy config: a row with a secret but no id field.
    setStored([{ url: 'https://x.com/h', secret: 'v1.keepme', enabled: true, events: [] }]);
    const a = await getWebhooksForApi();
    const b = await getWebhooksForApi();
    expect(a[0].id).toBe(b[0].id);        // deterministic across reads
    expect(a[0].id).toBeTruthy();
    // Round-trip: client saves back using the id it was given + a masked secret.
    await saveWebhooks([{ id: a[0].id, url: 'https://x.com/h', secret: '••••' }]);
    const wrote = JSON.parse((mockWriteConfig.mock.calls[0][0] as any).WEBHOOKS_JSON);
    expect(wrote[0].secret).toBe('v1.keepme'); // secret survived the round-trip
  });
  it('isWebhooksConfigured reflects any enabled endpoint', async () => {
    setStored([{ id: 'b', url: 'https://b.com', secret: '', enabled: false, events: [] }]);
    expect(await isWebhooksConfigured()).toBe(false);
    setStored([{ id: 'a', url: 'https://a.com', secret: '', enabled: true, events: [] }]);
    expect(await isWebhooksConfigured()).toBe(true);
  });
});

describe('dispatchWebhook', () => {
  it('no-op when nothing is configured', async () => {
    const { fetchMock } = installFetch();
    await dispatchWebhook('report.ready', { x: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('delivers only to enabled endpoints subscribed to the event', async () => {
    setStored([
      { id: 'a', url: 'https://a.com', secret: 'v1.sa', enabled: true, events: ['report.ready'] },
      { id: 'b', url: 'https://b.com', secret: '', enabled: true, events: ['task.created'] }, // wrong event
      { id: 'c', url: 'https://c.com', secret: '', enabled: false, events: [] },               // disabled
      { id: 'd', url: 'https://d.com', secret: '', enabled: true, events: [] },                // empty = all
    ]);
    const { calls } = installFetch();
    await dispatchWebhook('report.ready', { hello: 'world' });
    const urls = calls.map(c => c.url).sort();
    expect(urls).toEqual(['https://a.com', 'https://d.com']);
  });
  it('signs the body when a secret is set and omits the header otherwise', async () => {
    setStored([
      { id: 'a', url: 'https://a.com', secret: 'v1.sa', enabled: true, events: [] },
      { id: 'b', url: 'https://b.com', secret: '', enabled: true, events: [] },
    ]);
    const { calls } = installFetch();
    await dispatchWebhook('task.updated', { id: 't1' });
    const a = calls.find(c => c.url === 'https://a.com')!;
    const b = calls.find(c => c.url === 'https://b.com')!;
    expect(a.headers['X-Garely-Event']).toBe('task.updated');
    expect(a.headers['X-Garely-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(b.headers['X-Garely-Signature']).toBeUndefined();
    expect(a.body).toMatchObject({ event: 'task.updated', data: { id: 't1' } });
  });
  it('never throws when an endpoint fails', async () => {
    setStored([{ id: 'a', url: 'https://a.com', secret: '', enabled: true, events: [] }]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(dispatchWebhook('report.ready', {})).resolves.toBeUndefined();
  });
});

describe('notifyWebhookReportReady', () => {
  it('is a no-op (no DB read) when no one is subscribed', async () => {
    setStored([{ id: 'a', url: 'https://a.com', secret: '', enabled: true, events: ['task.created'] }]);
    const { fetchMock } = installFetch();
    await notifyWebhookReportReady('m1');
    expect(prismaMock.meeting.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('emits meeting + report payload to a subscribed endpoint', async () => {
    setStored([{ id: 'a', url: 'https://a.com', secret: '', enabled: true, events: ['report.ready'] }]);
    prismaMock.meeting.findUnique.mockResolvedValue({ id: 'm1', title: 'Standup', endedAt: new Date('2026-06-23T10:00:00Z'), reports: [{ id: 'r1', summary: 'Shipped X', decisions: ['Ship Friday'] }] } as any);
    const { calls } = installFetch();
    await notifyWebhookReportReady('m1');
    expect(calls[0].body.data).toMatchObject({
      meeting: { id: 'm1', title: 'Standup', url: 'https://meet.example.com/meetings/m1/report' },
      report: { id: 'r1', summary: 'Shipped X', decisions: ['Ship Friday'] },
    });
  });
});

describe('taskWebhookPayload', () => {
  it('projects a compact, stable task shape', () => {
    const p = taskWebhookPayload({ id: 't1', title: 'Do it', status: 'open', priority: 'high', dueDate: '2026-07-01', assigneeName: 'Ann', meetingId: 'm1', departmentId: 'd1', source: 'manual' });
    expect(p).toEqual({ task: { id: 't1', title: 'Do it', status: 'open', priority: 'high', dueDate: '2026-07-01', assignee: 'Ann', meetingId: 'm1', departmentId: 'd1', source: 'manual' } });
  });
});

describe('WEBHOOK_EVENTS', () => {
  it('exposes the documented catalog', () => {
    expect([...WEBHOOK_EVENTS]).toEqual(['report.ready', 'meeting.reminder', 'task.created', 'task.updated']);
  });
});
