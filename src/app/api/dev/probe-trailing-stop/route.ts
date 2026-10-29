import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { TopstepClient } from "@/lib/brokers/topstep/client";
import { topstepBrowserToken } from "@/lib/brokers/topstep/browser-token";
import { marketDataRegistry } from "@/lib/market-data/registry-singleton";
import { ContractResolver } from "@/lib/trading/broker-access/contract-resolver";
import { getDeployment } from "@/lib/db/deployments";
import type { OrderSide, PlaceOrderRequest, BracketConfig, Order } from "@/lib/brokers/types";

/**
 * Probe Topstep's TrailingStop (OrderType=5) behavior. Modes:
 *
 *   mode=bracket    Place a market entry with stopLossBracket.type=5.
 *                   Confirms the bracket form is honored. (Confirmed 2026-04-29.)
 *
 *   mode=standalone Place a market entry with type=4 SL, then a separate
 *                   type=5 order with trailPrice. Originally rejected
 *                   ("Trail Distance exceeds maximum (1000)") — likely a
 *                   race because the trail was placed before the entry
 *                   filled. mode=promote tests the post-fill case properly.
 *
 *   mode=promote    The production-target flow: enter long with type=4 SL +
 *                   type=1 TP brackets (full OCO), wait for entry fill,
 *                   identify the SL and TP child orders, cancel the SL,
 *                   place a fresh type=5 standalone, then snapshot all
 *                   resting orders. Answers: can we promote SL→trail
 *                   mid-trade, and does the new trail get OCO-linked to
 *                   the surviving TP?
 *
 *   mode=oco-test   Run promote, then deliberately *fire* the trail by
 *                   modifying its trailPrice down to 10 ticks. After fill,
 *                   snapshot orders to see whether Topstep auto-cancels
 *                   the orphaned TP or leaves it working (would short us
 *                   on a reversal). This is the load-bearing question for
 *                   the production design.
 *
 * Position is intentionally LEFT OPEN where applicable so the caller can
 * inspect via the orders table and flatten via the existing button (which
 * now also cancels resting orders on the contract).
 */

// Initial standalone-mode trailPrice (ticks). 10 was rejected with the
// misleading "exceeds maximum (1000)" message — likely because the trail
// was placed before the entry filled. promote-mode places it post-fill
// and uses the same value to test whether the actual issue was timing.
const INITIAL_TRAIL_TICKS = 10;
// oco-test mode tightens the working trail to this distance to force a
// fill within seconds. /NQ moves enough that 1 tick would race with
// modify; 10 ticks is the smallest reliably-fillable distance.
const FORCE_FIRE_TRAIL_TICKS = 10;
const SAMPLE_DELAYS_MS = [0, 15_000, 30_000, 60_000];
// After firing the trail in oco-test, poll for it to fill + look at TP state.
const POST_FIRE_POLL_MS = 30_000;
const POST_FIRE_POLL_INTERVAL_MS = 1_000;

