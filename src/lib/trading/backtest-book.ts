/**
 * Every leg one account runs, simulated together bar by bar.
 *
 * `runBacktest` answers for one playbook alone; a book is not the sum of its
 * single runs, because the engine makes four cross-leg decisions per entry
 * ([docs/proposals/book-backtest.md], "Cross-leg rules"):
 *
 * 1. one position per `(account, contract)` — the contract lock;
 * 2. the stale-signal latch on the leg the lock refused, cleared only by a
 *    plain `null` from `shouldEnter`;
 * 3. the account's daily P&L gate, over every leg's closed trades;
 * 4. the phase budget, moved by the whole book's closes.
 *
 * Each cell is a `createCellStepper`, so its own signal, exit and sizing path
 * is `runBacktest`'s. This file holds only the account between them. The lock
 * and the latch are the engine's (`acquireContractLock` /
 * `hasOpenPositionOnContract` / `signalSuppressed`), which are private to
 * `TradingEngine` and so are restated here at their claim, release and clear
 * points; the gate and the budget call the engine's own evaluators.
 *
 * **Each bar-close instant is two passes.** Pass A runs every cell's resting
 * bracket: an intrabar fill happened before the close, so it frees its slot
 * and enters the daily tally before anyone evaluates. Pass B runs each cell's
 * close, the filled ones included, in timeframe batch order, then
 * `created_at` order — the engine's evaluation order. A market exit in pass B (a `shouldExit`, the session
 * flatten) holds its slot, and its P&L stays out of the tally, until the end
 * of its batch: live, the lock frees only when the close is reconciled.
 *
 * **The three refusals above come out as `blocked` rows and `blockedCounts`,
 * never as skips.** Since A108 (2026-10-16) the engine writes a
 * `skipped_signals` row for each of them, under the same gate id
 * (`AccountGateRefusal`); parity does not yet match a live row against a book
 * block where neither side entered.
 */
import type { BarData } from "@/lib/brokers/types";
import {
  createCellStepper,
  type AccountGateRefusal,
  type BacktestTrade,
  type CellStepper,
} from "./backtest";
import { buildTradeRecord, type CliTradeRecord } from "./backtest-trade-record";
import { contractSpecForTicker } from "./contracts/contract-specs";
import { evaluateDailyPnlGate, hasDailyPnlLimits, type DailyPnlLimits } from "./daily-pnl-gate";
import { resolveSessionBudget, type SessionBudgetRow } from "./orders/account-phase-sizer";
import { feePerSideFor } from "./orders/fees";
import { toCents } from "./orders/pnl-math";
import { sessionDateOf } from "./regime/session-dates";
import { currentCmeSessionStart } from "./session/session";
import {
  riskBudgetSkip,
  sizeResolutionSkip,
  strategySkip,
  type SkippedSignal,
} from "./skipped-signal";
import { resolveTimeframe, type ParamValues, type StrategyModule } from "./strategy-types";

// ── Inputs ──────────────────────────────────────────────────────────

/** One deployment on the account, as the engine would evaluate it. */
export interface BookCellInput {
  deploymentId: string;
  strategyKey: string;
  /** As the database spells it, `/MNQ`. */
  ticker: string;
  /** Decides evaluation order on a shared instant; see `runBookBacktest`. */
  createdAt: string;
  /** No entry on a bar that closes before this instant: the deployment did
   *  not exist yet, so live evaluated nothing for it. Parity sets it to
   *  `createdAt`; a `book` run over past sessions leaves it unset. Refused
   *  silently — no skip, no block, no latch — since live has no row for it. */
  entriesFrom?: string;
  /** The parent group's saved params — the same blob the tick merges over
   *  the schema defaults. */
  paramValues: ParamValues;
}

export interface BookAccountInput {
  accountId: number;
  dailyPnl: DailyPnlLimits;
  /** The account's posture columns, or null when it has no `account_brokers`
   *  row — then every entry is a `size_resolution` skip, as it is live. */
  posture: Omit<SessionBudgetRow, "eodBalanceUsd" | "eodPeakUsd" | "eodSizesSessionStart"> | null;
  /** The close and peak the first simulated session is sized from; later
   *  sessions advance it by the book's simulated net P&L. Null leaves every
   *  session on the phase's stale-sample floor. */
  phaseSeed: { closeUsd: number; peakUsd: number } | null;
}

