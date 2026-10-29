import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  listDeletedDeployments,
  listDeployments,
  findConflictingDeployments,
  filterMainSessionOverlaps,
  sessionForStrategyKey,
  type InsertDeploymentInput,
} from "@/lib/db/deployments";
import { insertGroupWithLegs } from "@/lib/db/deployment-groups";
import {
  crossTimeframeExitRefusalForStrategyKey,
  daySessionRefusalForStrategyKey,
  getStrategy,
  instrumentRefusalForStrategyKey,
} from "@/lib/trading/strategies";
import { screenAccountsForAutoTrade } from "@/lib/db/account-brokers";
import { engineHandle } from "@/lib/trading/engine/handle/select";
import { isOperatorDeploymentStatus } from "@/lib/trading/domain";
import { validatePauseWindows } from "@/lib/trading/session/session";
import { undeployableInstrumentRefusal, type PauseWindow } from "@/lib/trading/strategy-types";
import { checkDeploymentSettings } from "@/lib/trading/deployment-settings";

const handle = engineHandle();

// Gated on both reads and writes: the engine's auto-start picks up any
// enabled deployment on the next process boot, so a rogue insert here
// would persist across restarts.
export async function GET(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  try {
    // Pass `?includeTrash=true` to get the union of active + trashed
    // deployments. The deployments page does this so the local
    // useDeployments cache covers both tabs without a second fetch.
    const url = new URL(request.url);
    const includeTrash = url.searchParams.get("includeTrash") === "true";
    const deployments = includeTrash
      ? [...listDeployments(), ...listDeletedDeployments()]
      : listDeployments();
    return NextResponse.json({ deployments });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list deployments" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const input = body as Partial<InsertDeploymentInput>;
  if (
    typeof input?.strategyKey !== "string" ||
    typeof input?.accountId !== "number" ||
    typeof input?.ticker !== "string" ||
    !isOperatorDeploymentStatus(input?.status) ||
    !input?.paramValues ||
    typeof input.paramValues !== "object"
  ) {
    return NextResponse.json({ error: "Invalid deployment payload" }, { status: 400 });
  }
  if (input.name != null && typeof input.name !== "string") {
    return NextResponse.json({ error: "Invalid deployment name" }, { status: 400 });
  }
  const settings = checkDeploymentSettings({
    strategyKey: input.strategyKey,
    ticker: input.ticker,
    module: getStrategy(input.strategyKey),
    values: input.paramValues,
  });
  if (!settings.ok) return NextResponse.json({ error: settings.error }, { status: 400 });
  input.paramValues = settings.values;

  // Topstep TOS bars automated trading on live (funded) accounts. 403, not
  // 400 — the payload is well-formed and the operator is not permitted to
  // do this, which is what the HTTP status means. Checked before the
  // deployment's own status, because a paused row on a live account is a
  // row somebody activates later.
  const refusal = screenAccountsForAutoTrade([input.accountId]);
  if (refusal) return NextResponse.json({ error: refusal.message }, { status: 403 });

  // An instrument on file for research only is refused for every playbook,
  // regardless of `status`, for the instrument check's reason below.
  const undeployableError = undeployableInstrumentRefusal(input.ticker);
  if (undeployableError) {
    return NextResponse.json({ error: undeployableError }, { status: 400 });
  }

  // A playbook that declares the instrument it was calibrated for is refused on
  // every other one. Checked regardless of `status`, and for the same reason
  // the live-account block above is: strategy and instrument are pinned at
  // creation, so a Paused row on the wrong instrument is a row somebody
  // activates later and cannot then repoint. 400 rather than 403 — this is not
  // a permission, it is a combination that does not exist.
  const instrumentError = instrumentRefusalForStrategyKey(input.strategyKey, input.ticker);
  if (instrumentError) {
    return NextResponse.json({ error: instrumentError }, { status: 400 });
  }

  // A strategy whose hooks need the instrument's day-session window is
  // refused on a ticker with no CONTRACT_SPECS row, same reasoning and same
  // timing as the instrument check above: the ticker is pinned at creation,
  // so a Paused row on one with no cash session is a row somebody activates
  // later and the engine refuses at that point instead.
  const daySessionError = daySessionRefusalForStrategyKey(input.strategyKey, input.ticker);
  if (daySessionError) {
    return NextResponse.json({ error: daySessionError }, { status: 400 });
  }

  // An exit filter set to a timeframe only the engine fetches bars for is
  // inert in every backtest and live on every tick, so the deployment would
  // trade an exit nothing has measured. Checked regardless of `status` for the
  // same reason as the two above, and here rather than only at activation so
  // the operator meets it while the form that sets it is still open.
  const crossTimeframeError = crossTimeframeExitRefusalForStrategyKey(
    input.strategyKey,
    input.paramValues,
  );
  if (crossTimeframeError) {
    return NextResponse.json({ error: crossTimeframeError }, { status: 400 });
  }

  if (input.status === "Active") {
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
    const sameTriple = findConflictingDeployments(
      input.accountId,
      input.ticker,
      input.strategyKey,
    );
    const overlaps = filterMainSessionOverlaps(candidateMain, sameTriple);
    if (overlaps.length > 0) {
      const c = overlaps[0];
      return NextResponse.json(
        {
          error:
            `Main session overlaps an existing active deployment of ${input.strategyKey} ` +
            `on ${input.ticker}.`,
          conflictId: c.id,
          conflictName: c.name,
        },
        { status: 409 },
      );
    }
  }

  try {
    // One shape: a single-account deployment is a parent with one leg.
    // The two rows land in one transaction — a parent with no leg is a
    // shell nothing can add to, and a leg with no parent cannot resolve a
    // size.
    const { group, legs } = insertGroupWithLegs(
      {
        name: input.name ?? null,
        strategyKey: input.strategyKey,
        paramValues: input.paramValues,
        ticker: input.ticker,
        contractId: input.contractId ?? null,
        enabled: input.status === "Active",
      },
      [{ accountId: input.accountId }],
    );
    await handle.emitDeploymentsChanged();
    return NextResponse.json({ deployment: legs[0], group });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Insert failed" },
      { status: 500 },
    );
  }
}
