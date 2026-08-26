'use client';

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ChevronDown, Check } from 'lucide-react';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Themed custom <select> replacement. Native selects can't be styled when open
 * on macOS — this renders a styled dropdown via portal (escapes overflow/clipping),
 * with click-outside + scroll close and flip-up when low on space.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  style,
  className,
  icon,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  style?: React.CSSProperties;
  className?: string;
  icon?: React.ReactNode;
}) {
  const t = useTranslations('common');
  const ph = placeholder ?? t('select');
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; openUp: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current && !btnRef.current.contains(t) && panelRef.current && !panelRef.current.contains(t)) {
        setOpen(false);
      }
    };
    // Close on OUTSIDE scroll only — ignore scrolling inside the panel itself
    // (the options list has its own overflow), otherwise it vanishes mid-scroll.
    const onScroll = (e: Event) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      setOpen(false);
    };
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const selected = options.find((o) => o.value === value);

  const toggle = () => {
    if (disabled) return;
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const estH = Math.min(options.length * 38 + 8, 280);
      const openUp = window.innerHeight - r.bottom < estH + 8 && r.top > estH;
      setPos({ left: r.left, top: openUp ? r.top : r.bottom, width: r.width, openUp });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        onClick={toggle}
        disabled={disabled}
        className={`field ${className || ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          cursor: disabled ? 'default' : 'pointer',
          textAlign: 'left',
          ...style,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0, overflow: 'hidden' }}>
          {icon}
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: selected ? 'inherit' : 'var(--muted)',
            }}
          >
            {selected ? selected.label : ph}
          </span>
        </span>
        <ChevronDown
          size={15}
          style={{
            color: open ? 'var(--accent)' : 'var(--muted)',
            flexShrink: 0,
            transition: 'transform .15s',
            transform: open ? 'rotate(180deg)' : 'none',
          }}
        />
      </button>

      {open && pos && typeof document !== 'undefined' && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed',
            left: pos.left,
            width: Math.max(pos.width, 160),
            ...(pos.openUp ? { bottom: window.innerHeight - pos.top + 4 } : { top: pos.top + 4 }),
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 12px 40px var(--overlay)',
            padding: 4,
            zIndex: 2000,
            maxHeight: 280,
            overflowY: 'auto',
            animation: 'fadeIn .12s ease',
          }}
        >
          {options.map((o) => {
            const sel = o.value === value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => { onChange(o.value); setOpen(false); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  width: '100%',
                  padding: '8px 10px',
                  border: 'none',
                  borderRadius: 7,
                  background: sel ? 'color-mix(in oklab, var(--accent) 16%, transparent)' : 'transparent',
                  color: sel ? 'var(--text)' : 'var(--text-2)',
                  cursor: 'pointer',
                  fontSize: 13,
                  textAlign: 'left',
                }}
                onMouseEnter={(e) => { if (!sel) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{o.label}</span>
                {sel && <Check size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