type Mode =
  | "bracket"
  | "standalone"
  | "promote"
  | "oco-test"
  | "modify-promote"
  | "standalone-v2"
  | "standalone-linked";

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: { deploymentId?: string; side?: OrderSide; mode?: Mode };
  try {
    body = (await request.json()) as { deploymentId?: string; side?: OrderSide; mode?: Mode };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { deploymentId, side, mode } = body;
  if (!deploymentId || (side !== 0 && side !== 1)) {
    return NextResponse.json({ error: "deploymentId and side (0|1) required" }, { status: 400 });
  }
  const validModes: Mode[] = [
    "bracket",
    "standalone",
    "promote",
    "oco-test",
    "modify-promote",
    "standalone-v2",
    "standalone-linked",
  ];
  if (!mode || !validModes.includes(mode)) {
    return NextResponse.json(
      { error: `mode must be one of: ${validModes.join(", ")}` },
      { status: 400 },
    );
  }

  const deployment = getDeployment(deploymentId);
  if (!deployment) return NextResponse.json({ error: "Deployment not found" }, { status: 404 });

  const token = await topstepBrowserToken();
  if (!token) {
    return NextResponse.json({ error: "Topstep is not configured" }, { status: 503 });
  }
  const client = new TopstepClient();
  client.setToken(token);

  const steps: Array<{ step: string; data: unknown }> = [];
  const log = (step: string, data: unknown) => steps.push({ step, data });

  try {
    const resolver = new ContractResolver(client);
    const contract = await resolver.resolve(deployment.ticker);
    log("contract resolved", { id: contract.id, tickSize: contract.tickSize });

    const now = new Date();
    const start = new Date(now.getTime() - 5 * 60 * 1000);
    const bars = await marketDataRegistry.realtime().retrieveBars({
      contractId: contract.id,
      live: false,
      startTime: start.toISOString(),
      endTime: now.toISOString(),
      unit: 2,
      unitNumber: 1,
      limit: 5,
      includePartialBar: true,
    });
    if (bars.length === 0) {
      return NextResponse.json(
        { error: "No bars returned — market closed?", steps },
        { status: 502 },
      );
    }
    const lastClose = bars[bars.length - 1].close;
    log("market price (last close)", { lastClose });

    if (mode === "bracket") {
      return await runBracketProbe({ client, contract, deployment, side, lastClose, steps, log });
    }
    if (mode === "standalone") {
      return await runStandaloneProbe({ client, contract, deployment, side, lastClose, token, steps, log });
    }
    if (mode === "promote") {
      return await runPromoteProbe({ client, contract, deployment, side, lastClose, token, steps, log, fireAfter: false });
    }
    if (mode === "oco-test") {
      return await runPromoteProbe({ client, contract, deployment, side, lastClose, token, steps, log, fireAfter: true });
    }
    if (mode === "modify-promote") {
      return await runModifyPromoteProbe({ client, contract, deployment, side, lastClose, token, steps, log });
    }
    return await runStandaloneVariantProbe({
      client, contract, deployment, side, lastClose, token, steps, log,
      variant: mode === "standalone-v2" ? "with-stop-price" : "with-linked-id",
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), steps },
      { status: 502 },
    );
  }
}

async function runBracketProbe({
  client,
  contract,
  deployment,
  side,
  lastClose,
  steps,
  log,
}: {
  client: TopstepClient;
  contract: { id: string; tickSize: number };
  deployment: { id: string; accountId: number };
  side: OrderSide;
  lastClose: number;
  steps: Array<{ step: string; data: unknown }>;
  log: (step: string, data: unknown) => void;
}) {
  // Type=5 SL bracket sign: validator enforces type=4 convention (long < 0,
  // short > 0). Confirmed 2026-04-29 by rejection on long+100. The earlier
  // long-side -100 run (without TP bracket) placed but parked the trail
  // above entry — re-test with full OCO to see if the broker resolves
  // direction correctly when both legs are present.
  const SL_TICKS = 100;
  const TP_TICKS = 100;
  const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
  const tpBracketTicks = side === 0 ? TP_TICKS : -TP_TICKS;
  const placeReq: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 2,
    side,
    size: 1,
    customTag: `tprobeb_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`,
    stopLossBracket: { ticks: slBracketTicks, type: 5 } as BracketConfig,
    takeProfitBracket: { ticks: tpBracketTicks, type: 1 } as BracketConfig,
  };
  const placeRes = await client.placeOrderRaw(placeReq);
  log("place order with TrailingStop SL + Limit TP brackets", placeRes);
  if (!placeRes.success) {
    return NextResponse.json(
      { error: `Entry placement failed: ${placeRes.errorMessage ?? "unknown"}`, steps },
      { status: 502 },
    );
  }

  // Resolve both children. SL leg type=5, TP leg type=1, side opposite entry.
  const exitSide: OrderSide = side === 0 ? 1 : 0;
  let slChild: Order | null = null;
  let tpChild: Order | null = null;
  const POLL_DEADLINE = Date.now() + 5000;
  while (Date.now() < POLL_DEADLINE) {
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    const onContract = open.filter(
      (o) => o.contractId === contract.id && o.side === exitSide && o.status === 1,
    );
    slChild = onContract.find((o) => o.type === 5) ?? null;
    tpChild = onContract.find((o) => o.type === 1) ?? null;
    if (slChild && tpChild) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!slChild || !tpChild) {
    log("FAILED to find both OCO children", {
      slChild: slChild ? shallowOrder(slChild) : null,
      tpChild: tpChild ? shallowOrder(tpChild) : null,
    });
    return NextResponse.json(
      { error: "SL or TP child not found within 5s", steps },
      { status: 502 },
    );
  }
  log("OCO children resolved", {
    slChild: { ...shallowOrder(slChild), typeMeaning: slChild.type === 5 ? "TrailingStop (honored)" : `${slChild.type} (NOT trailing)` },
    tpChild: shallowOrder(tpChild),
  });

  return NextResponse.json({
    ok: true,
    mode: "bracket",
    summary: {
      entryOrderId: placeRes.orderId,
      slChildId: slChild.id,
      slChildType: slChild.type,
      slChildStopPrice: slChild.stopPrice,
      tpChildId: tpChild.id,
      tpChildType: tpChild.type,
      tpChildLimitPrice: tpChild.limitPrice,
      bracketHonored: slChild.type === 5,
      lastClose,
    },
    steps,
  });
}

