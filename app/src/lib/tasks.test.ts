import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import {
  deleteTask,
  setRowAssignees,
  applyCustomCells,
  aiCellsFromModel,
  createTask,
  createTaskField,
  updateTaskField,
  deleteTaskField,
  listTaskFields,
  myOpenTasks,
} from '@/lib/tasks';
import { getCurrentOrgId } from '@/lib/org';

const PROV = {
  base: { id: 'b1' },
  table: { id: 'tbl', primaryFieldId: 'fT' },
  fieldIds: { title: 'fT', description: 'fD', status: 'fS', priority: 'fP', dueDate: 'fU', assignee: 'fA' },
  views: { grid: 'v1', board: 'v2', calendar: 'v3' },
};

vi.mock('@/lib/prisma');
vi.mock('@/lib/system-tasks-table', () => ({
  getSystemTasksTable: vi.fn(async () => PROV),
  provisionSystemTasksTable: vi.fn(async () => PROV),
}));
vi.mock('@/lib/access', () => ({ userDepartmentIds: vi.fn(async () => []), userCanAccessMeeting: vi.fn(), userCanViewTask: vi.fn() }));
vi.mock('@/lib/org', () => ({ getCurrentOrgId: vi.fn(async () => 'org-A'), requireCurrentOrgId: vi.fn() }));

beforeEach(() => {
  mockReset(prismaMock);
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock));
  vi.mocked(getCurrentOrgId).mockResolvedValue('org-A');
});

