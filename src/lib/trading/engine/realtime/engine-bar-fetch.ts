// Bar fetching for the engine. Every `retrieveBars` call funnels through
// `marketDataRegistry.realtime()` — swapping the market data provider is a
// config change at the registry level; nothing in this file needs to know
// about the underlying provider.
//
// NEVER `historical()` here, including the warmup fetch. Live trading reads
// live data: the historical slot may be a cache-backed provider that is
// permanently about one session behind, and splitting one fetch across two
// vendors would reintroduce stitching on the one path where it can lose
// money. One call, one source, and that source is live.

import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import type { BarData, BarUnit, Contract } from "@/lib/brokers/types";
import type { IndicatorConfig, Timeframe } from "@/lib/trading/domain";
import { getStrategy } from "../../strategies";
import { defaultParamValues, migrateLegacyParamOverrides, resolveTimeframe } from "../../strategy-types";
import type { CommonParams, ParamValues } from "../../strategy-types";
import { computeWarmupBars } from "../../replay/replay-bars";
import { getDeployment } from "@/lib/db/deployments";
import {
  abandonSnapshotQueue,
  getTradeById,
  incrementSnapshotRetry,
  listDueSnapshots,
  saveTradeBars,
} from "@/lib/db/trades";
import { ENGINE_SCOPE, type LogCategory } from "@/lib/logging/vocabulary";
import type { LogSubject } from "../engine";

const TIMEFRAME_TO_BAR: Record<Timeframe, { unit: BarUnit; unitNumber: number }> = {
  "1m": { unit: 2, unitNumber: 1 },
  "3m": { unit: 2, unitNumber: 3 },
  "5m": { unit: 2, unitNumber: 5 },
  "15m": { unit: 2, unitNumber: 15 },
  "30m": { unit: 2, unitNumber: 30 },
  "1h": { unit: 3, unitNumber: 1 },
  "4h": { unit: 3, unitNumber: 4 },
  "1d": { unit: 4, unitNumber: 1 },
};

// Globex runs 23 hours a day, five days a week, so N completed day sessions are
// N *trading* days back and the fetch window is a calendar span. The conversion
// is deliberately crude in the safe direction: a window one day too wide costs
// bars the strategy ignores, one day too narrow costs the whole quantity.
const TRADING_DAYS_PER_WEEK = 5;
const CALENDAR_DAYS_PER_WEEK = 7;
// The window is a rolling calendar span, and two things eat the sessions the
// 7/5 conversion buys. Alignment: any 21-day span holds exactly 15 weekdays
// whatever day it opens on, but the slack days are not a whole week — four of
// them add only two weekdays when the span opens on a Saturday, the alignment
// every Monday evaluation lands on. Holidays: CME closes roughly nine full
// sessions a year and two can fall inside three weeks (Christmas and New
// Year's Day are seven days apart). At four days, ORB v2's fifteen-session
// declaration came out at 17 weekdays − 2 holidays = 15, one of which is the
// current incomplete session — exactly fourteen completed prior sessions for a
// walk that needs fourteen, the oldest of them truncated by wherever the span
// opens intraday. Zero margin on a quantity whose shortfall is silent. A whole
// extra week covers both effects; an over-wide window costs only bars nobody
// reads.
const HOLIDAY_SLACK_DAYS = 7;

// The deepest single request this repo makes in production is
// `TopstepBarSource`'s `CHUNK_BARS`, and no vendor per-request cap is
// documented — so that number is the ceiling the engine holds itself to rather
// than a limit anyone published. Past it the answer is paging or a cache, both
// of which would put a stitched series on the live path, so a declaration that
// deep is refused at activation and this is the backstop for anything that
// reaches a tick anyway.
export const MAX_FETCH_DEPTH_BARS = 10_000;

const MS_PER_DAY = 86_400_000;

function unitToMs(unit: BarUnit): number {
  switch (unit) {
    case 1: return 1_000;
    case 2: return 60_000;
    case 3: return 3_600_000;
    case 4: return 86_400_000;
    case 5: return 604_800_000;
    case 6: return 2_592_000_000;
    default: return 60_000;
  }
}

