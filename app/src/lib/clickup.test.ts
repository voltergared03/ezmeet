import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { readConfig } from '@/lib/config';
import {
  mapPriority, normName, dedupeKeyFor, listIdForDepartment,
  pushMeetingTasksToClickUp, garelyStatusToClickUp, clickUpStatusToGarely,
  verifyClickUpSignature, applyClickUpEvent, migrateAllTasksToClickUp, getFallbackStats,
  type ClickUpConfig, type ClickUpPushItem,
} from '@/lib/clickup';
import { createHmac } from 'crypto';

vi.mock('@/lib/prisma');
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({})),
  writeConfig: vi.fn(async () => {}),
  publicBaseUrl: vi.fn(async () => 'https://meet.example.com'),
}));
vi.mock('@/lib/twofactor', () => ({
  decryptSecret: vi.fn((x: string) => x),
  encryptSecret: vi.fn((x: string) => x),
}));
vi.mock('@/lib/org', () => ({ getSingletonOrgId: vi.fn(async () => 'org1') }));
vi.mock('@/lib/system-tasks-table', () => ({
  getSystemTasksTable: vi.fn(async () => ({ table: { id: 't1' }, fieldIds: { title: 'fT', description: 'fD', status: 'fS', priority: 'fP', dueDate: 'fDue', assignee: 'fA' } })),
}));

const mockReadConfig = vi.mocked(readConfig);

// ─────────────────────────── pure mappers ───────────────────────────

describe('mapPriority', () => {
  it('maps Garely priority → ClickUp native priority', () => {
    expect(mapPriority('high')).toBe(2);
    expect(mapPriority('medium')).toBe(3);
    expect(mapPriority('low')).toBe(4);
    expect(mapPriority('HIGH')).toBe(2); // case-insensitive
  });
  it('returns null for unknown/empty so the field is omitted', () => {
    expect(mapPriority(null)).toBeNull();
    expect(mapPriority(undefined)).toBeNull();
    expect(mapPriority('urgent')).toBeNull();
    expect(mapPriority('')).toBeNull();
  });
});

describe('normName', () => {
  it('trims, lowercases, collapses whitespace', () => {
    expect(normName('  Account   Manager ')).toBe('account manager');
    expect(normName('IT')).toBe('it');
    expect(normName(null)).toBe('');
  });
});

describe('dedupeKeyFor', () => {
  it('is stable for the same semantic task across regenerations', () => {
    const a = dedupeKeyFor('m1', 'Ship the app', 'dIT', null);
    const b = dedupeKeyFor('m1', '  ship the APP  ', 'dIT', null); // normalized equal
    expect(a).toBe(b);
  });
  it('differs by meeting, title, department and parent', () => {
    const base = dedupeKeyFor('m1', 'Task', 'dIT', null);
    expect(dedupeKeyFor('m2', 'Task', 'dIT', null)).not.toBe(base);
    expect(dedupeKeyFor('m1', 'Other', 'dIT', null)).not.toBe(base);
    expect(dedupeKeyFor('m1', 'Task', 'dHR', null)).not.toBe(base);
    expect(dedupeKeyFor('m1', 'Task', 'dIT', 'Parent')).not.toBe(base); // subtask vs parent
  });
  it('appends the assignee so split copies get distinct keys — legacy calls unchanged', () => {
    const base = dedupeKeyFor('m1', 'Task', 'dIT', null);
    expect(dedupeKeyFor('m1', 'Task', 'dIT', null, 'u1')).not.toBe(base);
    expect(dedupeKeyFor('m1', 'Task', 'dIT', null, 'u1')).not.toBe(dedupeKeyFor('m1', 'Task', 'dIT', null, 'u2'));
    expect(dedupeKeyFor('m1', 'Task', 'dIT', null, undefined)).toBe(base); // omitted → backward-compatible
  });
  it('does NOT key on the destination list — a routing change never re-duplicates', () => {
    // The list id is deliberately not an input: re-mapping a department, changing the
    // fallback, or a per-user override all leave the key untouched, so existing links
    // keep matching and tasks are updated in place, not re-created.
    const before = dedupeKeyFor('m1', 'Task', 'dIT', null, 'u1');
    const after = dedupeKeyFor('m1', 'Task', 'dIT', null, 'u1'); // same inputs after a re-route
    expect(after).toBe(before);
  });
});

describe('listIdForDepartment', () => {
  const cfg = (over: Partial<ClickUpConfig> = {}): ClickUpConfig => ({
    token: 'pk_x', teamId: 'team1', routingMode: 'department', fallbackListId: '', personalRouting: false, ...over,
  });

  it('uses the admin-chosen mapping when set', () => {
    expect(listIdForDepartment(cfg(), 'L_INBOX', 'L_IT')).toBe('L_IT');
  });
  it('falls back when the department is unmapped', () => {
    expect(listIdForDepartment(cfg(), 'L_INBOX', null)).toBe('L_INBOX');
  });
  it('inbox routing mode sends everything to the fallback, ignoring the mapping', () => {
    expect(listIdForDepartment(cfg({ routingMode: 'inbox' }), 'L_INBOX', 'L_IT')).toBe('L_INBOX');
  });
  it('is null (do not push) when unmapped and no fallback is configured', () => {
    expect(listIdForDepartment(cfg(), null, null)).toBeNull();
  });
});

