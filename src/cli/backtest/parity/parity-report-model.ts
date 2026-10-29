/**
 * The parity report's view model, kept pure: what a date directory's files
 * say, turned into the sentences, chart series and table rows the page draws.
 * Nothing here formats markup; `parity-report-html.ts` does.
 *
 * The book is the primary view — each account's playbooks run together — and
 * each playbook alone is the detail under it, because the book is what the
 * engine actually is: one position per contract, shared across playbooks.
 */
import { chipForExitReason } from "@/components/exit-reason-chips";
import { aggregateBars } from "@/lib/data/aggregator";
import { EXIT_REASONS, exitReasonCodeOf } from "@/lib/logging/exit-reasons";
import { contractSpecForTicker } from "@/lib/trading/contracts/contract-specs";
import { toCents } from "@/lib/trading/orders/pnl-math";
import {
  etParts,
  etWallClockToUtc,
  sessionEndUtc,
  sessionStartUtc,
  splitSessionDate,
} from "@/lib/trading/regime/session-dates";
import { dayCloseUtc } from "./parity-day";
import {
  evidenceFor,
  irregularLines,
  settingsChangeNote,
  logLineText,
  type LogEvidence,
  type LogWindow,
  type ParityLogsFile,
} from "./parity-logs";
import { playbookLabel, type PlaybookNames } from "../playbook-label";
import type {
  BacktestOnlyRow,
  BlockedRow,
  BookAccountFiles,
  CompactBar,
  CompareRows,
  LiveRecordFile,
  LiveRow,
  LiveTradeRecord,
  ParityDayFiles,
  PlaybookLegFiles,
  RunTrade,
  SessionBarSeries,
} from "./parity-report-data";

export type Source = "live" | "backtest";

export interface Tip {
  title: string;
  rows: Array<[label: string, value: string]>;
}

export interface ChartTrade {
  mark: string;
  source: Source;
  ticker: string;
  /** 0 long, 1 short. */
  side: number;
  entry: { ms: number; price: number } | null;
  exit: { ms: number; price: number } | null;
}

export interface ChartBlocked {
  mark: string;
  ticker: string;
  ms: number;
}

