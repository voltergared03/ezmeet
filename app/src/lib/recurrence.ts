import { pad, zonedFormFields, zonedWallTimeToUtcISO } from '@/lib/utils';

/** Days in a 1-based month (e.g. daysInMonth(2024, 2) = 29). */
function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/**
 * The next occurrence after `from`, advanced in the WORKSPACE timezone.
 *
 * The old version did `setUTCDate/setUTCMonth` in UTC, which kept the UTC wall-clock fixed —
 * so at every Kyiv DST change a recurring meeting jumped an hour (10:00 → 09:00), and a
 * monthly meeting on the 31st overflowed into the next-but-one month (Jan 31 → Mar 3),
 * skipping a month. Advancing the LOCAL calendar fields and reconstructing the instant keeps
 * the wall-clock time constant across DST; monthly clamps to the month's last valid day.
 * (Known minor limit: once a monthly date is clamped, e.g. Feb 28, it doesn't spring back to
 * the 31st in longer months — that needs a stored anchor day, out of scope here.)
 */
export function nextOccurrenceAfter(from: Date, type: string, now: number, tz: string): Date {
  const { date, time } = zonedFormFields(from, tz); // wall-clock Y-M-D + H:M in the workspace zone
  const [y0, m0, d0] = date.split('-').map(Number);
  let year = y0, month = m0, day = d0; // month is 1-based

  const advance = () => {
    if (type === 'monthly') {
      month += 1;
      if (month > 12) { month = 1; year += 1; }
      day = Math.min(d0, daysInMonth(year, month)); // clamp the anchor day to a shorter month
    } else {
      const n = type === 'daily' ? 1 : type === 'biweekly' ? 14 : 7;
      // Pure calendar-day arithmetic via a UTC proxy (no DST inside UTC); we re-zone below.
      const proxy = new Date(Date.UTC(year, month - 1, day));
      proxy.setUTCDate(proxy.getUTCDate() + n);
      year = proxy.getUTCFullYear(); month = proxy.getUTCMonth() + 1; day = proxy.getUTCDate();
    }
  };
  const toUtc = () => new Date(zonedWallTimeToUtcISO(`${year}-${pad(month)}-${pad(day)}`, time, tz));

  advance();
  let guard = 0;
  while (toUtc().getTime() <= now && guard++ < 1000) advance();
  return toUtc();
}