// ─────────────────────────── orchestrator (mocked fetch + prisma) ───────────────────────────

// URL-routed fetch mock (robust to call order). Push no longer discovers Spaces/Lists —
// routing comes from the department's clickupListId — but the mock keeps serving them
// harmlessly, plus the field/task/GET routes the push path actually hits.
function installFetch() {
  const calls: { url: string; method: string; body: any }[] = [];
  let personalSpaceCreated = false; // stateful: the re-search after create must see it
  const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }, { user: { id: 222, email: 'b@x.com' } }] }] });
    if (u.includes('/team/team1/space') && method === 'POST') { personalSpaceCreated = true; return json({ id: 'spPersonal' }); }
    if (u.includes('/space/spPersonal/list') && method === 'POST') return json({ id: 'LP_u1' });
    if (u.includes('/list/LP_u1/field')) return json({ fields: [] });
    if (u.includes('/list/LP_u1/task') && method === 'POST') return json({ id: 'CUp1', url: 'https://app.clickup.com/t/CUp1' });
    if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'sp1', name: 'IT' }, { id: 'sp2', name: 'Call Inbox' }, ...(personalSpaceCreated ? [{ id: 'spPersonal', name: 'Garely Personal' }] : [])] });
    if (u.includes('/space/sp1/list')) return json({ lists: [{ id: 'L_IT', name: 'Tasks' }] });
    if (u.includes('/space/sp2/list')) return json({ lists: [{ id: 'L_INBOX', name: 'New Tasks' }] });
    if (u.includes('/list/L_IT/field')) return json({ fields: [{ id: 'fSrc', name: 'Source', type: 'drop_down', type_config: { options: [{ id: 'optTg', name: 'Telegram' }, { id: 'optGC', name: 'Garely Call' }] } }] });
    if (u.includes('/list/L_INBOX/field')) return json({ fields: [] });
    if (u.includes('/list/L_IT/task') && method === 'POST') return json({ id: 'CU1', url: 'https://app.clickup.com/t/CU1' });
    if (u.includes('/list/L_INBOX/task') && method === 'POST') return json({ id: 'CUi', url: 'https://app.clickup.com/t/CUi' });
    if (u.endsWith('/list/L_INBOX')) return json({ name: 'New Tasks', space: { name: 'Call Inbox' } });
    if (u.includes('/task/CU1') && method === 'PUT') return json({ id: 'CU1' });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

const enabledConfig = {
  CLICKUP_ENABLED: 'true', CLICKUP_TOKEN: 'pk_secret', CLICKUP_TEAM_ID: 'team1',
  CLICKUP_ROUTING_MODE: 'department', CLICKUP_FALLBACK_LIST_ID: 'L_INBOX',
};

// A department mapped to L_IT (the manual mapping the admin picked in the UI).
const itDept = { id: 'dIT', name: 'IT', clickupListId: 'L_IT' };

const itTask: ClickUpPushItem = {
  rowId: 'r1', title: 'Ship the app', priority: 'high', dueDate: new Date('2026-07-01T00:00:00Z'),
  departmentId: 'dIT', assigneeUserIds: ['u1'], parentTitle: null,
};

