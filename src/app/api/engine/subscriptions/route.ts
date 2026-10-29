import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { engineHandle } from "@/lib/trading/engine/handle/select";

const handle = engineHandle();

/**
 * Incremental subscription updates for the SSE relay. The /stream
 * endpoint subscribes the broadcaster to the contracts open at SSE
 * mount time, but new positions opened *after* the stream is up — most
 * commonly an engine fill on a previously-flat contract — never get
 * market-hub-subscribed and so their trade ticks never reach the browser.
 *
 * Symptom that triggered this route: dashboard "Unrealized" stuck at
 * "—" for an engine-opened position despite the user hub correctly
 * pushing the position itself.
 *
 * Body: { accountIds?: number[], contractIds?: string[] }
 *
 * Idempotent — broadcaster.ensureRunning de-dupes via trackedAccounts /
 * trackedContracts sets, so the client can safely call this on every
 * openContractIds change without worrying about duplicate subscribes.
 *
 * `contractIds` is also the **whole** set the browser holds open, so this
 * route is where the relay's tracking is pruned: a present array retains it
 * and untracks everything else. An absent one means "no claim about
 * contracts" and prunes nothing — this is the only caller that knows the
 * real set, so a caller that does not send it must not be read as sending
 * an empty one.
 */

interface SubscriptionsBody {
  accountIds?: number[];
  contractIds?: string[];
}

export async function POST(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;

  let body: SubscriptionsBody;
  try {
    body = (await req.json()) as SubscriptionsBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const accountIds = Array.isArray(body.accountIds) ? body.accountIds : [];
  const contractIds = Array.isArray(body.contractIds) ? body.contractIds : null;

  // Null is no relay: the engine has no realtime transport to relay from.
  let connected: boolean | null;
  try {
    connected = await handle.getConnectedState();
  } catch (err) {
    return NextResponse.json(
      { error: "Engine unavailable", detail: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }

  if (connected === null) {
    return NextResponse.json(
      { error: "Realtime feed disabled (USE_REALTIME_BARS=false)" },
      { status: 503 },
    );
  }

  try {
    await handle.ensureRunning(accountIds, contractIds ?? []);
    if (contractIds) await handle.retainContractTrades(contractIds);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
