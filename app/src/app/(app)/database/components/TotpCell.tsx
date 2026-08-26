'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslations } from 'next-intl';
import { KeyRound, Copy, Check, X } from 'lucide-react';
import type { TotpView } from '../lib/types';

const asView = (value: unknown): TotpView =>
  value && typeof value === 'object' && 'set' in (value as object) ? (value as TotpView) : { set: false };

/**
 * "2FA code" cell. The secret is stored encrypted server-side and never reaches
 * the client — this only ever receives the live code + a countdown, and only
 * sends a freshly pasted base32 secret up when the user sets/replaces the key.
 */
export function TotpCell({
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
  /** Viewer mode: still shows the live code (a read), but cannot set/replace the key. */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const [view, setView] = useState<TotpView>(() => asView(value));
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const fetchingRef = useRef(false);

  // Re-seed when the cell value changes (e.g. after a row refetch or a set).
  useEffect(() => {
    setView(asView(value));
  }, [value]);

  const refresh = useCallback(async () => {
    if (!rowId || fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const res = await fetch(`/api/rows/${rowId}/totp/${fieldId}`, { cache: 'no-store' });
      if (res.ok) setView(await res.json());
    } catch {
      /* keep last code */
    } finally {
      fetchingRef.current = false;
    }
  }, [rowId, fieldId]);

  // Re-anchor on mount + whenever the tab regains focus. The bulk row-GET seed is
  // already stale by network latency, and a backgrounded tab freezes the tick — so
  // without this the cell can show a code from a window that already rotated.
  // Deps intentionally EXCLUDE view.validUntil (it changes on every refresh →
  // would loop).
  useEffect(() => {
    if (!view.set || !rowId || editing) return;
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [view.set, rowId, editing, refresh]);

  // Tick wall-clock every second (remaining is derived from validUntil − now, so
  // it self-corrects against setInterval drift).
  useEffect(() => {
    if (!view.set || !rowId || editing) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [view.set, rowId, editing]);

  // When the current window has elapsed, fetch the next code.
  useEffect(() => {
    if (view.set && view.validUntil && !editing && now >= view.validUntil) refresh();
  }, [now, view.set, view.validUntil, editing, refresh]);

  const remaining = view.validUntil
    ? Math.max(0, Math.round((view.validUntil - now) / 1000))
    : (view.remainingSec ?? 0);

  const submit = (raw: string) => {
    const s = raw.trim();
    setEditing(false);
    if (s) onCommit(s);
  };

  const copy = async () => {
    if (!view.code) return;
    try {
      await navigator.clipboard.writeText(view.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked — ignore */
    }
  };

  // ── Set / replace mode ── only when editable (viewers never set keys) ──
  if (!readOnly && (editing || !view.set)) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', height: '100%', padding: '0 8px' }}>
        <KeyRound size={13} style={{ color: 'var(--muted)', flexShrink: 0 }} />
        <input
          ref={inputRef}
          autoFocus={editing}
          defaultValue=""
          placeholder={t('totpPlaceholder')}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit((e.target as HTMLInputElement).value);
            else if (e.key === 'Escape' && view.set) setEditing(false);
          }}
          style={{ flex: 1, minWidth: 0, border: 'none', background: 'transparent', color: 'var(--text)', font: 'inherit', fontSize: 13, outline: 'none' }}
        />
        <button
          type="button"
          aria-label={tc('save')}
          onClick={() => submit(inputRef.current?.value ?? '')}
          style={iconBtn}
        >
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

  // Viewer looking at an empty cell — nothing to show, no settable input.
  if (!view.set) {
    return <span style={{ padding: '0 10px', color: 'var(--muted)', fontSize: 13 }}>—</span>;
  }

  // ── Display mode ─────────────────────────────────────────────────
  const code = view.code ?? '------';
  const pretty = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, width: '100%', height: '100%', padding: '0 8px', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={copy}
        title={t('totpCopy')}
        className="mono"
        style={{
          border: 'none', background: 'transparent', cursor: 'pointer', padding: 0,
          fontSize: 15, fontWeight: 600, letterSpacing: '0.06em', color: 'var(--text)',
          display: 'inline-flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums',
        }}
      >
        {pretty}
        {copied ? <Check size={13} style={{ color: 'var(--green, var(--success))' }} /> : <Copy size={12} style={{ color: 'var(--muted)' }} />}
      </button>
      <Ring remaining={remaining} period={view.period ?? 30} />
      <div style={{ flex: 1 }} />
      {!readOnly && (
        <button type="button" aria-label={t('totpReplaceKey')} title={t('totpReplaceKey')} onClick={() => setEditing(true)} style={iconBtn}>
          <KeyRound size={13} />
        </button>
      )}
    </div>
  );
}

function Ring({ remaining, period }: { remaining: number; period: number }) {
  const r = 6;
  const circ = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, period > 0 ? remaining / period : 0));
  const low = remaining <= 5;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }} title={`${remaining}s`}>
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r={r} fill="none" stroke="var(--border-2, var(--border))" strokeWidth="2" />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={low ? 'var(--red, var(--danger))' : 'var(--accent)'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform="rotate(-90 8 8)"
          style={{ transition: 'stroke-dashoffset .95s linear' }}
        />
      </svg>
    </span>
  );
}

const iconBtn: CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 3, borderRadius: 5, flexShrink: 0,
};