export interface Candle {
  ms: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface ChartView {
  ticker: string;
  candleMinutes: number;
  candles: Candle[];
  cash: { startMs: number; endMs: number };
  window: { startMs: number; endMs: number };
  trades: ChartTrade[];
  blocked: ChartBlocked[];
  /** Why no candles are drawn; null when they are. */
  barsNote: string | null;
}

export interface DifferenceItem {
  /** Sort key: the signal bar, else the end of the session. */
  ms: number;
  text: string;
  /** The chart marks this sentence is about. */
  marks: string[];
  /** What live logged around the signal bar; null when there is no window to
   *  cut (no logs saved or readable, no bar recorded, or a sibling sentence
   *  about the same entry carries it). */
  logs: LogEvidence | null;
}

export interface DifferenceGroup {
  name: string;
  items: DifferenceItem[];
}

export interface SideCells {
  entry: string;
  exit: string;
  reason: string;
  pnl: string;
  pnlSign: number | null;
}

export interface TableRow {
  ms: number;
  playbook: string;
  signalBar: string;
  side: string;
  live: SideCells | null;
  backtest: SideCells | null;
  slippage: string;
  result: string;
  marks: string[];
}

export type Tone = "pos" | "neg" | null;

export interface Tile {
  label: string;
  value: string;
  title: string;
  tone: Tone;
}

export interface AccountView {
  /** Prefix for every mark on this account's charts; unique on the page. */
  key: string;
  title: string;
  refusal: string | null;
  notes: string[];
  tiles: Tile[];
  charts: ChartView[];
  groups: DifferenceGroup[];
  rows: TableRow[];
}

export interface LegView {
  title: string;
  refusal: string | null;
  notes: string[];
  tiles: Tile[];
  items: DifferenceItem[];
  rows: TableRow[];
}

export interface ReportView {
  date: string;
  /** The page's own caveats: what was not saved with the day. */
  notes: string[];
  /** `notes.md` as written, rendered by the page; null when the day has none. */
  notesMarkdown: string | null;
  /** The engine's warn and error lines no difference holds; null when the
   *  day's logs were not saved or not readable (`notes` says which). */
  irregularities: string[] | null;
  /** Null when the day has no book record. */
  accounts: AccountView[] | null;
  /** Null when the day has no playbook record. */
  legs: LegView[] | null;
  tips: Record<string, Tip>;
}

const MS_PER_MINUTE = 60_000;
const REPORT_CANDLE_MINUTES = 5;
/** Context drawn before the cash open (or the first mark) and after the close. */
const CHART_LEAD_MINUTES = 30;
const CHART_TAIL_MINUTES = 15;
const DASH = "—";
const BOOK_WORD = "the book";
const SIDE_WORDS: Readonly<Record<number, string>> = { 0: "long", 1: "short" };

const LIVE_DETAIL_MISSING =
  "Live exits, contract counts and P&L were not saved with this day's run, so live trades show their entry only.";
const BARS_MISSING =
  "The bars this run read were not saved with it, so no candles are drawn; the marks are placed by time and price alone.";
const LOGS_MISSING =
  "The engine's logs were not saved with this day's run, so no difference shows what live logged around it.";

function sideWord(side: number): string {
  return SIDE_WORDS[side] ?? `side ${side}`;
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function etClock(ms: number, withSeconds = false): string {
  const p = etParts(new Date(ms));
  return `${pad2(p.hour)}:${pad2(p.minute)}${withSeconds ? `:${pad2(p.second)}` : ""} ET`;
}

export function formatPrice(price: number): string {
  return price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `+$120.00` / `-$40.00` / `$0.00`, from whole cents. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : cents > 0 ? "+" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${pad2(abs % 100)}`;
}

function toneOf(cents: number | null): Tone {
  if (cents == null || cents === 0) return null;
  return cents > 0 ? "pos" : "neg";
}

function ticks(n: number): string {
  return `${n} tick${n === 1 ? "" : "s"}`;
}

/** Signed so positive is the worse fill, as `compare` signs it. */
export function slippageWords(slip: number | null): string {
  if (slip == null) return DASH;
  if (slip === 0) return "none";
  return `${ticks(Math.abs(slip))} ${slip > 0 ? "worse" : "better"}`;
}

function averageSlippageWords(avg: number | null): string {
  if (avg == null) return DASH;
  if (avg === 0) return "none";
  return `${Math.abs(avg).toFixed(1)} ${avg > 0 ? "worse" : "better"}`;
}

/** `Stop Loss (SL)` — the live label where there is one, and the shared code. */
export function exitReasonWords(raw: string | null): string {
  if (raw == null || raw.length === 0) return "not recorded";
  const code = exitReasonCodeOf(raw);
  const chip = chipForExitReason(raw);
  const label =
    code != null ? EXIT_REASONS[code].label : raw === "signal" ? "Strategy Exit" : raw === "end_of_data" ? "Bars ran out" : raw;
  return chip == null ? label : `${label} (${chip.code})`;
}

function last4(id: string | number): string {
  return String(id).slice(-4);
}

function bare(ticker: string): string {
  return ticker.replace(/^\//, "");
}

function msOf(iso: string | null): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ── One deployment's differences, rows and marks ─────────────────────────

interface CellInput {
  accountId: number;
  deploymentId: string;
  ticker: string;
  compare: CompareRows;
  missed: BacktestOnlyRow[];
  excused: Array<{ row: BacktestOnlyRow; contested: boolean; releaseSensitive: boolean }>;
  extra: Array<LiveRow & { reason: string }>;
  orderDifferences: Array<{ live: LiveRow; block: BlockedRow }>;
  blockedInBook: BlockedRow[];
  notCompared: Array<{ live: LiveRow; reason: string }>;
  inBook: boolean;
  unclosed: Array<{ tradeId: number; status: string; signalBarTs: string | null }>;
  /** Backtest trades closed by the bars running out; null when the run's
   *  trades were not readable and only the count is known. */
  endOfDataTrades: RunTrade[] | null;
  endOfDataCount: number;
}

interface CellContext {
  /** Prefix for this cell's marks. */
  key: string;
  /** "the book" or "the backtest": the playbook mode runs each leg alone. */
  backtestWord: string;
  /** Deployment id → its label; holds the cell's own. */
  names: ReadonlyMap<string, string>;
  liveById: ReadonlyMap<number, LiveTradeRecord>;
  runTradeById: ReadonlyMap<number, RunTrade>;
  sessionEndMs: number;
  tips: Record<string, Tip>;
  logs: ParityLogsFile | null;
  /** Every window a difference was given, so the irregularities leave them out. */
  windows: LogWindow[];
}

interface CellOutput {
  items: DifferenceItem[];
  rows: TableRow[];
  trades: ChartTrade[];
  blocked: ChartBlocked[];
}

/** What a backtest trade looks like when its run's `trades.jsonl` is not there. */
function backtestFromCompare(row: { tradeId: number; signalBarTs: string; side: number; entryPrice: number; exitReason: string }) {
  return { tradeId: row.tradeId, signalBarTs: row.signalBarTs, side: row.side, entryPrice: row.entryPrice, exitReason: row.exitReason };
}

function buildCell(cell: CellInput, ctx: CellContext): CellOutput {
  const ticker = bare(cell.ticker);
  const out: CellOutput = { items: [], rows: [], trades: [], blocked: [] };
  const liveMarks = new Map<number, string>();
  const backtestMarks = new Map<number, string>();
  const slippageByLive = new Map<number, number | null>();
  for (const m of cell.compare.matched) slippageByLive.set(m.liveTradeId, m.fillSlippageTicks);

  const nameOf = (deploymentId: string | null): string =>
    deploymentId == null ? "another playbook" : (ctx.names.get(deploymentId) ?? `deployment …${last4(deploymentId)}`);
  const name = nameOf(cell.deploymentId);

  const liveMark = (row: LiveRow): string => {
    const existing = liveMarks.get(row.tradeId);
    if (existing != null) return existing;
    const mark = `${ctx.key}-L${row.tradeId}`;
    liveMarks.set(row.tradeId, mark);
    const rec = ctx.liveById.get(row.tradeId) ?? null;
    const signalMs = msOf(rec?.signalBarTs ?? row.signalBarTs);
    const entryPrice = rec?.entryPrice ?? row.entryPrice;
    const exitMs = msOf(rec?.exitFilledAt ?? null);
    out.trades.push({
      mark,
      source: "live",
      ticker,
      side: row.side,
      // Placed on the signal bar, as the backtest's entry is: that bar is the
      // join, and the fill time is in the tooltip.
      entry: signalMs == null || entryPrice == null ? null : { ms: signalMs, price: entryPrice },
      exit: exitMs == null || rec?.exitPrice == null ? null : { ms: exitMs, price: rec.exitPrice },
    });
    const filled = msOf(rec?.entryFilledAt ?? null);
    ctx.tips[mark] = {
      title: `Live · ${name}`,
      rows: [
        ["Trade", String(row.tradeId)],
        ["Side", capitalise(sideWord(row.side))],
        ["Signal bar", signalMs == null ? "not recorded" : etClock(signalMs)],
        [
          "Entry",
          entryPrice == null ? "no fill recorded" : `${formatPrice(entryPrice)}${filled == null ? "" : ` at ${etClock(filled, true)}`}`,
        ],
        ["Contracts", rec == null ? DASH : String(rec.size)],
        ["Exit", rec?.exitPrice == null ? DASH : `${formatPrice(rec.exitPrice)}${exitMs == null ? "" : ` at ${etClock(exitMs, true)}`}`],
        ["Exit reason", exitReasonWords(rec?.exitReasonCode ?? row.exitReason)],
        ["P&L", rec?.pnlDollars == null ? DASH : formatCents(toCents(rec.pnlDollars))],
        ["Slippage", slippageByLive.has(row.tradeId) ? slippageWords(slippageByLive.get(row.tradeId) ?? null) : DASH],
        ...(rec != null && rec.status !== "closed" ? [["Status", rec.status] satisfies [string, string]] : []),
      ],
    };
    return mark;
  };

  const backtestMark = (row: ReturnType<typeof backtestFromCompare>): string => {
    const existing = backtestMarks.get(row.tradeId);
    if (existing != null) return existing;
    const mark = `${ctx.key}-B${row.tradeId}`;
    backtestMarks.set(row.tradeId, mark);
    const run = ctx.runTradeById.get(row.tradeId) ?? null;
    const signalMs = msOf(row.signalBarTs);
    const exitMs = msOf(run?.exitTs ?? null);
    out.trades.push({
      mark,
      source: "backtest",
      ticker,
      side: row.side,
      entry: signalMs == null ? null : { ms: signalMs, price: row.entryPrice },
      exit: exitMs == null || run == null ? null : { ms: exitMs, price: run.exitPrice },
    });
    ctx.tips[mark] = {
      title: `Backtest · ${name}`,
      rows: [
        ["Side", capitalise(sideWord(row.side))],
        ["Signal bar", signalMs == null ? "not recorded" : etClock(signalMs)],
        ["Entry", `${formatPrice(row.entryPrice)} at the signal bar's close`],
        ["Contracts", run == null ? DASH : String(run.contracts)],
        ["Exit", run == null ? DASH : `${formatPrice(run.exitPrice)}${exitMs == null ? "" : ` on the ${etClock(exitMs)} bar`}`],
        ["Exit reason", exitReasonWords(run?.exitReason ?? row.exitReason)],
        ["P&L", run == null ? DASH : formatCents(toCents(run.pnlNetDollars))],
        ...(run?.endOfData === true ? [["Note", "still open when the bars ran out"] satisfies [string, string]] : []),
      ],
    };
    return mark;
  };

  const blockedMark = (block: BlockedRow): string => {
    const mark = `${ctx.key}-X${out.blocked.length}-${last4(block.deploymentId)}`;
    const ms = msOf(block.signalBarTs);
    if (ms != null) out.blocked.push({ mark, ticker, ms });
    ctx.tips[mark] = {
      title: `Blocked in ${ctx.backtestWord} · ${name}`,
      rows: [
        ["Signal bar", ms == null ? "not recorded" : etClock(ms)],
        ["Held by", block.holderDeploymentId == null ? "nobody — the account's daily limit" : nameOf(block.holderDeploymentId)],
        ["Why", blockWhy(block, ticker, nameOf)],
      ],
    };
    return mark;
  };

  const liveCells = (row: LiveRow): SideCells => {
    const rec = ctx.liveById.get(row.tradeId) ?? null;
    const entryPrice = rec?.entryPrice ?? row.entryPrice;
    const filled = msOf(rec?.entryFilledAt ?? null);
    const exitMs = msOf(rec?.exitFilledAt ?? null);
    const cents = rec?.pnlDollars == null ? null : toCents(rec.pnlDollars);
    return {
      entry:
        entryPrice == null
          ? "no fill"
          : `${formatPrice(entryPrice)}${filled == null ? "" : ` ${etClock(filled)}`}${rec == null ? "" : ` ×${rec.size}`}`,
      exit: rec?.exitPrice == null ? DASH : `${formatPrice(rec.exitPrice)}${exitMs == null ? "" : ` ${etClock(exitMs)}`}`,
      reason: exitReasonWords(rec?.exitReasonCode ?? row.exitReason),
      pnl: cents == null ? DASH : formatCents(cents),
      pnlSign: cents == null ? null : Math.sign(cents),
    };
  };

  const backtestCells = (row: ReturnType<typeof backtestFromCompare>): SideCells => {
    const run = ctx.runTradeById.get(row.tradeId) ?? null;
    const exitMs = msOf(run?.exitTs ?? null);
    const cents = run == null ? null : toCents(run.pnlNetDollars);
    return {
      entry: `${formatPrice(row.entryPrice)}${run == null ? "" : ` ×${run.contracts}`}`,
      exit: run == null ? DASH : `${formatPrice(run.exitPrice)}${exitMs == null ? "" : ` ${etClock(exitMs)}`}`,
      reason: exitReasonWords(run?.exitReason ?? row.exitReason),
      pnl: cents == null ? DASH : formatCents(cents),
      pnlSign: cents == null ? null : Math.sign(cents),
    };
  };

  const at = (iso: string | null): { ms: number; words: string } => {
    const ms = msOf(iso);
    return ms == null ? { ms: ctx.sessionEndMs, words: "on an unrecorded bar" } : { ms, words: `at ${etClock(ms)}` };
  };
  const bt = ctx.backtestWord;
  const Bt = capitalise(bt);
  /** `bar` is the signal bar whose window of log lines the sentence carries. */
  const item = (ms: number, text: string, marks: string[], bar: string | null = null) => {
    const found = bar == null ? null : evidenceFor(ctx.logs, cell, bar);
    if (found != null) ctx.windows.push(found.window);
    out.items.push({ ms, text, marks, logs: found?.evidence ?? null });
  };
  const row = (r: Omit<TableRow, "playbook">) => out.rows.push({ playbook: name, ...r });
  /** The book alone reads the account's limits, so only its differences can
   *  come from a settings change the snapshot postdates. */
  const withSettings = (text: string, bar: string | null, gate: string | null): string => {
    const note = bt === BOOK_WORD ? settingsChangeNote(ctx.logs, cell.accountId, bar, gate) : null;
    return note == null ? text : `${text} ${note}`;
  };

  for (const m of cell.compare.matched) {
    const live: LiveRow = {
      tradeId: m.liveTradeId,
      side: m.side,
      signalBarTs: m.signalBarTs,
      entryPrice: m.liveEntryPrice,
      exitReason: m.liveExitReason,
    };
    const backtest = backtestFromCompare({
      tradeId: m.backtestTradeId,
      signalBarTs: m.signalBarTs,
      side: m.side,
      entryPrice: m.backtestEntryPrice,
      exitReason: m.backtestExitReason,
    });
    const marks = [liveMark(live), backtestMark(backtest)];
    const when = at(m.signalBarTs);
    const slipped = m.fillSlippageTicks != null && m.fillSlippageTicks !== 0;
    if (!m.exitReasonAgreement) {
      item(
        when.ms,
        `Both went ${sideWord(m.side)} ${when.words}, but live exited on ${exitReasonWords(m.liveExitReason)} and ` +
          `${bt} on ${exitReasonWords(m.backtestExitReason)}.`,
        marks,
        // One entry, one window: the slippage sentence carries it when there is one.
        slipped ? null : m.signalBarTs,
      );
    }
    if (m.fillSlippageTicks != null && slipped) {
      item(
        when.ms,
        `Both went ${sideWord(m.side)} ${when.words}; live filled ${slippageWords(m.fillSlippageTicks)} than ${bt}` +
          (m.liveEntryPrice == null
            ? "."
            : ` (${formatPrice(m.liveEntryPrice)} against ${formatPrice(m.backtestEntryPrice)}).`),
        marks,
        m.signalBarTs,
      );
    }
    row({
      ms: when.ms,
      signalBar: etClock(when.ms),
      side: sideWord(m.side),
      live: liveCells(live),
      backtest: backtestCells(backtest),
      slippage: slippageWords(m.fillSlippageTicks),
      result: m.exitReasonAgreement ? "Matched" : "Matched, exits differ",
      marks,
    });
  }

  for (const r of cell.missed) {
    const marks = [backtestMark(backtestFromCompare(r))];
    const when = at(r.signalBarTs);
    item(
      when.ms,
      withSettings(
        `${Bt} went ${sideWord(r.side)} ${when.words} and live did not enter` +
          (r.liveSkipReason == null ? "; live recorded no skip on that bar." : `; live skipped it: ${r.liveSkipReason}.`),
        r.signalBarTs,
        null,
      ),
      marks,
      r.signalBarTs,
    );
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(r.side), live: null, backtest: backtestCells(backtestFromCompare(r)), slippage: DASH, result: "Missed", marks });
  }

  for (const { row: r, contested, releaseSensitive } of cell.excused) {
    const marks = [backtestMark(backtestFromCompare(r))];
    const when = at(r.signalBarTs);
    const why = [
      contested ? `another playbook signalled on ${ticker} on the same bar, so which went first decided it` : null,
      releaseSensitive ? `a different exit timing could have changed who held ${ticker}` : null,
    ].filter((w): w is string => w != null);
    item(
      when.ms,
      `${Bt} went ${sideWord(r.side)} ${when.words} and live did not, but ${why.join(", and ")} — so it is not counted as a miss.`,
      marks,
      r.signalBarTs,
    );
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(r.side), live: null, backtest: backtestCells(backtestFromCompare(r)), slippage: DASH, result: "Not a miss", marks });
  }

  const accounted = new Set([...cell.missed, ...cell.excused.map((e) => e.row)].map((r) => r.tradeId));
  for (const r of cell.compare.backtestOnly) {
    if (accounted.has(r.tradeId)) continue;
    const marks = [backtestMark(backtestFromCompare(r))];
    const when = at(r.signalBarTs);
    // The live row's own sentence, below, carries this bar's window.
    item(when.ms, `${Bt} went ${sideWord(r.side)} ${when.words}, where live has a trade that is not closed, so they were not compared.`, marks);
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(r.side), live: null, backtest: backtestCells(backtestFromCompare(r)), slippage: DASH, result: "Live not closed", marks });
  }

  for (const r of cell.extra) {
    const marks = [liveMark(r)];
    const when = at(r.signalBarTs);
    item(
      when.ms,
      withSettings(
        r.reason === "duplicate_signal_bar"
          ? `Live went ${sideWord(r.side)} a second time ${when.words} (trade ${r.tradeId}); ${bt} entered that bar once.`
          : `Live went ${sideWord(r.side)} ${when.words} (trade ${r.tradeId}) and ${bt} did not enter` +
            (cell.inBook && bt === BOOK_WORD ? ", and nothing in the book blocked it." : "."),
        r.signalBarTs,
        null,
      ),
      marks,
      r.signalBarTs,
    );
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(r.side), live: liveCells(r), backtest: null, slippage: DASH, result: "Extra", marks });
  }

  for (const { live, block } of cell.orderDifferences) {
    const marks = [liveMark(live), blockedMark(block)];
    const when = at(live.signalBarTs);
    item(
      when.ms,
      withSettings(
        `Live went ${sideWord(live.side)} ${when.words} (trade ${live.tradeId}); ${bt} did not, because ${blockWhy(block, ticker, nameOf)}.`,
        live.signalBarTs,
        block.gate,
      ),
      marks,
      live.signalBarTs,
    );
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(live.side), live: liveCells(live), backtest: null, slippage: DASH, result: "Blocked in the book", marks });
  }

  for (const block of cell.blockedInBook) {
    const marks = [blockedMark(block)];
    const when = at(block.signalBarTs);
    item(
      when.ms,
      withSettings(
        `Neither entered ${when.words}: ${bt} had a signal, but ${blockWhy(block, ticker, nameOf)}; live did not enter either.`,
        block.signalBarTs,
        block.gate,
      ),
      marks,
      block.signalBarTs,
    );
    row({ ms: when.ms, signalBar: etClock(when.ms), side: DASH, live: null, backtest: null, slippage: DASH, result: `Blocked by ${nameOf(block.holderDeploymentId)}`, marks });
  }

  for (const { live, reason } of cell.notCompared) {
    const marks = [liveMark(live)];
    const when = at(live.signalBarTs);
    if (reason === "not_in_book") {
      item(when.ms, `Live went ${sideWord(live.side)} ${when.words} (trade ${live.tradeId}), but this playbook was not in the book, so it was not compared.`, marks);
    } else {
      const twin = (cell.endOfDataTrades ?? []).find((t) => msOf(t.signalBarTs) === when.ms);
      if (twin != null) marks.push(backtestMark(twin));
      item(
        when.ms,
        `Live went ${sideWord(live.side)} ${when.words} (trade ${live.tradeId}); ${bt}'s trade on that bar was still open when the bars ran out, so neither was compared.`,
        marks,
      );
    }
    row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(live.side), live: liveCells(live), backtest: null, slippage: DASH, result: "Not compared", marks });
  }

  if (cell.endOfDataTrades == null) {
    if (cell.endOfDataCount > 0) {
      item(
        ctx.sessionEndMs,
        `${cell.endOfDataCount} of ${bt}'s trade${cell.endOfDataCount === 1 ? " was" : "s were"} still open when the bars ran out, so not compared.`,
        [],
      );
    }
  } else {
    const liveBars = new Set(cell.notCompared.map((n) => msOf(n.live.signalBarTs)));
    for (const t of cell.endOfDataTrades) {
      const when = at(t.signalBarTs);
      if (liveBars.has(when.ms)) continue;
      const marks = [backtestMark(t)];
      item(when.ms, `${Bt} went ${sideWord(t.side)} ${when.words} and was still open when the bars ran out, so it was not compared.`, marks);
      row({ ms: when.ms, signalBar: etClock(when.ms), side: sideWord(t.side), live: null, backtest: backtestCells(t), slippage: DASH, result: "Not compared", marks });
    }
  }

  for (const r of cell.compare.liveUnjoinable) {
    const marks = [liveMark(r)];
    item(ctx.sessionEndMs, `Live trade ${r.tradeId} has no signal bar recorded, so it could not be matched.`, marks);
    row({ ms: ctx.sessionEndMs, signalBar: DASH, side: sideWord(r.side), live: liveCells(r), backtest: null, slippage: DASH, result: "Not compared", marks });
  }

  for (const u of cell.unclosed) {
    const rec = ctx.liveById.get(u.tradeId) ?? null;
    const live: LiveRow = {
      tradeId: u.tradeId,
      side: rec?.side ?? 0,
      signalBarTs: u.signalBarTs,
      entryPrice: rec?.entryPrice ?? null,
      exitReason: rec?.exitReasonCode ?? null,
    };
    const marks = rec == null ? [] : [liveMark(live)];
    const when = at(u.signalBarTs);
    item(when.ms, `Live trade ${u.tradeId} ${when.words} is ${u.status}, not closed, so it was not compared.`, marks, u.signalBarTs);
    row({
      ms: when.ms,
      signalBar: msOf(u.signalBarTs) == null ? DASH : etClock(when.ms),
      side: rec == null ? DASH : sideWord(rec.side),
      live: rec == null ? null : liveCells(live),
      backtest: null,
      slippage: DASH,
      result: `Live ${u.status}`,
      marks,
    });
  }

  // Every trade the run took is drawn, whether or not a sentence names it.
  for (const t of ctx.runTradeById.values()) {
    if (t.deploymentId != null && t.deploymentId !== cell.deploymentId) continue;
    backtestMark(t);
  }

  out.items.sort((a, b) => a.ms - b.ms);
  out.rows.sort((a, b) => a.ms - b.ms);
  return out;
}

