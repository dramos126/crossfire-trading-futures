import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/session";
import { getDeployment } from "@/lib/db/deployments";
import { log } from "@/lib/logger";
import { trackOrderRequest } from "@/lib/shutdown-drain";
import { engineHandle, isEngineRemoteError, isEngineUnreachable } from "@/lib/trading/engine/handle/select";
import type { ForceFlatResult } from "@/lib/trading/engine/flatten/engine-force-flat";

const handle = engineHandle();

// The board's per-deployment flatten. A thin arm over
// `engine.forceFlatDeployment` — every rule it carries is the primitive's
// and none of them is restated here: it bypasses the exit latch and only
// *reports* an in-flight exit, it is never screened by the live-account
// block, and it stamps a typed `ExitReasonCode`. See
// [engine.md](../../../../../../docs/modules/trading/engine.md).
//
// **One response channel, and that is the whole design of this file.** The
// primitive never throws so a caller flattening N deployments keeps the
// other N−1, and its `ForceFlatResult` already distinguishes the two
// outcomes that leave a position open from the two that do not. A route
// that answered 503 for one of them and 200 for the rest would give the
// board a second failure channel to branch on, and the field it is
// supposed to read — `positionMayStillBeOpen` — would not be on both. So
// every reachable outcome answers 200 with a result, including the ones
// this route synthesises.
//
// **That includes a separate engine process that gave no answer or refused
// the call.** In the `web` role the call crosses to the engine process: a
// refused connection or a timeout says nothing about whether the flatten ran
// (a timed-out one may have closed the position), and an answered error — the
// endpoint's no-lease or wrong-role refusal, or a throw on that side — means
// the primitive never answered for it. Both take the one channel: a result
// with `positionMayStillBeOpen`, so the board shows the sentence, and the
// failed-flatten report below. The `all` and `engine` roles never reach it.
//
// **The engine being down is a synthesised `error` result, not a 503.** It
// is the one arm the primitive cannot answer for, and it means exactly what
// `error` means: nothing reached the wire and the position is very likely
// still open. Answering `{ available: false }` the way the preflight does
// would be wrong here for the reason that shape is right there — a
// preflight that cannot answer is not an event, and a close that did not
// happen is.
//
// **And because it is an event, this arm reports it.** Inside the primitive
// every `error` return goes through `failed()`, which emits
// `deployment_flatten_failed` — the one member of the escalation sink's
// `KILL_SWITCH_EXEMPT` set, registered as *"the operator's per-deployment
// flatten never reached the broker."* The arm below is exactly that
// condition and it is the only one that never enters the primitive, so
// without this line it is the sole flatten failure with no durable row, no
// `/logs` entry and no unsilenceable alert: the engine dies at 11:40 with a
// 2-lot open, the operator presses ▼, sees a red line, and the post-mortem
// finds no record that a flatten was ever attempted. Escalation lives in
// the pipe rather than in the engine, so naming the event here reaches the
// exempt sender without adding a `sendUnsilenceableAlert` caller.
//
// **But it is not always the same event, and the row is what decides.**
// `failed()` picks between two reports for exactly this reason and so must
// this arm. The handle finds no engine on a passive-no-creds boot and
// between restarts, so the arm fires for *any* id an authenticated caller
// supplies — and it holds neither an account nor a contract, because there
// was nothing to read one from. Reporting all of them as
// `deployment_flatten_failed` would put *"the position may still be open"*
// on the operator's phone about a position this route never identified, and
// the sender's throttle keys on the deployment id, so N stale board ids are
// N pages the notifications kill-switch is not allowed to mute — noise on
// the one channel that exists for a real open position. `getDeployment` does
// not filter `deleted_at`, so a null row means no row has ever existed under
// that id: a stale board id, not a close that failed. That takes
// `deployment_flatten_no_row` at `warn`, and its line claims no position.
// **An unsilenceable event may not be a bucket** — see
// [logging](../../../../../../docs/modules/logging/README.md).

