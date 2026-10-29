import type { BacktestReplayResult } from "@/components/chart/trade-markers";

/**
 * Client-safe replay-result helpers: the cacheability predicate with no
 * server-only imports.
 *
 * **`replay.ts` re-exports from here rather than holding a copy**, so there is
 * nothing to keep in lockstep and no pair of definitions that can diverge — an
 * earlier version of this docblock instructed the reader to synchronise two
 * lists and there has only ever been one. The one live consumer is the replay
 * route, through that re-export.
 *
 * The client half of the reason is gone: this was split out so the analytics
 * panel and the trade table could share the filtering rules without dragging
 * the indicator/topstep-client tree into the browser bundle, and both of those
 * surfaces were deleted with the backtest-comparison work. **The file is dead
 * exactly as far as the route is and no further** — see the punchlist entry,
 * which is also where `parseReplayResult` is recorded as the one genuinely
 * unreferenced export here.
 */
export const NON_CACHEABLE_NO_SIGNAL_PREFIXES: readonly string[] = [
  "bar fetch failed",
  "no live client available",
  "no bar snapshot and no live client available",
  "insufficient post-entry bars for replay",
];

export function isReplayResultCacheable(result: BacktestReplayResult): boolean {
  if (result.status !== "no_signal") return true;
  const reason = result.noSignalReason ?? "";
  return !NON_CACHEABLE_NO_SIGNAL_PREFIXES.some((p) => reason.startsWith(p));
}

const REPLAY_STATUSES: ReadonlySet<BacktestReplayResult["status"]> = new Set([
  "match",
  "exec_drift",
  "signal_drift",
  "no_signal",
]);

function isBacktestReplayResult(v: unknown): v is BacktestReplayResult {
  if (v == null || typeof v !== "object") return false;
  const status = (v as { status?: unknown }).status;
  return typeof status === "string"
    && REPLAY_STATUSES.has(status as BacktestReplayResult["status"]);
}

/** Parse the raw JSON blob carried on a trade row, returning null when the
 *  blob is missing, malformed, or shape-incompatible. The cached blobs in
 *  replay_result_json predate any future shape change, so a permissive
 *  parser keeps an old row from poisoning the analytics aggregation. */
export function parseReplayResult(raw: string | null): BacktestReplayResult | null {
  if (raw == null || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return isBacktestReplayResult(v) ? v : null;
  } catch {
    return null;
  }
}
