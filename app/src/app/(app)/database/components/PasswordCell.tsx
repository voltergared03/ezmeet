'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Eye, EyeOff, Copy, Check, X, Pencil } from 'lucide-react';
import type { PasswordView } from '../lib/types';

const asView = (value: unknown): PasswordView => {
  if (value && typeof value === 'object' && 'set' in (value as object)) return value as PasswordView;
  if (typeof value === 'string' && value.length) return { set: true }; // optimistic, just-typed
  return { set: false };
};

/**
 * Password cell. The value is stored encrypted server-side and never arrives in
 * bulk row reads (only `{ set }`). Reveal/copy fetch the plaintext on demand from
 * the access-checked reveal endpoint; setting/replacing sends a new plaintext up.
 */
export function PasswordCell({
  value,
  rowId,
  fieldId,
  onCommit,
  readOnly = false,
}: {
  value: unknown;
  rowId?: string;
  fieldId: string;
  onCommit: (value: unknown) => void;
  /** Viewer mode: can still reveal/copy (reads), but cannot set/replace. */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const [view, setView] = useState<PasswordView>(() => asView(value));
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed + re-hide whenever the cell value changes (e.g. after a refetch).
  useEffect(() => { setView(asView(value)); setRevealed(null); }, [value]);

  const fetchPlain = async (): Promise<string | null> => {
    if (!rowId) return null;
    try {
      const res = await fetch(`/api/rows/${rowId}/password/${fieldId}`);
      if (res.ok) return (await res.json()).password ?? '';
    } catch { /* ignore */ }
    return null;
  };

  const toggleReveal = async () => {
    if (revealed != null) { setRevealed(null); return; }
    setLoading(true);
    const pw = await fetchPlain();
    setLoading(false);
    if (pw != null) setRevealed(pw);
  };

  const copy = async () => {
    const pw = revealed != null ? revealed : await fetchPlain();
    if (pw == null) return;
    try {
      await navigator.clipboard.writeText(pw);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch { /* clipboard blocked — ignore */ }
  };

  const submit = (raw: string) => {
    setEditing(false);
    setRevealed(null);
    if (raw.length) onCommit(raw); // do NOT trim — whitespace can be significant
  };

  // ── Set / replace mode ── only when editable (viewers never set values) ──
  if (!readOnly && (editing || !view.set)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', padding: '0 8px' }}>
        <Lock size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          autoFocus={editing}
          defaultValue=""
          type="text"
          placeholder={t('passwordPlaceholder')}
          spellCheck={false}
          autoComplete="new-password"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit((e.target as HTMLInputElement).value);
            else if (e.key === 'Escape' && view.set) setEditing(false);
          }}
          style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none' }}
        />
        <button type="button" aria-label={tc('save')} onClick={() => submit(inputRef.current?.value ?? '')} style={iconBtn}>
          <Check size={14} style={{ color: 'var(--accent)' }} />
        </button>
        {view.set && (
          <button type="button" aria-label={tc('cancel')} onClick={() => setEditing(false)} style={iconBtn}>
            <X size={13} />
          </button>
        )}
      </div>
    );
  }

  // Viewer looking at an empty cell — nothing to reveal.
  if (!view.set) {
    return <span style={{ padding: '0 10px', color: 'var(--muted)', fontSize: 13 }}>—</span>;
  }

  // ── Display mode ─────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: '100%', padding: '0 8px', overflow: 'hidden' }}>
      <Lock size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      <span
        className={revealed != null ? 'mono' : undefined}
        style={{
          flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13,
          letterSpacing: revealed != null ? 0 : '0.18em', color: revealed != null ? 'var(--text)' : 'var(--text-2)',
        }}
      >
        {revealed != null ? (revealed || '—') : '••••••••'}
      </span>
      <button type="button" aria-label={revealed != null ? t('passwordHide') : t('passwordReveal')} title={revealed != null ? t('passwordHide') : t('passwordReveal')} onClick={toggleReveal} disabled={loading} style={iconBtn}>
        {revealed != null ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      <button type="button" aria-label={t('passwordCopy')} title={t('passwordCopy')} onClick={copy} style={iconBtn}>
        {copied ? <Check size={13} style={{ color: 'var(--green, var(--success))' }} /> : <Copy size={13} />}
      </button>
      {!readOnly && (
        <button type="button" aria-label={t('passwordReplace')} title={t('passwordReplace')} onClick={() => setEditing(true)} style={iconBtn}>
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

const iconBtn: CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3, borderRadius: 5, flexShrink: 0,
};
