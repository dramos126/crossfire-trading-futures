import { NextRequest } from "next/server";
import {
  screenBodyDeployments,
  STOP_WHILE_CLOSING_STATUS,
  stopWhileClosingRefusal,
} from "@/lib/trading/broker-access/engine-entry-screens";
import type { Deployment } from "@/lib/trading/domain";
import { holdsLease } from "@/lib/db/lease";
import { EngineNotInThisProcessError } from "@/lib/role";
import { localEngineHandle } from "@/lib/trading/engine/handle/local";
import type { EngineCallAnswer, EngineCallMethod } from "@/lib/trading/engine/handle/remote";
import {
  BAD_REQUEST,
  BODY_TOO_LARGE,
  errorAnswer,
  refuseInternalRequest,
  STOP_WHILE_CLOSING,
  thrownAnswer,
  UNKNOWN_METHOD,
} from "../internal-gate";

const handle = localEngineHandle();

/**
 * `POST /api/internal/engine/<method>` with `{ args: [...] }`: one handle
 * method, run on this process's engine, answered `{ ok: true, result }` or
 * `{ ok: false, error: { name, message } }`. The caller is a `web` process's
 * remote handle; the gate is the shared secret (see `internal-gate.ts`).
 */

// Typed as a record over the interface so a method added to the handle
// fails to compile here until it is listed. `subscribeEvents` is the
// `events` stream, not a call.
const CALLS: Record<EngineCallMethod, true> = {
  ensureEngine: true,
  start: true,
  stop: true,
  sync: true,
  isRunning: true,
  status: true,
  reconnectMarketHub: true,
  checkAccountStatuses: true,
  refreshBrokerRegistry: true,
  registeredAccountIds: true,
  handleOrphanedAccount: true,
  syncIfRunning: true,
  stopIfRunning: true,
  nudgeClosingGuard: true,
  peekLegPosition: true,
  forceFlatDeployment: true,
  exitsInFlightForAccount: true,
  previewManualPositionClaim: true,
  engineSessionId: true,
  marketDataContractId: true,
  areHubsReady: true,
  reloadTradovateClients: true,
  invalidateAccountNames: true,
  activateFromSettings: true,
  listTopstepAccounts: true,
  getLogsByLevel: true,
  clearAllLogs: true,
  getBootAssertionState: true,
  getBootAssertionFailureReason: true,
  getStagingAllowlist: true,
  emitDeploymentsChanged: true,
  emitStrategyTradeClosedIfRunning: true,
  getConnectedState: true,
  ensureRunning: true,
  retainContractTrades: true,
  readPositions: true,
  readOrders: true,
  resolveDatedSymbols: true,
};

/**
 * The calls that can reach a broker's order endpoints from here: the flatten
 * places one, and the nudge runs a closing-guard pass that may. Refused up
 * front without the lease, as 503 — the engine's broker accessor would refuse
 * the order itself, but only after the work around it had run.
 */
const ORDER_REACHING_CALLS: ReadonlySet<EngineCallMethod> = new Set<EngineCallMethod>([
  "forceFlatDeployment",
  "nudgeClosingGuard",
]);

const STATUS_BAD_REQUEST = 400;
const STATUS_NOT_FOUND = 404;
const STATUS_TOO_LARGE = 413;
/** Far above any real call — a full deployment list is a few KiB. */
const MAX_BODY_BYTES = 64 * 1024;

// An own key of the list, so `constructor`, `__proto__` and the rest of the
// prototype never name a method.
function isCall(name: string): name is EngineCallMethod {
  return Object.prototype.hasOwnProperty.call(CALLS, name);
}

type ArgsRead = { args: unknown[] } | { refusal: Response };

async function readArgs(req: NextRequest): Promise<ArgsRead> {
  const tooLarge = { refusal: errorAnswer(STATUS_TOO_LARGE, BODY_TOO_LARGE, `the body is over ${MAX_BODY_BYTES} bytes`) };
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge;
  const badRequest = { refusal: errorAnswer(STATUS_BAD_REQUEST, BAD_REQUEST, "the body must be { args: [...] }") };
  let text: string;
  try {
    text = await req.text();
  } catch {
    return badRequest;
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return tooLarge;
  try {
    const body: unknown = JSON.parse(text);
    const args = typeof body === "object" && body !== null ? (body as { args?: unknown }).args : undefined;
    return Array.isArray(args) ? { args } : badRequest;
  } catch {
    return badRequest;
  }
}

function isDeploymentList(value: unknown): value is Deployment[] {
  return (
    Array.isArray(value) &&
    value.every((d: unknown) => {
      if (typeof d !== "object" || d === null) return false;
      const row = d as { id?: unknown; accountId?: unknown };
      return typeof row.id === "string" && typeof row.accountId === "number";
    })
  );
}

async function run(method: EngineCallMethod, args: unknown[]): Promise<unknown> {
  const call = handle[method] as (...callArgs: unknown[]) => Promise<unknown>;
  return call.apply(handle, args);
}

/**
 * `start` and `sync` carry a caller-supplied deployment list, so this is an
 * engine entry point and gets the same screens as `/api/engine` — the
 * secret is not a licence to trade an account the block refuses.
 */
async function runScreenedList(method: "start" | "sync", args: unknown[]): Promise<Response> {
  const [list] = args;
  if (!isDeploymentList(list)) {
    return errorAnswer(STATUS_BAD_REQUEST, BAD_REQUEST, `${method} takes one deployment list`);
  }
  const screened = screenBodyDeployments(list, await handle.getStagingAllowlist(), method);
  const answer: EngineCallAnswer = {
    ok: true,
    result: await run(method, [screened.deployments]),
    skippedLiveAccounts: screened.skippedLiveAccounts,
    skippedNotAllowed: screened.skippedNotAllowed,
  };
  return Response.json(answer);
}

async function runStop(): Promise<Response> {
  const refusal = stopWhileClosingRefusal();
  if (refusal) {
    const answer: EngineCallAnswer = {
      ok: false,
      error: { name: STOP_WHILE_CLOSING, message: refusal.error },
      closing: refusal.closing,
    };
    return Response.json(answer, { status: STOP_WHILE_CLOSING_STATUS });
  }
  const answer: EngineCallAnswer = { ok: true, result: await run("stop", []) };
  return Response.json(answer);
}

type RouteContext = { params: Promise<{ method: string }> };

export async function POST(req: NextRequest, ctx: RouteContext) {
  const refused = refuseInternalRequest(req);
  if (refused) return refused;

  const { method } = await ctx.params;
  if (!isCall(method)) {
    return errorAnswer(STATUS_NOT_FOUND, UNKNOWN_METHOD, `"${method}" is not an engine handle call`);
  }
  const read = await readArgs(req);
  if ("refusal" in read) return read.refusal;

  try {
    if (ORDER_REACHING_CALLS.has(method) && !holdsLease()) {
      throw new EngineNotInThisProcessError(
        method,
        "this process no longer holds the engine lease, so nothing was sent to the broker — the engine holding it runs these accounts",
      );
    }
    if (method === "start" || method === "sync") return await runScreenedList(method, read.args);
    if (method === "stop") return await runStop();
    const answer: EngineCallAnswer = { ok: true, result: await run(method, read.args) };
    return Response.json(answer);
  } catch (err) {
    return thrownAnswer(err);
  }
}
