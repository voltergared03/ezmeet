import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { suppressEmail, unsuppressEmail, filterSuppressed, isSuppressed } from '@/lib/suppression';

vi.mock('@/lib/prisma');

beforeEach(() => mockReset(prismaMock));

describe('filterSuppressed', () => {
  it('drops suppressed addresses and keeps the rest', async () => {
    prismaMock.suppressedEmail.findMany.mockResolvedValue([{ email: 'gone@x.com' }] as any);
    expect(await filterSuppressed(['keep@x.com', 'gone@x.com'])).toEqual(['keep@x.com']);
  });

  it('matches case-insensitively — Google hands back whatever case the organiser typed', async () => {
    prismaMock.suppressedEmail.findMany.mockResolvedValue([{ email: 'gone@x.com' }] as any);
    expect(await filterSuppressed(['GONE@X.com', ' Keep@X.com '])).toEqual(['keep@x.com']);
  });

  it('dedupes, and short-circuits an empty list without touching the database', async () => {
    prismaMock.suppressedEmail.findMany.mockResolvedValue([] as any);
    expect(await filterSuppressed(['a@x.com', 'a@x.com', ''])).toEqual(['a@x.com']);
    expect(await filterSuppressed([])).toEqual([]);
    expect(prismaMock.suppressedEmail.findMany).toHaveBeenCalledTimes(1); // not for the empty call
  });

  it('fails OPEN — a database error must not silently swallow a meeting invitation', async () => {
    // The alternative is worse than the bug this list exists to fix: everyone stops
    // getting invited, and nothing says why.
    prismaMock.suppressedEmail.findMany.mockRejectedValue(new Error('db down') as any);
    expect(await filterSuppressed(['a@x.com', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('suppressEmail / unsuppressEmail', () => {
  it('stores lowercased and is idempotent (upsert, not create)', async () => {
    prismaMock.suppressedEmail.upsert.mockResolvedValue({} as any);
    await suppressEmail('  Gone@X.COM ', 'user_deleted');
    const arg = prismaMock.suppressedEmail.upsert.mock.calls[0][0] as any;
    expect(arg.where.email).toBe('gone@x.com');
    expect(arg.create.reason).toBe('user_deleted');
  });

  it('ignores a missing address rather than writing an empty row', async () => {
    await suppressEmail(null);
    await suppressEmail('   ');
    expect(prismaMock.suppressedEmail.upsert).not.toHaveBeenCalled();
  });

  it('re-creating a user with the same address lifts the block', async () => {
    prismaMock.suppressedEmail.deleteMany.mockResolvedValue({ count: 1 } as any);
    await unsuppressEmail('GONE@x.com');
    const arg = prismaMock.suppressedEmail.deleteMany.mock.calls[0][0] as any;
    expect(arg.where.email).toBe('gone@x.com');
  });
});

describe('isSuppressed', () => {
  it('is true only for a stored address, and false when the lookup fails', async () => {
    prismaMock.suppressedEmail.findUnique.mockResolvedValue({ email: 'gone@x.com' } as any);
    expect(await isSuppressed('Gone@x.com')).toBe(true);
    prismaMock.suppressedEmail.findUnique.mockResolvedValue(null as any);
    expect(await isSuppressed('here@x.com')).toBe(false);
    prismaMock.suppressedEmail.findUnique.mockRejectedValue(new Error('db down') as any);
    expect(await isSuppressed('here@x.com')).toBe(false);
    expect(await isSuppressed(null)).toBe(false);
  });
});
