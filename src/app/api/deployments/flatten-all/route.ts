import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { getTradovateClientIfConfigured } from "@/lib/trading/engine/engine-singleton";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { buildCustomTag } from "@/lib/trading/engine/engine";
import { LIVE_ORDER_STATUSES } from "@/lib/trading/engine/engine-exit-legs";
import { isProductionEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { trackOrderRequest } from "@/lib/shutdown-drain";
import type { ExitReasonCode } from "@/lib/logging/exit-reasons";
import type {
  Account,
  Position,
  PlaceOrderRequest,
  PlaceOrderResponse,
} from "@/lib/brokers/types";
import type { Broker } from "@/lib/trading/broker-access/broker";
import { BrokerKind } from "@/lib/db/account-brokers";
import { BrokerOrderRole } from "@/lib/trading/orders/order-role";
import { tickerForContractId } from "@/lib/trading/broker-access/contract-resolver";
import type { TradovateClient } from "@/lib/brokers/tradovate/client";
import {
  attachPendingExit,
  backfillExitOrderId,
  findTradeByAccountContract,
  findRecentApproximatedTradeByAccountContract,
} from "@/lib/db/trades";

// Not `handle`: that name is the route's request handler below.
const engine = engineHandle();

// Emergency batch-flatten. Fans out market exits across all open positions
// for env-appropriate accounts (prod: live/eval; staging: practice/sim),
// then sweeps resting orders. Broker-extensible via the brokers[] list.

/** Exit reason stamped on a trade row this route closes. Typed as an
 *  `ExitReasonCode` so a typo fails to compile rather than falling through
 *  to the residual arm, which is exactly what the previous `"Flatten All"`
 *  string did. Declared here for the same reason the guards declare theirs:
 *  the actor owns its reason, the table owns its rendering. */
export const FLATTEN_ALL_EXIT_REASON: ExitReasonCode = "flatten_all";

type FlattenStatus = "ok" | "skipped" | "error";

interface AccountFlattenResult {
  accountId: number;
  accountName: string;
  broker: BrokerKind;
  status: FlattenStatus;
  reason?: string;
  positions: PositionFlattenResult[];
  cancelledOrders?: CancelResult[];
  /** Deployment ids on this account that had an engine exit in flight when
   *  the panic button fired. Present only when non-empty. Observational —
   *  the flatten proceeds regardless; this is what explains a fill count
   *  that looks doubled. */
  exitsInFlight?: string[];
  /** The exit latch could not be read, so an absent `exitsInFlight` says
   *  nothing about whether an engine exit was in flight. Present only then. */
  exitsInFlightUnknown?: true;
}

interface PositionFlattenResult {
  contractId: string;
  size: number;
  status: "ok" | "skipped" | "error";
  orderId?: number;
  reason?: string;
}

interface CancelResult {
  orderId: number;
  status: "ok" | "error";
  reason?: string;
}

interface AccountWork {
  account: Account;
  broker: Broker;
  brokerKind: BrokerKind;
  positions: Position[];
}

// Module-scope inflight guard: second concurrent POST → 409. The
// press-and-hold button makes accidental double-fires unlikely, but
// this prevents stuck-tab or automation-driven duplicates from doubling
// close attempts during a real flatten.
let inflight: Promise<Response> | null = null;

export async function POST(request: NextRequest): Promise<Response> {
  if (inflight) {
    return NextResponse.json(
      { error: "flatten-all already in flight" },
      { status: 409 },
    );
  }
  inflight = trackOrderRequest(() => handle(request));
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function handle(request: NextRequest): Promise<Response> {
  // The session gates the route. Neither broker's availability does: a
  // missing or expired broker session is reported as a broker-level error
  // in `results`, never as a 401.
  const denied = requireSession(request);
  if (denied) return denied;

  const isProd = isProductionEnv();

  // Both brokers now join the fan-out only when they are actually usable,
  // and a broker that cannot be reached is a soft per-broker error rather
  // than a dead route — this is the panic button, and partial coverage
  // beats zero coverage.
  let topstepToken: string | null = null;
  let topstepTokenError: string | null = null;
  try {
    topstepToken = await topstepBrowserToken();
  } catch (err) {
    topstepTokenError = err instanceof Error ? err.message : String(err);
  }
  const tradovate = await getTradovateClientIfConfigured();

  const brokers: Array<{ kind: BrokerKind; broker: Broker }> = [];
  if (topstepToken) {
    const topstep = new TopstepClient();
    topstep.setToken(topstepToken);
    brokers.push({ kind: BrokerKind.Topstep, broker: topstep });
  }
  if (tradovate) brokers.push({ kind: BrokerKind.Tradovate, broker: tradovate });

  const accountFetches = await Promise.allSettled(
    brokers.map((b) => b.broker.searchAccounts()),
  );

  const accounts: Account[] = [];
  const brokerByAccount = new Map<number, Broker>();
  const brokerKindByAccount = new Map<number, BrokerKind>();
  const brokerFetchErrors: AccountFlattenResult[] = [];
  if (topstepTokenError) {
    brokerFetchErrors.push({
      accountId: 0,
      accountName: `(${BrokerKind.Topstep})`,
      broker: BrokerKind.Topstep,
      status: "error",
      reason: `Topstep auth failed: ${topstepTokenError}`,
      positions: [],
    });
  }
  // Both Topstep and Tradovate searchAccounts failures are soft: this
  // route is the operator's panic button, and partial coverage during a
  // broker outage beats zero coverage. The Topstep-only deployments still
  // fire if Tradovate is down, and vice versa.
  for (let idx = 0; idx < accountFetches.length; idx++) {
    const res = accountFetches[idx];
    const b = brokers[idx];
    if (res.status === "fulfilled") {
      for (const a of res.value) {
        accounts.push(a);
        brokerByAccount.set(a.id, b.broker);
        brokerKindByAccount.set(a.id, b.kind);
      }
      continue;
    }
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
    log.event(
      "flatten_all_accounts_unreadable",
      "flatten-all",
      `${b.kind} searchAccounts failed: ${reason}`,
    );
    brokerFetchErrors.push({
      accountId: 0,
      accountName: `(${b.kind})`,
      broker: b.kind,
      status: "error",
      reason: `searchAccounts failed: ${reason}`,
      positions: [],
    });
  }

  const targetPractice = !isProd;
  const scoped: Account[] = [];
  const skipped: AccountFlattenResult[] = [];
  for (const a of accounts) {
    if (a.practice !== targetPractice) {
      skipped.push({
        accountId: a.id,
        accountName: a.name,
        broker: a.broker as BrokerKind,
        status: "skipped",
        reason: isProd
          ? "practice account excluded in production"
          : "live/eval account excluded in staging",
        positions: [],
      });
      continue;
    }
    scoped.push(a);
  }

  const positionFetches = await Promise.allSettled(
    scoped.map(async (a): Promise<AccountWork> => {
      const broker = brokerByAccount.get(a.id);
      const brokerKind = brokerKindByAccount.get(a.id);
      if (!broker || !brokerKind) {
        throw new Error(`no broker registered for account ${a.id}`);
      }
      const positions = await broker.searchOpenPositions(a.id);
      return { account: a, broker, brokerKind, positions };
    }),
  );

  const work: AccountWork[] = [];
  const fetchErrors: AccountFlattenResult[] = [];
  positionFetches.forEach((res, idx) => {
    const a = scoped[idx];
    if (res.status === "fulfilled") {
      if (res.value.positions.length > 0) work.push(res.value);
      return;
    }
    fetchErrors.push({
      accountId: a.id,
      accountName: a.name,
      broker: a.broker as BrokerKind,
      status: "error",
      reason: `searchOpenPositions failed: ${res.reason instanceof Error ? res.reason.message : String(res.reason)}`,
      positions: [],
    });
  });

  const fired = await Promise.allSettled(
    work.map((w) => flattenAccount(w, tradovate)),
  );

  const results: AccountFlattenResult[] = [
    ...skipped,
    ...brokerFetchErrors,
    ...fetchErrors,
  ];
  fired.forEach((res, idx) => {
    const w = work[idx];
    if (res.status === "fulfilled") {
      results.push(res.value);
      return;
    }
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
    // The positions were read; `positions: []` is what an account never
    // reached writes, and the button reads it that way. No sweep ran, so the
    // marker cancel row says orders may remain.
    results.push({
      accountId: w.account.id,
      accountName: w.account.name,
      broker: w.account.broker as BrokerKind,
      status: "error",
      reason,
      positions: w.positions.map((p) => ({
        contractId: p.contractId,
        size: p.size,
        status: "error",
        reason,
      })),
      cancelledOrders: [{ orderId: -1, status: "error", reason: `sweep not run: ${reason}` }],
    });
  });

  const attemptedAccounts = work.length;
  const errorCount = results.filter((r) => r.status === "error").length;
  let closedPositions = 0;
  let failedPositions = 0;
  for (const r of results) {
    for (const p of r.positions) {
      if (p.status === "ok") closedPositions++;
      else if (p.status === "error") failedPositions++;
    }
  }
  const totalPositions = closedPositions + failedPositions;
  log.event(
    "flatten_all_complete",
    "flatten-all",
    `complete: closed=${closedPositions} failed=${failedPositions} total=${totalPositions} ` +
      `(env=${isProd ? "prod" : "staging"}, targetPractice=${targetPractice})`,
  );

  return NextResponse.json({
    ok: errorCount === 0,
    env: isProd ? "prod" : "staging",
    isProd,
    attempted: attemptedAccounts,
    results,
  });
}

async function flattenAccount(
  w: AccountWork,
  tradovate: TradovateClient | null,
): Promise<AccountFlattenResult> {
  const { account, broker, brokerKind, positions } = w;

  // Observe the exit latch; never defer to it. `placeExitOrder` refuses a
  // second concurrent exit per deployment, but this route deliberately
  // bypasses that wrapper — the panic button is a last-resort path and must
  // not be refusable, same as the naked-position watchdog. Reading the latch
  // here means an operator who fires during an in-flight engine exit gets the
  // reason a fill count looks doubled in the response, rather than having to
  // reconstruct it from the engine log. A read that throws must not become
  // the gate the rule forbids, so it reports and the flatten goes on.
  let exitsInFlight: string[] = [];
  let exitsInFlightUnknown = false;
  try {
    exitsInFlight = (await engine.exitsInFlightForAccount(account.id)) ?? [];
  } catch (err) {
    exitsInFlightUnknown = true;
    log.event(
      "flatten_all_exits_in_flight",
      "flatten-all",
      `account=${account.id} exit latch unreadable (${err instanceof Error ? err.message : String(err)}) — flattening anyway`,
      { accountId: account.id },
    );
  }
  if (exitsInFlight.length > 0) {
    log.event(
      "flatten_all_exits_in_flight",
      "flatten-all",
      `account=${account.id} has ${exitsInFlight.length} engine exit(s) in flight (${exitsInFlight.join(", ")}) — flattening anyway; expect duplicate exit fills`,
      { accountId: account.id },
    );
  }

  const placements = await Promise.allSettled(
    positions.map((p) => closePosition(broker, brokerKind, account.id, p, tradovate)),
  );

  const positionResults: PositionFlattenResult[] = placements.map((res, idx) => {
    const p = positions[idx];
    if (res.status === "fulfilled") {
      const v = res.value;
      if (v.skipped) {
        return {
          contractId: p.contractId,
          size: p.size,
          status: "skipped",
          reason: v.reason,
        };
      }
      return {
        contractId: p.contractId,
        size: p.size,
        status: "ok",
        orderId: v.response.orderId,
      };
    }
    const reason = res.reason instanceof Error ? res.reason.message : String(res.reason);
    // The route has no deployment to read a ticker off — it sweeps the
    // broker’s own book — so the symbol is derived from the contract id.
    // `null` for a product this install does not map, which withholds the
    // slot rather than naming a symbol nobody verified.
    log.event(
      "flatten_all_close_failed",
      "flatten-all",
      `close failed (account=${account.id}, contract=${p.contractId}): ${reason}`,
      {
        accountId: account.id,
        contractId: p.contractId,
        ticker: tickerForContractId(p.contractId),
      },
    );
    return {
      contractId: p.contractId,
      size: p.size,
      status: "error",
      reason,
    };
  });

  // After closes settle, sweep any resting working orders on this
  // account so orphaned trailing stops / bracket children cannot re-enter
  // the market. Mirrors src/app/api/dev/flatten/route.ts; per-cancel
  // failures log+continue rather than abort the account result.
  const cancelledOrders: CancelResult[] = [];
  try {
    const open = await broker.searchOpenOrders(account.id, { forceFresh: true });
    // Every order type and side, not just protective legs: a panic sweep.
    // Pending is resting too, and could go working on the now-flat account.
    const resting = open.filter((o) => LIVE_ORDER_STATUSES.has(o.status));
    for (const order of resting) {
      try {
        await broker.cancelOrder(order.id, account.id);
        cancelledOrders.push({ orderId: order.id, status: "ok" });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        log.event(
          "flatten_all_cancel_failed",
          "flatten-all",
          `cancel failed (account=${account.id}, order=${order.id}): ${reason}`,
          { accountId: account.id, contractId: order.contractId },
        );
        cancelledOrders.push({ orderId: order.id, status: "error", reason });
      }
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.event(
      "flatten_all_orders_unreadable",
      "flatten-all",
      `searchOpenOrders failed (account=${account.id}): ${reason}`,
      { accountId: account.id },
    );
    cancelledOrders.push({
      orderId: -1,
      status: "error",
      reason: `searchOpenOrders failed: ${reason}`,
    });
  }

  const anyError =
    positionResults.some((r) => r.status === "error") ||
    cancelledOrders.some((c) => c.status === "error");
  return {
    accountId: account.id,
    accountName: account.name,
    broker: account.broker as BrokerKind,
    status: anyError ? "error" : "ok",
    positions: positionResults,
    cancelledOrders,
    ...(exitsInFlight.length > 0 ? { exitsInFlight } : {}),
    ...(exitsInFlightUnknown ? { exitsInFlightUnknown: true as const } : {}),
  };
}

interface ClosePositionResult {
  skipped?: false;
  response: PlaceOrderResponse;
}
interface SkippedPositionResult {
  skipped: true;
  reason: string;
}

async function closePosition(
  broker: Broker,
  brokerKind: BrokerKind,
  accountId: number,
  position: Position,
  tradovate: TradovateClient | null,
): Promise<ClosePositionResult | SkippedPositionResult> {
  // Tradovate positions carry a numeric contractId (e.g. 4393747). Warm
  // the client cache so the translator can route placeOrder, then resolve
  // to the dated symbol (e.g. "MYMM6") for the DB trade lookup — the engine
  // stores the dated symbol in strategy_trades.contract_id.
  let resolvedContractId = position.contractId;
  if (brokerKind === BrokerKind.Tradovate) {
    const numericId = parseNumericContractId(position.contractId);
    if (numericId !== null) {
      if (!tradovate) {
        return {
          skipped: true,
          reason: "contract not warmed — run engine first or start market data",
        };
      }
      try {
        await tradovate.warmContractId(numericId);
      } catch (err) {
        return {
          skipped: true,
          reason: `warmContractId failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const datedSymbol = tradovate.getDatedSymbolForContractId(numericId);
      if (datedSymbol === null) {
        return {
          skipped: true,
          reason: "contract not warmed — run engine first or start market data",
        };
      }
      resolvedContractId = datedSymbol;
    }
  }

  // Position.type: 1 = long (close with side 1 = Sell), 2 = short
  // (close with side 0 = Buy). size is always positive.
  const closingSide: 0 | 1 = position.type === 1 ? 1 : 0;
  const order: PlaceOrderRequest = {
    accountId,
    contractId: position.contractId,
    type: 2,
    side: closingSide,
    size: position.size,
    brokerOrderRole: BrokerOrderRole.Exit,
    customTag: buildCustomTag("s", position.contractId),
  };
  const response = await broker.placeOrder(order);

  // Stamp the exit order id so the heal pass can scope its /fill/deps
  // lookup to this specific order. The position-close WS event often
  // arrives before this route returns — the trade may already be 'closed'
  // and approximated by the time we get here. Use attachPendingExit for
  // in-flight trades; backfillExitOrderId for already-closed ones so we
  // don't corrupt the status column.
  try {
    const openTrade = findTradeByAccountContract(accountId, resolvedContractId);
    if (openTrade != null) {
      log.event(
        "flatten_all_exit_stamped",
        "flatten-all",
        `stamping exit orderId=${response.orderId} on open trade #${openTrade.id} (${resolvedContractId})`,
        { accountId, contractId: resolvedContractId, tradeId: openTrade.id },
      );
      attachPendingExit({
        tradeId: openTrade.id,
        exitOrderId: response.orderId,
        exitSubmittedAt: new Date().toISOString(),
        // The reason **code**, not a label. This site used to write
        // `"Flatten All"` into the code slot, which no arm recognised, so
        // every panic-button close was relabelled to the residual
        // `bracket_manual` at reconcile and re-swept forever.
        exitReason: FLATTEN_ALL_EXIT_REASON,
      });
    } else {
      const closedTrade = findRecentApproximatedTradeByAccountContract(
        accountId,
        resolvedContractId,
      );
      if (closedTrade != null) {
        log.event(
          "flatten_all_exit_stamped",
          "flatten-all",
          `backfilling exit orderId=${response.orderId} on already-closed trade #${closedTrade.id} (${resolvedContractId})`,
          { accountId, contractId: resolvedContractId, tradeId: closedTrade.id },
        );
        backfillExitOrderId(closedTrade.id, response.orderId);
      } else {
        log.event(
          "flatten_all_exit_unstamped",
          "flatten-all",
          `no trade found to stamp exit orderId=${response.orderId} (account=${accountId} contract=${resolvedContractId})`,
          { accountId, contractId: resolvedContractId },
        );
      }
    }
  } catch (err) {
    log.event(
      "flatten_all_exit_unstamped",
      "flatten-all",
      `exit orderId stamp failed (account=${accountId}, contract=${position.contractId}): ${err instanceof Error ? err.message : String(err)}`,
      { accountId, contractId: position.contractId },
    );
  }

  return { response };
}

function parseNumericContractId(id: string): number | null {
  if (id === "") return null;
  if (!/^\d+$/.test(id)) return null;
  const n = Number(id);
  return Number.isFinite(n) ? n : null;
}
