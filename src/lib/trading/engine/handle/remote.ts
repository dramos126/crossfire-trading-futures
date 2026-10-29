import type { BroadcastEvent } from "@/lib/realtime/event-broadcaster";
import { parseSseEvents } from "@/lib/realtime/sse";
import { SSE_IDLE_MS } from "@/lib/realtime/sse-heartbeat";
import type {
  StopWhileClosingRefusal,
  WithheldLiveAccount,
  WithheldNotAllowed,
} from "@/lib/trading/broker-access/engine-entry-screens";
import type { EngineHandle } from "@/lib/trading/engine/handle";

/**
 * The engine handle a `web` process uses: every call is a `POST` to the
 * engine process's internal endpoint, and the event stream is one upstream
 * SSE connection fanned out to this process's listeners. The engine side is
 * `src/app/api/internal/engine/`; the wire contract both sides read is here.
 */

// ── The wire contract ────────────────────────────────────────────────────

export const INTERNAL_ENGINE_PATH = "/api/internal/engine";
/** The events stream's segment; no handle method carries this name. */
export const ENGINE_EVENTS_SEGMENT = "events";

/** Every handle method but the event subscription, which is the stream. */
export type EngineCallMethod = Exclude<keyof EngineHandle, "subscribeEvents">;

export interface WireError {
  name: string;
  message: string;
}

/**
 * `start` and `sync` also carry the rows the endpoint's screens withheld, and
 * a stop refused while deployments close carries them — the same lists
 * `/api/engine` answers with.
 */
export type EngineCallAnswer =
  | {
      ok: true;
      result?: unknown;
      skippedLiveAccounts?: WithheldLiveAccount[];
      skippedNotAllowed?: WithheldNotAllowed[];
    }
  | { ok: false; error: WireError; closing?: StopWhileClosingRefusal["closing"] };

const CALL_TIMEOUT_MS = 10_000;
const SLOW_CALL_TIMEOUT_MS = 60_000;

/**
 * How long a web request waits on each call before answering that the engine
 * did not. Ten seconds answers a dead engine promptly; the long ones are the
 * calls whose work is broker round-trips in series — a flatten waiting on its
 * fill, a start or stop over every deployment, a boot, a registry or status
 * sweep over every account — and timing those out at ten seconds would call
 * a slow success unreachable. A timed-out call may still have run.
 */
export const ENGINE_CALL_TIMEOUT_MS: Record<EngineCallMethod, number> = {
  ensureEngine: CALL_TIMEOUT_MS,
  start: SLOW_CALL_TIMEOUT_MS,
  stop: SLOW_CALL_TIMEOUT_MS,
  sync: CALL_TIMEOUT_MS,
  isRunning: CALL_TIMEOUT_MS,
  status: CALL_TIMEOUT_MS,
  reconnectMarketHub: SLOW_CALL_TIMEOUT_MS,
  checkAccountStatuses: SLOW_CALL_TIMEOUT_MS,
  refreshBrokerRegistry: SLOW_CALL_TIMEOUT_MS,
  registeredAccountIds: CALL_TIMEOUT_MS,
  handleOrphanedAccount: SLOW_CALL_TIMEOUT_MS,
  syncIfRunning: CALL_TIMEOUT_MS,
  stopIfRunning: CALL_TIMEOUT_MS,
  nudgeClosingGuard: CALL_TIMEOUT_MS,
  peekLegPosition: CALL_TIMEOUT_MS,
  forceFlatDeployment: SLOW_CALL_TIMEOUT_MS,
  exitsInFlightForAccount: CALL_TIMEOUT_MS,
  previewManualPositionClaim: CALL_TIMEOUT_MS,
  engineSessionId: CALL_TIMEOUT_MS,
  marketDataContractId: CALL_TIMEOUT_MS,
  areHubsReady: CALL_TIMEOUT_MS,
  reloadTradovateClients: CALL_TIMEOUT_MS,
  invalidateAccountNames: CALL_TIMEOUT_MS,
  activateFromSettings: SLOW_CALL_TIMEOUT_MS,
  listTopstepAccounts: CALL_TIMEOUT_MS,
  getLogsByLevel: CALL_TIMEOUT_MS,
  clearAllLogs: CALL_TIMEOUT_MS,
  getBootAssertionState: CALL_TIMEOUT_MS,
  getBootAssertionFailureReason: CALL_TIMEOUT_MS,
  getStagingAllowlist: CALL_TIMEOUT_MS,
  emitDeploymentsChanged: CALL_TIMEOUT_MS,
  emitStrategyTradeClosedIfRunning: CALL_TIMEOUT_MS,
  getConnectedState: CALL_TIMEOUT_MS,
  ensureRunning: CALL_TIMEOUT_MS,
  retainContractTrades: CALL_TIMEOUT_MS,
  readPositions: CALL_TIMEOUT_MS,
  readOrders: CALL_TIMEOUT_MS,
  resolveDatedSymbols: CALL_TIMEOUT_MS,
};