/**
 * How many bars the live warmup fetch reads for one deployment: the greater of
 * what its indicators need and what its hooks declared in day sessions.
 *
 * The indicator half is `computeWarmupBars`, floored at 300 — that floor
 * replaces the flat 200 this fetch used to read for every strategy alike, and
 * is the number the replay and trade-snapshot windows already warm up over, so
 * the three paths now agree on the minimum.
 *
 * The session half is `warmupDaySessions`, converted here because the count is
 * a property of the strategy and the depth is a property of the timeframe.
 * Sessions are counted off the full Globex series — the day-session bars are
 * selected from it downstream — so the window is a calendar span wide enough to
 * hold that many trading days plus holiday slack, and the returned bar count is
 * that span at one bar per interval. It is a bound: weekends and the daily
 * halt mean the provider answers with fewer.
 *
 * **Throws past `MAX_FETCH_DEPTH_BARS`.** The timeframe is operator-selectable,
 * so the same declaration is five times deeper on 1m than on 5m; a depth that
 * would need paging is refused, not read.
 */
export function computeFetchDepth(args: FetchDepthArgs): number {
  const depth = rawFetchDepth(args);
  if (depth > MAX_FETCH_DEPTH_BARS) {
    throw new Error(describeFetchDepthCeiling(depth, args.timeframe));
  }
  return depth;
}

/**
 * The depth this declaration would read, when that is past the ceiling, and
 * null when it fits. Activation asks with this and refuses the deployment; the
 * throw in `computeFetchDepth` is the per-tick backstop for anything that got
 * into the loop without being classified.
 */
export function fetchDepthOverCeiling(args: FetchDepthArgs): number | null {
  const depth = rawFetchDepth(args);
  return depth > MAX_FETCH_DEPTH_BARS ? depth : null;
}

/**
 * The same depth, clamped instead of thrown, for the one path that must not
 * throw: a refused leg's exit block.
 *
 * A refused leg drops the session half, but its *indicator* half alone can be
 * past the ceiling — a saved period nothing else bounds — and `computeFetchDepth`
 * would then throw at the read, which is exactly the position the refusal exists
 * to move the exit block out of. The clamp is honest for that caller: the exit
 * filters read the tail of the window, and a leg that is refused takes no entry
 * off the truncated head.
 */
export function clampFetchDepth(args: FetchDepthArgs): number {
  return Math.min(rawFetchDepth(args), MAX_FETCH_DEPTH_BARS);
}

export function describeFetchDepthCeiling(depth: number, timeframe: Timeframe): string {
  return (
    `the warmup depth its strategy declares is ${depth.toLocaleString("en-US")} bars on ${timeframe}, ` +
    `past the ${MAX_FETCH_DEPTH_BARS.toLocaleString("en-US")}-bar ceiling one request reads`
  );
}

interface FetchDepthArgs {
  indicatorConfigs: IndicatorConfig[];
  warmupDaySessions: number;
  timeframe: Timeframe;
}

function rawFetchDepth(args: FetchDepthArgs): number {
  const indicatorDepth = computeWarmupBars(args.indicatorConfigs, null);
  if (args.warmupDaySessions <= 0) return indicatorDepth;

  // Same guard `snapshotTradeBars` takes: the timeframe is an operator-saved
  // string cast to `Timeframe`, so a row from before a schema change indexes
  // this table with a key it does not hold.
  const cfg = TIMEFRAME_TO_BAR[args.timeframe];
  if (!cfg) return indicatorDepth;

  const calendarDays =
    Math.ceil((args.warmupDaySessions * CALENDAR_DAYS_PER_WEEK) / TRADING_DAYS_PER_WEEK) +
    HOLIDAY_SLACK_DAYS;
  const sessionDepth = Math.ceil((calendarDays * MS_PER_DAY) / (cfg.unitNumber * unitToMs(cfg.unit)));
  return Math.max(indicatorDepth, sessionDepth);
}

/** The depth a caller that has no strategy in hand reads — the indicator floor
 *  alone. The exit filters' cross-timeframe read is the only such caller. */
const DEFAULT_FETCH_DEPTH = computeWarmupBars([], null);

/** Per-request 1s TTL, the same shape and the same reasoning as
 *  `TopstepClient`'s `OPEN_ORDERS_TTL_MS`. N legs on one contract and one
 *  timeframe evaluate on the same bar close, serially, and each asked for its
 *  own copy of the identical window — four ORB v2 legs on MNQ 5m meant four
 *  eight-thousand-bar REST reads inside one bar close for a series that cannot
 *  differ between them. The key is the exact request identity, so a different
 *  depth or a different contract is a different read; the window start moves
 *  by under a second across a hit, which is nothing at bar granularity. 1s is
 *  short enough that the next bar close always reads fresh. */
