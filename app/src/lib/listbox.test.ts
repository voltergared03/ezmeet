import { describe, it, expect } from 'vitest';
import { nextIndex, filterOptions, isNavKey, shouldRenderInline, type ListOption } from '@/lib/listbox';

const opts = (...labels: string[]): ListOption[] => labels.map((l) => ({ value: l.toLowerCase(), label: l }));

describe('nextIndex', () => {
  const three = opts('One', 'Two', 'Three');

  it('moves down and up, and wraps at both ends', () => {
    expect(nextIndex(three, 0, 'ArrowDown')).toBe(1);
    expect(nextIndex(three, 2, 'ArrowDown')).toBe(0); // wraps forward
    expect(nextIndex(three, 1, 'ArrowUp')).toBe(0);
    expect(nextIndex(three, 0, 'ArrowUp')).toBe(2); // wraps back
  });

  it('from "nothing active" lands on the first for Down and the last for Up', () => {
    // Opening a closed list and pressing a key should not require a prior click.
    expect(nextIndex(three, -1, 'ArrowDown')).toBe(0);
    expect(nextIndex(three, -1, 'ArrowUp')).toBe(2);
  });

  it('Home and End jump to the ends', () => {
    expect(nextIndex(three, 2, 'Home')).toBe(0);
    expect(nextIndex(three, 0, 'End')).toBe(2);
  });

  it('skips disabled options rather than parking on them', () => {
    const withDisabled: ListOption[] = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
      { value: 'c', label: 'C' },
    ];
    expect(nextIndex(withDisabled, 0, 'ArrowDown')).toBe(2);
    expect(nextIndex(withDisabled, 2, 'ArrowUp')).toBe(0);
    expect(nextIndex(withDisabled, 0, 'End')).toBe(2); // End skips back off a disabled last
  });

  it('stays put when every option is disabled — never points at something unselectable', () => {
    const allOff: ListOption[] = [
      { value: 'a', label: 'A', disabled: true },
      { value: 'b', label: 'B', disabled: true },
    ];
    expect(nextIndex(allOff, 0, 'ArrowDown')).toBe(0);
  });

  it('handles an empty list without throwing', () => {
    expect(nextIndex([], -1, 'ArrowDown')).toBe(-1);
  });
});

describe('filterOptions', () => {
  const tz = opts('Europe/Kyiv', 'Europe/Warsaw', 'America/New_York');

  it('matches anywhere in the label, not just the prefix', () => {
    // People look up a timezone by city, never by "europe/".
    expect(filterOptions(tz, 'kyiv').map((o) => o.label)).toEqual(['Europe/Kyiv']);
    expect(filterOptions(tz, 'europe')).toHaveLength(2);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(filterOptions(tz, '  WARSAW ')).toHaveLength(1);
  });

  it('folds accents so a Latin keyboard still finds an accented entry', () => {
    const names = opts('Zoë', 'Renée', 'Bob');
    expect(filterOptions(names, 'zoe').map((o) => o.label)).toEqual(['Zoë']);
    expect(filterOptions(names, 'renee').map((o) => o.label)).toEqual(['Renée']);
  });

  it('matches Cyrillic case-insensitively', () => {
    const names = opts('Настя', 'Денис');
    expect(filterOptions(names, 'настя')).toHaveLength(1);
    expect(filterOptions(names, 'НАСТЯ')).toHaveLength(1);
  });

  it('an empty query returns everything — the list must stay browsable', () => {
    expect(filterOptions(tz, '')).toHaveLength(3);
    expect(filterOptions(tz, '   ')).toHaveLength(3);
  });

  it('returns nothing for a query that matches nothing (caller shows empty state)', () => {
    expect(filterOptions(tz, 'zzz')).toEqual([]);
  });
});

describe('shouldRenderInline', () => {
  it('shows 2–3 options inline and collapses more', () => {
    expect(shouldRenderInline(2)).toBe(true);
    expect(shouldRenderInline(3)).toBe(true);
    expect(shouldRenderInline(4)).toBe(false);
  });
  it('is false for an empty set', () => {
    expect(shouldRenderInline(0)).toBe(false);
  });
});

describe('isNavKey', () => {
  it('accepts only the four listbox nav keys', () => {
    expect(isNavKey('ArrowDown')).toBe(true);
    expect(isNavKey('End')).toBe(true);
    expect(isNavKey('Enter')).toBe(false);
    expect(isNavKey('a')).toBe(false);
  });
});
