import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({ isStagingEnv: vi.fn(() => true) }));
vi.mock("@/lib/env", () => ({
  isStagingEnv: H.isStagingEnv,
  isProductionEnv: () => !H.isStagingEnv(),
}));

import {
  consoleLog,
  emit,
  projectLogRecord,
  resetLogBursts,
  setEscalationSink,
  setLogRingSink,
  setLogSink,
  taggedEvent,
  type BurstUpdate,
  type LogRecord,
} from "./pipe";
import { setManagedAccountSource } from "./scrub";
import { LEGACY_LEVEL_LADDER, type LegacyLevel } from "./vocabulary";

/**
 * A line the engine seam emits, expressed the way a migrated call site
 * does: the ladder's pair, and `entry_skipped` for the one chip the pair
 * cannot express.
 *
 * Shim A used to take the chip as an argument and carry it verbatim. This
 * stands in its place so every assertion below stays about the *pipe*
 * rather than about the shim that is gone — and it is deliberately the
 * long way round, because a helper that took a level and set it would be
 * the second writer of the `level` column all over again.
 */
function engineLine(
  deploymentId: string,
  level: LegacyLevel,
  message: string,
): LogRecord | null {
  if (level === "trade-skip") {
    return emit({ event: "entry_skipped", deploymentId, message });
  }
  const { severity, category } = LEGACY_LEVEL_LADDER[level];
  return emit({ event: null, severity, category, deploymentId, message });
}

const ALL_LEGACY_LEVELS: LegacyLevel[] = [
  "info",
  "warn",
  "error",
  "trade",
  "connection",
  "heartbeat",
  "trade-skip",
];

let written: LogRecord[];
let bumped: BurstUpdate[];
let ringPushed: LogRecord[];
let ringBumped: BurstUpdate[];
let escalated: LogRecord[];
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function consoleLines(): string[] {
  return [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
    (c) => String(c[0]),
  );
}

beforeEach(() => {
  written = [];
  bumped = [];
  ringPushed = [];
  ringBumped = [];
  escalated = [];
  setEscalationSink((r) => void escalated.push(r));
  setLogSink({ write: (r) => void written.push(r), bump: (u) => void bumped.push(u) });
  setLogRingSink({
    push: (r) => void ringPushed.push(r),
    bump: (u) => void ringBumped.push(u),
  });
  // The burst collapser is process-wide module state, and a message
  // repeated across two tests is a burst as far as it is concerned.
  resetLogBursts();
  H.isStagingEnv.mockReturnValue(true);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  setLogSink(null);
  setLogRingSink(null);
  setEscalationSink(null);
  setManagedAccountSource(null);
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  vi.unstubAllEnvs();
});

