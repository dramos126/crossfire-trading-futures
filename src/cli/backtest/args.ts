/**
 * Flag parsing for `yarn backtest`. Every refusal is a `CliError`, so an
 * unusable invocation exits non-zero with one line rather than running
 * something adjacent to what was asked for.
 */
import os from "node:os";

import { CliError } from "./cli-error";
import { parseSessionDate } from "./session-dates";
import { isSpecTicker, SPEC_TICKERS, type SpecTicker } from "@/lib/trading/contracts/contract-specs";
import {
  CLASSIFIER_VERSION,
  CLASSIFIER_WARMUP_SESSION_DAYS,
  REGIME_CELLS,
  isRegimeCell,
  type RegimeCell,
} from "@/lib/trading/regime/classify-regime";
import { REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import { PERTURB_WARMUP_SESSION_DAYS } from "./perturbations";
import { NO_THROTTLE_PCT } from "./throttle";

export const COMMANDS = [
  "run",
  "walk-forward",
  "labels",
  "lift",
  "compare",
  "parity-day",
  "parity-report",
  "book",
] as const;
export type Command = (typeof COMMANDS)[number];

export const CLI_TIMEFRAMES = ["1m", "5m", "15m", "30m"] as const;
export type CliTimeframe = (typeof CLI_TIMEFRAMES)[number];

export const OBJECTIVES = [
  "expectancyR",
  "netDollars",
  "profitFactor",
  "maxDrawdownR",
] as const;
export type Objective = (typeof OBJECTIVES)[number];

export const DEFAULT_WARMUP_SESSION_DAYS = 30;
const DEFAULT_TRAIN_MONTHS = 18;
const DEFAULT_TEST_MONTHS = 6;
const DEFAULT_STEP_MONTHS = 6;

/**
 * Session days of history the classifier needs before its first label: the
 * 250-day `vol` baseline, plus the 20-day range median, plus the 5-day
 * `vol5` window that the oldest baseline sample itself needs. Anything
 * shorter and the first sessions of the range come back `unknown`, which
 * fails closed and would silently empty the run.
 *
 * Re-exported from the classifier rather than recomputed here: the engine's
 * nightly job sizes its fetch off the same number, and two arithmetic copies
 * would let one side classify on a baseline the other refused.
 */
export { CLASSIFIER_WARMUP_SESSION_DAYS };

const DEFAULT_PERMUTATIONS = 1000;
const DEFAULT_MIN_CELL_TRADES = 100;
const DEFAULT_MIN_LIFT_R = 0.1;
const DEFAULT_FOLD_CONSISTENCY = 0.67;
/** Fixed, not clock-derived: two `lift` runs over the same bars must land on
 *  the same p-value unless the operator asked for a different draw. */
const DEFAULT_SEED = 1;

export const MAX_SWEEP_KEYS = 2;
export const MAX_SWEEP_GRID_POINTS = 25;

/**
 * The cache symbols `--bar-symbol` may name — the values of
 * `TICKER_TO_CACHE_SYMBOL` (`@/lib/data/cached-bars`), copied rather than
 * imported. That module binds the Topstep provider for its chained tail,
 * which reaches the broker registry and the `require.context` strategy
 * loader — a bundler-only mechanism with no test-environment equivalent —
 * and `parseArgs` otherwise touches none of it; the CLI reads the cache and
 * only the cache (backtest.md). `args.test.ts` pins the agreement against
 * the real map so the two cannot drift silently.
 */
/** Each bar series and the ticker it is priced as: a mini's bars price as its micro. */
const DEFAULT_BAR_SYMBOL_TICKER: Readonly<Record<string, SpecTicker>> = {
  "ES.c.0": "MES",
  "MES.v.0": "MES",
  "NQ.c.0": "MNQ",
  "MNQ.v.0": "MNQ",
  "YM.c.0": "MYM",
  "MYM.v.0": "MYM",
  "MGC.v.0": "MGC",
};
/**
 * The index micros' calendar-rolled series, which the ticker table mapped to
 * until 2026-10-25 (bugs.md A61: no cash session on quarterly expiry Fridays).
 * Still in the cache and still readable through `--bar-symbol`, so a run
 * recorded before the repoint can be reproduced on the bars it was made on.
 * Not in `TICKER_TO_CACHE_SYMBOL` on purpose: nothing resolves to them
 * without the flag, and nothing should.
 */
const ALTERNATE_ROLL_BAR_SYMBOL_TICKER: Readonly<Record<string, SpecTicker>> = {
  "MNQ.c.0": "MNQ",
  "MES.c.0": "MES",
  "MYM.c.0": "MYM",
};
const BAR_SYMBOL_TICKER: Readonly<Record<string, SpecTicker>> = {
  ...DEFAULT_BAR_SYMBOL_TICKER,
  ...ALTERNATE_ROLL_BAR_SYMBOL_TICKER,
};
/** The ticker table's own series — what `args.test.ts` pins against the real map. */
export const DEFAULT_BAR_SYMBOLS: readonly string[] = Object.keys(DEFAULT_BAR_SYMBOL_TICKER);
export const BAR_SYMBOLS: readonly string[] = Object.keys(BAR_SYMBOL_TICKER);
const BAR_SYMBOL_SET: ReadonlySet<string> = new Set(BAR_SYMBOLS);

/** The machine that runs backtests no longer runs the engine, so there is
 *  nothing to protect by default; `BACKTEST_WORKERS` is the core budget. Per
 *  process, not per run. */
export const DEFAULT_CPU_TARGET_PCT = NO_THROTTLE_PCT;
const MIN_CPU_TARGET_PCT = 5;

/** The machine's core budget for one CLI run — a runtime deploy-environment
 *  variable, read at startup like `BACKTEST_ARTIFACTS_DIR`. */
export const WORKERS_ENV_VAR = "BACKTEST_WORKERS";
export const WORKERS_FLAG = "--workers";
const DEFAULT_WORKERS = 1;
const WHOLE_NUMBER = /^\d+$/;
/** The commands with independent windows to fan out; the rest are one bar
 *  loop each and refuse the flag rather than ignoring it. */
const COMMANDS_WITH_WORKERS: ReadonlySet<Command> = new Set<Command>(["walk-forward", "lift"]);

export interface SweepAxis {
  key: string;
  lo: number;
  hi: number;
  step: number;
}

export interface CliArgs {
  command: Command;
  ticker: SpecTicker;
  /** Cache symbol to read bars from in place of `TICKER_TO_CACHE_SYMBOL[ticker]`,
   *  when set — the escape hatch for pricing one instrument's economics off
   *  another's bars (e.g. NQ bars under MNQ's tick value and fees). Null is
   *  the default: bars resolve from `--ticker` exactly as before. Nothing
   *  else reads it — tick value, fees, `calibratedFor` and the day session
   *  all still come from `--ticker`. Recorded on the run header so a
   *  substituted run is never mistaken for an on-instrument one. */
  barSymbol: string | null;
  timeframe: CliTimeframe;
  from: string;
  to: string;
  /** Null only for `labels`, which runs no hooks. */
  playbook: string | null;
  sets: Array<{ key: string; value: string }>;
  /** Fixed contract count. `1` unless `--contracts` said otherwise, and
   *  ignored entirely when {@link riskUsd} is set. */
  contracts: number;
  /** Per-trade dollar budget. Non-null means the run sizes through the
   *  engine's risk sizer instead of a fixed count — mutually exclusive with
   *  `--contracts`, which the parser refuses rather than resolving. */
  riskUsd: number | null;
  /** The contract ceiling the sizer caps at under `--risk-usd`. */
  maxContracts: number;
  dailyLossUsd: number | null;
  /** `--daily-profit-usd`: the other side of the same account gate — entries
   *  stop for the session once realised gross P&L reaches it; nothing is
   *  flattened. */
  dailyProfitUsd: number | null;
  fees: boolean;
  /** Already floored to the classifier's baseline when one is in play. */
  warmupDays: number;
  out: string | null;
  classifierVersion: string;
  /** Cells entries are restricted to. Null is `--regime all` — no gate. */
  regimes: RegimeCell[] | null;
  /** True when a label is computed: `labels`, `lift`, or a real `--regime`. */
  usesClassifier: boolean;
  perturb: boolean;
  permutations: number;
  minCellTrades: number;
  minLiftR: number;
  foldConsistency: number;
  seed: number;
  train: number;
  test: number;
  step: number;
  sweep: SweepAxis[];
  objective: Objective;
  /** Force `walk-forward`'s training runs without a sweep to ask for. A
   *  sweep needs them regardless, so this only ever adds work. */
  inSample: boolean;
  /** Run a playbook against an instrument it was not calibrated for. The
   *  measurement is legitimate research — a correlation or a portability
   *  read — and is refused unless it was asked for by name, so nobody
   *  measures a calibration against the wrong instrument by typo. */
  crossInstrument: boolean;
  /** Let `--set` give a calibration-list param a value off its list. Research,
   *  refused unless asked for by name; the header's `offCalibration` records
   *  which settings were off, whatever the flags. */
  explore: boolean;
  /** Cumulative CPU duty cycle each process holds itself to. 100 is no cap. */
  cpuTarget: number;
  /** Window processes for `walk-forward`'s sweep and `lift`'s folds; 1 forks
   *  nothing. Always 1 on the other commands. */
  workers: number;
  /** `--topstep-tail`: splice Topstep bars past the archive's end. Off by
   *  default — a calibration run is reproducible from the archive alone. */
  topstepTail: boolean;
  /** Everything after the command, verbatim, for the run header. */
  raw: string[];
}

const REQUIRED = ["--ticker", "--timeframe", "--from", "--to"] as const;

/** `labels` reads bars and the classifier only; every other command runs a
 *  playbook's hooks and cannot start without one. */
const COMMANDS_WITHOUT_PLAYBOOK: ReadonlySet<Command> = new Set<Command>(["labels"]);

const VALUE_FLAGS = new Set([
  "--ticker",
  "--bar-symbol",
  "--timeframe",
  "--from",
  "--to",
  "--playbook",
  "--set",
  "--regime",
  "--classifier-version",
  "--contracts",
  "--risk-usd",
  "--max-contracts",
  "--daily-loss-usd",
  "--daily-profit-usd",
  "--fees",
  "--out",
  "--warmup-days",
  "--train",
  "--test",
  "--step",
  "--sweep",
  "--objective",
  "--permutations",
  "--min-cell-trades",
  "--min-lift-r",
  "--fold-consistency",
  "--seed",
  "--cpu-target",
  WORKERS_FLAG,
]);

/** Flags that take no value; a following token is the next flag, not theirs. */
export const EXPLORE_FLAG = "--explore";
export const TOPSTEP_TAIL_FLAG = "--topstep-tail";

const BOOLEAN_FLAGS = new Set([
  "--perturb",
  "--in-sample",
  "--cross-instrument",
  EXPLORE_FLAG,
  TOPSTEP_TAIL_FLAG,
]);

export function parseCommand(argv: string[]): Command {
  const name = argv[0];
  if (name == null || name.startsWith("-")) {
    throw new CliError(`Expected a command, one of: ${COMMANDS.join(", ")}`);
  }
  const found = COMMANDS.find((c) => c === name);
  if (!found) {
    throw new CliError(`Unknown command "${name}". Expected one of: ${COMMANDS.join(", ")}`);
  }
  return found;
}

/** Group `--flag value` pairs, keeping repeats. Bare `--flag` is refused. */
function collect(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new CliError(`Unexpected argument "${token}" — every value follows its own flag`);
    }
    const [flag, inlineValue] = splitInline(token);
    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue != null) throw new CliError(`Flag "${flag}" takes no value`);
      out.set(flag, ["true"]);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) {
      throw new CliError(`Unknown flag "${flag}"`);
    }
    const value = inlineValue ?? argv[++i];
    if (value == null || value.startsWith("--")) {
      throw new CliError(`Flag "${flag}" needs a value`);
    }
    const bucket = out.get(flag);
    if (bucket) bucket.push(value);
    else out.set(flag, [value]);
  }
  return out;
}

