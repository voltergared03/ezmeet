import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';

vi.mock('@/lib/prisma');
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => ({ user: { id: 'u1', role: 'admin' } })) }));
vi.mock('@/lib/meeting-invite', () => ({ sendMeetingInvite: vi.fn(async () => {}) }));
vi.mock('@/lib/calendar-sync', () => ({ syncMeetingToGoogle: vi.fn(async () => {}) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

beforeEach(() => { mockReset(prismaMock); });

describe('DELETE /api/meetings/[id] — task cleanup', () => {
  it('sweeps the meeting task Rows and their ClickUp links (no FK does it for us)', async () => {
    // Regression: TaskRow.meetingId has no foreign key, so deleting a meeting left its
    // AI tasks behind forever — pointing at a meeting that no longer exists and
    // un-editable for non-admins because permission resolves through that dead meeting.
    const { DELETE } = await import('./route');
    prismaMock.meeting.findUnique.mockResolvedValue({ id: 'm1', createdById: 'u1', orgId: 'o1' } as any);
    prismaMock.recording.count.mockResolvedValue(0 as any);
    prismaMock.taskRow.findMany.mockResolvedValue([{ rowId: 'r1' }, { rowId: 'r2' }] as any);
    prismaMock.clickUpTaskLink.deleteMany.mockResolvedValue({ count: 2 } as any);
    prismaMock.row.deleteMany.mockResolvedValue({ count: 2 } as any);
    prismaMock.meeting.delete.mockResolvedValue({} as any);

    await DELETE(new Request('http://x', { method: 'DELETE' }) as any, { params: Promise.resolve({ id: 'm1' }) } as any);

    expect(prismaMock.clickUpTaskLink.deleteMany).toHaveBeenCalledWith({ where: { rowId: { in: ['r1', 'r2'] } } });
    expect(prismaMock.row.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r2'] } } });
    expect(prismaMock.meeting.delete).toHaveBeenCalled();
  });
});
