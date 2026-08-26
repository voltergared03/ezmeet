'use client';

import { useTranslations } from 'next-intl';
import { Star, Type } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { FieldCell } from './FieldCell';
import { RecordComments } from './RecordComments';
import { TYPE_ICONS } from './field-icons';
import type { TableT, RowT, OrgMember } from '../lib/types';

/** Expanded single-record view — every field stacked with its editor (the same
 *  FieldCell as the grid, so edits persist through the same onCellChange path).
 *  Shared by GridView, KanbanView and CalendarView. */
export function RecordModal({ table, row, members, onCellChange, onClose, initialFocus, readOnly = false }: {
  table: TableT;
  row: RowT;
  members: OrgMember[];
  onCellChange: (rowId: string, fieldId: string, value: unknown) => void;
  onClose: () => void;
  initialFocus?: 'comments';
  /** Viewer mode: fields are read-only (reads like totp/password/file still work). */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const fields = [...table.fields].sort((a, b) => a.position - b.position);
  const primary = fields.find((f) => f.id === table.primaryFieldId);
  const titleVal = primary && typeof row.data[primary.id] === 'string' ? (row.data[primary.id] as string) : '';

  return (
    <Modal open onClose={onClose} title={titleVal || t('untitled')} width={560}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '64vh', overflowY: 'auto', paddingRight: 4 }}>
        {fields.length === 0 && <div style={{ color: 'var(--muted)', fontSize: 13 }}>—</div>}
        {fields.map((f) => {
          const Icon = TYPE_ICONS[f.type] ?? Type;
          const isPrimary = f.id === table.primaryFieldId;
          return (
            <div key={f.id}>
              <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isPrimary ? <Star size={12} style={{ color: 'var(--amber, var(--warn))' }} /> : <Icon size={12} style={{ opacity: 0.6 }} />}
                {f.name}
              </label>
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, minHeight: 40, display: 'flex', alignItems: 'center', background: 'var(--bg)', overflow: 'hidden' }}>
                <FieldCell
                  field={f}
                  value={row.data[f.id]}
                  members={members}
                  baseId={table.baseId}
                  rowId={row.id}
                  onCommit={(v) => onCellChange(row.id, f.id, v)}
                  readOnly={readOnly}
                />
              </div>
            </div>
          );
        })}
        <RecordComments rowId={row.id} autoFocus={initialFocus === 'comments'} />
      </div>
    </Modal>
  );
}
