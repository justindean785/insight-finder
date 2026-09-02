/**
 * Wall-clock formatting for aggregate run durations.
 *
 * Lives in `lib/` rather than inline so the minute-boundary behaviour can be
 * driven by a test — the bug it exists to prevent is invisible in review and
 * only shows up on specific inputs.
 */

/**
 * Format a millisecond total as `Xm Ys` / `Zs`.
 *
 * Rounds to whole seconds BEFORE splitting minutes from seconds. Rounding the
 * remainder on its own lets it land on 60 and render an invalid figure —
 * 119_600ms printed "1m 60s", and 59_600ms printed "60s" instead of carrying.
 * An evidence tool reporting wall-clock has to carry properly at the boundary.
 */
export function fmtWallClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}
