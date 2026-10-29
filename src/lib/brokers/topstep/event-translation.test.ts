import { describe, it, expect, vi, afterEach } from "vitest";
import { toOrder, toPosition, toTradeFill, wireOrderStatus } from "./event-translation";
import { signedSize } from "@/lib/brokers/types";
import type {
  GatewayUserOrder,
  GatewayUserPosition,
  GatewayUserTrade,
} from "./signalr";

// Captured user-hub payloads (envelope already stripped by signalr.ts).

const ORDER: GatewayUserOrder = {
  id: 1234567,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  symbolId: "F.US.MNQ",
  creationTimestamp: "2026-08-22T13:31:02.117Z",
  updateTimestamp: "2026-08-22T13:31:02.480Z",
  status: 2,
  type: 2,
  side: 0,
  size: 3,
  limitPrice: null,
  stopPrice: null,
  fillVolume: 3,
  filledPrice: 24680.25,
  customTag: "e_a1b2c3d4_m1x9_9f2a",
};

const POSITION: GatewayUserPosition = {
  id: 778899,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  type: 1,
  size: 3,
  averagePrice: 24680.25,
};

const OPENING_FILL: GatewayUserTrade = {
  id: 55501,
  accountId: 9001,
  contractId: "CON.F.US.MNQ.M26",
  creationTimestamp: "2026-08-22T13:31:02.480Z",
  price: 24680.25,
  profitAndLoss: null,
  fees: 1.68,
  side: 0,
  size: 3,
  voided: false,
  orderId: 1234567,
};

const CLOSING_FILL: GatewayUserTrade = {
  ...OPENING_FILL,
  id: 55502,
  profitAndLoss: 42.5,
  side: 1,
  orderId: 1234568,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("toOrder", () => {
  it("maps every neutral Order field from the gateway payload", () => {
    expect(toOrder(ORDER)).toEqual({
      id: 1234567,
      accountId: 9001,
      contractId: "CON.F.US.MNQ.M26",
      creationTimestamp: "2026-08-22T13:31:02.117Z",
      updateTimestamp: "2026-08-22T13:31:02.480Z",
      status: 2,
      type: 2,
      side: 0,
      size: 3,
      limitPrice: null,
      stopPrice: null,
      filledPrice: 24680.25,
      customTag: "e_a1b2c3d4_m1x9_9f2a",
    });
  });

  it("drops symbolId and fillVolume, which no consumer reads", () => {
    const order = toOrder(ORDER) as unknown as Record<string, unknown>;
    expect(order.symbolId).toBeUndefined();
    expect(order.fillVolume).toBeUndefined();
  });

  it("preserves a resting order's limit and stop prices", () => {
    const resting: GatewayUserOrder = {
      ...ORDER,
      status: 1,
      type: 4,
      side: 1,
      limitPrice: 24700,
      stopPrice: 24650,
      fillVolume: 0,
      filledPrice: null,
    };
    const order = toOrder(resting);
    expect(order.status).toBe(1);
    expect(order.type).toBe(4);
    expect(order.side).toBe(1);
    expect(order.limitPrice).toBe(24700);
    expect(order.stopPrice).toBe(24650);
    expect(order.filledPrice).toBeNull();
  });

  it("passes an unknown status code through and warns rather than dropping the event", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = toOrder({ ...ORDER, status: 99 });
    expect(order.status).toBe(99);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown status=99"));
  });

  // brokers/README's standing rule about garbage union values is stated
  // specifically for side: a silent 0 ↔ 1 flip corrupts reconciliation.
  // narrow() must neither coerce it nor drop the event.
  it("passes an unknown side code through unmapped and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = toOrder({ ...ORDER, side: 7 as GatewayUserOrder["side"] });
    expect(order.side).toBe(7);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown side=7"));
  });
});

