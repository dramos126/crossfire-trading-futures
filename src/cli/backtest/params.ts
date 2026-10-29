/**
 * `--set key=value` onto `paramOverrides`.
 *
 * Today's params are tomorrow's calibration constants, so the CLI treats
 * them as one surface: a key the playbook does not declare is an error, not
 * a warning. A silently ignored override is a sweep whose axis did nothing
 * and whose result reads as a finding.
 */
import type {
  CommonParams,
  ParamSchema,
  ParamValues,
  StrategyModule,
} from "@/lib/trading/strategy-types";
import {
  defaultParamValues,
  instrumentRefusalFor,
  migrateLegacyParamOverrides,
} from "@/lib/trading/strategy-types";
import type { BacktestSizing } from "@/lib/trading/backtest";
import type { DaySessionWindow } from "@/lib/trading/contracts/contract-specs";
import { crossTimeframeExitRefusalFor } from "@/lib/trading/filters";
import type { AllFilterParams } from "@/lib/trading/filters";
import {
  exploreValueRefusal,
  isExplorable,
  timeWindowOutsideSessionRefusal,
} from "@/lib/trading/param-explore";
import { playbookSizingRefusal } from "@/lib/trading/orders/risk-sizer";
import { CliError } from "./cli-error";
import { EXPLORE_FLAG, type CliArgs } from "./args";

const TIMEFRAME_PARAM = "timeframe";
const TIME_WINDOW_START_PARAM = "timeWindowStartEt";
const TIME_WINDOW_END_PARAM = "timeWindowEndEt";

/**
 * `--timeframe` first, `--set` last.
 *
 * **Neither `--contracts` nor `--daily-loss-usd` is here**, and neither comes
 * back: both reach `runBacktest` as arguments (`sizing`, `dailyPnl`) rather
 * than as params, because the contract count is the account's risk posture's
 * and the daily gate is the account's — so writing either into the blob would
 * put a number in `resolvedParams` and in `calibrationHash` that no hook
 * reads. The header records the count on its own `sizing` field.
 */
export function resolveParamOverrides(
  strategy: StrategyModule,
  args: CliArgs,
  sweepValues: Record<string, number> = {},
): ParamValues {
  const overrides: ParamValues = { [TIMEFRAME_PARAM]: args.timeframe };

  for (const { key, value } of args.sets) {
    overrides[key] = coerce(strategy, key, value, "--set", args.explore);
  }
  for (const [key, value] of Object.entries(sweepValues)) {
    const schema = assertKnownKey(strategy, key, "--sweep");
    // A swept point on a select is a `--set` of that value, and its list holds
    // the same way; the number itself is what the grid writes, as before.
    if (schema.type === "select") coerce(strategy, key, String(value), "--sweep", args.explore);
    overrides[key] = value;
  }
  return overrides;
}

/**
 * `runBacktest`'s `sizing` option: `--risk-usd` or `--contracts`, which
 * `args.ts` already refuses together.
 *
 * One helper rather than the expression at three call sites, because the
 * three are `run`, `walk-forward` and `lift` and a fold that sized
 * differently from its own summary is exactly the drift the CLI's header
 * exists to make impossible.
 */
export function sizingFromArgs(args: CliArgs): BacktestSizing {
  if (args.riskUsd == null) return { mode: "fixed", contracts: args.contracts };
  return { mode: "risk", maxRiskPerTradeUsd: args.riskUsd, maxContracts: args.maxContracts };
}

/**
 * The params the run actually executes: the module's declared defaults under
 * the CLI's overrides, merged exactly as `runBacktest` merges them.
 *
 * A header that hashes the overrides alone reports the same
 * `calibrationHash` for every module run with the same flags, and does not
 * move when a playbook bumps a constant — which is the one thing the hash
 * exists to pin.
 */
export function resolveFullParams(
  strategy: StrategyModule,
  args: CliArgs,
  sweepValues: Record<string, number> = {},
): ParamValues {
  return {
    ...defaultParamValues(strategy.params),
    ...migrateLegacyParamOverrides(
      strategy.key ?? "",
      resolveParamOverrides(strategy, args, sweepValues),
    ),
  };
}

/**
 * Every param set the run will execute: the base constants, then one per sweep
 * grid point.
 *
 * Here rather than inline at the caller so the assertions below are checked
 * against the composition the run actually executes. The grid is passed in
 * rather than built here — `sweepGrid` lives in `walk-forward-command.ts`,
 * which imports this module.
 */
export function resolveExecutedParamSets(
  strategy: StrategyModule,
  args: CliArgs,
  sweep: Array<Record<string, number>>,
): ParamValues[] {
  return [
    resolveFullParams(strategy, args),
    ...sweep.map((point) => resolveFullParams(strategy, args, point)),
  ];
}