async function runStandaloneProbe({
  client,
  contract,
  deployment,
  side,
  lastClose,
  token,
  steps,
  log,
}: {
  client: TopstepClient;
  contract: { id: string; tickSize: number };
  deployment: { id: string; accountId: number };
  side: OrderSide;
  lastClose: number;
  token: string;
  steps: Array<{ step: string; data: unknown }>;
  log: (step: string, data: unknown) => void;
}) {
  // Park risk with a normal type=4 stop bracket so we're never naked.
  const SL_TICKS = 100;
  const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
  const placeReq: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 2,
    side,
    size: 1,
    customTag: `tprobes_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`,
    stopLossBracket: { ticks: slBracketTicks, type: 4 } as BracketConfig,
  };
  const placeRes = await client.placeOrderRaw(placeReq);
  log("place market entry with fixed stop", placeRes);

  // Place a standalone TrailingStop on the exit side. We send trailPrice
  // through a raw fetch so we can capture the literal request/response.
  const exitSide: OrderSide = side === 0 ? 1 : 0;
  const trailReqBody = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 5,
    side: exitSide,
    size: 1,
    trailPrice: INITIAL_TRAIL_TICKS,
    customTag: `tprobet_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`,
  };
  let trailPlaceResponse: unknown = null;
  let trailOrderId: number | null = null;
  try {
    const raw = await fetch("https://api.topstepx.com/api/Order/place", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(trailReqBody),
    });
    const text = await raw.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { bodyText: text };
    }
    trailPlaceResponse = { status: raw.status, body: parsed };
    // Topstep returns HTTP 200 with success:false on validation failures.
    // Only treat the order as placed when success is truthy.
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { orderId?: unknown; success?: unknown };
      if (obj.success === true && typeof obj.orderId === "number") {
        trailOrderId = obj.orderId;
      }
    }
  } catch (err) {
    trailPlaceResponse = { error: err instanceof Error ? err.message : String(err) };
  }
  log("place standalone TrailingStop", { request: trailReqBody, response: trailPlaceResponse });

  if (trailOrderId === null) {
    return NextResponse.json(
      { error: "TrailingStop place failed — no orderId returned", steps },
      { status: 502 },
    );
  }

  // Sample the trailing stop over time. Look it up by id each time so we
  // see whether stopPrice (and trailPrice) drift server-side.
  const samples: Array<{ tMs: number; stopPrice: number | null; raw: unknown }> = [];
  let elapsed = 0;
  for (const targetMs of SAMPLE_DELAYS_MS) {
    const wait = targetMs - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    elapsed = targetMs;
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    const found = open.find((o) => o.id === trailOrderId);
    samples.push({
      tMs: targetMs,
      stopPrice: found?.stopPrice ?? null,
      raw: found ?? null,
    });
  }
  log("trailing stop samples", samples);

  // Derive units. If trailPrice=10 was treated as ticks, expected initial
  // stopPrice for a long-exit (sell-stop) sits ~10*tickSize below entry,
  // i.e. lastClose - 10*tickSize. If treated as decimal price, it'd sit
  // lastClose - 10. Compare to the first sample.
  const firstStop = samples[0]?.stopPrice;
  const ticksInterpretation = side === 0 ? lastClose - INITIAL_TRAIL_TICKS * contract.tickSize : lastClose + INITIAL_TRAIL_TICKS * contract.tickSize;
  const priceInterpretation = side === 0 ? lastClose - INITIAL_TRAIL_TICKS : lastClose + INITIAL_TRAIL_TICKS;
  const distTicks = firstStop !== null && firstStop !== undefined ? Math.abs(firstStop - ticksInterpretation) : null;
  const distPrice = firstStop !== null && firstStop !== undefined ? Math.abs(firstStop - priceInterpretation) : null;
  const unitsGuess =
    distTicks === null || distPrice === null
      ? "unknown — no stopPrice on first sample"
      : distTicks < distPrice
        ? "ticks"
        : "price (decimal)";

  // Did the stop tighten over time? Compare last vs first sample.
  const lastStop = samples[samples.length - 1]?.stopPrice;
  let tightened: boolean | null = null;
  if (firstStop != null && lastStop != null) {
    tightened = side === 0 ? lastStop > firstStop : lastStop < firstStop;
  }

  return NextResponse.json({
    ok: true,
    mode: "standalone",
    summary: {
      trailOrderId,
      trailPriceSent: INITIAL_TRAIL_TICKS,
      lastClose,
      firstSampleStopPrice: firstStop ?? null,
      lastSampleStopPrice: lastStop ?? null,
      unitsGuess,
      ticksDistance: distTicks,
      priceDistance: distPrice,
      stopTightenedOverTime: tightened,
    },
    steps,
  });
}

