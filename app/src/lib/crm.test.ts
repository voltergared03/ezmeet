import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { readConfig } from '@/lib/config';
import {
  getCrmConfig, isCrmConfigured, findContactIdByEmail, createHubspotContact,
  logHubspotMeeting, buildMeetingBody, testCrm, pushMeetingToCrm,
} from '@/lib/crm';

vi.mock('@/lib/prisma');
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({})),
  writeConfig: vi.fn(async () => {}),
  publicBaseUrl: vi.fn(async () => 'https://meet.example.com'),
}));
vi.mock('@/lib/twofactor', () => ({ encryptSecret: vi.fn((x: string) => `v1.${x}`), decryptSecret: vi.fn((x: string) => x.replace(/^v1\./, '')) }));

const mockReadConfig = vi.mocked(readConfig);

/** Router-style fetch: dispatch by URL + method, recording calls. `json` may be a
 *  function of the parsed request body so a handler can vary its response. */
function installFetch(handlers: { match: (url: string, init?: RequestInit) => boolean; status?: number; json?: any | ((body: any) => any) }[]) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), method: init?.method || 'GET', body });
    const h = handlers.find((x) => x.match(String(url), init));
    const status = h?.status ?? 200;
    const json = typeof h?.json === 'function' ? h.json(body) : (h?.json ?? {});
    return { ok: status >= 200 && status < 300, status, json: async () => json, text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

beforeEach(() => { mockReset(prismaMock); vi.unstubAllGlobals(); vi.clearAllMocks(); mockReadConfig.mockResolvedValue({} as any); });

describe('getCrmConfig', () => {
  it('null when disabled', async () => {
    mockReadConfig.mockResolvedValue({ CRM_ENABLED: 'false', CRM_TOKEN: 'v1.tok' } as any);
    expect(await getCrmConfig()).toBeNull();
  });
  it('null when no token', async () => {
    mockReadConfig.mockResolvedValue({ CRM_ENABLED: 'true' } as any);
    expect(await getCrmConfig()).toBeNull();
  });
  it('decrypts token + reads createContact when enabled', async () => {
    mockReadConfig.mockResolvedValue({ CRM_ENABLED: 'true', CRM_TOKEN: 'v1.secrettoken', CRM_CREATE_CONTACT: 'true' } as any);
    expect(await getCrmConfig()).toEqual({ provider: 'hubspot', token: 'secrettoken', createContact: true });
    expect(await isCrmConfigured()).toBe(true);
  });
});

describe('findContactIdByEmail', () => {
  it('returns the first match id', async () => {
    const { calls } = installFetch([{ match: (u) => u.includes('/contacts/search'), json: { total: 1, results: [{ id: '42' }] } }]);
    expect(await findContactIdByEmail('TOK', 'a@b.com')).toBe('42');
    expect(calls[0].body.filterGroups[0].filters[0]).toMatchObject({ propertyName: 'email', operator: 'EQ', value: 'a@b.com' });
  });
  it('returns null on no match', async () => {
    installFetch([{ match: (u) => u.includes('/contacts/search'), json: { total: 0, results: [] } }]);
    expect(await findContactIdByEmail('TOK', 'none@b.com')).toBeNull();
  });
  it('returns null on API error', async () => {
    installFetch([{ match: () => true, status: 401 }]);
    expect(await findContactIdByEmail('TOK', 'a@b.com')).toBeNull();
  });
});

describe('createHubspotContact', () => {
  it('posts email + split name and returns id', async () => {
    const { calls } = installFetch([{ match: (u, i) => u.endsWith('/objects/contacts') && i?.method === 'POST', status: 201, json: { id: '99' } }]);
    expect(await createHubspotContact('TOK', 'a@b.com', 'Ann Marie Lee')).toBe('99');
    expect(calls[0].body.properties).toEqual({ email: 'a@b.com', firstname: 'Ann', lastname: 'Marie Lee' });
  });
  it('recovers a 409 (already exists) by searching', async () => {
    installFetch([
      { match: (u, i) => u.endsWith('/objects/contacts') && i?.method === 'POST', status: 409 },
      { match: (u) => u.includes('/contacts/search'), json: { results: [{ id: '7' }] } },
    ]);
    expect(await createHubspotContact('TOK', 'dup@b.com', 'Dup')).toBe('7');
  });
});

describe('logHubspotMeeting', () => {
  it('creates a meeting with COMPLETED outcome + contact associations (typeId 200)', async () => {
    const { calls } = installFetch([{ match: (u) => u.endsWith('/objects/meetings'), status: 201, json: { id: 'm-eng-1' } }]);
    const id = await logHubspotMeeting('TOK', { title: 'Standup', bodyHtml: '<p>hi</p>', url: 'https://g/x', startISO: '2026-06-23T10:00:00.000Z', endISO: '2026-06-23T10:30:00.000Z', contactIds: ['1', '2'] });
    expect(id).toBe('m-eng-1');
    const b = calls[0].body;
    expect(b.properties).toMatchObject({ hs_meeting_title: 'Standup', hs_meeting_outcome: 'COMPLETED', hs_timestamp: '2026-06-23T10:30:00.000Z', hs_meeting_external_url: 'https://g/x' });
    expect(b.associations).toHaveLength(2);
    expect(b.associations[0]).toEqual({ to: { id: '1' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 200 }] });
  });
});

