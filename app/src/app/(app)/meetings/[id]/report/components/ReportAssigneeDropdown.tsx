'use client';

import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, Check } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import type { AssignOption } from '../lib/types';

type ItemAssignee = { id: string | null; name: string; image: string | null; registered: boolean };

/* ─── AssigneeDropdown (report) — multi-assignee toggle ─────────── */

export function ReportAssigneeDropdown({
  item,
  options,
  onToggle,
}: {
  item: { id: string; assignee: string; assigneeImage?: string | null; assigneeRegistered?: boolean; assignees?: ItemAssignee[] };
  options: AssignOption[];
  // isSelected reflects the current membership so the parent knows add vs remove.
  onToggle: (itemId: string, opt: AssignOption, isSelected: boolean) => void;
}) {
  const tr = useTranslations();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; bottom: number; openUp: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && panelRef.current && !panelRef.current.contains(t)) setOpen(false);
    };
    // Capture-phase scroll fires for ANY scroll in the document, including scrolling
    // the list INSIDE the panel — which used to close the dropdown mid-scroll. Only
    // close when the scroll happens OUTSIDE the panel (the page moved under a fixed
    // portal, so it would otherwise detach from the button).
    const onScroll = (e: Event) => {
      const t = e.target as Node;
      if (panelRef.current && panelRef.current.contains(t)) return; // scrolling the list itself — keep open
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', handler);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Full set (виконавці); fall back to the single lead for old/legacy items.
  const assignees: ItemAssignee[] = item.assignees && item.assignees.length
    ? item.assignees
    : (item.assignee ? [{ id: null, name: item.assignee, image: item.assigneeImage || null, registered: !!item.assigneeRegistered }] : []);
  const isOptSelected = (o: AssignOption) =>
    o.id ? assignees.some((a) => a.id === o.id) : assignees.some((a) => a.id == null && a.name === o.name);
  const leadGuest = assignees.length > 0 && !assignees[0].registered;

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          if (!open && btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            const openUp = window.innerHeight - r.bottom < 290;
            setPos({ left: r.left, top: r.bottom, bottom: window.innerHeight - r.top, openUp });
          }
          setOpen(!open);
        }}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '2px 6px',
          borderRadius: 6,
          transition: 'background 0.15s',
          fontSize: 11.5,
          color: 'var(--text-2)',
        }}
        onMouseEnter={(e: any) => (e.currentTarget.style.background = 'var(--surface-2)')}
        onMouseLeave={(e: any) => (e.currentTarget.style.background = 'transparent')}
      >
        {assignees.length > 0 ? (
          <span style={{ display: 'inline-flex', alignItems: 'center' }}>
            {assignees.slice(0, 3).map((a, i) => (
              <span key={(a.id || a.name) + i} style={{ marginLeft: i === 0 ? 0 : -6, border: '1.5px solid var(--surface)', borderRadius: '50%', display: 'inline-flex' }}>
                <Avatar name={a.name || 'U'} image={a.image || null} size="sm" />
              </span>
            ))}
          </span>
        ) : (
          <Avatar name="U" image={null} size="sm" />
        )}
        <span>
          {assignees.length === 0
            ? tr('report.unassigned')
            : (assignees[0].name + (assignees.length > 1 ? ` +${assignees.length - 1}` : ''))}
        </span>
        {leadGuest && (
          <span
            style={{
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '.04em',
              color: 'var(--amber)',
              background: 'color-mix(in oklab, var(--amber) 16%, transparent)',
              border: '1px solid color-mix(in oklab, var(--amber) 30%, transparent)',
              borderRadius: 5,
              padding: '1px 5px',
              whiteSpace: 'nowrap',
            }}
          >
            {tr('report.notRegistered')}
          </span>
        )}
        <ChevronDown size={10} style={{ opacity: 0.5 }} />
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            left: pos?.left ?? 0,
            ...(pos?.openUp
              ? { bottom: (pos?.bottom ?? 0) + 4 }
              : { top: (pos?.top ?? 0) + 4 }),
            zIndex: 1000,
            minWidth: 220,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
            padding: 4,
            maxHeight: 260,
            overflowY: 'auto',
          }}
        >
          {options.map((o) => {
            const selected = isOptSelected(o);
            return (
            <button
              key={o.id || `g-${o.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(item.id, o, selected);
                // Guests replace the whole set, so close; registered users keep
                // the panel open for picking several.
                if (!o.id) setOpen(false);
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '8px 10px',
                background: selected ? 'var(--surface-2)' : 'transparent',
                border: 'none',
                borderRadius: 7,
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--text)',
                transition: 'background 0.12s',
              }}
              onMouseEnter={(e: any) => (e.currentTarget.style.background = 'var(--surface-2)')}
              onMouseLeave={(e: any) => (e.currentTarget.style.background = selected ? 'var(--surface-2)' : 'transparent')}
            >
              <Avatar name={o.name} image={o.image || null} size="sm" />
              <div style={{ flex: 1, textAlign: 'left', minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.name}</div>
                <div style={{ fontSize: 10.5, color: o.guest ? 'var(--amber)' : 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {o.guest ? tr('report.notRegistered') : o.email}
                </div>
              </div>
              {selected && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
            </button>
            );
          })}
          {options.length === 0 && (
            <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>
              {tr('report.noUsers')}
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
