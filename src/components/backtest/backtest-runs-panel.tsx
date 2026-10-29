"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BacktestTradeChart } from "@/components/backtest/backtest-trade-chart";
import { CHIP_CLASS, CHIP_TONE, chipForBacktestExitReason } from "@/components/exit-reason-chips";
import { cliTradeToMarker } from "@/components/chart/trade-markers";
import { formatUsd, pnlToneClass } from "@/components/board/board-view";
import {
  countOutcomes,
  displayLabels,
  filterTrades,
  flattenMeta,
  formatR,
  formatTicks,
  isCrossInstrument,
  resolveStep,
  RUN_TIMEFRAME_TITLE,
  runsForPlaybook,
  SAVED_RUNS_EMPTY,
  WHOLE_DAY_LABEL,
  WHOLE_DAY_TITLE,
  type OutcomeFilter,
} from "@/components/backtest/backtest-run-model";
import {
  CHART_TIMEFRAME_STORAGE_KEY,
  choiceFor,
  parseStoredWholeDay,
  parseTimeframe,
  resolveChartTimeframe,
  timeframeOptions,
  WHOLE_DAY_STORAGE_KEY,
} from "@/components/backtest/backtest-run-window";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import type { CliTradeRecord } from "@/lib/trading/backtest-trade-record";
import type { RunSummary, RunTrades } from "@/lib/trading/backtest-artifacts";
import type { TickerSymbol, Timeframe } from "@/lib/trading/domain";

/**
 * The run reader — stepping through one measured trade at a time.
 *
 * **What this screen is for.** Twenty-six theses were measured and rejected
 * on aggregate statistics, and the operator is a discretionary trader whose
 * judgement about *why* a trade worked is the input the loop was missing.
 * He cannot supply it from a table of numbers. Stepping matters more than
 * any single view, which is why the stepper is the primary control and the
 * trade list beside it is the secondary one.
 *
 * **It reads artifacts and never produces them.** The CLI is the sole
 * writer of `backtests/`; a trader agent holds that process, and nothing
 * here starts a run. That is also the split from *Try settings* beside it on
 * the Playbook page, which runs one in the browser and shows it without
 * saving. *Try settings* reads its result through `RunReader` below, so a
 * fresh run and a saved one are stepped by the same rules.
 *
 * The chart, the markers and `/api/backtest/bars` all pre-date this file —
 * what was missing was never the chart. It was that the trades lived in
 * files the web app had never been taught to open.
 */

interface BacktestRunsPanelProps {
  /** The page's playbook. Runs are matched on the artifact header's own
   *  `playbookKey`, never on the folder the run sits in. */
  strategyKey: string;
}

/** Matches the chart's own default window. Stated here because the facts
 *  strip's "context" line describes it to the reader. */
const PRE_BARS = 40;
const POST_BARS = 15;

export function BacktestRunsPanel({ strategyKey }: BacktestRunsPanelProps) {
  const { token } = useTrading();
  const { runs: mine, error: runsError, settled: runsSettled } = useSavedRuns(strategyKey);
  const chartPrefs = useChartPrefs();
  const [filter, setFilter] = useState<OutcomeFilter>("all");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [run, setRun] = useState<RunTrades | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);

  // Preselect the newest run for this playbook. `listRuns` sorts newest
  // first, so the head of the filtered list is it.
  useEffect(() => {
    if (selectedPath != null) return;
    if (mine.length === 0) return;
    setSelectedPath(mine[0].runPath);
  }, [mine, selectedPath]);

  // One run's trades. Cleared on the way in rather than left showing the
  // previous run's rows under the new run's name — the drill-in's
  // stale-scope defect, one surface over.
  useEffect(() => {
    if (!token || selectedPath == null) return;
    let cancelled = false;
    setRun(null);
    setRunError(null);
    setRunLoading(true);

    fetch(`/api/backtest/runs/${selectedPath.split("/").map(encodeURIComponent).join("/")}`)
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setRunError((body as { error?: string }).error ?? `HTTP ${res.status}`);
        else setRun(body as RunTrades);
      })
      .catch((err) => {
        if (!cancelled) setRunError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setRunLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token, selectedPath]);

  if (!runsSettled) {
    return <p className="text-xs text-[var(--muted)]">Reading the backtest runs folder…</p>;
  }

  if (runsError != null) {
    return (
      <div className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
        {runsError}
      </div>
    );
  }

  if (mine.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-[var(--muted)]">
        {SAVED_RUNS_EMPTY}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <RunPicker
        runs={mine}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
      />

      {runLoading && <p className="text-xs text-[var(--muted)]">Loading trades…</p>}

      {runError != null && (
        <div className="rounded-md border border-[var(--danger)]/30 bg-[var(--danger)]/10 px-3 py-2 text-sm text-[var(--danger)]">
          {runError}
        </div>
      )}

      {run != null && (
        <RunReader
          summary={run.summary}
          trades={run.trades}
          arrowKeys="page"
          filter={filter}
          onFilterChange={setFilter}
          chartPrefs={chartPrefs}
        />
      )}
    </div>
  );
}