describe("the engine seam — the seven chips, derived", () => {
  it("lands on every legacy chip, so /logs renders what it always did", () => {
    for (const level of ALL_LEGACY_LEVELS) {
      const record = engineLine("d1", level, `line at ${level}`);
      expect(record, level).not.toBeNull();
      expect(record!.level, level).toBe(level);
    }
  });

  it("leaves the event unclassified for a line that names no event", () => {
    expect(engineLine("d1", "trade", "m")!.event).toBeNull();
  });

  it("maps each level onto the ladder", () => {
    expect(engineLine("d1", "trade", "a")).toMatchObject({ severity: "info", category: "trade" });
    expect(engineLine("d1", "trade-skip", "b")).toMatchObject({
      severity: "info",
      category: "trade",
      level: "trade-skip",
    });
    expect(engineLine("d1", "connection", "c")).toMatchObject({
      severity: "info",
      category: "connection",
    });
    expect(engineLine("d1", "heartbeat", "d")).toMatchObject({
      severity: "info",
      category: "heartbeat",
    });
    expect(engineLine("d1", "warn", "e")).toMatchObject({ severity: "warn", category: "system" });
    expect(engineLine("d1", "error", "f")).toMatchObject({ severity: "error", category: "system" });
  });

  it("persists every legacy level", () => {
    for (const level of ALL_LEGACY_LEVELS) engineLine("d1", level, `line at ${level}`);
    expect(written.map((r) => r.level)).toEqual(ALL_LEGACY_LEVELS);
  });

  it("renders an engine line in the one console format", () => {
    engineLine("758d19dd", "trade", "Entry filled");
    expect(consoleLines()[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[info\] \[trade\] \[758d19dd\] Entry filled$/,
    );
  });
});

describe("compat shim B — log.* through the pipe", () => {
  it("persists a console line, which is the behaviour change L1 is for", () => {
    consoleLog("info", "db", "closed cleanly on SIGTERM");
    expect(written).toHaveLength(1);
    expect(written[0].message).toBe("closed cleanly on SIGTERM");
  });

  it("maps the tag onto a category and files the line under the engine sentinel", () => {
    consoleLog("warn", "tradovate.realtime", "fill not in order map");
    expect(written[0]).toMatchObject({
      severity: "warn",
      category: "broker",
      deploymentId: "engine",
      event: null,
    });
  });

  it("derives the legacy level so the row still renders in /logs", () => {
    consoleLog("warn", "tradovate.realtime", "a");
    consoleLog("info", "signalr", "b");
    consoleLog("error", "db", "c");
    expect(written.map((r) => r.level)).toEqual(["warn", "connection", "error"]);
  });

  it("renders a log.* line in the same console format as an engine line", () => {
    consoleLog("info", "db", "opened");
    expect(consoleLines()[0]).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[info\] \[system\] \[engine\] opened$/,
    );
  });

  /**
   * A58: both worlds shipped to prod in one boot stream with different
   * shapes, and the second bracket meant severity in one and a legacy level
   * in the other. This pins the property that fixed it — the two renders
   * agree field-for-field — rather than either shape on its own, so a
   * future re-divergence fails here instead of in `docker logs`.
   */
  it("gives both worlds the same shape, with severity in the same bracket", () => {
    const ONE_FORMAT =
      /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[(debug|info|warn|error)\] \[\w+\] \[[\w-]+\] .+$/;
    consoleLog("info", "db", "opened");
    engineLine("758d19dd", "trade", "Entry filled");
    const [tagged, engine] = consoleLines();
    expect(tagged).toMatch(ONE_FORMAT);
    expect(engine).toMatch(ONE_FORMAT);
    expect(engine).not.toContain("[Engine]");
  });

  it("routes by severity — warn to console.warn, error to console.error", () => {
    consoleLog("warn", "db", "w");
    consoleLog("error", "db", "e");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("scrubs meta before it reaches the console", () => {
    consoleLog("warn", "auth", "refresh failed", { token: "abcdefghijklmnop" });
    // A value under a sensitive key is redacted whole since 2026-10-27
    // (scrub.ts): the 6+4 mask kept ten real characters of a secret.
    expect(warnSpy.mock.calls[0][1]).toEqual({ token: "[REDACTED]" });
  });
});

/**
 * The second gap L1 handed to L4: a tagged line was durable immediately and
 * invisible in `/logs` until the *next* boot hydrated it back, because the
 * rings are fed by the engine's log handler and a `log.*` line never goes
 * near it. Observed on the first staging boot — four `[info]` lines
 * persisted while the UI's INFO chip read 1.
 */
describe("a tagged line reaches the live rings", () => {
  it("pushes a log.* line, so /logs shows it without waiting for a restart", () => {
    consoleLog("info", "engine", "boot: configured brokers — topstep");
    expect(ringPushed).toHaveLength(1);
    expect(ringPushed[0].message).toBe("boot: configured brokers — topstep");
  });

  it("pushes a log.event line too", () => {
    taggedEvent("hub_reconnected", "signalr", "market hub reconnected");
    expect(ringPushed).toHaveLength(1);
    expect(ringPushed[0].event).toBe("hub_reconnected");
  });

  it("hands the ring the very record the store got — one scrubbed message", () => {
    setManagedAccountSource(() => [11444469]);
    consoleLog("warn", "flatten-all", "close failed on account 11444469");
    expect(ringPushed[0]).toBe(written[0]);
    expect(ringPushed[0].message).toBe("close failed on account …4469");
  });

  it("leaves an engine line alone — its own log handler is what rings it", () => {
    engineLine("d1", "error", "bracket place failed");
    expect(written).toHaveLength(1);
    expect(ringPushed).toHaveLength(0);
  });

  it("pushes nothing for a repeat the collapser folded", () => {
    consoleLog("warn", "tradovate.realtime", "fill not in order map");
    consoleLog("warn", "tradovate.realtime", "fill not in order map");
    expect(ringPushed).toHaveLength(1);
    expect(ringBumped).toHaveLength(1);
  });

  // `debug` needs no special case: a line the gate dropped does not exist,
  // and a line that exists reaches the ring like any other.
  it("pushes no debug line the tag gate dropped", () => {
    vi.stubEnv("DEBUG_TAGS", "");
    consoleLog("debug", "eval", "per-bar detail");
    expect(ringPushed).toHaveLength(0);
  });

  it("pushes a debug line the tag gate kept, below prod", () => {
    vi.stubEnv("DEBUG_TAGS", "eval");
    consoleLog("debug", "eval", "per-bar detail");
    expect(ringPushed).toHaveLength(1);
    expect(ringPushed[0].severity).toBe("debug");
  });

  it("pushes no debug line in prod, where the line does not exist", () => {
    H.isStagingEnv.mockReturnValue(false);
    vi.stubEnv("DEBUG_TAGS", "*");
    consoleLog("debug", "eval", "per-bar detail");
    expect(ringPushed).toHaveLength(0);
    expect(written).toHaveLength(0);
  });

  it("survives a throwing ring without taking the caller's line with it", () => {
    setLogRingSink({ push: () => { throw new Error("ring is gone"); }, bump: () => {} });
    expect(() => consoleLog("info", "db", "opened")).not.toThrow();
    expect(written).toHaveLength(1);
  });
});

describe("the debug rule", () => {
  it("drops a debug line entirely in prod", () => {
    H.isStagingEnv.mockReturnValue(false);
    vi.stubEnv("DEBUG_TAGS", "*");
    expect(emit({ event: null, severity: "debug", category: "broker", deploymentId: "engine", message: "frame" })).toBeNull();
    expect(written).toHaveLength(0);
    expect(consoleLines()).toHaveLength(0);
  });

  it("keeps an untagged debug line below prod with no DEBUG_TAGS opt-in", () => {
    // Gate decision 2's staging half, and the reason the raw account-feed
    // frames go through the engine seam rather than through `log.*`: a
    // tagged debug line is opt-in, and an operator who never set the
    // variable would lose the frames on the environment that wants them.
    vi.stubEnv("DEBUG_TAGS", "");
    vi.stubEnv("LOG_LEVEL", "debug");
    const record = emit({
      event: "order_frame",
      deploymentId: "engine",
      message: "Tradovate WS: order acct=1001 id=5 status=2 size=1",
    });
    expect(record?.severity).toBe("debug");
    expect(written).toHaveLength(1);
  });

  it("drops the same untagged frame in prod", () => {
    H.isStagingEnv.mockReturnValue(false);
    vi.stubEnv("DEBUG_TAGS", "");
    expect(
      emit({
        event: "position_frame",
        deploymentId: "engine",
        message: "User hub: position update accountId=1001",
      }),
    ).toBeNull();
    expect(written).toHaveLength(0);
  });

  it("drops a debug line below prod when nobody enabled its tag", () => {
    vi.stubEnv("DEBUG_TAGS", "");
    consoleLog("debug", "eval", "per-bar detail");
    expect(written).toHaveLength(0);
    expect(consoleLines()).toHaveLength(0);
  });

  it("keeps and persists a debug line below prod when its tag is enabled", () => {
    vi.stubEnv("DEBUG_TAGS", "eval");
    vi.stubEnv("LOG_LEVEL", "debug");
    consoleLog("debug", "eval", "per-bar detail");
    expect(written).toHaveLength(1);
    expect(written[0].severity).toBe("debug");
  });

  it("writes a debug row under the info chip, since the legacy enum has none", () => {
    vi.stubEnv("DEBUG_TAGS", "*");
    consoleLog("debug", "tradovate.realtime", "order frame");
    expect(written[0].level).toBe("info");
    expect(written[0].severity).toBe("debug");
  });

  it("still lets a chip-bearing category name the level on a debug row", () => {
    vi.stubEnv("DEBUG_TAGS", "*");
    consoleLog("debug", "signalr", "frame");
    expect(written[0].level).toBe("connection");
    expect(written[0].severity).toBe("debug");
  });
});

describe("emit", () => {
  it("takes severity and category from the vocabulary when the event names one", () => {
    const record = emit({
      event: "bracket_place_failed",
      deploymentId: "d1",
      message: "stop rejected",
    });
    expect(record).toMatchObject({ severity: "error", category: "safety", level: "error" });
  });

  it("carries the subject columns through to the sink", () => {
    emit({
      event: "entry_filled",
      deploymentId: "d1",
      message: "Bought 1 MNQ",
      display: "…4469-ema-x.MNQ",
      accountId: 11444469,
      contractId: "CON.F.US.MNQ.Z25",
      tradeId: 4210,
    });
    expect(written[0]).toMatchObject({
      display: "…4469-ema-x.MNQ",
      accountId: 11444469,
      contractId: "CON.F.US.MNQ.Z25",
      tradeId: 4210,
      event: "entry_filled",
    });
  });

  it("nulls every subject column the caller did not supply", () => {
    emit({ event: null, severity: "info", category: "system", deploymentId: "engine", message: "m" });
    expect(written[0]).toMatchObject({
      display: null,
      accountId: null,
      contractId: null,
      tradeId: null,
    });
  });

  it("never upgrades a severity — the record carries what the call site claimed", () => {
    // L0 criterion 2 at the pipe: `error` on the wire means some call site
    // said `error`, so the audit of what each site checked is a per-site
    // question (L2's) and not something the pipe can launder.
    emit({ event: null, severity: "info", category: "safety", deploymentId: "d1", message: "first" });
    emit({ event: null, severity: "warn", category: "safety", deploymentId: "d1", message: "second" });
    expect(written.map((r) => r.severity)).toEqual(["info", "warn"]);
  });

  it("does not let a failing sink throw into the caller", () => {
    setLogSink({
      write: () => {
        throw new Error("disk full");
      },
      bump: () => {
        throw new Error("disk full");
      },
    });
    expect(() => engineLine("d1", "error", "sink throws on write")).not.toThrow();
    expect(() => engineLine("d1", "error", "sink throws on write")).not.toThrow();
  });

  it("emits nothing to the console below the configured level, but still persists", () => {
    vi.stubEnv("LOG_LEVEL", "error");
    consoleLog("info", "db", "quiet");
    expect(consoleLines()).toHaveLength(0);
    expect(written).toHaveLength(1);
  });
});

describe("burst collapse at the pipe", () => {
  // The boot the rework was written for: ~23 identical
  // `fill … not in tradovate_order_map — dropping` warnings in one frame.
  const BURST_LINE = "fill orderId=8811 not in tradovate_order_map — dropping";

  it("writes one row for 23 identical warnings and counts to 23", () => {
    for (let i = 0; i < 23; i++) consoleLog("warn", "tradovate.realtime", BURST_LINE);
    expect(written).toHaveLength(1);
    expect(bumped).toHaveLength(22);
    expect(bumped[bumped.length - 1].count).toBe(23);
    expect(bumped[bumped.length - 1].timestamp).toBe(written[0].timestamp);
    expect(bumped[bumped.length - 1].burstKey).toBe(written[0].burstKey);
  });

  it("prints the first of a burst and swallows the repeats", () => {
    for (let i = 0; i < 23; i++) consoleLog("warn", "tradovate.realtime", BURST_LINE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("returns null for a repeat, so the engine's ring gets one entry", () => {
    expect(engineLine("d1", "warn", BURST_LINE)).not.toBeNull();
    expect(engineLine("d1", "warn", BURST_LINE)).toBeNull();
  });

  // The one line the collapser was built for (tradovate/realtime.ts:748),
  // and the only one that opts in: ~23 fills in a single frame, each with
  // its own order id. The `burstKey` is what licenses the pipe to
  // normalise those ids out of the key.
  it("collapses the real burst's differing ids, because its call site opted in", () => {
    consoleLog("warn", "tradovate.realtime", "account 11444469: fill orderId=8811001 not in map", undefined, "orphan_fill");
    consoleLog("warn", "tradovate.realtime", "account 11447788: fill orderId=8811002 not in map", undefined, "orphan_fill");
    expect(written).toHaveLength(1);
    expect(bumped[0].count).toBe(2);
  });

  it("writes both lines when the same two ids arrive without a burstKey", () => {
    consoleLog("warn", "tradovate.realtime", "account 11444469: fill orderId=8811001 not in map");
    consoleLog("warn", "tradovate.realtime", "account 11447788: fill orderId=8811002 not in map");
    expect(written).toHaveLength(2);
    expect(bumped).toHaveLength(0);
  });

  it("keeps two deployments apart", () => {
    engineLine("depl-a", "warn", BURST_LINE);
    engineLine("depl-b", "warn", BURST_LINE);
    expect(written).toHaveLength(2);
    expect(bumped).toHaveLength(0);
  });

  it("keeps two causes apart when the call site names one", () => {
    emit({ event: null, severity: "warn", category: "safety", deploymentId: "d1", message: "stranded", burstKey: "sl" });
    emit({ event: null, severity: "warn", category: "safety", deploymentId: "d1", message: "stranded", burstKey: "tp" });
    expect(written).toHaveLength(2);
  });

  it("exempts the heartbeat, whose ring is a cadence rather than a cause", () => {
    for (let i = 0; i < 5; i++) engineLine("engine", "heartbeat", "[heartbeat] 1 deployment");
    expect(written).toHaveLength(5);
    expect(bumped).toHaveLength(0);
    expect(written[0].burstKey).toBeNull();
  });

  // A trade is an episode, not a cadence: one line per entry, exit or skip.
  // Two fills on one deployment inside thirty seconds is two trades, and an
  // event-keyed collapse would have folded them without ever looking at the
  // message — which is the same erasure as the digit collapse, arriving
  // from the other side of the key.
  it("exempts the trade category, so two fills in one window are two rows", () => {
    emit({ event: "entry_filled", deploymentId: "d1", message: "Bought 1 MNQ @ 20100" });
    emit({ event: "entry_filled", deploymentId: "d1", message: "Bought 2 MNQ @ 20140" });
    expect(written).toHaveLength(2);
    expect(bumped).toHaveLength(0);
    expect(written[0].burstKey).toBeNull();
  });

  it("exempts a legacy trade-skip line for the same reason", () => {
    engineLine("d1", "trade-skip", "Skipped: RSI filter blocked entry");
    engineLine("d1", "trade-skip", "Skipped: RSI filter blocked entry");
    expect(written).toHaveLength(2);
  });

  it("records the resolved cause key on the row it opened", () => {
    engineLine("d1", "warn", BURST_LINE);
    expect(written[0].burstKey).toContain("|d1|");
    expect(written[0].burstCount).toBe(1);
  });

  // The gap L1 left behind: the count landed in `engine_logs.burst_count`
  // and nowhere else, while the `/logs` page polls the rings and there is no
  // SSE for logs. A fold was therefore invisible rather than compact, and an
  // `error` row whose repeats climbed was silent escalation until a restart.
  it("hands every fold to the ring as well as to the store", () => {
    for (let i = 0; i < 23; i++) consoleLog("warn", "tradovate.realtime", BURST_LINE);
    expect(ringBumped).toHaveLength(22);
    expect(ringBumped[ringBumped.length - 1].count).toBe(23);
  });

  it("gives both sinks the same key and timestamp, so they name one row", () => {
    for (let i = 0; i < 3; i++) engineLine("d1", "error", BURST_LINE);
    expect(ringBumped).toEqual(bumped);
    expect(ringBumped[0].burstKey).toBe(written[0].burstKey);
    expect(ringBumped[0].timestamp).toBe(written[0].timestamp);
  });

  it("does not let a throwing ring cost the durable row its count", () => {
    setLogRingSink({ push: () => {}, bump: () => { throw new Error("ring is gone"); } });
    expect(() => {
      engineLine("d1", "warn", BURST_LINE);
      engineLine("d1", "warn", BURST_LINE);
    }).not.toThrow();
    expect(bumped[0].count).toBe(2);
  });

  it("never bumps the ring for a heartbeat, which has no cause key to fold on", () => {
    for (let i = 0; i < 5; i++) engineLine("engine", "heartbeat", "[heartbeat] 1 deployment");
    expect(ringBumped).toHaveLength(0);
    expect(written).toHaveLength(5);
  });
});

/**
 * The composition contract: **the pipe must never erase a discriminator a
 * call site deliberately carries.** Collapsing every four-digit run before
 * hashing did exactly that, and a folded repeat returns null from `emit`
 * — so the second incident reached no row, no ring and no console.
 *
 * Each fixture below is the message its call site actually renders, cited
 * so the provenance survives the next edit. Verify these by injection:
 * make `hashMessage`'s collapse unconditional again and all three of the
 * "renders" cases go red while the two "folds" cases stay green.
 */
describe("the collapser must not erase a discriminator the call site carries", () => {
  // engine.ts `refreshBrokerRegistry` — one line per re-routed account,
  // and total re-routing is the 2026-08-26 incident's shape. Two accounts
  // in one refresh emitted one row; the second account's `error` was gone.
  const reroute = (accountId: number) =>
    `Broker routing changed for account ${accountId} (Combine): topstep → tradovate. ` +
    `Every order for this account now resolves its contract through tradovate.`;

  // flatten-all route — N accounts failing inside one `Promise.allSettled`.
  const closeFailed = (accountId: number) =>
    `close failed (account=${accountId}, contract=CON.F.US.MNQ.U25): Bad Request`;

  // engine-exit.ts's `EXIT_FLAT_MISMATCH` warn. Its anchor re-announces on
  // a new trade id by design — and trade ids crossed 1000, so the pipe
  // started erasing the id the day the counter did.
  const flatMismatch = (tradeId: number) =>
    `Exit skipped (realtime_exit): broker reports no open position on CON.F.US.MNQ.U25, ` +
    `but trade #${tradeId} (CON.F.US.MNQ.U25) is still open — nothing was submitted; ` +
    `the position mirror is kept for the next pass`;

  it("renders both re-routing lines when two accounts move in one refresh", () => {
    engineLine("engine", "error", reroute(11444469));
    engineLine("engine", "error", reroute(11447788));
    expect(written.map((r) => r.message)).toEqual([reroute(11444469), reroute(11447788)]);
    expect(bumped).toHaveLength(0);
  });

  it("renders one line per account when a flatten-all fails on several", () => {
    consoleLog("warn", "flatten-all", closeFailed(11444469));
    consoleLog("warn", "flatten-all", closeFailed(11447788));
    consoleLog("warn", "flatten-all", closeFailed(11441122));
    expect(written).toHaveLength(3);
  });

  it("re-announces a flat mismatch on a new four-digit trade id", () => {
    engineLine("d1", "warn", flatMismatch(6876));
    engineLine("d1", "warn", flatMismatch(6877));
    expect(written).toHaveLength(2);
    expect(written[1].message).toContain("trade #6877");
  });

  // The other half of the contract, and what the collapser is for: the
  // per-tick sweep guards emit the same bytes every pass.
  it("still folds a repeat that is byte-identical", () => {
    for (let i = 0; i < 4; i++) engineLine("d1", "warn", flatMismatch(6876));
    expect(written).toHaveLength(1);
    expect(bumped[bumped.length - 1].count).toBe(4);
  });

  // Through `taggedEvent`, because that is what the site calls: it names
  // `orphan_fill_dropped` *and* hands over the `orphan_fill` hint, and the
  // two together are the only opt-in composition in the tree. Driving it
  // through `consoleLog` tested a shape nothing emits.
  it("folds the opted-in orphan-fill line across differing order ids", () => {
    const orphan = (orderId: number) =>
      `account 11444469: fill orderId=${orderId} not in tradovate_order_map — dropping`;
    for (const orderId of [8811001, 8811002, 8811003]) {
      taggedEvent("orphan_fill_dropped", "tradovate.realtime", orphan(orderId), {
        accountId: 11444469,
        contractId: "CON.F.US.MNQ.U25",
        burstKey: "orphan_fill",
      });
    }
    expect(written).toHaveLength(1);
    expect(written[0].severity).toBe("warn");
    expect(bumped[bumped.length - 1].count).toBe(3);
  });
});

describe("scrubbing is a property of the pipe", () => {
  it("hands the sink and the console the same scrubbed message", () => {
    setManagedAccountSource(() => [11444469]);
    engineLine("d1", "info", "flattened 11444469");
    expect(written[0].message).toBe("flattened …4469");
    expect(consoleLines()[0]).toContain("flattened …4469");
    expect(consoleLines()[0]).not.toContain("11444469");
  });

  // `display` is `account-strategy.ticker` — it carries an account number
  // by construction, and it is a durable column. The truncation rule lives
  // here rather than at the 71 call sites L3 will populate it from.
  it("truncates a managed account number in display, not only in message", () => {
    setManagedAccountSource(() => [11444469]);
    emit({
      event: null,
      severity: "info",
      category: "trade",
      deploymentId: "d1",
      display: "11444469-ema-x.MNQ",
      message: "entered",
    });
    expect(written[0].display).toBe("…4469-ema-x.MNQ");
  });

  it("scrubs the caller's burst hint before it reaches the resolved key", () => {
    setManagedAccountSource(() => [11444469]);
    emit({
      event: null,
      severity: "warn",
      category: "safety",
      deploymentId: "d1",
      burstKey: "stranded-11444469",
      message: "stranded",
    });
    expect(written[0].burstKey).toContain("stranded-…4469");
    expect(written[0].burstKey).not.toContain("11444469");
  });

  /**
   * The slot values reach a durable column, so they are scrubbed on the same
   * pass the message is — and this is the injection-verified half: neuter
   * `scrubValues` in `scrub.ts` and the account number arrives on the record,
   * on the ring push and in the serialized wire payload.
   *
   * The rule this backstops is a construction rule — a value carries a size,
   * a price or a reason and never an identifier — which it has to be,
   * because a price is a digit run too and `display`'s positional trick is
   * unavailable here.
   */
  it("scrubs a string value, and leaves a number alone", () => {
    setManagedAccountSource(() => [11444469]);
    const record = emit({
      event: "exit_filled",
      deploymentId: "d1",
      message: "closed",
      values: { size: 2, pnl: "+$32.25", reason: "closed on account 11444469" },
    })!;
    expect(record.values).toEqual({
      size: 2,
      pnl: "+$32.25",
      reason: "closed on account …4469",
    });
    expect(JSON.stringify(record.values)).not.toContain("11444469");
    expect(written[0].values).toEqual(record.values);
  });

  it("nulls values on a line that named none, rather than writing an empty object", () => {
    engineLine("d1", "info", "nothing to render");
    expect(written[0].values).toBeNull();
  });

  /**
   * The composition contract's downward half, on the new field: values are
   * *rendering* data, so they are not an axis of the cause key. Two lines
   * that differ only in their values differ in their message too — the site
   * interpolated them there first — so folding on the message is folding on
   * the values, and adding them to the key would only fold *less*.
   */
  it("keeps values out of the burst key", () => {
    emit({
      event: "bracket_cancel_failed",
      deploymentId: "d1",
      message: "cancel failed",
      values: { size: 1 },
    });
    emit({
      event: "bracket_cancel_failed",
      deploymentId: "d1",
      message: "cancel failed",
      values: { size: 9 },
    });
    expect(written).toHaveLength(1);
    expect(bumped).toHaveLength(1);
  });

  it("ignores a smuggled legacyLevel — the chip has one writer and it derives", () => {
    // The nominal guard this replaces pinned that shim A was the *only*
    // writer of the `level` column while the field still existed. Shim A is
    // gone, and this is the stronger statement: the field is off the public
    // type (the `@ts-expect-error` is that half of the assertion, and goes
    // unused — failing the build — if anyone puts it back), and a value
    // smuggled past the compiler now changes nothing, because nothing reads
    // it. Two ways of deciding the chip cannot come apart if there is one.
    emit({
      event: null,
      severity: "info",
      category: "system",
      deploymentId: "d1",
      message: "a call site naming its own legacy chip",
      // @ts-expect-error — `legacyLevel` is not on `LogEnvelope`.
      legacyLevel: "trade-skip",
    });
    expect(written[0].level).toBe("info");
  });
});

/**
 * The ladder's Discord half, wired in L2. The rule is narrow on purpose:
 * `error` **and** an event the vocabulary flagged. Everything else on the
 * ladder still reaches `/logs` and nowhere else, which is what stops this
 * from becoming a second, louder copy of the log.
 */
describe("escalation is a property of the ladder, narrowly", () => {
  it("escalates an error-severity line whose event is flagged", () => {
    emit({
      event: "session_exit_stranded",
      deploymentId: "d1",
      message: "the position is still open past its window",
    });
    expect(escalated).toHaveLength(1);
    expect(escalated[0].event).toBe("session_exit_stranded");
    expect(escalated[0].severity).toBe("error");
  });

  it("does not escalate an error the vocabulary did not flag", () => {
    // `bracket_place_failed` is `error/safety` and has a hand-placed rich
    // embed of its own. Flagging it too is the double-alert the dedupe rule
    // forbids.
    emit({ event: "bracket_place_failed", deploymentId: "d1", message: "bracket rejected" });
    expect(escalated).toHaveLength(0);
  });

  it("does not escalate an unclassified error", () => {
    // The 71 shim-A sites are `event: null`. If severity alone escalated,
    // every one of them would post to Discord on the first `error`.
    engineLine("d1", "error", "an unclassified engine error");
    expect(escalated).toHaveLength(0);
  });

  // The other half of the gate's two arms. A call site cannot reach the
  // `severity === "error"` test from below by naming a quieter level beside
  // a flagged event: `resolveLadder` answers from the registry, so the
  // downgrade this used to assert is no longer expressible.
  it("ignores a caller's quieter level on a flagged event and escalates anyway", () => {
    emit({
      event: "session_exit_stranded",
      severity: "warn",
      deploymentId: "d1",
      message: "a call site tried to downgrade this",
    });
    expect(escalated).toHaveLength(1);
    expect(escalated[0].severity).toBe("error");
  });

  it("carries the subject columns the alert renders its fields from", () => {
    emit({
      event: "exit_verification_residual",
      deploymentId: "d1",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
      message: "residual position size=1",
    });
    expect(escalated[0].accountId).toBe(12344469);
    expect(escalated[0].contractId).toBe("CON.F.US.MNQ.U26");
  });

  it("does not escalate a repeat the burst collapser folded", () => {
    // A folded repeat reaches no row, no ring and no console, so it must not
    // reach the webhook either — the alert is about the incident, and the
    // collapser has already decided this is the same one.
    for (let i = 0; i < 5; i++) {
      emit({
        event: "manual_position_close_failed",
        deploymentId: "d1",
        message: "identical cause, five passes",
      });
    }
    expect(written).toHaveLength(1);
    expect(escalated).toHaveLength(1);
  });

  it("never throws into the caller when the sender does", () => {
    setEscalationSink(() => {
      throw new Error("webhook exploded");
    });
    expect(() =>
      emit({ event: "session_exit_stranded", deploymentId: "d1", message: "still stranded" }),
    ).not.toThrow();
  });
});

describe("the API projection", () => {
  it("drops the account and contract ids and keeps only the truncated account in display", () => {
    setManagedAccountSource(() => [12344469]);
    const record = emit({
      event: "exit_verification_residual",
      deploymentId: "d1",
      display: "12344469-ema-crossover.MNQ",
      message: "residual position on account 12344469",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
      tradeId: 8812,
    })!;

    const wire = projectLogRecord(record, 0);
    const json = JSON.stringify(wire);

    // The two that stay server-side, asserted against the serialized
    // payload rather than the field — a leak through a nested value or a
    // message the scrubber missed is the shape this is watching for.
    expect(json).not.toContain("12344469");
    expect(json).not.toContain("CON.F.US.MNQ.U26");
    expect(wire.display).toBe("…4469-ema-crossover.MNQ");
    // `display` is the one account-shaped thing that survives, and it is
    // the truncated form the pipe wrote.
    expect(Object.keys(wire).sort()).toEqual([
      "burstCount",
      "category",
      "deploymentId",
      "display",
      "event",
      "level",
      "message",
      "seq",
      "severity",
      "ticker",
      "timestamp",
      "tradeId",
      "values",
    ]);
  });

  /**
   * The third widening, and the assertion that it is rendering data rather
   * than a fourth structural id: the values cross, and nothing account- or
   * broker-shaped crosses with them.
   */
  it("carries the template's values across, scrubbed", () => {
    setManagedAccountSource(() => [12344469]);
    const record = emit({
      event: "entry_filled",
      deploymentId: "d1",
      display: "12344469-ema-crossover.MNQ",
      message: "Trade #8812 entry filled @ 29246.25",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
      tradeId: 8812,
      values: { size: 1, price: "29246.25", sl: "29196.25", tp: "29346.25" },
    })!;

    const wire = projectLogRecord(record, 0);
    expect(wire.values).toEqual({
      size: 1,
      price: "29246.25",
      sl: "29196.25",
      tp: "29346.25",
    });
    const json = JSON.stringify(wire);
    expect(json).not.toContain("12344469");
    expect(json).not.toContain("CON.F.US.MNQ.U26");
  });

  /**
   * The fourth widening. A ticker is public market vocabulary — it names a
   * product every exchange lists and nothing about this operator — so it
   * crosses while the contract id it was derived from does not. That pair
   * of assertions is the whole decision.
   */
  it("carries the rendered ticker and still withholds the contract id it came from", () => {
    const record = emit({
      event: "naked_position_flatten",
      deploymentId: "engine",
      message: "[SAFETY] Flattening naked position",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
      ticker: "MNQ",
    })!;

    const wire = projectLogRecord(record, 0);
    expect(wire.ticker).toBe("MNQ");
    expect(JSON.stringify(wire)).not.toContain("CON.F.US.MNQ.U26");
  });

  it("nulls the ticker on a line that names no contract", () => {
    const wire = projectLogRecord(
      emit({ event: "engine_started", deploymentId: "engine", message: "up" })!,
      0,
    );
    expect(wire.ticker).toBeNull();
  });

  it("nulls values on a line that carried none", () => {
    const wire = projectLogRecord(
      emit({ event: "engine_started", deploymentId: "engine", message: "up" })!,
      0,
    );
    expect(wire.values).toBeNull();
  });

  /**
   * The one structural id L4b added, and the assertion that says the other
   * two did not come with it.
   *
   * The episode card groups by `trade_id`, so the viewer needs it on the
   * wire; the whitelist gains exactly one named field. Widening it to
   * `Omit<LogRecord, …>` — or adding `accountId` "while we're here" — is
   * what this pins against, and the key-list assertion above is the half
   * that fails when a *later* column arrives unannounced.
   */
  it("carries tradeId, and only tradeId, out of the three structural ids", () => {
    setManagedAccountSource(() => [12344469]);
    const record = emit({
      event: "exit_filled",
      deploymentId: "d1",
      display: "12344469-ema-crossover.MNQ",
      message: "trade closed",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
      tradeId: 8812,
    })!;

    const wire = projectLogRecord(record, 0);
    expect(wire.tradeId).toBe(8812);
    expect(Object.keys(wire).includes("accountId")).toBe(false);
    expect(Object.keys(wire).includes("contractId")).toBe(false);
  });

  /**
   * The catalog is a *cache*, and this is the case neither suite covered: an
   * account the boot sequence has not seeded yet, or one whose seed failed
   * while the database was unavailable, is not in `account_brokers` — and
   * under the old rule its `display` crossed to the browser whole.
   *
   * Asserted against the serialized payload with a digit-run regex rather
   * than against the field, because the field is only one of the ways the
   * number could ride out: the point is that nothing account-shaped is in
   * the JSON at all.
   */
  it("truncates display with the catalog empty — the wire carries no full account", () => {
    setManagedAccountSource(() => []);
    const record = emit({
      event: "exit_verification_residual",
      deploymentId: "d1",
      display: "12344469-ema-crossover.MNQ",
      message: "residual position after exit",
      accountId: 12344469,
      contractId: "CON.F.US.MNQ.U26",
    })!;

    const json = JSON.stringify(projectLogRecord(record, 0));
    expect(json).not.toMatch(/[0-9]{5,}/);
    expect(json).not.toContain("12344469");
    expect(projectLogRecord(record, 0).display).toBe("…4469-ema-crossover.MNQ");
  });

  it("nulls tradeId on a line that is not about one trade", () => {
    const wire = projectLogRecord(
      emit({ event: "hub_reconnected", deploymentId: "d1", message: "back" })!,
      0,
    );
    expect(wire.tradeId).toBeNull();
  });

  it("derives the pair for a hydrated legacy row, which carries no envelope", () => {
    const wire = projectLogRecord(
      {
        timestamp: "2026-08-27T00:00:00.000Z",
        deploymentId: "d1",
        level: "connection",
        message: "market hub reconnected",
      },
      3,
    );
    expect(wire.severity).toBe("info");
    expect(wire.category).toBe("connection");
    expect(wire.event).toBeNull();
    expect(wire.display).toBeNull();
    expect(wire.burstCount).toBe(1);
    // A hydrated row has no envelope, and its ordinal is still its position
    // in the ring — the caller's, not the row's.
    expect(wire.seq).toBe(3);
  });

  // `engine_logs.level` is freeform TEXT and the ring's `level` is an
  // `as`-cast off it, so the seven-value type is a claim about the database
  // rather than a fact about the value — and both accessors project every
  // hydrated row unconditionally. Without the fallback one unrecognised
  // level throws out of `getLogsByLevel`, which is the accessor the `/logs`
  // poll calls every five seconds.
  it("falls back to the info pair for a level the ladder does not carry", () => {
    const wire = projectLogRecord(
      {
        timestamp: "2026-08-27T00:00:00.000Z",
        deploymentId: "d1",
        level: "notice" as LegacyLevel,
        message: "a level written by a build that is gone",
      },
      0,
    );
    expect(wire.severity).toBe("info");
    expect(wire.category).toBe("system");
    expect(wire.level).toBe("notice");
  });
});

/**
 * The one chip `severity × category` cannot express, pinned on both sides of
 * the migration.
 *
 * `trade` and `trade-skip` share `info`/`trade`, so before L3 the level a
 * shim-A site named had to ride the envelope. `entry_skipped` is what
 * replaces it: the chip is derived from the event, and the derivation has to
 * answer identically for a line that came the old way and one that came the
 * new way — or the TRADE-SKIP chip quietly absorbs into TRADE on a viewer
 * this phase does not touch.
 */
describe("the TRADE-SKIP chip survives the migration", () => {
  it("gives a legacy trade-skip line and an entry_skipped event the same chip", () => {
    const legacy = engineLine("d1", "trade-skip", "Skipped: RSI filter blocked entry");
    const migrated = emit({
      event: "entry_skipped",
      deploymentId: "d1",
      message: "[ema-crossover] Skipped: RSI filter blocked entry — gate:filter:rsi",
    });
    expect(legacy?.level).toBe("trade-skip");
    expect(migrated?.level).toBe("trade-skip");
  });

  it("keeps an entry fill under TRADE, so the two chips do not merge", () => {
    expect(engineLine("d1", "trade", "Bought 1 MNQ @ 20100")?.level).toBe("trade");
    expect(
      emit({ event: "entry_filled", deploymentId: "d1", message: "Bought 2 MNQ @ 20140" })?.level,
    ).toBe("trade");
  });

  it("does not hand the skip chip to any other trade event", () => {
    expect(
      emit({ event: "exit_filled", deploymentId: "d1", message: "Closed MNQ +32" })?.level,
    ).toBe("trade");
  });
});
