/**
 * *Try settings* on `/playbooks/[key]` — the pure half.
 *
 * Thirteenth pure module on the `deployment-status.ts` / `board-model.ts` /
 * `playbook-deploy-model.ts` pattern, for the usual reason: a form that loads
 * a saved run and silently keeps a key the playbook no longer reads, a reset
 * that leaves the sizing behind, a fresh run filed under a saved run's name —
 * each renders and each is wrong.
 *
 * **It runs through the existing in-browser runner and nothing else.** The
 * request is `useBacktestRunner`'s, the routes are `/api/backtest` and
 * `/api/backtest/eval`, and the trades come back as the CLI's own
 * `trades.jsonl` rows so the run reader reads them unchanged.
 */
import type { BacktestSizing } from "@/lib/trading/backtest";
import type { RunSummary } from "@/lib/trading/backtest-artifacts";
import { RISK_SIZING_NEEDS_FEES } from "@/lib/trading/backtest-sizing-input";
import { daySessionForTicker, type SpecTicker } from "@/lib/trading/contracts/contract-specs";
import { TICKER_OPTIONS, type TickerSymbol } from "@/lib/trading/domain";
import {
  FULL_RISK_PERCENT,
  NO_PLAYBOOK_CONTRACT_CAP,
  PLAYBOOK_MAX_CONTRACTS_PARAM,
  PLAYBOOK_RISK_PERCENT_PARAM,
  REVIEWED_MAX_CONTRACTS,
} from "@/lib/trading/orders/risk-sizer";
import { crossTimeframeExitRefusalFor, type AllFilterParams } from "@/lib/trading/filters";
import {
  offCalibrationRefusal,
  timeWindowOutsideSessionRefusal,
} from "@/lib/trading/param-explore";
import {
  defaultParamValues,
  type CommonParams,
  type ParamSchema,
  type ParamValues,
  type StrategyConfig,
  type StrategyModule,
} from "@/lib/trading/strategy-types";
import type { BacktestResponse } from "@/lib/hooks/use-backtest-runner";

const TIMEFRAME_PARAM = "timeframe";

// ── Copy ────────────────────────────────────────────────────────────────

/** The frame's `InfoIcon`. Split on `\n\n` per the tooltip rule. */
export const TRY_SETTINGS_HELP =
  "Runs this playbook in the browser on the settings below, starting from its own defaults, and reads the trades one at a time.\n\n" +
  "Load from saved run fills the form from a run the backtest command saved. A setting this playbook no longer has is left out and named.\n\n" +
  "Nothing here changes the playbook or saves the run. Export settings downloads the backtest command that runs and saves it.";

/** Beside Run. One plain line: the result is shown, never written. */
export const TRY_NOT_SAVED =
  "This run is not saved. Export settings gives the backtest command that saves one.";

export const TRY_NO_INSTRUMENT =
  "This playbook does not name the instrument it was calibrated for, so there is nothing to " +
  "run it on. That is declared in the playbook's code; the platform will not guess one.";

export const LOAD_PLACEHOLDER = "Playbook defaults";

export const NO_SAVED_RUNS_TO_LOAD = "No saved runs to load.";

export const RESET_LABEL = "Reset to playbook defaults";

/** Under the date fields. The why — calendar days with no warm-up here,
 *  trading sessions after warm-up bars in the backtest command — is in
 *  backtest.md; the operator needs only the consequence. */
export const TRY_DATES_NOTE = "The first day or two may differ from a full backtest.";

/**
 * Beside a ceiling above the live one. Accepted, as the backtest command's
 * `--max-contracts` accepts it: such a run is research, and the run states
 * which so its numbers are not read as what the engine would place.
 */
export function maxContractsNote(maxContracts: number): string | null {
  if (maxContracts <= REVIEWED_MAX_CONTRACTS) return null;
  return (
    `Above the live ceiling of ${REVIEWED_MAX_CONTRACTS} contracts, so this run is research, ` +
    `not a preview of what the engine would place.`
  );
}

