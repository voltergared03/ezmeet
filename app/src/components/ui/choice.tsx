'use client';

import { useId } from 'react';
import { Check } from 'lucide-react';
import type { ListOption } from '@/lib/listbox';

/**
 * RadioGroup and CheckboxGroup — all options visible, no dropdown.
 *
 * The codebase had EIGHT <select> elements and ZERO radio buttons, so every
 * single-choice control was a dropdown, including binary yes/no ones. That hides both
 * answers behind a click and gives no hint whether one or several may be picked. The
 * control itself should say that before anyone touches it: a circle means one, a box
 * means several.
 *
 * Native <input type="radio"/"checkbox"> under a styled skin rather than
 * role="radiogroup" on divs: the browser then gives us arrow-key navigation, roving
 * focus, form participation and the accessibility tree for free, and all of those are
 * things a hand-rolled version gets subtly wrong.
 */

function Row({
  kind, name, option, checked, onSelect, disabled,
}: {
  kind: 'radio' | 'checkbox';
  name: string;
  option: ListOption;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const off = disabled || option.disabled;
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '9px 10px', borderRadius: 9,
        // 40px keeps the whole row a comfortable pointer target, and the <label>
        // wrapper means the text is clickable too, not just the 16px control.
        minHeight: 40,
        cursor: off ? 'not-allowed' : 'pointer',
        opacity: off ? 0.5 : 1,
        background: checked ? 'var(--accent-soft-2)' : 'transparent',
        transition: 'background .12s ease',
      }}
      onMouseEnter={(e) => { if (!off && !checked) e.currentTarget.style.background = 'var(--hover)'; }}
      onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
    >
      <input
        type={kind}
        name={name}
        value={option.value}
        checked={checked}
        disabled={off}
        onChange={onSelect}
        // Visually replaced by the box below, but kept in the layout (not
        // display:none) so it stays focusable and the focus ring has somewhere to go.
        style={{ position: 'absolute', opacity: 0, width: 16, height: 16, margin: 0 }}
      />
      <span
        aria-hidden
        style={{
          width: 17, height: 17, flexShrink: 0,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-2)'}`,
          background: checked ? 'var(--accent)' : 'transparent',
          borderRadius: kind === 'radio' ? '50%' : 5,
          transition: 'background .12s ease, border-color .12s ease',
        }}
      >
        {checked && (kind === 'radio'
          ? <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--on-accent)' }} />
          : <Check size={12} strokeWidth={3} style={{ color: 'var(--on-accent)' }} />)}
      </span>
      <span style={{ fontSize: 13.5, color: 'var(--text)' }}>{option.label}</span>
    </label>
  );
}

/** One choice out of several. Use whenever there are 2–3 options. */
export function RadioGroup({
  value, onChange, options, label, name, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: ListOption[];
  label?: string;
  name?: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const groupName = name || `r${uid}`;
  return (
    <div role="radiogroup" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {options.map((o) => (
        <Row
          key={o.value} kind="radio" name={groupName} option={o}
          checked={o.value === value} disabled={disabled}
          onSelect={() => onChange(o.value)}
        />
      ))}
    </div>
  );
}

/** Any number of choices, including none. */
export function CheckboxGroup({
  values, onChange, options, label, disabled,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  options: ListOption[];
  label?: string;
  disabled?: boolean;
}) {
  const uid = useId();
  const set = new Set(values);
  const toggle = (v: string) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    // Emit in the OPTIONS' order, not click order, so the stored value is stable
    // and two users who picked the same things produce the same array.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  };
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {options.map((o) => (
        <Row
          key={o.value} kind="checkbox" name={`c${uid}-${o.value}`} option={o}
          checked={set.has(o.value)} disabled={disabled}
          onSelect={() => toggle(o.value)}
        />
      ))}
    </div>
  );
}
