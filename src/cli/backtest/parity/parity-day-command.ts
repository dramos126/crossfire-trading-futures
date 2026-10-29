/**
 * `parity-day` — the session that just closed, backtested and compared
 * against what live did, in two modes: each live leg alone (`playbook`), and
 * each account's legs together (`book`). With no `--mode`, both.
 *
 * Written for an unattended 17:15 ET task, so **every way the day could go
 * unmeasured is a non-zero exit**, never a quiet zero-difference line: no
 * database, a snapshot taken before the close, no live leg, no Topstep, a
 * session whose bars do not reach its close. A leg or an account that cannot
 * be compared on its own terms (a module this build does not have, an account
 * with no risk posture, an archive that does not reach its warmup) is recorded
 * as `refused` and also fails the exit, after the rest of the day is written.
 *
 * The operator's database is opened read-only, once, to copy it. Everything
 * after reads the private copy — `listTradesForExport` and the Topstep stack
 * both go through `db/connection.ts`, which opens read-write and migrates —
 * so the snapshot file is never written.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type { StrategyTrade } from "@/lib/db/trade-types";
import type { SkippedSignalRow } from "@/lib/db/skipped-signals";
import type { ParamValues, StrategyModule } from "@/lib/trading/strategy-types";
import { resolveDeploymentParams, resolveTimeframe } from "@/lib/trading/strategy-types";
import { CONTRACT_SPECS, isSpecTicker, type SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { addCalendarDays, sessionStartUtc } from "@/lib/trading/regime/session-dates";
import { artifactRoot } from "@/lib/trading/backtest-artifacts";
import type { BacktestSizing } from "@/lib/trading/backtest";
import type { BookBlockedRecord } from "@/lib/trading/backtest-book";
import {
  SnapshotParamsError,
  readBookSnapshot,
  readPriorActiveDeployments,
  sessionRangeUtc,
  type BookSnapshot,
} from "@/lib/trading/backtest-book-snapshot";
import type { SessionBudget } from "@/lib/trading/orders/account-phase-sizer";
import { loadStrategiesNode } from "@/lib/trading/strategies/load-node";
import { RENAMED_KEYS } from "@/lib/trading/strategies/renamed-keys";
import { CLI_TIMEFRAMES, DEFAULT_WARMUP_SESSION_DAYS, parseArgs, type CliTimeframe } from "../args";
import type { BarTailRecord } from "../bars";
import { runBookOnce, withSourceIdentity, type BookRunInput } from "../commands/book-command";
import { CliError, DayRefusal } from "../cli-error";
import { compareTrades, type BacktestTradeRow, type CompareResult } from "../commands/compare-command";
import { currentGitDirty, currentGitSha, writeFileAtomically, writeJson } from "../output";
import {
  WARMUP_HOLIDAY_SLACK_SESSIONS,
  assertCrossTimeframeExitMeasurable,
  assertInstrumentCalibrated,
  assertSessionMeasurable,
  assertSettingsTakeEntries,
} from "../params";
import {
  bookCounts,
  compareBook,
  renderBookSummary,
  type BookAccountOutcome,
  type BookCellIdentity,
  type BookParityLogLine,
  type BookTradeRow,
} from "./parity-book";
import {
  assertSessionHasBars,
  attachLiveSkipReasons,
  findLiveLegs,
  judgeSnapshot,
  mergeParityLog,
  missedEntries,
  playbookSizingSettingsFromTrades,
  renderSummary,
  riskSizingFromTrades,
  seamWarning,
  setAsideBeforeCreation,
  toLiveTrade,
  type LegOutcome,
  type LiveLeg,
  type ParityArgs,
  type ParityLogLine,
  type ParityMode,
  type PriorActiveRow,
  type SizingBasis,
} from "./parity-day";
import {
  LOGS_FILE,
  logsUnavailable,
  readEngineLogs,
  scopeLogs,
  type LogLeg,
  type ParityLogsFile,
  type SessionLogRead,
} from "./parity-logs";
import {
  Field,
  LIVE_FILE,
  NOTES_FILE,
  REPORT_FILE,
  liveRecord,
  loadParityDay,
  sessionBarSeries,
  writeSessionBars,
  type SessionBarSeries,
} from "./parity-report-data";
import { buildReportView, irregularities, irregularitiesMarkdown } from "./parity-report-model";
import { PARITY_DIR, buildIndexHtml, writeDayReport, writeIndex } from "./parity-report";
import { playbookLabel, playbookNames, type PlaybookNames } from "../playbook-label";
import { runOnce, type RunOnceInput } from "../commands/run-command";
import { pidIsAlive } from "../run-lock";
import { copyAndScrub, readTakenAt, requireDatabase } from "../snapshot-copy";
import type { CpuThrottle } from "../throttle";
import { openTopstepTail, privateDbDir, type TopstepTail } from "../topstep-tail";

const LOG_FILE = "log.jsonl";
const SNAPSHOT_COPY_FILE = "snapshot.db";
/** The book mode's subtree of the date directory: its compare, its summary
 *  section and one run directory per account. */
export const BOOK_DIR = "book";
const SUMMARY_FILE = "summary.md";
const COMPARE_FILE = "compare.json";
/** The playbook mode's summary section, kept so a book-only re-run can
 *  rebuild `summary.md` without re-running the playbooks. */
const PLAYBOOK_SUMMARY_FILE = "summary-playbook.md";

const TIMEFRAME_MINUTES: Readonly<Record<CliTimeframe, number>> = {
  "1m": 1,
  "5m": 5,
  "15m": 15,
  "30m": 30,
};
const MS_PER_MINUTE = 60_000;

/** The app's database modules, read from the private copy. */
export interface ParityDbReads {
  trades: (from: string, to: string) => StrategyTrade[];
  skips: (sessionDate: string) => SkippedSignalRow[];
  paramValues: (deploymentId: string) => ParamValues | null;
  /** The deployment row's `created_at`; null when the row is gone. */
  createdAt: (deploymentId: string) => string | null;
  sessionBudget: (accountId: number, at: Date) => SessionBudget;
}