describe('buildMeetingBody', () => {
  it('escapes HTML and renders summary + decisions + link', () => {
    const html = buildMeetingBody('We shipped <X> & more', ['Ship Friday', 'Use <Postgres>'], 'https://g/r');
    expect(html).toContain('We shipped &lt;X&gt; &amp; more');
    expect(html).toContain('<li>Ship Friday</li>');
    expect(html).toContain('<li>Use &lt;Postgres&gt;</li>');
    expect(html).toContain('href="https://g/r"');
  });
  it('falls back to a default body when empty', () => {
    expect(buildMeetingBody('', [], '')).toContain('Meeting completed');
  });
});

describe('testCrm', () => {
  it('ok on a 200 probe', async () => {
    mockReadConfig.mockResolvedValue({ CRM_TOKEN: 'v1.tok' } as any); // works even with CRM_ENABLED unset
    installFetch([{ match: (u) => u.includes('/contacts?limit=1'), status: 200 }]);
    expect(await testCrm()).toEqual({ ok: true });
  });
  it('not_configured without a token', async () => {
    mockReadConfig.mockResolvedValue({} as any);
    expect(await testCrm()).toEqual({ ok: false, error: 'not_configured' });
  });
  it('surfaces a non-2xx', async () => {
    mockReadConfig.mockResolvedValue({ CRM_TOKEN: 'v1.tok' } as any);
    installFetch([{ match: () => true, status: 403 }]);
    const r = await testCrm();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('403');
  });
});