/** No bytes for this long — not even the engine side's heartbeat — and the
 *  upstream stream is taken as dead: a half-open connection never errors. */
export const UPSTREAM_IDLE_MS = SSE_IDLE_MS;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

/** Doubling from one second, capped at thirty. */
export function defaultReconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** attempt);
}

// ── Errors ───────────────────────────────────────────────────────────────

/** The engine process gave no answer: refused, timed out, or answered with
 *  something that is not the endpoint's JSON. Nothing is known about whether
 *  the call ran. */
export class EngineUnreachableError extends Error {
  constructor(
    readonly call: string,
    detail: string,
    options?: { cause?: unknown },
  ) {
    super(`engine process unreachable (${call}): ${detail}`, options);
    this.name = "EngineUnreachableError";
  }
}

/** The engine process answered with an error: the call ran there and threw,
 *  or the endpoint refused it. Carries the thrower's own name and message. */
export class EngineRemoteError extends Error {
  constructor(
    name: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = name;
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWireError(value: unknown): value is WireError {
  if (typeof value !== "object" || value === null) return false;
  const e = value as { name?: unknown; message?: unknown };
  return typeof e.name === "string" && typeof e.message === "string";
}

/** The endpoint's answer, or null for anything that is not one. */
function parseAnswer(text: string): EngineCallAnswer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const answer = parsed as { ok?: unknown; result?: unknown; error?: unknown };
  if (answer.ok === true) return { ok: true, result: answer.result };
  if (answer.ok === false && isWireError(answer.error)) return { ok: false, error: answer.error };
  return null;
}

// ── The handle ───────────────────────────────────────────────────────────

/** The timer the upstream stream's idle watchdog runs on. */
export interface StreamClock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: StreamClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface RemoteEngineOptions {
  fetch?: typeof fetch;
  /** Every call's bound, overriding {@link ENGINE_CALL_TIMEOUT_MS}. */
  callTimeoutMs?: number;
  /** Wait before reconnect attempt `attempt` (0-based) of the event stream. */
  reconnectDelayMs?: (attempt: number) => number;
  clock?: StreamClock;
}

type Listener = (event: BroadcastEvent) => void;

/** Both are refetches on the client, so a spare one costs a read and a missed
 *  one leaves the board on what it showed before the gap. */
const GAP_REFRESH: readonly BroadcastEvent[] = [{ kind: "deploymentsChanged" }, { kind: "setupsChanged" }];

/**
 * The one upstream event stream of this process. Opened by the first
 * subscriber and closed with the last; a drop while anyone listens tells
 * every listener `connected: false` and reconnects with backoff, and the
 * engine side's opening `status` frame says when it is back. The engine
 * side's heartbeat keeps it alive, and its absence for `UPSTREAM_IDLE_MS`
 * is a drop.
 */
class UpstreamEvents {
  private readonly listeners = new Map<string, Listener>();
  private state: "idle" | "connecting" | "open" | "down" = "idle";
  private firstOpen: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  /** Bumped on every close, so a pump or a retry from before it stands down. */
  private generation = 0;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch,
    private readonly reconnectDelayMs: (attempt: number) => number,
    private readonly clock: StreamClock,
    /** Re-sends this process's subscriptions to the engine at a re-open. */
    private readonly replay: () => Promise<void>,
  ) {}

  async subscribe(key: string, listener: Listener): Promise<() => void> {
    this.listeners.set(key, listener);
    const off = () => {
      if (this.listeners.get(key) !== listener) return;
      this.listeners.delete(key);
      if (this.listeners.size === 0) this.close();
    };
    if (this.state === "idle") this.firstOpen = this.openFirst();
    if (this.state === "down") {
      this.deliver(listener, { kind: "status", connected: false, reason: "engine event stream reconnecting" });
    }
    if (this.state === "connecting" && this.firstOpen) {
      // The first connection's failure is this subscribe's rejection, as the
      // engine's build error is the local one's.
      try {
        await this.firstOpen;
      } catch (err) {
        if (this.listeners.get(key) === listener) this.listeners.delete(key);
        throw err;
      }
    }
    return off;
  }

  private async openFirst(): Promise<void> {
    this.state = "connecting";
    const generation = this.generation;
    try {
      const reader = await this.connect();
      if (generation !== this.generation) {
        void reader.cancel();
        return;
      }
      this.opened(reader, generation, false);
    } catch (err) {
      if (generation === this.generation) {
        this.state = "idle";
        this.firstOpen = null;
        this.abort = null;
      }
      throw err;
    }
  }