function splitInline(token: string): [string, string | null] {
  const eq = token.indexOf("=");
  return eq === -1 ? [token, null] : [token.slice(0, eq), token.slice(eq + 1)];
}

function single(flags: Map<string, string[]>, flag: string): string | null {
  const values = flags.get(flag);
  if (values == null) return null;
  if (values.length > 1) {
    throw new CliError(`Flag "${flag}" was given ${values.length} times; it takes one value`);
  }
  return values[0];
}

export function parseArgs(command: Command, argv: string[]): CliArgs {
  const flags = collect(argv);

  // The two sizing modes answer different questions — signal quality in R
  // against account fit in dollars — so a run that quietly picked one would
  // produce a file whose numbers do not mean what the operator asked for.
  if (flags.has("--risk-usd") && flags.has("--contracts")) {
    throw new CliError(
      "--risk-usd and --contracts are mutually exclusive: one sizes every entry off the " +
        "per-trade budget, the other holds it fixed.",
    );
  }
  if (flags.has("--max-contracts") && !flags.has("--risk-usd")) {
    throw new CliError("--max-contracts only applies with --risk-usd");
  }
  // The budget's denominator is one contract's loss at the stop **with the
  // round-trip fee in it**, which is what the engine divides by. With fees off
  // the run sizes on a number no live account ever pays, so it reports more
  // contracts and fewer budget skips than the engine would — and `--risk-usd`
  // exists to be a preview of the engine rather than an approximation of it.
  if (flags.has("--risk-usd") && single(flags, "--fees") === "off") {
    throw new CliError(
      "--risk-usd cannot be combined with --fees off: the per-trade budget is " +
        "sized on one contract's loss at the stop including fees, so a fee-free " +
        "denominator reports a contract count the engine would not place.",
    );
  }

  // `run` only: a walk-forward or a lift reaches years back, where the tail
  // serves nothing, and a label must agree with the archive-only nightly job.
  // With `--bar-symbol` the tail would splice the ticker's own contract onto
  // another instrument's series.
  if (flags.has(TOPSTEP_TAIL_FLAG) && command !== "run") {
    throw new CliError(`${TOPSTEP_TAIL_FLAG} applies to run only`);
  }
  if (flags.has(WORKERS_FLAG) && !COMMANDS_WITH_WORKERS.has(command)) {
    throw new CliError(
      `${WORKERS_FLAG} applies to ${[...COMMANDS_WITH_WORKERS].join(" and ")} only: ` +
        `${command} is one bar loop with nothing to fan out`,
    );
  }
  if (flags.has(TOPSTEP_TAIL_FLAG) && flags.has("--bar-symbol")) {
    throw new CliError(
      `${TOPSTEP_TAIL_FLAG} cannot be combined with --bar-symbol: the tail reads --ticker's own ` +
        `Topstep contract, which is not the substituted series.`,
    );
  }

  for (const flag of REQUIRED) {
    if (!flags.has(flag)) throw new CliError(`Missing required flag ${flag}`);
  }
  if (!COMMANDS_WITHOUT_PLAYBOOK.has(command) && !flags.has("--playbook")) {
    throw new CliError("Missing required flag --playbook");
  }

  const tickerRaw = single(flags, "--ticker") ?? "";
  if (!isSpecTicker(tickerRaw)) {
    throw new CliError(`--ticker must be one of ${SPEC_TICKERS.join(", ")}, got "${tickerRaw}"`);
  }

  const barSymbolRaw = single(flags, "--bar-symbol");
  if (barSymbolRaw != null && !BAR_SYMBOL_SET.has(barSymbolRaw)) {
    throw new CliError(
      `--bar-symbol must be one of ${BAR_SYMBOLS.join(", ")}, got "${barSymbolRaw}"`,
    );
  }
  // Another index's bars priced on this ticker's grid give plausible, wrong dollars.
  if (barSymbolRaw != null && BAR_SYMBOL_TICKER[barSymbolRaw] !== tickerRaw) {
    throw new CliError(
      `--bar-symbol ${barSymbolRaw} is not ${tickerRaw}'s index; it prices as ${BAR_SYMBOL_TICKER[barSymbolRaw]}`,
    );
  }

  const timeframeRaw = single(flags, "--timeframe") ?? "";
  const timeframe = CLI_TIMEFRAMES.find((t) => t === timeframeRaw);
  if (!timeframe) {
    throw new CliError(
      `--timeframe must be one of ${CLI_TIMEFRAMES.join(", ")}, got "${timeframeRaw}"`,
    );
  }

  const from = parseSessionDate(single(flags, "--from") ?? "", "--from");
  const to = parseSessionDate(single(flags, "--to") ?? "", "--to");
  if (from > to) throw new CliError(`--from ${from} is after --to ${to}`);

  const feesRaw = single(flags, "--fees") ?? "on";
  if (feesRaw !== "on" && feesRaw !== "off") {
    throw new CliError(`--fees must be "on" or "off", got "${feesRaw}"`);
  }

  const objectiveRaw = single(flags, "--objective") ?? "expectancyR";
  const objective = OBJECTIVES.find((o) => o === objectiveRaw);
  if (!objective) {
    throw new CliError(
      `--objective must be one of ${OBJECTIVES.join(", ")}, got "${objectiveRaw}"`,
    );
  }

  // One implementation exists. Accepting "2" and running v1 would stamp a
  // header with a version the run cannot back.
  const classifierVersion = single(flags, "--classifier-version") ?? CLASSIFIER_VERSION;
  if (classifierVersion !== CLASSIFIER_VERSION) {
    throw new CliError(
      `--classifier-version must be "${CLASSIFIER_VERSION}", got "${classifierVersion}": ` +
        `it is the only classifier implemented.`,
    );
  }

  const sweep = (flags.get("--sweep") ?? []).map(parseSweepAxis);
  assertSweepBudget(sweep);

  const regimes = parseRegimes(single(flags, "--regime"));
  const usesClassifier = command === "labels" || command === "lift" || regimes != null;
  const perturb = flags.has("--perturb");
  const warmupDays = Math.max(
    positiveInt(single(flags, "--warmup-days"), "--warmup-days", DEFAULT_WARMUP_SESSION_DAYS),
    usesClassifier ? CLASSIFIER_WARMUP_SESSION_DAYS : 0,
    // A variant with a longer baseline needs a longer warmup, or its
    // agreement number reports the sessions the CLI could not hand it rather
    // than the sessions the classifier disagreed on.
    perturb ? PERTURB_WARMUP_SESSION_DAYS : 0,
  );

  const train = months(single(flags, "--train"), "--train", DEFAULT_TRAIN_MONTHS);
  const test = months(single(flags, "--test"), "--test", DEFAULT_TEST_MONTHS);
  const step = months(single(flags, "--step"), "--step", DEFAULT_STEP_MONTHS);
  if (step < test) {
    throw new CliError(
      `--step ${step}m is shorter than --test ${test}m: consecutive test windows would ` +
        `overlap and the pooled held-out set would count the same trades twice. ` +
        `Use --step at least as long as --test.`,
    );
  }

  return {
    command,
    ticker: tickerRaw,
    barSymbol: barSymbolRaw,
    timeframe,
    from,
    to,
    playbook: single(flags, "--playbook"),
    sets: (flags.get("--set") ?? []).map(parseSet),
    contracts: positiveInt(single(flags, "--contracts"), "--contracts", 1),
    riskUsd: optionalPositiveNumber(single(flags, "--risk-usd"), "--risk-usd"),
    // Defaults to the reviewed ceiling the engine itself caps at, so an
    // unstated cap makes a `--risk-usd` run a preview of what would have been
    // placed rather than a wider basis. A larger value is accepted and is
    // research — measuring the uncapped basis is what produced the ceiling —
    // and the run header records the number, which is what keeps that artifact
    // readable as something other than a preview.
    maxContracts: positiveInt(
      single(flags, "--max-contracts"),
      "--max-contracts",
      REVIEWED_MAX_CONTRACTS,
    ),
    dailyLossUsd: optionalPositiveNumber(single(flags, "--daily-loss-usd"), "--daily-loss-usd"),
    dailyProfitUsd: optionalPositiveNumber(
      single(flags, "--daily-profit-usd"),
      "--daily-profit-usd",
    ),
    fees: feesRaw === "on",
    warmupDays,
    out: single(flags, "--out"),
    classifierVersion,
    regimes,
    usesClassifier,
    perturb,
    permutations: positiveInt(
      single(flags, "--permutations"),
      "--permutations",
      DEFAULT_PERMUTATIONS,
    ),
    minCellTrades: positiveInt(
      single(flags, "--min-cell-trades"),
      "--min-cell-trades",
      DEFAULT_MIN_CELL_TRADES,
    ),
    minLiftR: positiveNumber(single(flags, "--min-lift-r"), "--min-lift-r", DEFAULT_MIN_LIFT_R),
    foldConsistency: fraction(
      single(flags, "--fold-consistency"),
      "--fold-consistency",
      DEFAULT_FOLD_CONSISTENCY,
    ),
    seed: positiveInt(single(flags, "--seed"), "--seed", DEFAULT_SEED),
    train,
    test,
    step,
    sweep,
    objective,
    inSample: flags.has("--in-sample"),
    crossInstrument: flags.has("--cross-instrument"),
    explore: flags.has(EXPLORE_FLAG),
    cpuTarget: cpuTarget(single(flags, "--cpu-target")),
    workers: COMMANDS_WITH_WORKERS.has(command)
      ? workerCount(single(flags, WORKERS_FLAG), process.env[WORKERS_ENV_VAR], os.availableParallelism())
      : DEFAULT_WORKERS,
    topstepTail: flags.has(TOPSTEP_TAIL_FLAG),
    raw: argv,
  };
}