const FETCH_BARS_TTL_MS = 1_000;

interface InFlightRead {
  /**
   * `Infinity` until the promise settles — the clock starts when the answer
   * exists, exactly as `OPEN_ORDERS_TTL_MS` is stamped after its await.
   *
   * Stamped at issue instead, the entry could expire while its own request was
   * still in flight: the fan-out is serial and each leg runs `calculateAll`
   * between reads, so an eight-thousand-bar read plus one leg's indicator pass
   * is well past a second, the sweep dropped an unsettled entry, and the next
   * leg issued the identical request again — the duplicate read this cache
   * exists to stop, in the case it exists for.
   */
  expiresAt: number;
  bars: Promise<BarData[]>;
}

const barsInFlight = new Map<string, InFlightRead>();

/** Drop every entry, and the snapshot queue's deferrals. Called from `stop()`,
 *  because the reads that fill both stop with the tick loop, and from tests,
 *  which would otherwise each have to advance a fake clock past the TTL to
 *  escape the previous case's entry. A deferral lost to a restart costs one
 *  early re-ask, nothing more. */
export function resetBarFetchCache(): void {
  barsInFlight.clear();
  snapshotDeferredUntil.clear();
}

/**
 * `onRead` reports whether this caller's answer came from another caller's
 * request. The health funnel in `engine.ts` uses it to record one observation
 * per read rather than one per leg: a leg that reused an answer made no
 * observation of the seam and must not report one.
 */
export async function fetchBars(
  contract: Contract,
  timeframe: Timeframe,
  depthBars: number = DEFAULT_FETCH_DEPTH,
  onRead?: (info: { reused: boolean }) => void,
): Promise<BarData[]> {
  // The same guard the depth math takes, at the one place that would otherwise
  // read `unit` off `undefined`: `timeframe` is an operator-saved string cast
  // to `Timeframe`, so a row from before a schema change indexes this table
  // with a key it does not hold.
  const cfg = TIMEFRAME_TO_BAR[timeframe];
  if (!cfg) throw new Error(`no bar unit on file for timeframe "${timeframe}"`);
  const now = new Date();
  const startTime = new Date(
    now.getTime() - depthBars * cfg.unitNumber * unitToMs(cfg.unit),
  );

  const key = `${contract.id}|${cfg.unit}|${cfg.unitNumber}|${depthBars}`;
  for (const [k, entry] of barsInFlight) {
    if (entry.expiresAt <= now.getTime()) barsInFlight.delete(k);
  }

  let hit = barsInFlight.get(key);
  const reused = hit != null;
  if (!hit) {
    const bars = marketDataRegistry.realtime().retrieveBars({
      contractId: contract.id,
      live: false,
      startTime: startTime.toISOString(),
      endTime: now.toISOString(),
      unit: cfg.unit,
      unitNumber: cfg.unitNumber,
      limit: depthBars,
      includePartialBar: false,
    });
    // `Infinity` while unsettled: sharing an in-flight read is the point, and
    // the sweep above must not drop it mid-flight. That leaves nothing here to
    // evict a read that never settles — every later leg would join the hang.
    // Bounded today only because the realtime slot is Topstep and its client
    // aborts `/retrieveBars` at 15s (`client.ts`), so a sharer inherits the
    // maker's budget rather than starting its own. A provider without that
    // abort needs an issued-at bound in this sweep; it is on the proposal's
    // deferred list, not assumed.
    const entry: InFlightRead = { expiresAt: Infinity, bars };
    hit = entry;
    barsInFlight.set(key, entry);
    void bars.then(
      () => {
        entry.expiresAt = Date.now() + FETCH_BARS_TTL_MS;
      },
      // A failed read must not be served for the rest of the second: the retry
      // is the caller's, and the rejection still reaches every caller that
      // awaited this promise, so nothing goes unhandled. Identity-checked, or a
      // slow failure would evict the read that already replaced it.
      () => {
        if (barsInFlight.get(key) === entry) barsInFlight.delete(key);
      },
    );
  }

  onRead?.({ reused });
  // A shallow copy per caller, never the shared array: `processDeployment`
  // appends the SignalR trigger bar to what it is handed, and one leg's append
  // must not land in another leg's series. The bar objects themselves are
  // shared — safe only while nothing writes a `BarData` field in place, which
  // nothing on the engine side does. An append-and-adjust would land in every
  // leg's series; copy the element first.
  return [...(await hit.bars)];
}

