'use client';

import { useId } from 'react';
import { AlertCircle } from 'lucide-react';

export interface FieldControlProps {
  id: string;
  'aria-invalid'?: true;
  'aria-describedby'?: string;
  'aria-required'?: true;
}

/**
 * Label + control + hint + error, wired together for screen readers.
 *
 * The app had NO inline field errors at all — zero `aria-invalid` anywhere, and
 * eight `alert()` calls standing in for validation. A modal alert cannot say WHICH
 * field is wrong, so the user is left to hunt; and it is invisible to anyone who has
 * already tabbed past. This is the piece that makes "show where and why the error
 * occurred" possible at every call site instead of one at a time.
 *
 * Two shapes of `children`:
 *  - a function, which receives the id and aria props to spread onto the control.
 *    Use this — it is the only form that actually associates the error with the input.
 *  - a plain node, for the existing call sites that have not been migrated yet. The
 *    label and error still render; they just are not announced as belonging together.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode | ((props: FieldControlProps) => React.ReactNode);
}) {
  const uid = useId();
  const id = `f${uid}`;
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;

  // Point at the error first: a screen reader reads describedby in order, and the
  // reason the value was rejected matters more than the hint that failed to prevent it.
  const describedBy = [error ? errId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  const controlProps: FieldControlProps = {
    id,
    ...(error ? { 'aria-invalid': true as const } : {}),
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(required ? { 'aria-required': true as const } : {}),
  };

  return (
    <div>
      {label && (
        <label className="field-label" htmlFor={id}>
          {label}
          {required && (
            <span aria-hidden style={{ color: 'var(--danger-fg)', marginInlineStart: 3 }}>*</span>
          )}
        </label>
      )}

      <div className={error ? 'field-invalid-wrap' : undefined}>
        {typeof children === 'function' ? children(controlProps) : children}
      </div>

      {/* Hint is hidden once an error shows: two competing lines under one input is
          noise, and the error is strictly the more urgent of the two. */}
      {hint && !error && (
        <div id={hintId} style={{ fontSize: 12, color: 'var(--muted)', marginTop: 5, lineHeight: 1.45 }}>
          {hint}
        </div>
      )}

      {error && (
        // role="alert" so a validation failure is announced when it appears, not only
        // when focus happens to return to the field.
        <div
          id={errId}
          role="alert"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 5,
            fontSize: 12, color: 'var(--danger-fg)', marginTop: 5, lineHeight: 1.45,
          }}
        >
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
