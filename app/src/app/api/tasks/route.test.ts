import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auth } from '@/lib/auth';
import { listTasks, createTask, updateTask, deleteTask, authorizeTaskMutation, listTaskFields } from '@/lib/tasks';
import { userCanViewTask } from '@/lib/access';
import { mockSession, jsonReq } from '@/test/helpers';
import { GET, POST, PATCH, DELETE } from '@/app/api/tasks/route';

// Tasks are base-engine Rows (Phase 3): the route delegates to the lib/tasks
// adapter, so we mock the adapter and assert the route forwards params + honors
// the authorize/whitelist contract (the adapter's own logic is unit-tested in
// lib/tasks.test.ts and lib/access.test.ts).
vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/tasks', () => ({
  listTasks: vi.fn(async () => []),
  createTask: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(async () => undefined),
  authorizeTaskMutation: vi.fn(),
  listTaskFields: vi.fn(async () => []),
  isClickUpManaged: vi.fn(async () => false),
}));
vi.mock('@/lib/access', () => ({ userCanViewTask: vi.fn(async () => true) }));
vi.mock('@/lib/task-notify', () => ({ notifyTaskAssigned: vi.fn(), notifyTaskUpdated: vi.fn() }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (k: string) => k) }));

const mockAuth = vi.mocked(auth);
const mockList = vi.mocked(listTasks);
const mockCreate = vi.mocked(createTask);
const mockUpdate = vi.mocked(updateTask);
const mockDelete = vi.mocked(deleteTask);
const mockAuthz = vi.mocked(authorizeTaskMutation);
const mockFields = vi.mocked(listTaskFields);

beforeEach(() => {
  mockAuth.mockReset();
  mockList.mockReset().mockResolvedValue([]);
  mockCreate.mockReset();
  mockUpdate.mockReset();
  mockDelete.mockReset().mockResolvedValue(undefined);
  mockAuthz.mockReset();
  mockFields.mockReset().mockResolvedValue([]);
});

const tasksUrl = (qs = '') => `http://localhost/api/tasks${qs}`;

describe('GET /api/tasks', () => {
  it('401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await GET(jsonReq('GET', undefined, tasksUrl()))).status).toBe(401);
  });

  it('forwards scope + filters to the adapter', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    await GET(jsonReq('GET', undefined, tasksUrl('?scope=all&department=sales&status=open')));
    const params = mockList.mock.calls[0][1];
    expect(params.scope).toBe('all');
    expect(params.department).toBe('sales');
    expect(params.status).toBe('open');
  });

  it('defaults scope to "mine" and returns the adapter list', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockList.mockResolvedValue([{ id: 't1' }] as any);
    const r = await GET(jsonReq('GET', undefined, tasksUrl()));
    expect(r.status).toBe(200);
    expect(mockList.mock.calls[0][1].scope).toBe('mine');
    expect(await r.json()).toEqual([{ id: 't1' }]);
  });

  it('?withFields=1 returns { tasks, fields } (P3.3 custom-field payoff)', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockList.mockResolvedValue([{ id: 't1' }] as any);
    mockFields.mockResolvedValue([{ id: 'fX', name: 'Cost', type: 'currency' }] as any);
    const r = await GET(jsonReq('GET', undefined, tasksUrl('?scope=all&withFields=1')));
    expect(r.status).toBe(200);
    expect(mockFields).toHaveBeenCalled();
    expect(await r.json()).toEqual({ tasks: [{ id: 't1' }], fields: [{ id: 'fX', name: 'Cost', type: 'currency' }] });
  });

  it('bare GET stays a plain array (back-compat for dashboard/myOpenTasks)', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockList.mockResolvedValue([{ id: 't1' }] as any);
    const r = await GET(jsonReq('GET', undefined, tasksUrl()));
    expect(Array.isArray(await r.json())).toBe(true);
    expect(mockFields).not.toHaveBeenCalled();
  });
});