/**
 * promote / oco-test mode.
 *
 * 1. Place market entry with full OCO: stopLossBracket type=4 + takeProfitBracket type=1.
 * 2. Wait for the entry market order to disappear from open (= filled).
 * 3. Find SL child (type=4, opposite side) + TP child (type=1, opposite side).
 * 4. Cancel SL child.
 * 5. Place a fresh standalone type=5 with trailPrice=INITIAL_TRAIL_TICKS.
 * 6. Snapshot all open orders for the contract → look for the new trail
 *    AND verify the TP child is still working.
 * 7. (oco-test only) Modify the trail's trailPrice to FORCE_FIRE_TRAIL_TICKS
 *    so it sits ~10 ticks behind market and fills almost immediately.
 *    Poll for it to leave the open list (filled), then snapshot the TP child:
 *    is it still working (orphaned) or auto-cancelled?
 *
 * Position state is intentionally LEFT in whatever state the probe ends in
 * so the caller can inspect, then use Flatten (which now also cancels
 * resting orders).
 */
async function runPromoteProbe({
  client,
  contract,
  deployment,
  side,
  lastClose,
  token,
  steps,
  log,
  fireAfter,
}: {
  client: TopstepClient;
  contract: { id: string; tickSize: number };
  deployment: { id: string; accountId: number };
  side: OrderSide;
  lastClose: number;
  token: string;
  steps: Array<{ step: string; data: unknown }>;
  log: (step: string, data: unknown) => void;
  fireAfter: boolean;
}) {
  const SL_TICKS = 100;
  const TP_TICKS = 100;
  const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
  const tpBracketTicks = side === 0 ? TP_TICKS : -TP_TICKS;
  const exitSide: OrderSide = side === 0 ? 1 : 0;

  const tagBase = `tprobep_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`;

  // 1. Place entry with full OCO.
  const placeReq: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 2,
    side,
    size: 1,
    customTag: tagBase,
    stopLossBracket: { ticks: slBracketTicks, type: 4 } as BracketConfig,
    takeProfitBracket: { ticks: tpBracketTicks, type: 1 } as BracketConfig,
  };
  const placeRes = await client.placeOrderRaw(placeReq);
  log("place entry with full OCO", placeRes);
  if (!placeRes.success) {
    return NextResponse.json({ error: "Entry placement failed", steps }, { status: 502 });
  }

  // 2. Wait for entry to fill (market order leaves the open list once filled).
  // Then resolve SL + TP children. They'll have side = exitSide.
  let slChild: Order | null = null;
  let tpChild: Order | null = null;
  const ENTRY_WAIT_DEADLINE = Date.now() + 5_000;
  while (Date.now() < ENTRY_WAIT_DEADLINE) {
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    const onContract = open.filter((o) => o.contractId === contract.id && o.status === 1);
    slChild = onContract.find((o) => o.side === exitSide && o.type === 4) ?? null;
    tpChild = onContract.find((o) => o.side === exitSide && o.type === 1) ?? null;
    if (slChild && tpChild) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!slChild || !tpChild) {
    log("FAILED to find SL+TP children", { slChild, tpChild });
    return NextResponse.json(
      { error: "SL or TP child not found within 5s — entry may not have filled", steps },
      { status: 502 },
    );
  }
  log("OCO children resolved", {
    slChild: { id: slChild.id, type: slChild.type, stopPrice: slChild.stopPrice },
    tpChild: { id: tpChild.id, type: tpChild.type, limitPrice: tpChild.limitPrice },
  });

  // 3. Cancel SL child.
  let cancelError: string | null = null;
  try {
    await client.cancelOrder(slChild.id, deployment.accountId);
  } catch (err) {
    cancelError = err instanceof Error ? err.message : String(err);
  }
  log("cancel original SL", { id: slChild.id, error: cancelError });
  if (cancelError) {
    return NextResponse.json({ error: `Cancel SL failed: ${cancelError}`, steps }, { status: 502 });
  }

  // 4. Place standalone TrailingStop on exit side.
  const trailReqBody = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 5,
    side: exitSide,
    size: 1,
    trailPrice: INITIAL_TRAIL_TICKS,
    customTag: `${tagBase}_t`,
  };
  let trailPlaceResponse: unknown = null;
  let trailOrderId: number | null = null;
  try {
    const raw = await fetch("https://api.topstepx.com/api/Order/place", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(trailReqBody),
    });
    const text = await raw.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { bodyText: text };
    }
    trailPlaceResponse = { status: raw.status, body: parsed };
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { orderId?: unknown; success?: unknown };
      if (obj.success === true && typeof obj.orderId === "number") {
        trailOrderId = obj.orderId;
      }
    }
  } catch (err) {
    trailPlaceResponse = { error: err instanceof Error ? err.message : String(err) };
  }
  log("place replacement TrailingStop", { request: trailReqBody, response: trailPlaceResponse });

  if (trailOrderId === null) {
    return NextResponse.json(
      {
        error: "Replacement trail place failed — TP is now the only protection",
        steps,
      },
      { status: 502 },
    );
  }

  // 5. Snapshot all open orders for the contract — verify trail + TP both resting.
  const postPromote = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
  const postPromoteOnContract = postPromote
    .filter((o) => o.contractId === contract.id)
    .map((o) => ({
      id: o.id,
      type: o.type,
      side: o.side,
      status: o.status,
      stopPrice: o.stopPrice,
      limitPrice: o.limitPrice,
    }));
  log("post-promote orders on contract", postPromoteOnContract);

  if (!fireAfter) {
    return NextResponse.json({
      ok: true,
      mode: "promote",
      summary: {
        entryOrderId: placeRes.orderId,
        originalSlId: slChild.id,
        tpId: tpChild.id,
        newTrailId: trailOrderId,
        tpStillWorking: postPromoteOnContract.some((o) => o.id === tpChild!.id && o.status === 1),
        trailWorking: postPromoteOnContract.some((o) => o.id === trailOrderId && o.status === 1),
        lastClose,
      },
      steps,
    });
  }

  // 6. oco-test only: tighten the trail to FORCE_FIRE_TRAIL_TICKS so it
  //    fills within seconds. Use modifyOrder with trailPrice; this also
  //    answers whether trailPrice is mutable on a working type=5 order.
  let modifyError: string | null = null;
  try {
    await client.modifyOrder(deployment.accountId, trailOrderId, {
      trailPrice: FORCE_FIRE_TRAIL_TICKS,
    });
  } catch (err) {
    modifyError = err instanceof Error ? err.message : String(err);
  }
  log("modify trail to force fire", {
    trailOrderId,
    newTrailPrice: FORCE_FIRE_TRAIL_TICKS,
    error: modifyError,
  });
  if (modifyError) {
    return NextResponse.json(
      {
        error: `Modify trail failed: ${modifyError}. Means trailPrice may be immutable on working orders.`,
        steps,
      },
      { status: 502 },
    );
  }

  // 7. Poll for the trail to leave the open list (= filled or cancelled).
  const fireDeadline = Date.now() + POST_FIRE_POLL_MS;
  let trailLeftOpen = false;
  let lastSnapshot: ReturnType<typeof shallowOrder>[] = [];
  while (Date.now() < fireDeadline) {
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    lastSnapshot = open
      .filter((o) => o.contractId === contract.id)
      .map(shallowOrder);
    const trailStill = open.find((o) => o.id === trailOrderId);
    if (!trailStill || trailStill.status !== 1) {
      trailLeftOpen = true;
      break;
    }
    await new Promise((r) => setTimeout(r, POST_FIRE_POLL_INTERVAL_MS));
  }
  log("post-fire snapshot", { trailLeftOpen, openOnContract: lastSnapshot });

  // 8. THE money question — is the TP still working after the trail filled?
  const tpStillWorking = lastSnapshot.some((o) => o.id === tpChild!.id && o.status === 1);

  return NextResponse.json({
    ok: true,
    mode: "oco-test",
    summary: {
      entryOrderId: placeRes.orderId,
      originalSlId: slChild.id,
      tpId: tpChild.id,
      newTrailId: trailOrderId,
      trailFilledOrCancelled: trailLeftOpen,
      tpStillWorkingAfterTrailFired: tpStillWorking,
      verdict: tpStillWorking
        ? "ORPHAN RISK — TP survived; production code MUST cancel TP after trail fills."
        : "OCO HONORED — Topstep auto-cancelled TP when the replacement trail fired.",
      lastClose,
    },
    steps,
  });
}

