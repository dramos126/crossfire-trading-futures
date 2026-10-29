/**
 * `compare` — joins a live trades export to a finished run by signal bar.
 *
 * The monthly review's parity check, automated. It compares **signals, not
 * fills**: `(strategyKey, ticker, signalBarTs)` is the key, because the
 * backtest fills at the close of the bar `shouldEnter` fired on and the live
 * row records that same bar, so the two agree exactly or the entry genuinely
 * differed. Wall-clock entry times never agree and are not asked to.
 *
 * A backtest entry with no live counterpart is reported with
 * `liveSkipReason: null` — an export file carries no skips, so "the lock
 * took it", "the daily loss gate was closed" and "the engine was down" are
 * indistinguishable from here. `parity-day`, which reads `skipped_signals`,
 * fills the field through `attachLiveSkipReasons`; this command reports
 * rather than concludes.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";
import { RENAMED_KEYS } from "@/lib/trading/strategies/renamed-keys";
import { CliError } from "../cli-error";

export interface LiveTrade {
  tradeId: number;
  strategyKey: string;
  ticker: string;
  side: number;
  signalBarTs: string | null;
  entryPrice: number | null;
  exitReason: string | null;
}

/** The `trades.jsonl` fields the join reads. A finished run's row satisfies
 *  it structurally; the reader below builds one field by field so a stale
 *  file fails on the field it is missing rather than arriving as `NaN`. */
export interface BacktestTradeRow {
  tradeId: number;
  signalBarTs: string;
  sessionDate: string;
  side: number;
  entryPrice: number;
  exitReason: string;
}

/** Why a live row has no backtest counterpart. `duplicate_signal_bar` is a
 *  second live leg on a signal bar the run entered once — a real event on a
 *  multi-leg deployment, and not the same finding as a missing entry. */
export type LiveOnlyReason = "no_backtest_entry" | "duplicate_signal_bar";

export interface LiveOnlyTrade extends LiveTrade {
  reason: LiveOnlyReason;
}

export interface MatchedTrade {
  signalBarTs: string;
  side: number;
  liveTradeId: number;
  backtestTradeId: number;
  liveEntryPrice: number | null;
  backtestEntryPrice: number;
  /** Live entry against the backtest's signal-bar close, **signed so a
   *  positive number is the worse fill** — paid up on a long, sold down on a
   *  short. Null when the live row never recorded a fill price. */
  fillSlippageTicks: number | null;
  liveExitReason: string | null;
  backtestExitReason: string;
  exitReasonAgreement: boolean;
}

export interface CompareResult {
  matched: MatchedTrade[];
  /** Live rows the run has no entry for, in export order, each carrying why. */
  liveOnly: LiveOnlyTrade[];
  /** Live rows written before `signal_bar_ts` existed. Held apart from
   *  `liveOnly` so a pre-column month does not read as drift. */
  liveUnjoinable: LiveTrade[];
  backtestOnly: Array<{
    tradeId: number;
    signalBarTs: string;
    sessionDate: string;
    side: number;
    entryPrice: number;
    exitReason: string;
    /** The live `skipped_signals` rows on the same deployment and signal bar,
     *  as `gate: reason`, joined with `; ` when several gates refused it.
     *  Always null under `compare`, which reads an export and no skip table;
     *  `parity-day` fills it from the database. */
    liveSkipReason: string | null;
  }>;
  /** Backtest entries on bars that closed before the deployment was created,
   *  set aside from `backtestOnly` because live could not have taken them.
   *  Only `parity-day` fills it; `compare` has no creation time. */
  beforeCreation?: {
    createdAt: string;
    entries: CompareResult["backtestOnly"];
  };
  summary: {
    matched: number;
    liveOnly: number;
    liveUnjoinable: number;
    backtestOnly: number;
    exitReasonAgreement: number;
    avgFillSlippageTicks: number;
    worstFillSlippageTicks: number;
  };
}

export interface CompareArgs {
  runDir: string;
  livePath: string;
}

