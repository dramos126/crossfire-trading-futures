/**
 * `register()`'s two additions for the deploy measurement: the exit a SIGTERM
 * arms once the marker is written — after the drain, held by an order request
 * in flight, capped, with the log queue written once more just before it —
 * and the cold-start marks handed to the boot sequence.
 * Everything `register()` reaches but the drain is mocked; the after-close
 * hook is captured and invoked directly, as `connection.ts` would.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  afterClose: [] as Array<(signal: string) => void>,
  getDb: vi.fn(),
  runBootSequence: vi.fn(async () => ({ kind: "no-deployments" })),
  runStandbyBoot: vi.fn(async () => ({ kind: "started", deploymentCount: 1 })),
  takeEngineLease: vi.fn(async (): Promise<string | null> => null),
  configured: [] as Array<{ id: string; isConfigured: () => boolean }>,
  flushBeforeExit: vi.fn(),
  startEngineLogStore: vi.fn(),
  startEngineLogFlush: vi.fn(),
  markSchemaCurrent: vi.fn(),
  awaitEngineSchema: vi.fn(async () => {}),
  logEvent: vi.fn(),
  markBootAssertionFailed: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: h.getDb,
  markSchemaCurrent: h.markSchemaCurrent,
  awaitEngineSchema: h.awaitEngineSchema,
  registerAfterCloseHook: (fn: (signal: string) => void) => {
    h.afterClose.push(fn);
  },
}));
vi.mock("@/lib/db/engine-logs", () => ({
  flushBeforeExit: h.flushBeforeExit,
  startEngineLogStore: h.startEngineLogStore,
  startEngineLogFlush: h.startEngineLogFlush,
}));
vi.mock("@/lib/logger", () => ({ log: { event: h.logEvent } }));
vi.mock("@/lib/trading/engine/boot/boot-assertion", () => ({
  markBootAssertionFailed: h.markBootAssertionFailed,
}));
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { allPlugins: () => h.configured },
}));
vi.mock("@/lib/trading/engine/boot/boot-engine", () => ({
  runBootSequence: h.runBootSequence,
  runStandbyBoot: h.runStandbyBoot,
  takeEngineLease: h.takeEngineLease,
}));
// The env→DB promotion's reads, answered as an install already promoted.
vi.mock("@/lib/db/settings", () => ({
  getSetupSignature: vi.fn(() => "sig"),
  setSetupSignature: vi.fn(),
  setSetupConfirmedAt: vi.fn(),
  getSetupConfirmedAt: vi.fn(() => "2026-01-01T00:00:00Z"),
  getTopstepApiKey: vi.fn(() => "key"),
  getTopstepUsername: vi.fn(() => "user"),
  getTopstepWebhookUrl: vi.fn(() => null),
  setTopstepApiKey: vi.fn(),
  setTopstepUsername: vi.fn(),
}));
vi.mock("@/lib/db/settings-cache", () => ({ invalidateSettingsCache: vi.fn() }));

import { register } from "./instrumentation";
import { orderRequestsInFlight, trackOrderRequest } from "@/lib/shutdown-drain";

const originalRuntime = process.env.NEXT_RUNTIME;
const IN_FLIGHT_KEY = "__crossfireInFlightOrderRequests";

beforeEach(() => {
  delete (globalThis as Record<string, unknown>)[IN_FLIGHT_KEY];
  // Timers only: the cold-start marks read the real `performance.now()`.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  h.afterClose.length = 0;
  h.configured = [];
  h.runBootSequence.mockClear();
  h.runStandbyBoot.mockClear();
  h.takeEngineLease.mockClear();
  h.flushBeforeExit.mockReset();
  process.env.NEXT_RUNTIME = "nodejs";
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
  else process.env.NEXT_RUNTIME = originalRuntime;
});

function spyExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
}

describe("the SIGTERM exit bound", () => {
  it("exits 143 five seconds after the after-close phase when no order request is in flight", async () => {
    await register();
    const exit = spyExit();
    expect(h.afterClose).toHaveLength(1);
    expect(orderRequestsInFlight()).toBe(0);

    h.afterClose[0]("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("waits past the drain for an order request in flight, and exits when it finishes", async () => {
    // Flatten-all cut between its bracket cancel and its market exit leaves a
    // position with no stop; before the bound it had until SIGKILL.
    await register();
    const exit = spyExit();
    let finishFlatten!: () => void;
    const flatten = trackOrderRequest(() => new Promise<void>((r) => (finishFlatten = r)));

    h.afterClose[0]("SIGTERM");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(exit).not.toHaveBeenCalled();

    finishFlatten();
    await flatten;
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("still exits at the 25s cap when an order request never finishes", async () => {
    await register();
    const exit = spyExit();
    void trackOrderRequest(() => new Promise<void>(() => {}));
    expect(orderRequestsInFlight()).toBe(1);

    h.afterClose[0]("SIGTERM");
    await vi.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("writes the log queue once more just before the exit — the lines of the work the drain waited for", async () => {
    // Queued after the close, which latches the store's own flush.
    await register();
    const order: string[] = [];
    h.flushBeforeExit.mockImplementation(() => order.push("flush"));
    const exit = spyExit().mockImplementation(((code: number) => {
      order.push(`exit ${code}`);
    }) as typeof process.exit);

    h.afterClose[0]("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(exit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush", "exit 143"]);
  });

  it("is armed the same way by a hand-off's yield, which runs the SIGTERM path with its own trigger", async () => {
    await register();
    const exit = spyExit();

    h.afterClose[0]("handoff");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("is not armed by SIGINT — `next dev`'s Ctrl-C exits on its own", async () => {
    await register();
    const exit = spyExit();

    h.afterClose[0]("SIGINT");
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits once only, through the same exit, when a hand-off's yield drains", async () => {
    await register();
    const order: string[] = [];
    h.flushBeforeExit.mockImplementation(() => order.push("flush"));
    const exit = spyExit().mockImplementation(((code: number) => {
      order.push(`exit ${code}`);
    }) as typeof process.exit);

    h.afterClose[0]("handoff");
    await vi.advanceTimersByTimeAsync(60_000);

    expect(order).toEqual(["flush", "exit 143"]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("is armed on an install with no broker configured too", async () => {
    // The passive-no-creds return comes before any boot; the dashboard's
    // streams still hold `server.close()` there.
    await register();
    expect(h.runBootSequence).not.toHaveBeenCalled();
    expect(h.afterClose).toHaveLength(1);
  });
});

describe("Next's own SIGTERM exit (A122)", () => {
  // Next's handler calls `process.exit(143)` as soon as `server.close()`
  // returns — milliseconds after the signal with no browser connected — so
  // the drain held nothing and an order in flight got about a second.
  const originalRole = process.env.CROSSFIRE_ROLE;
  const NEXT_SIGTERM_EXIT = 143;

  afterEach(() => {
    if (originalRole === undefined) delete process.env.CROSSFIRE_ROLE;
    else process.env.CROSSFIRE_ROLE = originalRole;
  });

  /** What Next's handler does once `server.close()` has returned. */
  function nextExits(): void {
    process.exit(NEXT_SIGTERM_EXIT);
  }

  it("is held while an order is in flight with no connection open, and the drain exits once it settles", async () => {
    await register();
    const order: string[] = [];
    h.flushBeforeExit.mockImplementation(() => order.push("flush"));
    const exit = spyExit().mockImplementation(((code: number) => {
      order.push(`exit ${code}`);
    }) as typeof process.exit);
    let finishExit!: () => void;
    const engineExit = trackOrderRequest(() => new Promise<void>((r) => (finishExit = r)));

    h.afterClose[0]("SIGTERM");
    nextExits();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(exit).not.toHaveBeenCalled();

    finishExit();
    await engineExit;
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["flush", "exit 143"]);
  });

  it("is held to the 25s cap when the order never settles, and the cap exits once", async () => {
    await register();
    const exit = spyExit();
    void trackOrderRequest(() => new Promise<void>(() => {}));

    h.afterClose[0]("SIGTERM");
    nextExits();
    await vi.advanceTimersByTimeAsync(24_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it.each(["all", "engine"])("is held to the drain minimum in the %s role with nothing in flight", async (role) => {
    process.env.CROSSFIRE_ROLE = role;
    await register();
    const exit = spyExit();

    h.afterClose[0]("SIGTERM");
    nextExits();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(143);
  });

  it("exits at once in the web role, which runs no order work, with the flush first", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    await register();
    const order: string[] = [];
    h.flushBeforeExit.mockImplementation(() => order.push("flush"));
    const exit = spyExit().mockImplementation(((code: number) => {
      order.push(`exit ${code}`);
    }) as typeof process.exit);

    h.afterClose[0]("SIGTERM");
    nextExits();
    expect(order).toEqual(["flush", "exit 143"]);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("gives the real process.exit back at the drain's exit, so a later call is honoured", async () => {
    await register();
    const exit = spyExit();

    h.afterClose[0]("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(exit).toHaveBeenCalledWith(143);

    expect(process.exit).toBe(exit);
    process.exit(1);
    expect(exit).toHaveBeenLastCalledWith(1);
  });
});

describe("the cold-start marks", () => {
  it("hands the boot sequence when register() was entered and when the database opened", async () => {
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.getDb).toHaveBeenCalled();
    expect(h.runBootSequence).toHaveBeenCalledTimes(1);
    const opts = (h.runBootSequence.mock.calls[0] as unknown[])[0] as {
      processMarks: { registerEnteredMs: number; dbOpenMs: number };
    };
    expect(opts.processMarks.registerEnteredMs).toBeGreaterThan(0);
    expect(opts.processMarks.dbOpenMs).toBeGreaterThanOrEqual(opts.processMarks.registerEnteredMs);
  });
});

describe("the process role", () => {
  const originalRole = process.env.CROSSFIRE_ROLE;

  const originalSecret = process.env.CROSSFIRE_INTERNAL_SECRET;

  beforeEach(() => {
    h.markSchemaCurrent.mockClear();
    h.awaitEngineSchema.mockClear();
    h.startEngineLogStore.mockClear();
    h.startEngineLogFlush.mockClear();
    h.logEvent.mockClear();
    h.markBootAssertionFailed.mockClear();
  });

  afterEach(() => {
    if (originalRole === undefined) delete process.env.CROSSFIRE_ROLE;
    else process.env.CROSSFIRE_ROLE = originalRole;
    if (originalSecret === undefined) delete process.env.CROSSFIRE_INTERNAL_SECRET;
    else process.env.CROSSFIRE_INTERNAL_SECRET = originalSecret;
  });

  it.each([
    ["no secret", undefined],
    ["a whitespace secret", "   "],
    ["a short secret", "s3cret"],
  ])("refuses to boot in the engine role with %s, loudly, before the lease", async (_label, secret) => {
    process.env.CROSSFIRE_ROLE = "engine";
    if (secret === undefined) delete process.env.CROSSFIRE_INTERNAL_SECRET;
    else process.env.CROSSFIRE_INTERNAL_SECRET = secret;
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.takeEngineLease).not.toHaveBeenCalled();
    expect(h.runBootSequence).not.toHaveBeenCalled();
    expect(h.markBootAssertionFailed).toHaveBeenCalledWith(expect.stringContaining("CROSSFIRE_INTERNAL_SECRET"));
    expect(h.logEvent).toHaveBeenCalledWith(
      "boot_refused",
      "engine",
      expect.stringContaining("CROSSFIRE_INTERNAL_SECRET"),
    );
  });

  it("boots in the engine role with a secret of 32 characters or more", async () => {
    process.env.CROSSFIRE_ROLE = "engine";
    process.env.CROSSFIRE_INTERNAL_SECRET = "a".repeat(32);
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.runBootSequence).toHaveBeenCalledTimes(1);
    expect(h.markBootAssertionFailed).not.toHaveBeenCalled();
  });

  it("does not ask the all role for a secret", async () => {
    delete process.env.CROSSFIRE_INTERNAL_SECRET;
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();
    expect(h.runBootSequence).toHaveBeenCalledTimes(1);
  });

  it("stamps the schema once the boot graph has loaded, and boots, in the default role", async () => {
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.markSchemaCurrent).toHaveBeenCalledTimes(1);
    expect(h.awaitEngineSchema).not.toHaveBeenCalled();
    expect(h.runBootSequence).toHaveBeenCalledTimes(1);
  });

  it("waits for the engine's schema and boots nothing in the web role, with the exit still armed", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.awaitEngineSchema).toHaveBeenCalledTimes(1);
    expect(h.markSchemaCurrent).not.toHaveBeenCalled();
    expect(h.runBootSequence).not.toHaveBeenCalled();
    expect(h.takeEngineLease).not.toHaveBeenCalled();
    expect(h.afterClose).toHaveLength(1);
  });

  it("starts the log flush alone in the web role, after the schema wait, so its own lines are written", async () => {
    // No engine is ever built there, and building one is what starts the
    // store in the other roles. The retention sweep stays the engine's.
    process.env.CROSSFIRE_ROLE = "web";
    const order: string[] = [];
    h.awaitEngineSchema.mockImplementationOnce(async () => {
      order.push("schema");
    });
    h.startEngineLogFlush.mockImplementationOnce(() => order.push("log flush"));
    await register();

    expect(order).toEqual(["schema", "log flush"]);
    expect(h.startEngineLogStore).not.toHaveBeenCalled();
  });

  it("leaves the log store to the engine build in the default role", async () => {
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();
    expect(h.startEngineLogStore).not.toHaveBeenCalled();
    expect(h.startEngineLogFlush).not.toHaveBeenCalled();
  });
});