/** Evaluate `deploymentId` first at the bar close `atMs` — one same-bar
 *  contest decided the other way. */
export interface BookPromotion {
  atMs: number;
  deploymentId: string;
}

export interface RunBookBacktestOptions {
  cells: readonly BookCellInput[];
  /** The registry, as the caller loads it — the app's and the CLI's loaders
   *  differ. */
  resolveStrategy: (key: string) => StrategyModule | undefined;
  /** Keyed by `bookBarKey(ticker, timeframe)`; see `planBookBars`. */
  bars: ReadonlyMap<string, BarData[]>;
  /** The 1m bars each series was aggregated from, on the same keys; see
   *  `runBacktest`'s `subBars`. A series with none takes its fallback. */
  subBars?: ReadonlyMap<string, BarData[]>;
  account: BookAccountInput;
  /** Rows whose signal bar precedes this are warmup: simulated, so the state
   *  they leave carries forward, and not reported. */
  reportFrom?: Date;
  promote?: readonly BookPromotion[];
  /** As `runBacktest`'s, per bar-close instant rather than per bar. */
  onProgress?: (processed: number, total: number) => void | Promise<void>;
}

// ── Outputs ─────────────────────────────────────────────────────────

/**
 * What sized one book entry, under the engine's `paramSnapshot` key names so
 * one reader takes both: the account's budget and ceiling for the session,
 * one contract's loss, and the playbook's applied cap (`null` for none),
 * share and scaled budget.
 */
export interface BookTradeSizing {
  maxRiskPerTradeUsd: number;
  maxContracts: number;
  riskPerContractUsd: number;
  appliedPlaybookMaxContracts: number | null;
  appliedPlaybookRiskPercent: number;
  playbookBudgetUsd: number;
}

/** A `trades.jsonl` row, plus the cell it belongs to and what sized it. */
export type BookTradeRecord = CliTradeRecord & {
  deploymentId: string;
  strategyKey: string;
  ticker: string;
  sizing: BookTradeSizing;
  /** Another cell on the contract signalled on this entry's bar and lost
   *  only to evaluation order. */
  contested: boolean;
  /** Entered inside a longer bar whose bracket fill then tripped the daily
   *  gate, where live's fill may have landed first and refused it; or an
   *  entry, by any cell, on a contract a bracket fill freed in that bar too
   *  late for live to be sure of having reconciled it by the close (A102). */
  releaseSensitive: boolean;
  /** Closed by the run running out of bars, not by any exit live would take;
   *  a parity join skips it. */
  endOfData: boolean;
};

/** A `skips.jsonl` row: only what the engine persists to `skipped_signals`. */
export type BookSkipRecord = SkippedSignal & { deploymentId: string };

/** A `blocked.jsonl` row: a cross-leg refusal live writes nowhere. */
export interface BookBlockedRecord {
  deploymentId: string;
  strategyKey: string;
  ticker: string;
  signalBarTs: string;
  sessionDate: string;
  gate: AccountGateRefusal;
  /** The cell holding the contract — for a stale latch, the one whose hold
   *  set it. Null for the daily gate. */
  holderDeploymentId: string | null;
  /** Lost to evaluation order on a bar where the holder also signalled. A
   *  latch inherits the flag of the block that set it. */
  contested: boolean;
  /** The other release timing would have lifted it: the holder was exiting
   *  by market order in this batch, or its bracket filled inside a longer bar
   *  this close falls in. A latch inherits it too. */
  releaseSensitive: boolean;
}

export interface BookContest {
  atMs: number;
  contract: string;
  winnerDeploymentId: string;
  loserDeploymentIds: string[];
}

export interface BookBacktestResult {
  /** `params` is the cell's resolved settings — the module's defaults under
   *  the deployment's own — so a run says which playbook sizing each cell ran. */
  cells: Array<{
    deploymentId: string;
    strategyKey: string;
    ticker: string;
    timeframe: string;
    createdAt: string;
    params: ParamValues;
  }>;
  trades: BookTradeRecord[];
  skips: BookSkipRecord[];
  blocked: BookBlockedRecord[];
  blockedCounts: Record<string, Record<AccountGateRefusal, number>>;
  contests: BookContest[];
  warnings: string[];
}