function shallowOrder(o: Order) {
  return {
    id: o.id,
    type: o.type,
    side: o.side,
    status: o.status,
    stopPrice: o.stopPrice,
    limitPrice: o.limitPrice,
  };
}

/**
 * modify-promote mode.
 *
 * Tests an UNDOCUMENTED, externally-claimed mechanic: that calling
 * /api/Order/modify on a working type=4 Stop with a non-null `trailPrice`
 * silently converts the order to a Trailing Stop (type 5) AND preserves
 * the existing OCO link to the TP child. The swagger lacks any `type`
 * field on ModifyOrderRequest, so this is the only path that *could*
 * give us "fixed stop, then arm a trail at X% of TP" without breaking OCO.
 *
 * Sequence:
 *   1. Place market entry with full OCO (type=4 SL + type=1 TP).
 *   2. Wait for fill, resolve SL + TP children.
 *   3. Snapshot SL pre-modify.
 *   4. POST /api/Order/modify with { orderId: slChild.id, trailPrice: 10 }.
 *      Send NOTHING ELSE — no stopPrice override, no size — so the only
 *      observable change is whatever trailPrice triggers.
 *   5. Snapshot SL post-modify: did `type` flip to 5? Did stopPrice
 *      become null? Did the order survive at all?
 *   6. Wait 30s, snapshot again to see if stopPrice moves favorably
 *      (server-managed trail) and whether TP is still working.
 *
 * Position is left open — flatten cancels resting orders.
 */