beforeEach(() => {
  mockReset(prismaMock);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('pushMeetingTasksToClickUp', () => {
  it('is a silent no-op when disabled (no ClickUp calls)', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_ENABLED: 'false' });
    const { fetchMock } = installFetch();
    await pushMeetingTasksToClickUp('m1', [itTask]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('creates a ClickUp task in the department\'s mapped list with assignee, priority, due date and Source', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'A@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'));
    expect(post).toBeTruthy();
    expect(post!.body.name).toBe('Ship the app');
    expect(post!.body.assignees).toEqual([111]); // email matched case-insensitively
    expect(post!.body.priority).toBe(2);
    expect(post!.body.due_date).toBe(new Date('2026-07-01T00:00:00Z').getTime());
    expect(post!.body.custom_fields).toEqual([{ id: 'fSrc', value: 'optGC' }]);

    const linkArgs = prismaMock.clickUpTaskLink.create.mock.calls[0][0] as any;
    expect(linkArgs.data.clickupTaskId).toBe('CU1');
    expect(linkArgs.data.listId).toBe('L_IT');
    expect(linkArgs.data.meetingId).toBe('m1');
    expect(linkArgs.data.rowId).toBe('r1'); // set even on the legacy/shared link (delete safety)

    expect(prismaMock.taskRow.update).toHaveBeenCalled();
    const markArgs = prismaMock.taskRow.update.mock.calls[0][0] as any;
    expect(markArgs.where.rowId).toBe('r1');
    expect(markArgs.data.clickupTaskId).toBe('CU1');
  });

  it('sends an UNMAPPED department\'s task to the fallback list', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dX', name: 'Marketing', clickupListId: null }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, departmentId: 'dX' }]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_INBOX/task'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'))).toBe(false);
  });

  it('does NOT push when the department is unmapped and no fallback is configured', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_FALLBACK_LIST_ID: '' });
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dX', name: 'Marketing', clickupListId: null }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, departmentId: 'dX' }]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.taskRow.update).not.toHaveBeenCalled();
  });

  it('UPDATES (not creates) when a link already exists — idempotent regenerate', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue({ id: 'lnk1', clickupTaskId: 'CU1', clickupUrl: 'https://app.clickup.com/t/CU1', listId: 'L_IT' } as any);
    prismaMock.clickUpTaskLink.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/task/CU1'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.clickUpTaskLink.update).toHaveBeenCalled();
  });

  it('does not rewrite listId on update — the ClickUp task never moved', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue({ id: 'lnk1', clickupTaskId: 'CU1', clickupUrl: 'https://x', listId: 'L_IT' } as any);
    prismaMock.clickUpTaskLink.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    const updateArgs = prismaMock.clickUpTaskLink.update.mock.calls[0][0] as any;
    expect(updateArgs.data.listId).toBeUndefined();
  });

  it('SKIPS a task whose only assignee is not in ClickUp (stays native to Garely)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'ghost@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.taskRow.update).not.toHaveBeenCalled();
  });

  it('mixed assignees: pushes with the matched assignee and notes the unmatched one', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }, { id: 'u2', email: 'ghost@x.com', clickupListId: null }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, assigneeUserIds: ['u1', 'u2'] }]);

    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'));
    expect(post).toBeTruthy();
    expect(post!.body.assignees).toEqual([111]); // only the matched assignee
    expect(post!.body.description).toContain('ghost@x.com'); // unmatched noted
  });

  // ── per-user routing (opt-in) ──
  const personalConfig = { ...enabledConfig, CLICKUP_PERSONAL_ROUTING: 'true', CLICKUP_PERSONAL_SPACE_ID: '', CLICKUP_PERSONAL_LISTS: '' };

  it('personal routing: a 2+ department assignee → own auto-created list (not the dept list)', async () => {
    mockReadConfig.mockResolvedValue(personalConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denys', clickupListId: null }] as any);
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u1' }] as any); // 2 depts
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/space/spPersonal/list'))).toBe(true);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/list/LP_u1/task'));
    expect(post).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'))).toBe(false); // NOT the dept list
  });

  it('personal routing: a single-department assignee stays in the department list', async () => {
    mockReadConfig.mockResolvedValue(personalConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Bob', clickupListId: null }] as any);
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: 'u1' }] as any); // 1 dept
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'))).toBe(true); // dept list
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/team/team1/space'))).toBe(false); // no personal space needed
  });

  it('personal routing: splits a task into one ClickUp task per assignee', async () => {
    mockReadConfig.mockResolvedValue(personalConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'A', clickupListId: null }, { id: 'u2', email: 'b@x.com', name: 'B', clickupListId: null }] as any);
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }] as any); // both single-dept
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, assigneeUserIds: ['u1', 'u2'] }]);

    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'));
    expect(posts.length).toBe(2); // one task per assignee
    expect(posts.map((p) => p.body.assignees[0]).sort()).toEqual([111, 222]);
    expect(prismaMock.clickUpTaskLink.create).toHaveBeenCalledTimes(2);
  });
});

// ─────────────────────── per-user list override (C-level routing) ───────────────────────

/** Stateful link store so adoption (key rewrite) behaves like a real DB. */
function linkStore(seed: any[] = []) {
  const rows = new Map<string, any>();
  for (const l of seed) rows.set(l.dedupeKey, { ...l });
  prismaMock.clickUpTaskLink.findUnique.mockImplementation(async (args: any) => {
    return rows.get(args.where.meetingId_dedupeKey.dedupeKey) ?? null;
  });
  prismaMock.clickUpTaskLink.update.mockImplementation(async (args: any) => {
    for (const [k, v] of rows) {
      if (v.id === args.where.id) {
        rows.delete(k);
        const next = { ...v, ...args.data };
        rows.set(next.dedupeKey ?? k, next);
        return next;
      }
    }
    return {};
  });
  prismaMock.clickUpTaskLink.create.mockImplementation(async (args: any) => {
    rows.set(args.data.dedupeKey, { id: `new-${rows.size}`, ...args.data });
    return args.data;
  });
  return rows;
}

/** Route table with an override list, and the department + inbox lists. */
function overrideFetch() {
  const calls: { url: string; method: string; body: any }[] = [];
  const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }, { user: { id: 222, email: 'b@x.com' } }] }] });
    if (u.includes('/list/L_CLEVEL/field')) return json({ fields: [] });
    if (u.includes('/list/L_IT/field')) return json({ fields: [] });
    if (u.includes('/list/L_CLEVEL/task') && method === 'POST') return json({ id: 'CUc', url: 'https://app.clickup.com/t/CUc' });
    if (u.includes('/list/L_IT/task') && method === 'POST') return json({ id: 'CU1', url: 'https://app.clickup.com/t/CU1' });
    if (u.includes('/task/') && method === 'PUT') return json({ id: 'ok' });
    return json({});
  }) as any);
  return { calls };
}

