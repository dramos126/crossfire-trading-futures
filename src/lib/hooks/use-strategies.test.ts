// @vitest-environment jsdom
/**
 * The deployment store's two ordering rules, driven through the exported
 * `refreshDeployments` and the real `useDeployments`.
 * `use-sse-stream.test.ts` holds the half that says a frame provokes a read;
 * these are the halves that decide *which* read wins, and both live in module
 * scope with no seam above them.
 *
 * Every response is **parked** until the test releases it, and reads and
 * writes are parked separately — both properties are about what happens while
 * a read is in flight, and a stub that resolves on its own turns each of them
 * into an interleaving the test hopes for rather than one it states.
 *
 * The store's coalescing guard, generation counter and `hasHydrated` flag are
 * all module scope, so each test takes a **fresh module registry**. Without it
 * the second test inherits the first one's snapshot and never hydrates, which
 * makes both of them order-dependent. `react` is externalized and keeps its
 * identity across the reset, so the statically imported `act` still drives
 * these mounts.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { useTradingState } from "./use-trading/use-trading-state";
import type { Deployment } from "@/lib/trading/domain";

const DEPLOYMENTS_URL = "/api/deployments?includeTrash=true";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "dep-1",
    strategyKey: "ema-crossover",
    accountId: 5001,
    ticker: "/MNQ",
    contractId: null,
    status: "Active",
    paramValues: { size: 1 },
    createdAt: "2026-09-03T12:00:00.000Z",
    updatedAt: "2026-09-03T12:00:00.000Z",
    orphanedAt: null,
    orphanReason: null,
    deletedAt: null,
    tombstonedAt: null,
    version: 1,
    name: null,
    pendingReconciliation: null,
    groupId: "parent-1",
    enabledSnapshot: null,
    ...overrides,
  };
}

interface Store {
  /** How many list reads have been *issued*, settled or not. */
  reads: () => number;
  /** Responses parked and not yet released. `afterEach` asserts this reaches
   *  zero rather than draining blind, so a test that parks more than the
   *  drain's budget fails loudly instead of leaking into the next mount. */
  inFlight: () => number;
  setList: (rows: Deployment[]) => void;
  setPatched: (row: Deployment) => void;
  flushReads: () => Promise<void>;
  flushWrites: () => Promise<void>;
  refresh: () => Promise<void>;
  snapshot: () => Deployment[];
  update: (id: string, patch: Partial<Deployment>) => Promise<Deployment>;
  /** Answer every later list read with `status` instead of 200. */
  setListStatus: (status: number) => void;
  /** Re-render under a new session, as the provider does after a re-mint. */
  rotateToken: (token: string) => void;
  refreshWith: (token: string) => Promise<void>;
  loadState: () => string;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let store: Store | null = null;

afterEach(async () => {
  if (store) {
    for (let i = 0; i < 5 && store.inFlight() > 0; i++) {
      await store.flushWrites();
      await store.flushReads();
    }
    expect(store.inFlight()).toBe(0);
  }
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  store = null;
  vi.unstubAllGlobals();
});

/** `useDeployments` reads exactly one field off this context — `ctx?.token` —
 *  and the real provider opens a stream and fetches the account catalogue on
 *  mount. `Partial<…>` is what keeps the supplied field honest: rename or
 *  retype `token` and this stops compiling. */
const CONTEXT = { token: "tok" } as Partial<ReturnType<typeof useTradingState>> as ReturnType<
  typeof useTradingState
>;