// ── Bar plan ────────────────────────────────────────────────────────

export function bookBarKey(ticker: string, timeframe: string): string {
  return `${ticker}|${timeframe}`;
}

/** The series the caller must load, one per `(ticker, timeframe)`, with the
 *  cells that read each so it can size the warmup per module. */
export function planBookBars(
  cells: readonly BookCellInput[],
  resolveStrategy: (key: string) => StrategyModule | undefined,
): Array<{ key: string; ticker: string; timeframe: string; deploymentIds: string[] }> {
  const plan = new Map<string, { key: string; ticker: string; timeframe: string; deploymentIds: string[] }>();
  for (const cell of cells) {
    const timeframe = resolveTimeframe(strategyOf(cell, resolveStrategy).config, cell.paramValues);
    const key = bookBarKey(cell.ticker, timeframe);
    const entry = plan.get(key) ?? { key, ticker: cell.ticker, timeframe, deploymentIds: [] };
    entry.deploymentIds.push(cell.deploymentId);
    plan.set(key, entry);
  }
  return [...plan.values()];
}

// ── Runner ──────────────────────────────────────────────────────────

const PROGRESS_EVERY_INSTANTS = 500;
const CENTS_PER_DOLLAR = 100;
const REFUSALS: readonly AccountGateRefusal[] = ["contract_held", "stale_latch", "daily_pnl"];

interface CellState {
  input: BookCellInput;
  /** Position in `created_at` order. */
  order: number;
  /** Timeframe batch on this contract: the engine feeds each contract's
   *  aggregators in the order their timeframes were first subscribed, which
   *  is `created_at` order. */
  batch: number;
  timeframe: string;
  /** `CONTRACT_SPECS`' root, so `/MNQ` and `MNQ` hold one lock. */
  contract: string;
  tickSize: number;
  bars: BarData[];
  /** The block that set the stale latch, or null when it is clear. */
  latch: Block | null;
  /** Blocks recorded against this cell's current hold. */
  heldAgainst: Block[];
  entryAtMs: number | null;
  entryBarIndex: number | null;
  skips: SkippedSignal[];
  /** What the sizer applied to each entry, by entry bar index. */
  sizing: Map<number, BookTradeSizing>;
}

interface Block {
  cell: CellState;
  signalBarTs: string;
  atMs: number;
  gate: AccountGateRefusal;
  holder: CellState | null;
  origin: Block | null;
  contested: boolean;
  releaseSensitive: boolean;
}

interface Cell {
  state: CellState;
  stepper: CellStepper;
}

/**
 * Same-instant order is timeframe batch first, then `created_at` ASC. That
 * is the engine's order after a server sync; after a board-driven update it
 * is the board's body order instead, which the snapshot does not record —
 * hence the `contested` flag rather than a claim about who won.
 */
