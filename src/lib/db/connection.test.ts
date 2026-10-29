/**
 * The shutdown path's pre-close hooks.
 *
 * The only thing under test here is **ordering**: a hook must run while the
 * connection is still open. That is what makes D-13's clean-shutdown marker a
 * structural guarantee rather than a property of import order — see
 * `registerPreCloseHook`.
 *
 * The signal handler is invoked directly rather than by `process.emit`, which
 * under `pool: "forks"` would also reach vitest's own SIGTERM listener and
 * take the worker down with it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), event: vi.fn() },
}));

const originalPath = process.env.TRADING_DB_PATH;
const SHUTDOWN_GLOBAL_KEY = "__crossfireDbShutdown";

/** Every `process` signal registration the module made, across loads. */
let registrations: Array<{ event: string; fn: () => void }> = [];

function spySignalRegistration(): void {
  const record = ((event: string, fn: () => void) => {
    registrations.push({ event, fn });
    return process;
  }) as typeof process.once;
  vi.spyOn(process, "once").mockImplementation(record);
  vi.spyOn(process, "prependOnceListener").mockImplementation(record);
}

async function loadConnection(): Promise<{
  mod: typeof import("./connection");
  fire(signal: string): void;
}> {
  spySignalRegistration();
  const mod = await import("./connection");
  return {
    mod,
    fire: (signal) => {
      const found = registrations.find((r) => r.event === signal);
      if (!found) throw new Error(`no handler registered for ${signal}`);
      found.fn();
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  registrations = [];
  delete (globalThis as Record<string, unknown>)[SHUTDOWN_GLOBAL_KEY];
  process.env.TRADING_DB_PATH = ":memory:";
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalPath === undefined) delete process.env.TRADING_DB_PATH;
  else process.env.TRADING_DB_PATH = originalPath;
});

describe("pre-close hooks", () => {
  it("runs a hook while the connection is still open", async () => {
    const { mod, fire } = await loadConnection();
    let openAtHookTime: boolean | null = null;
    let sawSignal: string | null = null;
    mod.registerPreCloseHook((signal) => {
      sawSignal = signal;
      openAtHookTime = db.open;
    });
    const db = mod.getDb();

    fire("SIGTERM");

    expect(sawSignal).toBe("SIGTERM");
    // The whole point: a hook that runs after `db.close()` cannot write, and
    // the marker it exists to write would silently never land.
    expect(openAtHookTime).toBe(true);
    expect(db.open).toBe(false);
  });

  it("runs every hook, in registration order", async () => {
    const { mod, fire } = await loadConnection();
    const order: number[] = [];
    mod.registerPreCloseHook(() => order.push(1));
    mod.registerPreCloseHook(() => order.push(2));
    mod.getDb();

    fire("SIGTERM");

    expect(order).toEqual([1, 2]);
  });

  it("closes the connection even when a hook throws", async () => {
    const { mod, fire } = await loadConnection();
    mod.registerPreCloseHook(() => {
      throw new Error("marker write failed");
    });
    let secondRan = false;
    mod.registerPreCloseHook(() => {
      secondRan = true;
    });
    const db = mod.getDb();

    fire("SIGTERM");

    expect(secondRan).toBe(true);
    expect(db.open).toBe(false);
  });

  it("registers the hooks on SIGINT too, so a manual stop is not read as a crash", async () => {
    const { mod, fire } = await loadConnection();
    const seen: string[] = [];
    mod.registerPreCloseHook((signal) => seen.push(signal));
    mod.getDb();

    fire("SIGINT");

    expect(seen).toEqual(["SIGINT"]);
  });
});

