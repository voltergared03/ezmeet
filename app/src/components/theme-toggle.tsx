'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Monitor, Sun, Moon } from 'lucide-react';
import { THEMES, applyTheme, readStoredTheme, type Theme } from '@/lib/theme';

const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * Three-way theme switch: System / Light / Dark.
 *
 * Segmented rather than a single cycling button, because with three states a
 * cycling button never tells you where you are or what comes next — you press it
 * and find out. All three options are visible and the current one is marked, which
 * is the same "show all options when there are 2-3 values" rule the rest of the
 * rework is built on.
 *
 * "System" is kept as a real option instead of being implied by the absence of a
 * choice: it is the only setting that keeps following the OS at dusk, and a user
 * who wants that has no other way to ask for it.
 */
export function ThemeToggle() {
  const t = useTranslations('settings');
  // Server-rendered markup cannot know the stored value, so the switch renders
  // unmarked until mount rather than guessing and re-marking on hydration.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => setTheme(readStoredTheme()), []);

  function choose(next: Theme) {
    setTheme(next);
    applyTheme(next);
  }

  return (
    <div>
      <div className="field-label">{t('theme')}</div>
      <div
        role="radiogroup"
        aria-label={t('theme')}
        style={{
          display: 'inline-flex', gap: 2, padding: 3,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        {THEMES.map((value) => {
          const Icon = ICON[value];
          const active = theme === value;
          const label = t(value === 'system' ? 'themeSystem' : value === 'light' ? 'themeLight' : 'themeDark');
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choose(value)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '7px 12px', minHeight: 34,
                border: 'none', borderRadius: 8,
                background: active ? 'var(--surface)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--muted)',
                boxShadow: active ? 'var(--shadow)' : 'none',
                fontWeight: active ? 600 : 500,
                fontSize: 13,
                transition: 'background .15s ease, color .15s ease',
              }}
            >
              <Icon size={15} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>{t('themeHint')}</div>
    </div>
  );
}
