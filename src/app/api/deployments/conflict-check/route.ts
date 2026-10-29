import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import {
  filterMainSessionOverlaps,
  findConflictingDeployments,
  findCrossStrategyDeployments,
  sessionForStrategyKey,
} from "@/lib/db/deployments";

/** Deploy-modal calls this to debounce the conflict warnings inline
 *  above the Deploy button. Returns two lists:
 *
 *    - `blocking`: same `(account, ticker, strategy)` triple, main
 *      window overlaps. Deploy must reject.
 *    - `nonBlocking`: same `(account, ticker)` but different strategy,
 *      main window overlaps. Trader-confirmed warning copy on the
 *      consuming side.
 *
 *  Both lists carry `accountId` so the modal can group rows by the
 *  affected account when fanning out across a multi-account picker.
 *
 *  POST so the account list travels in a body rather than a query string.
 *  Server-side check; client computes nothing.
 *
 *  **The candidate window is not in the body.** It is the playbook's
 *  `config.session`, resolved here from `strategyKey`, so a client cannot
 *  ask about a window the engine would not run — which is what a
 *  `paramValues.mainSession` on the wire used to allow.
 */
interface ConflictCheckBody {
  /** Multi-account picker fans out across every selected account. The
   *  server runs the same overlap check per accountId and tags each row
   *  with the originating accountId. */
  accountIds: number[];
  ticker: string;
  strategyKey: string;
  /** Set when editing an existing row (or the legs of an existing
   *  group) so the candidate is not reported as a conflict against
   *  itself. Plural to support group-edit mode where every current leg id
   *  must be excluded. */
  excludeDeploymentIds?: string[];
}

export async function POST(request: NextRequest) {
  const denied = requireSession(request);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const b = body as Partial<ConflictCheckBody>;
  if (
    !Array.isArray(b?.accountIds) ||
    !b.accountIds.every((n) => typeof n === "number") ||
    typeof b?.ticker !== "string" ||
    typeof b?.strategyKey !== "string"
  ) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const candidate = sessionForStrategyKey(b.strategyKey);
  if (!candidate) {
    return NextResponse.json({ blocking: [], nonBlocking: [] });
  }

  const excludeIds = Array.isArray(b.excludeDeploymentIds)
    ? b.excludeDeploymentIds.filter((s): s is string => typeof s === "string")
    : [];
  const excludeSet = new Set(excludeIds);

  const blocking: Array<{
    id: string;
    /** The parent's id. A caller holding the book payload matches it against
     *  a cell's `groupId` to tell a book's own copy from a hand-made one — the
     *  two ask the operator for different moves. */
    groupId: string;
    name: string | null;
    strategyKey: string;
    accountId: number;
    mainSession: unknown;
  }> = [];
  const nonBlocking: typeof blocking = [];

  for (const accountId of b.accountIds) {
    const sameTriple = findConflictingDeployments(accountId, b.ticker, b.strategyKey)
      .filter((d) => !excludeSet.has(d.id));
    const cross = findCrossStrategyDeployments(accountId, b.ticker, b.strategyKey)
      .filter((d) => !excludeSet.has(d.id));

    for (const d of filterMainSessionOverlaps(candidate, sameTriple)) {
      blocking.push({
        id: d.id,
        groupId: d.groupId,
        name: d.name,
        strategyKey: d.strategyKey,
        accountId,
        mainSession: sessionForStrategyKey(d.strategyKey),
      });
    }
    for (const d of filterMainSessionOverlaps(candidate, cross)) {
      nonBlocking.push({
        id: d.id,
        groupId: d.groupId,
        name: d.name,
        strategyKey: d.strategyKey,
        accountId,
        mainSession: sessionForStrategyKey(d.strategyKey),
      });
    }
  }

  return NextResponse.json({ blocking, nonBlocking });
}