describe('deleteTask — explicit subtask cascade', () => {
  it('deletes subtask Rows BEFORE the parent (TaskRow.parentRowId has no FK cascade)', async () => {
    prismaMock.taskRow.findMany.mockResolvedValue([{ rowId: 's1' }, { rowId: 's2' }] as any);
    const order: string[] = [];
    prismaMock.row.deleteMany.mockImplementation(async () => { order.push('deleteMany'); return { count: 2 } as any; });
    prismaMock.row.delete.mockImplementation(async () => { order.push('delete'); return { id: 't1' } as any; });

    await deleteTask('t1');

    expect(prismaMock.row.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s1', 's2'] } } });
    expect(prismaMock.row.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
    expect(order).toEqual(['deleteMany', 'delete']); // subtasks first, then parent
  });

  it('skips the subtask deleteMany when there are no subtasks', async () => {
    prismaMock.taskRow.findMany.mockResolvedValue([] as any);
    prismaMock.row.delete.mockResolvedValue({ id: 't1' } as any);
    await deleteTask('t1');
    expect(prismaMock.row.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.row.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
  });
});

describe('setRowAssignees — denorm keeper', () => {
  it('rewrites RowAssignment to the set AND mirrors the person cell (lead first)', async () => {
    prismaMock.row.findUnique
      .mockResolvedValueOnce({ table: { base: { orgId: 'org-A' } } } as any) // org lookup
      .mockResolvedValueOnce({ data: { existing: 1 } } as any); // current cell bag
    prismaMock.rowAssignment.deleteMany.mockResolvedValue({ count: 0 } as any);
    prismaMock.rowAssignment.upsert.mockResolvedValue({} as any);
    prismaMock.row.update.mockResolvedValue({} as any);

    await setRowAssignees('t1', ['u1', 'u2', 'u1']); // dedup → [u1,u2]

    expect(prismaMock.rowAssignment.deleteMany).toHaveBeenCalledWith({ where: { rowId: 't1', userId: { notIn: ['u1', 'u2'] } } });
    expect(prismaMock.rowAssignment.upsert).toHaveBeenCalledTimes(2);
    const upd = (prismaMock.row.update.mock.calls[0][0] as any).data;
    expect(upd.data.fA).toEqual(['u1', 'u2']); // person cell = assignees, lead (u1) first
    expect(upd.data.existing).toBe(1); // preserves other cells
  });

  it('clears the person cell when the set becomes empty', async () => {
    prismaMock.row.findUnique
      .mockResolvedValueOnce({ table: { base: { orgId: 'org-A' } } } as any)
      .mockResolvedValueOnce({ data: { fA: ['u1'] } } as any);
    prismaMock.rowAssignment.deleteMany.mockResolvedValue({ count: 1 } as any);
    prismaMock.row.update.mockResolvedValue({} as any);

    await setRowAssignees('t1', []);

    // sentinel keeps deleteMany valid (removes everyone) when the set is empty
    expect(prismaMock.rowAssignment.deleteMany).toHaveBeenCalledWith({ where: { rowId: 't1', userId: { notIn: [' '] } } });
    const upd = (prismaMock.row.update.mock.calls[0][0] as any).data;
    expect('fA' in upd.data).toBe(false); // person cell cleared
  });
});

describe('applyCustomCells — custom-field write guard (P3.3)', () => {
  // reserved = title/desc/status/priority/dueDate/assignee field ids
  const reserved = ['fT', 'fD', 'fS', 'fP', 'fU', 'fA'];

  it('merges custom cells but REJECTS reserved (system + assignee) ids', () => {
    const patch: Record<string, unknown> = { fS: 'done' }; // a typed-field patch already set
    applyCustomCells(patch, { fX: 42, fCustom: 'ok', fA: ['evil'], fS: 'open' }, reserved);
    expect(patch.fX).toBe(42);
    expect(patch.fCustom).toBe('ok');
    expect(patch.fA).toBeUndefined();   // assignee never writable via cells (only setRowAssignees)
    expect(patch.fS).toBe('done');      // typed status preserved — cells can't clobber the one write path
  });

  it('no-ops when cells is undefined (returns the same patch object)', () => {
    const patch = { fS: 'done' };
    expect(applyCustomCells(patch, undefined, reserved)).toBe(patch);
  });
});

describe('createTask — custom cells at creation (P3.3)', () => {
  it('merges custom-field cells and rejects reserved (system/assignee) ids', async () => {
    prismaMock.field.findMany.mockResolvedValue([
      { id: 'fT', type: 'text', options: null },
      { id: 'fD', type: 'longText', options: null },
      { id: 'fS', type: 'singleSelect', options: { choices: [{ id: 'open' }] } },
      { id: 'fP', type: 'singleSelect', options: { choices: [{ id: 'medium' }] } },
      { id: 'fU', type: 'date', options: null },
      { id: 'fA', type: 'person', options: { multiple: true } },
      { id: 'fX', type: 'text', options: null },
    ] as any);
    prismaMock.row.create.mockResolvedValue({ id: 'new1' } as any);
    prismaMock.taskRow.create.mockResolvedValue({} as any);
    prismaMock.rowAssignment.create.mockResolvedValue({} as any);
    prismaMock.row.findUnique.mockResolvedValue(null as any); // getTaskById short-circuits

    await createTask({ user: { id: 'u1', orgId: 'org-A' } } as any, {
      title: 'T',
      cells: { fX: 'Acme', fS: 'evil-status' }, // fS is reserved → must be ignored
    });

    const stored = (prismaMock.row.create.mock.calls[0][0] as any).data.data;
    expect(stored.fX).toBe('Acme'); // custom cell persisted
    expect(stored.fS).toBe('open'); // status stays 'open' — cells can't override the typed field
  });
});

describe('aiCellsFromModel — AI fills custom fields from transcript (P4.1)', () => {
  const ff = (id: string, name: string, type: string, options: unknown = null) => ({ id, name, type, options } as any);
  const fields = [
    ff('fC', 'Client', 'text'),
    ff('fB', 'Budget', 'number'),
    ff('fS', 'Stage', 'singleSelect', { choices: [{ id: 'won', name: 'Won' }, { id: 'lost', name: 'Lost' }] }),
    ff('fG', 'Tags', 'multiSelect', { choices: [{ id: 'vip', name: 'VIP' }, { id: 'urg', name: 'Urgent' }] }),
    ff('fD', 'Deadline', 'date'),   // not AI-fillable
    ff('fO', 'Owner', 'person'),    // not AI-fillable
  ];

  it('projects text/number and resolves select names → choice ids', () => {
    const out = aiCellsFromModel(fields, { Client: 'Acme', Budget: '5000', Stage: 'Won', Tags: ['VIP', 'nope', 'Urgent'] });
    expect(out).toEqual({ fC: 'Acme', fB: 5000, fS: 'won', fG: ['vip', 'urg'] });
  });

  it('matches field names case-insensitively; drops unknown select options', () => {
    expect(aiCellsFromModel(fields, { stage: 'won' })).toEqual({ fS: 'won' });
    expect(aiCellsFromModel(fields, { Stage: 'Maybe' })).toEqual({}); // not a listed choice
  });

  it('ignores non-fillable types (date/person) and empty values', () => {
    expect(aiCellsFromModel(fields, { Deadline: 'next week', Owner: 'Anna', Client: '' })).toEqual({});
  });

  it('returns {} for non-object model fields', () => {
    expect(aiCellsFromModel(fields, null)).toEqual({});
    expect(aiCellsFromModel(fields, 'x')).toEqual({});
  });

  it('coerces checkbox truthy/falsey, drops the unrecognized', () => {
    const cb = [ff('fK', 'Done', 'checkbox')];
    expect(aiCellsFromModel(cb, { Done: 'yes' })).toEqual({ fK: true });
    expect(aiCellsFromModel(cb, { Done: false })).toEqual({ fK: false });
    expect(aiCellsFromModel(cb, { Done: 'maybe' })).toEqual({});
  });

  it('duplicate field names: first wins, no fan-out into multiple ids', () => {
    const dup = [ff('f1', 'Notes', 'text'), ff('f2', 'notes', 'text')]; // same name, case-collision
    expect(aiCellsFromModel(dup, { Notes: 'hi' })).toEqual({ f1: 'hi' }); // only the first
  });

  it('does not pull inherited prototype keys (Object.hasOwn)', () => {
    const proto = [ff('fX', 'toString', 'text')];
    expect(aiCellsFromModel(proto, {})).toEqual({}); // {}.toString exists on prototype but not own
  });
});

describe('createTaskField — custom field schema (P3.3)', () => {
  it('rejects link fields in v1', async () => {
    const r = await createTaskField('org-A', { name: 'Rel', type: 'link' as any });
    expect(r).toEqual({ error: 'unsupported_field_type', status: 400 });
    expect(prismaMock.field.create).not.toHaveBeenCalled();
  });

  it('creates a custom field on the org-resolved system table (never a client table)', async () => {
    prismaMock.field.count.mockResolvedValue(6 as any);
    prismaMock.field.create.mockResolvedValue({ id: 'fX', tableId: 'tbl', name: 'Cost', type: 'currency', options: { symbol: '₴', precision: 2 }, position: 6, width: null } as any);
    const r = await createTaskField('org-A', { name: 'Cost', type: 'currency' as any });
    expect('field' in r && r.field.id).toBe('fX');
    expect((prismaMock.field.create.mock.calls[0][0] as any).data.tableId).toBe('tbl'); // resolved from orgId
  });
});

describe('updateTaskField / deleteTaskField — scope + system-field guard (P3.3)', () => {
  it('refuses one of the 6 system field ids (403)', async () => {
    prismaMock.field.findUnique.mockResolvedValue({ tableId: 'tbl', type: 'singleSelect', options: null } as any);
    const r = await updateTaskField('org-A', 'fS', { name: 'x' }); // fS = status (system)
    expect(r).toEqual({ error: 'system_field', status: 403 });
    expect(prismaMock.field.update).not.toHaveBeenCalled();
  });

  it('refuses a field outside the org Tasks table (404)', async () => {
    prismaMock.field.findUnique.mockResolvedValue({ tableId: 'OTHER', type: 'text', options: null } as any);
    const r = await deleteTaskField('org-A', 'fForeign');
    expect(r).toEqual({ error: 'not_found', status: 404 });
    expect(prismaMock.field.delete).not.toHaveBeenCalled();
  });

  it('deletes a custom field that belongs to the Tasks table', async () => {
    prismaMock.field.findUnique.mockResolvedValue({ tableId: 'tbl', type: 'currency', options: null } as any);
    prismaMock.field.delete.mockResolvedValue({} as any);
    const r = await deleteTaskField('org-A', 'fX');
    expect(r).toEqual({ ok: true });
    expect(prismaMock.field.delete).toHaveBeenCalledWith({ where: { id: 'fX' } });
  });
});

describe('listTaskFields — client FieldT projection (P3.3)', () => {
  it('maps the system table fields and normalizes width to null', async () => {
    prismaMock.field.findMany.mockResolvedValue([
      { id: 'fT', tableId: 'tbl', name: 'Title', type: 'text', options: null, position: 0, width: 240 },
      { id: 'fX', tableId: 'tbl', name: 'Cost', type: 'currency', options: { symbol: '₴', precision: 2 }, position: 6, width: null },
    ] as any);
    const fields = await listTaskFields({ user: { id: 'u1' } } as any);
    expect(fields).toHaveLength(2);
    expect(fields[1]).toMatchObject({ id: 'fX', name: 'Cost', type: 'currency', width: null });
  });

  it('returns [] when the org has no system Tasks table', async () => {
    const { getSystemTasksTable } = await import('@/lib/system-tasks-table');
    vi.mocked(getSystemTasksTable).mockResolvedValueOnce(null as any);
    expect(await listTaskFields({ user: { id: 'u1' } } as any)).toEqual([]);
  });
});

describe('updateTask — concurrent cell edits', () => {
  it('merges against the row read INSIDE the transaction, not the pre-transaction snapshot', async () => {
    // Regression: the merge used a snapshot read before the transaction, so two people
    // editing DIFFERENT cells of one task raced and the later write clobbered the
    // earlier. /api/rows got SELECT … FOR UPDATE; the task path never did.
    const { updateTask } = await import('@/lib/tasks');
    prismaMock.row.findUnique.mockResolvedValue({
      id: 't1', data: { fT: 'old title', fD: 'stale' }, table: { id: 'tbl', base: { orgId: 'org-A' } },
    } as any);
    prismaMock.field.findMany.mockResolvedValue([
      { id: 'fT', type: 'text', options: null }, { id: 'fD', type: 'text', options: null },
    ] as any);
    // someone else committed a description change between the snapshot and the write
    prismaMock.$queryRaw.mockResolvedValue([{ data: { fT: 'old title', fD: 'THEIR EDIT' } }] as any);
    prismaMock.row.update.mockResolvedValue({} as any);
    prismaMock.taskRow.update.mockResolvedValue({} as any);

    await updateTask('t1', { title: 'my title' });

    const written = (prismaMock.row.update.mock.calls[0][0] as any).data.data;
    expect(written.fT).toBe('my title');      // our change applied
    expect(written.fD).toBe('THEIR EDIT');    // and theirs survived
  });
});

describe('myOpenTasks — dashboard ordering', () => {
  const row = (title: string, priority: string) => ({
    id: title, position: 0, createdAt: new Date('2026-01-01T00:00:00Z'),
    data: { fT: title, fP: priority, fS: 'open' }, taskMeta: null, assignments: [], collaborators: [], _count: { comments: 0, attachments: 0 },
  });

  it('orders by severity (high → medium → low), not alphabetically', async () => {
    // Regression: a string sort ranked low ('l') above medium ('m'), so the dashboard
    // buried the more urgent task under a less urgent one.
    prismaMock.row.findMany.mockResolvedValue([row('L', 'low'), row('H', 'high'), row('M', 'medium')] as any);
    const out = await myOpenTasks({ user: { id: 'u1' } } as any);
    expect(out.map((t) => t.priority)).toEqual(['high', 'medium', 'low']);
  });

  it('drops done tasks and unknown priorities sort last', async () => {
    prismaMock.row.findMany.mockResolvedValue([
      row('done', 'high'), row('none', ''), row('hi', 'high'),
    ].map((r, i) => (i === 0 ? { ...r, data: { ...r.data, fS: 'done' } } : r)) as any);
    const out = await myOpenTasks({ user: { id: 'u1' } } as any);
    expect(out.map((t) => t.title)).toEqual(['hi', 'none']); // done filtered; blank priority last
  });
});
