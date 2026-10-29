/**
 * What the parity report reads, and the two files `parity-day` writes so a
 * report can be rebuilt from the date directory alone — no database, no bar
 * cache, no Topstep:
 *
 * - `live.json` at the date's root: the session's live trades (every status)
 *   and skips, the fields the report draws. `compare.json` carries only what
 *   the join reads, so without it a live exit has no price, time or P&L.
 * - `session-bars.json` in each run directory: the session's bars as that run
 *   read them, compact. The archive may not hold the session at all (the
 *   Topstep tail served it), so the cache cannot stand in for it later.
 * - `logs.json` at the date's root: the engine's lines for the session's legs
 *   (`parity-logs.ts`), so a difference shows what live logged around it.
 *
 * `notes.md` is read too, and is the one file here nothing in this CLI writes.
 *
 * Every file is our own, but a date directory outlives the build that wrote
 * it, so each field is checked as it is read and a missing one names itself.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { BarData } from "@/lib/brokers/types";
import { parseDbInstant } from "@/lib/trading/backtest-book-snapshot";
import { sessionDateOf } from "@/lib/trading/regime/session-dates";
import type { LiveLeg } from "./parity-day";
import { LOGS_FILE, type ParityLogsFile } from "./parity-logs";

export const LIVE_FILE = "live.json";
export const SESSION_BARS_FILE = "session-bars.json";
export const REPORT_FILE = "report.html";
/** Written by a person or an agent investigating the day, appended to over
 *  time; never written by `parity-day` or `parity-report`, only rendered. */
export const NOTES_FILE = "notes.md";
export const INDEX_FILE = "index.html";
const COMPARE_FILE = "compare.json";
const SUMMARY_FILE = "summary.md";
const BOOK_DIR = "book";
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;

// ── Written by parity-day ────────────────────────────────────────────────

export interface LiveTradeRecord {
  id: number;
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  ticker: string;
  side: number;
  size: number;
  status: string;
  signalBarTs: string | null;
  entryPrice: number | null;
  entryFilledAt: string | null;
  exitPrice: number | null;
  exitFilledAt: string | null;
  exitReasonCode: string | null;
  /** Net of fees, as the trade row records it. */
  pnlDollars: number | null;
  entrySlippageTicks: number | null;
}

export interface LiveSkipRecord {
  deploymentId: string;
  signalBarTs: string;
  gate: string;
  reason: string;
}

export interface LiveRecordFile {
  sessionDate: string;
  trades: LiveTradeRecord[];
  skips: LiveSkipRecord[];
}

/** A stored instant as ISO, or null when it is absent or not an instant. */
function isoOrNull(value: string | null): string | null {
  if (value == null) return null;
  const at = parseDbInstant(value);
  return Number.isFinite(at.getTime()) ? at.toISOString() : null;
}

export function liveRecord(sessionDate: string, legs: readonly LiveLeg[]): LiveRecordFile {
  return {
    sessionDate,
    trades: legs.flatMap((leg) =>
      [...leg.trades, ...leg.unclosed].map((t) => ({
        id: t.id,
        deploymentId: t.deploymentId,
        accountId: t.accountId,
        strategyKey: t.strategyKey,
        ticker: t.ticker,
        side: t.side,
        size: t.size,
        status: t.status,
        signalBarTs: isoOrNull(t.signalBarTs),
        entryPrice: t.entryPrice,
        entryFilledAt: isoOrNull(t.entryFilledAt),
        exitPrice: t.exitPrice,
        exitFilledAt: isoOrNull(t.exitFilledAt),
        exitReasonCode: t.exitReasonCode,
        pnlDollars: t.pnlDollars,
        entrySlippageTicks: t.entrySlippageTicks,
      })),
    ),
    skips: legs.flatMap((leg) =>
      leg.skips.map((s) => ({ deploymentId: s.deploymentId, signalBarTs: s.signalBarTs, gate: s.gate, reason: s.reason })),
    ),
  };
}