/**
 * Whether `walk-forward` runs each fold's **training** window at all.
 *
 * A sweep has to — it is picking constants on it. Without one there is
 * nothing to pick, the fold would run the same base constants twice, and the
 * command is a pure held-out report; the training half is then a train-vs-test
 * comparison someone has to ask for.
 */
export function runsInSampleWindows(args: Pick<CliArgs, "sweep" | "inSample">): boolean {
  return args.sweep.length > 0 || args.inSample;
}

export function cpuTarget(raw: string | null): number {
  if (raw == null) return DEFAULT_CPU_TARGET_PCT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_CPU_TARGET_PCT || n > NO_THROTTLE_PCT) {
    throw new CliError(
      `--cpu-target must be a whole percentage between ${MIN_CPU_TARGET_PCT} and ` +
        `${NO_THROTTLE_PCT}, got "${raw}"`,
    );
  }
  return n;
}

/**
 * `--workers` if given, else `BACKTEST_WORKERS`, else 1. Either is a whole
 * number from 1 to the machine's core count; anything else is refused naming
 * its source, because a typo in a box's env file otherwise surfaces as a sweep
 * that quietly ran on one core.
 */
export function workerCount(
  flag: string | null,
  env: string | undefined,
  cores: number,
): number {
  const [raw, source] = flag != null ? [flag, WORKERS_FLAG] : [env, WORKERS_ENV_VAR];
  // Empty is unset, as `artifactRoot` reads `BACKTEST_ARTIFACTS_DIR`.
  if (raw == null || raw.length === 0) return DEFAULT_WORKERS;
  // Digits only: `Number` also reads "0x4", "4.0" and "1e0" as 4 or 1.
  const n = Number(raw);
  if (!WHOLE_NUMBER.test(raw) || n < 1 || n > cores) {
    throw new CliError(
      `${source} must be a whole number from 1 to ${cores} (this machine's core count), ` +
        `got "${raw}"`,
    );
  }
  return n;
}

