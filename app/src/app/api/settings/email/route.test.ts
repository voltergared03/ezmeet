import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { auth } from '@/lib/auth';
import { jsonReq } from '@/test/helpers';
import { PATCH } from '@/app/api/settings/email/route';

vi.mock('@/lib/prisma');
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const mockAuth = vi.mocked(auth);
const url = 'http://localhost/api/settings/email';
const admin = () => ({ user: { id: 'u1', role: 'admin', orgId: 'org-A' } }) as any;

beforeEach(() => {
  mockReset(prismaMock);
  mockAuth.mockReset();
  prismaMock.systemConfig.upsert.mockResolvedValue({} as any);
});

/** Collect the { key -> value } that the handler upserted. */
function upserted(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const call of prismaMock.systemConfig.upsert.mock.calls) {
    const arg = call[0] as any;
    out[arg.where.key] = arg.update.value;
  }
  return out;
}

describe('PATCH /api/settings/email — credential re-point guard (F-10)', () => {
  it('403 for non-admin', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'member' } } as any);
    const res = await PATCH(jsonReq('PATCH', { host: 'mail.evil.com' }, url));
    expect(res.status).toBe(403);
  });

  it('clears the stored password when the host changes and no new password is given', async () => {
    mockAuth.mockResolvedValue(admin());
    prismaMock.systemConfig.findUnique.mockResolvedValue({ value: 'mail.old.com' } as any);
    await PATCH(jsonReq('PATCH', { host: 'mail.evil.com' }, url));
    const u = upserted();
    expect(u.SMTP_HOST).toBe('mail.evil.com');
    expect(u.SMTP_PASS).toBe(''); // stored password wiped → cannot be sent to the new host
  });

  it('keeps the password when the host is unchanged', async () => {
    mockAuth.mockResolvedValue(admin());
    prismaMock.systemConfig.findUnique.mockResolvedValue({ value: 'mail.old.com' } as any);
    await PATCH(jsonReq('PATCH', { host: 'mail.old.com', fromName: 'Garely' }, url));
    const u = upserted();
    expect(u).not.toHaveProperty('SMTP_PASS'); // untouched
  });

  it('does NOT clear the password when a new password accompanies the host change', async () => {
    mockAuth.mockResolvedValue(admin());
    prismaMock.systemConfig.findUnique.mockResolvedValue({ value: 'mail.old.com' } as any);
    await PATCH(jsonReq('PATCH', { host: 'mail.new.com', pass: 'fresh-secret' }, url));
    const u = upserted();
    expect(u.SMTP_HOST).toBe('mail.new.com');
    expect(u.SMTP_PASS).toBe('fresh-secret');
  });
});
