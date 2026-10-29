/**
 * `book` — every leg one account runs, backtested together over a range of
 * sessions (docs/proposals/book-backtest.md; the runner is
 * `lib/trading/backtest-book.ts`).
 *
 * The book is the snapshot's: `TRADING_DB_PATH` is opened read-only once and
 * copied and scrubbed exactly as `parity-day` does (`snapshot-copy.ts`), and
 * the deployment set, params, thresholds and posture come off the copy. The
 * header names the source file, its mtime and `snapshot_meta.taken_at`,
 * because they are the snapshot's and not history's.
 *
 * `runBookOnce` is the run `parity-day --mode book` makes per account, too.
 */
import path from "node:path";

import Database from "better-sqlite3";
import { statSync } from "node:fs";

import {
  planBookBars,
  runBookBacktest,
  runBookBacktestPermuted,
  type BookBacktestResult,
  type RunBookBacktestOptions,
} from "@/lib/trading/backtest-book";
import {
  SnapshotParamsError,
  readBookSnapshot,
  sessionRangeUtc,
  type BookSnapshot,
} from "@/lib/trading/backtest-book-snapshot";
import { researchRoot } from "@/lib/trading/backtest-artifacts";
import { CONTRACT_SPECS, isSpecTicker, type SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { toCents } from "@/lib/trading/orders/pnl-math";
import { sessionStartUtc } from "@/lib/trading/regime/session-dates";
import { loadStrategiesNode } from "@/lib/trading/strategies/load-node";
import {
  resolveDeploymentParams,
  resolveTimeframe,
  type ParamValues,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import { CLI_TIMEFRAMES, DEFAULT_WARMUP_SESSION_DAYS, cpuTarget, type CliTimeframe } from "../args";
import { loadRunBars, type BarTailInput, type BarTailRecord, type LoadedBars } from "../bars";
import { CliError } from "../cli-error";
import { currentGitSha, makeRunDir, newRunId, writeJson, writeJsonl } from "../output";
import {
  WARMUP_HOLIDAY_SLACK_SESSIONS,
  assertCrossTimeframeExitMeasurable,
  assertInstrumentCalibrated,
  assertSessionMeasurable,
  assertSettingsTakeEntries,
} from "../params";
import { playbookLabel, playbookNames } from "../playbook-label";
import { parseSessionDate } from "../session-dates";
import { copyAndScrub, requireDatabase } from "../snapshot-copy";
import type { CpuThrottle } from "../throttle";
import { DB_PATH_VAR, openTopstepTail, privateDbDir } from "../topstep-tail";

export const BOOK_ORDERS = ["created_at", "permute"] as const;
export type BookOrder = (typeof BOOK_ORDERS)[number];

export interface BookArgs {
  accountId: number;
  from: string;
  to: string;
  topstepTail: boolean;
  order: BookOrder;
  cpuTarget: number;
  out: string | null;
  raw: string[];
}

const BOOK_FLAGS = "--account, --from, --to, --topstep-tail, --order, --cpu-target and --out";

export function parseBookArgs(argv: string[]): BookArgs {
  const values = new Map<string, string>();
  let topstepTail = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    if (flag === "--topstep-tail") {
      if (eq !== -1) throw new CliError(`Flag "${flag}" takes no value`);
      topstepTail = true;
      continue;
    }
    if (!["--account", "--from", "--to", "--order", "--cpu-target", "--out"].includes(flag)) {
      throw new CliError(`Unknown flag "${flag}". book takes ${BOOK_FLAGS}`);
    }
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value == null || value.startsWith("--")) throw new CliError(`Flag "${flag}" needs a value`);
    if (values.has(flag)) throw new CliError(`Flag "${flag}" was given twice; it takes one value`);
    values.set(flag, value);
  }
  for (const flag of ["--account", "--from", "--to"]) {
    if (!values.has(flag)) throw new CliError(`Missing required flag ${flag}`);
  }
  const accountRaw = values.get("--account") ?? "";
  const accountId = Number(accountRaw);
  if (!Number.isInteger(accountId) || accountId < 1) {
    throw new CliError(`--account must be an account id, got "${accountRaw}"`);
  }
  const from = parseSessionDate(values.get("--from") ?? "", "--from");
  const to = parseSessionDate(values.get("--to") ?? "", "--to");
  if (from > to) throw new CliError(`--from ${from} is after --to ${to}`);
  const orderRaw = values.get("--order") ?? "created_at";
  const order = BOOK_ORDERS.find((o) => o === orderRaw);
  if (order == null) throw new CliError(`--order must be one of ${BOOK_ORDERS.join(", ")}, got "${orderRaw}"`);
  return {
    accountId,
    from,
    to,
    topstepTail,
    order,
    cpuTarget: cpuTarget(values.get("--cpu-target") ?? null),
    out: values.get("--out") ?? null,
    raw: argv,
  };
}

