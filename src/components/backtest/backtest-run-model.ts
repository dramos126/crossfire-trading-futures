/**
 * The run-reader's decisions, outside the JSX.
 *
 * The eighth pure module on the `deployment-status.ts` / `trade-markers.ts`
 * / `board-model.ts` / `board-view.ts` pattern, and it is here for the same
 * reason those are: every answer below compiles and renders while telling
 * the trader something false. A filter that reports *3 of 412* when it
 * filtered to 47, a stepper that clamps silently onto a different trade
 * than the one its label names, a run grouped under the playbook its
 * *folder* is called rather than the one its header records — each is a
 * plausible screen and a wrong one.
 *
 * Owned by docs/modules/ui/design-language.md.
 */
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { RunSummary } from "@/lib/trading/backtest-artifacts";

/**
 * Which population the trader is looking at.
 *
 * Three and not four: there is no *break-even* option, because the buckets
 * come from the sign of `pnlTicks` exactly as `computeStats` does
 * ([backtest.md](../../docs/modules/trading/backtest.md)) and a scratch
 * trade is neither a winner nor a loser. It stays in `all` and is reachable
 * there. A fourth option would be a fourth bucket this surface invented,
 * disagreeing with every stats grid in the app.
 */
export type OutcomeFilter = "all" | "winners" | "losers";

/**
 * **The sign of `pnlTicks`, and nothing else.** Not `pnlNetDollars`: fees
 * can turn a one-tick win into a negative dollar figure, and a trade
 * filtered into *losers* whose chart shows price reaching the target is the
 * surface disagreeing with the marker taxonomy two inches below it. The
 * hard rule in backtest.md says exit reason does not decide the bucket
 * either — a trail-stop exit that locked in +200 ticks is a win.
 */
export function isWinner(t: CliTradeRecord): boolean {
  return t.pnlTicks > 0;
}

export function isLoser(t: CliTradeRecord): boolean {
  return t.pnlTicks < 0;
}

export function filterTrades(
  trades: readonly CliTradeRecord[],
  filter: OutcomeFilter,
): CliTradeRecord[] {
  if (filter === "winners") return trades.filter(isWinner);
  if (filter === "losers") return trades.filter(isLoser);
  return [...trades];
}

/** Counts for the filter control, over the whole run rather than over what
 *  survives the current filter — the same rule `/logs`' facet counts follow.
 *  A control whose own counts move when you use it cannot be read. */
export interface OutcomeCounts {
  all: number;
  winners: number;
  losers: number;
  /** Not an option; rendered as the residual so `w + l < all` is explained
   *  rather than looking like a dropped row. */
  scratch: number;
}

export function countOutcomes(trades: readonly CliTradeRecord[]): OutcomeCounts {
  let winners = 0;
  let losers = 0;
  for (const t of trades) {
    if (isWinner(t)) winners++;
    else if (isLoser(t)) losers++;
  }
  return { all: trades.length, winners, losers, scratch: trades.length - winners - losers };
}

/**
 * The stepper's state, resolved together so the label and the trade cannot
 * disagree.
 *
 * `index` is clamped *here* and returned, rather than clamped at the render
 * and left stale in the caller's state: a filter change shrinks the
 * population under a held index, and a component that renders
 * `Math.min(i, n-1)` while its state still holds `i` shows trade 12 under a
 * label that says 40 and steps from the wrong place on the next press.
 */
export interface StepState {
  /** Clamped into range, or null when the population is empty. */
  index: number | null;
  /** 1-based, for the `N of M` label. Null with the index. */
  position: number | null;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  /** The trade the label is about. Null when the population is empty. */
  trade: CliTradeRecord | null;
}

export function resolveStep(trades: readonly CliTradeRecord[], requested: number): StepState {
  const total = trades.length;
  if (total === 0) {
    return { index: null, position: null, total: 0, canPrev: false, canNext: false, trade: null };
  }
  const index = Math.min(Math.max(0, Math.trunc(requested)), total - 1);
  return {
    index,
    position: index + 1,
    total,
    canPrev: index > 0,
    canNext: index < total - 1,
    trade: trades[index],
  };
}

