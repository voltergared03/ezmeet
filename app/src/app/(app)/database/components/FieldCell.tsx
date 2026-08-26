'use client';

import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ExternalLink, Mail, Phone, Star, Search } from 'lucide-react';
import type { FieldT, OrgMember, SelectChoice } from '../lib/types';
import { PersonPicker } from './PersonPicker';
import { FileCell } from './FileCell';
import { TotpCell } from './TotpCell';
import { PasswordCell } from './PasswordCell';
import { RelationCell } from './RelationCell';

const cellInput: CSSProperties = {
  width: '100%', height: '100%', border: 'none', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 13, padding: '0 10px', outline: 'none',
};

const isoToDateInput = (v: unknown): string => {
  if (typeof v !== 'string' || !v) return '';
  const d = new Date(v);
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};

const enterBlur = (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
};

/** One editable cell, rendered per field type. `onCommit(value)` persists; an
 *  empty value clears the cell (server drops the key). */
export function FieldCell({
  field,
  value,
  members,
  baseId,
  rowId,
  onCommit,
  readOnly = false,
}: {
  field: FieldT;
  value: unknown;
  members: OrgMember[];
  baseId?: string;
  rowId?: string;
  onCommit: (value: unknown) => void;
  /** Viewer mode: render the value but block ALL edits (reads like totp code /
   *  password reveal / file open stay available in the sub-components). */
  readOnly?: boolean;
}) {
  switch (field.type) {
    case 'text':
    case 'longText':
      return (
        <input
          style={cellInput}
          readOnly={readOnly}
          defaultValue={typeof value === 'string' ? value : ''}
          key={String(value ?? '')}
          onBlur={readOnly ? undefined : (e) => { if (e.target.value !== (value ?? '')) onCommit(e.target.value); }}
          onKeyDown={enterBlur}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          style={cellInput}
          readOnly={readOnly}
          defaultValue={typeof value === 'number' ? String(value) : ''}
          key={String(value ?? '')}
          onBlur={readOnly ? undefined : (e) => {
            const v = e.target.value === '' ? '' : Number(e.target.value);
            if (v !== (value ?? '')) onCommit(v === '' ? '' : v);
          }}
          onKeyDown={enterBlur}
        />
      );
    case 'checkbox':
      return (
        <button
          type="button"
          onClick={readOnly ? undefined : () => onCommit(!value)}
          disabled={readOnly}
          style={{ width: '100%', height: '100%', border: 'none', background: 'transparent', cursor: readOnly ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          aria-pressed={!!value}
        >
          <span
            style={{
              width: 18, height: 18, borderRadius: 5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              border: `1.5px solid ${value ? 'var(--accent)' : 'var(--border-2, var(--border))'}`,
              background: value ? 'var(--accent)' : 'transparent',
            }}
          >
            {value ? <Check size={13} style={{ color: 'var(--on-accent)' }} /> : null}
          </span>
        </button>
      );
    case 'date':
      return (
        <input
          type="date"
          style={cellInput}
          readOnly={readOnly}
          defaultValue={isoToDateInput(value)}
          key={isoToDateInput(value)}
          onChange={readOnly ? undefined : (e) => onCommit(e.target.value || '')}
        />
      );
    case 'singleSelect':
    case 'multiSelect':
      return (
        <ChoiceCell
          choices={field.options?.choices ?? []}
          value={value}
          multiple={field.type === 'multiSelect'}
          onCommit={onCommit}
          readOnly={readOnly}
        />
      );
    case 'person':
      return (
        <PersonPicker
          members={members}
          value={value}
          multiple={!!field.options?.multiple}
          onCommit={onCommit}
          readOnly={readOnly}
        />
      );
    case 'currency':
      return <AdornedNumberCell value={value} prefix={field.options?.symbol || '₴'} onCommit={onCommit} readOnly={readOnly} />;
    case 'percent':
      return <AdornedNumberCell value={value} suffix="%" onCommit={onCommit} readOnly={readOnly} />;
    case 'rating':
      return <RatingCell value={value} max={field.options?.max ?? 5} onCommit={onCommit} readOnly={readOnly} />;
    case 'url':
    case 'email':
    case 'phone':
      return <LinkCell kind={field.type} value={value} onCommit={onCommit} readOnly={readOnly} />;
    case 'file':
      return <FileCell value={value} baseId={baseId} rowId={rowId} fieldId={field.id} onCommit={onCommit} readOnly={readOnly} />;
    case 'totp':
      return <TotpCell value={value} rowId={rowId} fieldId={field.id} onCommit={onCommit} readOnly={readOnly} />;
    case 'password':
      return <PasswordCell value={value} rowId={rowId} fieldId={field.id} onCommit={onCommit} readOnly={readOnly} />;
    case 'link':
      return <RelationCell value={value} field={field} onCommit={onCommit} readOnly={readOnly} />;
    default:
      return null;
  }
}

/** Number cell with a non-editable currency symbol prefix or "%" suffix. */
function AdornedNumberCell({
  value,
  prefix,
  suffix,
  onCommit,
  readOnly = false,
}: {
  value: unknown;
  prefix?: string;
  suffix?: string;
  onCommit: (value: unknown) => void;
  readOnly?: boolean;
}) {
  const has = typeof value === 'number';
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%' }}>
      {prefix && has && <span style={{ paddingLeft: 10, color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>{prefix}</span>}
      <input
        type="number"
        style={{ ...cellInput, paddingLeft: prefix && has ? 4 : 10 }}
        readOnly={readOnly}
        defaultValue={has ? String(value) : ''}
        key={String(value ?? '')}
        onBlur={readOnly ? undefined : (e) => {
          const v = e.target.value === '' ? '' : Number(e.target.value);
          if (v !== (value ?? '')) onCommit(v === '' ? '' : v);
        }}
        onKeyDown={enterBlur}
      />
      {suffix && has && <span style={{ paddingRight: 10, color: 'var(--muted)', fontSize: 13, flexShrink: 0 }}>{suffix}</span>}
    </div>
  );
}

/** Star rating, 1..max. Click the current value to step it down (0 clears). */
function RatingCell({ value, max, onCommit, readOnly = false }: { value: unknown; max: number; onCommit: (value: unknown) => void; readOnly?: boolean }) {
  const cur = typeof value === 'number' ? value : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1, padding: '0 8px', height: '100%', overflow: 'hidden' }}>
      {Array.from({ length: Math.min(Math.max(max, 1), 10) }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          onClick={readOnly ? undefined : () => onCommit(cur === n ? n - 1 : n)}
          disabled={readOnly}
          aria-label={`${n}`}
          style={{
            border: 'none', background: 'transparent', cursor: readOnly ? 'default' : 'pointer', padding: 0, display: 'inline-flex',
            color: n <= cur ? 'var(--amber, var(--warn))' : 'var(--border-2, var(--border))',
          }}
        >
          <Star size={15} fill={n <= cur ? 'currentColor' : 'none'} />
        </button>
      ))}
    </div>
  );
}