export const SIZING_NEEDS_CONTRACTS = "Set a whole number of contracts, 1 or more.";
export const SIZING_NEEDS_RISK = "Set a risk per trade above $0.";
export const SIZING_NEEDS_MAX_CONTRACTS = "Set a maximum of 1 contract or more.";

/** How many settings differ from the playbook's own. */
export function describeChangedCount(count: number): string {
  if (count === 0) return "All settings at the playbook's defaults.";
  return `${count} setting${count === 1 ? "" : "s"} changed from the playbook's defaults.`;
}

// ── What it runs on ─────────────────────────────────────────────────────

export type TryInstrument =
  | { kind: "ready"; ticker: TickerSymbol; spec: SpecTicker }
  | { kind: "inert"; reason: string };

/** The instrument is the playbook's `calibratedFor` and nothing else — the
 *  same rule the Deploy control keeps, for the same reason. */
export function tryInstrument(config: Pick<StrategyConfig, "calibratedFor">): TryInstrument {
  const spec = config.calibratedFor;
  if (spec == null) return { kind: "inert", reason: TRY_NO_INSTRUMENT };
  const option = TICKER_OPTIONS.find((o) => o.symbol === `/${spec}`);
  if (!option) return { kind: "inert", reason: TRY_NO_INSTRUMENT };
  return { kind: "ready", ticker: option.symbol, spec };
}

// ── Sizing ──────────────────────────────────────────────────────────────

/**
 * The sizing controls' state. Both modes' numbers are held, so switching mode
 * and back does not lose what was typed; `riskUsd` is null until one is set,
 * because there is no playbook default for a dollar budget.
 */
export interface SizingDraft {
  mode: "fixed" | "risk";
  contracts: number;
  riskUsd: number | null;
  maxContracts: number;
}

/** One contract — the R basis, and what an unsized run has always used. The
 *  ceiling starts at the reviewed one, as the CLI's `--max-contracts` does. */
export const DEFAULT_SIZING_DRAFT: SizingDraft = {
  mode: "fixed",
  contracts: 1,
  riskUsd: null,
  maxContracts: REVIEWED_MAX_CONTRACTS,
};

/** The research note for the mode on screen: a fixed count above the live
 *  ceiling is research exactly as a risk run's cap above it is. */
export function sizingResearchNote(draft: SizingDraft): string | null {
  return maxContractsNote(draft.mode === "fixed" ? draft.contracts : draft.maxContracts);
}

/**
 * Fixed contracts is the run's own count on every entry, so the sizer — and
 * the playbook's two sizing settings with it — never runs. Said beside the
 * count whenever the form sets either one, so a run that ignores them does
 * not read as one that applied them.
 */
export const FIXED_SIZING_IGNORES_PLAYBOOK_LIMITS =
  "Fixed contracts takes this count on every entry, so Playbook max contracts and Share of " +
  "account risk do not apply. Choose Risk per trade to apply them.";

export function fixedSizingPlaybookNote(draft: SizingDraft, params: ParamValues): string | null {
  if (draft.mode !== "fixed") return null;
  const cap = params[PLAYBOOK_MAX_CONTRACTS_PARAM];
  const share = params[PLAYBOOK_RISK_PERCENT_PARAM];
  const set =
    (cap !== undefined && cap !== NO_PLAYBOOK_CONTRACT_CAP) ||
    (share !== undefined && share !== FULL_RISK_PERCENT);
  return set ? FIXED_SIZING_IGNORES_PLAYBOOK_LIMITS : null;
}

export type ResolvedSizing = { ok: true; sizing: BacktestSizing } | { ok: false; reason: string };

