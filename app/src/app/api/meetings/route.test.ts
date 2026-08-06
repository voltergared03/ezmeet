import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { GET } from './route';

vi.mock('@/lib/prisma');
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => null) }));
vi.mock('@/lib/internal-auth', () => ({ isInternalAuthed: vi.fn(() => true) }));

beforeEach(() => { mockReset(prismaMock); });

describe('GET /api/meetings?livekitRoom= (the STT agent lookup)', () => {
  it('returns transcriptionEnabled — the agent gates on it, and omitting it kills the switch', async () => {
    // Regression: the select shipped without this field, so agent.py read undefined,
    // `is False` never matched, and turning transcription off did nothing at all.
    prismaMock.meeting.findMany.mockResolvedValue([
      { id: 'm1', livekitRoom: 'meet-x', status: 'live', title: 'T', transcriptionEnabled: false },
    ] as any);

    const res = await GET(new Request('http://x/api/meetings?livekitRoom=meet-x') as any);
    const body = await res.json();

    expect(body[0]).toHaveProperty('transcriptionEnabled', false);
    const select = (prismaMock.meeting.findMany.mock.calls[0][0] as any).select;
    expect(select.transcriptionEnabled).toBe(true);
  });
});