function blockWhy(block: BlockedRow, ticker: string, nameOf: (id: string | null) => string): string {
  const holder = nameOf(block.holderDeploymentId);
  const base =
    block.gate === "contract_held"
      ? `${holder} was already holding a position on ${ticker}`
      : block.gate === "stale_latch"
        ? `its signal was set aside while ${holder} held ${ticker}, and the same setup does not fire twice`
        : block.gate === "daily_pnl"
          ? "the account had reached its daily P&L limit"
          : `it was refused (${block.gate})`;
  const flags = [
    block.contested ? "both signalled on that bar, so which went first decided it" : null,
    block.releaseSensitive ? `a different exit timing for ${holder} could have freed ${ticker} in time` : null,
  ].filter((f): f is string => f != null);
  return flags.length === 0 ? base : `${base} (${flags.join("; ")})`;
}

// ── Charts ───────────────────────────────────────────────────────────────

/** The session's candles at the report's 5 minutes where the run read 5m or
 *  1m bars; a coarser series is drawn as it is. */
export function candlesFor(series: readonly SessionBarSeries[], ticker: string): { minutes: number; candles: Candle[] } | null {
  const own = series.filter((s) => s.ticker === ticker && s.bars.length > 0);
  const minutesOf = (tf: string) => Number.parseInt(tf, 10);
  const pick =
    own.find((s) => minutesOf(s.timeframe) === REPORT_CANDLE_MINUTES) ??
    own.find((s) => minutesOf(s.timeframe) < REPORT_CANDLE_MINUTES) ??
    own.sort((a, b) => minutesOf(a.timeframe) - minutesOf(b.timeframe))[0];
  if (pick == null) return null;
  const toCandle = ([ms, open, high, low, close]: CompactBar): Candle => ({ ms, open, high, low, close });
  const minutes = minutesOf(pick.timeframe);
  if (minutes >= REPORT_CANDLE_MINUTES) return { minutes, candles: pick.bars.map(toCandle) };
  const NS_PER_MS = BigInt(1_000_000);
  const aggregated = aggregateBars(
    pick.bars.map(([ms, open, high, low, close]) => ({
      tsUtc: BigInt(ms) * NS_PER_MS,
      open,
      high,
      low,
      close,
      volume: BigInt(0),
      symbol: ticker,
    })),
    REPORT_CANDLE_MINUTES,
  );
  return {
    minutes: REPORT_CANDLE_MINUTES,
    candles: aggregated
      .map((b) => ({ ms: Number(b.tsUtc / NS_PER_MS), open: b.open, high: b.high, low: b.low, close: b.close }))
      .sort((a, b) => a.ms - b.ms),
  };
}