export function resolveSizing(draft: SizingDraft, includeFees: boolean): ResolvedSizing {
  if (draft.mode === "fixed") {
    if (!Number.isInteger(draft.contracts) || draft.contracts < 1) {
      return { ok: false, reason: SIZING_NEEDS_CONTRACTS };
    }
    return { ok: true, sizing: { mode: "fixed", contracts: draft.contracts } };
  }
  if (draft.riskUsd == null || !(draft.riskUsd > 0)) return { ok: false, reason: SIZING_NEEDS_RISK };
  if (!Number.isInteger(draft.maxContracts) || draft.maxContracts < 1) {
    return { ok: false, reason: SIZING_NEEDS_MAX_CONTRACTS };
  }
  if (!includeFees) return { ok: false, reason: RISK_SIZING_NEEDS_FEES };
  return {
    ok: true,
    sizing: { mode: "risk", maxRiskPerTradeUsd: draft.riskUsd, maxContracts: draft.maxContracts },
  };
}

// ── Settings the run cannot take ────────────────────────────────────────

/**
 * Why Run and Export are refused on these settings, or null. Every sentence is
 * one the run would otherwise meet later, verbatim: an off-calibration value
 * the hooks cannot take (the CLI's `--explore` refusal), settings the module
 * says take no entry (its `settingsRefusal`, which the CLI throws), an exit
 * filter only the engine can feed (`runBacktest`'s throw), and a time-of-day
 * window outside the playbook's session (the CLI's refusal). The form adds no
 * rule of its own. The day session is the instrument's the form runs on,
 * `calibratedFor`.
 */
export function settingsRefusal(
  playbookKey: string,
  module: Pick<StrategyModule, "params" | "settingsRefusal"> & {
    config: Pick<StrategyConfig, "session" | "calibratedFor">;
  },
  params: ParamValues,
): string | null {
  const instrument = module.config.calibratedFor;
  const daySession = instrument == null ? null : daySessionForTicker(instrument);
  return (
    offCalibrationRefusal(module.params, params) ??
    module.settingsRefusal?.(params as unknown as CommonParams, daySession) ??
    crossTimeframeExitRefusalFor(params as unknown as AllFilterParams) ??
    timeWindowOutsideSessionRefusal(playbookKey, module.config.session, params)
  );
}

// ── Loading a saved run ─────────────────────────────────────────────────

/** What a saved run's header puts into the form. A null field is one the
 *  header did not record; the form keeps the playbook's default for it. */
export interface LoadedRun {
  source: { runPath: string; label: string };
  params: ParamValues;
  sizing: SizingDraft | null;
  includeFees: boolean | null;
  from: string | null;
  to: string | null;
  /** Keys the header recorded and this playbook no longer declares. */
  dropped: string[];
  /** Header fields absent from this run, in the operator's words. */
  unrecorded: string[];
  /** The instrument the saved run traded, when it is not the one this form
   *  runs on; null when they match. */
  otherInstrument: { ran: string; runsOn: SpecTicker } | null;
}

/**
 * The form as a saved run's header describes it.
 *
 * **Starts from the module's defaults, not from the form's current values**,
 * so a key the header does not carry reads as the playbook's own rather than
 * as whatever was typed before the load. A key the module no longer declares
 * is dropped and named — applying it would put a value in the request that no
 * hook reads, and silently omitting it would let the operator believe the run
 * they are about to make is the one they loaded. `timeframe` comes from the
 * header's own field, which is what `--timeframe` wrote.
 *
 * **A run on another instrument still loads**, and says so: the form runs on
 * `instrument` whatever the header's `ticker` was, so a `--cross-instrument`
 * run's settings applied here are a variation, not a reproduction.
 */