/** Marks a reader's container, so a page carrying two can tell whose an
 *  arrow key is. */
const RUN_READER_ATTR = "data-run-reader";

/**
 * One run's trades: the outcome filter, the stepper, the chart and the strip.
 *
 * Shared by *Saved Runs* and by *Try settings*, which feeds it an in-browser
 * run's trades built by the CLI's own `buildTradeRecord` — so both read one
 * shape through one set of rules.
 *
 * `arrowKeys` says whose ◀ ▶ the arrow keys are when two readers share a page.
 * `"page"` takes them under any focus outside a text field and outside another
 * reader, which is what *Saved Runs* always did; `"within"` takes them only
 * while focus is inside this reader, so stepping a fresh run never also steps
 * the saved one.
 */
export function RunReader({
  summary,
  trades,
  arrowKeys,
  filter,
  onFilterChange,
  chartPrefs,
}: {
  summary: RunSummary;
  trades: CliTradeRecord[];
  arrowKeys: "page" | "within";
  /** Held by the caller, with `chartPrefs`, because the reader unmounts while
   *  the next run loads and both choices outlive a change of run. */
  filter: OutcomeFilter;
  onFilterChange: (next: OutcomeFilter) => void;
  chartPrefs: ChartPrefs;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [requestedIndex, setRequestedIndex] = useState(0);

  // A new run starts at its first trade. Reset during render rather than in
  // an effect, so no frame steps the new run from the old one's index.
  const [seenTrades, setSeenTrades] = useState(trades);
  if (seenTrades !== trades) {
    setSeenTrades(trades);
    setRequestedIndex(0);
  }

  const counts = useMemo(() => countOutcomes(trades), [trades]);
  const visible = useMemo(() => filterTrades(trades, filter), [trades, filter]);
  const step = resolveStep(visible, requestedIndex);

  const goTo = useCallback((next: number) => setRequestedIndex(next), []);
  const changeFilter = useCallback(
    (next: OutcomeFilter) => {
      onFilterChange(next);
      // A filter change is a new question; page 5 of all trades is not page 5
      // of the losers. Same reason the drill-in resets its page index.
      setRequestedIndex(0);
    },
    [onFilterChange],
  );

  // Left / right step the trade under any focus that is not a text field,
  // because cycling is the interaction this screen exists for and reaching
  // for the mouse four hundred times is not it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      const inside = el != null && containerRef.current?.contains(el) === true;
      if (!inside) {
        if (arrowKeys === "within") return;
        if (el?.closest?.(`[${RUN_READER_ATTR}]`) != null) return;
      }
      if (step.index == null) return;
      if (e.key === "ArrowLeft" && step.canPrev) {
        e.preventDefault();
        goTo(step.index - 1);
      }
      if (e.key === "ArrowRight" && step.canNext) {
        e.preventDefault();
        goTo(step.index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step.index, step.canPrev, step.canNext, goTo, arrowKeys]);

  return (
    <div ref={containerRef} {...{ [RUN_READER_ATTR]: "" }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <OutcomeToggle value={filter} counts={counts} onChange={changeFilter} />
        <Stepper
          position={step.position}
          total={step.total}
          canPrev={step.canPrev}
          canNext={step.canNext}
          onPrev={() => step.index != null && goTo(step.index - 1)}
          onNext={() => step.index != null && goTo(step.index + 1)}
        />
      </div>

      {step.trade == null ? (
        <p className="text-xs text-[var(--muted)]">
          {counts.all === 0
            ? "This run recorded no trades."
            : `No ${filter} in this run — ${counts.all} trade${counts.all === 1 ? "" : "s"} recorded.`}
        </p>
      ) : (
        <TradeView
          trade={step.trade}
          summary={summary}
          onPick={goTo}
          trades={visible}
          activeIndex={step.index ?? 0}
          chartPrefs={chartPrefs}
        />
      )}
    </div>
  );
}

/**
 * This playbook's saved runs, newest first — the list *Saved Runs* picks from
 * and *Try settings* loads from, so both scope on the same header key.
 *
 * One fetch, on mount — artifacts do not change while the page is open unless
 * a CLI run finishes, and a reload is the escape for that rather than a poll
 * competing with the run for the same disk.
 */
export function useSavedRuns(strategyKey: string): {
  runs: RunSummary[];
  error: string | null;
  settled: boolean;
} {
  const { token } = useTrading();
  const [all, setAll] = useState<RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!token) return;
    const signal = { cancelled: false };
    void loadRuns(token, signal, setAll, setError, setSettled);
    return () => {
      signal.cancelled = true;
    };
  }, [token]);

  const runs = useMemo(() => (all == null ? [] : runsForPlaybook(all, strategyKey)), [all, strategyKey]);
  return { runs, error, settled };
}

