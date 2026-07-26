import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: { meeting: { updateMany: vi.fn() } } }));

import { GET } from '@/app/api/cron/report-backstop/route';
import { prisma } from '@/lib/prisma';

const req = (secret?: string) =>
  ({ url: `http://localhost/api/cron/report-backstop${secret !== undefined ? `?secret=${secret}` : ''}` }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'S';
  vi.mocked(prisma.meeting.updateMany).mockResolvedValue({ count: 2 } as any);
});

describe('cron/report-backstop', () => {
  it('403 without the cron secret', async () => {
    const r = await GET(req('nope'));
    expect(r.status).toBe(403);
    expect(prisma.meeting.updateMany).not.toHaveBeenCalled();
  });

  it('fails only stale generating reports and reports the count', async () => {
    const r = await GET(req('S'));
    expect((await r.json()).released).toBe(2);
    const arg = vi.mocked(prisma.meeting.updateMany).mock.calls[0][0] as any;
    expect(arg.where.reportStatus).toBe('generating'); // never touches ready/failed
    expect(arg.data.reportStatus).toBe('failed');
    // Only clearly-stale rows: an old start OR a pre-fix null start.
    expect(arg.where.OR).toEqual([
      { reportStartedAt: { lt: expect.any(Date) } },
      { reportStartedAt: null },
    ]);
  });
});