function cashWindow(date: string, ticker: string): { startMs: number; endMs: number } {
  const spec = contractSpecForTicker(ticker);
  const [y, m, d] = splitSessionDate(date);
  if (spec == null) return { startMs: sessionStartUtc(date).getTime(), endMs: sessionEndUtc(date).getTime() };
  const [hh, mm] = spec.daySession.start.split(":").map(Number);
  return { startMs: etWallClockToUtc(y, m, d, hh, mm).getTime(), endMs: dayCloseUtc(date, spec).getTime() };
}

function buildChart(input: {
  date: string;
  ticker: string;
  series: readonly SessionBarSeries[];
  trades: ChartTrade[];
  blocked: ChartBlocked[];
}): ChartView {
  const cash = cashWindow(input.date, input.ticker);
  const markTimes = [
    ...input.trades.flatMap((t) => [t.entry?.ms, t.exit?.ms]),
    ...input.blocked.map((b) => b.ms),
  ].filter((ms): ms is number => ms != null);
  const lead = CHART_LEAD_MINUTES * MS_PER_MINUTE;
  const tail = CHART_TAIL_MINUTES * MS_PER_MINUTE;
  const window = {
    startMs: Math.max(sessionStartUtc(input.date).getTime(), Math.min(cash.startMs, ...markTimes) - lead),
    endMs: Math.min(sessionEndUtc(input.date).getTime(), Math.max(cash.endMs, ...markTimes) + tail),
  };
  const found = candlesFor(input.series, input.ticker);
  const minutes = found?.minutes ?? REPORT_CANDLE_MINUTES;
  const candleMs = minutes * MS_PER_MINUTE;
  return {
    ticker: input.ticker,
    candleMinutes: minutes,
    candles: (found?.candles ?? []).filter((c) => c.ms + candleMs > window.startMs && c.ms < window.endMs),
    cash,
    window,
    trades: input.trades,
    blocked: input.blocked,
    barsNote: found == null ? BARS_MISSING : null,
  };
}

