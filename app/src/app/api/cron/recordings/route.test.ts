import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({
  prisma: { recording: { findMany: vi.fn(), delete: vi.fn() } },
}));
vi.mock('@/lib/egress', () => ({ RECORDINGS_DIR: '/recordings' }));
vi.mock('@/lib/with-route', () => ({ withRoute: (_n: string, h: any) => h }));
const readdir = vi.fn();
const stat = vi.fn();
const unlink = vi.fn(async () => {});
vi.mock('fs', () => ({ promises: { readdir: (...a: any[]) => readdir(...a), stat: (...a: any[]) => stat(...a), unlink: (...a: any[]) => unlink(...a) } }));

import { GET } from '@/app/api/cron/recordings/route';
import { prisma } from '@/lib/prisma';

const OLD = Date.now() - 40 * 24 * 3600 * 1000; // 40 days ago
const FRESH = Date.now() - 60 * 1000; // a minute ago
const req = (secret = 'S') => ({ nextUrl: { searchParams: { get: () => secret } } }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'S';
  vi.mocked(prisma.recording.findMany).mockResolvedValue([] as any);
  readdir.mockResolvedValue([]);
  stat.mockResolvedValue({ isFile: () => true, mtimeMs: OLD });
});

describe('cron/recordings storage housekeeping', () => {
  it('403 on a wrong secret', async () => {
    const r = await GET(req('nope') as any);
    expect(r.status).toBe(403);
  });

  it('NEVER deletes a file referenced by a Recording row, even if old', async () => {
    // Two recordings: one main file, one screen-audio with a source segment in meta.
    vi.mocked(prisma.recording.findMany)
      .mockResolvedValueOnce([] as any) // expiry pass: nothing expired
      .mockResolvedValueOnce([
        { filePath: '/recordings/final.mp4', meta: null },
        { filePath: '/recordings/aud.ogg', meta: { audioFile: 'aud.ogg', screenSegments: [{ fileName: 'seg1.mp4' }] } },
      ] as any);
    // Recordings dir holds referenced files + one true orphan, all old.
    readdir.mockImplementation(async (dir: string) =>
      dir === '/recordings' ? ['final.mp4', 'aud.ogg', 'seg1.mp4', 'orphan.mp4'] : []);

    const res = await GET(req() as any);
    const body = await res.json();
    expect(body.orphansPruned).toBe(1);
    const deletedNames = unlink.mock.calls.map((c) => String(c[0]));
    expect(deletedNames).toContain('/recordings/orphan.mp4');
    expect(deletedNames).not.toContain('/recordings/final.mp4');
    expect(deletedNames).not.toContain('/recordings/aud.ogg');
    expect(deletedNames).not.toContain('/recordings/seg1.mp4'); // referenced via meta segment
  });

  it('keeps a FRESH orphan (younger than the safety window)', async () => {
    vi.mocked(prisma.recording.findMany)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([] as any); // nothing referenced
    readdir.mockImplementation(async (dir: string) => (dir === '/recordings' ? ['brandnew.mp4'] : []));
    stat.mockResolvedValue({ isFile: () => true, mtimeMs: FRESH });

    const res = await GET(req() as any);
    expect((await res.json()).orphansPruned).toBe(0);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('prunes old speaker-audio WAVs and keeps fresh ones', async () => {
    process.env.SPEAKER_AUDIO_DIR = '/speaker-audio';
    vi.mocked(prisma.recording.findMany)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([] as any);
    readdir.mockImplementation(async (dir: string) =>
      dir === '/speaker-audio' ? ['old.wav', 'fresh.wav'] : []);
    stat.mockImplementation(async (full: string) => ({
      isFile: () => true,
      mtimeMs: full.includes('fresh') ? FRESH : OLD,
    }));

    const res = await GET(req() as any);
    expect((await res.json()).speakerAudioPruned).toBe(1);
    const deleted = unlink.mock.calls.map((c) => String(c[0]));
    expect(deleted).toContain('/speaker-audio/old.wav');
    expect(deleted).not.toContain('/speaker-audio/fresh.wav');
  });
});
