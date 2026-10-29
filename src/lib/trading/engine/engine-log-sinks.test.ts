/**
 * The ring sink is where `/logs` lines enter the stream: every line the ring
 * stores — and every count a folded repeat climbs to — is sent as a `logLine`
 * frame, projected for the wire as the logs read projects it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db/connection", () => ({
  getDb: vi.fn(() => {
    throw new Error("getDb() not available in test");
  }),
  registerMigration: vi.fn(),
  registerAfterCloseHook: vi.fn(),
}));
// Their sinks install at import; this file is about the ring's alone.
vi.mock("@/lib/db/engine-logs", () => ({}));
vi.mock("@/lib/notify/log-escalation", () => ({}));

import { emit, resetLogBursts, type LogRecord, type WireLogRecord } from "@/lib/logging/pipe";
import { getBroadcaster, resetBroadcaster } from "@/lib/realtime/broadcaster-singleton";
import type { BroadcastEvent, BroadcasterDeps } from "@/lib/realtime/event-broadcaster";
import { logRings, pushToRing } from "./engine-log-sinks";

let frames: BroadcastEvent[];

function relay(): void {
  buildRelay()?.subscribe("browser", (e) => frames.push(e));
}

function buildRelay(): ReturnType<typeof getBroadcaster> {
  return getBroadcaster({
    userEvents: {
      retain: async () => {},
      isConnected: () => true,
      onPosition: () => {},
      onFill: () => {},
      onStatus: () => {},
    },
    marketTrades: { subscribe: async () => {}, unsubscribe: async () => {} },
    marketDataContractId: async () => null,
  } satisfies BroadcasterDeps);
}

const lines = (): WireLogRecord[] =>
  frames.flatMap((e) => (e.kind === "logLine" ? [e.record] : []));

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: "2026-10-27T14:30:00.000Z",
    deploymentId: "dep-1",
    level: "trade",
    message: "Entry filled",
    severity: "info",
    category: "trade",
    event: null,
    display: "…4469-ema-x.MNQ",
    accountId: 1234554469,
    contractId: "CON.F.US.MNQ.Z26",
    ticker: "MNQ",
    tradeId: 7,
    values: null,
    burstKey: null,
    burstCount: 1,
    lastSeenAt: "2026-10-27T14:30:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  frames = [];
  const rings = logRings();
  rings.logs.length = 0;
  rings.heartbeatLogs.length = 0;
  resetLogBursts();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  resetBroadcaster();
  resetLogBursts();
  vi.restoreAllMocks();
});

describe("the ring sink — logLine", () => {
  it("sends each stored line once, projected: no account or contract id crosses", () => {
    relay();
    pushToRing(record());
    pushToRing(record({ message: "Bracket placed" }));

    expect(lines().map((l) => l.message)).toEqual(["Entry filled", "Bracket placed"]);
    expect(lines()[1]).toEqual({
      timestamp: "2026-10-27T14:30:00.000Z",
      deploymentId: "dep-1",
      level: "trade",
      message: "Bracket placed",
      severity: "info",
      category: "trade",
      event: null,
      display: "…4469-ema-x.MNQ",
      ticker: "MNQ",
      tradeId: 7,
      values: null,
      burstCount: 1,
      seq: 1,
    });
  });

  it("stamps a heartbeat's seq past the main ring, as the logs read does", () => {
    relay();
    pushToRing(record());
    pushToRing(record({ level: "heartbeat", category: "heartbeat", message: "alive" }));

    expect(lines().map((l) => l.seq)).toEqual([0, 1]);
  });

  it("re-sends a folded repeat's line with the climbed count", () => {
    relay();
    // An engine line: the pipe returns it and the engine's handler rings it.
    const line = { event: null, severity: "error", category: "safety", deploymentId: "dep-1" } as const;
    const first = emit({ ...line, message: "Bracket cancel failed for order 8811001" });
    if (first) pushToRing(first);
    emit({ ...line, message: "Bracket cancel failed for order 8811001" });
    emit({ ...line, message: "Bracket cancel failed for order 8811001" });

    expect(lines().map((l) => l.burstCount)).toEqual([1, 2, 3]);
    expect(new Set(lines().map((l) => l.timestamp)).size).toBe(1);
  });

  it("projects nothing for a relay with no listener, and still stores", () => {
    const sent = vi.spyOn(buildRelay()!, "emitLogLine");

    pushToRing(record());

    expect(sent).not.toHaveBeenCalled();
    expect(logRings().logs).toHaveLength(1);
  });

  it("sends nothing, and still stores, when no relay exists yet", () => {
    pushToRing(record());
    expect(frames).toEqual([]);
    expect(logRings().logs).toHaveLength(1);
  });
});
