'use client';

import { useState, useRef, useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Plus, Trash2, MoreHorizontal, Pencil, Star, Type, Maximize2, GripVertical, Check, Minus, CopyPlus, X } from 'lucide-react';
import { FieldCell } from './FieldCell';
import { FieldEditor } from './FieldEditor';
import { RecordModal } from './RecordModal';
import { RowContextMenu } from './RowContextMenu';
import { TYPE_ICONS } from './field-icons';
import type { TableT, RowT, OrgMember, FieldT, FieldType } from '../lib/types';

const GUTTER = 60; // row-number / drag / checkbox column width

/** Move `dragId` to before/after `overId` within `ids`. Returns the new order, or null if it's a no-op. */
function moveWithin(ids: string[], dragId: string, overId: string, after: boolean): string[] | null {
  if (dragId === overId) return null;
  const without = ids.filter((id) => id !== dragId);
  let idx = without.indexOf(overId);
  if (idx < 0) return null;
  if (after) idx += 1;
  const next = [...without.slice(0, idx), dragId, ...without.slice(idx)];
  if (next.length === ids.length && next.every((id, i) => id === ids[i])) return null; // unchanged
  return next;
}

export function GridView({
  table,
  rows,
  members,
  onCellChange,
  onAddRow,
  onAddField,
  onEditField,
  onDeleteRow,
  onDeleteField,
  onSetPrimary,
  onResizeField,
  onReorderFields,
  onReorderRows,
  canReorderRows = true,
  onInsertRow,
  onDuplicateRows,
  onBulkDelete,
  onCopyRowLink,
  readOnly = false,
}: {
  table: TableT;
  rows: RowT[];
  members: OrgMember[];
  onCellChange: (rowId: string, fieldId: string, value: unknown) => void;
  onAddRow: () => void;
  onAddField: (name: string, type: FieldType, options?: unknown) => void;
  onEditField: (fieldId: string, patch: { name: string; type: FieldType; options?: unknown }) => void;
  onDeleteRow: (rowId: string) => void;
  onDeleteField: (fieldId: string) => void;
  onSetPrimary: (fieldId: string) => void;
  onResizeField: (fieldId: string, width: number) => void;
  onReorderFields?: (orderedIds: string[]) => void;
  onReorderRows?: (orderedIds: string[]) => void;
  /** Manual row drag is disabled while a view sort is active (sort overrides position). */
  canReorderRows?: boolean;
  onInsertRow?: (anchorId: string, position: 'above' | 'below', count: number) => void;
  onDuplicateRows?: (ids: string[]) => void;
  onBulkDelete?: (ids: string[]) => void;
  onCopyRowLink?: (rowId: string) => void;
  /** Viewer mode: cells become read-only and ALL edit/structure affordances are hidden. */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const [editor, setEditor] = useState<{ field: FieldT | null } | null>(null);
  const [detail, setDetail] = useState<{ id: string; focus?: 'comments' } | null>(null);
  const [widths, setWidths] = useState<Record<string, number>>({}); // in-session drag overrides
  // Drag-to-reorder state
  const [dragField, setDragField] = useState<string | null>(null);
  const [overField, setOverField] = useState<{ id: string; after: boolean } | null>(null);
  const [dragRow, setDragRow] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<{ id: string; after: boolean } | null>(null);
  // Multi-select + context menu
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [headerHover, setHeaderHover] = useState(false);
  const [ctx, setCtx] = useState<{ rowId: string; x: number; y: number } | null>(null);

  // Reset selection when the table changes.
  useEffect(() => { setSelected(new Set()); }, [table.id]);

  const fields = [...table.fields].sort((a, b) => a.position - b.position);
  const widthOf = (f: FieldT) => widths[f.id] ?? f.width ?? (f.id === table.primaryFieldId ? 240 : 180);
  const template = `${GUTTER}px ${fields.map((f) => `${widthOf(f)}px`).join(' ')} 160px`;
  const detailRow = detail ? rows.find((r) => r.id === detail.id) ?? null : null;
  const rowsDraggable = !readOnly && canReorderRows && !!onReorderRows && rows.length > 1;
  const anySelected = selected.size > 0;
  const allSelected = rows.length > 0 && selected.size === rows.length;

  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
  const clearSelection = () => setSelected(new Set());
  // Right-clicking a selected row targets the whole selection; otherwise just that row.
  const targetIds = (rowId: string) => (selected.has(rowId) && selected.size > 0 ? Array.from(selected) : [rowId]);

  const headerCell: CSSProperties = {
    background: 'var(--surface)',
    borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)',
    height: 38, display: 'flex', alignItems: 'center', padding: '0 10px',
    fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
  };
  const bodyCell: CSSProperties = {
    borderBottom: '1px solid var(--border)', borderRight: '1px solid var(--border)',
    height: 36, display: 'flex', alignItems: 'center', overflow: 'hidden',
  };

  const commitFieldDrop = (overId: string, after: boolean) => {
    if (dragField && onReorderFields) {
      const next = moveWithin(fields.map((f) => f.id), dragField, overId, after);
      if (next) onReorderFields(next);
    }
    setDragField(null);
    setOverField(null);
  };
  const commitRowDrop = (overId: string, after: boolean) => {
    if (dragRow && onReorderRows) {
      const next = moveWithin(rows.map((r) => r.id), dragRow, overId, after);
      if (next) onReorderRows(next);
    }
    setDragRow(null);
    setOverRow(null);
  };

  const bulkDelete = () => { if (onBulkDelete && selected.size) { onBulkDelete(Array.from(selected)); clearSelection(); } };
  const bulkDuplicate = () => { if (onDuplicateRows && selected.size) { onDuplicateRows(Array.from(selected)); clearSelection(); } };

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg)', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ overflow: 'auto', flex: 1, minHeight: 0 }}>
      <div style={{ minWidth: 'max-content' }}>
        <div style={{ display: 'grid', gridTemplateColumns: template, position: 'sticky', top: 0, zIndex: 2 }}>
          <div
            style={{ ...headerCell, justifyContent: 'center', color: 'var(--muted)', position: 'sticky', left: 0, zIndex: 3 }}
            onMouseEnter={() => setHeaderHover(true)}
            onMouseLeave={() => setHeaderHover(false)}
          >
            {!readOnly && (headerHover || anySelected)
              ? <Checkbox checked={allSelected} indeterminate={anySelected && !allSelected} onToggle={toggleAll} ariaLabel={t('selectAll')} />
              : <span>#</span>}
          </div>
          {fields.map((f, ci) => (
            <FieldHeaderCell
              key={f.id}
              field={f}
              isPrimary={f.id === table.primaryFieldId}
              style={headerCell}
              width={widthOf(f)}
              frozen={ci === 0}
              leftOffset={GUTTER}
              onEdit={() => setEditor({ field: f })}
              onDelete={() => onDeleteField(f.id)}
              onSetPrimary={() => onSetPrimary(f.id)}
              onResize={(w) => setWidths((prev) => ({ ...prev, [f.id]: w }))}
              onResizeEnd={(w) => onResizeField(f.id, w)}
              readOnly={readOnly}
              draggable={!readOnly && !!onReorderFields && fields.length > 1}
              dragging={dragField === f.id}
              overSide={dragField && dragField !== f.id && overField?.id === f.id ? (overField.after ? 'r' : 'l') : null}
              onDragStartCol={(e) => {
                setDragField(f.id);
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', f.id); } catch { /* Safari */ }
              }}
              onDragOverCol={(e) => {
                if (!dragField || dragField === f.id) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const after = e.clientX - r.left > r.width / 2;
                setOverField((prev) => (prev?.id === f.id && prev.after === after ? prev : { id: f.id, after }));
              }}
              onDropCol={(e) => {
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                commitFieldDrop(f.id, e.clientX - r.left > r.width / 2);
              }}
              onDragEndCol={() => { setDragField(null); setOverField(null); }}
            />
          ))}
          <div style={headerCell}>
            {!readOnly && (
              <button
                onClick={() => setEditor({ field: null })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }}
              >
                <Plus size={14} /> {t('addField')}
              </button>
            )}
          </div>
        </div>

        {rows.map((row, ri) => {
          const isOver = dragRow && dragRow !== row.id && overRow?.id === row.id;
          const isSelected = selected.has(row.id);
          return (
          <div
            key={row.id}
            className="db-grid-row"
            style={{ display: 'grid', gridTemplateColumns: template, position: 'relative', opacity: dragRow === row.id ? 0.4 : 1, background: isSelected ? 'color-mix(in oklab, var(--accent) 10%, var(--bg))' : undefined }}
            onContextMenu={readOnly ? undefined : (e) => { e.preventDefault(); setCtx({ rowId: row.id, x: e.clientX, y: e.clientY }); }}
            onDragOver={dragRow ? (e) => {
              if (dragRow === row.id) return;
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientY - r.top > r.height / 2;
              setOverRow((prev) => (prev?.id === row.id && prev.after === after ? prev : { id: row.id, after }));
            } : undefined}
            onDrop={dragRow ? (e) => {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              commitRowDrop(row.id, e.clientY - r.top > r.height / 2);
            } : undefined}
          >
            <RowGutter
              n={ri + 1}
              style={bodyCell}
              selected={isSelected}
              anySelected={anySelected}
              readOnly={readOnly}
              onToggle={() => toggleRow(row.id)}
              draggable={rowsDraggable}
              onDragStartRow={(e) => {
                setDragRow(row.id);
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', row.id); } catch { /* Safari */ }
              }}
              onDragEndRow={() => { setDragRow(null); setOverRow(null); }}
            />
            {fields.map((f, ci) => (
              <div key={f.id} style={ci === 0 ? { ...bodyCell, position: 'sticky', left: GUTTER, zIndex: 1, background: 'inherit', boxShadow: '2px 0 5px -2px rgba(0,0,0,.35)' } : bodyCell}>
                <FieldCell field={f} value={row.data[f.id]} members={members} baseId={table.baseId} rowId={row.id} onCommit={(v) => onCellChange(row.id, f.id, v)} readOnly={readOnly} />
              </div>
            ))}
            <div style={{ ...bodyCell, justifyContent: 'flex-end', paddingRight: 6 }}>
              <button
                className="row-expand"
                onClick={() => setDetail({ id: row.id })}
                aria-label={t('openRecord')}
                title={t('openRecord')}
                style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', display: 'inline-flex', padding: 4, borderRadius: 6, transition: 'opacity .12s' }}
              >
                <Maximize2 size={14} />
              </button>
            </div>
            {isOver && (
              <div style={{ position: 'absolute', left: 0, right: 0, height: 2, background: 'var(--accent)', zIndex: 5, pointerEvents: 'none', ...(overRow!.after ? { bottom: -1 } : { top: -1 }) }} />
            )}
          </div>
          );
        })}
      </div>
        {rows.length === 0 && (
          <div style={{ padding: '34px 16px', textAlign: 'center' }}>
            <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text-2)' }}>{t('noRows')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{t('noRowsHint')}</div>
          </div>
        )}
      </div>

      {!readOnly && (
        <button
          onClick={() => onAddRow()}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '10px 14px', flexShrink: 0,
            border: 'none', borderTop: '1px solid var(--border)',
            background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', fontSize: 13,
          }}
        >
          <Plus size={15} /> {t('addRow')}
        </button>
      )}

      {anySelected && !readOnly && (
        <BulkBar
          count={selected.size}
          label={t('selectedCount', { count: selected.size })}
          onDuplicate={onDuplicateRows ? bulkDuplicate : undefined}
          onDelete={onBulkDelete ? bulkDelete : undefined}
          onClear={clearSelection}
          duplicateLabel={t('duplicate')}
          deleteLabel={t('delete')}
          clearLabel={t('clearSelection')}
        />
      )}

      {ctx && (
        <RowContextMenu
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onInsert={(position, count) => onInsertRow?.(ctx.rowId, position, count)}
          onDuplicate={() => onDuplicateRows?.(targetIds(ctx.rowId))}
          onCopyLink={() => onCopyRowLink?.(ctx.rowId)}
          onComment={() => setDetail({ id: ctx.rowId, focus: 'comments' })}
          onDelete={() => {
            const ids = targetIds(ctx.rowId);
            if (ids.length > 1 && onBulkDelete) { onBulkDelete(ids); clearSelection(); }
            else onDeleteRow(ctx.rowId);
          }}
        />
      )}

      <FieldEditor
        open={!!editor}
        initial={editor?.field ?? null}
        onClose={() => setEditor(null)}
        onSave={(d) => {
          if (editor?.field) onEditField(editor.field.id, d);
          else onAddField(d.name, d.type, d.options);
        }}
      />

      {detailRow && (
        <RecordModal
          table={table}
          row={detailRow}
          members={members}
          onCellChange={onCellChange}
          onClose={() => setDetail(null)}
          initialFocus={detail?.focus}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

function Checkbox({ checked, indeterminate, onToggle, ariaLabel }: { checked: boolean; indeterminate?: boolean; onToggle: () => void; ariaLabel: string }) {
  const on = checked || indeterminate;
  return (
    <button
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      style={{ width: 16, height: 16, padding: 0, flexShrink: 0, borderRadius: 4, border: `1.5px solid ${on ? 'var(--accent)' : 'var(--muted)'}`, background: on ? 'var(--accent)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
    >
      {checked ? <Check size={11} color="#fff" /> : indeterminate ? <Minus size={11} color="#fff" /> : null}
    </button>
  );
}

function RowGutter({
  n,
  style,
  selected,
  anySelected,
  readOnly,
  onToggle,
  draggable,
  onDragStartRow,
  onDragEndRow,
}: {
  n: number;
  style: CSSProperties;
  selected: boolean;
  anySelected: boolean;
  readOnly?: boolean;
  onToggle: () => void;
  draggable: boolean;
  onDragStartRow: (e: React.DragEvent) => void;
  onDragEndRow: () => void;
}) {
  const t = useTranslations('database');
  const [hover, setHover] = useState(false);
  const showControls = !readOnly && (hover || selected || anySelected);
  return (
    <div
      style={{ ...style, gap: 4, padding: '0 8px', color: 'var(--muted)', fontSize: 12, position: 'sticky', left: 0, zIndex: 1, background: 'inherit' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span
        draggable={draggable}
        onDragStart={draggable ? onDragStartRow : undefined}
        onDragEnd={draggable ? onDragEndRow : undefined}
        title={draggable ? t('dragRow') : undefined}
        aria-label={draggable ? t('dragRow') : undefined}
        style={{ width: 13, display: 'flex', flexShrink: 0, color: 'var(--muted)', cursor: draggable ? 'grab' : 'default', opacity: hover && draggable ? 1 : 0 }}
      >
        <GripVertical size={13} />
      </span>
      {showControls
        ? <Checkbox checked={selected} onToggle={onToggle} ariaLabel={t('selectRow')} />
        : <span className="mono" style={{ flex: 1, textAlign: 'center' }}>{n}</span>}
    </div>
  );
}

function BulkBar({ count, label, onDuplicate, onDelete, onClear, duplicateLabel, deleteLabel, clearLabel }: {
  count: number;
  label: string;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onClear: () => void;
  duplicateLabel: string;
  deleteLabel: string;
  clearLabel: string;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 2500, display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px 8px 14px', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 16px 48px var(--overlay)' }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginRight: 4 }}>{label}</span>
      {onDuplicate && (
        <button onClick={onDuplicate} className="btn btn-ghost" style={{ gap: 6, fontWeight: 600 }}>
          <CopyPlus size={15} /> {duplicateLabel}
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} className="btn btn-ghost" style={{ gap: 6, fontWeight: 600, color: 'var(--danger)' }}>
          <Trash2 size={15} /> {deleteLabel}
        </button>
      )}
      <button onClick={onClear} aria-label={clearLabel} title={clearLabel} className="btn btn-ghost btn-icon" style={{ width: 30, height: 30 }}>
        <X size={16} />
      </button>
    </div>,
    document.body,
  );
}

function FieldHeaderCell({
  field,
  isPrimary,
  style,
  onEdit,
  onDelete,
  onSetPrimary,
  width,
  onResize,
  onResizeEnd,
  frozen,
  leftOffset,
  readOnly,
  draggable,
  dragging,
  overSide,
  onDragStartCol,
  onDragOverCol,
  onDropCol,
  onDragEndCol,
}: {
  field: FieldT;
  isPrimary: boolean;
  style: CSSProperties;
  width: number;
  onEdit: () => void;
  onDelete: () => void;
  onSetPrimary: () => void;
  onResize: (w: number) => void;
  onResizeEnd: (w: number) => void;
  frozen?: boolean;
  leftOffset?: number;
  readOnly?: boolean;
  draggable: boolean;
  dragging: boolean;
  overSide: 'l' | 'r' | null;
  onDragStartCol: (e: React.DragEvent) => void;
  onDragOverCol: (e: React.DragEvent) => void;
  onDropCol: (e: React.DragEvent) => void;
  onDragEndCol: () => void;
}) {
  const t = useTranslations('database');
  const Icon = TYPE_ICONS[field.type] ?? Type;
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const clamp = (w: number) => Math.max(80, Math.min(800, w));
    const move = (ev: MouseEvent) => onResize(clamp(width + ev.clientX - startX));
    const up = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      onResizeEnd(clamp(width + ev.clientX - startX));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <div
      onDragOver={draggable ? onDragOverCol : undefined}
      onDrop={draggable ? onDropCol : undefined}
      style={{ ...style, justifyContent: 'space-between', gap: 6, position: frozen ? 'sticky' : 'relative', left: frozen ? leftOffset : undefined, zIndex: frozen ? 3 : undefined, boxShadow: frozen ? '2px 0 5px -2px rgba(0,0,0,.35)' : undefined }}
    >
      <span
        draggable={draggable}
        onDragStart={draggable ? onDragStartCol : undefined}
        onDragEnd={draggable ? onDragEndCol : undefined}
        title={draggable ? t('dragColumn') : undefined}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, overflow: 'hidden', flex: 1, minWidth: 0, cursor: draggable ? 'grab' : 'default', opacity: dragging ? 0.4 : 1 }}
      >
        {isPrimary ? <Star size={13} style={{ color: 'var(--amber, var(--warn))', flexShrink: 0 }} /> : <Icon size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />}
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{field.name}</span>
      </span>
      {!readOnly && (
        <button
          ref={ref}
          aria-label={t('menu')}
          onClick={(e) => {
            e.stopPropagation();
            const r = ref.current!.getBoundingClientRect();
            setPos({ left: r.right - 188, top: r.bottom });
            setMenu((m) => !m);
          }}
          style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', display: 'flex', flexShrink: 0 }}
        >
          <MoreHorizontal size={15} />
        </button>
      )}
      {menu && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            onMouseDown={(e) => e.stopPropagation()}
            style={{ position: 'fixed', left: Math.max(pos.left, 8), top: pos.top + 4, width: 188, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 12px 40px var(--overlay)', padding: 4, zIndex: 2000 }}
          >
            <MenuItem icon={<Pencil size={14} />} label={t('editField')} onClick={() => { onEdit(); setMenu(false); }} />
            {!isPrimary && <MenuItem icon={<Star size={14} />} label={t('setPrimary')} onClick={() => { onSetPrimary(); setMenu(false); }} />}
            {!isPrimary && <MenuItem icon={<Trash2 size={14} />} label={t('deleteField')} danger onClick={() => { onDelete(); setMenu(false); }} />}
          </div>,
          document.body,
        )}
      {overSide && (
        <div style={{ position: 'absolute', top: 0, bottom: 0, width: 2, background: 'var(--accent)', zIndex: 6, pointerEvents: 'none', ...(overSide === 'r' ? { right: -1 } : { left: -1 }) }} />
      )}
      {!readOnly && (
        <div
          className="col-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resizeColumn')}
          onMouseDown={startResize}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'absolute', top: 0, right: -4, width: 8, height: '100%', cursor: 'col-resize', zIndex: 3 }}
        />
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 7, background: 'transparent', color: danger ? 'var(--danger)' : 'var(--text)', cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon} {label}
    </button>
  );
}