const SNAPSHOT_COPY_FILE = "snapshot.db";

export async function bookCommand(args: BookArgs, throttle: CpuThrottle): Promise<string> {
  const sourcePath = requireDatabase("book");
  const copyPath = path.join(privateDbDir(), SNAPSHOT_COPY_FILE);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await copyAndScrub(source, copyPath);
  } finally {
    source.close();
  }
  // Anything that opens the app's database from here on opens the scrubbed
  // copy, never the operator's file.
  process.env[DB_PATH_VAR] = copyPath;
  const snapshot = withSourceIdentity(readSnapshotOrRefuse(copyPath, args), sourcePath);
  if (snapshot.cells.length === 0) {
    throw new CliError(
      `Account ${args.accountId} has no playbook in the snapshot for ${args.from} to ${args.to}: none was ` +
        `Active before the scrub, and none traded or skipped in the range.`,
    );
  }

  const outDir = makeRunDir(
    // Under research/, not runs/: runs/<playbook>/ holds one playbook's runs, and a book is several.
    args.out ?? path.join(researchRoot(), "book", `${args.accountId}-${args.from}-${args.to}-${newRunId()}`),
  );
  // Before the strategies load: the tail sets the database path the app's
  // modules read at import (a scratch file here; the copy is only read).
  const tail = args.topstepTail ? await openTopstepTail() : null;
  const strategies = await loadStrategiesNode({ includeTest: true });
  await runBookOnce({
    snapshot,
    strategies,
    from: args.from,
    to: args.to,
    order: args.order,
    tail,
    throttle,
    outDir,
    cliArgs: ["book", ...args.raw],
  });
  return outDir;
}

function readSnapshotOrRefuse(copyPath: string, args: BookArgs): BookSnapshot {
  try {
    return readBookSnapshot({ dbPath: copyPath, accountId: args.accountId, ...sessionRangeUtc(args.from, args.to) });
  } catch (err) {
    if (err instanceof SnapshotParamsError) throw new CliError(err.message);
    throw err;
  }
}

/** The header names the operator's file, not the private copy it was read from. */
export function withSourceIdentity(snapshot: BookSnapshot, sourcePath: string): BookSnapshot {
  return {
    ...snapshot,
    header: {
      ...snapshot.header,
      snapshotPath: sourcePath,
      snapshotMtime: statSync(sourcePath).mtime.toISOString(),
    },
  };
}

export interface BookTail {
  contractId: (ticker: SpecTicker) => Promise<string>;
  chain: BarTailInput["chain"];
}

export interface BookRunInput {
  snapshot: BookSnapshot;
  strategies: Record<string, StrategyModule>;
  /** Session dates, inclusive. */
  from: string;
  to: string;
  order: BookOrder;
  tail: BookTail | null;
  throttle: CpuThrottle;
  outDir: string;
  /** Called on each series' bars before the run; a refusal throws. */
  checkBars?: (series: { ticker: SpecTicker; timeframe: CliTimeframe }, loaded: LoadedBars) => void;
  cliArgs: string[];
  /** Extra top-level keys for `run.json`. */
  extra?: Record<string, unknown>;
}

export interface BookRunOutput {
  result: BookBacktestResult;
  /** Per series, keyed `bookBarKey(ticker, timeframe)`. */
  barTail: Record<string, BarTailRecord | null>;
}

interface PreparedCell {
  timeframe: CliTimeframe;
  warmupDays: number;
}

