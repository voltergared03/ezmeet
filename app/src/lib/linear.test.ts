import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { readConfig } from '@/lib/config';
import {
  mapPriority, normName, dedupeKeyFor, teamIdForDepartment,
  garelyStatusToStateType, linearStateToGarely, withinReplayWindow,
  getLinearConfig, verifyLinearSignature, pushMeetingTasksToLinear, applyLinearEvent,
  type LinearConfig, type LinearPushItem,
} from '@/lib/linear';
import { createHmac } from 'crypto';

vi.mock('@/lib/prisma');
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({})),
  writeConfig: vi.fn(async () => {}),
  publicBaseUrl: vi.fn(async () => 'https://meet.example.com'),
}));
vi.mock('@/lib/twofactor', () => ({ decryptSecret: vi.fn((x: string) => x), encryptSecret: vi.fn((x: string) => x) }));
vi.mock('@/lib/org', () => ({ getSingletonOrgId: vi.fn(async () => 'org1') }));
vi.mock('@/lib/system-tasks-table', () => ({
  getSystemTasksTable: vi.fn(async () => ({ table: { id: 't1' }, fieldIds: { title: 'fT', description: 'fD', status: 'fS', priority: 'fP', dueDate: 'fDue', assignee: 'fA' } })),
}));

const mockReadConfig = vi.mocked(readConfig);

/** Route a fake Linear GraphQL response by the query string. */
function installGraphQL(routes: { match: string; data: any }[]) {
  const calls: { query: string; variables: any }[] = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body));
    calls.push({ query: parsed.query, variables: parsed.variables });
    const route = routes.find((r) => parsed.query.includes(r.match));
    return { ok: true, status: 200, json: async () => ({ data: route?.data ?? {} }), text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

beforeEach(() => { mockReset(prismaMock); vi.unstubAllGlobals(); vi.clearAllMocks(); mockReadConfig.mockResolvedValue({} as any); });

// ─────────────────────────── pure mappers ───────────────────────────

describe('mapPriority', () => {
  it('maps Garely priority → Linear priority Int', () => {
    expect(mapPriority('high')).toBe(2);
    expect(mapPriority('medium')).toBe(3);
    expect(mapPriority('low')).toBe(4);
    expect(mapPriority('HIGH')).toBe(2);
    expect(mapPriority(null)).toBe(0); // No priority
  });
});

describe('normName', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normName('  Sales   Team ')).toBe('sales team');
    expect(normName(null)).toBe('');
  });
});

describe('dedupeKeyFor', () => {
  it('is stable for the same semantic tuple and differs on title/dept/parent', () => {
    const a = dedupeKeyFor('m1', 'Ship it', 'd1', null);
    expect(dedupeKeyFor('m1', 'ship it', 'd1', null)).toBe(a); // normalized
    expect(dedupeKeyFor('m1', 'Ship it', 'd2', null)).not.toBe(a);
    expect(dedupeKeyFor('m1', 'Ship it', 'd1', 'Parent')).not.toBe(a);
  });
});

describe('teamIdForDepartment', () => {
  const cfg = (mode: 'department' | 'inbox'): LinearConfig => ({ token: 't', routingMode: mode, teamMap: {}, fallbackTeamId: 'fb' });
  const map = { byDept: new Map([['sales', 'teamS']]), fallbackTeamId: 'fb' };
  it('routes by department name, falls back when unmatched', () => {
    expect(teamIdForDepartment(cfg('department'), map, 'Sales')).toBe('teamS');
    expect(teamIdForDepartment(cfg('department'), map, 'Unknown')).toBe('fb');
    expect(teamIdForDepartment(cfg('department'), map, null)).toBe('fb');
  });
  it('inbox mode always uses the fallback team', () => {
    expect(teamIdForDepartment(cfg('inbox'), map, 'Sales')).toBe('fb');
  });
});

