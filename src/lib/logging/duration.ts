/**
 * The humanised duration every operator-facing surface renders.
 *
 * `1314s` and `22m` carry the same information and only one of them is read
 * correctly at a glance — [ui/copy.md](../../../docs/modules/ui/copy.md)'s
 * rule, and this is the one implementation of it.
 *
 * **It lives here because the `/logs` Activity lane renders it and that lane
 * is a client component.** Its previous home, `trading/engine/engine-restart.ts`,
 * imports `db/connection` and the strategy loader, so importing it from the
 * browser bundle would drag both across — the same reason `exit-reasons.ts`
 * lives in this module and not under `trading/`. `engine-restart.ts` re-exports
 * it, so every server-side caller is unchanged and there is still exactly one
 * implementation.
 *
 * Owned by docs/modules/logging/README.md. Leaf: this file imports nothing.
 */

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
/** Under this, a gap reads better as a raw second count than as `1m 38s`. */
const GAP_IN_SECONDS_BELOW_S = 120;

/**
 * A gap as an operator reads it: `98s`, `14m`, `12h 40m`.
 *
 * Rounded to the second below two minutes and truncated to the minute above
 * it — these are log lines, not a stopwatch, and `45640s` is a number nobody
 * converts in their head at 03:00.
 */
export function formatGapDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < GAP_IN_SECONDS_BELOW_S) return `${seconds}s`;
  const totalMinutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}