export async function runBookBacktest(opts: RunBookBacktestOptions): Promise<BookBacktestResult> {
  const { account, reportFrom, promote = [], onProgress } = opts;
  const reportFromMs = reportFrom?.getTime() ?? -Infinity;

  const ordered = [...opts.cells].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
  /** Per contract, as the engine batches: timeframe → batch number. */
  const batchOf = new Map<string, Map<string, number>>();
  const warnings: string[] = [];

  // ── Account state ──
  const locks = new Map<string, CellState>();
  let pendingRelease: Array<{ state: CellState; trade: BacktestTrade }> = [];
  const grossCentsBySession = new Map<string, number>();
  let sample: { closeCents: number; peakCents: number; session: string } | null = null;
  let netCentsSinceSample = 0;
  let currentAt = -Infinity;
  const contestedEntries = new Set<string>();
  const sensitiveEntries = new Set<string>();
  /** Every entry, in instant order, for the gate's retroactive flag. */
  const entries: Array<{ key: string; atMs: number }> = [];
  const contests = new Map<string, BookContest>();
  const blocks: Block[] = [];

  const phaseRow = (): SessionBudgetRow | null =>
    account.posture == null
      ? null
      : {
          ...account.posture,
          eodBalanceUsd: sample == null ? null : sample.closeCents / CENTS_PER_DOLLAR,
          eodPeakUsd: sample == null ? null : sample.peakCents / CENTS_PER_DOLLAR,
          eodSizesSessionStart: sample?.session ?? null,
        };

  // `session` is the one the close is filled in — the engine's counter reads
  // the fill time against `currentCmeSessionStart(now)`.
  const absorb = (trade: BacktestTrade, session: string): void => {
    grossCentsBySession.set(
      session,
      (grossCentsBySession.get(session) ?? 0) + toCents(trade.grossPnlDollars),
    );
    netCentsSinceSample += toCents(trade.pnlDollars);
  };

  const dailyGateTripped = (session: string): boolean =>
    hasDailyPnlLimits(account.dailyPnl) &&
    evaluateDailyPnlGate({
      ...account.dailyPnl,
      realizedGross: (grossCentsBySession.get(session) ?? 0) / CENTS_PER_DOLLAR,
      unrealized: 0,
    }).tripped;

  const release = (state: CellState): void => {
    if (locks.get(state.contract) === state) locks.delete(state.contract);
    state.heldAgainst = [];
    state.entryAtMs = null;
    state.entryBarIndex = null;
  };

  const block = (
    state: CellState,
    bar: BarData,
    gate: AccountGateRefusal,
    holder: CellState | null,
    origin: Block | null,
  ): Block => {
    const row: Block = {
      cell: state,
      signalBarTs: bar.timestamp,
      atMs: currentAt,
      gate,
      holder,
      origin,
      contested: false,
      releaseSensitive: false,
    };
    blocks.push(row);
    return row;
  };

  // The engine's order — held, then latched, then the daily gate — and it
  // matters: a leg the lock refuses is latched even on a bar the gate would
  // also have refused.
  const decide = (state: CellState, i: number): AccountGateRefusal | null => {
    const bar = state.bars[i];
    const holder = locks.get(state.contract);
    if (holder != null) {
      const row = block(state, bar, "contract_held", holder, null);
      // A latched loser was refused whoever went first, so order decided
      // nothing.
      if (holder.entryAtMs === currentAt && holder.entryBarIndex != null && state.latch == null) {
        row.contested = true;
        contestedEntries.add(entryKey(holder.input.deploymentId, holder.entryBarIndex));
        noteContest(contests, currentAt, state.contract, holder, state);
      }
      if (pendingRelease.some((p) => p.state === holder)) row.releaseSensitive = true;
      holder.heldAgainst.push(row);
      state.latch = row;
      return "contract_held";
    }
    if (state.latch != null) {
      block(state, bar, "stale_latch", state.latch.holder, state.latch);
      return "stale_latch";
    }
    if (dailyGateTripped(currentCmeSessionStart(new Date(currentAt)))) {
      block(state, bar, "daily_pnl", null, null);
      return "daily_pnl";
    }
    return null;
  };

  // ── Cells ──
  const cells: Cell[] = [];
  for (const [order, input] of ordered.entries()) {
    const strategy = strategyOf(input, opts.resolveStrategy);
    const spec = contractSpecForTicker(input.ticker);
    if (spec == null) {
      throw new Error(
        `Deployment ${input.deploymentId} trades ${input.ticker}, which has no contract spec, so its ticks cannot be priced.`,
      );
    }
    const timeframe = resolveTimeframe(strategy.config, input.paramValues);
    const key = bookBarKey(input.ticker, timeframe);
    const bars = opts.bars.get(key);
    if (bars == null) {
      throw new Error(`No bars were supplied for ${key}, which deployment ${input.deploymentId} reads.`);
    }
    if (bars.length === 0) {
      warnings.push(`${input.deploymentId}: no bars for ${key}; the cell took no part in the book.`);
      continue;
    }
    const batches = batchOf.get(spec.ticker) ?? new Map<string, number>();
    if (!batches.has(timeframe)) batches.set(timeframe, batches.size);
    batchOf.set(spec.ticker, batches);
    const state: CellState = {
      input,
      order,
      batch: batches.get(timeframe) ?? 0,
      timeframe,
      contract: spec.ticker,
      tickSize: spec.tickSize,
      bars,
      latch: null,
      heldAgainst: [],
      entryAtMs: null,
      entryBarIndex: null,
      skips: [],
      sizing: new Map(),
    };
    const entriesFromMs = input.entriesFrom == null ? -Infinity : Date.parse(input.entriesFrom);
    const stepper = createCellStepper({
      strategy,
      bars,
      subBars: opts.subBars?.get(key),
      paramOverrides: input.paramValues,
      tickSize: spec.tickSize,
      tickValue: spec.tickValue,
      daySession: spec.daySession,
      feePerSideUsd: feePerSideFor(input.ticker),
      onEntrySkip: (skip, bar) => state.skips.push(strategySkip(skip, bar)),
      onRiskBudgetSkip: (bar, numbers) => state.skips.push(riskBudgetSkip(bar, numbers)),
      onSizeResolutionSkip: (bar, args) => state.skips.push(sizeResolutionSkip(bar, args)),
      postureFor: () => resolveSessionBudget(phaseRow(), new Date(currentAt)).posture,
      onEntrySized: (entryBarIndex, sized) =>
        state.sizing.set(entryBarIndex, {
          maxRiskPerTradeUsd: sized.posture.maxRiskPerTradeUsd,
          maxContracts: sized.posture.maxContracts,
          riskPerContractUsd: sized.riskPerContractUsd,
          appliedPlaybookMaxContracts: sized.playbook.maxContracts,
          appliedPlaybookRiskPercent: sized.playbook.riskPercent,
          playbookBudgetUsd: sized.budgetUsd,
        }),
      accountGate: {
        onNoSignal: () => {
          state.latch = null;
        },
        check: (i) => (currentAt < entriesFromMs ? "not_deployed" : decide(state, i)),
      },
    });
    cells.push({ state, stepper });
  }

  // ── Schedule: every bar close, grouped by instant ──
  const byInstant = new Map<number, Array<{ cell: Cell; i: number }>>();
  for (const cell of cells) {
    const { bars } = cell.state;
    for (let i = 0; i < bars.length; i++) {
      const at = Date.parse(bars[i].timestamp) + cell.stepper.barLengthMs;
      const list = byInstant.get(at);
      if (list) list.push({ cell, i });
      else byInstant.set(at, [{ cell, i }]);
    }
  }
  const instants = [...byInstant.keys()].sort((a, b) => a - b);
  const promoted = new Set(promote.map((p) => `${p.atMs}|${p.deploymentId}`));

  for (const [k, at] of instants.entries()) {
    if (k % PROGRESS_EVERY_INSTANTS === 0 && k > 0) {
      await onProgress?.(k, instants.length);
      await new Promise<void>((r) => setImmediate(r));
    }
    currentAt = at;
    const session = currentCmeSessionStart(new Date(at));
    // A bracket fill lands inside the bar, so in the session just before the
    // close — which differs from `session` only when the close opens one.
    const fillSession = currentCmeSessionStart(new Date(at - 1));
    const events = byInstant.get(at) ?? [];

    // Pass A — resting brackets, filled before the close. A cell whose bracket
    // filled is flat at the close and joins pass B (A102); one the session
    // flatten closed is out of session there and does not.
    const flattenedInA = new Set<CellState>();
    const freedAtClose = new Set<string>();
    for (const { cell, i } of events) {
      if (!cell.stepper.hasPosition()) continue;
      const outcome = cell.stepper.bracketPhase(i);
      if (outcome === "none") continue;
      if (outcome === "flattened") flattenedInA.add(cell.state);
      if (outcome === "filled_at_close") freedAtClose.add(cell.state.contract);
      absorb(lastTrade(cell.stepper), fillSession);
      // A longer bar's fill happened somewhere inside it; a shorter-timeframe
      // close in that span could have entered live — into the slot, or past
      // the daily gate this fill trips.
      const barOpenMs = Date.parse(cell.state.bars[i].timestamp);
      for (const row of cell.state.heldAgainst) {
        if (row.atMs > barOpenMs) row.releaseSensitive = true;
      }
      if (dailyGateTripped(fillSession)) {
        for (let k = entries.length - 1; k >= 0 && entries[k].atMs > barOpenMs; k--) {
          sensitiveEntries.add(entries[k].key);
        }
      }
      release(cell.state);
    }

    // The phase rolls after pass A, so a fill inside the session's last bar
    // closes that session. Seeded at the first reported instant: the seed is
    // the live close before the first reported session, and warmup P&L moving
    // it would size that session from a balance live never had.
    if (sample == null) {
      if (account.phaseSeed != null && at >= reportFromMs) {
        sample = {
          closeCents: toCents(account.phaseSeed.closeUsd),
          peakCents: toCents(account.phaseSeed.peakUsd),
          session,
        };
        netCentsSinceSample = 0;
      }
    } else if (sample.session !== session) {
      const closeCents: number = sample.closeCents + netCentsSinceSample;
      sample = { closeCents, peakCents: Math.max(sample.peakCents, closeCents), session };
      netCentsSinceSample = 0;
    }

    // Pass B — the close, batch by batch.
    const rank = (e: { cell: Cell }): [number, number] =>
      promoted.has(`${at}|${e.cell.state.input.deploymentId}`)
        ? [-1, -1]
        : [e.cell.state.batch, e.cell.state.order];
    const passB = events
      .filter((e) => !flattenedInA.has(e.cell.state))
      .sort((a, b) => {
        const [ab, ao] = rank(a);
        const [bb, bo] = rank(b);
        return ab - bb || ao - bo;
      });
    for (let start = 0; start < passB.length; ) {
      const batch = rank(passB[start])[0];
      let end = start;
      for (; end < passB.length && rank(passB[end])[0] === batch; end++) {
        const { cell, i } = passB[end];
        const had = cell.stepper.hasPosition();
        cell.stepper.barPhase(i);
        const has = cell.stepper.hasPosition();
        if (!had && has) {
          locks.set(cell.state.contract, cell.state);
          cell.state.entryAtMs = at;
          cell.state.entryBarIndex = i;
          entries.push({ key: entryKey(cell.state.input.deploymentId, i), atMs: at });
          // Live may not have reconciled a fill this late by the close, and
          // would still hold that contract there — against any cell.
          if (freedAtClose.has(cell.state.contract)) sensitiveEntries.add(entryKey(cell.state.input.deploymentId, i));
        } else if (had && !has) {
          pendingRelease.push({ state: cell.state, trade: lastTrade(cell.stepper) });
        }
      }
      for (const { state, trade } of pendingRelease) {
        absorb(trade, session);
        release(state);
      }
      pendingRelease = [];
      start = end;
    }
  }

  return buildResult(cells, blocks, contests, contestedEntries, sensitiveEntries, reportFromMs, warnings);
}

