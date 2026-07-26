import { describe, it, expect, vi } from 'vitest';


import { nextOccurrenceAfter } from '@/lib/recurrence';

const KYIV = 'Europe/Kyiv';
const partsInKyiv = (d: Date) => {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: KYIV, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
};

describe('nextOccurrenceAfter — timezone-aware', () => {
  it('keeps the wall-clock hour constant across a Kyiv DST change (weekly)', () => {
    // 10:00 Kyiv on 2026-03-25 (before spring-forward on Mar 29) = 08:00 UTC.
    const from = new Date('2026-03-25T08:00:00.000Z');
    expect(partsInKyiv(from).h).toBe(10); // sanity
    const next = nextOccurrenceAfter(from, 'weekly', from.getTime(), KYIV);
    const p = partsInKyiv(next);
    // A week later is 2026-04-01, AFTER DST → still 10:00 Kyiv (would be 11:00 under the UTC bug).
    expect([p.mo, p.d, p.h, p.mi]).toEqual([4, 1, 10, 0]);
  });

  it('clamps a monthly meeting on the 31st to the last day of a shorter month (no skipped month)', () => {
    // 2026-01-31 09:00 Kyiv. Naive setUTCMonth would overflow to March 3.
    const from = new Date('2026-01-31T07:00:00.000Z'); // 09:00 Kyiv (UTC+2 in winter)
    expect(partsInKyiv(from)).toMatchObject({ mo: 1, d: 31, h: 9 });
    const next = nextOccurrenceAfter(from, 'monthly', from.getTime(), KYIV);
    const p = partsInKyiv(next);
    expect(p.mo).toBe(2); // February, NOT March
    expect(p.d).toBe(28); // clamped to Feb 28
    expect(p.h).toBe(9); // hour preserved
  });

  it('advances past all missed occurrences to the next future slot', () => {
    const from = new Date('2026-01-01T08:00:00.000Z');
    const now = new Date('2026-01-20T00:00:00.000Z').getTime();
    const next = nextOccurrenceAfter(from, 'weekly', now, KYIV);
    expect(next.getTime()).toBeGreaterThan(now); // strictly in the future
    expect(partsInKyiv(next).h).toBe(10); // 08:00 UTC = 10:00 Kyiv, preserved
  });
});