describe("after-close hooks", () => {
  // The phase that ends the SSE streams and arms the exit bound. Its whole
  // point is that nothing in it can run ahead of the clean-shutdown marker,
  // whichever module registered first.
  it("run after every pre-close hook and after the close, even when registered first", async () => {
    const { mod, fire } = await loadConnection();
    const order: string[] = [];
    let openAtAfterClose: boolean | null = null;
    mod.registerAfterCloseHook(() => {
      order.push("after");
      openAtAfterClose = db.open;
    });
    mod.registerPreCloseHook(() => order.push("marker"));
    const db = mod.getDb();

    fire("SIGTERM");

    expect(order).toEqual(["marker", "after"]);
    expect(openAtAfterClose).toBe(false);
  });

  it("run when no connection was left open to close", async () => {
    const { mod, fire } = await loadConnection();
    const seen: string[] = [];
    mod.registerAfterCloseHook((signal) => seen.push(signal));
    mod.getDb().close();

    fire("SIGTERM");

    expect(seen).toEqual(["SIGTERM"]);
  });

  it("see the closed latch raised, which no pre-close hook does", async () => {
    // The log store's flush checks it so its timer cannot reopen the database.
    const { mod, fire } = await loadConnection();
    let atPreClose: boolean | null = null;
    let atAfterClose: boolean | null = null;
    mod.registerPreCloseHook(() => (atPreClose = mod.isClosedForShutdown()));
    mod.registerAfterCloseHook(() => (atAfterClose = mod.isClosedForShutdown()));
    mod.getDb();
    expect(mod.isClosedForShutdown()).toBe(false);

    fire("SIGTERM");

    expect(atPreClose).toBe(false);
    expect(atAfterClose).toBe(true);
    expect(mod.isClosedForShutdown()).toBe(true);
  });

  it("run every hook when one throws", async () => {
    const { mod, fire } = await loadConnection();
    mod.registerAfterCloseHook(() => {
      throw new Error("stream already gone");
    });
    let secondRan = false;
    mod.registerAfterCloseHook(() => {
      secondRan = true;
    });
    mod.getDb();

    fire("SIGTERM");

    expect(secondRan).toBe(true);
  });
});

describe("the stop sequence without a signal", () => {
  // The engine's hand-off yields through it: the SIGTERM path, with the
  // request as the trigger.
  it("runs the same hooks in the same order, naming the trigger", async () => {
    const { mod } = await loadConnection();
    const order: string[] = [];
    mod.registerAfterCloseHook((trigger) => order.push(`after:${trigger}`));
    mod.registerPreCloseHook((trigger) => order.push(`marker:${trigger}`));
    const db = mod.getDb();

    mod.runShutdownSequence("handoff");

    expect(order).toEqual(["marker:handoff", "after:handoff"]);
    expect(db.open).toBe(false);
    expect(mod.isClosedForShutdown()).toBe(true);
  });

  it("runs once: a signal that arrives during a hand-off's drain finds it run", async () => {
    const { mod, fire } = await loadConnection();
    const seen: string[] = [];
    mod.registerPreCloseHook((trigger) => seen.push(trigger));
    mod.registerAfterCloseHook((trigger) => seen.push(`after:${trigger}`));
    mod.getDb();

    mod.runShutdownSequence("handoff");
    fire("SIGTERM");

    expect(seen).toEqual(["handoff", "after:handoff"]);
  });
});

describe("A51: the close handler runs ahead of a listener bound before it", () => {
  // `next dev` binds a SIGINT handler that exits before ours is registered;
  // Node runs listeners in order, so an appended handler never ran on Ctrl-C.
  it("prepends both signal handlers instead of appending them", async () => {
    const { mod } = await loadConnection();
    mod.getDb();

    expect(process.prependOnceListener).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(process.prependOnceListener).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(process.once).not.toHaveBeenCalled();
  });
});