describe("toPosition", () => {
  it("maps a long position", () => {
    expect(toPosition(POSITION)).toEqual({
      id: 778899,
      accountId: 9001,
      contractId: "CON.F.US.MNQ.M26",
      creationTimestamp: "2026-08-22T13:31:02.480Z",
      type: 1,
      size: 3,
      averagePrice: 24680.25,
    });
  });

  it("maps a flat (size 0) position, which is the close signal", () => {
    const flat = toPosition({ ...POSITION, size: 0, type: 2 });
    expect(flat.size).toBe(0);
    expect(flat.type).toBe(2);
  });

  // A50. The gateway sends `type=0` on every close, beside `size=0` — the
  // two lines were adjacent in the 2026-08-26 soak. It was missing from
  // the known set, so each close warned that the gateway had "added a
  // code" it has always sent, and a real drift warning would have arrived
  // in a stream of false ones.
  it("does not warn on the flat sentinel the gateway sends with every close", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flat = toPosition({ ...POSITION, size: 0, type: 0 as GatewayUserPosition["type"] });
    expect(flat.type).toBe(0);
    expect(flat.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still warns on a position type that genuinely is not in the set", () => {
    // The negative above is only evidence beside this: the drift arm has
    // to keep firing for a code nobody has seen.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const odd = toPosition({ ...POSITION, type: 7 as GatewayUserPosition["type"] });
    expect(odd.type).toBe(7);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown type=7"));
  });

  // The membership change is inert because nothing downstream reads
  // `type` to decide flatness — `signedSize` answers 0 on any type once
  // size is 0, and it is the accessor every consumer goes through.
  it("reads flat from size, whatever the type says", () => {
    for (const type of [0, 1, 2] as Array<GatewayUserPosition["type"]>) {
      const flat = toPosition({ ...POSITION, size: 0, type });
      expect(signedSize(flat), `type=${type}`).toBe(0);
    }
  });
});

// A89. ProjectX's OrderStatus enum (gateway.docs.projectx.com/docs/realtime):
// None 0, Open 1, Filled 2, Cancelled 3, Expired 4, Rejected 5, Pending 6.
// The neutral OrderStatus is 1 Working, 2 Filled, 3 Cancelled, 4 Rejected,
// 5 Pending — the two agree only on 1–3.
describe("wireOrderStatus — wire → neutral", () => {
  it.each([
    [1, 1, "Open → Working"],
    [2, 2, "Filled → Filled"],
    [3, 3, "Cancelled → Cancelled"],
    [4, 3, "Expired → Cancelled, as Tradovate maps Expired"],
    [5, 4, "Rejected → Rejected"],
    [6, 5, "Pending → Pending"],
  ])("maps wire %d to neutral %d (%s) without warning", (wire, neutral) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(wireOrderStatus(wire, "test")).toBe(neutral);
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps the hub's order frame through it", () => {
    expect(toOrder({ ...ORDER, status: 5 }).status).toBe(4);
    expect(toOrder({ ...ORDER, status: 6 }).status).toBe(5);
  });

  // 8 is not in ProjectX's enum; 0 (None) is in it but has no neutral
  // meaning and has never been seen on an order. Both keep the drift arm.
  it.each([0, 8])("passes the unidentified status %d through and warns", (status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const order = toOrder({ ...ORDER, status });
    expect(order.status).toBe(status);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`unknown status=${status}`));
  });
});

// What the engine makes of the mapped codes — watchdog coverage and the
// post-flatten cancel — is pinned engine-side, in engine-watchdog.test.ts.

describe("toTradeFill", () => {
  it("keeps profitAndLoss null on an opening fill", () => {
    expect(toTradeFill(OPENING_FILL)).toEqual({
      id: 55501,
      accountId: 9001,
      contractId: "CON.F.US.MNQ.M26",
      creationTimestamp: "2026-08-22T13:31:02.480Z",
      price: 24680.25,
      profitAndLoss: null,
      fees: 1.68,
      side: 0,
      size: 3,
      voided: false,
      orderId: 1234567,
    });
  });

  it("keeps profitAndLoss non-null on a closing fill — the entry/exit discriminator", () => {
    const fill = toTradeFill(CLOSING_FILL);
    expect(fill.profitAndLoss).toBe(42.5);
    expect(fill.side).toBe(1);
  });

  it("carries fees inline, so Topstep never produces the Tradovate null-fees path", () => {
    expect(toTradeFill(CLOSING_FILL).fees).toBe(1.68);
  });

  it("preserves the voided flag", () => {
    expect(toTradeFill({ ...CLOSING_FILL, voided: true }).voided).toBe(true);
  });

  it("passes an unknown side code through unmapped and warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fill = toTradeFill({ ...CLOSING_FILL, side: 7 as GatewayUserTrade["side"] });
    expect(fill.side).toBe(7);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown side=7"));
  });
});
