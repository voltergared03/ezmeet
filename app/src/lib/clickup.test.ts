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
});

describe('listIdForDepartment', () => {
  const cfg = (over: Partial<ClickUpConfig> = {}): ClickUpConfig => ({
    token: 'pk_x', teamId: 'team1', routingMode: 'department', listMap: {}, fallbackListId: '', personalRouting: false, ...over,
  });
  const listMap = {
    byDept: new Map([['account management', 'L_AM'], ['it', 'L_IT'], ['call inbox', 'L_INBOX']]),
    fallbackListId: 'L_INBOX',
  };

  it('routes an exact department-name match', () => {
    expect(listIdForDepartment(cfg(), listMap, 'IT')).toBe('L_IT');
  });
  it('routes "Account Manager" → "Account Management" via the built-in alias', () => {
    expect(listIdForDepartment(cfg(), listMap, 'Account Manager')).toBe('L_AM');
  });
  it('falls back to Call Inbox for no/unknown department', () => {
    expect(listIdForDepartment(cfg(), listMap, null)).toBe('L_INBOX');
    expect(listIdForDepartment(cfg(), listMap, 'Marketing')).toBe('L_INBOX');
  });
  it('inbox routing mode sends everything to the fallback', () => {
    expect(listIdForDepartment(cfg({ routingMode: 'inbox' }), listMap, 'IT')).toBe('L_INBOX');
  });
});

// ─────────────────────────── orchestrator (mocked fetch + prisma) ───────────────────────────

// URL-routed fetch mock (robust to call order).
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
    // Per-user routing: create the personal space + a per-user list, then push into it.
    if (u.includes('/team/team1/space') && method === 'POST') { personalSpaceCreated = true; return json({ id: 'spPersonal' }); }
    if (u.includes('/space/spPersonal/list') && method === 'POST') return json({ id: 'LP_u1' });
    if (u.includes('/list/LP_u1/field')) return json({ fields: [] });
    if (u.includes('/list/LP_u1/task') && method === 'POST') return json({ id: 'CUp1', url: 'https://app.clickup.com/t/CUp1' });
    if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'sp1', name: 'IT' }, { id: 'sp2', name: 'Call Inbox' }, ...(personalSpaceCreated ? [{ id: 'spPersonal', name: 'Garely Personal' }] : [])] });
    if (u.includes('/space/sp1/list')) return json({ lists: [{ id: 'L_IT', name: 'Tasks' }] });
    if (u.includes('/space/sp2/list')) return json({ lists: [{ id: 'L_INBOX', name: 'New Tasks' }] });
    if (u.includes('/list/L_IT/field')) return json({ fields: [{ id: 'fSrc', name: 'Source', type: 'drop_down', type_config: { options: [{ id: 'optTg', name: 'Telegram' }, { id: 'optGC', name: 'Garely Call' }] } }] });
    if (u.includes('/list/L_IT/task') && method === 'POST') return json({ id: 'CU1', url: 'https://app.clickup.com/t/CU1' });
    if (u.endsWith('/list/L_INBOX')) return json({ name: 'New Tasks', space: { name: 'Call Inbox' } });
    if (u.includes('/task/CU1') && method === 'PUT') return json({ id: 'CU1' });
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

