import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonReq, mockSession, ctx } from '@/test/helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/regenerate', () => ({
  transcribeSpeakerFile: vi.fn(),
  regenerateMeetingReport: vi.fn(async () => {}),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    meeting: { findUnique: vi.fn() },
    speakerTrack: { findUnique: vi.fn(), update: vi.fn() },
    transcriptSegment: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (ops: any) => ops),
  },
}));

import { POST } from '@/app/api/meetings/[id]/fix-language/route';
import { auth } from '@/lib/auth';
import { transcribeSpeakerFile } from '@/lib/regenerate';
import { prisma } from '@/lib/prisma';

const call = () =>
  POST(
    jsonReq('POST', { trackId: 'trk1', language: 'ru' }, 'http://localhost/api/meetings/m1/fix-language'),
    ctx({ id: 'm1' }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue(mockSession({ role: 'admin' }) as any);
  vi.mocked(prisma.meeting.findUnique).mockResolvedValue({ id: 'm1', createdById: 'someone' } as any);
  vi.mocked(prisma.speakerTrack.findUnique).mockResolvedValue({
    id: 'trk1', meetingId: 'm1', speakerId: 'u1', speakerName: 'Late Joiner', filePath: '/x.wav',
  } as any);
  vi.mocked(prisma.speakerTrack.update).mockResolvedValue({} as any);
  vi.mocked(prisma.transcriptSegment.deleteMany).mockResolvedValue({ count: 2 } as any);
  vi.mocked(prisma.transcriptSegment.createMany).mockResolvedValue({ count: 2 } as any);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null as any);
});

describe('POST fix-language — re-basing onto the meeting-global timeline', () => {
  it('shifts WAV-relative re-transcription to preserve the speaker\'s position, and rebuilds epochs', async () => {
    // The speaker is a LATE joiner: their existing rows sit at ~600s on the meeting clock,
    // with absolute epochs. Re-transcription returns WAV-relative times (near 0).
    vi.mocked(prisma.transcriptSegment.findMany).mockResolvedValue([
      { startTime: 600, startEpochMs: 1700000600000 }, // WALL0 = 1700000600000 - 600000 = 1700000000000
      { startTime: 615, startEpochMs: 1700000615000 },
    ] as any);
    vi.mocked(transcribeSpeakerFile).mockResolvedValue([
      { content: 'привет', start: 0, end: 2, confidence: 0.9 },
      { content: 'как дела', start: 12, end: 14, confidence: 0.9 },
    ] as any);

    const res = await call();
    expect(res.status).toBe(200);

    const rows = vi.mocked(prisma.transcriptSegment.createMany).mock.calls[0][0].data as any[];
    // Earliest re-transcribed (start=0) must land at the speaker's existing base (600), NOT 0.
    expect(rows[0].startTime).toBe(600);
    expect(rows[1].startTime).toBe(612); // 12 + shift(600)
    // Epochs rebuilt from the recovered WALL0 (1700000000000).
    expect(rows[0].startEpochMs).toBe(1700000600000);
    expect(rows[1].startEpochMs).toBe(1700000612000);
  });

  it('is a no-op shift for an old meeting whose rows have no epochs (per-stream ~0)', async () => {
    vi.mocked(prisma.transcriptSegment.findMany).mockResolvedValue([
      { startTime: 0, startEpochMs: null },
      { startTime: 3, startEpochMs: null },
    ] as any);
    vi.mocked(transcribeSpeakerFile).mockResolvedValue([
      { content: 'a', start: 0, end: 1, confidence: 0.9 },
      { content: 'b', start: 5, end: 6, confidence: 0.9 },
    ] as any);

    await call();
    const rows = vi.mocked(prisma.transcriptSegment.createMany).mock.calls[0][0].data as any[];
    expect(rows[0].startTime).toBe(0); // base 0 - newMin 0 = 0 shift
    expect(rows[1].startTime).toBe(5);
    expect(rows[0].startEpochMs).toBeNull(); // no anchor → epochs stay null
    expect(rows[1].endEpochMs).toBeNull();
  });
});
