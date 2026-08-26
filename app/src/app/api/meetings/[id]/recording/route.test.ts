import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonReq, ctx, mockSession } from '@/test/helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/with-route', () => ({ withRoute: (_n: string, h: any) => h }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('@/lib/access', () => ({ userCanAccessMeeting: vi.fn(async () => true) }));
vi.mock('@/lib/egress', () => ({
  startRoomRecording: vi.fn(async () => ({ egressId: 'eg1', fileName: 'f.mp4', filePath: '/recordings/f.mp4' })),
  stopRecording: vi.fn(async () => {}),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    meeting: { findUnique: vi.fn() },
    recording: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

import { POST, GET } from '@/app/api/meetings/[id]/recording/route';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { startRoomRecording, stopRecording } from '@/lib/egress';

const mAuth = vi.mocked(auth);
const findUnique = vi.mocked(prisma.meeting.findUnique);
const recFindFirst = vi.mocked(prisma.recording.findFirst);
const recCreate = vi.mocked(prisma.recording.create);

beforeEach(() => {
  vi.clearAllMocks();
  recCreate.mockResolvedValue({ id: 'r1' } as any);
});

describe('POST /api/meetings/[id]/recording (in-meeting start/stop)', () => {
  it('401 without a session', async () => {
    mAuth.mockResolvedValue(null as any);
    const r = await POST(jsonReq('POST', { action: 'start' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(401);
  });

  it('403 for a non-owner, non-admin', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'intruder', role: 'member' }));
    findUnique.mockResolvedValue({ createdById: 'owner-1' } as any);
    const r = await POST(jsonReq('POST', { action: 'start' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(403);
    expect(startRoomRecording).not.toHaveBeenCalled();
  });

  it('creator can start: spawns egress + creates a processing row', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'owner-1', role: 'member' }));
    findUnique.mockResolvedValue({ createdById: 'owner-1', livekitRoom: 'room-1' } as any);
    recFindFirst.mockResolvedValue(null);
    const r = await POST(jsonReq('POST', { action: 'start' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(200);
    expect(startRoomRecording).toHaveBeenCalledWith('room-1');
    const arg = recCreate.mock.calls[0][0] as any;
    expect(arg.data.status).toBe('processing');
    expect(arg.data.egressId).toBe('eg1');
    expect((await r.json()).active).toBe(true);
  });

  it('start is idempotent while already recording', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'a', role: 'admin' }));
    findUnique.mockResolvedValue({ livekitRoom: 'room-1' } as any);
    recFindFirst.mockResolvedValue({ id: 'rec-live', egressId: 'eg-live', status: 'processing' } as any);
    const r = await POST(jsonReq('POST', { action: 'start' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(200);
    expect(startRoomRecording).not.toHaveBeenCalled();
    expect(recCreate).not.toHaveBeenCalled();
  });

  it('stop ends the active egress', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'a', role: 'admin' }));
    findUnique.mockResolvedValue({ livekitRoom: 'room-1' } as any);
    recFindFirst.mockResolvedValue({ id: 'rec-live', egressId: 'eg-live', status: 'processing' } as any);
    const r = await POST(jsonReq('POST', { action: 'stop' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(200);
    expect(stopRecording).toHaveBeenCalledWith('eg-live');
    expect((await r.json()).active).toBe(false);
  });

  it('400 on an unknown action', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'a', role: 'admin' }));
    findUnique.mockResolvedValue({ livekitRoom: 'room-1' } as any);
    recFindFirst.mockResolvedValue(null);
    const r = await POST(jsonReq('POST', { action: 'frobnicate' }), ctx({ id: 'm1' }));
    expect(r.status).toBe(400);
  });
});


describe('GET /api/meetings/[id]/recording', () => {
  const rec = (over: Record<string, unknown> = {}) => ({
    id: 'r1', fileName: 'f.mp4', fileSize: null, durationSec: null,
    status: 'ready', permanent: false, expiresAt: null, createdAt: new Date('2026-08-26T12:00:00Z'),
    ...over,
  }) as any;

  it('returns a FAILED recording instead of hiding it', async () => {
    // It used to filter on status: 'ready', so a lost recording came back as null and
    // the page rendered what it renders for a meeting nobody recorded. A failure the
    // user cannot see is one they cannot act on.
    mAuth.mockResolvedValue(mockSession({ id: 'u1' }) as any);
    recFindFirst.mockResolvedValue(rec({ status: 'failed' }));
    const r = await GET(jsonReq('GET'), ctx({ id: 'm1' }));
    const body = await r.json();
    expect(body.recording.status).toBe('failed');
    // and the query must not be narrowed by status
    expect(recFindFirst.mock.calls[0][0].where).toEqual({ meetingId: 'm1' });
  });

  it('still returns a ready recording', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'u1' }) as any);
    recFindFirst.mockResolvedValue(rec());
    const body = await (await GET(jsonReq('GET'), ctx({ id: 'm1' }))).json();
    expect(body.recording.status).toBe('ready');
    expect(body.recording.url).toBe('/api/recordings/r1/file');
  });

  it('returns null when the meeting has no recording at all', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'u1' }) as any);
    recFindFirst.mockResolvedValue(null as any);
    const body = await (await GET(jsonReq('GET'), ctx({ id: 'm1' }))).json();
    expect(body.recording).toBeNull();
  });
});