/**
 * Best-effort exit fill price. Uses the latest bar close for the contract
 * since `searchOpenOrders` only exposes working orders and there's no
 * fills endpoint. Replace with SignalR GatewayUserOrder feed for exact
 * fills when we add the hub listener.
 *
 * `marketDataContractId` is the same translator `snapshotTradeBars` takes,
 * for the same reason (bugs.md A118): the row's contract is the execution id,
 * which on Tradovate the market-data provider cannot name. Null means "cannot
 * tell" and nothing is fetched; absent, the row's id is used as-is.
 */
export async function resolveExitFillPrice(
  trade: { contractId: string },
  marketDataContractId?: (contractId: string) => Promise<string | null>,
): Promise<number | null> {
  try {
    const barsContractId = marketDataContractId
      ? await marketDataContractId(trade.contractId)
      : trade.contractId;
    if (!barsContractId) return null;
    const bars = await marketDataRegistry.realtime().retrieveBars({
      contractId: barsContractId,
      live: false,
      startTime: new Date(Date.now() - 10 * 60_000).toISOString(),
      endTime: new Date().toISOString(),
      unit: 2,
      unitNumber: 1,
      limit: 1,
      includePartialBar: true,
    });
    return bars[0]?.close ?? null;
  } catch {
    return null;
  }
}

/**
 * Snapshot the bar window around a closed trade and persist it via
 * saveTradeBars. Window: max(300, computeWarmupBars(strategy)) bars
 * before entry + 300 bars after exit. The 300 floor matches the chart
 * route's BARS_BEFORE_ENTRY; the warmup ceiling lets a slowPeriod=200
 * strategy's indicators settle by the trigger bar so the replay
 * engine doesn't false-tag the trade as signal_drift.
 *
 * Best-effort: any failure here is logged at warn level via the supplied
 * `log` callback but doesn't block the close path. The chart route falls
 * back to a live /retrieveBars hit when no snapshot exists, so worst-case
 * the trade just gets a live-fetched chart until the contract ages out
 * of Topstep's ~3-month history horizon.
 *
 * `marketDataContractId` is the engine's translation of the row's
 * contract into the namespace the market-data slot speaks. The row holds
 * the *execution* contract (`MNQU6` on a Tradovate leg), and one provider
 * serves every broker, so passing it through asks that provider for a
 * symbol it has never heard of (bugs.md A54). Null means "cannot tell":
 * nothing is fetched rather than bars off the wrong contract. Absent, the
 * row's id is used as-is — correct for a Topstep row only.
 *
 * The outcome is for the re-snapshot queue, which must advance its row on
 * every answer (bugs.md A16): `retire` is a bail no later attempt can change,
 * `retry` is a window that may yet fill — no bars yet, or a failed read. The
 * close-time caller ignores it.
 */
