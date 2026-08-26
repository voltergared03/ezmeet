'use client';

import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, Check, Search } from 'lucide-react';
import { filterOptions, nextIndex, isNavKey, type ListOption } from '@/lib/listbox';

/**
 * A select you can type into.
 *
 * For the long lists — timezones, ClickUp lists, departments, people. A plain
 * dropdown of 200 timezones is only usable by someone who already knows where their
 * entry sits alphabetically; everyone else scrolls and gives up. Typing filters,
 * scrolling still browses, so neither habit is punished.
 *
 * Keyboard is a first-class path, not an afterthought: the list opens on typing,
 * arrows move, Enter commits, Escape reverts. Navigation logic lives in lib/listbox
 * where it is actually tested.
 */
export function Combobox({
  value, onChange, options, placeholder, disabled, emptyText, style, className, id,
  'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ListOption[];
  placeholder?: string;
  disabled?: boolean;
  emptyText?: string;
  style?: React.CSSProperties;
  className?: string;
  id?: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
}) {
  const t = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; openUp: boolean } | null>(null);

  const selected = options.find((o) => o.value === value) || null;
  const shown = useMemo(() => filterOptions(options, query), [options, query]);

  // Closed: display the selection. Open: display what is being typed. Without this
  // the field would either blank out on open (losing context of the current value)
  // or refuse to be typed into.
  const text = open ? query : selected?.label ?? '';

  function place() {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const estH = Math.min(shown.length * 36 + 12, 300);
    const openUp = window.innerHeight - r.bottom < estH + 8 && r.top > estH;
    setPos({ left: r.left, top: openUp ? r.top : r.bottom, width: r.width, openUp });
  }

  function openList() {
    if (disabled || open) return;
    place();
    setQuery('');
    setActive(options.findIndex((o) => o.value === value));
    setOpen(true);
  }

  function close(commit?: string) {
    setOpen(false);
    setQuery('');
    setActive(-1);
    if (commit !== undefined) onChange(commit);
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const n = e.target as Node;
      if (!wrapRef.current?.contains(n) && !panelRef.current?.contains(n)) close();
    };
    // Ignore scrolling INSIDE the panel — the option list has its own overflow and
    // would otherwise close itself the moment the user scrolled it.
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shown.length]);

  // Keep the active row in view while arrowing through a list taller than the panel.
  useEffect(() => {
    if (!open || active < 0) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open && (isNavKey(e.key) || e.key === 'Enter')) { e.preventDefault(); openList(); return; }
    if (!open) return;
    if (isNavKey(e.key)) {
      e.preventDefault();
      setActive((i) => nextIndex(shown, i, e.key as 'ArrowDown'));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = shown[active];
      if (pick && !pick.disabled) close(pick.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(); // revert — the previous value stands
    } else if (e.key === 'Tab') {
      close();
    }
  }

  return (
    <>
      <div ref={wrapRef} style={{ position: 'relative' }}>
        <input
          ref={inputRef}
          id={id}
          className={`field ${className || ''}`}
          style={{ paddingInlineEnd: 32, cursor: disabled ? 'default' : 'text', ...style }}
          value={text}
          placeholder={placeholder ?? t('select')}
          disabled={disabled}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          onChange={(e) => { if (!open) openList(); setQuery(e.target.value); setActive(0); }}
          onFocus={openList}
          onKeyDown={onKeyDown}
        />
        <span
          aria-hidden
          style={{
            position: 'absolute', insetInlineEnd: 10, top: '50%', transform: 'translateY(-50%)',
            display: 'inline-flex', color: 'var(--muted)', pointerEvents: 'none',
          }}
        >
          {open ? <Search size={14} /> : <ChevronDown size={15} />}
        </span>
      </div>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{
            position: 'fixed', left: pos.left, width: Math.max(pos.width, 180),
            ...(pos.openUp ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }),
            background: 'var(--surface)', border: '1px solid var(--border)',
            borderRadius: 10, boxShadow: 'var(--shadow-lg)', padding: 4,
            zIndex: 2000, maxHeight: 300, overflowY: 'auto', animation: 'fadeIn .12s ease',
          }}
        >
          {shown.length === 0 && (
            <div style={{ padding: '10px 12px', fontSize: 13, color: 'var(--muted)' }}>
              {emptyText ?? t('noResults')}
            </div>
          )}
          {shown.map((o, i) => {
            const sel = o.value === value;
            const act = i === active;
            return (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={sel}
                data-i={i}
                disabled={o.disabled}
                // mousedown, not click: the input's blur would otherwise close the
                // panel before the click ever lands.
                onMouseDown={(e) => { e.preventDefault(); if (!o.disabled) close(o.value); }}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  width: '100%', padding: '8px 10px', minHeight: 36,
                  border: 'none', borderRadius: 7, textAlign: 'left', fontSize: 13,
                  background: act ? 'var(--hover-2)' : sel ? 'var(--accent-soft-2)' : 'transparent',
                  color: o.disabled ? 'var(--muted-2)' : sel ? 'var(--text)' : 'var(--text-2)',
                  cursor: o.disabled ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                {sel && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} aria-hidden />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
