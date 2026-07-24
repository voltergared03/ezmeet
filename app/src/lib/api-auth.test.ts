import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auth } from '@/lib/auth';
import { userCanAccessMeeting } from '@/lib/access';
import { requireAuth, requireAdmin, requireMeetingAccess } from '@/lib/api-auth';
import { mockSession } from '@/test/helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/access', () => ({ userCanAccessMeeting: vi.fn() }));

const mockAuth = vi.mocked(auth);
const mockAccess = vi.mocked(userCanAccessMeeting);

beforeEach(() => {
  mockAuth.mockReset();
  mockAccess.mockReset();
});

const status = (r: unknown) => (r as Response).status;

describe('requireAuth', () => {
  it('responds 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    const r = await requireAuth();
    expect(r).toBeInstanceOf(Response);
    expect(status(r)).toBe(401);
  });

  it('returns the session when signed in', async () => {
    const s = mockSession();
    mockAuth.mockResolvedValue(s);
    expect(await requireAuth()).toBe(s);
  });
});

describe('disabled accounts are cut off from the API too', () => {
  it('requireAuth responds 403 for a disabled user with a valid session', async () => {
    mockAuth.mockResolvedValue(mockSession({ status: 'disabled' }));
    expect(status(await requireAuth())).toBe(403);
  });

  it('requireMeetingAccess responds 403 for a disabled user before checking access', async () => {
    mockAuth.mockResolvedValue(mockSession({ status: 'disabled' }));
    const r = await requireMeetingAccess('m1');
    expect(status(r)).toBe(403);
    expect(mockAccess).not.toHaveBeenCalled(); // short-circuits before the access query
  });

  it('requireAdmin responds 403 for a disabled admin', async () => {
    mockAuth.mockResolvedValue(mockSession({ role: 'admin', status: 'disabled' }));
    expect(status(await requireAdmin())).toBe(403);
  });
});

describe('requireAdmin', () => {
  it('responds 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect(status(await requireAdmin())).toBe(401);
  });

  it('responds 403 for a non-admin', async () => {
    mockAuth.mockResolvedValue(mockSession({ role: 'member' }));
    expect(status(await requireAdmin())).toBe(403);
  });

  it('returns the session for an admin', async () => {
    const s = mockSession({ role: 'admin' });
    mockAuth.mockResolvedValue(s);
    expect(await requireAdmin()).toBe(s);
  });
});

describe('requireMeetingAccess', () => {
  it('responds 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect(status(await requireMeetingAccess('m1'))).toBe(401);
    expect(mockAccess).not.toHaveBeenCalled();
  });

  it('responds 403 when the user cannot access the meeting', async () => {
    mockAuth.mockResolvedValue(mockSession());
    mockAccess.mockResolvedValue(false);
    expect(status(await requireMeetingAccess('m1'))).toBe(403);
  });

  it('returns the session when access is granted', async () => {
    const s = mockSession({ id: 'u7' });
    mockAuth.mockResolvedValue(s);
    mockAccess.mockResolvedValue(true);
    expect(await requireMeetingAccess('m1')).toBe(s);
    expect(mockAccess).toHaveBeenCalledWith('m1', 'u7', 'member');
  });
});