describe('per-user list override', () => {
  it('routes an override user\'s task to their list even with personal routing OFF', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig); // personalRouting off
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denis', clickupListId: 'L_CLEVEL' }] as any);
    linkStore(); // no existing links
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = overrideFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_CLEVEL/task'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'))).toBe(false);
  });

  it('override beats the multi-department personal list', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_PERSONAL_ROUTING: 'true' });
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denis', clickupListId: 'L_CLEVEL' }] as any);
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u1' }] as any); // multi-dept
    linkStore();
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = overrideFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_CLEVEL/task'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/space/spPersonal'))).toBe(false); // personal list not created
  });

  it('forceFallback (unconfirmed dept) beats the override — the task goes to the Inbox', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denis', clickupListId: 'L_CLEVEL' }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, forceFallback: true }]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_INBOX/task'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/list/L_CLEVEL/task'))).toBe(false);
  });

  it('adopts a pre-split link instead of creating a duplicate when a user first gets an override', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denis', clickupListId: 'L_CLEVEL' }] as any);
    // The task was already pushed once via the legacy (4-arg) path, sitting in L_IT.
    const legacyKey = dedupeKeyFor('m1', 'Ship the app', 'dIT', null);
    const rows = linkStore([{ id: 'lnk0', dedupeKey: legacyKey, clickupTaskId: 'CUold', clickupUrl: 'https://x', listId: 'L_IT' }]);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = overrideFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    // No brand-new ClickUp task — the existing one is reused (updated in place).
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    // The link was re-keyed to the 5-arg (per-assignee) key, not left orphaned.
    const fiveArgKey = dedupeKeyFor('m1', 'Ship the app', 'dIT', null, 'u1');
    expect(rows.has(fiveArgKey)).toBe(true);
    expect(rows.has(legacyKey)).toBe(false);
  });

  it('drops a redundant legacy link instead of throwing when the target already has its 5-arg link', async () => {
    // Partial prior adoption: both the 4-arg legacy link AND u1's 5-arg link exist. Rewriting
    // the legacy key onto u1's key would violate @@unique — so the legacy link is dropped.
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denis', clickupListId: 'L_CLEVEL' }] as any);
    const legacyKey = dedupeKeyFor('m1', 'Ship the app', 'dIT', null);
    const fiveArgKey = dedupeKeyFor('m1', 'Ship the app', 'dIT', null, 'u1');
    const rows = linkStore([
      { id: 'lnk0', dedupeKey: legacyKey, clickupTaskId: 'CUold', clickupUrl: 'https://x', listId: 'L_IT' },
      { id: 'lnk1', dedupeKey: fiveArgKey, clickupTaskId: 'CU5', clickupUrl: 'https://y', listId: 'L_CLEVEL' },
    ]);
    prismaMock.clickUpTaskLink.delete.mockImplementation(async (args: any) => {
      for (const [k, v] of rows) if (v.id === args.where.id) rows.delete(k);
      return {} as any;
    });
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    overrideFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]); // must not throw

    expect(rows.has(legacyKey)).toBe(false); // redundant legacy link removed
    expect(rows.has(fiveArgKey)).toBe(true); // the real per-assignee link survives
  });
});

// ─────────────────────────── reverse sync (ClickUp → Garely) ───────────────────────────

describe('status mapping', () => {
  it('garelyStatusToClickUp', () => {
    expect(garelyStatusToClickUp('done')).toBe('done');
    expect(garelyStatusToClickUp('in_progress')).toBe('in progress');
    expect(garelyStatusToClickUp('open')).toBeUndefined();
    expect(garelyStatusToClickUp(null)).toBeUndefined();
  });
  it('clickUpStatusToGarely (Blocked → in_progress, closed/done → done)', () => {
    expect(clickUpStatusToGarely('done', 'Done')).toBe('done');
    expect(clickUpStatusToGarely('closed', 'Closed')).toBe('done');
    expect(clickUpStatusToGarely('custom', 'In Progress')).toBe('in_progress');
    expect(clickUpStatusToGarely('custom', 'Blocked')).toBe('in_progress');
    expect(clickUpStatusToGarely('open', 'New')).toBe('open');
    expect(clickUpStatusToGarely('open', 'to do')).toBe('open');
  });

  it('treats EVERY custom stage as in-progress, whatever it is named', () => {
    // A list has one 'open' status and one 'closed'; everything a team adds between them is
    // type 'custom'. Those tasks were deliberately moved off "to do" and are not finished.
    // Keyed on ClickUp's semantic type, NOT English names — matching names reported a
    // non-English workspace's active work as untouched.
    expect(clickUpStatusToGarely('custom', 'in control')).toBe('in_progress');
    expect(clickUpStatusToGarely('custom', 'routine')).toBe('in_progress');
    expect(clickUpStatusToGarely('custom', 'На перевірці')).toBe('in_progress');
    expect(clickUpStatusToGarely('custom', 'в работе')).toBe('in_progress');
  });

  it('falls back to name hints only when ClickUp sends no type', () => {
    expect(clickUpStatusToGarely(null, 'Complete')).toBe('done');
    expect(clickUpStatusToGarely(undefined, 'In Review')).toBe('in_progress');
    expect(clickUpStatusToGarely('', 'Something else')).toBe('open');
  });
});

describe('verifyClickUpSignature', () => {
  it('accepts a correct HMAC-SHA256 signature, rejects wrong / missing', async () => {
    mockReadConfig.mockResolvedValue({ CLICKUP_WEBHOOK_SECRET: 'whsec' });
    const body = '{"event":"taskStatusUpdated","task_id":"CU1"}';
    const good = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(await verifyClickUpSignature(body, good)).toBe(true);
    expect(await verifyClickUpSignature(body, 'deadbeef')).toBe(false);
    expect(await verifyClickUpSignature(body, null)).toBe(false);
  });
  it('rejects when no webhook secret is configured', async () => {
    mockReadConfig.mockResolvedValue({});
    expect(await verifyClickUpSignature('x', 'y')).toBe(false);
  });
});