export async function snapshotTradeBars(
  tradeId: number,
  log: (
    deploymentId: string,
    severity: "warn",
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ) => void,
  marketDataContractId?: (contractId: string) => Promise<string | null>,
): Promise<SnapshotOutcome> {
  const BARS_BEFORE_ENTRY_FLOOR = 300;
  // Widened from 50 → 300 (2026-04-29) so replay walk-forward has
  // enough post-entry runway to hit TP/SL on slow trades. Storage is
  // cheap; replay fidelity is load-bearing for EXEC DRIFT classification.
  const BARS_AFTER_EXIT = 300;
  try {
    const trade = getTradeById(tradeId);
    if (!trade) return { kind: "retire", reason: "the trade row is gone" };
    const strategy = getStrategy(trade.strategyKey);
    if (!strategy) return { kind: "retire", reason: `strategy ${trade.strategyKey} is not registered` };
    const deployment = trade.deploymentId ? getDeployment(trade.deploymentId) : null;
    const tf = resolveTimeframe(strategy.config, deployment?.paramValues) as Timeframe;
    const cfg = TIMEFRAME_TO_BAR[tf];
    if (!cfg) return { kind: "retire", reason: `no bar unit on file for timeframe "${tf}"` };
    const minutes = cfg.unit === 2 ? cfg.unitNumber
      : cfg.unit === 3 ? cfg.unitNumber * 60
      : cfg.unit === 4 ? cfg.unitNumber * 1440
      : 0;
    if (minutes <= 0) return { kind: "retire", reason: `timeframe "${tf}" has no minute length` };

    // Width the pre-entry window by the strategy's warmup needs so
    // replay sees enough bars to settle every indicator at the trigger
    // bar. Without this, a slowPeriod=200 strategy snapshotting only
    // 300 bars feeds NaN into shouldEnter at trigger time and replay
    // false-tags the trade signal_drift — corrupting the SIGNAL_DRIFT
    // pill's diagnostic value. Floors at 300 so single-indicator
    // strategies (and the chart route) keep their familiar window.
    const params = {
      ...defaultParamValues(strategy.params),
      ...migrateLegacyParamOverrides(
        trade.strategyKey,
        (trade.paramSnapshot as ParamValues | null) ?? deployment?.paramValues ?? {},
        { deploymentId: deployment?.id ?? trade.deploymentId },
      ),
    } as CommonParams;
    const indicatorConfigs =
      strategy.buildIndicators?.(params) ?? strategy.config.indicators;
    const barsBeforeEntry = Math.max(
      BARS_BEFORE_ENTRY_FLOOR,
      computeWarmupBars(indicatorConfigs, params),
    );

    const entryIso = trade.entryFilledAt ?? trade.entrySubmittedAt;
    const entryMs = new Date(entryIso).getTime();
    const exitMs = trade.exitFilledAt ? new Date(trade.exitFilledAt).getTime() : Date.now();
    const maturityMs = exitMs + BARS_AFTER_EXIT * minutes * 60_000;
    const startTime = new Date(entryMs - barsBeforeEntry * minutes * 60_000).toISOString();
    // Cap initial fetch to now — post-exit bars don't exist yet. The
    // re-snapshot at maturityMs fills the post-exit tail. Without this
    // cap, concurrent closes (e.g. flatten-all) issue multi-day requests
    // that hit Topstep's 429 rate limit even though the future bars are
    // unavailable anyway.
    const nowMs = Date.now();
    const endTime = new Date(Math.min(maturityMs, nowMs)).toISOString();

    const barsContractId = marketDataContractId
      ? await marketDataContractId(trade.contractId)
      : trade.contractId;
    if (!barsContractId) {
      throw new Error(`no market-data contract for ${trade.contractId}`);
    }

    const bars = await marketDataRegistry.realtime().retrieveBars({
      contractId: barsContractId,
      live: false,
      startTime,
      endTime,
      unit: cfg.unit,
      unitNumber: cfg.unitNumber,
      // barsBeforeEntry + BARS_AFTER_EXIT is typically ≤ 750 even for
      // slowPeriod=200 strategies; cap at 1000 to tolerate trades that
      // ran for many sessions before exit.
      limit: 1000,
      includePartialBar: false,
    });
    if (bars.length === 0) return { kind: "retry", reason: "the provider returned no bars for the window" };

    // Always queue a re-snapshot when the post-exit tail is incomplete.
    const dueAt = nowMs < maturityMs ? new Date(maturityMs).toISOString() : null;
    saveTradeBars(tradeId, bars, tf, dueAt);
    return { kind: "saved" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(ENGINE_SCOPE, "warn", "system", `Bar snapshot failed for trade #${tradeId}: ${reason}`, { tradeId });
    return { kind: isRateLimitRefusal(err) ? "defer" : "retry", reason };
  }
}

/** `defer` is a read refused for rate: it says nothing about the window, so
 *  the queue waits it out without spending an attempt. */
export type SnapshotOutcome =
  | { kind: "saved" }
  | { kind: "retry"; reason: string }
  | { kind: "defer"; reason: string }
  | { kind: "retire"; reason: string };

const RATE_LIMITED_STATUS = 429;

/** Read structurally, as `brokerErrorAccountId` reads `accountId`: the engine
 *  names no provider's error class, and a message match would turn on prose. */
export function isRateLimitRefusal(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { status?: unknown }).status === RATE_LIMITED_STATUS;
}