/**
 * The chart's timeframe and whole-day choices. Held on the panel rather than
 * the chart, because the chart is remounted per trade and the choice has to
 * survive ◀ ▶ and a change of run; stored so it survives a reload too.
 */
export interface ChartPrefs {
  /** The operator's pick, or null for the run's own timeframe. */
  timeframeChoice: Timeframe | null;
  setTimeframeChoice: (choice: Timeframe | null) => void;
  wholeDay: boolean;
  setWholeDay: (on: boolean) => void;
}

export function useChartPrefs(): ChartPrefs {
  const [timeframeChoice, setChoiceState] = useState<Timeframe | null>(null);
  const [wholeDay, setWholeDayState] = useState(false);

  // Read after mount, not in the initialiser: the server render has no
  // storage, and a first client render that differed would not hydrate.
  useEffect(() => {
    setChoiceState(parseTimeframe(localStorage.getItem(CHART_TIMEFRAME_STORAGE_KEY)));
    setWholeDayState(parseStoredWholeDay(localStorage.getItem(WHOLE_DAY_STORAGE_KEY)));
  }, []);

  const setTimeframeChoice = useCallback((choice: Timeframe | null) => {
    setChoiceState(choice);
    if (choice == null) localStorage.removeItem(CHART_TIMEFRAME_STORAGE_KEY);
    else localStorage.setItem(CHART_TIMEFRAME_STORAGE_KEY, choice);
  }, []);

  const setWholeDay = useCallback((on: boolean) => {
    setWholeDayState(on);
    localStorage.setItem(WHOLE_DAY_STORAGE_KEY, String(on));
  }, []);

  return { timeframeChoice, setTimeframeChoice, wholeDay, setWholeDay };
}

async function loadRuns(
  token: string,
  // An object rather than a boolean: the caller flips it after this call has
  // started, and a boolean argument is a copy that never sees the flip.
  signal: { cancelled: boolean },
  setRuns: (r: RunSummary[]) => void,
  setError: (e: string | null) => void,
  setSettled: (b: boolean) => void,
): Promise<void> {
  try {
    const res = await fetch("/api/backtest/runs");
    const body = await res.json();
    if (signal.cancelled) return;
    if (!res.ok) setError((body as { error?: string }).error ?? `HTTP ${res.status}`);
    else setRuns((body as { runs: RunSummary[] }).runs);
  } catch (err) {
    if (!signal.cancelled) setError(err instanceof Error ? err.message : String(err));
  } finally {
    // Settles on any answer, not only a successful one — the arm that says
    // "there are no runs" must be reachable, and a read that fails forever
    // must not leave the reader waiting forever.
    if (!signal.cancelled) setSettled(true);
  }
}