/**
 * Runs grouped for the picker.
 *
 * **Keyed on `playbookKey` off the header, never on the folder name.** The
 * default `--out` happens to start with the playbook, but the trader's own
 * `--out` does not: `backtests/tf-arm/control-5m` is
 * `opening-range-breakout-v2`, and `backtests/orb/risk1200-5m` is a
 * different name again for a module whose key is neither. Grouping by
 * folder would file one playbook's trades under another's heading, which is
 * the one error this screen must not make — its whole purpose is to let the
 * trader say *why this playbook's trades went the way they did*.
 */
export interface RunGroup {
  playbookKey: string;
  runs: RunSummary[];
}

export function groupRuns(runs: readonly RunSummary[]): RunGroup[] {
  const byKey = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const existing = byKey.get(run.playbookKey);
    if (existing) existing.push(run);
    else byKey.set(run.playbookKey, [run]);
  }
  return [...byKey.entries()]
    .map(([playbookKey, group]) => ({ playbookKey, runs: group }))
    .sort((a, b) => a.playbookKey.localeCompare(b.playbookKey));
}

/**
 * The runs for one playbook page.
 *
 * A run is this page's when its header names this playbook. **Cross-
 * instrument runs are included and are not silently mixed in** — the header
 * records `calibratedFor`, so `ticker !== calibratedFor` identifies one
 * without knowing which flags were typed, and `isCrossInstrument` below is
 * what the row stamps. A run whose header predates the field answers false
 * rather than guessing: absent is not the same as equal.
 */
export function runsForPlaybook(
  runs: readonly RunSummary[],
  playbookKey: string,
): RunSummary[] {
  return runs.filter((r) => r.playbookKey === playbookKey);
}

export function isCrossInstrument(run: RunSummary): boolean {
  return run.calibratedFor != null && run.calibratedFor !== run.ticker;
}

/**
 * What the picker renders for one run's identity, disambiguated within the
 * page's own visible set.
 *
 * `label` is the run directory's basename, and two runs on one playbook page
 * can already share one — `playbookKey` comes from the run header, the
 * directory name comes from `--out`, and they are not the same namespace:
 * `tf-arm/arm-15m` and `opening-range-breakout-v2/arm-15m` both carry the
 * same `playbookKey` and land on the same page. `runPath` is already the
 * unique key and is already what selection uses, so nothing here changes
 * selection — this only decides what the operator can read.
 *
 * **The common case — every visible label distinct — must render exactly as
 * `label` alone.** `parent` is set only on a label two or more visible runs
 * share, never on `label` itself: making the label the full `runPath` would
 * put the same redundant prefix on every row on a playbook page, which is
 * the reason the basename was chosen to begin with.
 */
export interface DisplayLabel {
  label: string;
  /** The immediate parent directory, rendered as a `parent/` prefix — set
   *  only when `label` collides in the visible set. Null when this run's
   *  `runPath` has no parent segment to disambiguate with, even if its
   *  label collides; that case is unreached today (a run always sits at
   *  least one directory below the artifact root) and is not silently
   *  mis-rendered if it ever is. */
  parent: string | null;
}

export function displayLabels(runs: readonly RunSummary[]): Map<string, DisplayLabel> {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);

  const out = new Map<string, DisplayLabel>();
  for (const r of runs) {
    const collides = (counts.get(r.label) ?? 0) > 1;
    if (!collides) {
      out.set(r.runPath, { label: r.label, parent: null });
      continue;
    }
    const segments = r.runPath.split("/");
    const parent = segments.length >= 2 ? segments[segments.length - 2] : null;
    out.set(r.runPath, { label: r.label, parent });
  }
  return out;
}

