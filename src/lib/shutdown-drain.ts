/**
 * How a SIGTERM'd process decides when to exit: once the clean-shutdown
 * marker is written, it waits for order work in flight — a route's or the
 * engine's — and for nothing else.
 *
 * Next exits once `server.close()` returns, and that waits on every open
 * connection — including a dashboard keep-alive socket the browser goes on
 * reusing, since Node closes idle sockets once, at the `close()` call. So the
 * stop ran to the 30s `docker stop` grace and SIGKILL, and the exit is armed
 * here instead. A bare timer would cut order work mid-way. The per-deployment
 * flatten (and the engine's own exit) cancels the brackets before its market
 * exit, so a cut there leaves a position with no stop until the next
 * process's naked-position sweep; flatten-all closes positions first and
 * cancels second, so a cut there leaves working orders resting on a flat
 * account. An entry cut after `placeOrder` was sent leaves a fill the next
 * process attributes. Before the timer all of it had until SIGKILL at ~30s —
 * Next's cleanup waits for in-flight requests, and SIGTERM never stopped the
 * engine — so every order call runs through `trackOrderRequest`, and the
 * marker hook raises the draining latch so a bar closing inside the drain
 * starts no fresh entry for the exit to cut.
 *
 * The state is on `globalThis` because each route's module graph is not the
 * one `instrumentation.ts` loaded, and `next dev` re-evaluates both.
 */

/** The least time the process waits after the marker before exiting. */
export const SHUTDOWN_DRAIN_MS = 5_000;
/** The exit fires at this point however much order work is still open —
 *  under the 30s `docker stop` grace, so it is our exit and not SIGKILL. */
export const SHUTDOWN_EXIT_CAP_MS = 25_000;
/** 128 + SIGTERM's 15, the code Next's own handler exits with. A hand-off's
 *  yield exits with it too: it is the SIGTERM path with another trigger. */
const SIGTERM_EXIT_CODE = 143;
/** The trigger an engine yielding to a standby runs the stop sequence with,
 *  in place of a signal's name (engine-boot.md, *Hand-off*). */
export const HANDOFF_TRIGGER = "handoff";

interface InFlightOrderRequests {
  count: number;
  onIdle: Array<() => void>;
}
const IN_FLIGHT_KEY = "__crossfireInFlightOrderRequests";
const DRAINING_KEY = "__crossfireShutdownDraining";
type GlobalWithDrain = typeof globalThis & {
  [IN_FLIGHT_KEY]?: InFlightOrderRequests;
  [DRAINING_KEY]?: boolean;
};

function inFlight(): InFlightOrderRequests {
  const g = globalThis as GlobalWithDrain;
  g[IN_FLIGHT_KEY] ??= { count: 0, onIdle: [] };
  return g[IN_FLIGHT_KEY];
}

/** Run order work — a route's or the engine's — so that a SIGTERM's exit waits for it. */
export async function trackOrderRequest<T>(work: () => Promise<T>): Promise<T> {
  const state = inFlight();
  state.count++;
  try {
    return await work();
  } finally {
    state.count--;
    if (state.count === 0) for (const resolve of state.onIdle.splice(0)) resolve();
  }
}

export function orderRequestsInFlight(): number {
  return inFlight().count;
}

/** Raised by the marker hook on a stop signal and never lowered: the process is on its way out. */
export function markShutdownDraining(): void {
  (globalThis as GlobalWithDrain)[DRAINING_KEY] = true;
}

/** True once a stop signal arrived. The engine refuses new entries while it is. */
export function isShutdownDraining(): boolean {
  return (globalThis as GlobalWithDrain)[DRAINING_KEY] === true;
}

function noOrderRequestsInFlight(): Promise<void> {
  const state = inFlight();
  if (state.count === 0) return Promise.resolve();
  return new Promise((resolve) => state.onIdle.push(resolve));
}

/**
 * The after-close hook: on SIGTERM or a hand-off's yield, the drain owns the
 * process's exit. It exits once no order work is in flight and at least
 * `SHUTDOWN_DRAIN_MS` has passed, or at `SHUTDOWN_EXIT_CAP_MS` — and this is
 * the one place either stop exits. `finalFlush` runs just before the exit —
 * the log lines of the work the drain waited for were queued after the close;
 * the store's flush catches its own failures, so it cannot hold the exit. The
 * engine lease is released inside the real exit, by the process's exit
 * listener, so it is the last thing the process does. SIGINT is left alone —
 * `next dev`'s Ctrl-C exits on its own.
 *
 * `process.exit` is held until then (A122): Next's own SIGTERM handler calls
 * `process.exit(143)` as soon as `server.close()` returns, which with no
 * browser connected is milliseconds after the signal, so the drain never got
 * to hold anything. Our signal listener is prepended to Next's and Next's
 * exit follows an await, so the hold is always in place first. A process
 * that runs no engine (`drainsOrderWork` false) has no order work to wait
 * for, and exits on Next's call — `server.close()` returning is its drain.
 * The timers are ref'd: with the exit held, an unref'd timer would let an
 * idle process end on an empty loop, without the drain or the flush.
 */
export function armShutdownExit(signal: string, finalFlush: () => void, drainsOrderWork: boolean): void {
  if (signal !== "SIGTERM" && signal !== HANDOFF_TRIGGER) return;
  const realExit = process.exit;
  let exited = false;
  const exit = () => {
    // The cap and the drain can both reach here; only a stubbed exit returns.
    if (exited) return;
    exited = true;
    clearTimeout(capTimer);
    clearTimeout(drainTimer);
    finalFlush();
    process.exit = realExit;
    realExit(SIGTERM_EXIT_CODE);
  };
  process.exit = (() => {
    if (!drainsOrderWork) exit();
  }) as typeof process.exit;
  const capTimer = setTimeout(exit, SHUTDOWN_EXIT_CAP_MS);
  const drainTimer = setTimeout(() => void noOrderRequestsInFlight().then(exit), SHUTDOWN_DRAIN_MS);
}
