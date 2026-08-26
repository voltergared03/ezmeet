'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Filter, ArrowUpDown, Plus, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import {
  filterOpsForType,
  defaultOpForType,
  valueKindFor,
  isSortable,
  type FilterOp,
} from '../lib/filter-ops';
import type { FieldT, FieldType, FilterCond, SortCond, OrgMember } from '../lib/types';

const COMMIT_DELAY = 350; // debounce for free-text/number typing

function sanitizeFilters(filters: FilterCond[] | undefined, fields: FieldT[]): FilterCond[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return (filters ?? [])
    .filter((f) => byId.has(f.fieldId))
    .map((f) => {
      const fld = byId.get(f.fieldId)!;
      const ops = filterOpsForType(fld.type);
      return { fieldId: f.fieldId, op: ops.includes(f.op as FilterOp) ? f.op : ops[0], value: f.value };
    });
}

function sanitizeSorts(sorts: SortCond[] | undefined, fields: FieldT[]): SortCond[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return (sorts ?? [])
    .filter((s) => byId.has(s.fieldId) && isSortable(byId.get(s.fieldId)!.type))
    .map((s) => ({ fieldId: s.fieldId, dir: s.dir === 'desc' ? 'desc' : 'asc' }));
}

export function GridToolbar({
  fields,
  members,
  filters: initialFilters,
  sorts: initialSorts,
  rowCount,
  onChange,
  readOnly = false,
}: {
  fields: FieldT[];
  members: OrgMember[];
  filters: FilterCond[];
  sorts: SortCond[];
  rowCount: number;
  onChange: (next: { filters: FilterCond[]; sorts: SortCond[] }) => void;
  /** Viewer mode: hide the filter/sort builders (they persist to the shared view config). */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const [filters, setFilters] = useState<FilterCond[]>(() => sanitizeFilters(initialFilters, fields));
  const [sorts, setSorts] = useState<SortCond[]>(() => sanitizeSorts(initialSorts, fields));
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const sortableFields = fields.filter((f) => isSortable(f.type));

  function push(nextFilters: FilterCond[], nextSorts: SortCond[], immediate: boolean) {
    setFilters(nextFilters);
    setSorts(nextSorts);
    if (timer.current) clearTimeout(timer.current);
    const fire = () => onChange({ filters: nextFilters, sorts: nextSorts });
    if (immediate) fire();
    else timer.current = setTimeout(fire, COMMIT_DELAY);
  }

  // --- filters ---
  const addFilter = () => {
    const f = fields[0];
    if (!f) return;
    push([...filters, { fieldId: f.id, op: defaultOpForType(f.type), value: undefined }], sorts, true);
  };
  const removeFilter = (i: number) => push(filters.filter((_, idx) => idx !== i), sorts, true);
  const clearFilters = () => push([], sorts, true);
  const changeFilterField = (i: number, fieldId: string) => {
    const fld = fieldById.get(fieldId);
    const op = fld ? defaultOpForType(fld.type) : 'isEmpty';
    push(filters.map((f, idx) => (idx === i ? { fieldId, op, value: undefined } : f)), sorts, true);
  };
  const changeFilterOp = (i: number, op: string) => {
    const f = filters[i];
    const fld = fieldById.get(f.fieldId);
    const prevKind = fld ? valueKindFor(fld.type, f.op as FilterOp) : 'none';
    const nextKind = fld ? valueKindFor(fld.type, op as FilterOp) : 'none';
    push(filters.map((x, idx) => (idx === i ? { ...x, op, value: prevKind === nextKind ? x.value : undefined } : x)), sorts, true);
  };
  const changeFilterValue = (i: number, value: unknown, immediate: boolean) =>
    push(filters.map((f, idx) => (idx === i ? { ...f, value } : f)), sorts, immediate);

  // --- sorts ---
  const addSort = () => {
    const f = sortableFields[0];
    if (!f) return;
    push(filters, [...sorts, { fieldId: f.id, dir: 'asc' }], true);
  };
  const removeSort = (i: number) => push(filters, sorts.filter((_, idx) => idx !== i), true);
  const clearSorts = () => push(filters, [], true);
  const changeSort = (i: number, patch: Partial<SortCond>) =>
    push(filters, sorts.map((s, idx) => (idx === i ? { ...s, ...patch } : s)), true);

  const pill: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 17, height: 17,
    padding: '0 5px', borderRadius: 9, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 10.5, fontWeight: 700,
  };
  const activeBtn = (on: boolean): CSSProperties =>
    on ? { background: 'color-mix(in oklab, var(--accent) 14%, transparent)', borderColor: 'var(--accent)', color: 'var(--text)' } : {};

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
      {!readOnly && (
        <>
          <button className="btn btn-ghost" onClick={() => setFilterOpen(true)} style={{ gap: 6, fontWeight: 600, ...activeBtn(filters.length > 0) }}>
            <Filter size={15} /> {t('filter')}
            {filters.length > 0 && <span style={pill}>{filters.length}</span>}
          </button>
          <button className="btn btn-ghost" onClick={() => setSortOpen(true)} style={{ gap: 6, fontWeight: 600, ...activeBtn(sorts.length > 0) }}>
            <ArrowUpDown size={15} /> {t('sort')}
            {sorts.length > 0 && <span style={pill}>{sorts.length}</span>}
          </button>
        </>
      )}
      <div style={{ flex: 1 }} />
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{rowCount} {t('recordsShort')}</span>

      {/* Filter builder */}
      <Modal open={filterOpen} onClose={() => setFilterOpen(false)} title={t('filter')} width={580}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>{t('filterAndHint')}</div>
        {filters.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 0 14px' }}>{t('noFilters')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {filters.map((f, i) => {
              const fld = fieldById.get(f.fieldId);
              const kind = fld ? valueKindFor(fld.type, f.op as FilterOp) : 'none';
              return (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 10, background: 'var(--surface-2)' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Select
                      value={f.fieldId}
                      onChange={(v) => changeFilterField(i, v)}
                      options={fields.map((x) => ({ value: x.id, label: x.name }))}
                      style={{ flex: 1.4, padding: '7px 10px', minWidth: 0 }}
                    />
                    <Select
                      value={f.op}
                      onChange={(v) => changeFilterOp(i, v)}
                      options={(fld ? filterOpsForType(fld.type) : (['isEmpty', 'isNotEmpty'] as FilterOp[])).map((op) => ({ value: op, label: t(`ops.${op}` as never) }))}
                      style={{ flex: 1, padding: '7px 10px', minWidth: 0 }}
                    />
                    <button className="btn btn-ghost btn-icon" onClick={() => removeFilter(i)} aria-label={t('remove')} style={{ width: 30, height: 30, flexShrink: 0 }}><X size={15} /></button>
                  </div>
                  {fld && kind !== 'none' && (
                    <div style={{ marginTop: 8 }}>
                      <FilterValueEditor field={fld} kind={kind} value={f.value} members={members} onChange={(v, immediate) => changeFilterValue(i, v, immediate)} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <ModalFooter
          onAdd={addFilter}
          addLabel={t('addFilter')}
          onClear={filters.length > 0 ? clearFilters : undefined}
          clearLabel={tc('clear')}
          onDone={() => setFilterOpen(false)}
          doneLabel={t('done')}
        />
      </Modal>

      {/* Sort builder */}
      <Modal open={sortOpen} onClose={() => setSortOpen(false)} title={t('sort')} width={520}>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12 }}>{t('sortHint')}</div>
        {sorts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--muted)', padding: '4px 0 14px' }}>{t('noSorts')}</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
            {sorts.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: 8, background: 'var(--surface-2)' }}>
                <Select
                  value={s.fieldId}
                  onChange={(v) => changeSort(i, { fieldId: v })}
                  options={sortableFields.map((x) => ({ value: x.id, label: x.name }))}
                  style={{ flex: 1, padding: '7px 10px', minWidth: 0 }}
                />
                <Select
                  value={s.dir ?? 'asc'}
                  onChange={(v) => changeSort(i, { dir: v as 'asc' | 'desc' })}
                  options={[{ value: 'asc', label: t('sortAscending') }, { value: 'desc', label: t('sortDescending') }]}
                  style={{ width: 168, padding: '7px 10px', flexShrink: 0 }}
                />
                <button className="btn btn-ghost btn-icon" onClick={() => removeSort(i)} aria-label={t('remove')} style={{ width: 30, height: 30, flexShrink: 0 }}><X size={15} /></button>
              </div>
            ))}
          </div>
        )}
        <ModalFooter
          onAdd={sortableFields.length ? addSort : undefined}
          addLabel={t('addSort')}
          onClear={sorts.length > 0 ? clearSorts : undefined}
          clearLabel={tc('clear')}
          onDone={() => setSortOpen(false)}
          doneLabel={t('done')}
        />
      </Modal>
    </div>
  );
}