/** `[epoch ms, open, high, low, close]` — a session of 1m bars is ~1,400 of these. */
export type CompactBar = [number, number, number, number, number];
const COMPACT_BAR_LENGTH = 5;

export interface SessionBarSeries {
  /** Bare, `MNQ`. */
  ticker: string;
  timeframe: string;
  bars: CompactBar[];
}

export interface SessionBarsFile {
  sessionDate: string;
  series: SessionBarSeries[];
}

/** The bars of `sessionDate` only; the warmup is not the report's. */
export function sessionBarSeries(
  ticker: string,
  timeframe: string,
  bars: readonly BarData[],
  sessionDate: string,
): SessionBarSeries {
  return {
    ticker: ticker.replace(/^\//, ""),
    timeframe,
    bars: bars
      .filter((bar) => sessionDateOf(new Date(bar.timestamp)) === sessionDate)
      .map((bar) => [Date.parse(bar.timestamp), bar.open, bar.high, bar.low, bar.close]),
  };
}

/** Unindented: a pretty-printed session is one number per line. Nothing is
 *  written for a run whose bars were never seen. */
export function writeSessionBars(dir: string, file: SessionBarsFile): void {
  if (file.series.every((s) => s.bars.length === 0)) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SESSION_BARS_FILE), `${JSON.stringify(file)}\n`, "utf8");
}

// ── Read back ────────────────────────────────────────────────────────────

export class ReportDataError extends Error {}

/** A checked walk over parsed JSON: a wrong type names the path it was at. */
export class Field {
  constructor(
    private readonly value: unknown,
    readonly at: string,
  ) {}

  private fail(expected: string): never {
    throw new ReportDataError(`${this.at}: expected ${expected}, found ${JSON.stringify(this.value) ?? "nothing"}`);
  }

  private record(): Record<string, unknown> {
    if (typeof this.value !== "object" || this.value === null || Array.isArray(this.value)) this.fail("an object");
    return this.value as Record<string, unknown>;
  }

  key(name: string): Field {
    return new Field(this.record()[name], `${this.at}.${name}`);
  }

  /** The key's field, or null when it is absent or null. */
  optional(name: string): Field | null {
    const v = this.record()[name];
    return v == null ? null : new Field(v, `${this.at}.${name}`);
  }

  isNull(): boolean {
    return this.value == null;
  }

  num(): number {
    if (typeof this.value !== "number" || !Number.isFinite(this.value)) this.fail("a number");
    return this.value;
  }

  str(): string {
    if (typeof this.value !== "string") this.fail("text");
    return this.value;
  }

  bool(): boolean {
    if (typeof this.value !== "boolean") this.fail("true or false");
    return this.value;
  }

  numOrNull(): number | null {
    return this.value == null ? null : this.num();
  }

  strOrNull(): string | null {
    return this.value == null ? null : this.str();
  }

  list(): Field[] {
    if (!Array.isArray(this.value)) this.fail("a list");
    return this.value.map((v, i) => new Field(v, `${this.at}[${i}]`));
  }
}