describe("MaxListenersExceededWarning: a hot reload adds no signal listener", () => {
  async function reload(): Promise<typeof import("./connection")> {
    vi.resetModules();
    vi.restoreAllMocks();
    return (await loadConnection()).mod;
  }

  it("registers SIGTERM and SIGINT once per process, not once per module graph", async () => {
    for (let i = 0; i < 3; i++) (await reload()).getDb();

    expect(registrations.map((r) => r.event).sort()).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("still runs a hook an earlier graph registered, and closes every graph's connection", async () => {
    const first = await reload();
    let openAtHookTime: boolean | null = null;
    const firstDb = first.getDb();
    first.registerPreCloseHook(() => {
      openAtHookTime = firstDb.open;
    });
    const secondDb = (await reload()).getDb();

    registrations.find((r) => r.event === "SIGTERM")!.fn();

    expect(openAtHookTime).toBe(true);
    expect(firstDb.open).toBe(false);
    expect(secondDb.open).toBe(false);
  });
});

describe("two processes on one file", () => {
  const originalRole = process.env.CROSSFIRE_ROLE;

  afterEach(() => {
    vi.useRealTimers();
    if (originalRole === undefined) delete process.env.CROSSFIRE_ROLE;
    else process.env.CROSSFIRE_ROLE = originalRole;
  });

  it("sets a busy timeout on every open, in every role", async () => {
    for (const role of ["all", "web", "engine"]) {
      process.env.CROSSFIRE_ROLE = role;
      vi.resetModules();
      delete (globalThis as Record<string, unknown>)[SHUTDOWN_GLOBAL_KEY];
      const { mod } = await loadConnection();
      expect(mod.getDb().pragma("busy_timeout", { simple: true }), role).toBe(5_000);
    }
  });

  it("migrates in the engine's process, at open and for a module registering late", async () => {
    process.env.CROSSFIRE_ROLE = "engine";
    const { mod } = await loadConnection();
    const atOpen = vi.fn();
    const late = vi.fn();
    mod.registerMigration(atOpen);
    mod.getDb();
    mod.registerMigration(late);

    expect(atOpen).toHaveBeenCalledTimes(1);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("migrates nothing in a web process, at open or late", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    const { mod } = await loadConnection();
    const atOpen = vi.fn();
    const late = vi.fn();
    mod.registerMigration(atOpen);
    mod.getDb();
    mod.registerMigration(late);

    expect(atOpen).not.toHaveBeenCalled();
    expect(late).not.toHaveBeenCalled();
  });

  it("stamps the schema version from the engine's process only", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    const { mod } = await loadConnection();
    mod.markSchemaCurrent();
    expect(mod.getDb().pragma("user_version", { simple: true })).toBe(0);

    process.env.CROSSFIRE_ROLE = "all";
    mod.markSchemaCurrent();
    expect(mod.getDb().pragma("user_version", { simple: true })).toBe(mod.SCHEMA_VERSION);
  });

  it("holds a web process until the engine has migrated, polling", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    const { mod } = await loadConnection();
    const db = mod.getDb();
    vi.useFakeTimers();
    let ready = false;
    const wait = mod.awaitEngineSchema().then(() => {
      ready = true;
    });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(ready).toBe(false);
    // The engine process's stamp, on the shared file.
    db.pragma(`user_version = ${mod.SCHEMA_VERSION}`);
    await vi.advanceTimersByTimeAsync(1_000);
    await wait;
    expect(ready).toBe(true);
  });

  it("gives up after a minute, naming both versions", async () => {
    process.env.CROSSFIRE_ROLE = "web";
    const { mod } = await loadConnection();
    mod.getDb();
    vi.useFakeTimers();
    const wait = mod.awaitEngineSchema();
    const settled = expect(wait).rejects.toThrow(
      `database schema is at version 0 and this build needs ${mod.SCHEMA_VERSION}`,
    );

    await vi.advanceTimersByTimeAsync(61_000);
    await settled;
  });

  it("refuses a role it does not know, naming the three it does", async () => {
    process.env.CROSSFIRE_ROLE = "worker";
    const { mod } = await loadConnection();
    expect(() => mod.getDb()).toThrow("use one of all, web, engine");
    expect(() => mod.getDb()).toThrow("use one of all, web, engine");
  });
});