describe('status mapping', () => {
  it('Garely status → workflow-state TYPE', () => {
    expect(garelyStatusToStateType('in_progress')).toBe('started');
    expect(garelyStatusToStateType('done')).toBe('completed');
    expect(garelyStatusToStateType('open')).toBe('unstarted');
    expect(garelyStatusToStateType(null)).toBe('unstarted');
  });
  it('Linear workflow state → Garely 3-state', () => {
    expect(linearStateToGarely('completed', 'Done')).toBe('done');
    expect(linearStateToGarely('canceled', 'Canceled')).toBe('done');
    expect(linearStateToGarely('started', 'In Progress')).toBe('in_progress');
    expect(linearStateToGarely('unstarted', 'Todo')).toBe('open');
    expect(linearStateToGarely('backlog', 'Backlog')).toBe('open');
    expect(linearStateToGarely('triage', 'In Review')).toBe('in_progress'); // name-based fallback
  });
});

describe('withinReplayWindow', () => {
  it('accepts fresh timestamps, rejects stale/missing', () => {
    const now = 1_000_000;
    expect(withinReplayWindow(now, now)).toBe(true);
    expect(withinReplayWindow(now - 30_000, now)).toBe(true);
    expect(withinReplayWindow(now - 120_000, now)).toBe(false);
    expect(withinReplayWindow(undefined, now)).toBe(false);
  });
});

// ─────────────────────────── config ───────────────────────────

describe('getLinearConfig', () => {
  it('is null when disabled', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'false', LINEAR_TOKEN: 'tok' } as any);
    expect(await getLinearConfig()).toBeNull();
  });
  it('is null when enabled but no token', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: '' } as any);
    expect(await getLinearConfig()).toBeNull();
  });
  it('parses an enabled config + team map', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: 'tok', LINEAR_ROUTING_MODE: 'inbox', LINEAR_TEAM_MAP: '{"Sales":"teamS"}', LINEAR_FALLBACK_TEAM_ID: 'fb' } as any);
    expect(await getLinearConfig()).toMatchObject({ token: 'tok', routingMode: 'inbox', teamMap: { Sales: 'teamS' }, fallbackTeamId: 'fb' });
  });
});

// ─────────────────────────── signature ───────────────────────────

describe('verifyLinearSignature', () => {
  it('accepts a correct HMAC and rejects a wrong one', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_WEBHOOK_SECRET: 'whsec' } as any);
    const body = '{"action":"update"}';
    const good = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(await verifyLinearSignature(body, good)).toBe(true);
    expect(await verifyLinearSignature(body, 'deadbeef')).toBe(false);
    expect(await verifyLinearSignature(body, null)).toBe(false);
  });
});

// ─────────────────────────── push (GraphQL transport + owned gate) ───────────────────────────

