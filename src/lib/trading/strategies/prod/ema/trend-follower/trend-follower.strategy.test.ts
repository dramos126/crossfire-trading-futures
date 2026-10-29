/**
 * `trend-follower`'s `vwapGates` research setting ([README.md](./README.md), Params → VWAP filter).
 *
 * The series is five days of 5m Globex bars on a seeded random walk whose drift
 * switches every 40 bars, so the EMA stack aligns both ways and the real
 * indicator chain (EMA, ATR, ADX, session VWAP) produces entries on both sides.
 * 2025-01-06 is a Monday in EST, so the 09:30 ET open is 14:30 UTC.
 */
import { describe, it, expect } from "vitest";
import type { BarData } from "@/lib/brokers/types";
import type { EntrySignal, ParamValue } from "@/lib/trading/strategy-types";
import { defaultParamValues } from "@/lib/trading/strategy-types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { calculateAll, type IndicatorResult } from "@/lib/trading/indicators";
import { collectSessionWindows } from "@/lib/trading/session/session";
import { parseArgs } from "@/cli/backtest/args";
import { CliError } from "@/cli/backtest/cli-error";
import { resolveFullParams } from "@/cli/backtest/params";
import strategy from "./trend-follower.strategy";

type EntryCtx = Parameters<typeof strategy.shouldEnter>[0];

const TICK = 0.25;
const DAY_SESSION = CONTRACT_SPECS.MNQ.daySession;
const BAR_MS = 5 * 60_000;
const SEED = 20261020;
const DAYS = 5;
const BARS_PER_DAY = 288;
const REGIME_BARS = 40;
const DRIFTS = [-1.5, 0, 1.5];
const NOISE = 4;
const START_MS = Date.UTC(2025, 0, 6, 0, 0, 0);

/**
 * Every entry 4.1.0 took on the walk at its defaults, as `bar:side:sl:tp`,
 * captured from that module before `vwapGates` existed. `all` must reproduce it
 * exactly.
 */