  private async connect(): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const abort = new AbortController();
    this.abort = abort;
    const url = `${this.url}${INTERNAL_ENGINE_PATH}/${ENGINE_EVENTS_SEGMENT}`;
    // Bounded until the headers arrive, then the idle watchdog takes over: a
    // connect whose headers never come would otherwise hold every listener on
    // a stream that never opens. A timer, not `AbortSignal.timeout` on the
    // request, because that would also end a healthy stream's body at the bound.
    const headersTimer = this.clock.setTimeout(
      () => abort.abort(new DOMException(`no answer within ${CALL_TIMEOUT_MS} ms`, "TimeoutError")),
      CALL_TIMEOUT_MS,
    );
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.secret}`, accept: "text/event-stream" },
        signal: abort.signal,
      });
    } catch (err) {
      throw new EngineUnreachableError(ENGINE_EVENTS_SEGMENT, describe(err), { cause: err });
    } finally {
      this.clock.clearTimeout(headersTimer);
    }
    const isStream = (res.headers.get("content-type") ?? "").startsWith("text/event-stream");
    if (res.ok && isStream && res.body) return res.body.getReader();
    const answer = parseAnswer(await res.text().catch(() => ""));
    if (answer && !answer.ok) throw new EngineRemoteError(answer.error.name, answer.error.message, res.status);
    throw new EngineUnreachableError(ENGINE_EVENTS_SEGMENT, `answered ${res.status} with no event stream`);
  }

  private opened(reader: ReadableStreamDefaultReader<Uint8Array>, generation: number, reopened: boolean): void {
    this.state = "open";
    this.attempt = 0;
    void this.pump(reader, generation, reopened);
  }

  private async pump(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    generation: number,
    reopened: boolean,
  ): Promise<void> {
    const connection = this.abort;
    const decoder = new TextDecoder();
    let buffer = "";
    let reason = "engine event stream ended";
    // Events emitted while the stream was down are gone; after the engine's
    // opening frame the listeners are told to refetch what they show.
    let refreshOwed = reopened;
    let stalled = false;
    let idle: unknown = null;
    const armIdle = () => {
      if (idle !== null) this.clock.clearTimeout(idle);
      idle = this.clock.setTimeout(() => {
        stalled = true;
        connection?.abort();
        reader.cancel().catch(() => {});
      }, UPSTREAM_IDLE_MS);
    };
    armIdle();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation !== this.generation) return;
        armIdle();
        const parsed = parseSseEvents(buffer + decoder.decode(value, { stream: true }));
        buffer = parsed.rest;
        for (const event of parsed.events) {
          this.fanOut(event);
          if (refreshOwed && event.kind === "status") {
            refreshOwed = false;
            for (const refresh of GAP_REFRESH) this.fanOut(refresh);
          }
        }
      }
    } catch (err) {
      reason = `engine event stream dropped: ${describe(err)}`;
    } finally {
      if (idle !== null) this.clock.clearTimeout(idle);
    }
    if (stalled) reason = `engine event stream stalled: no bytes in ${UPSTREAM_IDLE_MS} ms`;
    if (generation === this.generation) this.dropped(reason);
  }

  private dropped(reason: string): void {
    this.state = "down";
    this.fanOut({ kind: "status", connected: false, reason });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const generation = this.generation;
    const delay = this.reconnectDelayMs(this.attempt);
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconnect(generation);
    }, delay);
  }

  private async reconnect(generation: number): Promise<void> {
    if (generation !== this.generation) return;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      reader = await this.connect();
      if (generation !== this.generation) {
        void reader.cancel();
        return;
      }
      // The engine may be a new process whose relay never heard this
      // process's browsers ask for their accounts and contracts, and their
      // own streams never dropped, so they will not ask again. Replayed
      // before the pump delivers the opening `connected: true`.
      await this.replay();
    } catch {
      reader?.cancel().catch(() => {});
      // Listeners were told at the drop; one frame per outage, not per try.
      if (generation === this.generation) {
        this.abort?.abort();
        this.scheduleReconnect();
      }
      return;
    }
    if (generation !== this.generation) {
      void reader.cancel();
      return;
    }
    this.opened(reader, generation, true);
  }

  private fanOut(event: BroadcastEvent): void {
    for (const listener of [...this.listeners.values()]) this.deliver(listener, event);
  }

  private deliver(listener: Listener, event: BroadcastEvent): void {
    try {
      listener(event);
    } catch {
      // One listener's failure is its own; the rest still get the event.
    }
  }

  private close(): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abort?.abort();
    this.abort = null;
    this.firstOpen = null;
    this.state = "idle";
    this.attempt = 0;
  }
}

/**
 * The engine in another process, reached at `baseUrl` with the shared
 * secret. Holds the one upstream event stream and nothing else; every call
 * is one request, never retried — a call that timed out may still have run.
 */
export function remoteEngineHandle(baseUrl: string, secret: string, options: RemoteEngineOptions = {}): EngineHandle {
  const base = baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;

  // Everything this process's browsers asked the relay for. The engine side
  // keeps no per-caller record, so the union is what a new engine is owed.
  const watchedAccounts = new Set<number>();
  const watchedContracts = new Set<string>();
  const retainedTradeContracts = new Set<string>();

  async function replayWatched(): Promise<void> {
    if (watchedAccounts.size > 0 || watchedContracts.size > 0) {
      await call("ensureRunning", [[...watchedAccounts], [...watchedContracts]]);
    }
    if (retainedTradeContracts.size > 0) await call("retainContractTrades", [[...retainedTradeContracts]]);
  }

  const upstream = new UpstreamEvents(
    base,
    secret,
    fetchImpl,
    options.reconnectDelayMs ?? defaultReconnectDelayMs,
    options.clock ?? REAL_CLOCK,
    replayWatched,
  );

  async function call(method: EngineCallMethod, args: unknown[]): Promise<unknown> {
    const timeoutMs = options.callTimeoutMs ?? ENGINE_CALL_TIMEOUT_MS[method];
    let res: Response;
    let text: string;
    try {
      res = await fetchImpl(`${base}${INTERNAL_ENGINE_PATH}/${method}`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify({ args }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      const detail = timedOut ? `no answer within ${timeoutMs} ms` : describe(err);
      throw new EngineUnreachableError(method, detail, { cause: err });
    }
    const answer = parseAnswer(text);
    if (!answer) throw new EngineUnreachableError(method, `answered ${res.status} with no engine answer`);
    if (!answer.ok) throw new EngineRemoteError(answer.error.name, answer.error.message, res.status);
    return answer.result;
  }

  // The one cast: the wire answer is the engine process's own handle's
  // result, typed by the same interface on that side.
  function remote<K extends EngineCallMethod>(method: K): EngineHandle[K] {
    return ((...args: unknown[]) => call(method, args)) as EngineHandle[K];
  }

  return {
    ensureEngine: remote("ensureEngine"),
    start: remote("start"),
    stop: remote("stop"),
    sync: remote("sync"),
    isRunning: remote("isRunning"),
    status: remote("status"),
    reconnectMarketHub: remote("reconnectMarketHub"),
    checkAccountStatuses: remote("checkAccountStatuses"),
    refreshBrokerRegistry: remote("refreshBrokerRegistry"),
    registeredAccountIds: remote("registeredAccountIds"),
    handleOrphanedAccount: remote("handleOrphanedAccount"),

    syncIfRunning: remote("syncIfRunning"),
    stopIfRunning: remote("stopIfRunning"),
    nudgeClosingGuard: remote("nudgeClosingGuard"),
    peekLegPosition: remote("peekLegPosition"),
    forceFlatDeployment: remote("forceFlatDeployment"),
    exitsInFlightForAccount: remote("exitsInFlightForAccount"),
    previewManualPositionClaim: remote("previewManualPositionClaim"),
    engineSessionId: remote("engineSessionId"),
    marketDataContractId: remote("marketDataContractId"),
    areHubsReady: remote("areHubsReady"),
    reloadTradovateClients: remote("reloadTradovateClients"),
    invalidateAccountNames: remote("invalidateAccountNames"),

    activateFromSettings: remote("activateFromSettings"),
    listTopstepAccounts: remote("listTopstepAccounts"),
    getLogsByLevel: remote("getLogsByLevel"),
    clearAllLogs: remote("clearAllLogs"),
    getBootAssertionState: remote("getBootAssertionState"),
    getBootAssertionFailureReason: remote("getBootAssertionFailureReason"),
    getStagingAllowlist: remote("getStagingAllowlist"),

    emitDeploymentsChanged: remote("emitDeploymentsChanged"),
    emitStrategyTradeClosedIfRunning: remote("emitStrategyTradeClosedIfRunning"),
    getConnectedState: remote("getConnectedState"),
    subscribeEvents: (key, listener) => upstream.subscribe(key, listener),
    ensureRunning: (accountIds, contractIds) => {
      for (const id of accountIds) watchedAccounts.add(id);
      for (const id of contractIds) watchedContracts.add(id);
      return remote("ensureRunning")(accountIds, contractIds);
    },
    retainContractTrades: (contractIds) => {
      for (const id of contractIds) retainedTradeContracts.add(id);
      return remote("retainContractTrades")(contractIds);
    },

    readPositions: remote("readPositions"),
    readOrders: remote("readOrders"),
    resolveDatedSymbols: remote("resolveDatedSymbols"),
  };
}