async function mountStore(): Promise<Store> {
  vi.resetModules();
  const { loadDeployments, refreshDeployments, useDeployments, useDeploymentsLoadState } = await import(
    "./use-strategies"
  );
  const { TradingContext } = await import("./use-trading/use-trading-state");

  const urls: string[] = [];
  const parkedReads: Array<() => void> = [];
  const parkedWrites: Array<() => void> = [];
  let list: Deployment[] = [];
  let patched: Deployment = deployment();
  let listStatus = 200;
  let helpers: ReturnType<typeof useDeployments> | null = null;
  let loadState = "idle";

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string }) => {
      urls.push(url);
      const isWrite = init?.method != null && init.method !== "GET";
      const status = isWrite ? 200 : listStatus;
      return new Promise((resolve) => {
        const release = () =>
          resolve({
            ok: status < 400,
            status,
            statusText: "",
            json: async () => (isWrite ? { deployment: patched } : { deployments: list }),
          });
        (isWrite ? parkedWrites : parkedReads).push(release);
      });
    }),
  );

  function Harness() {
    // Captured during render rather than through an effect: the test needs
    // the mutation helpers before any of its own awaits, and they are stable
    // for the life of the mount.
    helpers = useDeployments();
    loadState = useDeploymentsLoadState();
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (context: typeof CONTEXT) =>
    act(() =>
      root!.render(createElement(TradingContext.Provider, { value: context }, createElement(Harness))),
    );
  render(CONTEXT);

  store = {
    reads: () => urls.filter((u) => u === DEPLOYMENTS_URL).length,
    inFlight: () => parkedReads.length + parkedWrites.length,
    setList: (rows) => {
      list = rows;
    },
    setPatched: (row) => {
      patched = row;
    },
    flushReads: async () => {
      for (const release of parkedReads.splice(0)) release();
      await settle();
    },
    flushWrites: async () => {
      for (const release of parkedWrites.splice(0)) release();
      await settle();
    },
    refresh: () => refreshDeployments("tok"),
    snapshot: () => loadDeployments(),
    update: (id, patch) => helpers!.updateDeployment(id, patch),
    setListStatus: (status) => {
      listStatus = status;
    },
    rotateToken: (token) => render({ ...CONTEXT, token }),
    refreshWith: (token) => refreshDeployments(token),
    loadState: () => loadState,
  };
  return store;
}

/** Each link in read → apply → loop is a microtask, so one flush is not
 *  enough. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("refreshDeployments — hydration is awaited, not raced", () => {
  it("holds its first read until hydration has landed", async () => {
    // `snapshotGeneration` counts writes, not freshness. Run concurrently,
    // hydration's GET is issued strictly earlier and better-sqlite3
    // serialises the reads, so hydration lands first, bumps the counter, and
    // the discard rule throws away the read issued *after* the write the
    // frame announced. That is the permanent-`Pausing` failure the trailing
    // edge exists to prevent, re-entered through the hydration door.
    const s = await mountStore();
    await settle();
    expect(s.reads()).toBe(1);

    const frame = s.refresh();
    await settle();
    expect(s.reads()).toBe(1);

    s.setList([deployment({ status: "Pausing" })]);
    await s.flushReads();
    expect(s.reads()).toBe(2);

    s.setList([deployment({ status: "Paused" })]);
    await s.flushReads();
    await frame;

    expect(s.snapshot().map((d) => d.status)).toEqual(["Paused"]);
  });
});

describe("refreshDeployments — a read that lost a race applies nothing", () => {
  it("keeps the write and drops the list read issued before it", async () => {
    const s = await mountStore();
    await settle();
    s.setList([deployment({ status: "Active" })]);
    await s.flushReads();
    expect(s.snapshot().map((d) => d.status)).toEqual(["Active"]);

    // Issued here and still answering `Active`: it was already on the wire
    // when the pause below was written.
    const frame = s.refresh();
    await settle();

    s.setPatched(deployment({ status: "Paused" }));
    const write = s.update("dep-1", { status: "Paused" });
    await settle();
    await s.flushWrites();
    await write;
    expect(s.snapshot().map((d) => d.status)).toEqual(["Paused"]);

    await s.flushReads();
    await frame;

    // Applying the stale list would retract the operator's own pause, and
    // nothing polls behind this store to correct it.
    expect(s.snapshot().map((d) => d.status)).toEqual(["Paused"]);
  });
});

// A tab whose session is refused stays connected forever: the store's read is
// the one call that reaches a tab after a reset or an expiry, so its status is
// the signal, and a re-minted session must re-read the list it could not.
describe("refreshDeployments — a tab whose session is refused stays connected forever", () => {
  it("rejects a refused read with the status, so a caller can tell 401 from 500", async () => {
    const s = await mountStore();
    await s.flushReads();
    s.setListStatus(401);

    const refused = expect(s.refresh()).rejects.toMatchObject({ status: 401 });
    await settle();
    await s.flushReads();

    await refused;
    expect(s.loadState()).toBe("failed");
  });

  it("re-reads a failed list when the session is re-minted, and keeps the rows until then", async () => {
    const s = await mountStore();
    s.setList([deployment({ status: "Active" })]);
    await s.flushReads();
    s.setListStatus(401);
    const frame = s.refreshWith("tok").catch(() => {});
    await settle();
    await s.flushReads();
    await frame;
    // Not blanked: an expiring session says so through the load state.
    expect(s.snapshot().map((d) => d.status)).toEqual(["Active"]);
    expect(s.reads()).toBe(2);

    s.setListStatus(200);
    s.setList([]);
    s.rotateToken("fresh");
    await settle();
    expect(s.reads()).toBe(3);
    await s.flushReads();

    expect(s.snapshot()).toEqual([]);
    expect(s.loadState()).toBe("ready");
  });
});