// ── Accounts, legs, the page ─────────────────────────────────────────────

/** Null when any figure is missing: a partial sum would read as the whole. */
function sumCents(values: ReadonlyArray<number | null>): number | null {
  let cents = 0;
  for (const v of values) {
    if (v == null) return null;
    cents += toCents(v);
  }
  return cents;
}

function liveIndex(live: LiveRecordFile | null): Map<number, LiveTradeRecord> {
  return new Map((live?.trades ?? []).map((t) => [t.id, t]));
}

function accountView(
  acct: BookAccountFiles,
  files: ParityDayFiles,
  tips: Record<string, Tip>,
  windows: LogWindow[],
  playbooks: PlaybookNames,
): AccountView {
  const key = `a${acct.accountId}`;
  const title = `Account …${last4(acct.accountId)}`;
  const sessionEndMs = sessionEndUtc(files.date).getTime();
  const notes = [...acct.seamWarnings];
  if (acct.cells == null) {
    return { key, title, refusal: acct.refusal ?? "No reason was recorded.", notes, tiles: [], charts: [], groups: [], rows: [] };
  }

  // The section's heading names the account, so its labels do not.
  const names = new Map<string, string>();
  for (const c of [...(acct.run?.cells ?? []), ...acct.cells]) {
    names.set(c.deploymentId, playbookLabel(playbooks, c));
  }
  const runTrades = acct.run?.trades ?? null;
  const unclosedFor = (deploymentId: string) =>
    files.live == null
      ? (files.playbook?.find((l) => l.deploymentId === deploymentId)?.unclosed ?? [])
      : files.live.trades
          .filter((t) => t.deploymentId === deploymentId && t.status !== "closed")
          .map((t) => ({ tradeId: t.id, status: t.status, signalBarTs: t.signalBarTs }));

  const groups: DifferenceGroup[] = [];
  const rows: TableRow[] = [];
  const trades: ChartTrade[] = [];
  const blocked: ChartBlocked[] = [];
  for (const cell of acct.cells) {
    const own = runTrades?.filter((t) => t.deploymentId === cell.deploymentId) ?? null;
    const built = buildCell(
      {
        accountId: acct.accountId,
        deploymentId: cell.deploymentId,
        ticker: cell.ticker,
        compare: cell.compare,
        missed: cell.missed,
        excused: cell.excused,
        extra: cell.extra,
        orderDifferences: cell.orderDifferences,
        blockedInBook: cell.blockedInBook,
        notCompared: cell.notCompared,
        inBook: cell.inBook,
        unclosed: unclosedFor(cell.deploymentId),
        endOfDataTrades: own?.filter((t) => t.endOfData) ?? null,
        endOfDataCount: cell.endOfData,
      },
      {
        key: `${key}-${last4(cell.deploymentId)}`,
        backtestWord: BOOK_WORD,
        names,
        liveById: liveIndex(files.live),
        runTradeById: new Map((own ?? []).map((t) => [t.tradeId, t])),
        sessionEndMs,
        tips,
        logs: files.logs,
        windows,
      },
    );
    if (built.items.length > 0) groups.push({ name: names.get(cell.deploymentId) ?? cell.deploymentId, items: built.items });
    rows.push(...built.rows);
    trades.push(...built.trades);
    blocked.push(...built.blocked);
  }
  rows.sort((a, b) => a.ms - b.ms);

  const tickerOrder = [...new Set(acct.cells.map((c) => bare(c.ticker)))];
  const series = [
    ...(acct.run?.bars ?? []),
    ...(files.playbook ?? []).filter((l) => l.accountId === acct.accountId).flatMap((l) => l.run?.bars ?? []),
  ];
  const charts = tickerOrder
    .filter((t) => trades.some((tr) => tr.ticker === t) || blocked.some((b) => b.ticker === t))
    .map((ticker) =>
      buildChart({
        date: files.date,
        ticker,
        series,
        trades: trades.filter((t) => t.ticker === ticker),
        blocked: blocked.filter((b) => b.ticker === ticker),
      }),
    );

  const liveCents =
    files.live == null
      ? null
      : sumCents(
          files.live.trades.filter((t) => t.accountId === acct.accountId && t.status === "closed").map((t) => t.pnlDollars),
        );
  const bookCents = acct.run?.netDollars == null ? null : toCents(acct.run.netDollars);
  const notCompared = acct.liveNotCompared + acct.liveUnjoinable + acct.liveNotClosed;
  const tiles: Tile[] = [
    { label: "Matched", value: String(acct.matched), title: "Entries live and the book both took, on the same signal bar.", tone: null },
    {
      label: "Missed",
      value: String(acct.missed),
      title:
        "Entries the book took that live did not." +
        (acct.excused > 0
          ? ` ${acct.excused} more were left out of this count because evaluation order or exit timing could have given the bar away.`
          : ""),
      tone: null,
    },
    { label: "Extra", value: String(acct.extra), title: "Entries live took that the book neither took nor refused.", tone: null },
    {
      label: "Not compared",
      value: String(notCompared),
      title:
        `${acct.liveNotCompared} live trade(s) the book could not stand against (its trade ran out of bars, or the playbook was not in the book), ` +
        `${acct.liveUnjoinable} with no signal bar recorded, ${acct.liveNotClosed} not closed.`,
      tone: null,
    },
    {
      label: "Blocked by another",
      value: String(acct.blockedInBook + acct.orderDifferences),
      title:
        `Signals the book refused because another playbook held the contract, or the daily limit was reached: ` +
        `${acct.blockedInBook} where live did not enter either, ${acct.orderDifferences} where live did.`,
      tone: null,
    },
    {
      label: "Contests",
      value: String(acct.run?.contests ?? acct.contestedDifferences),
      title:
        "Bars where two playbooks signalled on the same contract, so which went first decided who entered. " +
        `${acct.contestedDifferences} of the differences below were decided that way.`,
      tone: null,
    },
    {
      label: "Avg slippage",
      value: averageSlippageWords(acct.avgFillSlippageTicks),
      title: "Live fill against the book's price, in ticks, over matched entries. Worse means live paid more on a long or got less on a short.",
      tone: null,
    },
    {
      label: "Worst slippage",
      value: slippageWords(acct.worstFillSlippageTicks),
      title: "The worst live fill against the book's price among matched entries.",
      tone: null,
    },
    {
      label: "Live P&L",
      value: liveCents == null ? DASH : formatCents(liveCents),
      title:
        liveCents == null
          ? "Live P&L was not saved with this day's run."
          : "Net of fees, every closed live trade on this account in the session.",
      tone: toneOf(liveCents),
    },
    {
      label: "Book P&L",
      value: bookCents == null ? DASH : formatCents(bookCents),
      title: bookCents == null ? "The book run's summary was not readable." : "Net of fees, every trade the book took in the session.",
      tone: toneOf(bookCents),
    },
  ];
  return { key, title, refusal: null, notes, tiles, charts, groups, rows };
}