/**
 * The base run, and one rerun per contested loser with that loser evaluated
 * first at its bar — the bound on what evaluation order alone can move, for
 * the monthly review.
 */
export async function runBookBacktestPermuted(
  opts: RunBookBacktestOptions,
): Promise<{ base: BookBacktestResult; variants: Array<{ promoted: BookPromotion; result: BookBacktestResult }> }> {
  const base = await runBookBacktest(opts);
  const variants: Array<{ promoted: BookPromotion; result: BookBacktestResult }> = [];
  for (const contest of base.contests) {
    for (const loser of contest.loserDeploymentIds) {
      const promoted = { atMs: contest.atMs, deploymentId: loser };
      variants.push({
        promoted,
        result: await runBookBacktest({ ...opts, promote: [...(opts.promote ?? []), promoted] }),
      });
    }
  }
  return { base, variants };
}

// ── Helpers ─────────────────────────────────────────────────────────

function strategyOf(
  cell: BookCellInput,
  resolveStrategy: (key: string) => StrategyModule | undefined,
): StrategyModule {
  const strategy = resolveStrategy(cell.strategyKey);
  if (strategy == null) {
    throw new Error(
      `Deployment ${cell.deploymentId} runs ${cell.strategyKey}, which this build does not register.`,
    );
  }
  return strategy;
}

