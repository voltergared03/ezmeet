'use client';

/**
 * Skeleton placeholders.
 *
 * A spinner says only "wait". A skeleton says what is coming and roughly how much of
 * it, so the page does not jump when the data lands and the wait feels shorter than
 * the same wait behind a spinner. The app currently has eight spinners to two
 * skeletons; these are the shapes to replace them with.
 *
 * The shimmer is one CSS animation on a gradient rather than a JS timer, and it is
 * suppressed by the prefers-reduced-motion block in globals.css.
 */

export function Skeleton({
  w, h = 12, radius = 6, style,
}: {
  /** Width — a number is px, a string is any CSS length. Defaults to full width. */
  w?: number | string;
  h?: number | string;
  radius?: number;
  style?: React.CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className="skeleton"
      style={{ width: w ?? '100%', height: h, borderRadius: radius, ...style }}
    />
  );
}

/**
 * A paragraph of lines. The last line is short, because real text almost never fills
 * its final line and a block of equal bars reads as a table, not prose.
 */
export function SkeletonText({ lines = 3, gap = 8 }: { lines?: number; gap?: number }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} w={i === lines - 1 ? '62%' : '100%'} h={11} />
      ))}
    </span>
  );
}

/** Avatar + two lines — the shape of a person row (participants, users, assignees). */
export function SkeletonRow({ avatar = true }: { avatar?: boolean }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}>
      {avatar && <Skeleton w={32} h={32} radius={999} style={{ flexShrink: 0 }} />}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1, minWidth: 0 }}>
        <Skeleton w="42%" h={12} />
        <Skeleton w="26%" h={10} />
      </span>
    </span>
  );
}

/**
 * A card-shaped block. `role="status"` + `aria-busy` so a screen reader is told the
 * region is loading instead of being read an empty box — the one thing a visual
 * skeleton communicates and a silent one does not.
 */
export function SkeletonCard({ lines = 3, label }: { lines?: number; label?: string }) {
  return (
    <div
      className="card"
      role="status"
      aria-busy="true"
      aria-label={label}
      style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <Skeleton w="38%" h={14} />
      <SkeletonText lines={lines} />
    </div>
  );
}