describe('applyClickUpEvent', () => {
  const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;

  it('taskDeleted removes the owning Garely row + its subtasks (legacy single task)', async () => {
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue(null as any); // no split link
    prismaMock.taskRow.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.clickUpTaskLink.deleteMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([] as any); // no other copies for the row
    prismaMock.taskRow.findMany.mockResolvedValue([{ rowId: 'r1sub' }] as any);
    prismaMock.row.deleteMany.mockResolvedValue({ count: 2 } as any);
    await applyClickUpEvent('taskDeleted', 'CU1');
    const del = prismaMock.row.deleteMany.mock.calls[0][0] as any;
    expect(del.where.id.in).toEqual(expect.arrayContaining(['r1', 'r1sub']));
  });

  it('taskStatusUpdated mirrors the live ClickUp status into the Garely row', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.taskRow.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { existing: 1 }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: { status: 'Done', type: 'done' } })));

    await applyClickUpEvent('taskStatusUpdated', 'CU1');

    const upd = prismaMock.row.update.mock.calls[0][0] as any;
    expect(upd.data.data.fS).toBe('done'); // mapped status written under the status field id
    expect(prismaMock.taskRow.update).toHaveBeenCalled();
  });

  it('is a no-op when the ClickUp task id is not a Garely-owned task', async () => {
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue(null as any);
    prismaMock.taskRow.findFirst.mockResolvedValue(null as any);
    await applyClickUpEvent('taskDeleted', 'UNKNOWN');
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
  });

  it('deleting ONE split copy keeps the Garely row while other copies remain', async () => {
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: 'r1' } as any); // a split copy
    prismaMock.clickUpTaskLink.deleteMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([{ clickupTaskId: 'CUother', clickupUrl: 'https://x' }] as any); // a copy remains
    prismaMock.taskRow.updateMany.mockResolvedValue({} as any);
    await applyClickUpEvent('taskDeleted', 'CUgone');
    expect(prismaMock.clickUpTaskLink.deleteMany).toHaveBeenCalled();
    expect(prismaMock.taskRow.updateMany).toHaveBeenCalled(); // lead pointer re-pointed
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled(); // row kept
  });

  it('deleting the LAST split copy removes the Garely row', async () => {
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.clickUpTaskLink.deleteMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([] as any); // no copies remain
    prismaMock.taskRow.findMany.mockResolvedValue([] as any); // no subtasks
    prismaMock.row.deleteMany.mockResolvedValue({ count: 1 } as any);
    await applyClickUpEvent('taskDeleted', 'CUlast');
    expect(prismaMock.row.deleteMany).toHaveBeenCalled();
  });
});

describe('migrateAllTasksToClickUp', () => {
  it('pushes eligible tasks (with status) + marks owned; skips non-ClickUp assignees', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.row.findMany.mockResolvedValue([
      { id: 'r1', data: { fT: 'Migrated task', fP: 'high', fS: 'done' }, taskMeta: { meetingId: null, departmentId: 'dIT', parentRowId: null }, assignments: [{ userId: 'u1' }] },
      { id: 'r2', data: { fT: 'Native task' }, taskMeta: { meetingId: null, departmentId: 'dIT', parentRowId: null }, assignments: [{ userId: 'u2' }] },
    ] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }, { id: 'u2', email: 'ghost@x.com', clickupListId: null }] as any);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    const res = await migrateAllTasksToClickUp();

    expect(res.migrated).toBe(1);
    expect(res.skipped).toBe(1);
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'));
    expect(post!.body.name).toBe('Migrated task');
    expect(post!.body.status).toBe('done'); // done task migrated with the right status
    expect(prismaMock.taskRow.update).toHaveBeenCalled();
  });

  it('honours the department mapping on the backfill path (unmapped → fallback)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.row.findMany.mockResolvedValue([
      { id: 'r1', data: { fT: 'Task' }, taskMeta: { meetingId: null, departmentId: 'dX', parentRowId: null }, assignments: [{ userId: 'u1' }] },
    ] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dX', name: 'Marketing', clickupListId: null }] as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await migrateAllTasksToClickUp();

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_INBOX/task'))).toBe(true);
  });
});

describe('getFallbackStats', () => {
  it('null when disabled', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_ENABLED: 'false' });
    expect(await getFallbackStats()).toBeNull();
  });
  it('null when no fallback list is configured', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_FALLBACK_LIST_ID: '' });
    installFetch();
    expect(await getFallbackStats()).toBeNull();
  });
  it('resolves the fallback list by its own NAME + counts tasks routed there (30d + all-time)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.clickUpTaskLink.count.mockResolvedValueOnce(3 as any).mockResolvedValueOnce(12 as any);
    installFetch();
    const stats = await getFallbackStats();
    // list name ('New Tasks'), not the Space name ('Call Inbox') — this stat is about a list
    expect(stats).toEqual({ listName: 'New Tasks', last30d: 3, total: 12 });
    const countArgs = prismaMock.clickUpTaskLink.count.mock.calls[0][0] as any;
    expect(countArgs.where.listId).toBe('L_INBOX');
    expect(countArgs.where.syncedAt.gte).toBeInstanceOf(Date);
  });
});