/** URL / email / phone: editable inline, with a trailing icon that opens the link. */
function LinkCell({ kind, value, onCommit, readOnly = false }: { kind: 'url' | 'email' | 'phone'; value: unknown; onCommit: (value: unknown) => void; readOnly?: boolean }) {
  const v = typeof value === 'string' ? value : '';
  const href = !v
    ? ''
    : kind === 'email'
      ? `mailto:${v}`
      : kind === 'phone'
        ? `tel:${v.replace(/[^\d+]/g, '')}`
        : /^https?:\/\//i.test(v) ? v : `https://${v}`;
  const Icon = kind === 'email' ? Mail : kind === 'phone' ? Phone : ExternalLink;
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%', height: '100%' }}>
      <input
        style={cellInput}
        readOnly={readOnly}
        defaultValue={v}
        key={v}
        onBlur={readOnly ? undefined : (e) => { if (e.target.value !== v) onCommit(e.target.value); }}
        onKeyDown={enterBlur}
      />
      {v && (
        <a
          href={href}
          target={kind === 'url' ? '_blank' : undefined}
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={v}
          style={{ flexShrink: 0, display: 'inline-flex', padding: '0 9px', color: 'var(--accent)' }}
        >
          <Icon size={13} />
        </a>
      )}
    </div>
  );
}