async function runModifyPromoteProbe({
  client,
  contract,
  deployment,
  side,
  lastClose,
  token,
  steps,
  log,
}: {
  client: TopstepClient;
  contract: { id: string; tickSize: number };
  deployment: { id: string; accountId: number };
  side: OrderSide;
  lastClose: number;
  token: string;
  steps: Array<{ step: string; data: unknown }>;
  log: (step: string, data: unknown) => void;
}) {
  const SL_TICKS = 100;
  const TP_TICKS = 100;
  const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
  const tpBracketTicks = side === 0 ? TP_TICKS : -TP_TICKS;
  const exitSide: OrderSide = side === 0 ? 1 : 0;

  const tagBase = `tprobem_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`;

  // 1. Entry with full OCO.
  const placeReq: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 2,
    side,
    size: 1,
    customTag: tagBase,
    stopLossBracket: { ticks: slBracketTicks, type: 4 } as BracketConfig,
    takeProfitBracket: { ticks: tpBracketTicks, type: 1 } as BracketConfig,
  };
  const placeRes = await client.placeOrderRaw(placeReq);
  log("place entry with full OCO", placeRes);
  if (!placeRes.success) {
    return NextResponse.json({ error: "Entry placement failed", steps }, { status: 502 });
  }

  // 2. Resolve SL + TP children.
  let slChild: Order | null = null;
  let tpChild: Order | null = null;
  const ENTRY_WAIT_DEADLINE = Date.now() + 5_000;
  while (Date.now() < ENTRY_WAIT_DEADLINE) {
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    const onContract = open.filter((o) => o.contractId === contract.id && o.status === 1);
    slChild = onContract.find((o) => o.side === exitSide && o.type === 4) ?? null;
    tpChild = onContract.find((o) => o.side === exitSide && o.type === 1) ?? null;
    if (slChild && tpChild) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!slChild || !tpChild) {
    log("FAILED to find SL+TP children", { slChild, tpChild });
    return NextResponse.json(
      { error: "SL or TP child not found within 5s", steps },
      { status: 502 },
    );
  }
  log("OCO children resolved", {
    slChild: shallowOrder(slChild),
    tpChild: shallowOrder(tpChild),
  });
  const slPreModify = shallowOrder(slChild);

  // 3. Modify SL with ONLY trailPrice. Use a raw fetch so we capture the
  //    full response body verbatim — the gateway's success/error shape is
  //    what we actually care about here, not just success/throw.
  const modifyBody = {
    accountId: deployment.accountId,
    orderId: slChild.id,
    trailPrice: 10,
  };
  let modifyResponse: unknown = null;
  try {
    const raw = await fetch("https://api.topstepx.com/api/Order/modify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(modifyBody),
    });
    const text = await raw.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { bodyText: text };
    }
    modifyResponse = { status: raw.status, body: parsed };
  } catch (err) {
    modifyResponse = { error: err instanceof Error ? err.message : String(err) };
  }
  log("modify SL with trailPrice only", { request: modifyBody, response: modifyResponse });

  // 4. Snapshot SL post-modify.
  const postOpen = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
  const slPostModify = postOpen.find((o) => o.id === slChild!.id);
  log("SL post-modify", {
    found: !!slPostModify,
    snapshot: slPostModify ? shallowOrder(slPostModify) : null,
    typeBefore: slPreModify.type,
    typeAfter: slPostModify?.type ?? null,
    typeChanged: slPostModify ? slPostModify.type !== slPreModify.type : null,
  });

  // 5. Wait 30s and snapshot again — does stopPrice move favorably?
  await new Promise((r) => setTimeout(r, 30_000));
  const finalOpen = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
  const slFinal = finalOpen.find((o) => o.id === slChild!.id);
  const tpFinal = finalOpen.find((o) => o.id === tpChild!.id);
  log("30s post-modify snapshot", {
    sl: slFinal ? shallowOrder(slFinal) : null,
    tp: tpFinal ? shallowOrder(tpFinal) : null,
    onContract: finalOpen.filter((o) => o.contractId === contract.id).map(shallowOrder),
  });

  // 6. Verdict.
  const slStillWorking = !!slFinal && slFinal.status === 1;
  const slIsTrailingNow = !!slFinal && slFinal.type === 5;
  const tpStillWorking = !!tpFinal && tpFinal.status === 1;
  const stopPriceMoved =
    slPostModify?.stopPrice != null && slFinal?.stopPrice != null
      ? slFinal.stopPrice !== slPostModify.stopPrice
      : null;

  let verdict = "INCONCLUSIVE";
  if (!slStillWorking) {
    verdict = "MODIFY DESTROYED SL — Gemini was wrong; modify with trailPrice doesn't work this way.";
  } else if (slIsTrailingNow && tpStillWorking) {
    verdict = "✓ CONFIRMED — modify with trailPrice converts SL to type=5 AND OCO link survives.";
  } else if (slStillWorking && !slIsTrailingNow) {
    verdict = "Modify accepted but SL stayed type=4 — trailPrice was ignored or stored without converting.";
  }

  return NextResponse.json({
    ok: true,
    mode: "modify-promote",
    summary: {
      entryOrderId: placeRes.orderId,
      slId: slChild.id,
      tpId: tpChild.id,
      slPreModify,
      slPostModify: slPostModify ? shallowOrder(slPostModify) : null,
      slFinal: slFinal ? shallowOrder(slFinal) : null,
      tpFinal: tpFinal ? shallowOrder(tpFinal) : null,
      slStillWorking,
      slIsTrailingNow,
      tpStillWorking,
      stopPriceMovedOver30s: stopPriceMoved,
      verdict,
      lastClose,
    },
    steps,
  });
}