function parseSet(raw: string): { key: string; value: string } {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new CliError(`--set expects key=value, got "${raw}"`);
  return { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
}

export function parseSweepAxis(raw: string): SweepAxis {
  const eq = raw.indexOf("=");
  if (eq <= 0) throw new CliError(`--sweep expects key=lo:hi:step, got "${raw}"`);
  const key = raw.slice(0, eq);
  const parts = raw.slice(eq + 1).split(":");
  if (parts.length !== 3) {
    throw new CliError(`--sweep expects key=lo:hi:step, got "${raw}"`);
  }
  const [lo, hi, step] = parts.map(Number);
  if (![lo, hi, step].every(Number.isFinite)) {
    throw new CliError(`--sweep ${key}: lo, hi and step must all be numbers`);
  }
  if (step <= 0) throw new CliError(`--sweep ${key}: step must be positive`);
  if (hi < lo) throw new CliError(`--sweep ${key}: hi must not be below lo`);
  return { key, lo, hi, step };
}

export function sweepAxisPoints(axis: SweepAxis): number[] {
  const points: number[] = [];
  // Accumulate by index rather than by repeated addition: `lo + n*step`
  // does not drift, `cursor += step` does, and a drifted last point can
  // fall short of `hi` and silently drop a grid column.
  const count = Math.floor((axis.hi - axis.lo) / axis.step + 1e-9) + 1;
  for (let i = 0; i < count; i++) points.push(axis.lo + i * axis.step);
  return points;
}

export function sweepGridSize(sweep: SweepAxis[]): number {
  return sweep.reduce((n, axis) => n * sweepAxisPoints(axis).length, 1);
}

export function assertSweepBudget(sweep: SweepAxis[]): void {
  if (sweep.length === 0) return;
  if (sweep.length > MAX_SWEEP_KEYS) {
    throw new CliError(
      `--sweep takes at most ${MAX_SWEEP_KEYS} keys; ${sweep.length} were given`,
    );
  }
  const size = sweepGridSize(sweep);
  if (size > MAX_SWEEP_GRID_POINTS) {
    throw new CliError(
      `--sweep grid is ${size} points; the cap is ${MAX_SWEEP_GRID_POINTS}. ` +
        `Widen the step or drop a key.`,
    );
  }
}

function positiveInt(raw: string | null, flag: string, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new CliError(`${flag} must be a positive whole number, got "${raw}"`);
  }
  return n;
}