/** Attempts per queued row, a retry counting the same as a failure. */
export const SNAPSHOT_RETRY_LIMIT = 3;
/** Re-snapshots per reconcile tick, so a long offline window does not
 *  burst-fire dozens of `/retrieveBars` reads at once. */
export const SNAPSHOT_PER_TICK_LIMIT = 3;
/** How long a `retry` row waits before it is asked again. A row is due 300
 *  bars after its exit, so a provider with no bars for it is lagging on the
 *  order of minutes; asking every 15s tick was the A16 defect. */
export const SNAPSHOT_RETRY_DELAY_MS = 5 * 60_000;

/** tradeId → epoch ms before which the row is not asked again. Holds only
 *  unexpired deferrals (pruned on every pass), so at most the rows retried in
 *  the last `SNAPSHOT_RETRY_DELAY_MS`. */
const snapshotDeferredUntil = new Map<number, number>();

export interface SnapshotQueueDeps {
  passive(): boolean;
  snapshot(tradeId: number): Promise<SnapshotOutcome>;
  log(deploymentId: string, severity: "info" | "warn", category: LogCategory, message: string, subject?: LogSubject): void;
}

/**
 * Re-snapshot the rows whose maturity time has passed. Every outcome advances
 * the row: `saved` clears it (`saveTradeBars` writes the new due time), `retire`
 * takes it off the queue, `retry` spends one attempt and waits
 * `SNAPSHOT_RETRY_DELAY_MS` — after `SNAPSHOT_RETRY_LIMIT` the partial bars
 * stay as the final state — and `defer` (a rate refusal) waits the same delay
 * and spends nothing.
 *
 * **Skipped while the hub is passive** (A15, documented rather than capped):
 * the queue is a column on rows that exist anyway, so a passive window costs
 * no memory and grows by at most one row per trade closed in it, and the
 * first active tick resumes in due order. Passive mode polls REST for every
 * deployment, which is the budget this protects.
 */
export async function runSnapshotQueue(deps: SnapshotQueueDeps): Promise<void> {
  if (deps.passive()) return;
  const nowMs = Date.now();
  for (const [id, until] of snapshotDeferredUntil) {
    if (until <= nowMs) snapshotDeferredUntil.delete(id);
  }
  // Over-read by the deferred count so rows waiting out a delay at the head
  // of the due order cannot starve the rows behind them.
  const due = listDueSnapshots(
    new Date(nowMs).toISOString(),
    SNAPSHOT_RETRY_LIMIT,
    SNAPSHOT_PER_TICK_LIMIT + snapshotDeferredUntil.size,
  )
    .filter((row) => !snapshotDeferredUntil.has(row.tradeId))
    .slice(0, SNAPSHOT_PER_TICK_LIMIT);
  for (const row of due) {
    let outcome: SnapshotOutcome;
    try {
      outcome = await deps.snapshot(row.tradeId);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      outcome = { kind: isRateLimitRefusal(err) ? "defer" : "retry", reason };
    }
    if (outcome.kind === "saved") {
      snapshotDeferredUntil.delete(row.tradeId);
      continue;
    }
    if (outcome.kind === "retire") {
      snapshotDeferredUntil.delete(row.tradeId);
      abandonSnapshotQueue(row.tradeId);
      deps.log(
        ENGINE_SCOPE,
        "info",
        "system",
        `Snapshot queue retired trade #${row.tradeId}: ${outcome.reason}; its stored bars stay as they are`,
        { tradeId: row.tradeId },
      );
      continue;
    }
    // A 429 storm longer than two delays would otherwise retire every due row.
    if (outcome.kind === "defer") {
      snapshotDeferredUntil.set(row.tradeId, nowMs + SNAPSHOT_RETRY_DELAY_MS);
      continue;
    }
    const attempts = incrementSnapshotRetry(row.tradeId);
    if (attempts >= SNAPSHOT_RETRY_LIMIT) {
      snapshotDeferredUntil.delete(row.tradeId);
      abandonSnapshotQueue(row.tradeId);
      deps.log(
        ENGINE_SCOPE,
        "warn",
        "system",
        `Snapshot queue gave up on trade #${row.tradeId} after ${attempts} attempts: ${outcome.reason}`,
        { tradeId: row.tradeId },
      );
      continue;
    }
    snapshotDeferredUntil.set(row.tradeId, nowMs + SNAPSHOT_RETRY_DELAY_MS);
  }
}
