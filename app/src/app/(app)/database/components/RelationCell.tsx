'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Link as LinkIcon, Plus, Check, Search } from 'lucide-react';
import type { FieldT, LinkRef } from '../lib/types';

type Item = { id: string; label: string };

/** Accept either the server-enriched `[{id,label}]` or a raw `[id]` (just-set, pre-refresh). */
const asItems = (value: unknown): Item[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((v): Item | null => {
      if (typeof v === 'string') return { id: v, label: '' };
      if (v && typeof v === 'object' && typeof (v as LinkRef).id === 'string') return { id: (v as LinkRef).id, label: (v as LinkRef).label ?? '' };
      return null;
    })
    .filter((x): x is Item => x !== null);
};

/** Client-side label for a target row's display-field value (mirrors lib/base-links). */
function cellLabel(value: unknown, field: { type?: string; options?: { choices?: { id: string; name: string }[] } } | null): string {
  if (value == null || value === '') return '';
  const choices = field?.options?.choices ?? [];
  if (typeof value === 'string') {
    if (field?.type === 'singleSelect') return choices.find((c) => c.id === value)?.name ?? '';
    if (field?.type === 'date') { const d = new Date(value); return isNaN(d.getTime()) ? value : d.toISOString().slice(0, 10); }
    return value;
  }
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '✓' : '';
  if (Array.isArray(value)) {
    if (field?.type === 'multiSelect') return value.map((id) => choices.find((c) => c.id === id)?.name).filter(Boolean).join(', ');
    return value.filter((v) => typeof v === 'string').join(', ');
  }
  return '';
}

/** A `link` (relation) cell: chips of linked records + a picker over the target table. */
export function RelationCell({ value, field, onCommit, readOnly = false }: { value: unknown; field: FieldT; onCommit: (value: unknown) => void; readOnly?: boolean }) {
  const t = useTranslations('database');
  const targetTableId = field.options?.targetTableId || '';
  const multiple = !!field.options?.multiple;
  const displayFieldId = field.options?.displayFieldId || '';

  const items = asItems(value);
  const selectedIds = items.map((i) => i.id);

  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number; width: number; openUp: boolean; maxH: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const [options, setOptions] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState('');
  const labelCache = useRef<Map<string, string>>(new Map());

  async function load() {
    if (loaded || !targetTableId) return;
    try {
      const [tRes, rRes] = await Promise.all([fetch(`/api/tables/${targetTableId}`), fetch(`/api/tables/${targetTableId}/rows`)]);
      const tbl = tRes.ok ? await tRes.json() : null;
      const rowsData = rRes.ok ? await rRes.json() : { rows: [] };
      const dfId = displayFieldId || tbl?.primaryFieldId || tbl?.fields?.[0]?.id || '';
      const df = (tbl?.fields ?? []).find((f: { id: string }) => f.id === dfId) ?? null;
      const opts: Item[] = (rowsData.rows ?? []).map((row: { id: string; data: Record<string, unknown> }) => {
        const label = cellLabel(row.data?.[dfId], df) || t('untitled');
        labelCache.current.set(row.id, label);
        return { id: row.id, label };
      });
      setOptions(opts);
      setLoaded(true);
    } catch {
      setLoaded(true);
    }
  }

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const margin = 8;
      const panelW = Math.max(r.width, 240);
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      const openUp = spaceBelow < 220 && spaceAbove > spaceBelow;
      const maxH = Math.max(160, Math.min(340, openUp ? spaceAbove : spaceBelow));
      const left = Math.max(margin, Math.min(r.left, window.innerWidth - panelW - margin));
      setPos({ left, top: r.bottom, bottom: r.top, width: r.width, openUp, maxH });
      load();
    }
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tg = e.target as Node;
      if (btnRef.current && !btnRef.current.contains(tg) && panelRef.current && !panelRef.current.contains(tg)) setOpen(false);
    };
    const onScroll = (e: Event) => { if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return; setOpen(false); };
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

  const pick = (id: string) => {
    if (multiple) {
      const next = selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
      onCommit(next.length ? next : null);
    } else {
      onCommit(selectedIds[0] === id ? null : [id]);
      setOpen(false);
    }
  };

  const labelFor = (it: Item) => it.label || labelCache.current.get(it.id) || '…';
  const filtered = q.trim() ? options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase())) : options;

  return (
    <>
      <button ref={btnRef} type="button" onClick={readOnly ? undefined : toggle} disabled={readOnly} style={{ ...cellBtn, cursor: readOnly ? 'default' : 'pointer' }}>
        {items.length === 0 ? (
          <span style={{ color: 'var(--muted-2, var(--muted))', display: 'inline-flex' }}>{readOnly ? <span style={{ fontSize: 13 }}>—</span> : <Plus size={14} />}</span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, overflow: 'hidden' }}>
            {items.map((it) => (
              <span key={it.id} style={chip}>
                <LinkIcon size={10} style={{ opacity: 0.55, flexShrink: 0 }} />
                <span style={chipName}>{labelFor(it)}</span>
              </span>
            ))}
          </span>
        )}
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed', left: pos.left, width: Math.max(pos.width, 240),
              ...(pos.openUp ? { bottom: window.innerHeight - pos.bottom + 4 } : { top: pos.top + 4 }),
              background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
              boxShadow: '0 12px 40px var(--overlay)', zIndex: 2000, maxHeight: pos.maxH, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid var(--border)' }}>
              <Search size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('linkSearch')}
                style={{ flex: 1, border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none' }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: 4 }}>
              {!loaded && <div style={{ padding: 10, color: 'var(--muted)', fontSize: 12 }}>…</div>}
              {loaded && filtered.length === 0 && <div style={{ padding: 10, color: 'var(--muted)', fontSize: 12 }}>{t('linkNoRecords')}</div>}
              {filtered.map((o) => {
                const sel = selectedIds.includes(o.id);
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => pick(o.id)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '7px 9px', border: 'none', borderRadius: 7,
                      background: sel ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent', color: 'var(--text)', cursor: 'pointer', textAlign: 'left', fontSize: 13,
                    }}
                    onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-2)'; }}
                    onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
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

const cellBtn: CSSProperties = {
  width: '100%', height: '100%', border: 'none', background: 'transparent', display: 'flex', alignItems: 'center',
  gap: 5, padding: '0 8px', cursor: 'pointer', color: 'var(--text)', overflow: 'hidden', minWidth: 0,
};
const chip: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-2)', borderRadius: 999, padding: '2px 9px', maxWidth: 160, flexShrink: 0,
};
const chipName: CSSProperties = { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
