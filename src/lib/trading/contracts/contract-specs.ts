/**
 * Static per-instrument contract facts, for callers with no broker.
 *
 * The engine reads tick size and tick value off a resolved `Contract` from
 * whichever broker executes the deployment. Nothing else can: the backtest
 * CLI runs off the Parquet cache with no client, no account and no contract
 * search, and a table is the only honest source for it. This table is
 * therefore deliberately small — the instruments with a shelf, plus research
 * rows — and grows one row at a time beside a cache backfill.
 */
import { FEE_PER_SIDE_USD } from "@/lib/trading/orders/fees";

export type SpecTicker = "MNQ" | "MES" | "MGC" | "MYM";

export const SPEC_TICKERS: readonly SpecTicker[] = ["MNQ", "MES", "MGC", "MYM"];

/**
 * The rows a deployment may be offered on — every surface that tells the
 * operator where to deploy or seeds a book shelf reads this, never
 * `SPEC_TICKERS`. A row joins here only once the live path is checked for it:
 * `MYM` was research-only from 2026-10-16 and deployable from 2026-10-21.
 */
export const DEPLOYABLE_SPEC_TICKERS: readonly SpecTicker[] = ["MNQ", "MES", "MGC", "MYM"];

/** ET wall-clock `HH:MM` bounds of the instrument's day session. Readonly
 *  because the row is handed by reference to every strategy context, every
 *  indicator pass and the parsed-minutes cache keyed on it. */
export interface DaySessionWindow {
  readonly start: string;
  readonly end: string;
}

export interface ContractSpec {
  ticker: SpecTicker;
  tickSize: number;
  /** Dollars per tick per contract. */
  tickValue: number;
  /** Databento continuous symbol under `{BAR_CACHE_DIR}/ohlcv-1m/`. Mirrors
   *  `TICKER_TO_CACHE_SYMBOL`; `contract-specs.test.ts` pins the agreement. */
  cacheSymbol: string;
  feePerSide: number;
  daySession: DaySessionWindow;
}

/**
 * `MGC`'s window is provisional — the former COMEX pit hours ending at the
 * 13:30 ET settlement. It is an open operator decision and nothing on the
 * MNQ shelf depends on it; see the regime-playbooks proposal.
 */
export const CONTRACT_SPECS: Readonly<Record<SpecTicker, ContractSpec>> = {
  MNQ: {
    ticker: "MNQ",
    tickSize: 0.25,
    tickValue: 0.5,
    cacheSymbol: "MNQ.v.0",
    feePerSide: FEE_PER_SIDE_USD["/MNQ"],
    daySession: { start: "09:30", end: "16:00" },
  },
  MES: {
    ticker: "MES",
    tickSize: 0.25,
    tickValue: 1.25,
    cacheSymbol: "MES.v.0",
    feePerSide: FEE_PER_SIDE_USD["/MES"],
    daySession: { start: "09:30", end: "16:00" },
  },
  MGC: {
    ticker: "MGC",
    tickSize: 0.1,
    tickValue: 1.0,
    cacheSymbol: "MGC.v.0",
    feePerSide: FEE_PER_SIDE_USD["/MGC"],
    daySession: { start: "08:20", end: "13:30" },
  },
  MYM: {
    ticker: "MYM",
    tickSize: 1.0,
    tickValue: 0.5,
    cacheSymbol: "MYM.v.0",
    feePerSide: FEE_PER_SIDE_USD["/MYM"],
    daySession: { start: "09:30", end: "16:00" },
  },
};

export function isSpecTicker(value: string): value is SpecTicker {
  return (SPEC_TICKERS as readonly string[]).includes(value);
}

/**
 * The day-session window for a deployment's ticker, or null when the table
 * has no row for it.
 *
 * Accepts the app's `/MNQ` spelling as well as the CLI's bare `MNQ`, because
 * the engine names an instrument one way and the backtest the other. Null is
 * an answer, not a failure: only a caller that actually needs the window —
 * a session VWAP, a day-session range — refuses to produce a number, through
 * `requireDaySession`.
 */
export function daySessionForTicker(ticker: string): DaySessionWindow | null {
  return contractSpecForTicker(ticker)?.daySession ?? null;
}

/**
 * The whole spec row for a ticker, on the same `/MNQ`-or-`MNQ` spelling rule
 * as `daySessionForTicker`, or null when the table has no row.
 *
 * The nightly regime job needs the tick size beside the window — the
 * classifier's features are tick integers — and a caller that took one from
 * this table and the other from somewhere else would be measuring one
 * instrument with another's scale.
 */
export function contractSpecForTicker(ticker: string): ContractSpec | null {
  const root = ticker.startsWith("/") ? ticker.slice(1) : ticker;
  return isSpecTicker(root) ? CONTRACT_SPECS[root] : null;
}