export interface LegRun {
  records: BacktestTradeRow[];
  barTail: BarTailRecord | null;
}

/** What the comparison reads of one account's book run. */
export interface ParityBookRun {
  cells: BookCellIdentity[];
  trades: BookTradeRow[];
  blocked: BookBlockedRecord[];
  barTail: Record<string, BarTailRecord | null>;
}

export interface ParityDayDeps {
  openTail: (copyPath: string) => Promise<TopstepTail>;
  /** Called only after `openTail`, which points `db/connection.ts` at the copy. */
  openDb: () => Promise<ParityDbReads>;
  loadStrategies: () => Promise<Record<string, StrategyModule>>;
  runLeg: (input: RunOnceInput) => Promise<LegRun>;
  readBook: (args: Parameters<typeof readBookSnapshot>[0]) => BookSnapshot;
  runBook: (input: BookRunInput) => Promise<ParityBookRun>;
  gitState: () => { sha: string | null; dirty: boolean | null };
  /** Registers a synchronous handler for process exit; returns its removal. */
  onExit: (fn: () => void) => () => void;
}

export function nodeParityDayDeps(): ParityDayDeps {
  return {
    openTail: (copyPath) => openTopstepTail(copyPath),
    openDb: async () => {
      const [{ listTradesForExport }, { listSkippedSignals }, { getDeployment }, { resolveSessionPosture }] =
        await Promise.all([
          import("@/lib/db/trades"),
          import("@/lib/db/skipped-signals"),
          import("@/lib/db/deployments"),
          import("@/lib/db/account-brokers"),
        ]);
      return {
        trades: (from, to) => listTradesForExport({ from, to, allStatuses: true }),
        skips: (date) => listSkippedSignals({ fromSessionDate: date, toSessionDate: date }),
        paramValues: (id) => getDeployment(id)?.paramValues ?? null,
        createdAt: (id) => getDeployment(id)?.createdAt ?? null,
        sessionBudget: (accountId, at) => resolveSessionPosture(accountId, at),
      };
    },
    loadStrategies: () => loadStrategiesNode({ includeTest: true }),
    runLeg: async (input) => {
      const { window, loaded } = await runOnce(input);
      return { records: window.records, barTail: loaded.barTail };
    },
    readBook: readBookSnapshot,
    runBook: async (input) => {
      const { result, barTail } = await runBookOnce(input);
      return { cells: result.cells, trades: result.trades, blocked: result.blocked, barTail };
    },
    gitState: () => ({ sha: currentGitSha(), dirty: currentGitDirty() }),
    onExit: (fn) => {
      process.on("exit", fn);
      return () => process.off("exit", fn);
    },
  };
}