/**
 * The bar window to fetch around a trade.
 *
 * Pre-entry context is what lets the trader see the setup *form*, which is
 * the whole reason this screen exists — a chart that opens on the entry bar
 * answers "what happened next" and not "would I have taken this". The pad
 * is in bars and converted here, so a 1m run and a 15m run both get the
 * same amount of readable context rather than the same number of minutes.
 */
export interface BarWindow {
  fromIso: string;
  toIso: string;
}

export function barWindowFor(
  trade: CliTradeRecord,
  timeframeMinutes: number,
  preBars: number,
  postBars: number,
): BarWindow {
  const padMs = timeframeMinutes * 60_000;
  return {
    fromIso: new Date(new Date(trade.entryTs).getTime() - preBars * padMs).toISOString(),
    toIso: new Date(new Date(trade.exitTs).getTime() + postBars * padMs).toISOString(),
  };
}

/**
 * `entryMeta` flattened for display.
 *
 * The blob is the strategy's own diagnostic channel and this surface knows
 * nothing about its keys by design — it is what a trader needs to answer
 * *why did the playbook think this was a setup*, and a renderer that only
 * printed keys it recognised would hide exactly the field a new playbook
 * added. Values are stringified here rather than in JSX so the number
 * formatting is testable.
 *
 * Nested objects and arrays render as compact JSON rather than `[object
 * Object]`. A long float is fixed to four places: `atr` arrives as
 * `275.01785714285717` and the trailing digits are noise from the divide,
 * not precision the run measured.
 */
export interface MetaEntry {
  key: string;
  value: string;
}

export function flattenMeta(meta: unknown): MetaEntry[] {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
  return Object.entries(meta as Record<string, unknown>).map(([key, raw]) => ({
    key,
    value: formatMetaValue(raw),
  }));
}

function formatMetaValue(raw: unknown): string {
  if (raw == null) return "—";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return String(raw);
    return Number.isInteger(raw) ? String(raw) : trimZeros(raw.toFixed(4));
  }
  if (typeof raw === "boolean") return raw ? "yes" : "no";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw);
  } catch {
    return String(raw);
  }
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Ticks as a signed, glanceable string. `+124t` / `-124t`.
 *
 * Excursions are recorded as positive magnitudes in both directions, so
 * the caller states the sign it means rather than this guessing one — an
 * MAE printed `+139t` reads as a gain.
 */
export function formatTicks(ticks: number, sign: "+" | "-" | "auto" = "auto"): string {
  const rounded = Math.round(ticks);
  if (sign === "auto") return `${rounded >= 0 ? "+" : ""}${rounded}t`;
  return `${sign}${Math.abs(rounded)}t`;
}

/** R to two places with an explicit sign, the unit the shelf is read in. */
export function formatR(r: number): string {
  return `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`;
}

// ── Copy ────────────────────────────────────────────────────────────────

/** The empty list on the Playbook page. Names the producer and says *read*,
 *  never a path, and names the in-browser run by its section's label rather
 *  than by where it sits — see copy.md, "An empty list says where the things
 *  would have come from". */
export const SAVED_RUNS_EMPTY =
  "No saved runs for this playbook. Runs come from the backtest command and are read from the runs folder. Try settings runs one in the browser without saving it.";

export const SAVED_RUNS_HELP =
  "Runs the backtest command saved for this playbook, read one trade at a time. Step with ◀ ▶ or the arrow keys.\n\n" +
  "The chart can be read on 1m, 5m or 15m bars whatever the run traded on; the trade, its stop and its target are the same on every one.\n\n" +
  "Nothing here starts a run or changes the playbook.";

export const RUN_TIMEFRAME_TITLE = "The timeframe this run traded on.";

export const WHOLE_DAY_LABEL = "Whole day";

/** A button title, so one paragraph rather than `\n\n` blocks. */
export const WHOLE_DAY_TITLE =
  "Loads the trade's whole session, 18:00 ET the evening before to 17:00 ET, so you can zoom out. The chart still opens on the trade.";