/**
 * Refuse a run whose time-of-day window cannot fire inside the playbook's own
 * session.
 *
 * **The refusal is against `config.session`, and that is the whole of what the
 * CLI will and will not measure.** While the session was a `CommonParams` key
 * every module carried the same 09:30–15:55 ET default, so this gate read as
 * "the CLI cannot measure a window outside the cash session" and a trader
 * asking for a London morning got a refusal about the platform rather than
 * about the playbook. A playbook that declares 08:20–13:30 is now measurable
 * at 08:35–09:30 with no flag, because the window it trades is its own
 * constant. What has not changed is the direction of the lever: the
 * time-window entry filter **intersects** and never widens, so an empty
 * intersection is still zero entries and a file that reads as "the playbook
 * found no signals" rather than "not measured". A partial overlap is the
 * filter narrowing as documented and runs.
 *
 * **Do not answer a window this refuses with a flag that moves the session.**
 * A CLI-only override would make the backtest a preview of a playbook the
 * engine does not run; the answer is a `config.session` the module declares
 * and both paths read.
 */
export function assertSessionMeasurable(strategy: StrategyModule, params: ParamValues): void {
  const refusal = timeWindowOutsideSessionRefusal(
    strategy.key ?? "playbook",
    strategy.config.session,
    params,
  );
  if (refusal == null) return;
  throw new CliError(
    `--set ${TIME_WINDOW_START_PARAM}/${TIME_WINDOW_END_PARAM}: ${refusal} A playbook that ` +
      `should trade another window declares it in config.session, which the engine reads too.`,
  );
}

/**
 * Refuse a run whose settings leave the playbook's hooks no entry to take, in
 * the module's own sentence (`StrategyModule.settingsRefusal`) — the one
 * *Try settings* disables Run with. Every param set the run executes, because
 * a sweep can move one of the settings a rule compares.
 */
export function assertSettingsTakeEntries(
  strategy: StrategyModule,
  paramSets: ParamValues[],
  daySession: DaySessionWindow | null,
): void {
  for (const params of paramSets) {
    // The platform's two sizing settings first: a value the engine's sizer
    // would throw on every entry is a run with no trades in it.
    const sizingRefusal = playbookSizingRefusal(params);
    if (sizingRefusal != null) throw new CliError(sizingRefusal);
    // The cast `runBacktest` makes on the same merged object.
    const refusal = strategy.settingsRefusal?.(params as unknown as CommonParams, daySession) ?? null;
    if (refusal != null) throw new CliError(refusal);
  }
}

/**
 * Refuse a run that enables an exit filter on a timeframe the backtest cannot
 * serve — the filter reads `crossTimeframeBars`, which only the engine
 * populates, so it would return false on every bar here and fire normally live.
 *
 * `runBacktest` throws on the same condition and that throw is the guarantee;
 * this exists so the CLI says it before the bar read rather than after it, in
 * the voice its other refusals use.
 *
 * **Every param set the run executes**, for the reason
 * `assertWarmupCoversDeclaredSessions` checks every one: `--set
 * emaExitTimeframe=15m` is a param like any other, and a sweep that moved an
 * enable key would otherwise be measured at the points that happened to be off.
 *
 * **There is no override flag, and the contrast with `--cross-instrument` is
 * the reason.** That one changes which bars honest hooks are handed, and the
 * run header records the swap, so the artifact cannot be misread. Here nothing
 * could be recorded that would make the file readable: the filter did not run,
 * and a number produced without it is a number about a different strategy.
 */
export function assertCrossTimeframeExitMeasurable(paramSets: ParamValues[]): void {
  for (const params of paramSets) {
    const refusal = crossTimeframeExitRefusalFor(params as unknown as AllFilterParams);
    if (refusal == null) continue;
    throw new CliError(
      `${refusal} There is no flag that measures it anyway — unlike --cross-instrument, ` +
        `nothing the run header could record would make the result readable.`,
    );
  }
}

/**
 * Refuse a run whose `--ticker` is not the instrument the playbook declares it
 * was calibrated for, unless `--cross-instrument` asked for it by name.
 *
 * **The escape hatch is a flag here and deliberately not one on the session
 * check above, and the difference is what each would be overriding.** A CLI
 * flag that moved `config.session` would make the backtest a preview of a
 * playbook the engine does not run. This one moves nothing: the hooks, the
 * constants and the window are exactly what the engine would use, and the only
 * thing that changes is which bars they are handed. Cross-instrument runs are
 * real research — an MNQ playbook run on MES bars is a portability read and
 * a correlation input — so refusing them outright would delete a measurement the trader
 * needs, and allowing them silently is how an MNQ calibration gets quoted off
 * MES bars.
 *
 * **What keeps the artifact honest is the header, not the flag.** `buildHeader`
 * stamps `calibratedFor`, so `ticker !== calibratedFor` is readable off any
 * run directory without knowing which flags were typed. A reader who has to
 * grep `cliArgs` for a flag to find out what a file measured will not.
 */
export function assertInstrumentCalibrated(
  strategy: StrategyModule,
  ticker: string,
  crossInstrument: boolean,
): void {
  if (crossInstrument) return;
  const refusal = instrumentRefusalFor(strategy.config, ticker);
  if (refusal == null) return;
  throw new CliError(
    `${refusal} Pass --cross-instrument to measure it on ${ticker} anyway — the run header ` +
      `records the instrument it was calibrated for, so the file cannot be read as an ` +
      `on-instrument result.`,
  );
}