export async function parityDayCommand(
  args: ParityArgs,
  throttle: CpuThrottle,
  deps: ParityDayDeps = nodeParityDayDeps(),
): Promise<string> {
  const sourcePath = requireDatabase("parity-day");
  const copyPath = path.join(privateDbDir(), SNAPSHOT_COPY_FILE);
  const snapshot = await copySnapshot(sourcePath, copyPath, args);
  const sessionLogs = readSessionLogs(copyPath, args.date);

  // Opened before any database module is imported: the tail sets the path
  // `db/connection.ts` reads at import, and here that path is the copy.
  const tail = await deps.openTail(copyPath);
  const db = await deps.openDb();
  const legs = findLiveLegs({
    sessionDate: args.date,
    // A session opens at 18:00 ET the evening before its date, so the
    // calendar-date bound spans both days and `findLiveLegs` keeps the
    // session's own rows.
    trades: db.trades(addCalendarDays(args.date, -1), args.date),
    skips: db.skips(args.date),
    priorActive: snapshot.priorActive,
  });
  if (legs.length === 0) {
    throw new DayRefusal(
      `No playbook was live in session ${args.date}: no trade, no skipped signal` +
        (snapshot.priorActive == null ? "" : ", and no deployment Active in the snapshot") +
        `. Nothing was recorded — an empty day is not a day that matched.`,
    );
  }

  // Read before any run, so the book's instruments are resolved with the
  // legs' and an unreachable Topstep refuses the day before anything is written.
  const books = args.modes.includes("book")
    ? readBooks({
        date: args.date,
        legs,
        copyPath,
        sourcePath,
        usePriorState: snapshot.priorActive != null,
        readBook: deps.readBook,
      })
    : [];
  const contracts = await resolveContracts(
    [...legs.map((l) => l.ticker), ...books.flatMap((b) => b.snap?.cells.map((c) => c.ticker) ?? [])],
    tail,
  );
  const strategies = await deps.loadStrategies();
  const playbooks = playbookNames(strategies);
  const git = deps.gitState();
  const swap = new DateDirSwap(path.join(artifactRoot(), PARITY_DIR), args.date, deps.onExit);
  // A playbook-only re-run keeps the book's record, so the book's cells need
  // their lines too; a book-only one reads the same legs the playbooks had.
  const carriedCells = args.modes.includes("book") ? [] : carriedBookCells(path.join(swap.finalDir, BOOK_DIR, COMPARE_FILE));
  const logs = scopeLogs(sessionLogs, args.date, logLegs({ legs, books, carriedCells, strategies, db }));

  swap.begin();
  if (args.modes.length < 2) {
    // A single-mode re-run replaces its own mode's record of the date and
    // keeps the other's, as the log does.
    swap.carryForward((entry) => {
      const owner = parityEntryOwner(entry);
      return (owner === "playbook" || owner === "book") && !args.modes.includes(owner);
    });
    if (!args.modes.includes("playbook")) adoptPrePlaybookSummary(swap);
  }
  let outcomes: LegOutcome[] = [];
  let bookOutcomes: BookAccountOutcome[] = [];
  try {
    await writeJson(swap.stagingDir, LIVE_FILE, liveRecord(args.date, legs));
    await writeJson(swap.stagingDir, LOGS_FILE, logs);
    if (args.modes.includes("playbook")) {
      outcomes = await runLegs({
        args,
        legs,
        swap,
        tail,
        contracts,
        strategies,
        throttle,
        db,
        deps,
        context: { args, git, snapshotTakenAt: snapshot.takenAt },
      });
      await writeJson(swap.stagingDir, "compare.json", {
        sessionDate: args.date,
        mode: "playbook",
        snapshotTakenAt: snapshot.takenAt,
        legs: outcomes.map(({ leg, line, compare }) => ({
          ...line,
          unclosed: leg.unclosed.map((t) => ({ tradeId: t.id, status: t.status, signalBarTs: t.signalBarTs })),
          compare,
        })),
      });
      await fs.writeFile(
        path.join(swap.stagingDir, PLAYBOOK_SUMMARY_FILE),
        renderSummary({
          sessionDate: args.date,
          usedPriorStatus: snapshot.priorActive != null,
          snapshotTakenAt: snapshot.takenAt,
          outcomes,
          logs,
          names: playbooks,
        }),
        "utf8",
      );
    }
    if (args.modes.includes("book")) {
      bookOutcomes = await runBookAccounts({
        date: args.date,
        books,
        // Once the playbook mode has a record of the day, a session or
        // Topstep refusal in the book refuses that account, not the record.
        dayRefusalEndsDay: !args.modes.includes("playbook"),
        stagingBookDir: path.join(swap.stagingDir, BOOK_DIR),
        finalBookDir: path.join(swap.finalDir, BOOK_DIR),
        tail,
        contracts,
        strategies,
        throttle,
        deps,
        git,
        snapshotTakenAt: snapshot.takenAt,
      });
      await writeJson(path.join(swap.stagingDir, BOOK_DIR), "compare.json", {
        sessionDate: args.date,
        mode: "book",
        snapshotTakenAt: snapshot.takenAt,
        accounts: bookOutcomes.map(({ line, cells }) => ({ ...line, compare: cells })),
      });
      await fs.writeFile(
        path.join(swap.stagingDir, BOOK_DIR, SUMMARY_FILE),
        renderBookSummary({ sessionDate: args.date, outcomes: bookOutcomes, logs, names: playbooks }),
        "utf8",
      );
    }
    await fs.writeFile(
      path.join(swap.stagingDir, SUMMARY_FILE),
      assembleSummary(swap.stagingDir) + irregularitiesSection(swap.stagingDir, args.date, logs, playbooks),
      "utf8",
    );
  } catch (err) {
    swap.rollback();
    throw err;
  }
  const keptByNobody = (entry: string) => parityEntryOwner(entry) === "kept";
  // Copied now so the page shows the notes, and again at the swap (below),
  // which is what keeps an append made while the report was being built.
  swap.carryForward(keptByNobody);
  const renderedNotes = readOptionalSync(path.join(swap.stagingDir, NOTES_FILE));
  // Last, and unable to fail the day: a report that cannot be built is a
  // warning and a plain page, and the index is rebuilt with this day read
  // from where it stands before the swap.
  writeDayReport(swap.stagingDir, args.date, playbooks);
  let indexHtml: string | null = null;
  try {
    indexHtml = buildIndexHtml(swap.root, { date: args.date, dir: swap.stagingDir });
  } catch (err) {
    process.stderr.write(`The parity index could not be built: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  const logFile = path.join(swap.root, LOG_FILE);
  const existingLog = await readOptional(logFile);
  let log = existingLog;
  if (args.modes.includes("playbook")) {
    log = mergeParityLog(log, { sessionDate: args.date, mode: "playbook" }, outcomes.map((o) => o.line));
  }
  if (args.modes.includes("book")) {
    log = mergeParityLog(log, { sessionDate: args.date, mode: "book" }, bookOutcomes.map((o) => o.line));
  }
  swap.commit(() => {
    writeFileAtomically(logFile, log);
    if (indexHtml != null) writeIndex(swap.root, indexHtml);
  }, keptByNobody);
  if (readOptionalSync(path.join(swap.finalDir, NOTES_FILE)) !== renderedNotes) {
    process.stderr.write(
      `${NOTES_FILE} for ${args.date} changed while the run was finishing and is kept, but the page shows the earlier ` +
        `version: run \`corepack yarn backtest parity-report --date ${args.date}\` to show it.\n`,
    );
  }

  if (snapshot.takenAt == null) {
    process.stderr.write(
      "The snapshot carries no snapshot_meta, so it could not be checked that it was taken after the session closed.\n",
    );
  }
  for (const { line } of outcomes) {
    if (line.seamWarning != null) {
      process.stderr.write(`${playbookLabel(playbooks, line)}: ${line.seamWarning}\n`);
    }
  }
  for (const { line } of bookOutcomes) {
    for (const warning of line.seamWarnings) process.stderr.write(`book account ${line.accountId}: ${warning}\n`);
  }
  const refused = outcomes.filter((o) => o.line.status === "refused");
  if (refused.length > 0) {
    process.stderr.write(
      `${refused.length} of ${outcomes.length} live playbook(s) could not be compared:\n` +
        refused.map((o) => `  ${playbookLabel(playbooks, o.leg)}: ${o.line.refusal}\n`).join(""),
    );
    process.exitCode = 1;
  }
  const refusedBooks = bookOutcomes.filter((o) => o.line.status === "refused");
  if (refusedBooks.length > 0) {
    process.stderr.write(
      `${refusedBooks.length} of ${bookOutcomes.length} book(s) could not be compared:\n` +
        refusedBooks.map((o) => `  account ${o.accountId}: ${o.line.refusal}\n`).join(""),
    );
    process.exitCode = 1;
  }
  return swap.finalDir;
}

/** `<playbook>-<TICKER>-<deploymentId>`, as `legDirName` writes it: the
 *  contract is the one upper-case segment. */