function Chip({ choice }: { choice: SelectChoice }) {
  const c = choice.color || 'var(--surface-3)';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, padding: '2px 9px', fontSize: 12,
        background: `color-mix(in oklab, ${c} 18%, transparent)`,
        color: 'var(--text)', border: `1px solid color-mix(in oklab, ${c} 38%, transparent)`,
        maxWidth: 150,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c, flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{choice.name}</span>
    </span>
  );
}

function ChoiceCell({
  choices,
  value,
  multiple,
  onCommit,
  readOnly = false,
}: {
  choices: SelectChoice[];
  value: unknown;
  multiple: boolean;
  onCommit: (v: string | string[] | null) => void;
  readOnly?: boolean;
}) {
  const ids = Array.isArray(value)
    ? (value.filter((v) => typeof v === 'string') as string[])
    : typeof value === 'string' && value
      ? [value]
      : [];
  const t = useTranslations('database');
  const byId = new Map(choices.map((c) => [c.id, c]));
  const selected = ids.map((id) => byId.get(id)).filter(Boolean) as SelectChoice[];

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = q.trim() ? choices.filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase())) : choices;
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number; width: number; openUp: boolean; maxH: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current && !btnRef.current.contains(target) && panelRef.current && !panelRef.current.contains(target)) setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      setQ('');
      const r = btnRef.current.getBoundingClientRect();
      const margin = 8;
      const panelW = Math.max(r.width, 180);
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      // Flip above the cell when it would overflow the viewport bottom; cap height.
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const maxH = Math.max(160, Math.min(280, openUp ? spaceAbove : spaceBelow));
      const left = Math.max(margin, Math.min(r.left, window.innerWidth - panelW - margin));
      setPos({ left, top: r.bottom, bottom: r.top, width: r.width, openUp, maxH });
    }
    setOpen((o) => !o);
  };

  const pick = (id: string) => {
    if (multiple) {
      const next = ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
      onCommit(next.length ? next : null);
    } else {
      onCommit(ids[0] === id ? null : id);
      setOpen(false);
    }
  };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={readOnly ? undefined : toggle}
        disabled={readOnly}
        style={{ width: '100%', height: '100%', border: 'none', background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4, padding: '0 8px', cursor: readOnly ? 'default' : 'pointer', overflow: 'hidden' }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden', flexWrap: 'nowrap' }}>
          {selected.map((c) => <Chip key={c.id} choice={c} />)}
        </span>
        {!readOnly && <ChevronDown size={13} style={{ color: 'var(--muted)', flexShrink: 0, opacity: 0.6 }} />}
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed', left: pos.left, width: Math.max(pos.width, 180),
              ...(pos.openUp ? { bottom: window.innerHeight - pos.bottom + 4 } : { top: pos.top + 4 }),
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 12px 40px var(--overlay)', zIndex: 2000, maxHeight: pos.maxH,
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
              <Search size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('search')}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none' }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: 4 }}>
            {filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)', fontSize: 12 }}>—</div>}
            {filtered.map((c) => {
              const sel = ids.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c.id)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', border: 'none', borderRadius: 7, background: sel ? 'var(--surface-2)' : 'transparent', cursor: 'pointer' }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                >
                  <span style={{ flex: 1, display: 'flex' }}><Chip choice={c} /></span>
                  {sel && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                </button>
              );
            })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
