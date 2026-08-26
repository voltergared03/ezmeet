'use client';

import { useState, useRef, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Check, UserPlus, Search } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import type { OrgMember } from '../lib/types';

const asIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? (value.filter((v) => typeof v === 'string') as string[])
    : typeof value === 'string' && value
      ? [value]
      : [];

/** A cell-friendly person selector. Shows selected avatars; click opens a
 *  portal dropdown of org members to toggle. Single or multiple per `multiple`. */
export function PersonPicker({
  members,
  value,
  multiple,
  onCommit,
  readOnly = false,
}: {
  members: OrgMember[];
  value: unknown;
  multiple?: boolean;
  onCommit: (v: string | string[] | null) => void;
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const ids = asIds(value);
  const byId = new Map(members.map((m) => [m.id, m]));
  const selected = ids.map((id) => byId.get(id)).filter(Boolean) as OrgMember[];

  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const filtered = q.trim()
    ? members.filter((m) => `${m.name ?? ''} ${m.email ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))
    : members;
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number; width: number; openUp: boolean; maxH: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current && !btnRef.current.contains(target) && panelRef.current && !panelRef.current.contains(target)) {
        setOpen(false);
      }
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
      const panelW = Math.max(r.width, 200);
      const spaceBelow = window.innerHeight - r.bottom - margin;
      const spaceAbove = r.top - margin;
      // Flip the menu above the cell when it would overflow the bottom of the
      // viewport and there's more room above; cap its height to the space we have.
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

  const cellBtn: CSSProperties = {
    width: '100%', height: '100%', border: 'none', background: 'transparent',
    display: 'flex', alignItems: 'center', gap: 5, padding: '0 8px', cursor: 'pointer',
    color: 'var(--text)', overflow: 'hidden', minWidth: 0,
  };

  return (
    <>
      <button type="button" ref={btnRef} onClick={readOnly ? undefined : toggle} disabled={readOnly} style={{ ...cellBtn, cursor: readOnly ? 'default' : 'pointer' }}>
        {selected.length === 0 ? (
          <span style={{ color: 'var(--muted-2, var(--muted))', display: 'inline-flex' }}>
            {readOnly ? <span style={{ fontSize: 13 }}>—</span> : <UserPlus size={14} />}
          </span>
        ) : (
          selected.map((m) => (
            <span key={m.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface-2)', borderRadius: 999, padding: '2px 8px 2px 2px', maxWidth: 140 }}>
              <Avatar name={m.name || m.email || '?'} image={m.image} size="sm" />
              <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.name || m.email}
              </span>
            </span>
          ))
        )}
      </button>

      {open && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: 'fixed', left: pos.left, width: Math.max(pos.width, 200),
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
            {filtered.length === 0 && (
              <div style={{ padding: 10, color: 'var(--muted)', fontSize: 12 }}>—</div>
            )}
            {filtered.map((m) => {
              const sel = ids.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => pick(m.id)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px',
                    border: 'none', borderRadius: 7, background: sel ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent',
                    color: 'var(--text)', cursor: 'pointer', textAlign: 'left',
                  }}
                  onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-2)'; }}
                  onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
                >
                  <Avatar name={m.name || m.email || '?'} image={m.image} size="sm" />
                  <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {m.name || m.email}
                  </span>
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