describe('POST /api/tasks', () => {
  it('creates a task and notifies the assignees', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockCreate.mockResolvedValue({ task: { id: 't1' } as any, assignees: ['u2'] });
    const r = await POST(jsonReq('POST', { title: 'Ship it', assigneeIds: ['u2'] }, tasksUrl()));
    expect(r.status).toBe(201);
    expect(mockCreate).toHaveBeenCalled();
  });

  it('400 on an empty title', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    expect((await POST(jsonReq('POST', { title: '   ' }, tasksUrl()))).status).toBe(400);
  });
});

describe('PATCH /api/tasks — authorization + whitelist', () => {
  it('401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null);
    expect((await PATCH(jsonReq('PATCH', { taskId: 't1' }))).status).toBe(401);
  });

  it('400 when taskId is missing', async () => {
    mockAuth.mockResolvedValue(mockSession());
    expect((await PATCH(jsonReq('PATCH', {}))).status).toBe(400);
  });

  it('403 when the adapter denies the mutation', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ error: 'Forbidden', status: 403 });
    const r = await PATCH(jsonReq('PATCH', { taskId: 't1', status: 'done' }));
    expect(r.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('updates when authorized', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ meetingId: null, assigneeId: 'u1' });
    mockUpdate.mockResolvedValue({ task: { id: 't1' } as any, before: { status: 'open', dueDate: null }, addedAssignees: [], statusChanged: true, dueChanged: false });
    const r = await PATCH(jsonReq('PATCH', { taskId: 't1', status: 'done' }));
    expect(r.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it('ignores non-whitelisted fields (no mass-assignment)', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ meetingId: null, assigneeId: 'u1' });
    mockUpdate.mockResolvedValue({ task: { id: 't1' } as any, before: { status: 'open', dueDate: null }, addedAssignees: [], statusChanged: true, dueChanged: false });
    await PATCH(jsonReq('PATCH', { taskId: 't1', status: 'done', meetingId: 'evil', source: 'ai', reportId: 'r9' }));
    const fields = mockUpdate.mock.calls[0][1] as any;
    expect(fields.meetingId).toBeUndefined();
    expect(fields.source).toBeUndefined();
    expect(fields.reportId).toBeUndefined();
    expect(fields.status).toBe('done');
  });

  it('404 when the task no longer exists', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ meetingId: null, assigneeId: 'u1' });
    mockUpdate.mockResolvedValue(null);
    expect((await PATCH(jsonReq('PATCH', { taskId: 't1', status: 'done' }))).status).toBe(404);
  });

  it('forwards custom-field cells to the adapter (P3.3)', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ meetingId: null, assigneeId: 'u1' });
    mockUpdate.mockResolvedValue({ task: { id: 't1' } as any, before: { status: 'open', dueDate: null }, addedAssignees: [], statusChanged: false, dueChanged: false });
    await PATCH(jsonReq('PATCH', { taskId: 't1', cells: { fX: 42 } }));
    const fields = mockUpdate.mock.calls[0][1] as any;
    expect(fields.cells).toEqual({ fX: 42 });
  });
});

describe('DELETE /api/tasks — authorization', () => {
  it('403 when the adapter denies the mutation', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ error: 'Forbidden', status: 403 });
    const r = await DELETE(jsonReq('DELETE', { taskId: 't1' }));
    expect(r.status).toBe(403);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('400 when taskId is missing', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    expect((await DELETE(jsonReq('DELETE', {}))).status).toBe(400);
  });

  it('deletes when authorized', async () => {
    mockAuth.mockResolvedValue(mockSession({ id: 'u1', role: 'member' }));
    mockAuthz.mockResolvedValue({ meetingId: null, assigneeId: 'u1' });
    const r = await DELETE(jsonReq('DELETE', { taskId: 't1' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(mockDelete).toHaveBeenCalledWith('t1');
  });
});
