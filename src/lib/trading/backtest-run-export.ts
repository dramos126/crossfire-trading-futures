/**
 * The file *Try settings* downloads: what a full CLI run of the same settings
 * would be, and the command that starts it.
 *
 * **The command is built to the CLI's own parser, and a test round-trips it.**
 * `--set` carries exactly the params that differ from the module's defaults;
 * `resolveFullParams` merges those over the same defaults, so the command
 * reproduces the form's resolved set rather than restating it. `timeframe` is
 * the one param that is never a `--set`: it is `--timeframe`, which the CLI
 * writes into the params itself.
 *
 * **A value off the playbook's calibration list adds `--explore`**, and only
 * then: the CLI refuses such a value without it, and a calibrated run carrying
 * it would claim a research basis it does not have.
 *
 * **When the CLI cannot express the settings, the file says so instead of
 * emitting a command that runs something else** — a changed param of a type
 * `--set` refuses, a timeframe the CLI does not run, or a risk-sized run with
 * fees off. `command` is null and `commandUnavailable` is the sentence.
 */
import type { BacktestSizing } from "@/lib/trading/backtest";
import type { RunSizing } from "@/lib/trading/backtest-artifacts";
import { RISK_SIZING_NEEDS_FEES } from "@/lib/trading/backtest-sizing-input";
import { deepEqual } from "@/lib/trading/deep-equal";
import type { SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { offCalibrationKeys } from "@/lib/trading/param-explore";
import type { ParamSchema, ParamValues } from "@/lib/trading/strategy-types";

/** `--timeframe`'s accepted set in `cli/backtest/args.ts`, copied so this
 *  browser-side module does not pull the CLI's argument graph in;
 *  `backtest-run-export.test.ts` pins the copy against the real parser. */
export const CLI_TIMEFRAMES: readonly string[] = ["1m", "5m", "15m", "30m"];

/** `EXPLORE_FLAG` in `cli/backtest/args.ts`, copied for the same reason;
 *  the round-trip test is what pins it. */
export const CLI_EXPLORE_FLAG = "--explore";

const TIMEFRAME_PARAM = "timeframe";

/** The param types `--set` coerces. The rest are structured and the CLI
 *  refuses them by name. */
const SETTABLE_TYPES: ReadonlySet<ParamSchema["type"]> = new Set<ParamSchema["type"]>([
  "number",
  "integer",
  "boolean",
  "select",
  "time",
]);

const COMMAND_PREFIX = "corepack yarn backtest";

/** A shell word that needs no quoting. Anything else is single-quoted. */
const SAFE_SHELL_WORD = /^[A-Za-z0-9_.,:=+\-/@%]+$/;

/** Keys whose value differs from the module's declared default, in schema
 *  order. `timeframe` is included — it is a param like any other here; the
 *  command expresses it through its own flag. */
export function changedParamKeys(
  schema: Record<string, ParamSchema>,
  params: ParamValues,
): string[] {
  return Object.entries(schema)
    .filter(([key, p]) => key in params && !deepEqual(params[key], p.default))
    .map(([key]) => key);
}

/** `runBacktest`'s sizing in the run header's shape, so the file reads like
 *  a `run.json` and loads back the same way. */
export function toHeaderSizing(sizing: BacktestSizing): RunSizing {
  return sizing.mode === "fixed"
    ? { mode: "contracts", contracts: sizing.contracts }
    : { mode: "risk", riskUsd: sizing.maxRiskPerTradeUsd, maxContracts: sizing.maxContracts };
}

export interface RunExportInput {
  playbookKey: string;
  playbookVersion: string | null;
  schema: Record<string, ParamSchema>;
  ticker: SpecTicker;
  /** Session dates, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** The form's whole resolved set — defaults with every edit applied. */
  params: ParamValues;
  /** The timeframe the run used: the params' own, else the module's. */
  timeframe: string;
  includeFees: boolean;
  feePerSideUsd: number;
  sizing: BacktestSizing;
  loadedFrom: { runPath: string; label: string } | null;
  now: Date;
}

export interface RunExport {
  playbookKey: string;
  playbookVersion: string | null;
  ticker: SpecTicker;
  timeframe: string;
  from: string;
  to: string;
  sizing: RunSizing;
  fees: { on: boolean; feePerSideUsd: number };
  /** Only the params that differ from the module's defaults. */
  changedParams: ParamValues;
  resolvedParams: ParamValues;
  /** The keys off the playbook's calibration list, as a run header records
   *  them; the command carries `--explore` exactly when this is non-empty. */
  offCalibration: string[];
  /** The saved run the form was loaded from, if any. */
  loadedFromRun: { runPath: string; label: string } | null;
  /** The command's words after `corepack yarn backtest`, as the CLI's
   *  parser receives them. Null with `command`. */
  cliArgs: string[] | null;
  command: string | null;
  /** Why there is no command, in a sentence. Null when there is one. */
  commandUnavailable: string | null;
  generatedAt: string;
}

export function runExportFilename(playbookKey: string, now: Date): string {
  return `${playbookKey}-try-settings-${now.toISOString().slice(0, 10)}.json`;
}

export function buildRunExport(input: RunExportInput): RunExport {
  const changed = changedParamKeys(input.schema, input.params);
  const changedParams: ParamValues = {};
  for (const key of changed) changedParams[key] = input.params[key];

  const offCalibration = offCalibrationKeys(input.schema, input.params);
  const unavailable = commandUnavailableReason(input, changed);
  const cliArgs = unavailable == null ? buildCliArgs(input, changed, offCalibration) : null;

  return {
    playbookKey: input.playbookKey,
    playbookVersion: input.playbookVersion,
    ticker: input.ticker,
    timeframe: input.timeframe,
    from: input.from,
    to: input.to,
    sizing: toHeaderSizing(input.sizing),
    fees: { on: input.includeFees, feePerSideUsd: input.includeFees ? input.feePerSideUsd : 0 },
    changedParams,
    resolvedParams: input.params,
    offCalibration,
    loadedFromRun: input.loadedFrom,
    cliArgs,
    command: cliArgs == null ? null : [COMMAND_PREFIX, ...cliArgs.map(shellWord)].join(" "),
    commandUnavailable: unavailable,
    generatedAt: input.now.toISOString(),
  };
}

function commandUnavailableReason(input: RunExportInput, changed: string[]): string | null {
  if (!CLI_TIMEFRAMES.includes(input.timeframe)) {
    return (
      `The backtest command runs ${CLI_TIMEFRAMES.join(", ")} bars, not ${input.timeframe}, ` +
      `so it cannot reproduce this run.`
    );
  }
  if (input.sizing.mode === "risk" && !input.includeFees) return RISK_SIZING_NEEDS_FEES;
  const unsettable = changed.filter(
    (key) => key !== TIMEFRAME_PARAM && !SETTABLE_TYPES.has(input.schema[key].type),
  );
  if (unsettable.length > 0) {
    const labels = unsettable.map((key) => input.schema[key].label).join(", ");
    return (
      `The backtest command cannot set ${labels}, so it cannot reproduce a run that changes ` +
      `${unsettable.length === 1 ? "it" : "them"}.`
    );
  }
  return null;
}

function buildCliArgs(input: RunExportInput, changed: string[], offCalibration: string[]): string[] {
  const args = [
    "run",
    "--playbook",
    input.playbookKey,
    "--ticker",
    input.ticker,
    "--timeframe",
    input.timeframe,
    "--from",
    input.from,
    "--to",
    input.to,
  ];
  if (input.sizing.mode === "fixed") {
    args.push("--contracts", String(input.sizing.contracts));
  } else {
    args.push(
      "--risk-usd",
      String(input.sizing.maxRiskPerTradeUsd),
      "--max-contracts",
      String(input.sizing.maxContracts),
    );
  }
  args.push("--fees", input.includeFees ? "on" : "off");
  if (offCalibration.length > 0) args.push(CLI_EXPLORE_FLAG);
  for (const key of changed) {
    if (key === TIMEFRAME_PARAM) continue;
    args.push("--set", `${key}=${String(input.params[key])}`);
  }
  return args;
}

function shellWord(word: string): string {
  return SAFE_SHELL_WORD.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
