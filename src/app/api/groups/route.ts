import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  insertGroupWithLegs,
  listGroups,
  type InsertGroupInput,
} from "@/lib/db/deployment-groups";
import { listBooksWithPlaybooks } from "@/lib/db/books";
import {
  filterMainSessionOverlaps,
  findConflictingDeployments,
  findCrossStrategyDeployments,
  sessionForStrategyKey,
} from "@/lib/db/deployments";
import {
  crossTimeframeExitRefusalForStrategyKey,
  daySessionRefusalForStrategyKey,
  getStrategy,
  instrumentRefusalForStrategyKey,
} from "@/lib/trading/strategies";
import { validatePauseWindows } from "@/lib/trading/session/session";
import { undeployableInstrumentRefusal, type PauseWindow } from "@/lib/trading/strategy-types";
import { checkDeploymentSettings } from "@/lib/trading/deployment-settings";
import type { Deployment, DeploymentGroup, TickerSymbol } from "@/lib/trading/domain";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  // `books` is each book's own switch and its cells' arming, read-only, for
  // one reader: the Dashboard hides the card of a book that is switched off
  // and the row of a playbook disarmed in it, and a parent row's `enabled`
  // cannot say either — a stood-down row under a book that is *on* may be the
  // armed-but-idle state the operator has to see.
  const books = listBooksWithPlaybooks().map((book) => ({
    id: book.id,
    enabled: book.enabled,
    playbooks: book.playbooks.map((cell) => ({
      ticker: cell.ticker,
      strategyKey: cell.strategyKey,
      armed: cell.armed,
    })),
  }));
  return NextResponse.json({ groups: listGroups(), books });
}

/**
 * Create a deployment group + fan out N legs in a single transaction.
 *
 * Body shape:
 *   { name?, strategyKey, ticker, contractId?, paramValues, enabled,
 *     legs: [{ accountId }, ...] }
 *
 * Conflict checks run per leg against `findConflictingDeployments` +
 * `filterMainSessionOverlaps`. If ANY leg conflicts, the whole group is
 * rejected with a per-account breakdown so the caller can deselect.
 */