const SIGNALS_BEFORE_VWAP_GATES = [
  "179:1:49:98", "180:1:51:102", "181:1:51:102", "182:1:50:100", "183:1:49:98",
  "184:1:46:92", "185:1:46:92", "186:1:47:94", "187:1:44:88", "188:1:44:88",
  "197:1:42:84", "199:1:41:82", "203:1:42:84", "204:1:51:102", "205:1:56:112",
  "206:1:44:88", "207:1:45:90", "208:1:45:90", "209:1:45:90", "210:1:45:90",
  "211:1:46:92", "212:1:47:94", "213:1:45:90", "215:1:46:92", "216:1:47:94",
  "476:0:47:94", "477:0:48:96", "478:0:46:92", "481:0:48:96", "482:0:46:92",
  "522:0:68:136", "525:0:50:100", "526:0:48:96", "527:0:47:94", "528:0:48:96",
  "756:1:51:102", "757:1:52:104", "758:1:49:98", "759:1:48:96", "760:1:48:96",
  "761:1:50:100", "762:1:49:98", "763:1:48:96", "764:1:50:100", "765:1:49:98",
  "766:1:48:96", "767:1:49:98", "768:1:48:96", "779:1:50:100", "780:1:61:122",
  "781:1:61:122", "782:1:51:102", "783:1:53:106", "785:1:48:96", "786:1:48:96",
  "1050:1:51:102", "1051:1:52:104", "1052:1:52:104", "1053:1:51:102", "1054:1:49:98",
  "1055:1:50:100", "1056:1:52:104", "1058:1:50:100", "1062:1:51:102", "1063:1:49:98",
  "1331:1:70:140", "1332:1:79:158", "1385:1:48:96",
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const toTick = (p: number) => Math.round(p / TICK) * TICK;

function walk(): BarData[] {
  const rand = mulberry32(SEED);
  const bars: BarData[] = [];
  let price = 20000;
  let drift = 0;
  for (let i = 0; i < DAYS * BARS_PER_DAY; i++) {
    if (i % REGIME_BARS === 0) drift = DRIFTS[Math.floor(rand() * DRIFTS.length)];
    const open = price;
    const close = toTick(open + drift + (rand() - 0.5) * 2 * NOISE);
    const high = toTick(Math.max(open, close) + rand() * NOISE);
    const low = toTick(Math.min(open, close) - rand() * NOISE);
    bars.push({
      timestamp: new Date(START_MS + i * BAR_MS).toISOString(),
      open,
      high,
      low,
      close,
      volume: 100 + Math.floor(rand() * 900),
    });
    price = close;
  }
  return bars;
}

const BARS = walk();

function paramsWith(overrides: Record<string, ParamValue>): EntryCtx["params"] {
  return { ...defaultParamValues(strategy.params), ...overrides } as EntryCtx["params"];
}

function indicatorsFor(params: EntryCtx["params"]): Map<string, IndicatorResult> {
  return calculateAll(strategy.buildIndicators?.(params) ?? [], BARS, DAY_SESSION);
}

function enterAt(
  barIndex: number,
  overrides: Record<string, ParamValue>,
  indicators = indicatorsFor(paramsWith(overrides)),
): EntrySignal | null {
  return strategy.shouldEnter({
    bars: BARS,
    barIndex,
    indicators,
    position: null,
    params: paramsWith(overrides),
    tickSize: TICK,
    daySession: DAY_SESSION,
    sessionWindows: collectSessionWindows(strategy.config.session, { pauseWindows: [] }),
    crossTimeframeBars: new Map(),
    hasEnteredThisSession: () => false,
  }) as EntrySignal | null;
}

function signalsOver(overrides: Record<string, ParamValue> = {}): string[] {
  const indicators = indicatorsFor(paramsWith(overrides));
  const out: string[] = [];
  for (let i = 0; i < BARS.length; i++) {
    const s = enterAt(i, overrides, indicators);
    if (s) out.push(`${i}:${s.side}:${s.slTicks}:${s.tpTicks}`);
  }
  return out;
}

/** A series id read off the module's own indicator list; its own come before the filters'. */
function idOf(type: string): string {
  const config = (strategy.buildIndicators?.(paramsWith({})) ?? []).find((c) => c.type === type);
  if (!config) throw new Error(`module builds no ${type}`);
  return config.id;
}

const vwapId = () => idOf("SESSION_VWAP");

/** The default indicators with the VWAP series rewritten at the bars `edit` touches. */
function withVwap(edit: (vwap: number[]) => void): Map<string, IndicatorResult> {
  const indicators = indicatorsFor(paramsWith({}));
  const id = vwapId();
  const original = indicators.get(id);
  if (!original) throw new Error("no VWAP series");
  const values = [...original.values];
  edit(values);
  indicators.set(id, { ...original, values });
  return indicators;
}

/** The first long entry on the walk with every gate on, and its VWAP inputs. */
function firstLong() {
  const params = paramsWith({});
  const indicators = indicatorsFor(params);
  const vwap = indicators.get(vwapId())?.values ?? [];
  const atr = indicators.get(idOf("ATR"))?.values ?? [];
  for (let i = 0; i < BARS.length; i++) {
    const s = enterAt(i, {}, indicators);
    if (s?.side === 0) {
      return {
        barIndex: i,
        signal: s,
        close: BARS[i].close,
        atr: atr[i],
        vwapPastIndex: i - params.vwapSlopeLookback,
        vwapNow: vwap[i],
      };
    }
  }
  throw new Error("walk produced no long entry");
}

describe("vwapGates", () => {
  it("defaults to all", () => {
    expect(defaultParamValues(strategy.params).vwapGates).toBe("all");
  });

  it("takes exactly 4.1.0's entries at the default", () => {
    expect(signalsOver()).toEqual(SIGNALS_BEFORE_VWAP_GATES);
  });

  it("takes the same entries when all is set explicitly", () => {
    expect(signalsOver({ vwapGates: "all" })).toEqual(SIGNALS_BEFORE_VWAP_GATES);
  });

  it("with none, keeps every entry all takes, at the same stop and target, and adds more", () => {
    const none = signalsOver({ vwapGates: "none" });
    for (const s of SIGNALS_BEFORE_VWAP_GATES) expect(none).toContain(s);
    expect(none.length).toBeGreaterThan(SIGNALS_BEFORE_VWAP_GATES.length);
  });

  describe("each gate, on a long the default takes", () => {
    const base = firstLong();
    const expectSameEntry = (s: EntrySignal | null) => {
      expect(s).not.toBeNull();
      expect(s?.side).toBe(base.signal.side);
      expect(s?.slTicks).toBe(base.signal.slTicks);
      expect(s?.tpTicks).toBe(base.signal.tpTicks);
    };

    it("side gate: VWAP above the close blocks under all and not under none", () => {
      const indicators = withVwap((v) => {
        v[base.barIndex] = base.close + TICK;
        // Keep the slope rising so only the side gate is crossed.
        v[base.vwapPastIndex] = base.close - TICK;
      });
      expect(enterAt(base.barIndex, { vwapGates: "all" }, indicators)).toBeNull();
      expectSameEntry(enterAt(base.barIndex, { vwapGates: "none" }, indicators));
    });

    it("slope gate: VWAP falling over the lookback blocks under all and not under none", () => {
      const indicators = withVwap((v) => {
        v[base.vwapPastIndex] = base.vwapNow + TICK;
      });
      expect(enterAt(base.barIndex, { vwapGates: "all" }, indicators)).toBeNull();
      expectSameEntry(enterAt(base.barIndex, { vwapGates: "none" }, indicators));
    });

    it("distance gate: price past the ATR cap from VWAP blocks under all and not under none", () => {
      const { vwapMaxAtrDistance } = paramsWith({});
      const farVwap = base.close - (vwapMaxAtrDistance + 1) * base.atr;
      const indicators = withVwap((v) => {
        v[base.barIndex] = farVwap;
        v[base.vwapPastIndex] = farVwap - TICK;
      });
      expect(enterAt(base.barIndex, { vwapGates: "all" }, indicators)).toBeNull();
      expectSameEntry(enterAt(base.barIndex, { vwapGates: "none" }, indicators));
    });

    it("a missing VWAP value blocks under all and not under none", () => {
      const indicators = withVwap((v) => {
        v[base.vwapPastIndex] = NaN;
      });
      expect(enterAt(base.barIndex, { vwapGates: "all" }, indicators)).toBeNull();
      expectSameEntry(enterAt(base.barIndex, { vwapGates: "none" }, indicators));
    });
  });
});

describe("adxMinimum (A109)", () => {
  it("the module's own declaration stands after the filter spread, at 20", () => {
    expect(strategy.params.adxMinimum).toMatchObject({ group: "Trend", default: 20 });
    expect(defaultParamValues(strategy.params).adxMinimum).toBe(20);
  });

  it("the backtest CLI resolves 20 with no --set", () => {
    const args = parseArgs("run", [
      "--playbook", "trend-follower", "--ticker", "MNQ", "--timeframe", "5m",
      "--from", "2022-01-01", "--to", "2026-09-30",
    ]);
    expect(resolveFullParams(strategy, args).adxMinimum).toBe(20);
  });

  it("gates entries: 0 takes every default entry and more, 100 takes none", () => {
    const off = signalsOver({ adxMinimum: 0 });
    for (const s of SIGNALS_BEFORE_VWAP_GATES) expect(off).toContain(s);
    expect(off.length).toBeGreaterThan(SIGNALS_BEFORE_VWAP_GATES.length);
    expect(signalsOver({ adxMinimum: 100 })).toEqual([]);
  });
});

describe("vwapGates from the backtest CLI", () => {
  const RUN = [
    "--playbook", "trend-follower",
    "--ticker", "MNQ",
    "--timeframe", "5m",
    "--from", "2022-01-01",
    "--to", "2026-09-30",
  ];

  it("parses --set vwapGates=none beside --set adxMinimum=0", () => {
    const args = parseArgs("run", [...RUN, "--set", "adxMinimum=0", "--set", "vwapGates=none"]);
    const params = resolveFullParams(strategy, args);
    expect(params.vwapGates).toBe("none");
    expect(params.adxMinimum).toBe(0);
  });

  it("refuses a value that is not one of its options", () => {
    const args = parseArgs("run", [...RUN, "--set", "vwapGates=off"]);
    expect(() => resolveFullParams(strategy, args)).toThrow(CliError);
  });
});