// ── The run picker ──────────────────────────────────────────────────────

function RunPicker({
  runs,
  selectedPath,
  onSelect,
}: {
  runs: RunSummary[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  // Disambiguated within this page's own visible set — see the doc comment
  // on displayLabels for why the parent directory, never the full runPath.
  const labels = useMemo(() => displayLabels(runs), [runs]);
  return (
    <div className="rounded-md border border-[var(--card-border)] overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-[var(--card)] border-b border-[var(--card-border)]">
          <tr className="text-left text-[var(--muted)] uppercase tracking-wider text-[10px]">
            <th className="px-3 py-2 font-medium w-8" />
            <th className="px-3 py-2 font-medium">Run</th>
            <th className="px-3 py-2 font-medium">Instrument</th>
            <th className="px-3 py-2 font-medium">Range</th>
            <th className="px-3 py-2 font-medium text-right">Trades</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => {
            const selected = r.runPath === selectedPath;
            const display = labels.get(r.runPath) ?? { label: r.label, parent: null };
            return (
              <tr
                key={r.runPath}
                className={`border-b border-[var(--card-border)] last:border-0 ${
                  i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
                } ${selected ? "outline outline-1 -outline-offset-1 outline-[var(--accent)]" : ""}`}
              >
                <td className="px-3 py-1.5">
                  {/* A real radio in a leading cell, not role="radio" on the
                      row — the row override flattens every cell into the
                      control's name and takes the column headers with it. */}
                  <input
                    type="radio"
                    name="backtest-run"
                    className="w-3.5 h-3.5 accent-[var(--accent)] align-middle"
                    checked={selected}
                    onChange={() => onSelect(r.runPath)}
                    aria-label={`${display.parent != null ? `${display.parent}/` : ""}${display.label}, ${r.ticker} ${r.timeframe}, ${r.tradeCount} trades`}
                  />
                </td>
                <td className="px-3 py-1.5 font-mono text-[var(--foreground)]">
                  <span className="truncate inline-block max-w-[22rem] align-middle" title={r.runPath}>
                    {display.parent != null && (
                      <span className="text-[var(--muted-secondary)]">{display.parent}/</span>
                    )}
                    {display.label}
                  </span>
                  {r.kind === "walk-forward" && (
                    <span className={`ml-1.5 ${CHIP_CLASS} ${CHIP_TONE.neutral}`} title="Walk-forward run — held-out windows">
                      WF
                    </span>
                  )}
                  {isCrossInstrument(r) && (
                    <span
                      className={`ml-1.5 ${CHIP_CLASS} ${CHIP_TONE.ops}`}
                      title={`Measured on ${r.ticker}, calibrated for ${r.calibratedFor}. Its numbers describe portability, not this playbook's own edge.`}
                    >
                      X-INST
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 font-mono tabular-nums text-[var(--muted)]">
                  {r.ticker} · {r.timeframe}
                </td>
                <td className="px-3 py-1.5 font-mono tabular-nums text-[var(--muted)]">
                  {r.from} → {r.to}
                </td>
                <td className="px-3 py-1.5 text-right font-mono tabular-nums text-[var(--foreground)]">
                  {r.tradeCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── The controls ────────────────────────────────────────────────────────

function toggleClass(active: boolean): string {
  return `px-2 py-1 text-xs rounded-md border transition-colors ${
    active
      ? "border-[var(--accent)] text-[var(--accent)] bg-[var(--accent)]/10"
      : "border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)]"
  }`;
}

const OUTCOME_LABELS: Record<OutcomeFilter, string> = {
  all: "All",
  winners: "Winners",
  losers: "Losers",
};

function OutcomeToggle({
  value,
  counts,
  onChange,
}: {
  value: OutcomeFilter;
  counts: { all: number; winners: number; losers: number; scratch: number };
  onChange: (v: OutcomeFilter) => void;
}) {
  const countFor = (f: OutcomeFilter) =>
    f === "all" ? counts.all : f === "winners" ? counts.winners : counts.losers;
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Filter trades by outcome">
      {(["all", "winners", "losers"] as const).map((f) => {
        const active = value === f;
        return (
          <button
            key={f}
            onClick={() => onChange(f)}
            aria-pressed={active}
            className={toggleClass(active)}
          >
            {OUTCOME_LABELS[f]}{" "}
            <span className="font-mono tabular-nums">{countFor(f)}</span>
          </button>
        );
      })}
      {counts.scratch > 0 && (
        <span
          className="ml-1 text-[11px] text-[var(--muted-secondary)] font-mono tabular-nums"
          title="Trades that closed at zero ticks. Neither a winner nor a loser, and reachable under All."
        >
          {counts.scratch} scratch
        </span>
      )}
    </div>
  );
}

function ChartControls({
  options,
  runTimeframe,
  value,
  onPick,
  wholeDay,
  onWholeDay,
}: {
  options: Timeframe[];
  runTimeframe: Timeframe | null;
  value: Timeframe;
  onPick: (tf: Timeframe) => void;
  wholeDay: boolean;
  onWholeDay: (on: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-1" role="group" aria-label="Chart timeframe">
        {options.map((tf) => (
          <button
            key={tf}
            onClick={() => onPick(tf)}
            aria-pressed={value === tf}
            title={tf === runTimeframe ? RUN_TIMEFRAME_TITLE : undefined}
            className={`${toggleClass(value === tf)} font-mono tabular-nums`}
          >
            {tf}
          </button>
        ))}
      </div>
      <button
        onClick={() => onWholeDay(!wholeDay)}
        aria-pressed={wholeDay}
        title={WHOLE_DAY_TITLE}
        className={toggleClass(wholeDay)}
      >
        {WHOLE_DAY_LABEL}
      </button>
    </div>
  );
}

function Stepper({
  position,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  position: number | null;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const btn =
    "px-2 py-1 text-xs rounded-md border border-[var(--card-border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-[var(--accent)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  return (
    <div className="flex items-center gap-2 ml-auto">
      <button onClick={onPrev} disabled={!canPrev} className={btn} aria-label="Previous trade">
        ◀
      </button>
      <span className="text-xs font-mono tabular-nums text-[var(--foreground)] min-w-[6rem] text-center">
        {position == null ? "—" : `${position} of ${total}`}
      </span>
      <button onClick={onNext} disabled={!canNext} className={btn} aria-label="Next trade">
        ▶
      </button>
    </div>
  );
}

// ── One trade ───────────────────────────────────────────────────────────

function TradeView({
  trade,
  summary,
  trades,
  activeIndex,
  onPick,
  chartPrefs,
}: {
  trade: CliTradeRecord;
  summary: RunSummary;
  trades: CliTradeRecord[];
  activeIndex: number;
  onPick: (i: number) => void;
  chartPrefs: ChartPrefs;
}) {
  // Memoised: the chart's render effect depends on `marker`, so a fresh object
  // on every parent render tore the chart down and snapped the operator's
  // zoom and pan back to the opening view.
  const marker = useMemo(() => cliTradeToMarker(trade, summary.tickSize), [trade, summary.tickSize]);
  const runTimeframe = parseTimeframe(summary.timeframe);
  const timeframe = resolveChartTimeframe(chartPrefs.timeframeChoice, runTimeframe);
  return (
    <div className="space-y-3">
      <TradeFacts trade={trade} summary={summary} />
      <ChartControls
        options={timeframeOptions(runTimeframe)}
        runTimeframe={runTimeframe}
        value={timeframe}
        onPick={(tf) => chartPrefs.setTimeframeChoice(choiceFor(tf, runTimeframe))}
        wholeDay={chartPrefs.wholeDay}
        onWholeDay={chartPrefs.setWholeDay}
      />
      <div className="rounded-md border border-[var(--card-border)] overflow-hidden">
        {/* Keyed on the trade so lightweight-charts is torn down and rebuilt
            per step rather than mutated — the same pattern the backtest
            panel's expand-row uses. */}
        <BacktestTradeChart
          key={`${summary.runPath}:${trade.tradeId}`}
          marker={marker}
          ticker={tickerOf(summary.ticker)}
          timeframe={timeframe}
          preBars={PRE_BARS}
          postBars={POST_BARS}
          wholeDay={chartPrefs.wholeDay}
          sessionDate={trade.sessionDate}
          rangeHigh={numericMeta(trade, "rangeHigh")}
          rangeLow={numericMeta(trade, "rangeLow")}
        />
      </div>
      <MetaRow trade={trade} />
      <TradeStrip trades={trades} activeIndex={activeIndex} onPick={onPick} />
    </div>
  );
}

/** A number off the trade's entry metadata, or null. */
function numericMeta(trade: CliTradeRecord, key: string): number | null {
  const value = trade.entryMeta?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Headers record a bare root (`MNQ`); the bars route keys on the
 *  slash-prefixed `TickerSymbol`. One place, so the two conventions cannot
 *  drift into a silent 400. */
function tickerOf(headerTicker: string): TickerSymbol {
  return (headerTicker.startsWith("/") ? headerTicker : `/${headerTicker}`) as TickerSymbol;
}

function TradeFacts({ trade, summary }: { trade: CliTradeRecord; summary: RunSummary }) {
  const chip = chipForBacktestExitReason(trade.exitReason);
  const isLong = trade.side === 0;
  return (
    <div className="rounded-md border border-[var(--card-border)] bg-[var(--card)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="font-mono tabular-nums text-[var(--muted)]">#{trade.tradeId}</span>
        <span className={`font-semibold ${isLong ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
          {isLong ? "LONG" : "SHORT"}
        </span>
        <span className="font-mono tabular-nums text-[var(--foreground)]">
          {trade.entryPrice} <span className="text-[var(--muted)]">→</span> {trade.exitPrice}
        </span>
        <span className={`${CHIP_CLASS} ${CHIP_TONE[chip.group]}`} title={trade.exitReason}>
          {chip.code}
        </span>
        <span className={`font-mono tabular-nums font-medium ${pnlToneClass(trade.pnlNetDollars)}`}>
          {formatUsd(trade.pnlNetDollars)}
        </span>
        <span className={`font-mono tabular-nums ${pnlToneClass(trade.rMultiple)}`}>
          {formatR(trade.rMultiple)}
        </span>
        <span className="font-mono tabular-nums text-[var(--muted)]">
          {formatTicks(trade.pnlTicks)}
        </span>
        <span className="ml-auto font-mono tabular-nums text-[var(--muted)]">
          {trade.sessionDate} · {summary.ticker} {summary.timeframe}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--muted)]">
        <Fact label="Best" value={formatTicks(trade.mfeTicks, "+")} tone="mfe" />
        <Fact label="Worst" value={formatTicks(trade.maeTicks, "-")} tone="mae" />
        <Fact label="Stop" value={`${trade.slTicks}t`} />
        <Fact label="Target" value={`${trade.tpTicks}t`} />
        <Fact label="Size" value={`${trade.contracts}`} />
        <Fact label="Bars held" value={`${trade.barsHeld}`} />
        {trade.regime != null && <Fact label="Regime" value={String(trade.regime)} />}
        {trade.sample != null && <Fact label="Sample" value={trade.sample} />}
        {(trade.slMoved?.breakeven || trade.slMoved?.trail) && (
          <Fact
            label="Stop moved"
            value={trade.slMoved.breakeven ? "breakeven" : "trail"}
          />
        )}
      </div>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "mfe" | "mae";
}) {
  const valueClass =
    tone === "mfe"
      ? "text-[var(--success-dim)]"
      : tone === "mae"
        ? "text-[var(--danger-dim)]"
        : "text-[var(--foreground)]";
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="uppercase tracking-wider text-[10px] text-[var(--muted-secondary)]">{label}</span>
      <span className={`font-mono tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}

/**
 * The strategy's own diagnostic blob, rendered whole.
 *
 * Every key, unfiltered — this is what answers *why did the playbook think
 * this was a setup*, and a renderer that printed only the keys it
 * recognised would hide exactly the field a new playbook added.
 */
function MetaRow({ trade }: { trade: CliTradeRecord }) {
  const entries = flattenMeta(trade.entryMeta);
  const exitEntries = flattenMeta(trade.exitMeta);
  if (entries.length === 0 && exitEntries.length === 0) return null;
  return (
    <div className="rounded-md border border-[var(--card-border)] bg-[var(--bg-row-alt)] px-3 py-2 space-y-1">
      {entries.length > 0 && <MetaLine label="Entry" entries={entries} />}
      {exitEntries.length > 0 && <MetaLine label="Exit" entries={exitEntries} />}
    </div>
  );
}

function MetaLine({ label, entries }: { label: string; entries: { key: string; value: string }[] }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <span className="uppercase tracking-wider text-[10px] text-[var(--muted-secondary)] w-10 shrink-0">
        {label}
      </span>
      {entries.map((e) => (
        <span key={e.key} className="inline-flex items-baseline gap-1 text-[11px]">
          <span className="text-[var(--muted)]">{e.key}</span>
          <span className="font-mono tabular-nums text-[var(--foreground)]">{e.value}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * The population as a strip, so the trader can jump as well as step.
 *
 * Secondary to the stepper deliberately — cycling is the interaction this
 * screen exists for. It is here because a run of four hundred trades has
 * shape (a losing month, a cluster of scratches) that stepping cannot show.
 */
function TradeStrip({
  trades,
  activeIndex,
  onPick,
}: {
  trades: CliTradeRecord[];
  activeIndex: number;
  onPick: (i: number) => void;
}) {
  return (
    <div className="max-h-40 overflow-auto rounded-md border border-[var(--card-border)]">
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-[var(--card)] border-b border-[var(--card-border)]">
          <tr className="text-left text-[var(--muted)] uppercase tracking-wider text-[10px]">
            <th className="px-2 py-1.5 font-medium text-right w-12">#</th>
            <th className="px-2 py-1.5 font-medium w-16">Side</th>
            <th className="px-2 py-1.5 font-medium">Session</th>
            <th className="px-2 py-1.5 font-medium w-16">Exit</th>
            <th className="px-2 py-1.5 font-medium text-right w-20">R</th>
            <th className="px-2 py-1.5 font-medium text-right w-24">P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => {
            const chip = chipForBacktestExitReason(t.exitReason);
            const active = i === activeIndex;
            return (
              <tr
                key={`${t.tradeId}-${t.entryTs}`}
                onClick={() => onPick(i)}
                aria-current={active ? "true" : undefined}
                className={`cursor-pointer border-b border-[var(--card-border)] last:border-0 hover:bg-[var(--hover)] transition-colors ${
                  i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
                } ${active ? "border-l-2 border-l-[var(--accent)]" : "border-l-2 border-l-transparent"}`}
              >
                <td className="px-2 py-1 text-right font-mono tabular-nums text-[var(--muted)]">
                  {t.tradeId}
                </td>
                <td className={`px-2 py-1 font-mono ${t.side === 0 ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
                  {t.side === 0 ? "LONG" : "SHORT"}
                </td>
                <td className="px-2 py-1 font-mono tabular-nums text-[var(--muted)]">{t.sessionDate}</td>
                <td className="px-2 py-1">
                  <span className={`${CHIP_CLASS} ${CHIP_TONE[chip.group]}`} title={t.exitReason}>
                    {chip.code}
                  </span>
                </td>
                <td className={`px-2 py-1 text-right font-mono tabular-nums ${pnlToneClass(t.rMultiple)}`}>
                  {formatR(t.rMultiple)}
                </td>
                <td className={`px-2 py-1 text-right font-mono tabular-nums ${pnlToneClass(t.pnlNetDollars)}`}>
                  {formatUsd(t.pnlNetDollars)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