/** Console/`/logs` tag. Only the `DEBUG_TAGS` gate rides on it — the event
 *  decides severity and category. */
const TAG = "flatten-deployment";

/** What a caller reads when there is no engine to ask and this id names a
 *  real deployment. `positionMayStillBeOpen` is set for the same reason every
 *  other `error` sets it: nothing was submitted, so nothing was closed.
 *
 *  The reason is a lowercase fragment like the primitive's own, because the
 *  surface renders it as the tail of *"Nothing was closed: …"* — a
 *  self-contained sentence here doubles the clause. */
function engineUnavailable(deploymentId: string): ForceFlatResult {
  return {
    deploymentId,
    accountId: null,
    contractId: null,
    status: "error",
    reason: "the trading engine is not running",
    positionMayStillBeOpen: true,
  };
}

const ENGINE_NO_ANSWER_REASON = "no answer from the engine — check the position";
const ENGINE_REFUSED_REASON = "the engine refused the flatten — check the position";

/** What a caller reads when the engine process gave no answer or refused the
 *  call. Not "nothing was closed": a timed-out call may still have run there. */
function engineCallFailed(deploymentId: string, reason: string): ForceFlatResult {
  return {
    deploymentId,
    accountId: null,
    contractId: null,
    status: "error",
    reason,
    positionMayStillBeOpen: true,
  };
}

/** The same arm over an id no row has ever existed for.
 *
 *  **`positionMayStillBeOpen` is omitted**, exactly as the primitive omits it
 *  on `NO_SUCH_ROW` and for its reason: that field is what the surface
 *  renders *instead of* the status string, so setting it would re-tell
 *  through the result the claim the second event exists to stop telling — and
 *  offer a retry against an id that will never resolve. */
function noSuchDeployment(deploymentId: string): ForceFlatResult {
  return {
    deploymentId,
    accountId: null,
    contractId: null,
    status: "error",
    reason: "this database has no deployment with that id, and no trading engine is running",
  };
}

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: RouteContext) {
  const denied = requireSession(request);
  if (denied) return denied;

  const { id } = await ctx.params;
  let result: ForceFlatResult | null;
  try {
    result = await trackOrderRequest(() => handle.forceFlatDeployment(id));
  } catch (err) {
    if (isEngineUnreachable(err)) {
      log.event(
        "deployment_flatten_failed",
        TAG,
        "[FLATTEN] Force flatten got no answer from the trading engine — the position may still be open. Check it at the broker.",
        { deploymentId: id },
      );
      return NextResponse.json({ result: engineCallFailed(id, ENGINE_NO_ANSWER_REASON) });
    }
    if (isEngineRemoteError(err)) {
      log.event(
        "deployment_flatten_failed",
        TAG,
        `[FLATTEN] The trading engine refused the force flatten — the position may still be open. Check it at the broker. (${err.name}: ${err.message})`,
        { deploymentId: id },
      );
      return NextResponse.json({ result: engineCallFailed(id, ENGINE_REFUSED_REASON) });
    }
    throw err;
  }
  if (!result) {
    // Only this arm reads the row: when the engine answers, the primitive
    // has already read it and made the same choice for itself.
    if (getDeployment(id) == null) {
      log.event(
        "deployment_flatten_no_row",
        TAG,
        "[FLATTEN] Force flatten was asked for a deployment this database has no row for — nothing was closed, no position was identified and no broker was reached, so nothing has been left open. There was no trading engine running to ask either.",
        { deploymentId: id },
      );
      return NextResponse.json({ result: noSuchDeployment(id) });
    }
    // Consequence-first, the same shape `REACHED_NO_BROKER` uses inside the
    // primitive: the clause the operator has to act on has to survive the
    // alert title's cap.
    log.event(
      "deployment_flatten_failed",
      TAG,
      "[FLATTEN] Force flatten did not reach the broker — the position may still be open. There was no trading engine running to ask.",
      { deploymentId: id },
    );
    return NextResponse.json({ result: engineUnavailable(id) });
  }

  return NextResponse.json({ result });
}