export function loadFromRun(
  schema: Record<string, ParamSchema>,
  run: RunSummary,
  instrument: SpecTicker,
): LoadedRun {
  const params = defaultParamValues(schema);
  const dropped: string[] = [];
  const unrecorded: string[] = [];

  if (run.resolvedParams == null) {
    unrecorded.push("parameters");
  } else {
    for (const [key, value] of Object.entries(run.resolvedParams)) {
      if (key in schema) params[key] = value;
      else dropped.push(key);
    }
  }
  if (TIMEFRAME_PARAM in schema) params[TIMEFRAME_PARAM] = run.timeframe;

  let sizing: SizingDraft | null = null;
  if (run.sizing == null) unrecorded.push("sizing");
  else if (run.sizing.mode === "contracts") {
    sizing = { ...DEFAULT_SIZING_DRAFT, mode: "fixed", contracts: run.sizing.contracts };
  } else {
    sizing = {
      ...DEFAULT_SIZING_DRAFT,
      mode: "risk",
      riskUsd: run.sizing.riskUsd,
      maxContracts: run.sizing.maxContracts,
    };
  }

  if (run.feePerSide == null) unrecorded.push("fees");
  const hasDates = run.from.length > 0 && run.to.length > 0;
  if (!hasDates) unrecorded.push("dates");

  return {
    source: { runPath: run.runPath, label: run.label },
    params,
    sizing,
    includeFees: run.feePerSide == null ? null : run.feePerSide > 0,
    from: hasDates ? run.from : null,
    to: hasDates ? run.to : null,
    dropped,
    unrecorded,
    otherInstrument: run.ticker === instrument ? null : { ran: run.ticker, runsOn: instrument },
  };
}

/** The line under the picker after a load. */
export function describeLoaded(loaded: LoadedRun): string {
  const base = `Loaded from ${loaded.source.label}.`;
  if (loaded.unrecorded.length === 0) return base;
  return `${base} Its header records no ${loaded.unrecorded.join(", ")}, so ${
    loaded.unrecorded.length === 1 ? "that stays" : "those stay"
  } at the playbook's defaults.`;
}

/** The warning beside it when keys were left out, or null when none were. */
export function describeDropped(loaded: LoadedRun): string | null {
  if (loaded.dropped.length === 0) return null;
  return (
    `Left out, because this playbook no longer has ${
      loaded.dropped.length === 1 ? "this setting" : "these settings"
    }: ${loaded.dropped.join(", ")}.`
  );
}

/** The warning when the loaded run traded another instrument, or null. */
export function describeOtherInstrument(loaded: LoadedRun): string | null {
  if (loaded.otherInstrument == null) return null;
  const { ran, runsOn } = loaded.otherInstrument;
  return (
    `That run traded ${ran}, and this playbook runs here on ${runsOn}, ` +
    `so a run on these settings will not reproduce it.`
  );
}

// ── The result, as the run reader reads it ──────────────────────────────

/** Not a path: a fresh run has none. Unique so the chart's per-trade key
 *  cannot collide with a saved run's. */
export const BROWSER_RUN_PATH = "try-settings";
export const BROWSER_RUN_LABEL = "This run";

/**
 * An in-browser result as the run reader's `RunSummary`.
 *
 * The reader reads `ticker`, `timeframe`, `tickSize` and `calibratedFor` off
 * it; the rest is stated truthfully for a run nothing saved. `ticker` is the
 * bare root, as a header records it.
 */
export function browserRunSummary(
  response: BacktestResponse,
  playbook: { key: string; version: string | null; calibratedFor: SpecTicker | null },
  range: { from: string; to: string },
  sizing: BacktestSizing,
): RunSummary {
  return {
    runPath: BROWSER_RUN_PATH,
    label: BROWSER_RUN_LABEL,
    playbookKey: playbook.key,
    playbookVersion: playbook.version,
    ticker: response.ticker.replace(/^\//, ""),
    timeframe: response.timeframe,
    from: range.from,
    to: range.to,
    calibratedFor: playbook.calibratedFor,
    tickSize: response.contract.tickSize,
    kind: "run",
    modifiedMs: 0,
    tradeCount: response.tradeRecords.length,
    resolvedParams: response.result.params,
    sizing:
      sizing.mode === "fixed"
        ? { mode: "contracts", contracts: sizing.contracts }
        : { mode: "risk", riskUsd: sizing.maxRiskPerTradeUsd, maxContracts: sizing.maxContracts },
    feePerSide: response.includeFees ? response.feePerSideUsd : 0,
  };
}
