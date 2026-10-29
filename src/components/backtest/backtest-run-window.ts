/**
 * The run reader's chart window and timeframe, outside the JSX.
 *
 * Which bars to fetch, which slice of them to open on, and which timeframe
 * the operator is reading at. Each answer renders plausibly when wrong — a
 * session window a DST hour off, a Monday session loaded as Monday evening,
 * a picker that silently forgets the run's own timeframe — so they are pure
 * and pinned here rather than inline in the chart.
 *
 * Owned by docs/modules/ui/ui-playbooks.md, "The run reader".
 */
import type { BarData } from "@/lib/brokers/types";
import type { Timeframe } from "@/lib/trading/domain";
import { containingBarIndex } from "@/components/chart/trade-markers";
import { sessionDateOf, sessionEndUtc, sessionStartUtc } from "@/lib/trading/regime/session-dates";

const MS_PER_MINUTE = 60_000;

export const TIMEFRAME_MINUTES: Readonly<Record<Timeframe, number>> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "4h": 240,
  "1d": 1440,
};

/** The timeframes the picker always offers. The run's own is added when it
 *  is none of these, so a 3m run can still be read on the bars it ran on. */
export const CHART_TIMEFRAMES: readonly Timeframe[] = ["1m", "5m", "15m"];

/** A header's or a stored timeframe, or null when it is not one we chart.
 *  A stored value that is null reads as *the run's own*. */
export function parseTimeframe(raw: string | null | undefined): Timeframe | null {
  return raw != null && Object.prototype.hasOwnProperty.call(TIMEFRAME_MINUTES, raw)
    ? (raw as Timeframe)
    : null;
}

export function timeframeOptions(runTimeframe: Timeframe | null): Timeframe[] {
  const options = [...CHART_TIMEFRAMES];
  if (runTimeframe != null && !options.includes(runTimeframe)) options.push(runTimeframe);
  return options.sort((a, b) => TIMEFRAME_MINUTES[a] - TIMEFRAME_MINUTES[b]);
}

/**
 * The timeframe the chart renders at.
 *
 * `choice` is the operator's explicit pick, or null for *the run's own*. Null
 * is a meaning rather than an absence: an operator reading every run on its
 * own bars keeps doing so when the next run is 15m, which a stored `"5m"`
 * would not. A choice the run cannot offer falls back to the run's own.
 */
export function resolveChartTimeframe(
  choice: Timeframe | null,
  runTimeframe: Timeframe | null,
): Timeframe {
  const fallback = runTimeframe ?? CHART_TIMEFRAMES[0];
  if (choice == null) return fallback;
  return timeframeOptions(runTimeframe).includes(choice) ? choice : fallback;
}

/** What to store for a pick: picking the run's own timeframe stores null. */
export function choiceFor(picked: Timeframe, runTimeframe: Timeframe | null): Timeframe | null {
  return picked === runTimeframe ? null : picked;
}

/**
 * One Globex session: 18:00 ET the evening before `sessionDate` to 17:00 ET
 * on it.
 *
 * Delegates to `regime/session-dates.ts` rather than restating the boundary,
 * because that module is what the CLI stamps `sessionDate` with — a second
 * definition would let the chart open a different day than the one the row
 * names.
 */
export interface SessionWindow {
  sessionDate: string;
  fromMs: number;
  toMs: number;
}

export function sessionWindowFor(entryIso: string): SessionWindow {
  const sessionDate = sessionDateOf(new Date(entryIso));
  return {
    sessionDate,
    fromMs: sessionStartUtc(sessionDate).getTime(),
    toMs: sessionEndUtc(sessionDate).getTime(),
  };
}

/**
 * The bars to fetch. Whole day changes only this, never the opening view
 * (`initialLogicalRange`).
 *
 * Tight: `preBars + contextBars` before the entry and `postBars + contextBars`
 * after the exit, in bars of `timeframe`.
 *
 * Whole day: the trade's session, 18:00 ET to 17:00 ET, so zooming out has
 * the rest of the day — widened on either side to the tight window wherever
 * that reaches further. The opening view counts `preBars` back from the entry
 * bar and `postBars` on from the exit bar, and a session edge that cuts into
 * that range (an entry just after 18:00, a 15m trade held to the close) would
 * open the chart on a different first or last bar than Whole day off does.
 */
export interface ChartWindow {
  fromIso: string;
  toIso: string;
}

export function chartWindowFor(args: {
  entryIso: string;
  exitIso: string;
  timeframe: Timeframe;
  wholeDay: boolean;
  preBars: number;
  postBars: number;
  contextBars: number;
}): ChartWindow {
  const entryMs = new Date(args.entryIso).getTime();
  const exitMs = new Date(args.exitIso).getTime();
  const barMs = TIMEFRAME_MINUTES[args.timeframe] * MS_PER_MINUTE;
  const tightFromMs = entryMs - (args.preBars + args.contextBars) * barMs;
  const tightToMs = exitMs + (args.postBars + args.contextBars) * barMs;
  if (!args.wholeDay) {
    return { fromIso: new Date(tightFromMs).toISOString(), toIso: new Date(tightToMs).toISOString() };
  }
  const session = sessionWindowFor(args.entryIso);
  return {
    fromIso: new Date(Math.min(session.fromMs, tightFromMs)).toISOString(),
    toIso: new Date(Math.max(session.toMs, tightToMs)).toISOString(),
  };
}

/** The logical range the chart opens on, in bar indices: `preBars` before the
 *  bar containing the entry to `postBars` after the one containing the exit
 *  (the same snap the markers use). Whole day or not, so "Fit trade" and the
 *  opening view agree. */
export function initialLogicalRange(
  bars: readonly Pick<BarData, "timestamp">[],
  entryIso: string,
  exitIso: string,
  preBars: number,
  postBars: number,
): { from: number; to: number } {
  const entryIdx = Math.max(0, containingBarIndex(bars, entryIso));
  const exitIdx = Math.max(entryIdx, containingBarIndex(bars, exitIso));
  return { from: Math.max(0, entryIdx - preBars), to: exitIdx + postBars };
}

// ── Persisted operator choices ──────────────────────────────────────────

export const CHART_TIMEFRAME_STORAGE_KEY = "runReader.chartTimeframe";
export const WHOLE_DAY_STORAGE_KEY = "runReader.wholeDay";

export function parseStoredWholeDay(raw: string | null): boolean {
  return raw === "true";
}