function ModalFooter({ onAdd, addLabel, onClear, clearLabel, onDone, doneLabel }: {
  onAdd?: () => void; addLabel: string; onClear?: () => void; clearLabel: string; onDone: () => void; doneLabel: string;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
      {onAdd ? (
        <button className="btn btn-ghost" onClick={onAdd} style={{ gap: 6, color: 'var(--accent)', fontWeight: 600 }}><Plus size={15} /> {addLabel}</button>
      ) : <span />}
      <div style={{ display: 'flex', gap: 8 }}>
        {onClear && <button className="btn btn-ghost" onClick={onClear}>{clearLabel}</button>}
        <button className="btn btn-primary" onClick={onDone}>{doneLabel}</button>
      </div>
    </div>
  );
}

function FilterValueEditor({ field, kind, value, members, onChange }: {
  field: FieldT;
  kind: ReturnType<typeof valueKindFor>;
  value: unknown;
  members: OrgMember[];
  onChange: (value: unknown, immediate: boolean) => void;
}) {
  const t = useTranslations('database');
  const tc = useTranslations('common');

  if (kind === 'text') {
    return <input className="field" value={typeof value === 'string' ? value : ''} placeholder={t('filterValue')} onChange={(e) => onChange(e.target.value, false)} style={{ width: '100%' }} />;
  }
  if (kind === 'number') {
    return <input className="field" type="number" value={typeof value === 'number' ? value : (typeof value === 'string' ? value : '')} placeholder={t('filterValue')} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value), false)} style={{ width: '100%' }} />;
  }
  if (kind === 'date') {
    const dv = typeof value === 'string' ? value.slice(0, 10) : '';
    return <input className="field" type="date" value={dv} onChange={(e) => onChange(e.target.value || undefined, true)} style={{ width: '100%' }} />;
  }
  if (kind === 'boolean') {
    return (
      <Select
        value={value === true ? 'true' : value === false ? 'false' : ''}
        onChange={(v) => onChange(v === 'true', true)}
        placeholder={t('filterValue')}
        options={[{ value: 'true', label: tc('yes') }, { value: 'false', label: tc('no') }]}
        style={{ width: '100%' }}
      />
    );
  }
  if (kind === 'choice') {
    const choices = field.options?.choices ?? [];
    return (
      <Select
        value={typeof value === 'string' ? value : ''}
        onChange={(v) => onChange(v, true)}
        placeholder={t('filterValue')}
        options={choices.map((c) => ({ value: c.id, label: c.name }))}
        style={{ width: '100%' }}
      />
    );
  }
  // choices (select chips) / members (people chips) → array value
  const arr = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (id: string) => onChange(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id], true);
  if (kind === 'choices') {
    const choices = field.options?.choices ?? [];
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {choices.length === 0 ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span> : choices.map((c) => (
          <ChipToggle key={c.id} on={arr.includes(c.id)} color={c.color} label={c.name} onClick={() => toggle(c.id)} />
        ))}
      </div>
    );
  }
  // members
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {members.length === 0 ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>—</span> : members.map((m) => (
        <ChipToggle key={m.id} on={arr.includes(m.id)} label={m.name || m.email || '?'} avatar={<Avatar name={m.name || m.email || '?'} image={m.image} size="sm" />} onClick={() => toggle(m.id)} />
      ))}
    </div>
  );
}

function ChipToggle({ on, label, color, avatar, onClick }: { on: boolean; label: string; color?: string; avatar?: React.ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, padding: avatar ? '3px 9px 3px 3px' : '5px 10px', borderRadius: 8,
        border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
        background: on ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : 'var(--surface)',
        color: on ? 'var(--text)' : 'var(--text-2)', cursor: 'pointer', fontSize: 12.5, maxWidth: '100%',
      }}
    >
      {avatar}
      {color && <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  );
}