describe("a standby engine process", () => {
  const originalRole = process.env.CROSSFIRE_ROLE;
  const originalSecret = process.env.CROSSFIRE_INTERNAL_SECRET;
  const originalStandby = process.env.CROSSFIRE_STANDBY;

  beforeEach(() => {
    h.logEvent.mockClear();
    h.markBootAssertionFailed.mockClear();
    process.env.CROSSFIRE_INTERNAL_SECRET = "a".repeat(32);
    process.env.CROSSFIRE_STANDBY = "1";
  });

  afterEach(() => {
    for (const [key, value] of [
      ["CROSSFIRE_ROLE", originalRole],
      ["CROSSFIRE_INTERNAL_SECRET", originalSecret],
      ["CROSSFIRE_STANDBY", originalStandby],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("boots through the standby sequence, never the ordinary one", async () => {
    process.env.CROSSFIRE_ROLE = "engine";
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();

    expect(h.runStandbyBoot).toHaveBeenCalledTimes(1);
    expect(h.runBootSequence).not.toHaveBeenCalled();
    expect(h.takeEngineLease).not.toHaveBeenCalled();
  });

  it.each([
    ["the all role", "all", true, "CROSSFIRE_ROLE=engine"],
    ["no broker configured", "engine", false, "no broker configured"],
  ])("is refused on %s, and takes nothing", async (_label, role, configured, reason) => {
    process.env.CROSSFIRE_ROLE = role;
    h.configured = [{ id: "topstep", isConfigured: () => configured }];
    await register();

    expect(h.runStandbyBoot).not.toHaveBeenCalled();
    expect(h.runBootSequence).not.toHaveBeenCalled();
    expect(h.takeEngineLease).not.toHaveBeenCalled();
    expect(h.markBootAssertionFailed).toHaveBeenCalledWith(expect.stringContaining(reason));
    expect(h.logEvent).toHaveBeenCalledWith("boot_refused", "engine", expect.stringContaining(reason));
  });
});

describe("the engine lease on an install with no broker configured", () => {
  // Nothing boots until the wizard, yet the dashboard's routes reach
  // `getEngine()`, which builds nothing without the lease. Boot takes it on
  // a configured install, so register() takes it only here.
  it("is taken before the passive-no-creds return", async () => {
    await register();
    expect(h.takeEngineLease).toHaveBeenCalledTimes(1);
    expect(h.runBootSequence).not.toHaveBeenCalled();
  });

  it("is left to the boot sequence on a configured install", async () => {
    h.configured = [{ id: "topstep", isConfigured: () => true }];
    await register();
    expect(h.takeEngineLease).not.toHaveBeenCalled();
    expect(h.runBootSequence).toHaveBeenCalledTimes(1);
  });
});