function readJsonFile(file: string): Field | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  try {
    return new Field(JSON.parse(text), path.basename(file));
  } catch (err) {
    throw new ReportDataError(`${file} is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readJsonlFile(file: string): Field[] | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, i) => {
      try {
        return new Field(JSON.parse(line), `${path.basename(file)} line ${i + 1}`);
      } catch {
        throw new ReportDataError(`${file} line ${i + 1} is not JSON`);
      }
    });
}

export interface LiveRow {
  tradeId: number;
  side: number;
  signalBarTs: string | null;
  entryPrice: number | null;
  exitReason: string | null;
}

export interface MatchedRow {
  signalBarTs: string;
  side: number;
  liveTradeId: number;
  backtestTradeId: number;
  liveEntryPrice: number | null;
  backtestEntryPrice: number;
  fillSlippageTicks: number | null;
  liveExitReason: string | null;
  backtestExitReason: string;
  exitReasonAgreement: boolean;
}

export interface BacktestOnlyRow {
  tradeId: number;
  signalBarTs: string;
  side: number;
  entryPrice: number;
  exitReason: string;
  liveSkipReason: string | null;
}

export interface CompareRows {
  matched: MatchedRow[];
  liveOnly: Array<LiveRow & { reason: string }>;
  liveUnjoinable: LiveRow[];
  backtestOnly: BacktestOnlyRow[];
}

export interface BlockedRow {
  deploymentId: string;
  signalBarTs: string;
  gate: string;
  holderDeploymentId: string | null;
  contested: boolean;
  releaseSensitive: boolean;
}

export interface BookCellRows {
  deploymentId: string;
  strategyKey: string;
  ticker: string;
  inBook: boolean;
  compare: CompareRows;
  notCompared: Array<{ live: LiveRow; reason: string }>;
  missed: BacktestOnlyRow[];
  excused: Array<{ row: BacktestOnlyRow; contested: boolean; releaseSensitive: boolean }>;
  endOfData: number;
  extra: Array<LiveRow & { reason: string }>;
  orderDifferences: Array<{ live: LiveRow; block: BlockedRow }>;
  blockedInBook: BlockedRow[];
}

/** One `trades.jsonl` row, the fields the report draws. */
export interface RunTrade {
  tradeId: number;
  /** Set on a book run's rows only. */
  deploymentId: string | null;
  signalBarTs: string;
  side: number;
  contracts: number;
  entryPrice: number;
  exitTs: string;
  exitPrice: number;
  exitReason: string;
  pnlNetDollars: number;
  endOfData: boolean;
}

export interface RunFiles {
  trades: RunTrade[] | null;
  bars: SessionBarSeries[];
}

export interface BookAccountFiles {
  accountId: number;
  status: string;
  refusal: string | null;
  cellIds: string[];
  matched: number;
  missed: number;
  excused: number;
  extra: number;
  orderDifferences: number;
  blockedInBook: number;
  contestedDifferences: number;
  endOfData: number;
  liveNotCompared: number;
  liveUnjoinable: number;
  liveNotClosed: number;
  avgFillSlippageTicks: number | null;
  worstFillSlippageTicks: number | null;
  seamWarnings: string[];
  cells: BookCellRows[] | null;
  run: (RunFiles & {
    /** Evaluation order, with each cell's timeframe. */
    cells: Array<{ deploymentId: string; strategyKey: string; ticker: string; timeframe: string }>;
    netDollars: number | null;
    contests: number | null;
    blocked: BlockedRow[] | null;
  }) | null;
}

export interface PlaybookLegFiles {
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  ticker: string;
  status: string;
  refusal: string | null;
  matched: number;
  liveOnly: number;
  backtestOnly: number;
  liveNotClosed: number;
  avgFillSlippageTicks: number | null;
  worstFillSlippageTicks: number | null;
  seamWarning: string | null;
  unclosed: Array<{ tradeId: number; status: string; signalBarTs: string | null }>;
  compare: CompareRows | null;
  run: RunFiles | null;
}

export interface ParityDayFiles {
  date: string;
  playbook: PlaybookLegFiles[] | null;
  book: BookAccountFiles[] | null;
  live: LiveRecordFile | null;
  /** Null on a day recorded before `logs.json` existed. */
  logs: ParityLogsFile | null;
  /** `notes.md` as written; null when the day has none. */
  notes: string | null;
}

function liveRow(f: Field): LiveRow {
  return {
    tradeId: f.key("tradeId").num(),
    side: f.key("side").num(),
    signalBarTs: f.key("signalBarTs").strOrNull(),
    entryPrice: f.key("entryPrice").numOrNull(),
    exitReason: f.key("exitReason").strOrNull(),
  };
}

function backtestOnlyRow(f: Field): BacktestOnlyRow {
  return {
    tradeId: f.key("tradeId").num(),
    signalBarTs: f.key("signalBarTs").str(),
    side: f.key("side").num(),
    entryPrice: f.key("entryPrice").num(),
    exitReason: f.key("exitReason").str(),
    liveSkipReason: f.key("liveSkipReason").strOrNull(),
  };
}

function blockedRow(f: Field): BlockedRow {
  return {
    deploymentId: f.key("deploymentId").str(),
    signalBarTs: f.key("signalBarTs").str(),
    gate: f.key("gate").str(),
    holderDeploymentId: f.key("holderDeploymentId").strOrNull(),
    contested: f.key("contested").bool(),
    releaseSensitive: f.key("releaseSensitive").bool(),
  };
}

function compareRows(f: Field): CompareRows {
  return {
    matched: f.key("matched").list().map((m) => ({
      signalBarTs: m.key("signalBarTs").str(),
      side: m.key("side").num(),
      liveTradeId: m.key("liveTradeId").num(),
      backtestTradeId: m.key("backtestTradeId").num(),
      liveEntryPrice: m.key("liveEntryPrice").numOrNull(),
      backtestEntryPrice: m.key("backtestEntryPrice").num(),
      fillSlippageTicks: m.key("fillSlippageTicks").numOrNull(),
      liveExitReason: m.key("liveExitReason").strOrNull(),
      backtestExitReason: m.key("backtestExitReason").str(),
      exitReasonAgreement: m.key("exitReasonAgreement").bool(),
    })),
    liveOnly: f.key("liveOnly").list().map((l) => ({ ...liveRow(l), reason: l.key("reason").str() })),
    liveUnjoinable: f.key("liveUnjoinable").list().map(liveRow),
    backtestOnly: f.key("backtestOnly").list().map(backtestOnlyRow),
  };
}

function bookCellRows(f: Field): BookCellRows {
  return {
    deploymentId: f.key("deploymentId").str(),
    strategyKey: f.key("strategyKey").str(),
    ticker: f.key("ticker").str(),
    inBook: f.key("inBook").bool(),
    compare: compareRows(f.key("compare")),
    notCompared: f.key("notCompared").list().map((n) => ({ live: liveRow(n.key("live")), reason: n.key("reason").str() })),
    missed: f.key("missed").list().map(backtestOnlyRow),
    excused: f.key("excused").list().map((e) => ({
      row: backtestOnlyRow(e.key("row")),
      contested: e.key("contested").bool(),
      releaseSensitive: e.key("releaseSensitive").bool(),
    })),
    endOfData: f.key("endOfData").num(),
    extra: f.key("extra").list().map((l) => ({ ...liveRow(l), reason: l.key("reason").str() })),
    orderDifferences: f.key("orderDifferences").list().map((d) => ({
      live: liveRow(d.key("live")),
      block: blockedRow(d.key("block")),
    })),
    blockedInBook: f.key("blockedInBook").list().map(blockedRow),
  };
}

function runTrade(f: Field): RunTrade {
  return {
    tradeId: f.key("tradeId").num(),
    deploymentId: f.optional("deploymentId")?.str() ?? null,
    signalBarTs: f.key("signalBarTs").str(),
    side: f.key("side").num(),
    contracts: f.key("contracts").num(),
    entryPrice: f.key("entryPrice").num(),
    exitTs: f.key("exitTs").str(),
    exitPrice: f.key("exitPrice").num(),
    exitReason: f.key("exitReason").str(),
    pnlNetDollars: f.key("pnlNetDollars").num(),
    endOfData: f.optional("endOfData")?.bool() ?? false,
  };
}

function sessionBars(dir: string): SessionBarSeries[] {
  const file = readJsonFile(path.join(dir, SESSION_BARS_FILE));
  if (file == null) return [];
  return file
    .key("series")
    .list()
    .map((s) => ({
      ticker: s.key("ticker").str(),
      timeframe: s.key("timeframe").str(),
      bars: s
        .key("bars")
        .list()
        .map((b): CompactBar => {
          const n = b.list().map((v) => v.num());
          if (n.length !== COMPACT_BAR_LENGTH) throw new ReportDataError(`${b.at}: expected five numbers`);
          return [n[0], n[1], n[2], n[3], n[4]];
        }),
    }));
}

function runFiles(dir: string): RunFiles | null {
  if (!existsSync(dir)) return null;
  return { trades: readJsonlFile(path.join(dir, "trades.jsonl"))?.map(runTrade) ?? null, bars: sessionBars(dir) };
}

function liveFile(f: Field): LiveRecordFile {
  return {
    sessionDate: f.key("sessionDate").str(),
    trades: f
      .key("trades")
      .list()
      .map((t) => ({
        id: t.key("id").num(),
        deploymentId: t.key("deploymentId").str(),
        accountId: t.key("accountId").num(),
        strategyKey: t.key("strategyKey").str(),
        ticker: t.key("ticker").str(),
        side: t.key("side").num(),
        size: t.key("size").num(),
        status: t.key("status").str(),
        signalBarTs: t.key("signalBarTs").strOrNull(),
        entryPrice: t.key("entryPrice").numOrNull(),
        entryFilledAt: t.key("entryFilledAt").strOrNull(),
        exitPrice: t.key("exitPrice").numOrNull(),
        exitFilledAt: t.key("exitFilledAt").strOrNull(),
        exitReasonCode: t.key("exitReasonCode").strOrNull(),
        pnlDollars: t.key("pnlDollars").numOrNull(),
        entrySlippageTicks: t.key("entrySlippageTicks").numOrNull(),
      })),
    skips: f
      .key("skips")
      .list()
      .map((s) => ({
        deploymentId: s.key("deploymentId").str(),
        signalBarTs: s.key("signalBarTs").str(),
        gate: s.key("gate").str(),
        reason: s.key("reason").str(),
      })),
  };
}

function playbookLegs(dateDir: string): PlaybookLegFiles[] | null {
  const file = readJsonFile(path.join(dateDir, COMPARE_FILE));
  if (file == null) return null;
  return file
    .key("legs")
    .list()
    .map((leg) => {
      const runDir = leg.key("runDir").strOrNull();
      const compare = leg.optional("compare");
      return {
        deploymentId: leg.key("deploymentId").str(),
        accountId: leg.key("accountId").num(),
        strategyKey: leg.key("strategyKey").str(),
        ticker: leg.key("ticker").str(),
        status: leg.key("status").str(),
        refusal: leg.key("refusal").strOrNull(),
        matched: leg.key("matched").num(),
        liveOnly: leg.key("liveOnly").num(),
        backtestOnly: leg.key("backtestOnly").num(),
        liveNotClosed: leg.key("liveNotClosed").num(),
        avgFillSlippageTicks: leg.key("avgFillSlippageTicks").numOrNull(),
        worstFillSlippageTicks: leg.key("worstFillSlippageTicks").numOrNull(),
        seamWarning: leg.key("seamWarning").strOrNull(),
        unclosed: (leg.optional("unclosed")?.list() ?? []).map((u) => ({
          tradeId: u.key("tradeId").num(),
          status: u.key("status").str(),
          // Written as the trade row spells it, which may be SQLite's
          // `YYYY-MM-DD HH:MM:SS` — UTC that `Date.parse` reads as local.
          signalBarTs: isoOrNull(u.key("signalBarTs").strOrNull()),
        })),
        compare: compare == null ? null : compareRows(compare),
        // The recorded path is where the run was written; the directory may
        // since have moved (a different mount), so it is found by name here.
        run: runDir == null ? null : runFiles(path.join(dateDir, path.basename(runDir))),
      };
    });
}

function bookAccounts(dateDir: string): BookAccountFiles[] | null {
  const file = readJsonFile(path.join(dateDir, BOOK_DIR, COMPARE_FILE));
  if (file == null) return null;
  return file
    .key("accounts")
    .list()
    .map((acct) => {
      const accountId = acct.key("accountId").num();
      const compare = acct.optional("compare");
      const runDir = path.join(dateDir, BOOK_DIR, String(accountId));
      const runJson = acct.key("runDir").isNull() ? null : readJsonFile(path.join(runDir, "run.json"));
      const files = runJson == null ? null : runFiles(runDir);
      return {
        accountId,
        status: acct.key("status").str(),
        refusal: acct.key("refusal").strOrNull(),
        cellIds: acct.key("cells").list().map((c) => c.str()),
        matched: acct.key("matched").num(),
        missed: acct.key("missed").num(),
        excused: acct.key("excused").num(),
        extra: acct.key("extra").num(),
        orderDifferences: acct.key("orderDifferences").num(),
        blockedInBook: acct.key("blockedInBook").num(),
        contestedDifferences: acct.key("contestedDifferences").num(),
        endOfData: acct.key("endOfData").num(),
        liveNotCompared: acct.key("liveNotCompared").num(),
        liveUnjoinable: acct.key("liveUnjoinable").num(),
        liveNotClosed: acct.key("liveNotClosed").num(),
        avgFillSlippageTicks: acct.key("avgFillSlippageTicks").numOrNull(),
        worstFillSlippageTicks: acct.key("worstFillSlippageTicks").numOrNull(),
        seamWarnings: acct.key("seamWarnings").list().map((w) => w.str()),
        cells: compare == null ? null : compare.list().map(bookCellRows),
        run:
          runJson == null || files == null
            ? null
            : {
                ...files,
                cells: runJson
                  .key("header")
                  .key("cells")
                  .list()
                  .map((c) => ({
                    deploymentId: c.key("deploymentId").str(),
                    strategyKey: c.key("strategyKey").str(),
                    ticker: c.key("ticker").str(),
                    timeframe: c.key("timeframe").str(),
                  })),
                netDollars: runJson.optional("summary")?.optional("book")?.optional("netDollars")?.num() ?? null,
                contests: runJson.key("header").optional("contests")?.list().length ?? null,
                blocked: readJsonlFile(path.join(runDir, "blocked.jsonl"))?.map(blockedRow) ?? null,
              },
      };
    });
}

/** Everything a date directory holds that the report draws. `date` is passed
 *  because a run reads its own staging directory, whose name is not the date. */
export function loadParityDay(dateDir: string, date: string, warn: (message: string) => void = stderrWarn): ParityDayFiles {
  const live = readJsonFile(path.join(dateDir, LIVE_FILE));
  const logs = readJsonFile(path.join(dateDir, LOGS_FILE));
  return {
    date,
    playbook: playbookLegs(dateDir),
    book: bookAccounts(dateDir),
    live: live == null ? null : liveFile(live),
    logs: logs == null ? null : logsFile(logs),
    notes: readNotes(dateDir, warn),
  };
}

function stderrWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Someone else's file: one that cannot be read (a folder of that name, no
 *  permission) costs the page its notes and a warning, never the page. */
export function readNotes(dateDir: string, warn: (message: string) => void = stderrWarn): string | null {
  const file = path.join(dateDir, NOTES_FILE);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    warn(`${file} could not be read, so the page has no notes: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function logsFile(f: Field): ParityLogsFile {
  return {
    sessionDate: f.key("sessionDate").str(),
    unavailable: f.key("unavailable").strOrNull(),
    legs: f
      .key("legs")
      .list()
      .map((l) => ({
        deploymentId: l.key("deploymentId").str(),
        accountId: l.key("accountId").num(),
        strategyKey: l.key("strategyKey").str(),
        ticker: l.key("ticker").str(),
        barMinutes: l.key("barMinutes").numOrNull(),
      })),
    lines: f
      .key("lines")
      .list()
      .map((l) => ({
        at: l.key("at").str(),
        deploymentId: l.key("deploymentId").strOrNull(),
        accountId: l.key("accountId").numOrNull(),
        severity: l.key("severity").str(),
        event: l.key("event").strOrNull(),
        message: l.key("message").str(),
      })),
  };
}

/** `summary.md`, for the fallback page; null when the day has none. */
export function readSummary(dateDir: string): string | null {
  const file = path.join(dateDir, SUMMARY_FILE);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/** The committed date directories under the parity root, newest first. */
export function listParityDates(parityRoot: string): string[] {
  if (!existsSync(parityRoot)) return [];
  return readdirSync(parityRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && DATE_DIR.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}