const enabledConfig = {
  CLICKUP_ENABLED: 'true', CLICKUP_TOKEN: 'pk_secret', CLICKUP_TEAM_ID: 'team1',
  CLICKUP_ROUTING_MODE: 'department', CLICKUP_LIST_MAP: '', CLICKUP_FALLBACK_LIST_ID: '',
};

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

  it('creates a ClickUp task in the department list with assignee, priority, due date and Source', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'A@x.com' }] as any);
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

    // The Garely row is marked ClickUp-owned (read-only mirror + reverse-sync anchor).
    expect(prismaMock.taskRow.update).toHaveBeenCalled();
    const markArgs = prismaMock.taskRow.update.mock.calls[0][0] as any;
    expect(markArgs.where.rowId).toBe('r1');
    expect(markArgs.data.clickupTaskId).toBe('CU1');
  });

  it('UPDATES (not creates) when a link already exists — idempotent regenerate', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com' }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue({ id: 'lnk1', clickupTaskId: 'CU1', clickupUrl: 'https://app.clickup.com/t/CU1' } as any);
    prismaMock.clickUpTaskLink.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/task/CU1'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.clickUpTaskLink.update).toHaveBeenCalled();
  });

  it('SKIPS a task whose only assignee is not in ClickUp (stays native to Garely)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'ghost@x.com' }] as any);
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    // No assignee matched a ClickUp member → not "owned" → never pushed, never marked.
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/task'))).toBe(false);
    expect(prismaMock.clickUpTaskLink.create).not.toHaveBeenCalled();
    expect(prismaMock.taskRow.update).not.toHaveBeenCalled();
  });

  it('mixed assignees: pushes with the matched assignee and notes the unmatched one', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'ghost@x.com' }] as any);
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
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Denys' }] as any);
    prismaMock.departmentMember.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u1' }] as any); // 2 depts
    prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
    prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);
    const { calls } = installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/team/team1/space'))).toBe(true); // space auto-created
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/space/spPersonal/list'))).toBe(true); // personal list created
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/list/LP_u1/task'));
    expect(post).toBeTruthy();
    expect(post!.body.assignees).toEqual([111]);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_IT/task'))).toBe(false); // NOT the dept list
    const linkArgs = prismaMock.clickUpTaskLink.create.mock.calls[0][0] as any;
    expect(linkArgs.data.rowId).toBe('r1');
    expect(linkArgs.data.assigneeUserId).toBe('u1');
  });

  it('personal routing: a single-department assignee stays in the department list', async () => {
    mockReadConfig.mockResolvedValue(personalConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'Bob' }] as any);
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
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com', name: 'A' }, { id: 'u2', email: 'b@x.com', name: 'B' }] as any);
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

  it('deleting an orphaned legacy copy of a now-split-managed row is a safe no-op', async () => {
    // Mixed state: the legacy link has rowId=null and TaskRow.clickupTaskId points at
    // the split lead (a different id), so this delete resolves to no row → untouched.
    prismaMock.clickUpTaskLink.findFirst.mockResolvedValue({ rowId: null } as any);
    prismaMock.taskRow.findFirst.mockResolvedValue(null as any);
    await applyClickUpEvent('taskDeleted', 'CUlegacyOrphan');
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.clickUpTaskLink.deleteMany).not.toHaveBeenCalled();
  });
});

describe('migrateAllTasksToClickUp', () => {
  it('pushes eligible tasks (with status) + marks owned; skips non-ClickUp assignees', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.row.findMany.mockResolvedValue([
      { id: 'r1', data: { fT: 'Migrated task', fP: 'high', fS: 'done' }, taskMeta: { meetingId: null, departmentId: 'dIT', parentRowId: null }, assignments: [{ userId: 'u1' }] },
      { id: 'r2', data: { fT: 'Native task' }, taskMeta: { meetingId: null, departmentId: 'dIT', parentRowId: null }, assignments: [{ userId: 'u2' }] },
    ] as any);
    prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'ghost@x.com' }] as any);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
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
});

describe('getFallbackStats', () => {
  it('null when disabled', async () => {
    mockReadConfig.mockResolvedValue({ ...enabledConfig, CLICKUP_ENABLED: 'false' });
    expect(await getFallbackStats()).toBeNull();
  });
  it('resolves the fallback list + counts tasks routed there (30d + all-time)', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.clickUpTaskLink.count.mockResolvedValueOnce(3 as any).mockResolvedValueOnce(12 as any);
    installFetch();
    const stats = await getFallbackStats();
    expect(stats).toEqual({ listName: 'Call Inbox', last30d: 3, total: 12 });
    // the 30-day count is scoped to the fallback list id
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
  prismaMock.user.findMany.mockResolvedValue([{ id: 'u1', email: 'a@x.com' }] as any);
  prismaMock.clickUpTaskLink.findUnique.mockResolvedValue(null as any);
  prismaMock.clickUpTaskLink.create.mockResolvedValue({} as any);
  prismaMock.taskRow.update.mockResolvedValue({} as any);
}

describe('list discovery: folder-nested lists', () => {
  it('finds a department list inside a ClickUp folder (folderless endpoint returns none)', async () => {
    // Regression: we only called GET /space/{id}/list ("Get Folderless Lists"), so a Space
    // whose lists live in Folders looked empty → the whole department silently fell back
    // to the Call Inbox even though it plainly existed in ClickUp.
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dSales', name: 'Sales' }] as any);
    pushPrismaMocks();

    const { calls, json } = stubFetch((u, method) => {
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }] }] });
      if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'spS', name: 'Sales' }] });
      if (u.includes('/space/spS/list')) return json({ lists: [] });
      if (u.includes('/space/spS/folder')) return json({ folders: [{ id: 'f1', name: 'Boards', lists: [{ id: 'L_SALES', name: 'Tasks' }] }] });
      if (u.includes('/list/L_SALES/task') && method === 'POST') return json({ id: 'CU9', url: 'https://app.clickup.com/t/CU9' });
      return undefined;
    });

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, departmentId: 'dSales' }]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_SALES/task'))).toBe(true);
  });

  it('falls back to fetching a folder’s lists when the folder payload omits them', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dSales', name: 'Sales' }] as any);
    pushPrismaMocks();

    const { calls, json } = stubFetch((u, method) => {
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }] }] });
      if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'spS', name: 'Sales' }] });
      if (u.includes('/space/spS/list')) return json({ lists: [] });
      if (u.includes('/space/spS/folder')) return json({ folders: [{ id: 'f1', name: 'Boards' }] }); // no embedded lists
      if (u.includes('/folder/f1/list')) return json({ lists: [{ id: 'L_SALES', name: 'Tasks' }] });
      if (u.includes('/list/L_SALES/task') && method === 'POST') return json({ id: 'CU9', url: 'https://app.clickup.com/t/CU9' });
      return undefined;
    });

    await pushMeetingTasksToClickUp('m1', [{ ...itTask, departmentId: 'dSales' }]);

    expect(calls.some((c) => c.url.includes('/folder/f1/list'))).toBe(true);
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_SALES/task'))).toBe(true);
  });
});