export function parseCompareArgs(argv: string[]): CompareArgs {
  let runDir: string | null = null;
  let livePath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = splitInline(argv[i]);
    const value = inline ?? argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new CliError(`Flag "${flag}" needs a value`);
    }
    if (flag === "--run") runDir = value;
    else if (flag === "--live") livePath = value;
    else throw new CliError(`Unknown flag "${flag}". compare takes --run and --live`);
  }
  if (runDir == null) throw new CliError("Missing required flag --run");
  if (livePath == null) throw new CliError("Missing required flag --live");
  return { runDir: path.resolve(runDir), livePath: path.resolve(livePath) };
}

function splitInline(token: string): [string, string | null] {
  const eq = token.indexOf("=");
  return eq === -1 ? [token, null] : [token.slice(0, eq), token.slice(eq + 1)];
}

export async function compareCommand(argv: string[]): Promise<string> {
  const args = parseCompareArgs(argv);
  const header = await readRunHeader(args.runDir);
  const records = await readTradeRecords(args.runDir);
  const live = filterLive(await readLiveExport(args.livePath), header.playbookKey, header.ticker);

  const result = compareTrades({
    records,
    live,
    tickSize: header.contract.tickSize,
  });

  const file = path.join(args.runDir, "compare.json");
  await fs.writeFile(
    file,
    `${JSON.stringify(
      {
        run: {
          dir: args.runDir,
          playbookKey: header.playbookKey,
          playbookVersion: header.playbookVersion,
          ticker: header.ticker,
          from: header.from,
          to: header.to,
        },
        live: { path: args.livePath, count: live.length },
        ...result,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  process.stdout.write(report(result));
  return args.runDir;
}

/**
 * Pure join. Live rows are keyed on the signal bar's **instant**, not its
 * text: the engine writes ISO-8601 and a hand-assembled export may not, and
 * two spellings of one instant are one bar.
 *
 * One instant can carry several live rows — two legs of one deployment fire
 * on the same signal bar — so the bucket is a list and the match is
 * one-to-one within it. The surplus is reported rather than dropped: a live
 * trade that vanished from every count is the one failure a parity check
 * cannot afford.
 */
export function compareTrades(input: {
  records: BacktestTradeRow[];
  live: LiveTrade[];
  tickSize: number;
}): CompareResult {
  const { records, live, tickSize } = input;
  const liveByInstant = new Map<number, LiveTrade[]>();
  const liveUnjoinable: LiveTrade[] = [];
  for (const trade of live) {
    const instant = instantOf(trade.signalBarTs);
    if (instant == null) {
      liveUnjoinable.push(trade);
      continue;
    }
    const bucket = liveByInstant.get(instant);
    if (bucket) bucket.push(trade);
    else liveByInstant.set(instant, [trade]);
  }

  const matched: MatchedTrade[] = [];
  const backtestOnly: CompareResult["backtestOnly"] = [];
  const matchedPerInstant = new Map<number, number>();

  for (const record of records) {
    const instant = instantOf(record.signalBarTs);
    const taken = instant == null ? 0 : matchedPerInstant.get(instant) ?? 0;
    const counterpart = instant == null ? undefined : liveByInstant.get(instant)?.[taken];
    if (counterpart == null || instant == null) {
      backtestOnly.push({
        tradeId: record.tradeId,
        signalBarTs: record.signalBarTs,
        sessionDate: record.sessionDate,
        side: record.side,
        entryPrice: record.entryPrice,
        exitReason: record.exitReason,
        liveSkipReason: null,
      });
      continue;
    }
    matchedPerInstant.set(instant, taken + 1);
    matched.push({
      signalBarTs: record.signalBarTs,
      side: record.side,
      liveTradeId: counterpart.tradeId,
      backtestTradeId: record.tradeId,
      liveEntryPrice: counterpart.entryPrice,
      backtestEntryPrice: record.entryPrice,
      fillSlippageTicks: slippageTicks(record, counterpart, tickSize),
      liveExitReason: counterpart.exitReason,
      backtestExitReason: record.exitReason,
      exitReasonAgreement: sameExit(counterpart.exitReason, record.exitReason),
    });
  }

  const liveOnly: LiveOnlyTrade[] = [];
  const seenPerInstant = new Map<number, number>();
  for (const trade of live) {
    const instant = instantOf(trade.signalBarTs);
    if (instant == null) continue;
    const index = seenPerInstant.get(instant) ?? 0;
    seenPerInstant.set(instant, index + 1);
    const taken = matchedPerInstant.get(instant) ?? 0;
    if (index < taken) continue;
    liveOnly.push({
      ...trade,
      reason: taken > 0 ? "duplicate_signal_bar" : "no_backtest_entry",
    });
  }

  const slippages = matched
    .map((m) => m.fillSlippageTicks)
    .filter((t): t is number => t != null);

  return {
    matched,
    liveOnly,
    liveUnjoinable,
    backtestOnly,
    summary: {
      matched: matched.length,
      liveOnly: liveOnly.length,
      liveUnjoinable: liveUnjoinable.length,
      backtestOnly: backtestOnly.length,
      exitReasonAgreement:
        matched.length > 0
          ? matched.filter((m) => m.exitReasonAgreement).length / matched.length
          : 0,
      avgFillSlippageTicks:
        slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0,
      worstFillSlippageTicks: slippages.length > 0 ? Math.max(...slippages) : 0,
    },
  };
}

/**
 * The backtest's `entryPrice` **is** the signal bar's close — it fills at
 * that close by construction — so the difference against the live fill is
 * the slippage. Signed with the trade's direction so a positive number is
 * always the worse fill, matching `entry_slippage_ticks` on the trade row.
 */
function slippageTicks(
  record: BacktestTradeRow,
  live: LiveTrade,
  tickSize: number,
): number | null {
  if (live.entryPrice == null) return null;
  const direction: 1 | -1 = record.side === 0 ? 1 : -1;
  return pnlTicksFromPrices(record.entryPrice, live.entryPrice, direction, tickSize);
}

/** The backtest names a strategy's own exit `signal`; live records the same
 *  exit as `strategy_signal`. Every other reason is spelled alike on both. */
const BACKTEST_TO_LIVE_EXIT: Readonly<Record<string, string>> = { signal: "strategy_signal" };

function sameExit(live: string | null, backtest: string): boolean {
  return live === (BACKTEST_TO_LIVE_EXIT[backtest] ?? backtest);
}

function instantOf(value: string | null): number | null {
  if (value == null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** A run and an export saved on either side of a key rename (2026-10-16)
 *  name the same playbook, so both sides are compared by the current key. */
function currentKey(key: string): string {
  return RENAMED_KEYS[key] ?? key;
}

export function filterLive(
  trades: LiveTrade[],
  playbookKey: string | null,
  ticker: string,
): LiveTrade[] {
  const wanted = playbookKey == null ? null : currentKey(playbookKey);
  return trades.filter(
    (trade) =>
      (wanted == null || currentKey(trade.strategyKey) === wanted) && trade.ticker === ticker,
  );
}

interface RunHeader {
  playbookKey: string | null;
  playbookVersion: string | null;
  ticker: string;
  from: string;
  to: string;
  contract: { tickSize: number };
}

async function readRunHeader(runDir: string): Promise<RunHeader> {
  const file = path.join(runDir, "run.json");
  const parsed = await readJson(file);
  const header = isRecord(parsed) ? parsed.header : null;
  if (
    !isRecord(header) ||
    typeof header.ticker !== "string" ||
    !isRecord(header.contract) ||
    typeof header.contract.tickSize !== "number"
  ) {
    throw new CliError(`${file}: not a run header — is --run a backtest run directory?`);
  }
  return {
    playbookKey: typeof header.playbookKey === "string" ? header.playbookKey : null,
    playbookVersion: typeof header.playbookVersion === "string" ? header.playbookVersion : null,
    ticker: header.ticker,
    from: typeof header.from === "string" ? header.from : "",
    to: typeof header.to === "string" ? header.to : "",
    contract: { tickSize: header.contract.tickSize },
  };
}

/**
 * `trades.jsonl` is read the way the header is: checked, not assumed. The
 * file may have been written by an older build or hand-edited, and an absent
 * `entryPrice` reaches the slippage arithmetic as `NaN` and poisons the
 * summary rather than failing.
 */
async function readTradeRecords(runDir: string): Promise<BacktestTradeRow[]> {
  const file = path.join(runDir, "trades.jsonl");
  const text = await readFile(file);
  const lines = text.split("\n");
  const rows: BacktestTradeRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[i]) as unknown;
    } catch {
      throw new CliError(`${file}: line ${i + 1} is not JSON`);
    }
    if (!isRecord(parsed)) {
      throw new CliError(`${file}: line ${i + 1} is not a trade object`);
    }
    rows.push({
      tradeId: requireNumber(parsed.tradeId, file, i + 1, "tradeId"),
      signalBarTs: requireString(parsed.signalBarTs, file, i + 1, "signalBarTs"),
      sessionDate: requireString(parsed.sessionDate, file, i + 1, "sessionDate"),
      side: requireNumber(parsed.side, file, i + 1, "side"),
      entryPrice: requireNumber(parsed.entryPrice, file, i + 1, "entryPrice"),
      exitReason: requireString(parsed.exitReason, file, i + 1, "exitReason"),
    });
  }
  return rows;
}

function requireNumber(value: unknown, file: string, line: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CliError(`${file}: line ${line} has no finite "${field}" — is the run stale?`);
  }
  return value;
}

function requireString(value: unknown, file: string, line: number, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`${file}: line ${line} has no "${field}" — is the run stale?`);
  }
  return value;
}

/**
 * The export route's body, or a bare array of its `trades`. This is the one
 * boundary in the CLI that reads a file it did not write, so the fields the
 * join needs are checked rather than assumed.
 */
async function readLiveExport(livePath: string): Promise<LiveTrade[]> {
  const parsed = await readJson(livePath);
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.trades)
      ? parsed.trades
      : null;
  if (rows == null) {
    throw new CliError(
      `${livePath}: expected the trades export — an array, or an object with a "trades" array`,
    );
  }

  return rows.map((row, i) => {
    if (
      !isRecord(row) ||
      typeof row.tradeId !== "number" ||
      typeof row.strategyKey !== "string" ||
      typeof row.ticker !== "string" ||
      typeof row.side !== "number"
    ) {
      throw new CliError(
        `${livePath}: trade ${i} is missing tradeId, strategyKey, ticker or side`,
      );
    }
    return {
      tradeId: row.tradeId,
      strategyKey: row.strategyKey,
      ticker: row.ticker,
      side: row.side,
      signalBarTs: typeof row.signalBarTs === "string" ? row.signalBarTs : null,
      entryPrice: typeof row.entryPrice === "number" ? row.entryPrice : null,
      exitReason: typeof row.exitReason === "string" ? row.exitReason : null,
    };
  });
}

async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(`${file}: not valid JSON`);
  }
}

async function readFile(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    throw new CliError(`Cannot read ${file}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const DECIMALS = 2;

function report(result: CompareResult): string {
  const { summary } = result;
  const lines = [
    `matched            ${summary.matched}`,
    `live only          ${summary.liveOnly}`,
    `backtest only      ${summary.backtestOnly}`,
    `live unjoinable    ${summary.liveUnjoinable}  (no signal_bar_ts on the row)`,
    "",
    `exit reason agreement  ${summary.exitReasonAgreement.toFixed(DECIMALS)}`,
    `fill slippage ticks    avg ${summary.avgFillSlippageTicks.toFixed(DECIMALS)}  worst ${summary.worstFillSlippageTicks.toFixed(DECIMALS)}  (positive is the worse fill)`,
  ];
  if (summary.backtestOnly > 0) {
    lines.push(
      "",
      "backtest-only entries carry liveSkipReason: null — an export carries no",
      "skips; parity-day reads them from the database.",
    );
  }
  return `${lines.join("\n")}\n`;
}