describe('pushMeetingToCrm', () => {
  const enabled = { CRM_ENABLED: 'true', CRM_TOKEN: 'v1.tok' };

  it('no-op when disabled (no DB read)', async () => {
    mockReadConfig.mockResolvedValue({ CRM_ENABLED: 'false' } as any);
    const { fetchMock } = installFetch([{ match: () => true }]);
    await pushMeetingToCrm('m1');
    expect(prismaMock.meeting.findUnique).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs one meeting engagement to the matched contacts', async () => {
    mockReadConfig.mockResolvedValue(enabled as any);
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: 'm1', title: 'Sales call', scheduledAt: new Date('2026-06-23T10:00:00Z'), endedAt: new Date('2026-06-23T10:40:00Z'),
      participants: [
        { guestEmail: 'lead@acme.com', guestName: 'Lead Person', user: null },
        { guestEmail: null, guestName: null, user: { email: 'rep@garely.com', name: 'Rep' } },
      ],
      reports: [{ summary: 'Discussed pricing', decisions: ['Send proposal'] }],
    } as any);
    const { calls } = installFetch([
      // each search resolves to a distinct contact keyed by the email it filtered on
      { match: (u) => u.includes('/contacts/search'), json: (b: any) => ({ results: [{ id: 'c-' + b.filterGroups[0].filters[0].value }] }) },
      { match: (u) => u.endsWith('/objects/meetings'), status: 201, json: { id: 'eng1' } },
    ]);
    await pushMeetingToCrm('m1');
    const meetingCall = calls.find((c) => c.url.endsWith('/objects/meetings'));
    expect(meetingCall).toBeTruthy();
    expect(meetingCall!.body.properties.hs_meeting_title).toBe('Sales call');
    expect(meetingCall!.body.associations.length).toBe(2); // both participants matched
    expect(meetingCall!.body.properties.hs_meeting_body).toContain('Discussed pricing');
  });

  it('dedupes contacts when two participant emails resolve to the same contact', async () => {
    mockReadConfig.mockResolvedValue(enabled as any);
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: 'm1', title: 'Call', scheduledAt: null, endedAt: new Date('2026-06-23T10:40:00Z'),
      participants: [
        { guestEmail: 'a@acme.com', guestName: 'A', user: null },
        { guestEmail: 'a.alias@acme.com', guestName: 'A', user: null },
      ],
      reports: [{ summary: 's', decisions: [] }],
    } as any);
    const { calls } = installFetch([
      { match: (u) => u.includes('/contacts/search'), json: { results: [{ id: 'same-contact' }] } }, // both emails → same id
      { match: (u) => u.endsWith('/objects/meetings'), status: 201, json: { id: 'eng1' } },
    ]);
    await pushMeetingToCrm('m1');
    const meetingCall = calls.find((c) => c.url.endsWith('/objects/meetings'))!;
    expect(meetingCall.body.associations).toHaveLength(1); // deduped, not 2
    expect(meetingCall.body.associations[0].to.id).toBe('same-contact');
  });

  it('skips logging when nobody is in the CRM and createContact is off', async () => {
    mockReadConfig.mockResolvedValue(enabled as any);
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: 'm1', title: 'x', scheduledAt: null, endedAt: new Date('2026-06-23T10:40:00Z'),
      participants: [{ guestEmail: 'unknown@x.com', guestName: 'U', user: null }],
      reports: [{ summary: 's', decisions: [] }],
    } as any);
    const { calls } = installFetch([
      { match: (u) => u.includes('/contacts/search'), json: { results: [] } }, // no match
      { match: (u) => u.endsWith('/objects/meetings'), status: 201, json: { id: 'eng1' } },
    ]);
    await pushMeetingToCrm('m1');
    expect(calls.some((c) => c.url.endsWith('/objects/meetings'))).toBe(false);
  });

  it('creates a contact for an unmatched email when createContact is on', async () => {
    mockReadConfig.mockResolvedValue({ ...enabled, CRM_CREATE_CONTACT: 'true' } as any);
    prismaMock.meeting.findUnique.mockResolvedValue({
      id: 'm1', title: 'x', scheduledAt: null, endedAt: new Date('2026-06-23T10:40:00Z'),
      participants: [{ guestEmail: 'new@x.com', guestName: 'New Lead', user: null }],
      reports: [{ summary: 's', decisions: [] }],
    } as any);
    const { calls } = installFetch([
      { match: (u) => u.includes('/contacts/search'), json: { results: [] } },                        // no match
      { match: (u, i) => u.endsWith('/objects/contacts') && i?.method === 'POST', status: 201, json: { id: 'new-1' } }, // created
      { match: (u) => u.endsWith('/objects/meetings'), status: 201, json: { id: 'eng1' } },
    ]);
    await pushMeetingToCrm('m1');
    const meetingCall = calls.find((c) => c.url.endsWith('/objects/meetings'));
    expect(meetingCall!.body.associations[0].to.id).toBe('new-1');
  });
});