// ─────────────────────── create retry safety (regression) ───────────────────────

describe('createClickUpTask retry safety', () => {
  const baseRoutes = (json: (b: unknown) => Response) => (u: string) => {
    if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }] }] });
    if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'sp1', name: 'IT' }] });
    if (u.includes('/space/sp1/list')) return json({ lists: [{ id: 'L_IT', name: 'Tasks' }] });
    return undefined;
  };

  it('does NOT retry when the create times out — the task may already exist (no duplicate)', async () => {
    // This is the reported bug: a blind retry after a timeout produced TWO tasks —
    // one WITH the assignee (orphaned) and one WITHOUT (linked).
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
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
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
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
    // A 400 proves nothing was created, so degrading to an unassigned task is safe and
    // keeps the task from being lost. This is the one case the retry exists for.
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT' }] as any);
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

// ─────────────────────── department→list pin (regression) ───────────────────────

describe('department → list pin', () => {
  it('falls back to the pinned list when the department name no longer matches any Space', async () => {
    // Regression: the link was a pure NAME match, so renaming the department (or the Space)
    // silently sent 100% of that department's tasks to the Call Inbox.
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([
      { id: 'dIT', name: 'Renamed Team', clickupListId: 'L_PINNED' },
    ] as any);
    pushPrismaMocks();

    const { calls, json } = stubFetch((u, method) => {
      if (u.endsWith('/team')) return json({ teams: [{ id: 'team1', members: [{ user: { id: 111, email: 'a@x.com' } }] }] });
      if (u.includes('/team/team1/space')) return json({ spaces: [{ id: 'sp2', name: 'Call Inbox' }] });
      if (u.includes('/space/sp2/list')) return json({ lists: [{ id: 'L_INBOX', name: 'New Tasks' }] });
      if (u.includes('/list/L_PINNED/task') && method === 'POST') return json({ id: 'CU7', url: 'https://app.clickup.com/t/CU7' });
      return undefined;
    });

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/list/L_PINNED/task'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/list/L_INBOX/task'))).toBe(false); // not stranded in the Inbox
  });

  it('pins the list on a successful name resolve, so a later rename is survivable', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT', clickupListId: null }] as any);
    prismaMock.department.update.mockResolvedValue({} as any);
    pushPrismaMocks();
    installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(prismaMock.department.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'dIT' }, data: { clickupListId: 'L_IT' } }),
    );
  });

  it('does not re-write an unchanged pin', async () => {
    mockReadConfig.mockResolvedValue(enabledConfig);
    prismaMock.department.findMany.mockResolvedValue([{ id: 'dIT', name: 'IT', clickupListId: 'L_IT' }] as any);
    prismaMock.department.update.mockResolvedValue({} as any);
    pushPrismaMocks();
    installFetch();

    await pushMeetingTasksToClickUp('m1', [itTask]);

    expect(prismaMock.department.update).not.toHaveBeenCalled();
  });
});