export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Partial<InsertGroupInput> & {
    legs?: Array<{ accountId: number }>;
  };

  if (
    typeof input?.strategyKey !== "string" ||
    typeof input?.ticker !== "string" ||
    !input?.paramValues ||
    typeof input.paramValues !== "object" ||
    typeof input?.enabled !== "boolean" ||
    !Array.isArray(input.legs) ||
    input.legs.length === 0
  ) {
    return NextResponse.json({ error: "Invalid group payload" }, { status: 400 });
  }
  if (input.name != null && typeof input.name !== "string") {
    return NextResponse.json({ error: "Invalid group name" }, { status: 400 });
  }
  const settings = checkDeploymentSettings({
    strategyKey: input.strategyKey,
    ticker: input.ticker,
    module: getStrategy(input.strategyKey),
    values: input.paramValues,
  });
  if (!settings.ok) return NextResponse.json({ error: settings.error }, { status: 400 });
  input.paramValues = settings.values;
  const seenAccountIds = new Set<number>();
  for (const leg of input.legs) {
    if (typeof leg.accountId !== "number") {
      return NextResponse.json({ error: "Each leg requires accountId" }, { status: 400 });
    }
    if (seenAccountIds.has(leg.accountId)) {
      // Per-account uniqueness within a group: post-insert two legs
      // sharing (accountId, ticker, strategyKey) would mutually conflict
      // on every subsequent edit, and at runtime the contract lock means
      // only one ever fires entries — silently degraded multi-deploy.
      return NextResponse.json(
        { error: `Duplicate accountId ${leg.accountId} in legs[]` },
        { status: 400 },
      );
    }
    seenAccountIds.add(leg.accountId);
  }

  // Live-account block, per leg. One refused leg refuses the whole group —
  // partial creation would leave the operator with a group that silently
  // omits accounts they selected.
  const refusal = screenAccountsForAutoTrade(input.legs.map((leg) => leg.accountId));
  if (refusal) {
    return NextResponse.json(
      { error: refusal.message, refusedAccounts: refusal.refused },
      { status: 403 },
    );
  }

  // A research-only instrument, once for the parent, on the instrument
  // check's reasoning below.
  const undeployableError = undeployableInstrumentRefusal(input.ticker);
  if (undeployableError) {
    return NextResponse.json({ error: undeployableError }, { status: 400 });
  }

  // Cross-instrument refusal, once for the parent: the instrument is the
  // parent's and every leg trades it. Regardless of `enabled`, because
  // strategy and instrument are pinned at creation — see the deployments
  // route for the whole reasoning.
  const instrumentError = instrumentRefusalForStrategyKey(input.strategyKey, input.ticker);
  if (instrumentError) {
    return NextResponse.json({ error: instrumentError }, { status: 400 });
  }

  // Day-session refusal, once for the parent, same reasoning as the
  // instrument check above: the ticker is the parent's and every leg trades
  // it, pinned at creation regardless of `enabled`.
  const daySessionError = daySessionRefusalForStrategyKey(input.strategyKey, input.ticker);
  if (daySessionError) {
    return NextResponse.json({ error: daySessionError }, { status: 400 });
  }

  // Cross-timeframe exit filter, once for the parent: the params are the
  // parent's and every leg evaluates them. See the deployments route for why
  // an inert-in-backtest, live-on-engine exit filter is refused rather than
  // warned about.
  const crossTimeframeError = crossTimeframeExitRefusalForStrategyKey(
    input.strategyKey,
    input.paramValues,
  );
  if (crossTimeframeError) {
    return NextResponse.json({ error: crossTimeframeError }, { status: 400 });
  }

  // Conflict pre-check, per leg. Report all hits so the caller's deploy
  // modal can render the per-account breakdown without a second roundtrip.
  // Cross-strategy warnings (same account+ticker, different strategy,
  // overlapping main) are non-blocking — collected here and returned on
  // both the conflict-reject and success paths.
  type CrossStrategyWarning = {
    accountId: number;
    conflictId: string;
    conflictName: string | null;
    conflictStrategyKey: string;
  };
  const crossStrategyWarnings: CrossStrategyWarning[] = [];
  if (input.enabled) {
    const candidateMain = sessionForStrategyKey(input.strategyKey);
    if (!candidateMain) {
      return NextResponse.json(
        { error: `Strategy ${input.strategyKey} is not registered, so it declares no session.` },
        { status: 400 },
      );
    }
    const rawPauses = (input.paramValues as Record<string, unknown>).pauseWindows;
    if (rawPauses != null) {
      if (!Array.isArray(rawPauses)) {
        return NextResponse.json({ error: "pauseWindows must be an array" }, { status: 400 });
      }
      const pauseCheck = validatePauseWindows(candidateMain, rawPauses as PauseWindow[]);
      if (!pauseCheck.valid) {
        return NextResponse.json({ error: pauseCheck.error }, { status: 400 });
      }
    }
    const conflicts: Array<{ accountId: number; conflict: Deployment }> = [];
    for (const leg of input.legs) {
      const sameTriple = findConflictingDeployments(
        leg.accountId,
        input.ticker,
        input.strategyKey,
      );
      const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
      if (overlaps.length > 0) {
        conflicts.push({ accountId: leg.accountId, conflict: overlaps[0] });
      }
      const cross = findCrossStrategyDeployments(
        leg.accountId,
        input.ticker,
        input.strategyKey,
      );
      const crossOverlaps = filterMainSessionOverlaps(candidateMain, cross);
      for (const c of crossOverlaps) {
        crossStrategyWarnings.push({
          accountId: leg.accountId,
          conflictId: c.id,
          conflictName: c.name,
          conflictStrategyKey: c.strategyKey,
        });
      }
    }
    if (conflicts.length > 0) {
      return NextResponse.json(
        {
          error: `Cannot create group — ${conflicts.length} of ${input.legs.length} accounts have conflicts.`,
          conflicts: conflicts.map((c) => ({
            accountId: c.accountId,
            conflictId: c.conflict.id,
            conflictName: c.conflict.name,
            conflictStrategyKey: c.conflict.strategyKey,
          })),
          crossStrategyWarnings,
        },
        { status: 409 },
      );
    }
  }

  let created: { group: DeploymentGroup; legs: Deployment[] };
  try {
    created = insertGroupWithLegs(
      {
        name: input.name ?? null,
        strategyKey: input.strategyKey,
        paramValues: input.paramValues,
        ticker: input.ticker as TickerSymbol,
        contractId: input.contractId ?? null,
        enabled: input.enabled,
      },
      input.legs,
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Insert deployment failed" },
      { status: 500 },
    );
  }

  await handle.emitDeploymentsChanged();
  return NextResponse.json({ ...created, crossStrategyWarnings });
}