const LEG_DIR = /^[a-z0-9][a-z0-9-]*-[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$/;

/**
 * Who owns an entry of the date directory: the mode that wrote it, `run` for
 * what every run rewrites (the assembled `summary.md`, the live record and
 * the engine's logs — the legs do not depend on the mode — and the report),
 * or `kept` for anything else: `notes.md`, a screenshot, a folder a person
 * dropped in. Nothing here writes a kept entry and every run keeps it, taking
 * it from the old directory at the swap itself.
 */
export type ParityEntryOwner = ParityMode | "run" | "kept";

export function parityEntryOwner(entry: string): ParityEntryOwner {
  if ([SUMMARY_FILE, LIVE_FILE, LOGS_FILE, REPORT_FILE].includes(entry)) return "run";
  if (entry === BOOK_DIR) return "book";
  if (entry === COMPARE_FILE || entry === PLAYBOOK_SUMMARY_FILE || LEG_DIR.test(entry)) return "playbook";
  return "kept";
}

/** The deployments the date's book record names, from its `compare.json`;
 *  none when there is no readable record. */
function carriedBookCells(file: string): CarriedCell[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = new Field(JSON.parse(readFileSync(file, "utf8")), path.basename(file));
    return parsed
      .key("accounts")
      .list()
      .flatMap((acct) => {
        const accountId = acct.key("accountId").num();
        return (acct.optional("compare")?.list() ?? []).map((cell) => ({
          accountId,
          deploymentId: cell.key("deploymentId").str(),
          strategyKey: cell.key("strategyKey").str(),
          ticker: cell.key("ticker").str(),
        }));
      });
  } catch {
    // The report reads the same file and says what is wrong with it; here an
    // unreadable record only means its cells show no log lines.
    return [];
  }
}

interface CarriedCell {
  accountId: number;
  deploymentId: string;
  strategyKey: string;
  ticker: string;
}

/**
 * `summary.md`'s closing section: the warn and error lines no difference's
 * window holds, every mode's differences read back from the staging
 * directory through the page's own model. Nothing when the logs could not be
 * read — each section already says so.
 */
function irregularitiesSection(dir: string, date: string, logs: ParityLogsFile, playbooks: PlaybookNames): string {
  if (logs.unavailable != null) return "";
  let section: string;
  try {
    section = irregularitiesMarkdown(
      date,
      buildReportView(loadParityDay(dir, date, () => {}), playbooks).irregularities ?? [],
      null,
    );
  } catch {
    section = irregularitiesMarkdown(
      date,
      irregularities(logs, [], playbooks),
      "The day's differences could not be read back, so this lists every warning and error, including any a difference above already shows.",
    );
  }
  return `\n${section}`;
}

