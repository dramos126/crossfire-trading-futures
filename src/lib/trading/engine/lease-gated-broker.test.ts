/**
 * The engine's order gate: `brokerForAccount` hands back the broker with its
 * three order calls refused once this process no longer holds the engine
 * lease. Real `lease.ts` on an in-memory database (the `lease.test.ts`
 * pattern) and the real `placeExitOrder`, so the scenario is the one the gate
 * exists for: an exit chain that awaited a position read while another
 * process took the stale lease, then reached its market order.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

let db: InstanceType<typeof Database>;
const { migrations, logEvent } = vi.hoisted(() => ({
  migrations: [] as Array<(d: InstanceType<typeof Database>) => void>,
  logEvent: vi.fn(),
}));

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => db),
  registerMigration: vi.fn((fn: (d: InstanceType<typeof Database>) => void) => {
    migrations.push(fn);
  }),
}));
vi.mock("@/lib/logger", () => ({ log: { event: logEvent } }));
vi.mock("@/lib/db/trades", () => ({
  attachPendingExit: vi.fn(),
  getOpenTradeForDeployment: vi.fn().mockReturnValue(null),
}));
vi.mock("@/lib/trading/strategies", () => ({ getStrategy: vi.fn().mockReturnValue(undefined) }));

import { leaseGate, leaseHolderId, tryAcquireLease, LEASE_FRESH_MS } from "@/lib/db/lease";
import type { Broker } from "@/lib/trading/broker-access/broker";
import type { Contract, Position } from "@/lib/brokers/types";
import type { Deployment } from "@/lib/trading/domain";
import type { DeploymentState } from "./engine";
import type { StrategyModule } from "../strategy-types";
import { placeExitOrder, type ExitOrderDeps } from "./engine-exit";
import { leaseGatedBroker, LeaseLostError } from "./lease-gated-broker";

const ACCOUNT = 1001;
const CONTRACT_ID = "CON.F.US.MNQ.M26";
const OTHER = "standby-host:9:beef";

const contract: Contract = {
  id: CONTRACT_ID,
  name: "MNQM6",
  description: "Micro E-mini Nasdaq 100 June 2026",
  activeContract: true,
  symbolId: "/MNQ",
  tickSize: 0.25,
  tickValue: 1.25,
};

const deployment = {
  id: "deploy-aaa",
  strategyKey: "test",
  accountId: ACCOUNT,
  ticker: "/MNQ",
  contractId: CONTRACT_ID,
  status: "Active",
  paramValues: {},
} as unknown as Deployment;

const longOne = {
  id: 1,
  accountId: ACCOUNT,
  contractId: CONTRACT_ID,
  size: 1,
  type: 1,
  averagePrice: 20000,
  creationTimestamp: "",
} as Position;

function fakeBroker(onPositionRead: () => void = () => {}) {
  const calls = {
    placeOrder: vi.fn(async () => ({ orderId: 9001, success: true, errorCode: 0, errorMessage: null })),
    cancelOrder: vi.fn(async () => undefined),
    modifyOrder: vi.fn(async () => undefined),
    searchOpenPositions: vi.fn(async () => {
      onPositionRead();
      return [longOne];
    }),
  };
  const broker = {
    ...calls,
    searchOpenOrders: vi.fn(async () => []),
    searchTrades: vi.fn(async () => []),
    getFillsForOrder: vi.fn(async () => []),
    searchAccounts: vi.fn(async () => []),
    searchContracts: vi.fn(async () => []),
    invalidateOpenOrders: vi.fn(),
  } satisfies Broker;
  return { broker, calls };
}

function exitDeps(broker: Broker, mayOrder: () => boolean): ExitOrderDeps & { logEvent: ReturnType<typeof vi.fn> } {
  const states = new Map<string, DeploymentState>();
  const engineLogEvent = vi.fn();
  return {
    brokerFor: (d) => leaseGatedBroker(broker, d.accountId, mayOrder),
    getState: (id) => {
      if (!states.has(id)) states.set(id, { position: null, exitInFlight: false } as DeploymentState);
      return states.get(id) as DeploymentState;
    },
    log: vi.fn(),
    logEvent: engineLogEvent,
    maybeOrphanFromBrokerError: vi.fn(),
    resolveContract: vi.fn(async () => contract),
    notifyForceClose: vi.fn(async () => undefined),
    buildCustomTag: vi.fn(() => "x_deployaaa_abc1"),
    stateMap: states,
  };
}

const strategy = { shouldExit: () => false } as unknown as StrategyModule;
const position = { side: 0, entryPrice: 20000, entryTimestamp: "", barsSinceEntry: 1, size: 1 } as Parameters<
  typeof placeExitOrder
>[4];

function refusals(): unknown[][] {
  return logEvent.mock.calls.filter((c) => c[0] === "engine_lease_refused");
}

beforeEach(() => {
  db = new Database(":memory:");
  for (const fn of migrations) fn(db);
  logEvent.mockClear();
});

describe("an exit after another process took the stale lease", () => {
  it("is refused at the wire, sends nothing, and the loss is said once", async () => {
    const T0 = Date.now();
    tryAcquireLease(leaseHolderId(), T0 - LEASE_FRESH_MS - 1);
    // The freeze: while the exit awaited its position read, the standby
    // found the lease stale and took it.
    const { broker, calls } = fakeBroker(() => tryAcquireLease(OTHER, T0));
    const mayOrder = leaseGate("an order call", "The engine holding it manages these positions.");
    const deps = exitDeps(broker, mayOrder);

    await expect(
      placeExitOrder(deps, strategy, deployment, contract, position, null, "test_reason"),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(calls.searchOpenPositions).toHaveBeenCalled();
    expect(calls.placeOrder).not.toHaveBeenCalled();
    expect(deps.logEvent.mock.calls.map((c) => c[0])).toContain("exit_order_rejected");
    expect(refusals()).toHaveLength(1);
    expect(String(refusals()[0][2])).toContain(OTHER);

    // A second try on the next tick, and the stop move and cancel beside it,
    // are refused too — and not said again.
    await expect(placeExitOrder(deps, strategy, deployment, contract, position, null, "test_reason")).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    const gated = deps.brokerFor(deployment);
    await expect(gated.modifyOrder(ACCOUNT, 7, { stopPrice: 19990 })).rejects.toBeInstanceOf(LeaseLostError);
    await expect(gated.cancelOrder(7, ACCOUNT)).rejects.toBeInstanceOf(LeaseLostError);
    expect(calls.placeOrder).not.toHaveBeenCalled();
    expect(calls.modifyOrder).not.toHaveBeenCalled();
    expect(calls.cancelOrder).not.toHaveBeenCalled();
    expect(refusals()).toHaveLength(1);

    // Reads are the broker's own: the process can still see the account.
    await expect(gated.searchOpenPositions(ACCOUNT)).resolves.toEqual([longOne]);
  });
});

describe("the all role, where the lease is always this process's", () => {
  it("places every order: the exit, the stop move and the cancel all reach the broker", async () => {
    tryAcquireLease(leaseHolderId(), Date.now());
    const { broker, calls } = fakeBroker();
    const deps = exitDeps(broker, leaseGate("an order call", "unused"));

    await placeExitOrder(deps, strategy, deployment, contract, position, null, "test_reason");
    const gated = deps.brokerFor(deployment);
    await gated.modifyOrder(ACCOUNT, 7, { stopPrice: 19990 });
    await gated.cancelOrder(7, ACCOUNT);

    expect(calls.placeOrder).toHaveBeenCalledTimes(1);
    expect(calls.modifyOrder).toHaveBeenCalledWith(ACCOUNT, 7, { stopPrice: 19990 });
    expect(calls.cancelOrder).toHaveBeenCalledWith(7, ACCOUNT);
    expect(refusals()).toEqual([]);
  });

  it("keeps the client's own `this`, so a stateful client is unchanged behind the gate", async () => {
    tryAcquireLease(leaseHolderId(), Date.now());
    class Client {
      placed = 0;
      async placeOrder() {
        this.placed++;
        return { orderId: this.placed, success: true, errorCode: 0, errorMessage: null };
      }
    }
    const client = new Client();
    const gated = leaseGatedBroker(client as unknown as Broker, ACCOUNT, () => true);
    await gated.placeOrder({} as Parameters<Broker["placeOrder"]>[0]);
    expect(client.placed).toBe(1);
  });
});