/**
 * standalone-v2 / standalone-linked.
 *
 * Final two untried surfaces of /api/Order/place for a standalone type=5:
 *
 *   with-stop-price   Send both stopPrice (initial trigger) AND trailPrice.
 *                     Bracket form internally expands ticks: -100, type: 5
 *                     into stopPrice + distance — maybe the standalone path
 *                     requires both fields explicit.
 *
 *   with-linked-id    Send linkedOrderId pointing at the entry order. The
 *                     dead-account probe shows linkedOrderId is a known
 *                     gateway field even though it's absent from our typed
 *                     PlaceOrderRequest. Theory: standalone type=5 needs a
 *                     parent order to inherit OCO behavior.
 *
 * Both leave a parking type=4 SL bracket on the entry so the position never
 * goes naked while we test.
 */
async function runStandaloneVariantProbe({
  client,
  contract,
  deployment,
  side,
  lastClose,
  token,
  steps,
  log,
  variant,
}: {
  client: TopstepClient;
  contract: { id: string; tickSize: number };
  deployment: { id: string; accountId: number };
  side: OrderSide;
  lastClose: number;
  token: string;
  steps: Array<{ step: string; data: unknown }>;
  log: (step: string, data: unknown) => void;
  variant: "with-stop-price" | "with-linked-id";
}) {
  const SL_TICKS = 100;
  const slBracketTicks = side === 0 ? -SL_TICKS : SL_TICKS;
  const exitSide: OrderSide = side === 0 ? 1 : 0;
  const tagBase = `tprobev_${deployment.id.replace(/-/g, "").slice(0, 6)}_${Date.now().toString(36)}`;

  const placeReq: PlaceOrderRequest = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 2,
    side,
    size: 1,
    customTag: tagBase,
    stopLossBracket: { ticks: slBracketTicks, type: 4 } as BracketConfig,
  };
  const placeRes = await client.placeOrderRaw(placeReq);
  log("place market entry with fixed stop", placeRes);
  if (!placeRes.success) {
    return NextResponse.json({ error: "Entry placement failed", steps }, { status: 502 });
  }

  // Wait for entry to fill so the type=5 attaches to a real position.
  const ENTRY_FILL_DEADLINE = Date.now() + 5_000;
  let parkingSl: Order | null = null;
  while (Date.now() < ENTRY_FILL_DEADLINE) {
    const open = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
    parkingSl = open.find(
      (o) => o.contractId === contract.id && o.side === exitSide && o.type === 4 && o.status === 1,
    ) ?? null;
    if (parkingSl) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!parkingSl) {
    return NextResponse.json(
      { error: "Parking SL not found within 5s — entry may not have filled", steps },
      { status: 502 },
    );
  }
  log("entry confirmed via parking SL", shallowOrder(parkingSl));

  const trailReqBody: Record<string, unknown> = {
    accountId: deployment.accountId,
    contractId: contract.id,
    type: 5,
    side: exitSide,
    size: 1,
    trailPrice: 10,
    customTag: `${tagBase}_t`,
  };

  if (variant === "with-stop-price") {
    const offset = 10;
    const initial = side === 0 ? lastClose - offset : lastClose + offset;
    const rounded = Math.round(initial / contract.tickSize) * contract.tickSize;
    trailReqBody.stopPrice = rounded;
  } else {
    trailReqBody.linkedOrderId = placeRes.orderId;
  }

  let response: unknown = null;
  let trailOrderId: number | null = null;
  try {
    const raw = await fetch("https://api.topstepx.com/api/Order/place", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify(trailReqBody),
    });
    const text = await raw.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { bodyText: text };
    }
    response = { status: raw.status, body: parsed };
    if (parsed && typeof parsed === "object") {
      const obj = parsed as { orderId?: unknown; success?: unknown };
      if (obj.success === true && typeof obj.orderId === "number") {
        trailOrderId = obj.orderId;
      }
    }
  } catch (err) {
    response = { error: err instanceof Error ? err.message : String(err) };
  }
  log(`place standalone TrailingStop (${variant})`, { request: trailReqBody, response });

  const after = await client.searchOpenOrders(deployment.accountId, { forceFresh: true });
  const onContract = after.filter((o) => o.contractId === contract.id).map(shallowOrder);
  log("post-place orders on contract", onContract);

  return NextResponse.json({
    ok: true,
    mode: variant === "with-stop-price" ? "standalone-v2" : "standalone-linked",
    summary: {
      variant,
      trailOrderId,
      placed: trailOrderId !== null,
      verdict:
        trailOrderId !== null
          ? `✓ ${variant} accepted — standalone trail can be placed this way.`
          : `${variant} rejected — see response for error message.`,
      lastClose,
    },
    steps,
  });
}