// ─────────────────────── list discovery: folders (regression) ───────────────────────

/** Minimal fetch stub with an explicit route table, for discovery/retry edge cases. */
function stubFetch(routes: (u: string, method: string) => Response | undefined) {
  const calls: { url: string; method: string; body: any }[] = [];
  const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method || 'GET';
    calls.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return routes(u, method) ?? json({});
  }) as any);
  return { calls, json };
}

function pushPrismaMocks() {
  prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', clickupListId: null }] as any);
  prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
  prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
  prismaMock.taskRow.update.mockResolvedValue({} as any);
}

describe('list discovery: folder-nested lists (picker)', () => {
  it('listAllClickUpLists finds lists inside folders and labels them with the full path', async () => {
    // Regression: we only called GET /space/{id}/list ("Get Folderless Lists"), so a Space
    // whose lists live in Folders looked empty. The picker must see those lists.
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { listAllClickUpLists } = await import('@/lib/clickup');

    stubFetch((u) => {
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [] }] });
      if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'spS', name: 'Sales' }] });
      if (u.includes('/space/spS/list')) return json({ lists: [] });
      if (u.includes('/space/spS/folder')) return json({ folders: [{ id: 'f1', name: 'Boards', lists: [{ id: 'L_SALES', name: 'Tasks' }] }] });
      return undefined;
    });

    const lists = await listAllClickUpLists();
    const sales = lists.find((l) => l.listId === 'L_SALES');
    expect(sales).toBeTruthy();
    expect(sales!.label).toBe('Sales / Boards / Tasks'); // full path disambiguates duplicate names
  });

  it('listAllClickUpLists fetches a folder\'s lists when the folder payload omits them', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { listAllClickUpLists } = await import('@/lib/clickup');

    const { calls } = stubFetch((u) => {
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [] }] });
      if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'spS', name: 'Sales' }] });
      if (u.includes('/space/spS/list')) return json({ lists: [] });
      if (u.includes('/space/spS/folder')) return json({ folders: [{ id: 'f1', name: 'Boards' }] }); // no embedded lists
      if (u.includes('/folder/f1/list')) return json({ lists: [{ id: 'L_SALES', name: 'Tasks' }] });
      return undefined;
    });

    const lists = await listAllClickUpLists();
    expect(calls.some((c) => c.url.includes('/folder/f1/list'))).toBe(true);
    expect(lists.some((l) => l.listId === 'L_SALES')).toBe(true);
  });
});

// ─────────────────────── create retry safety (regression) ───────────────────────

describe('createClickUpTask retry safety', () => {
  const baseRoutes = (json: (b: unknown) => Response) => (u: string) => {
    if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }] }] });
    if (u.includes('/list/L_IT/field')) return json({ fields: [] });
    return undefined;
  };

  it('does NOT retry when the create times out — the task may already exist (no duplicate)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    pushPrismaMocks();

    const calls: { url: string; method: string }[] = [];
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const method = init?.method || 'GET';
      calls.push({ url: u, method });
      if (u.includes('/list/L_IT/task') && method === 'POST') {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      return baseRoutes(json)(u) ?? json({});
    }) as any);

    await pushMeetingTasksToClickUp('m1', [itTask]); // per-item catch keeps this from throwing

    const posts = calls.filter((c) => c.method === 'POST' && c.url.includes('/task'));
    expect(posts).toHaveLength(1); // exactly one attempt — no blind second create
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
  });

  it('does NOT retry on a 5xx — the create may have landed server-side', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    pushPrismaMocks();

    const calls: { url: string; method: string }[] = [];
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const method = init?.method || 'GET';
      calls.push({ url: u, method });
      if (u.includes('/list/L_IT/task') && method === 'POST') {
        return { ok: false, status: 502, json: async () => ({}), text: async () => 'bad gateway' } as Response;
      }
      return baseRoutes(json)(u) ?? json({});
    }) as any);

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.filter((c) => c.method === 'POST' && c.url.includes('/task'))).toHaveLength(1);
  });

  it('DOES retry unassigned when ClickUp rejects the assignee with a 400 (private list)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([itDept] as any);
    pushPrismaMocks();

    const posts: any[] = [];
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (u.includes('/list/L_IT/task') && method === 'POST') {
        posts.push(body);
        if (body.assignees?.length) return { ok: false, status: 400, json: async () => ({}), text: async () => 'Assignee not a member' } as Response;
        return json({ id: 'CU1', url: 'https://app.clickup.com/t/CU1' });
      }
      return baseRoutes(json)(u) ?? json({});
    }) as any);

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(posts).toHaveLength(2);
    expect(posts[0].assignees).toEqual([111]);
    expect(posts[1].assignees).toBeUndefined(); // landed unassigned rather than lost
    expect(prismaMock.clickUpTaskLink.create).toHaveBeenCalled();
  });
});

// ─────────────────────── reverse sync: renames + reconcile (regression) ───────────────────────