function legView(leg: PlaybookLegFiles, files: ParityDayFiles, windows: LogWindow[], playbooks: PlaybookNames): LegView {
  // A leg has a table and no chart, so its tooltips have nothing to hang on.
  const tips: Record<string, Tip> = {};
  const title = playbookLabel(playbooks, leg, leg.accountId);
  const notes = leg.seamWarning == null ? [] : [leg.seamWarning];
  if (leg.compare == null) {
    return { title, refusal: leg.refusal ?? "No reason was recorded.", notes, tiles: [], items: [], rows: [] };
  }
  const unclosedBars = new Set(leg.unclosed.map((u) => msOf(u.signalBarTs)));
  const runTrades = leg.run?.trades ?? [];
  const built = buildCell(
    {
      accountId: leg.accountId,
      deploymentId: leg.deploymentId,
      ticker: leg.ticker,
      compare: leg.compare,
      missed: leg.compare.backtestOnly.filter((r) => !unclosedBars.has(msOf(r.signalBarTs))),
      excused: [],
      extra: leg.compare.liveOnly,
      orderDifferences: [],
      blockedInBook: [],
      notCompared: [],
      inBook: true,
      unclosed: leg.unclosed,
      endOfDataTrades: [],
      endOfDataCount: 0,
    },
    {
      key: `p${last4(leg.deploymentId)}`,
      backtestWord: "the backtest",
      names: new Map([[leg.deploymentId, title]]),
      liveById: liveIndex(files.live),
      runTradeById: new Map(runTrades.map((t) => [t.tradeId, t])),
      sessionEndMs: sessionEndUtc(files.date).getTime(),
      tips,
      logs: files.logs,
      windows,
    },
  );
  return {
    title,
    refusal: null,
    notes,
    tiles: [
      { label: "Matched", value: String(leg.matched), title: "Entries live and this playbook's own backtest both took.", tone: null },
      { label: "Missed", value: String(leg.backtestOnly), title: "Entries the backtest took that live did not.", tone: null },
      { label: "Extra", value: String(leg.liveOnly), title: "Entries live took that the backtest did not.", tone: null },
      { label: "Not closed", value: String(leg.liveNotClosed), title: "Live trades of the session that are not closed, not compared.", tone: null },
      { label: "Avg slippage", value: averageSlippageWords(leg.avgFillSlippageTicks), title: "Live fill against the backtest's price, in ticks.", tone: null },
    ],
    items: built.items,
    rows: built.rows,
  };
}

