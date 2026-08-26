'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { ArrowUp, ArrowDown, CopyPlus, Link2, MessageSquarePlus, Trash2 } from 'lucide-react';

const MENU_W = 290;

/** Right-click context menu for a grid row (Teable-style). */
export function RowContextMenu({
  x,
  y,
  onClose,
  onInsert,
  onDuplicate,
  onCopyLink,
  onComment,
  onDelete,
}: {
  x: number;
  y: number;
  onClose: () => void;
  onInsert: (position: 'above' | 'below', count: number) => void;
  onDuplicate: () => void;
  onCopyLink: () => void;
  onComment: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('database');
  const ref = useRef<HTMLDivElement>(null);
  const [aboveN, setAboveN] = useState(1);
  const [belowN, setBelowN] = useState(1);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  useEffect(() => {
    const el = ref.current;
    const h = el?.offsetHeight ?? 320;
    const left = Math.min(x, window.innerWidth - MENU_W - 8);
    const top = Math.min(y, window.innerHeight - h - 8);
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: 'fixed', left: pos.left, top: pos.top, width: MENU_W, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 16px 48px var(--overlay)', padding: 5, zIndex: 3000 }}
    >
      <InsertRow icon={<ArrowUp size={16} />} labelBefore={t('insertRecord')} labelAfter={t('directionAbove')} count={aboveN} setCount={setAboveN} onRun={() => { onInsert('above', aboveN); onClose(); }} />
      <InsertRow icon={<ArrowDown size={16} />} labelBefore={t('insertRecord')} labelAfter={t('directionBelow')} count={belowN} setCount={setBelowN} onRun={() => { onInsert('below', belowN); onClose(); }} />
      <Divider />
      <Item icon={<CopyPlus size={16} />} label={t('duplicateRecord')} onClick={() => { onDuplicate(); onClose(); }} />
      <Item icon={<Link2 size={16} />} label={t('copyRecordUrl')} onClick={() => { onCopyLink(); onClose(); }} />
      <Divider />
      <Item icon={<MessageSquarePlus size={16} />} label={t('addComment')} onClick={() => { onComment(); onClose(); }} />
      <Item icon={<Trash2 size={16} />} label={t('deleteRecord')} danger onClick={() => { onDelete(); onClose(); }} />
    </div>,
    document.body,
  );
}

function InsertRow({ icon, labelBefore, labelAfter, count, setCount, onRun }: { icon: ReactNode; labelBefore: string; labelAfter: string; count: number; setCount: (n: number) => void; onRun: () => void }) {
  const clamp = (n: number) => Math.max(1, Math.min(50, n || 1));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onRun}
      onKeyDown={(e) => { if (e.key === 'Enter') onRun(); }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px', borderRadius: 8, cursor: 'pointer', color: 'var(--text)', fontSize: 13.5 }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ display: 'flex', color: 'var(--muted)', flexShrink: 0 }}>{icon}</span>
      <span>{labelBefore}</span>
      <input
        type="number"
        min={1}
        max={50}
        value={count}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onRun(); }}
        onChange={(e) => setCount(clamp(parseInt(e.target.value, 10)))}
        style={{ width: 44, padding: '4px 6px', textAlign: 'center', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none' }}
      />
      <span>{labelAfter}</span>
      <span style={{ flex: 1 }} />
    </div>
  );
}

function Item({ icon, label, onClick, danger }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 8, background: 'transparent', color: danger ? 'var(--red, var(--danger))' : 'var(--text)', cursor: 'pointer', fontSize: 13.5, textAlign: 'left' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = danger ? 'color-mix(in oklab, var(--red, var(--danger)) 12%, transparent)' : 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ display: 'flex', color: danger ? 'inherit' : 'var(--muted)', flexShrink: 0 }}>{icon}</span>
      {label}
    </button>
  );
}

function Divider() {
  return <div style={{ height: 1, background: 'var(--border)', margin: '5px 6px' }} />;
}