/**
 * The checks `run` makes before reading a bar, for every cell. One cell this
 * build cannot run refuses the book: the others' contention with it is the
 * thing being measured.
 */
function prepareCells(snapshot: BookSnapshot, strategies: Record<string, StrategyModule>): Map<string, PreparedCell> {
  const out = new Map<string, PreparedCell>();
  const names = playbookNames(strategies);
  for (const cell of snapshot.cells) {
    const name = playbookLabel(names, cell);
    const strategy = strategies[cell.strategyKey];
    if (strategy == null) throw new CliError(`${name}: this build has no playbook "${cell.strategyKey}".`);
    const ticker = cell.ticker.replace(/^\//, "");
    if (!isSpecTicker(ticker)) throw new CliError(`${name}: ${cell.ticker} is not on the backtest's contract table.`);
    const rawTimeframe = resolveTimeframe(strategy.config, cell.paramValues);
    const timeframe = CLI_TIMEFRAMES.find((t) => t === rawTimeframe);
    if (timeframe == null) throw new CliError(`${name}: it trades ${rawTimeframe} bars, which the backtest does not run.`);
    const resolved = resolveDeploymentParams(strategy, cell.paramValues, {
      strategyKey: cell.strategyKey,
      deploymentId: cell.deploymentId,
    });
    const merged = resolved as unknown as ParamValues;
    try {
      assertInstrumentCalibrated(strategy, ticker, false);
      assertSessionMeasurable(strategy, merged);
      assertSettingsTakeEntries(strategy, [merged], CONTRACT_SPECS[ticker].daySession);
      assertCrossTimeframeExitMeasurable([merged]);
    } catch (err) {
      if (err instanceof CliError) throw new CliError(`${name}: ${err.message}`);
      throw err;
    }
    const declared = strategy.warmupDaySessions?.(resolved) ?? 0;
    out.set(cell.deploymentId, {
      timeframe,
      warmupDays: Math.max(DEFAULT_WARMUP_SESSION_DAYS, declared === 0 ? 0 : declared + WARMUP_HOLIDAY_SLACK_SESSIONS),
    });
  }
  return out;
}

/** One book run directory: bars per series, the run, and the files. */
export async function runBookOnce(input: BookRunInput): Promise<BookRunOutput> {
  const { snapshot, strategies, throttle } = input;
  const prepared = prepareCells(snapshot, strategies);
  const resolveStrategy = (key: string): StrategyModule | undefined => strategies[key];

  const bars = new Map<string, LoadedBars["bars"]>();
  const subBars = new Map<string, LoadedBars["bars"]>();
  const barTail: Record<string, BarTailRecord | null> = {};
  const series: Array<Record<string, unknown>> = [];
  for (const entry of planBookBars(snapshot.cells, resolveStrategy)) {
    const ticker = entry.ticker.replace(/^\//, "");
    const timeframe = CLI_TIMEFRAMES.find((t) => t === entry.timeframe);
    if (!isSpecTicker(ticker) || timeframe == null) {
      throw new Error(`${entry.key} passed prepareCells and is not a series the CLI loads.`);
    }
    const warmupDays = Math.max(...entry.deploymentIds.map((id) => prepared.get(id)?.warmupDays ?? DEFAULT_WARMUP_SESSION_DAYS));
    const spec = CONTRACT_SPECS[ticker];
    const { loaded, warmupFrom } = await loadRunBars({
      args: { timeframe, from: input.from, to: input.to, warmupDays, usesClassifier: false, perturb: false },
      spec,
      tail: input.tail == null ? null : { contractId: await input.tail.contractId(ticker), chain: input.tail.chain },
      straddleLegs: snapshot.cells
        .filter((cell) => entry.deploymentIds.includes(cell.deploymentId))
        .flatMap((cell) => {
          const strategy = resolveStrategy(cell.strategyKey);
          return strategy == null ? [] : [{ strategy, paramOverrides: cell.paramValues }];
        }),
    });
    input.checkBars?.({ ticker, timeframe }, loaded);
    bars.set(entry.key, loaded.bars);
    if (loaded.subBars != null) subBars.set(entry.key, loaded.subBars);
    barTail[entry.key] = loaded.barTail;
    series.push({
      key: entry.key,
      ticker,
      timeframe,
      deploymentIds: entry.deploymentIds,
      warmupDays,
      warmupFrom,
      barCount: loaded.bars.length,
      firstBarTs: loaded.bars[0]?.timestamp ?? null,
      lastBarTs: loaded.bars.at(-1)?.timestamp ?? null,
      cacheFiles: loaded.cacheFiles,
    });
  }

  const options: RunBookBacktestOptions = {
    cells: snapshot.cells,
    resolveStrategy,
    bars,
    subBars,
    account: snapshot.account,
    reportFrom: sessionStartUtc(input.from),
    onProgress: throttle.onProgress,
  };
  const permuted = input.order === "permute" ? await runBookBacktestPermuted(options) : null;
  const result = permuted?.base ?? (await runBookBacktest(options));

  const { header } = snapshot;
  await writeJson(input.outDir, "run.json", {
    header: {
      command: "book",
      gitSha: currentGitSha(),
      accountId: header.accountId,
      from: input.from,
      to: input.to,
      snapshot: { path: header.snapshotPath, mtime: header.snapshotMtime, takenAt: header.snapshotTakenAt },
      activeSource: header.activeSource,
      // True when the snapshot had no pre-scrub record and the book is the
      // legs that left a row in the range — a quiet leg is missing from it.
      activeSourceFallback: header.activeSource === "session_activity",
      phaseSeedSource: header.phaseSeedSource,
      order: input.order,
      cells: result.cells,
      series,
      barTail,
      account: snapshot.account,
      blockedCounts: result.blockedCounts,
      contests: result.contests,
      cpu: throttle.report(),
      cliArgs: input.cliArgs,
      generatedAt: new Date().toISOString(),
    },
    summary: bookSummary(result),
    warnings: result.warnings,
    ...(permuted == null
      ? {}
      : {
          permutations: permuted.variants.map((v, k) => ({
            promoted: v.promoted,
            dir: variantDir(k),
            summary: bookSummary(v.result),
          })),
        }),
    ...input.extra,
  });
  await writeResultFiles(input.outDir, result);
  for (const [k, variant] of (permuted?.variants ?? []).entries()) {
    await writeResultFiles(path.join(input.outDir, variantDir(k)), variant.result);
  }
  return { result, barTail };
}

function variantDir(k: number): string {
  return `variant-${k + 1}`;
}

/** Each written even when empty: a missing file reads as an older build. */
async function writeResultFiles(dir: string, result: BookBacktestResult): Promise<void> {
  await writeJsonl(dir, "trades.jsonl", result.trades);
  await writeJsonl(dir, "skips.jsonl", result.skips);
  await writeJsonl(dir, "blocked.jsonl", result.blocked);
}

const CENTS_PER_DOLLAR = 100;

/** Per cell and for the book: counts, and dollars summed in whole cents. */
export function bookSummary(result: BookBacktestResult) {
  const tally = (trades: BookBacktestResult["trades"]) => {
    let net = 0;
    let gross = 0;
    let fees = 0;
    for (const t of trades) {
      net += toCents(t.pnlNetDollars);
      gross += toCents(t.pnlGrossDollars);
      fees += toCents(t.feesDollars);
    }
    return {
      trades: trades.length,
      // The sign of pnlTicks decides the bucket (backtest.md).
      wins: trades.filter((t) => t.pnlTicks > 0).length,
      losses: trades.filter((t) => t.pnlTicks < 0).length,
      contestedEntries: trades.filter((t) => t.contested).length,
      netDollars: net / CENTS_PER_DOLLAR,
      grossDollars: gross / CENTS_PER_DOLLAR,
      feesDollars: fees / CENTS_PER_DOLLAR,
    };
  };
  return {
    book: { ...tally(result.trades), skips: result.skips.length, blocked: result.blocked.length, contests: result.contests.length },
    cells: result.cells.map((cell) => ({
      ...cell,
      ...tally(result.trades.filter((t) => t.deploymentId === cell.deploymentId)),
      skips: result.skips.filter((s) => s.deploymentId === cell.deploymentId).length,
      blocked: result.blockedCounts[cell.deploymentId],
    })),
  };
}
