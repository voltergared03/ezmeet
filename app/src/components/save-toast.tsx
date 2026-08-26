'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Minimal transient error toast for optimistic-save paths.
 *
 * Several editors (the base grid, the task drawer, report action items) apply a
 * change locally and fire a PATCH without checking the result — a rejected save
 * looked applied, then vanished on the next refresh. Callers now revert the
 * optimistic state and call `showSaveError(...)` so the failure is visible.
 *
 * Self-contained (no context/provider): the hook owns the state and returns the
 * element to render. Mount `saveToast` once near the page root.
 */
export function useSaveErrorToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showSaveError = useCallback((m: string) => {
    setMsg(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMsg(null), 4000);
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const saveToast = msg ? (
    <div
      role="alert"
      aria-live="assertive"
      onClick={() => setMsg(null)}
      style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        zIndex: 10000, background: 'var(--red)', color: 'var(--on-accent)', padding: '10px 16px',
        borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,.28)', fontSize: 14,
        maxWidth: 'min(90vw, 440px)', cursor: 'pointer', textAlign: 'center',
      }}
    >
      {msg}
    </div>
  ) : null;

  return { showSaveError, saveToast };
}