export function buildReportView(files: ParityDayFiles, playbooks: PlaybookNames): ReportView {
  const tips: Record<string, Tip> = {};
  const notes: string[] = [];
  if (files.live == null) notes.push(LIVE_DETAIL_MISSING);
  if (files.logs == null) notes.push(LOGS_MISSING);
  else if (files.logs.unavailable != null) notes.push(files.logs.unavailable);
  const windows: LogWindow[] = [];
  const accounts = files.book?.map((a) => accountView(a, files, tips, windows, playbooks)) ?? null;
  const legs = files.playbook?.map((l) => legView(l, files, windows, playbooks)) ?? null;
  return {
    date: files.date,
    notes,
    notesMarkdown: files.notes,
    irregularities:
      files.logs == null || files.logs.unavailable != null ? null : irregularities(files.logs, windows, playbooks),
    accounts,
    legs,
    tips,
  };
}

export const IRREGULARITIES_HEADING = "Engine warnings and errors";
export const IRREGULARITIES_LEAD =
  "What live logged as a warning or an error for these playbooks, their accounts and the engine in the session, " +
  "outside every difference — what the comparison cannot see.";

/** `summary.md`'s closing section: the lines, or "None.", under the lead and
 *  any caveat about how they were picked. */
export function irregularitiesMarkdown(sessionDate: string, lines: readonly string[], caveat: string | null): string {
  return [
    `# ${IRREGULARITIES_HEADING}, session ${sessionDate}`,
    "",
    IRREGULARITIES_LEAD,
    ...(caveat == null ? [] : ["", caveat]),
    "",
    ...(lines.length === 0 ? ["None."] : lines.map((l) => `- ${l}`)),
    "",
  ].join("\n");
}