describe('webhook subscription covers renames', () => {
  it('re-creates the webhook when the stored one is missing an event we now need', async () => {
    // Regression: the verify branch compared only the ENDPOINT, so adding an event to the
    // subscription was a silent no-op — the existing hook matched and was never re-created,
    // and the new event (taskUpdated → renames) simply never arrived.
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_WEBHOOK_ID: 'wh1' } as any);
    const { ensureClickUpWebhook } = await import('@/lib/clickup');

    const { calls } = stubFetch((u, method) => {
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [] }] });
      if (u.includes('/team/team1/webhook') && method === 'GET') {
        // Same endpoint, but subscribed only to the OLD event set.
        return json({ webhooks: [{ id: 'wh1', endpoint: 'https://meet.example.com/api/webhooks/clickup', events: ['taskStatusUpdated', 'taskDeleted'] }] });
      }
      if (u.includes('/team/team1/webhook') && method === 'POST') return json({ id: 'wh2', secret: 's' });
      return undefined;
    });

    const res = await ensureClickUpWebhook();
    expect(res.ok).toBe(true);
    const created = calls.find((c) => c.method === 'POST' && c.url.includes('/webhook'));
    expect(created).toBeTruthy(); // it re-registered instead of short-circuiting
    expect(created!.body.events).toContain('taskUpdated');
  });

  it('leaves a healthy webhook alone when endpoint AND events already match', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_WEBHOOK_ID: 'wh1' } as any);
    const { ensureClickUpWebhook } = await import('@/lib/clickup');

    const { calls } = stubFetch((u, method) => {
      const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [] }] });
      if (u.includes('/team/team1/webhook') && method === 'GET') {
        return json({ webhooks: [{ id: 'wh1', endpoint: 'https://meet.example.com/api/webhooks/clickup', events: ['taskStatusUpdated', 'taskUpdated', 'taskDeleted'] }] });
      }
      return undefined;
    });

    await ensureClickUpWebhook();
    expect(calls.some((c) => c.method === 'POST')).toBe(false); // no needless re-registration
  });
});

describe('applyClickUpEvent mirrors renames', () => {
  const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;

  it('writes a ClickUp rename back onto the Garely row', async () => {
    // A title corrected by hand in ClickUp (e.g. a garbled AI name) must win, or Garely keeps
    // showing the old wording and the task reads as stale/missing.
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { fT: 'Nologic Center check', fS: 'open' }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    prismaMock.clickUpTaskLink.updateMany.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);
    vi.stubGlobal('fetch', vi.fn(async () => json({ name: 'Knowledge Center check', status: { status: 'to do', type: 'open' } })));

    await applyClickUpEvent('taskUpdated', 'CU1');

    const upd = prismaMock.row.update.mock.calls[0][0] as any;
    expect(upd.data.data.fT).toBe('Knowledge Center check'); // title mirrored under the title field id
  });

  it('does not blank a Garely title when ClickUp returns no name', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { fT: 'Keep me', fS: 'open' }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    prismaMock.taskRow.updateMany.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);
    vi.stubGlobal('fetch', vi.fn(async () => json({ status: { status: 'in progress', type: 'custom' } })));

    await applyClickUpEvent('taskUpdated', 'CU1');

    const upd = prismaMock.row.update.mock.calls[0][0] as any;
    expect(upd.data.data.fT).toBe('Keep me');
    expect(upd.data.data.fS).toBe('in_progress'); // status still mirrored
  });

  it('skips the write entirely when nothing changed (taskUpdated fires on every edit)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: 'r1' } as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { fT: 'Same', fS: 'open' }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.taskRow.updateMany.mockResolvedValue({} as any);
    vi.stubGlobal('fetch', vi.fn(async () => json({ name: 'Same', status: { status: 'to do', type: 'open' } })));

    await applyClickUpEvent('taskUpdated', 'CU1');

    expect(prismaMock.row.update).not.toHaveBeenCalled(); // no churn on a no-op event
  });
});