function readOptionalSync(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Every deployment whose lines are read: the live legs, the book cells (a
 * quiet cell's blocked signal is a difference too) and, on a playbook-only
 * re-run, the cells of the book record it keeps — each with the bar it
 * trades on so a window can be cut. A timeframe that does not resolve is
 * left null rather than refusing anything.
 */
function logLegs(input: {
  legs: readonly LiveLeg[];
  books: readonly AccountBook[];
  carriedCells: readonly CarriedCell[];
  strategies: Record<string, StrategyModule>;
  db: ParityDbReads;
}): LogLeg[] {
  const out = new Map<string, LogLeg>();
  const minutesOf = (strategyKey: string, deploymentId: string, paramValues: ParamValues | null): number | null => {
    const strategy = moduleOf(input.strategies, strategyKey);
    if (strategy == null || paramValues == null) return null;
    try {
      const merged = resolveDeploymentParams(strategy, paramValues, { strategyKey, deploymentId }) as unknown as ParamValues;
      const timeframe = CLI_TIMEFRAMES.find((t) => t === resolveTimeframe(strategy.config, merged));
      return timeframe == null ? null : TIMEFRAME_MINUTES[timeframe];
    } catch {
      return null;
    }
  };
  for (const leg of input.legs) {
    out.set(leg.deploymentId, {
      deploymentId: leg.deploymentId,
      accountId: leg.accountId,
      strategyKey: leg.strategyKey,
      ticker: leg.ticker,
      barMinutes: minutesOf(leg.strategyKey, leg.deploymentId, input.db.paramValues(leg.deploymentId)),
    });
  }
  for (const book of input.books) {
    for (const cell of book.snap?.cells ?? []) {
      if (out.has(cell.deploymentId)) continue;
      out.set(cell.deploymentId, {
        deploymentId: cell.deploymentId,
        accountId: book.accountId,
        strategyKey: cell.strategyKey,
        ticker: cell.ticker,
        barMinutes: minutesOf(cell.strategyKey, cell.deploymentId, cell.paramValues),
      });
    }
  }
  for (const cell of input.carriedCells) {
    if (out.has(cell.deploymentId)) continue;
    out.set(cell.deploymentId, {
      ...cell,
      barMinutes: minutesOf(cell.strategyKey, cell.deploymentId, input.db.paramValues(cell.deploymentId)),
    });
  }
  return [...out.values()];
}

/** The copy's `engine_logs`, read-only and before the tail migrates the copy;
 *  an unopenable copy is a sentence, as a missing table is. */
function readSessionLogs(copyPath: string, sessionDate: string): SessionLogRead {
  let db: Database.Database;
  try {
    db = new Database(copyPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    return logsUnavailable(`the snapshot copy could not be opened (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    return readEngineLogs(db, sessionDate);
  } finally {
    db.close();
  }
}

/** `summary.md`: the playbook section, then the book section, whichever exist. */
function assembleSummary(dir: string): string {
  const sections = [path.join(dir, PLAYBOOK_SUMMARY_FILE), path.join(dir, BOOK_DIR, SUMMARY_FILE)]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8").trimEnd());
  return `${sections.join("\n\n")}\n`;
}

/**
 * A date directory written before the book mode existed has a `summary.md`
 * that is the playbook section alone and no `summary-playbook.md`; a
 * book-only re-run keeps it as that section.
 */
function adoptPrePlaybookSummary(swap: DateDirSwap): void {
  const old = path.join(swap.finalDir, SUMMARY_FILE);
  if (!existsSync(old) || existsSync(path.join(swap.finalDir, PLAYBOOK_SUMMARY_FILE))) return;
  if (existsSync(path.join(swap.finalDir, BOOK_DIR))) return;
  cpSync(old, path.join(swap.stagingDir, PLAYBOOK_SUMMARY_FILE));
}

const LEFTOVER_DIR = /^\.(\d{4}-\d{2}-\d{2})\.(partial|previous)-(\d+)$/;

/**
 * The date's directory, replaced only when the day completes. Built beside
 * it; at commit the old one is renamed aside, the new one renamed in, the log
 * rewritten and only then the old one deleted — all synchronously, so a
 * signal (which `main` turns into `process.exit`) cannot land between them.
 * Before commit, exit removes the staging directory and nothing else.
 */
export class DateDirSwap {
  readonly root: string;
  readonly finalDir: string;
  readonly stagingDir: string;
  private readonly asideDir: string;
  private removeExitHandler: (() => void) | null = null;

  constructor(
    root: string,
    private readonly date: string,
    private readonly onExit: (fn: () => void) => () => void,
    private readonly isAlive: (pid: number) => boolean = pidIsAlive,
  ) {
    this.root = root;
    this.finalDir = path.join(root, date);
    this.stagingDir = path.join(root, `.${date}.partial-${process.pid}`);
    this.asideDir = path.join(root, `.${date}.previous-${process.pid}`);
  }

  begin(): void {
    this.clearLeftovers();
    rmSync(this.stagingDir, { recursive: true, force: true });
    mkdirSync(this.stagingDir, { recursive: true });
    this.removeExitHandler = this.onExit(() => this.rollback());
  }

  /** Copy the previous record's entries `keep` names into the staging directory. */
  carryForward(keep: (entry: string) => boolean): void {
    if (!existsSync(this.finalDir)) return;
    for (const entry of readdirSync(this.finalDir)) {
      if (!keep(entry)) continue;
      cpSync(path.join(this.finalDir, entry), path.join(this.stagingDir, entry), { recursive: true });
    }
  }

  /** Before commit only: the previous record of the date is untouched. */
  rollback(): void {
    rmSync(this.stagingDir, { recursive: true, force: true });
    this.release();
  }

  /**
   * `keepFromPrevious` names the entries nobody but a person writes: they are
   * taken from the old directory once it is aside — nothing can append to it
   * there — replacing any earlier copy, so a change made since that copy is
   * not deleted with the old directory. Copied, not moved, so a failed
   * commit restores the old directory whole.
   */
  commit(writeLog: () => void, keepFromPrevious: (entry: string) => boolean = () => false): void {
    const hadPrevious = existsSync(this.finalDir);
    if (hadPrevious) renameSync(this.finalDir, this.asideDir);
    try {
      if (hadPrevious) {
        for (const entry of readdirSync(this.stagingDir)) {
          if (keepFromPrevious(entry)) rmSync(path.join(this.stagingDir, entry), { recursive: true, force: true });
        }
        for (const entry of readdirSync(this.asideDir)) {
          if (!keepFromPrevious(entry)) continue;
          cpSync(path.join(this.asideDir, entry), path.join(this.stagingDir, entry), { recursive: true });
        }
      }
      renameSync(this.stagingDir, this.finalDir);
      writeLog();
    } catch (err) {
      rmSync(this.finalDir, { recursive: true, force: true });
      if (hadPrevious) renameSync(this.asideDir, this.finalDir);
      this.rollback();
      throw err;
    }
    if (hadPrevious) rmSync(this.asideDir, { recursive: true, force: true });
    this.release();
  }

  private release(): void {
    this.removeExitHandler?.();
    this.removeExitHandler = null;
  }

  /**
   * What a run of this date that died (SIGKILL, power) left behind. A live
   * pid's directories are its own. An aside directory with no date directory
   * means the run died between its two renames: it is the last committed
   * record, so it goes back rather than away.
   */
  private clearLeftovers(): void {
    if (!existsSync(this.root)) return;
    for (const entry of readdirSync(this.root)) {
      const match = LEFTOVER_DIR.exec(entry);
      if (match == null || match[1] !== this.date) continue;
      const pid = Number(match[3]);
      if (pid === process.pid || this.isAlive(pid)) continue;
      const dir = path.join(this.root, entry);
      if (match[2] === "previous" && !existsSync(this.finalDir)) renameSync(dir, this.finalDir);
      else rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Each leg in turn: a refusal on the leg's own terms — its settings, its
 *  archive coverage, its warmup — is recorded and the loop goes on; a
 *  `DayRefusal` (session incomplete, Topstep) or any defect ends the day. */
async function runLegs(input: {
  args: ParityArgs;
  legs: LiveLeg[];
  swap: DateDirSwap;
  tail: TopstepTail;
  contracts: Map<SpecTicker, string>;
  strategies: Record<string, StrategyModule>;
  throttle: CpuThrottle;
  db: ParityDbReads;
  deps: ParityDayDeps;
  context: LineContext;
}): Promise<LegOutcome[]> {
  const { args, legs, swap, tail, contracts, strategies, throttle, db, context } = input;
  const outcomes: LegOutcome[] = [];
  for (const leg of legs) {
    const legDir = legDirName(leg);
    let prepared: PreparedLeg;
    try {
      prepared = prepareLeg({
        leg,
        date: args.date,
        strategies,
        paramValues: db.paramValues(leg.deploymentId),
        budget: () => db.sessionBudget(leg.accountId, sessionStartUtc(args.date)),
      });
    } catch (err) {
      if (!(err instanceof CliError)) throw err;
      outcomes.push(refusedOutcome(leg, context, err.message));
      continue;
    }

    const runArgs = parseArgs("run", [
      "--ticker", prepared.ticker,
      "--timeframe", prepared.timeframe,
      "--from", args.date,
      "--to", args.date,
      "--playbook", leg.strategyKey,
      "--topstep-tail",
      "--risk-usd", String(prepared.sizing.maxRiskPerTradeUsd),
      "--max-contracts", String(prepared.sizing.maxContracts),
      "--warmup-days", String(prepared.warmupDays),
      "--cpu-target", String(args.cpuTarget),
      "--out", path.join(swap.stagingDir, legDir),
    ]);
    const spec = CONTRACT_SPECS[prepared.ticker];
    const sessionBars: SessionBarSeries[] = [];
    let run: LegRun;
    try {
      run = await input.deps.runLeg({
        args: runArgs,
        strategy: prepared.strategy,
        throttle,
        paramOverrides: prepared.paramValues,
        tail: { contractId: requireContract(contracts, prepared.ticker), chain: tail.chain },
        checkBars: (bars) => {
          assertSessionHasBars(bars.bars, args.date, spec, TIMEFRAME_MINUTES[prepared.timeframe]);
          sessionBars.push(sessionBarSeries(prepared.ticker, prepared.timeframe, bars.bars, args.date));
        },
        extra: {
          parity: {
            sessionDate: args.date,
            deploymentId: leg.deploymentId,
            accountId: leg.accountId,
            paramOverrides: prepared.paramValues,
            sizingBasis: prepared.sizingBasis,
            postureBasis: prepared.postureBasis,
            liveEvidence: leg.evidence,
          },
        },
      });
    } catch (err) {
      if (err instanceof DayRefusal || !(err instanceof CliError)) throw err;
      await fs.rm(path.join(swap.stagingDir, legDir), { recursive: true, force: true });
      outcomes.push(refusedOutcome(leg, context, err.message));
      continue;
    }
    writeSessionBars(path.join(swap.stagingDir, legDir), { sessionDate: args.date, series: sessionBars });

    const compare = setAsideBeforeCreation(
      attachLiveSkipReasons(
        compareTrades({
          records: run.records,
          live: leg.trades.map(toLiveTrade),
          tickSize: spec.tickSize,
        }),
        leg.skips,
      ),
      db.createdAt(leg.deploymentId),
      TIMEFRAME_MINUTES[prepared.timeframe] * MS_PER_MINUTE,
    );
    outcomes.push({
      leg,
      compare,
      line: comparedLine({
        leg,
        context,
        compare,
        prepared,
        runDir: path.join(swap.finalDir, legDir),
        barTail: run.barTail,
      }),
    });
  }
  return outcomes;
}

/** One account's book as the snapshot gives it, or why it could not be read. */
interface AccountBook {
  accountId: number;
  legs: LiveLeg[];
  snap: BookSnapshot | null;
  refusal: string | null;
}

/** Every account with a live leg, its book read off the copy; group params
 *  the reader rejects refuse that account alone. */
function readBooks(input: {
  date: string;
  legs: LiveLeg[];
  copyPath: string;
  sourcePath: string;
  usePriorState: boolean;
  readBook: ParityDayDeps["readBook"];
}): AccountBook[] {
  const byAccount = new Map<number, LiveLeg[]>();
  for (const leg of input.legs) byAccount.set(leg.accountId, [...(byAccount.get(leg.accountId) ?? []), leg]);
  return [...byAccount.keys()]
    .sort((a, b) => a - b)
    .map((accountId) => {
      const legs = byAccount.get(accountId) ?? [];
      try {
        const snap = input.readBook({
          dbPath: input.copyPath,
          accountId,
          ...sessionRangeUtc(input.date, input.date),
          usePriorState: input.usePriorState,
        });
        return { accountId, legs, snap: withSourceIdentity(snap, input.sourcePath), refusal: null };
      } catch (err) {
        if (!(err instanceof SnapshotParamsError)) throw err;
        return { accountId, legs, snap: null, refusal: err.message };
      }
    });
}

/**
 * One book run per account with a live leg in the session, sequentially, and
 * the account's live trades — every leg together — joined against it. A
 * refusal on the account's own terms is recorded as `refused`, and so is a
 * `DayRefusal` unless `dayRefusalEndsDay`; a defect ends the day.
 */
async function runBookAccounts(input: {
  date: string;
  books: AccountBook[];
  dayRefusalEndsDay: boolean;
  stagingBookDir: string;
  finalBookDir: string;
  tail: TopstepTail;
  contracts: Map<SpecTicker, string>;
  strategies: Record<string, StrategyModule>;
  throttle: CpuThrottle;
  deps: ParityDayDeps;
  git: { sha: string | null; dirty: boolean | null };
  snapshotTakenAt: string | null;
}): Promise<BookAccountOutcome[]> {
  const { date, deps, tail, contracts } = input;
  mkdirSync(input.stagingBookDir, { recursive: true });

  const outcomes: BookAccountOutcome[] = [];
  for (const { accountId, legs, snap, refusal } of input.books) {
    const base = {
      mode: "book" as const,
      sessionDate: date,
      accountId,
      liveLegs: legs.map((l) => l.deploymentId),
      liveNotClosed: legs.reduce((n, l) => n + l.unclosed.length, 0),
      snapshotTakenAt: input.snapshotTakenAt,
      gitSha: input.git.sha,
      gitDirty: input.git.dirty,
      generatedAt: new Date().toISOString(),
    };
    const refusedBook = (refusal: string, cells: string[], snap: BookSnapshot | null): BookAccountOutcome => ({
      accountId,
      cells: null,
      line: {
        ...base,
        status: "refused",
        refusal,
        cells,
        runDir: null,
        activeSource: snap?.header.activeSource ?? null,
        phaseSeedSource: snap?.header.phaseSeedSource ?? null,
        matched: 0,
        missed: 0,
        excused: 0,
        extra: 0,
        orderDifferences: 0,
        blockedInBook: 0,
        contestedDifferences: 0,
        endOfData: 0,
        liveNotCompared: 0,
        liveUnjoinable: 0,
        exitReasonDisagreements: 0,
        avgFillSlippageTicks: null,
        worstFillSlippageTicks: null,
        barTail: null,
        seamWarnings: [],
      },
    });

    if (snap == null) {
      outcomes.push(refusedBook(refusal ?? "the snapshot's book for this account could not be read.", [], null));
      continue;
    }
    const cellIds = snap.cells.map((c) => c.deploymentId);
    if (snap.cells.length === 0) {
      outcomes.push(refusedBook("the snapshot holds no playbook for this account in the session.", cellIds, snap));
      continue;
    }

    const accountDir = String(accountId);
    const sessionBars: SessionBarSeries[] = [];
    let run: ParityBookRun;
    try {
      run = await deps.runBook({
        // A playbook created mid-session takes no entry before it existed;
        // live could not have.
        snapshot: { ...snap, cells: snap.cells.map((c) => ({ ...c, entriesFrom: c.createdAt })) },
        strategies: input.strategies,
        from: date,
        to: date,
        order: "created_at",
        tail: { contractId: async (ticker) => requireContract(contracts, ticker), chain: tail.chain },
        throttle: input.throttle,
        outDir: path.join(input.stagingBookDir, accountDir),
        checkBars: ({ ticker, timeframe }, loaded) => {
          assertSessionHasBars(loaded.bars, date, CONTRACT_SPECS[ticker], TIMEFRAME_MINUTES[timeframe]);
          sessionBars.push(sessionBarSeries(ticker, timeframe, loaded.bars, date));
        },
        cliArgs: ["parity-day", "--date", date, "--mode", "book"],
        extra: { parity: { sessionDate: date, accountId, liveLegs: base.liveLegs } },
      });
    } catch (err) {
      if (!(err instanceof CliError) || (err instanceof DayRefusal && input.dayRefusalEndsDay)) throw err;
      await fs.rm(path.join(input.stagingBookDir, accountDir), { recursive: true, force: true });
      outcomes.push(refusedBook(err.message, cellIds, snap));
      continue;
    }
    writeSessionBars(path.join(input.stagingBookDir, accountDir), { sessionDate: date, series: sessionBars });

    const cells = compareBook({ cells: run.cells, trades: run.trades, blocked: run.blocked, legs });
    outcomes.push({
      accountId,
      cells,
      line: {
        ...base,
        status: "compared",
        refusal: null,
        cells: run.cells.map((c) => c.deploymentId),
        runDir: path.join(input.finalBookDir, accountDir),
        activeSource: snap.header.activeSource,
        phaseSeedSource: snap.header.phaseSeedSource,
        ...bookCounts(cells),
        barTail: run.barTail,
        seamWarnings: Object.values(run.barTail)
          .map(seamWarning)
          .filter((w): w is string => w != null),
      },
    });
  }
  return outcomes;
}

interface SnapshotRead {
  /** `snapshot_meta.taken_at`, normalised; null on a copy without the table. */
  takenAt: string | null;
  /** Null when the pre-scrub status is not evidence about this session. */
  priorActive: PriorActiveRow[] | null;
}

/**
 * Read-only open, the copy's age judged before anything is copied, the
 * pre-scrub status read off the source while it is open, then one consistent
 * copy with every credential row and token table emptied.
 */
export async function copySnapshot(
  sourcePath: string,
  copyPath: string,
  args: Pick<ParityArgs, "date" | "isLatestSession">,
): Promise<SnapshotRead> {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const verdict = judgeSnapshot({
      takenAt: readTakenAt(source),
      sessionDate: args.date,
      isLatestSession: args.isLatestSession,
    });
    if (verdict.kind === "refuse") throw new DayRefusal(verdict.message);
    const read: SnapshotRead = {
      takenAt: verdict.takenAt,
      priorActive: verdict.trustPriorStatus ? readPriorActive(source) : null,
    };
    await copyAndScrub(source, copyPath);
    return read;
  } finally {
    source.close();
  }
}

/** The shared reading of `snapshot_prior_deployments`; null when the snapshot
 *  predates it. */
function readPriorActive(db: Database.Database): PriorActiveRow[] | null {
  const hasTable =
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshot_prior_deployments'`)
      .get() != null;
  if (!hasTable) return null;
  return readPriorActiveDeployments(db, null).map((r) => ({
    deploymentId: r.id,
    accountId: r.account_id,
    strategyKey: r.strategy_key,
    ticker: r.ticker,
  }));
}

/** Up front, one per instrument — every leg's and every book cell's: this is
 *  where an unreachable Topstep is found, before any run directory exists. */
async function resolveContracts(tickers: string[], tail: TopstepTail): Promise<Map<SpecTicker, string>> {
  const out = new Map<SpecTicker, string>();
  for (const ticker of tickers) {
    const root = ticker.replace(/^\//, "");
    if (!isSpecTicker(root) || out.has(root)) continue;
    out.set(root, await tail.contractId(root));
  }
  return out;
}

function requireContract(contracts: Map<SpecTicker, string>, ticker: SpecTicker): string {
  const id = contracts.get(ticker);
  if (id == null || id.length === 0) {
    throw new Error(
      `No Topstep contract was resolved for ${ticker}; resolveContracts covers every leg's and book cell's instrument.`,
    );
  }
  return id;
}

/**
 * The module a snapshot row's key names. A snapshot taken before 2026-10-16
 * carries a key since renamed — `snapshot_prior_deployments` is read off the
 * source, which never ran the rename — so the lookup goes through the map
 * while the leg keeps the key it was read with: `compare.json` and
 * `log.jsonl` still join against the days recorded under it.
 */
function moduleOf(strategies: Record<string, StrategyModule>, key: string): StrategyModule | undefined {
  return strategies[RENAMED_KEYS[key] ?? key];
}

interface PreparedLeg {
  strategy: StrategyModule;
  ticker: SpecTicker;
  timeframe: CliTimeframe;
  paramValues: ParamValues;
  sizing: Extract<BacktestSizing, { mode: "risk" }>;
  sizingBasis: SizingBasis;
  postureBasis: SessionBudget["basis"] | null;
  warmupDays: number;
}

/**
 * Everything about a leg that can refuse it on its own terms, before a bar is
 * read: the deployment row's params merged by `resolveDeploymentParams`, the
 * engine's own merge, and the checks `run` makes before reading a bar.
 */
function prepareLeg(input: {
  leg: LiveLeg;
  date: string;
  strategies: Record<string, StrategyModule>;
  paramValues: ParamValues | null;
  budget: () => SessionBudget;
}): PreparedLeg {
  const { leg, strategies } = input;
  const ticker = leg.ticker.replace(/^\//, "");
  if (!isSpecTicker(ticker)) {
    throw new CliError(`${leg.ticker} is not on the backtest's contract table.`);
  }
  const strategy = moduleOf(strategies, leg.strategyKey);
  if (strategy == null) throw new CliError(`this build has no playbook "${leg.strategyKey}".`);
  if (input.paramValues == null) {
    throw new CliError("the deployment row is not in the snapshot, so its settings are unknown.");
  }
  const resolved = resolveDeploymentParams(strategy, input.paramValues, {
    strategyKey: leg.strategyKey,
    deploymentId: leg.deploymentId,
  });
  const merged = resolved as unknown as ParamValues;
  const rawTimeframe = resolveTimeframe(strategy.config, merged);
  const timeframe = CLI_TIMEFRAMES.find((t) => t === rawTimeframe);
  if (timeframe == null) {
    throw new CliError(`it trades ${rawTimeframe} bars, which the backtest does not run.`);
  }

  const spec = CONTRACT_SPECS[ticker];
  assertInstrumentCalibrated(strategy, ticker, false);
  assertSessionMeasurable(strategy, merged);
  assertSettingsTakeEntries(strategy, [merged], spec.daySession);
  assertCrossTimeframeExitMeasurable([merged]);

  const declared = strategy.warmupDaySessions?.(resolved) ?? 0;
  const warmupDays = Math.max(
    DEFAULT_WARMUP_SESSION_DAYS,
    declared === 0 ? 0 : declared + WARMUP_HOLIDAY_SLACK_SESSIONS,
  );

  const liveTrades = [...leg.trades, ...leg.unclosed];
  const fromTrades = riskSizingFromTrades(liveTrades);
  if (fromTrades != null && fromTrades.mode === "risk") {
    return {
      strategy,
      ticker,
      timeframe,
      // The playbook's cap and share from the same snapshot as the budget,
      // over the row's: the operator may have changed them since the entry.
      paramValues: { ...input.paramValues, ...playbookSizingSettingsFromTrades(liveTrades) },
      sizing: fromTrades,
      sizingBasis: "trade_snapshot",
      postureBasis: null,
      warmupDays,
    };
  }

  // The account-phase sizer's budget for the session open, as the engine
  // resolves it — but from the snapshot's balance sample, which the line's
  // `postureBasis` names.
  let budget: SessionBudget;
  try {
    budget = input.budget();
  } catch (err) {
    throw new CliError(
      `no trade recorded its budget and the account's risk posture does not resolve: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (budget.posture == null) {
    throw new CliError("no trade recorded its budget and the account has no risk posture set.");
  }
  return {
    strategy,
    ticker,
    timeframe,
    paramValues: input.paramValues,
    sizing: {
      mode: "risk",
      maxRiskPerTradeUsd: budget.posture.maxRiskPerTradeUsd,
      maxContracts: budget.posture.maxContracts,
    },
    sizingBasis: "account_posture",
    postureBasis: budget.basis,
    warmupDays,
  };
}

function legDirName(leg: LiveLeg): string {
  return `${leg.strategyKey}-${leg.ticker.replace(/^\//, "")}-${leg.deploymentId}`;
}

interface LineContext {
  args: ParityArgs;
  git: { sha: string | null; dirty: boolean | null };
  snapshotTakenAt: string | null;
}

function baseLine(leg: LiveLeg, context: LineContext) {
  return {
    mode: "playbook" as const,
    sessionDate: context.args.date,
    deploymentId: leg.deploymentId,
    accountId: leg.accountId,
    strategyKey: leg.strategyKey,
    ticker: leg.ticker,
    liveEvidence: leg.evidence,
    liveNotClosed: leg.unclosed.length,
    snapshotTakenAt: context.snapshotTakenAt,
    gitSha: context.git.sha,
    gitDirty: context.git.dirty,
    generatedAt: new Date().toISOString(),
  };
}

function refusedOutcome(leg: LiveLeg, context: LineContext, refusal: string): LegOutcome {
  return {
    leg,
    compare: null,
    line: {
      ...baseLine(leg, context),
      status: "refused",
      refusal,
      sizing: null,
      sizingBasis: null,
      postureBasis: null,
      runDir: null,
      matched: 0,
      liveOnly: 0,
      backtestOnly: 0,
      liveUnjoinable: 0,
      exitReasonDisagreements: 0,
      avgFillSlippageTicks: null,
      worstFillSlippageTicks: null,
      barTail: null,
      seamWarning: null,
    },
  };
}

function comparedLine(input: {
  leg: LiveLeg;
  context: LineContext;
  compare: CompareResult;
  prepared: PreparedLeg;
  runDir: string;
  barTail: BarTailRecord | null;
}): ParityLogLine {
  const { compare } = input;
  const hasSlippage = compare.matched.some((m) => m.fillSlippageTicks != null);
  return {
    ...baseLine(input.leg, input.context),
    status: "compared",
    refusal: null,
    sizing: input.prepared.sizing,
    sizingBasis: input.prepared.sizingBasis,
    postureBasis: input.prepared.postureBasis,
    runDir: input.runDir,
    matched: compare.summary.matched,
    liveOnly: compare.summary.liveOnly,
    backtestOnly: missedEntries(compare, input.leg).length,
    liveUnjoinable: compare.summary.liveUnjoinable,
    exitReasonDisagreements: compare.matched.filter((m) => !m.exitReasonAgreement).length,
    // Null rather than the summary's 0 when nothing was measured, so a day
    // with no fills does not average in as a day of perfect fills.
    avgFillSlippageTicks: hasSlippage ? compare.summary.avgFillSlippageTicks : null,
    worstFillSlippageTicks: hasSlippage ? compare.summary.worstFillSlippageTicks : null,
    barTail: input.barTail,
    seamWarning: seamWarning(input.barTail),
  };
}

async function readOptional(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return "";
    throw err;
  }
}