function lastTrade(stepper: CellStepper): BacktestTrade {
  return stepper.trades[stepper.trades.length - 1];
}

function entryKey(deploymentId: string, entryBarIndex: number): string {
  return `${deploymentId}|${entryBarIndex}`;
}

function noteContest(
  contests: Map<string, BookContest>,
  atMs: number,
  contract: string,
  winner: CellState,
  loser: CellState,
): void {
  const key = `${atMs}|${contract}`;
  const contest = contests.get(key) ?? {
    atMs,
    contract,
    winnerDeploymentId: winner.input.deploymentId,
    loserDeploymentIds: [],
  };
  if (!contest.loserDeploymentIds.includes(loser.input.deploymentId)) {
    contest.loserDeploymentIds.push(loser.input.deploymentId);
  }
  contests.set(key, contest);
}

function buildResult(
  cells: Cell[],
  blocks: Block[],
  contests: Map<string, BookContest>,
  contestedEntries: Set<string>,
  sensitiveEntries: Set<string>,
  reportFromMs: number,
  warnings: string[],
): BookBacktestResult {
  const inReport = (ts: string): boolean => Date.parse(ts) >= reportFromMs;
  const finished = cells.map((cell) => {
    const result = cell.stepper.finish();
    for (const w of result.warnings ?? []) warnings.push(`${cell.state.input.deploymentId}: ${w}`);
    return { cell, trades: result.trades, params: result.params };
  });
  const sizingOf = (state: CellState, entryBarIndex: number): BookTradeSizing => {
    const sizing = state.sizing.get(entryBarIndex);
    // Every book entry goes through the sizer (`postureFor` is always set).
    if (sizing == null) {
      throw new Error(`${state.input.deploymentId}: the entry on bar ${entryBarIndex} has no sizer record.`);
    }
    return sizing;
  };

  const kept = finished
    .flatMap(({ cell, trades }) => trades.filter((t) => inReport(t.signalBarTs)).map((trade) => ({ cell, trade })))
    .sort(
      (a, b) =>
        Date.parse(a.trade.signalBarTs) - Date.parse(b.trade.signalBarTs) ||
        a.cell.state.order - b.cell.state.order,
    );
  const trades: BookTradeRecord[] = kept.map(({ cell, trade }, k) => ({
    ...buildTradeRecord({
      trade,
      bars: cell.state.bars,
      tickSize: cell.state.tickSize,
      tradeId: k + 1,
      foldId: null,
      sample: null,
      regime: null,
    }),
    deploymentId: cell.state.input.deploymentId,
    strategyKey: cell.state.input.strategyKey,
    ticker: cell.state.input.ticker,
    sizing: sizingOf(cell.state, trade.entryBarIndex),
    contested: contestedEntries.has(entryKey(cell.state.input.deploymentId, trade.entryBarIndex)),
    releaseSensitive: sensitiveEntries.has(entryKey(cell.state.input.deploymentId, trade.entryBarIndex)),
    endOfData: trade.exitReason === "end_of_data",
  }));

  const skips: BookSkipRecord[] = cells
    .flatMap(({ state }) =>
      state.skips
        .filter((s) => inReport(s.signalBarTs))
        .map((s) => ({ order: state.order, row: { ...s, deploymentId: state.input.deploymentId } })),
    )
    .sort((a, b) => Date.parse(a.row.signalBarTs) - Date.parse(b.row.signalBarTs) || a.order - b.order)
    .map((s) => s.row);

  const blockedCounts: Record<string, Record<AccountGateRefusal, number>> = {};
  for (const { state } of cells) {
    blockedCounts[state.input.deploymentId] = Object.fromEntries(REFUSALS.map((g) => [g, 0])) as Record<
      AccountGateRefusal,
      number
    >;
  }
  const blocked: BookBlockedRecord[] = [];
  for (const row of blocks) {
    if (!inReport(row.signalBarTs)) continue;
    const flags = row.origin ?? row;
    blockedCounts[row.cell.input.deploymentId][row.gate]++;
    blocked.push({
      deploymentId: row.cell.input.deploymentId,
      strategyKey: row.cell.input.strategyKey,
      ticker: row.cell.input.ticker,
      signalBarTs: row.signalBarTs,
      sessionDate: sessionDateOf(new Date(row.signalBarTs)),
      gate: row.gate,
      holderDeploymentId: row.holder?.input.deploymentId ?? null,
      contested: flags.contested,
      releaseSensitive: flags.releaseSensitive,
    });
  }

  return {
    cells: finished.map(({ cell: { state }, params }) => ({
      deploymentId: state.input.deploymentId,
      strategyKey: state.input.strategyKey,
      ticker: state.input.ticker,
      timeframe: state.timeframe,
      createdAt: state.input.createdAt,
      params,
    })),
    trades,
    skips,
    blocked,
    blockedCounts,
    contests: [...contests.values()].filter((c) => c.atMs >= reportFromMs),
    warnings,
  };
}
