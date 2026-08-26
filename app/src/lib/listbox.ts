/**
 * Keyboard and filtering logic for the option-list primitives (Select, Combobox,
 * RadioGroup, CheckboxGroup).
 *
 * Pulled out of the components deliberately: this repo runs no React component
 * tests, so anything left inside a .tsx is untested by construction. Keyboard
 * navigation is exactly the part that is easy to get subtly wrong and impossible to
 * notice with a mouse, so it lives here where it can be tested directly.
 */

export interface ListOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Keys that move the active option, per the WAI-ARIA listbox pattern. */
export type NavKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End';

export function isNavKey(key: string): key is NavKey {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End';
}

/**
 * Next active index for a nav key, skipping disabled options.
 *
 * `current` of -1 means "nothing active yet": ArrowDown then lands on the first
 * option and ArrowUp on the last, which is what people expect when they open a
 * closed list and immediately press a key.
 *
 * Wraps at both ends. Returns `current` when every option is disabled, so a caller
 * can never end up pointing at something unselectable.
 */
export function nextIndex(options: ListOption[], current: number, key: NavKey): number {
  const n = options.length;
  if (n === 0) return -1;
  const enabled = (i: number) => !options[i]?.disabled;

  const seek = (from: number, step: number): number => {
    for (let k = 0; k < n; k++) {
      const i = (((from + step * k) % n) + n) % n;
      if (enabled(i)) return i;
    }
    return current; // everything disabled
  };

  switch (key) {
    case 'ArrowDown': return seek(current < 0 ? 0 : current + 1, 1);
    case 'ArrowUp':   return seek(current < 0 ? n - 1 : current - 1, -1);
    case 'Home':      return seek(0, 1);
    case 'End':       return seek(n - 1, -1);
  }
}

/**
 * Filter options by a typed query.
 *
 * Matches anywhere in the label, not just the prefix — people search a timezone by
 * typing "kyiv", not "europe/". Case- and diacritic-insensitive so "Настя" is found
 * by "настя", and accent-folded so a Latin-keyboard user typing "Kyiv" still matches
 * "Кyiv"-style mixed entries.
 *
 * An empty query returns everything rather than nothing: the list must stay
 * browsable by scrolling, which is the whole point of a combobox over a text field.
 */
export function filterOptions<T extends ListOption>(options: T[], query: string): T[] {
  const q = normalize(query);
  if (!q) return options;
  return options.filter((o) => normalize(o.label).includes(q) || normalize(o.value).includes(q));
}

function normalize(s: string): string {
  return s
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .trim();
}

/**
 * Should this control render all options inline instead of behind a dropdown?
 *
 * The rule from the guidelines: two or three choices are shown, more are collapsed.
 * A dropdown over two options hides both of them and charges a click to learn what
 * they even are.
 */
export const INLINE_MAX = 3;

export function shouldRenderInline(count: number): boolean {
  return count > 0 && count <= INLINE_MAX;
}
