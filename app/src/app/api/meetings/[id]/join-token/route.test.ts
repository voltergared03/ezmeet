import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { auth } from '@/lib/auth';
import { userCanAccessMeeting } from '@/lib/access';
import { createLivekitToken, createRoom } from '@/lib/livekit';
import { mockSession, jsonReq, ctx } from '@/test/helpers';
import { POST } from '@/app/api/meetings/[id]/join-token/route';

vi.mock('@/lib/prisma');
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/access', () => ({ userCanAccessMeeting: vi.fn() }));
vi.mock('@/lib/livekit', () => ({
  createLivekitToken: vi.fn(async () => 'lk-token'),
  createRoom: vi.fn(async () => {}),
}));
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({ WS_MAX_PARTICIPANTS: '20' })),
}));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

const mockAuth = vi.mocked(auth);

const meeting = (over: Record<string, unknown> = {}) => ({
  id: 'm1', livekitRoom: 'room-1', joinToken: 'jt', status: 'active',
  allowGuests: true, createdById: 'host1', ...over,
});

beforeEach(() => {
  mockReset(prismaMock);
  mockAuth.mockReset();
  vi.mocked(createLivekitToken).mockClear();
  vi.mocked(createRoom).mockClear();
  vi.mocked(userCanAccessMeeting).mockReset();
});

describe('POST /api/meetings/[id]/join-token', () => {
  it('404 when the meeting does not exist', async () => {
    mockAuth.mockResolvedValue(mockSession());
    prismaMock.meeting.findUnique.mockResolvedValue(null as any);
    expect((await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).status).toBe(404);
  });

  it('401 when neither signed in nor a guest name given', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    expect((await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).status).toBe(401);
  });

  it('403 when a guest joins a meeting that disallows guests', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting({ allowGuests: false }) as any);
    expect((await POST(jsonReq('POST', { guestName: 'Guest' }), ctx({ id: 'm1' }))).status).toBe(403);
  });

  it('403 when a signed-in NON-participant asks to join a PRIVATE meeting (allowGuests=false)', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'outsider' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting({ allowGuests: false }) as any);
    vi.mocked(userCanAccessMeeting).mockResolvedValue(false);
    const r = await POST(jsonReq('POST', {}), ctx({ id: 'm1' }));
    expect(r.status).toBe(403);
    expect(createLivekitToken).not.toHaveBeenCalled(); // no token minted for an outsider
  });

  it('lets a signed-in PARTICIPANT into a private meeting', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'member' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting({ allowGuests: false }) as any);
    vi.mocked(userCanAccessMeeting).mockResolvedValue(true);
    prismaMock.user.findUnique.mockResolvedValue({ preferences: {} } as any);
    const r = await POST(jsonReq('POST', {}), ctx({ id: 'm1' }));
    expect(r.status).toBe(200);
  });

  it('does NOT gate an OPEN meeting (allowGuests default true) for a signed-in member', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'member' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any); // allowGuests: true
    prismaMock.user.findUnique.mockResolvedValue({ preferences: {} } as any);
    const r = await POST(jsonReq('POST', {}), ctx({ id: 'm1' }));
    expect(r.status).toBe(200);
    expect(userCanAccessMeeting).not.toHaveBeenCalled(); // open meeting → no access query
  });

  it('202 + creates a join request for a new guest (waiting room)', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.joinRequest.create.mockResolvedValue({ id: 'jr1' } as any);
    const r = await POST(jsonReq('POST', { guestName: 'Guest' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(202);
    expect((await r.json()).requestId).toBe('jr1');
  });

  it('404 when the join request belongs to another meeting', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.joinRequest.findUnique.mockResolvedValue({ id: 'jr1', meetingId: 'OTHER', status: 'approved' } as any);
    expect((await POST(jsonReq('POST', { guestName: 'G', requestId: 'jr1' }), ctx({ id: 'm1' }))).status).toBe(404);
  });

  it('403 { denied } when the guest request was denied', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.joinRequest.findUnique.mockResolvedValue({ id: 'jr1', meetingId: 'm1', status: 'denied' } as any);
    const r = await POST(jsonReq('POST', { guestName: 'G', requestId: 'jr1' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(403);
    expect((await r.json()).denied).toBe(true);
  });

  it('202 pending while the guest request is not yet approved', async () => {
    mockAuth.mockResolvedValue(null);
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.joinRequest.findUnique.mockResolvedValue({ id: 'jr1', meetingId: 'm1', status: 'pending' } as any);
    expect((await POST(jsonReq('POST', { guestName: 'G', requestId: 'jr1' }), ctx({ id: 'm1' }))).status).toBe(202);
  });

  it('grants canKick to the host', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'host1', role: 'member' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.user.findUnique.mockResolvedValue({ preferences: {} } as any);
    const j = await (await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).json();
    expect(j.token).toBe('lk-token');
    expect(j.isHost).toBe(true);
    expect(j.canKick).toBe(true);
  });

  it('does NOT grant canKick to a regular participant', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'someone', role: 'member' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.user.findUnique.mockResolvedValue({ preferences: {} } as any);
    const j = await (await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).json();
    expect(j.isHost).toBe(false);
    expect(j.isAdmin).toBe(false);
    expect(j.canKick).toBe(false);
  });

  it('grants canKick to an admin who is not the host', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'someone', role: 'admin' }));
    prismaMock.meeting.findUnique.mockResolvedValue(meeting() as any);
    prismaMock.user.findUnique.mockResolvedValue({ preferences: {} } as any);
    const j = await (await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).json();
    expect(j.isAdmin).toBe(true);
    expect(j.canKick).toBe(true);
  });

  it('410 when the meeting has ended (no resurrecting a dead room)', async () => {
    mockAuth.mockResolvedValue(mockSession());
    prismaMock.meeting.findUnique.mockResolvedValue(meeting({ status: 'ended' }) as any);
    const r = await POST(jsonReq('POST', {}), ctx({ id: 'm1' }));
    expect(r.status).toBe(410);
    expect((await r.json()).ended).toBe(true);
  });

  it('410 when the meeting was cancelled', async () => {
    mockAuth.mockResolvedValue(mockSession());
    prismaMock.meeting.findUnique.mockResolvedValue(meeting({ status: 'cancelled' }) as any);
    expect((await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).status).toBe(410);
  });

  it('410 on an ended occurrence returns the next live occurrence token', async () => {
    mockAuth.mockResolvedValue(mockSession());
    prismaMock.meeting.findUnique.mockResolvedValue(
      meeting({ status: 'ended', recurrence: { type: 'weekly', seriesId: 's1' } }) as any,
    );
    prismaMock.meeting.findFirst.mockResolvedValue({ joinToken: 'next-jt' } as any);
    const j = await (await POST(jsonReq('POST', {}), ctx({ id: 'm1' }))).json();
    expect(j.nextToken).toBe('next-jt');
  });
});
