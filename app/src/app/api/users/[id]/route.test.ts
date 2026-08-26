import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jsonReq, ctx, mockSession } from '@/test/helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/with-route', () => ({ withRoute: (_n: string, h: any) => h }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));
vi.mock('@/lib/suppression', () => ({ suppressEmail: vi.fn(async () => {}) }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn(), count: vi.fn() },
    meeting: { updateMany: vi.fn() },
    meetingParticipant: { deleteMany: vi.fn() },
    $transaction: vi.fn(async () => []),
  },
}));

import { PATCH } from '@/app/api/users/[id]/route';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

const mAuth = vi.mocked(auth);
const findUnique = vi.mocked(prisma.user.findUnique);
const update = vi.mocked(prisma.user.update);
const count = vi.mocked(prisma.user.count);

beforeEach(() => {
  vi.clearAllMocks();
  mAuth.mockResolvedValue(mockSession({ id: 'admin1', email: 'a@x.com', role: 'admin' }) as any);
  // first findUnique = "who is calling"
  findUnique.mockResolvedValue({ id: 'admin1', role: 'admin' } as any);
  update.mockResolvedValue({ id: 'u2', name: 'B', email: 'b@x.com', role: 'member', status: 'disabled', preferences: {} } as any);
  count.mockResolvedValue(1 as any);
});

describe('PATCH /api/users/[id] — blocking an account', () => {
  it('blocking REVOKES the session by bumping sessionEpoch', async () => {
    // The point of the whole design: 70 route handlers read auth() directly and never
    // re-check status, so instead of teaching all of them, the cookie is invalidated.
    const r = await PATCH(jsonReq('PATCH', { status: 'disabled' }), ctx({ id: 'u2' }));
    expect(r.status).toBe(200);
    const data = (update.mock.calls[0][0] as any).data;
    expect(data.status).toBe('disabled');
    expect(data.sessionEpoch).toEqual({ increment: 1 });
  });

  it('unblocking does NOT bump the epoch — there is nothing to revoke', async () => {
    update.mockResolvedValue({ id: 'u2', name: 'B', email: 'b@x.com', role: 'member', status: 'active', preferences: {} } as any);
    await PATCH(jsonReq('PATCH', { status: 'active' }), ctx({ id: 'u2' }));
    const data = (update.mock.calls[0][0] as any).data;
    expect(data.status).toBe('active');
    expect(data.sessionEpoch).toBeUndefined();
  });

  it('refuses to block your own account — you would lock yourself out mid-action', async () => {
    const r = await PATCH(jsonReq('PATCH', { status: 'disabled' }), ctx({ id: 'admin1' }));
    expect(r.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses to block the last ACTIVE admin — the way back would be direct SQL', async () => {
    count.mockResolvedValue(0 as any);                    // no other active admin
    findUnique
      .mockResolvedValueOnce({ id: 'admin1', role: 'admin' } as any) // caller
      .mockResolvedValueOnce({ role: 'admin' } as any);              // target
    const r = await PATCH(jsonReq('PATCH', { status: 'disabled' }), ctx({ id: 'admin2' }));
    expect(r.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('blocking the last MEMBER is fine — only admins can lock the workspace out', async () => {
    count.mockResolvedValue(0 as any);
    findUnique
      .mockResolvedValueOnce({ id: 'admin1', role: 'admin' } as any)
      .mockResolvedValueOnce({ role: 'member' } as any);
    const r = await PATCH(jsonReq('PATCH', { status: 'disabled' }), ctx({ id: 'u2' }));
    expect(r.status).toBe(200);
  });

  it('rejects a status that is neither active nor disabled', async () => {
    const r = await PATCH(jsonReq('PATCH', { status: 'banished' }), ctx({ id: 'u2' }));
    expect(r.status).toBe(400);
  });

  it('non-admins cannot change status at all', async () => {
    mAuth.mockResolvedValue(mockSession({ id: 'u9', email: 'm@x.com', role: 'member' }) as any);
    findUnique.mockResolvedValue({ id: 'u9', role: 'member' } as any);
    const r = await PATCH(jsonReq('PATCH', { status: 'disabled' }), ctx({ id: 'u2' }));
    expect(r.status).toBe(403);
  });
});