/** `09:50:00 ET · Opening Range Breakout (capped) — MNQ (deployment …1942, account …9820) · entry_order_rejected (error): …` */
export function irregularities(logs: ParityLogsFile, windows: readonly LogWindow[], playbooks: PlaybookNames): string[] {
  const legs = new Map(logs.legs.map((l) => [l.deploymentId, l]));
  return irregularLines(logs, windows).map((line) => {
    const leg = line.deploymentId == null ? null : legs.get(line.deploymentId);
    const subject =
      leg != null
        ? playbookLabel(playbooks, leg, leg.accountId)
        : line.deploymentId != null
          ? `deployment …${last4(line.deploymentId)}`
          : line.accountId != null
            ? `Account …${last4(line.accountId)}`
            : "the engine";
    return logLineText(line, subject);
  });
}

// ── The index ────────────────────────────────────────────────────────────

export interface IndexRow {
  date: string;
  /** Null when the day could not be read; `note` says why. */
  accounts: number | null;
  matched: number | null;
  missed: number | null;
  extra: number | null;
  blocked: number | null;
  livePnl: string;
  livePnlTone: Tone;
  bookPnl: string;
  bookPnlTone: Tone;
  note: string | null;
  /** The day has a `notes.md`. */
  hasNotes: boolean;
}

export function indexRow(files: ParityDayFiles): IndexRow {
  const book = files.book?.filter((a) => a.cells != null) ?? null;
  const sum = (pick: (a: BookAccountFiles) => number): number | null =>
    book == null ? null : book.reduce((n, a) => n + pick(a), 0);
  const liveCents =
    files.live == null ? null : sumCents(files.live.trades.filter((t) => t.status === "closed").map((t) => t.pnlDollars));
  const bookCents =
    book == null || book.some((a) => a.run?.netDollars == null)
      ? null
      : book.reduce((n, a) => n + toCents(a.run?.netDollars ?? 0), 0);
  const refused = files.book?.filter((a) => a.cells == null).length ?? 0;
  return {
    date: files.date,
    accounts: book?.length ?? null,
    matched: sum((a) => a.matched),
    missed: sum((a) => a.missed),
    extra: sum((a) => a.extra),
    blocked: sum((a) => a.blockedInBook + a.orderDifferences),
    livePnl: liveCents == null ? DASH : formatCents(liveCents),
    livePnlTone: toneOf(liveCents),
    bookPnl: bookCents == null ? DASH : formatCents(bookCents),
    bookPnlTone: toneOf(bookCents),
    note:
      files.book == null
        ? "No book comparison for this day."
        : refused > 0
          ? `${refused} account${refused === 1 ? " was" : "s were"} not compared.`
          : null,
    hasNotes: files.notes != null,
  };
}