describe('reconcileClickUpTasks (catch-up sweep)', () => {
  it('converges a status the webhook never delivered, fetching per LIST not per task', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([
      { clickupTaskId: 'CU1', listId: 'L_IT', rowId: 'r1' },
      { clickupTaskId: 'CU2', listId: 'L_IT', rowId: 'r2' },
    ] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([] as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { fT: 'T', fS: 'open' }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    prismaMock.taskRow.updateMany.mockResolvedValue({} as any);
    prismaMock.clickUpTaskLink.updateMany.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);

    const { calls } = stubFetch((u) => {
      const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.includes('/list/L_IT/task')) {
        return j({ last_page: true, tasks: [
          { id: 'CU1', name: 'T', status: { status: 'complete', type: 'closed' } },
          { id: 'CU2', name: 'T', status: { status: 'to do', type: 'open' } },
        ] });
      }
      return undefined;
    });

    const res = await reconcileClickUpTasks();
    expect(res.checked).toBe(2);
    // One list fetch covers both tasks — never one GET /task per link.
    expect(calls.filter((c) => c.url.includes('/list/L_IT/task')).length).toBe(1);
    expect(calls.some((c) => c.url.includes('/task/CU1?') || c.url.endsWith('/task/CU1'))).toBe(false);
    const wrote = prismaMock.row.update.mock.calls.map((c: any) => c[0].data.data.fS);
    expect(wrote).toContain('done'); // CU1 converged to done
  });

  it('never deletes a Garely row for a task that merely MOVED lists', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([{ clickupTaskId: 'CUmoved', listId: 'L_IT', rowId: 'r1' }] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([] as any);

    stubFetch((u) => {
      const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.includes('/list/L_IT/task')) return j({ last_page: true, tasks: [] }); // not in this list any more
      if (u.includes('/task/CUmoved')) return j({ id: 'CUmoved', name: 'Moved', status: { status: 'to do', type: 'open' } }); // but alive
      return undefined;
    });

    const res = await reconcileClickUpTasks();
    expect(res.deleted).toBe(0);
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
  });

  it('applies ONE authoritative copy per row when a task is split per assignee', async () => {
    // Regression (high): per-user routing puts N ClickUp copies on ONE Garely row. Mirroring
    // every copy is last-writer-wins — a rename on the lead copy gets reverted by another
    // copy's stale name on the same sweep, and completedAt flips. Exactly one copy must win,
    // and it must be the lead (TaskRow.clickupTaskId), never DB row order.
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([
      { clickupTaskId: 'CUb', listId: 'L_IT', rowId: 'r1' }, // non-lead copy, stale name
      { clickupTaskId: 'CUa', listId: 'L_IT', rowId: 'r1' }, // lead copy, renamed by a human
    ] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([{ rowId: 'r1', clickupTaskId: 'CUa' }] as any);
    prismaMock.row.findUnique.mockResolvedValue({ data: { fT: 'Old name', fS: 'open' }, table: { base: { orgId: 'org1' } } } as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    prismaMock.taskRow.updateMany.mockResolvedValue({} as any);
    prismaMock.clickUpTaskLink.updateMany.mockResolvedValue({} as any);
    prismaMock.$transaction.mockResolvedValue([] as any);

    stubFetch((u) => {
      const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.includes('/list/L_IT/task')) {
        return j({ last_page: true, tasks: [
          { id: 'CUa', name: 'Renamed by human', status: { status: 'to do', type: 'open' } },
          { id: 'CUb', name: 'Old name', status: { status: 'to do', type: 'open' } },
        ] });
      }
      return undefined;
    });

    await reconcileClickUpTasks();

    // Exactly one write for the row, and it carries the LEAD copy's name.
    expect(prismaMock.row.update).toHaveBeenCalledTimes(1);
    const upd = prismaMock.row.update.mock.calls[0][0] as any;
    expect(upd.data.data.fT).toBe('Renamed by human');
  });

  it('prunes a dead link with no Garely row instead of counting it as a deletion', async () => {
    // Found on prod: 53 legacy links pointed at long-gone ClickUp tasks and resolved to no row.
    // applyClickUpEvent no-ops on those, but the sweep still counted them as "deleted" AND left
    // them in place — so every run re-probed dead ids and pinned the delete cap forever,
    // masking any real deletion.
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([{ clickupTaskId: 'CUdead', listId: 'L_IT', rowId: null }] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([] as any); // nothing claims it
    prismaMock.clickUpTaskLink.deleteMany.mockResolvedValue({ count: 1 } as any);

    stubFetch((u) => {
      const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.includes('/list/L_IT/task')) return j({ last_page: true, tasks: [] });
      if (u.includes('/task/CUdead')) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' } as Response;
      return undefined;
    });

    const res = await reconcileClickUpTasks();
    expect(res.pruned).toBe(1);
    expect(res.deleted).toBe(0); // never counted as a task deletion — no user data involved
    expect(prismaMock.clickUpTaskLink.deleteMany).toHaveBeenCalled(); // the dead link is gone
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled(); // and no Garely row touched
  });

  it('skips a whole list it could not enumerate, instead of per-task checking it', async () => {
    // A list fetch that fails tells us NOTHING about its tasks. Falling through to a per-task
    // check would fire one GET per link (rate-limit storm) and risk reading an outage as gone.
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([
      { clickupTaskId: 'CUa', listId: 'L_DEAD', rowId: 'r1' },
      { clickupTaskId: 'CUb', listId: 'L_DEAD', rowId: 'r2' },
    ] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([] as any);

    const { calls } = stubFetch((u) => {
      if (u.includes('/list/L_DEAD/task')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' } as Response;
      }
      return undefined;
    });

    const res = await reconcileClickUpTasks();
    expect(res.deleted).toBe(0);
    expect(res.skipped).toBe(2);
    // No per-task fallback GETs for links whose list we could not read.
    expect(calls.some((c) => c.url.includes('/task/CUa'))).toBe(false);
    expect(calls.some((c) => c.url.includes('/task/CUb'))).toBe(false);
  });

  it('does not delete on a transient API failure — only a confirmed 404', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    const { reconcileClickUpTasks } = await import('@/lib/clickup');
    prismaMock.clickUpTaskLink.findMany.mockResolvedValue([{ clickupTaskId: 'CUerr', listId: 'L_IT', rowId: 'r1' }] as any);
    prismaMock.taskRow.findMany.mockResolvedValue([] as any);

    stubFetch((u) => {
      const j = (b: unknown) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) }) as Response;
      if (u.includes('/list/L_IT/task')) return j({ last_page: true, tasks: [] });
      if (u.includes('/task/CUerr')) {
        return { ok: false, status: 500, json: async () => ({}), text: async () => 'server error' } as Response;
      }
      return undefined;
    });

    const res = await reconcileClickUpTasks();
    expect(res.deleted).toBe(0); // a 5xx must never be read as "deleted"
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
  });
});