/**
 * `--regime all` (and an absent flag) is null — no gate, and no classifier
 * run at all. Anything else is a comma list of the four cells; `unknown` is
 * not one of them, because standing down is what an unknown label does.
 */
function parseRegimes(raw: string | null): RegimeCell[] | null {
  if (raw == null || raw === "all") return null;
  const cells = raw.split(",").map((c) => c.trim());
  const bad = cells.filter((c) => !isRegimeCell(c));
  if (bad.length > 0) {
    throw new CliError(
      `--regime: unknown cell${bad.length > 1 ? "s" : ""} ${bad.join(", ")}. ` +
        `Expected "all" or a comma list of: ${REGIME_CELLS.join(", ")}`,
    );
  }
  return cells.filter(isRegimeCell);
}

function positiveNumber(raw: string | null, flag: string, fallback: number): number {
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive number, got "${raw}"`);
  }
  return n;
}

function fraction(raw: string | null, flag: string, fallback: number): number {
  const n = positiveNumber(raw, flag, fallback);
  if (n > 1) throw new CliError(`${flag} must be a fraction of 1 or less, got "${raw}"`);
  return n;
}

function optionalPositiveNumber(raw: string | null, flag: string): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError(`${flag} must be a positive number, got "${raw}"`);
  }
  return n;
}

function months(raw: string | null, flag: string, fallback: number): number {
  if (raw == null) return fallback;
  const match = raw.match(/^(\d+)m$/);
  if (!match) throw new CliError(`${flag} must be a month count like "18m", got "${raw}"`);
  const n = Number(match[1]);
  if (n < 1) throw new CliError(`${flag} must be at least 1m`);
  return n;
}