describe('pushMeetingTasksToLinear', () => {
  const item: LinearPushItem = { rowId: 'r1', title: 'Do X', priority: 'high', dueDate: null, departmentId: 'd1', assigneeUserIds: ['g1'], parentTitle: null };

  it('creates a Linear issue for an owned task and marks the row owned', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: 'tok', LINEAR_ROUTING_MODE: 'department' } as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'd1', name: 'Sales' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }] as any);
    prismaMock.linearTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.linearTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installGraphQL([
      { match: 'users(', data: { users: { nodes: [{ id: 'u_lin', email: 'a@x.com', active: true }] } } },
      { match: 'teams(', data: { teams: { nodes: [{ id: 'team1', name: 'Sales' }] } } },
      { match: 'issueCreate', data: { issueCreate: { success: true, issue: { id: 'iss1', identifier: 'SAL-1', url: 'https://linear.app/iss1' } } } },
    ]);

    await pushMeetingTasksToLinear('m1', [item]);

    const createCall = calls.find((c) => c.query.includes('issueCreate'));
    expect(createCall).toBeTruthy();
    expect(createCall!.variables.input).toMatchObject({ teamId: 'team1', title: 'Do X', assigneeId: 'u_lin', priority: 2 });
    expect(prismaMock.linearTaskLink.create).toHaveBeenCalled();
    expect(prismaMock.taskRow.update).toHaveBeenCalledWith(expect.objectContaining({ where: { rowId: 'r1' }, data: expect.objectContaining({ linearIssueId: 'iss1' }) }));
  });

  it('SKIPS a task whose assignee is not a Linear member (stays native)', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: 'tok', LINEAR_ROUTING_MODE: 'department' } as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'd1', name: 'Sales' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }] as any);
    const { calls } = installGraphQL([
      { match: 'users(', data: { users: { nodes: [{ id: 'u_lin', email: 'someone-else@x.com', active: true }] } } },
      { match: 'teams(', data: { teams: { nodes: [{ id: 'team1', name: 'Sales' }] } } },
    ]);

    await pushMeetingTasksToLinear('m1', [item]);

    expect(calls.find((c) => c.query.includes('issueCreate'))).toBeUndefined();
    expect(prismaMock.linearTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.taskRow.update).not.toHaveBeenCalled();
  });

  it('does NOT retry a create on a timeout/transport error — no duplicate issue', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: 'tok', LINEAR_ROUTING_MODE: 'department' } as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'd1', name: 'Sales' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }] as any);
    prismaMock.linearTaskLink.findUnique.mockResolvedValue(null as any);
    const resp = (obj: any) => ({ ok: true, status: 200, json: async () => obj, text: async () => '' }) as Response;
    let createCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).query as string;
      if (q.includes('users(')) return resp({ data: { users: { nodes: [{ id: 'u_lin', email: 'a@x.com', active: true }] } } });
      if (q.includes('teams(')) return resp({ data: { teams: { nodes: [{ id: 'team1', name: 'Sales' }] } } });
      if (q.includes('issueCreate')) { createCalls++; throw new DOMException('timed out', 'TimeoutError'); }
      return resp({ data: {} });
    }) as any);

    await pushMeetingTasksToLinear('m1', [item]);

    expect(createCalls).toBe(1); // NOT retried — a lost response might mean the issue was created
    expect(prismaMock.linearTaskLink.create).not.toHaveBeenCalled();
  });

  it('retries WITHOUT assignee/state only on a Linear REJECTION (bad assignee)', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'true', LINEAR_TOKEN: 'tok', LINEAR_ROUTING_MODE: 'department' } as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'd1', name: 'Sales' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'g1', email: 'a@x.com' }] as any);
    prismaMock.linearTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.linearTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const resp = (obj: any) => ({ ok: true, status: 200, json: async () => obj, text: async () => '' }) as Response;
    const createInputs: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body)); const q = b.query as string;
      if (q.includes('users(')) return resp({ data: { users: { nodes: [{ id: 'u_lin', email: 'a@x.com', active: true }] } } });
      if (q.includes('teams(')) return resp({ data: { teams: { nodes: [{ id: 'team1', name: 'Sales' }] } } });
      if (q.includes('issueCreate')) {
        createInputs.push(b.variables.input);
        if (createInputs.length === 1) return resp({ errors: [{ message: 'assignee is not a member of the team' }] });
        return resp({ data: { issueCreate: { success: true, issue: { id: 'iss1', url: 'https://linear.app/iss1' } } } });
      }
      return resp({ data: {} });
    }) as any);

    await pushMeetingTasksToLinear('m1', [item]);

    expect(createInputs.length).toBe(2); // rejected → retried
    expect(createInputs[0].assigneeId).toBe('u_lin');
    expect(createInputs[1].assigneeId).toBeUndefined(); // second attempt drops the bad assignee
    expect(prismaMock.linearTaskLink.create).toHaveBeenCalled();
  });

  it('is a no-op when Linear is disabled', async () => {
    mockReadConfig.mockResolvedValue({ LINEAR_ENABLED: 'false' } as any);
    const { fetchMock } = installGraphQL([]);
    await pushMeetingTasksToLinear('m1', [item]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────── reverse apply ───────────────────────────

describe('applyLinearEvent', () => {
  it('ignores non-Issue types', async () => {
    await applyLinearEvent('update', 'Comment', 'iss1');
    expect(prismaMock.taskRow.findFirst).not.toHaveBeenCalled();
  });
  it('remove → deletes the owning row (+ subtasks)', async () => {
    prismaMock.taskRow.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.taskRow.findMany.mockResolvedValue([{ rowId: 'r1s' }] as any);
    prismaMock.row.deleteMany.mockResolvedValue({ count: 2 } as any);
    await applyLinearEvent('remove', 'Issue', 'iss1');
    expect(prismaMock.row.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['r1', 'r1s'] } } });
  });
  it('is a no-op for an unknown (non-owned) issue id', async () => {
    prismaMock.taskRow.findFirst.mockResolvedValue(null as any);
    await applyLinearEvent('update', 'Issue', 'iss-unknown');
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
  });
});