/**
 * `--warmup-days` is walked back in **weekdays** (`shiftSessionDatesBack`) and
 * the calendar it lands on has holidays in it, so the sessions delivered are
 * fewer than the days asked for: every CME closure inside the window costs one,
 * and Christmas and New Year's Day are seven days apart, so two can fall inside
 * three weeks. The same shortfall the engine's `HOLIDAY_SLACK_DAYS` covers on
 * its calendar span, in the unit this side counts in. Three is a whole extra
 * holiday over the worst pair, and the surplus is warmup bars the run drops.
 */
export const WARMUP_HOLIDAY_SLACK_SESSIONS = 3;

/**
 * Refuse a run whose warmup is shorter than the sessions the module declared it
 * needs, at any params the run will execute.
 *
 * `warmupDaySessions` is the one declaration both paths honour — the engine
 * converts it to a bar depth for the live fetch, the CLI checks `--warmup-days`
 * against it here. Short of it, a session-scoped quantity is NaN for the first
 * part of the range and the module silently takes no entries there, which reads
 * as a thin market rather than as a run that could not be measured.
 *
 * **Every param set the run executes, not just the defaults.** A sweep resolves
 * a different declaration at every grid point — `--sweep atrPeriod=10:40:10`
 * asks ORB v2 for 11 sessions at one point and 41 at another — and asserting
 * once at the base constants let the deep end of the grid run starved while the
 * shallow end passed. The grid is at most `MAX_SWEEP_GRID_POINTS` and the
 * declaration is a pure function of the params, so every point is checked
 * rather than an assumed-monotonic maximum.
 */
export function assertWarmupCoversDeclaredSessions(
  strategy: StrategyModule,
  paramSets: ParamValues[],
  warmupDays: number,
): void {
  let needed = 0;
  for (const params of paramSets) {
    // The cast `runBacktest` makes on the same object: the merge above is the
    // module's own schema defaults under the CLI's overrides.
    const merged = params as unknown as CommonParams;
    const at = strategy.warmupDaySessions?.(merged) ?? 0;
    if (at > needed) needed = at;
  }
  const required = needed === 0 ? 0 : needed + WARMUP_HOLIDAY_SLACK_SESSIONS;
  if (warmupDays >= required) return;

  throw new CliError(
    `--warmup-days ${warmupDays} is short of the ${needed} completed day sessions ` +
      `"${strategy.key ?? "playbook"}" declares it needs at these params, plus ` +
      `${WARMUP_HOLIDAY_SLACK_SESSIONS} for the holidays the weekday walk-back does not skip, ` +
      `so its session-scoped gates would be unset over the start of the range and the run ` +
      `would under-count entries. Use --warmup-days ${required} or more.`,
  );
}

export function assertKnownKey(
  strategy: StrategyModule,
  key: string,
  flag: string,
): ParamSchema {
  const schema = strategy.params[key];
  if (!schema) {
    throw new CliError(
      `${flag} ${key}: "${strategy.key ?? "playbook"}" declares no param "${key}". ` +
        `Known keys: ${Object.keys(strategy.params).sort().join(", ")}`,
    );
  }
  return schema;
}

function coerce(
  strategy: StrategyModule,
  key: string,
  raw: string,
  flag: string,
  explore: boolean,
): ParamValues[string] {
  const schema = assertKnownKey(strategy, key, flag);
  switch (schema.type) {
    case "number":
    case "integer": {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        throw new CliError(`${flag} ${key}: "${raw}" is not a number`);
      }
      if (schema.type === "integer" && !Number.isInteger(n)) {
        throw new CliError(`${flag} ${key}: "${raw}" must be a whole number`);
      }
      return n;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new CliError(`${flag} ${key}: expected "true" or "false", got "${raw}"`);
    }
    case "select": {
      const allowed = schema.options.map((o) => o.value);
      if (allowed.includes(raw)) return raw;
      if (!isExplorable(schema)) {
        throw new CliError(`${flag} ${key}: expected one of ${allowed.join(", ")}, got "${raw}"`);
      }
      // The same footing as `--max-contracts` above the reviewed ceiling: the
      // run is research rather than a measurement of the playbook, and the
      // header's `offCalibration` is what says so afterwards.
      if (!explore) {
        throw new CliError(
          `${flag} ${key}: "${raw}" is outside "${strategy.key ?? "playbook"}"'s calibration ` +
            `(${allowed.join(", ")}). Pass ${EXPLORE_FLAG} to measure it anyway — the run header ` +
            `records every setting outside the calibration, so the file cannot be read as a ` +
            `calibrated result.`,
        );
      }
      const refusal = exploreValueRefusal(schema.explore, raw);
      if (refusal != null) throw new CliError(`${flag} ${key}: ${refusal}`);
      return raw;
    }
    case "time":
      return raw;
    default:
      throw new CliError(
        `${flag} ${key}: params of type "${schema.type}" are structured and cannot be set from the command line`,
      );
  }
}
