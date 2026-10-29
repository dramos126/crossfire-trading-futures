import os from "node:os";

import { afterEach, describe, it, expect, vi } from "vitest";

// Only the pinning test below needs `cached-bars`; `parseArgs` itself never
// imports it (see BAR_SYMBOLS's comment in args.ts). `cached-bars` binds the
// Topstep provider for its chained tail, which reaches the broker registry
// and the require.context strategy loader vitest has no equivalent for.
vi.mock("@/lib/brokers/registry-singleton", () => ({
  brokerRegistry: { getPlugin: vi.fn(() => null) },
}));

import {
  BAR_SYMBOLS,
  DEFAULT_BAR_SYMBOLS,
  assertSweepBudget,
  parseArgs,
  parseCommand,
  parseSweepAxis,
  sweepAxisPoints,
  sweepGridSize,
  workerCount,
} from "./args";
import { parseBookArgs } from "./commands/book-command";
import { CliError } from "./cli-error";
import { parseParityArgs } from "./parity/parity-day";
import { REVIEWED_MAX_CONTRACTS } from "@/lib/trading/orders/risk-sizer";
import { TICKER_TO_CACHE_SYMBOL } from "@/lib/data/cached-bars";

const MINIMAL = [
  "--ticker",
  "MNQ",
  "--timeframe",
  "5m",
  "--from",
  "2025-06-02",
  "--to",
  "2025-06-30",
  "--playbook",
  "orb",
];

describe("parseCommand", () => {
  it("accepts every registered command, including the ones pass B fills in", () => {
    expect(parseCommand(["run"])).toBe("run");
    expect(parseCommand(["walk-forward"])).toBe("walk-forward");
    expect(parseCommand(["lift"])).toBe("lift");
  });

  it("refuses an unknown command", () => {
    expect(() => parseCommand(["backtest"])).toThrow(/Unknown command/);
  });
});

describe("--topstep-tail", () => {
  it("is off by default, so a run reads the archive alone", () => {
    expect(parseArgs("run", MINIMAL).topstepTail).toBe(false);
    expect(parseArgs("run", [...MINIMAL, "--topstep-tail"]).topstepTail).toBe(true);
  });

  it("is refused outside run and beside --bar-symbol", () => {
    expect(() => parseArgs("walk-forward", [...MINIMAL, "--topstep-tail"])).toThrow(/run only/);
    expect(() =>
      parseArgs("run", [...MINIMAL, "--topstep-tail", "--bar-symbol", "NQ.c.0"]),
    ).toThrow(/--bar-symbol/);
  });

  it("is a command the parser knows, beside parity-day", () => {
    expect(parseCommand(["parity-day"])).toBe("parity-day");
  });
});

describe("parseArgs", () => {
  it("defaults contracts, fees, warmup and the fold geometry", () => {
    const args = parseArgs("run", MINIMAL);
    expect(args.contracts).toBe(1);
    expect(args.fees).toBe(true);
    expect(args.warmupDays).toBe(30);
    expect(args.dailyLossUsd).toBeNull();
    expect(args.dailyProfitUsd).toBeNull();
    expect([args.train, args.test, args.step]).toEqual([18, 6, 6]);
  });

  it("reads --daily-profit-usd beside --daily-loss-usd, and refuses a non-positive one", () => {
    const args = parseArgs("run", [...MINIMAL, "--daily-profit-usd", "200"]);
    expect(args.dailyProfitUsd).toBe(200);
    expect(args.dailyLossUsd).toBeNull();
    const both = parseArgs("run", [
      ...MINIMAL,
      "--daily-profit-usd=200",
      "--daily-loss-usd",
      "500",
    ]);
    expect([both.dailyLossUsd, both.dailyProfitUsd]).toEqual([500, 200]);
    expect(() => parseArgs("run", [...MINIMAL, "--daily-profit-usd", "0"])).toThrow(
      /--daily-profit-usd must be a positive number/,
    );
  });

  it("runs unthrottled at 100 unless told otherwise, and still takes a lower target", () => {
    expect(parseArgs("run", MINIMAL).cpuTarget).toBe(100);
    expect(parseArgs("run", [...MINIMAL, "--cpu-target", "40"]).cpuTarget).toBe(40);
    expect(parseArgs("run", [...MINIMAL, "--cpu-target", "5"]).cpuTarget).toBe(5);
  });

  it("refuses a CPU target outside 5..100 or one that is not whole", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--cpu-target", "0"])).toThrow(/--cpu-target/);
    expect(() => parseArgs("run", [...MINIMAL, "--cpu-target", "150"])).toThrow(/--cpu-target/);
    expect(() => parseArgs("run", [...MINIMAL, "--cpu-target", "40.5"])).toThrow(/--cpu-target/);
  });

  it("reads --risk-usd, and leaves the fixed-count mode off", () => {
    const args = parseArgs("run", [...MINIMAL, "--risk-usd", "225"]);
    expect(args.riskUsd).toBe(225);
    // The ceiling defaults to the one the engine enforces, so an unstated cap
    // makes the run a preview of what would have been placed.
    expect(args.maxContracts).toBe(REVIEWED_MAX_CONTRACTS);
  });

  it("accepts a --max-contracts above the reviewed ceiling as a research basis", () => {
    // The uncapped basis is what produced the ceiling, so the flag is not
    // bounded by it; the run header carries the number that was used.
    const args = parseArgs("run", [...MINIMAL, "--risk-usd", "225", "--max-contracts", "100"]);
    expect(args.maxContracts).toBe(100);
  });

  it("refuses --risk-usd together with --contracts rather than picking one", () => {
    // They answer different questions — signal quality in R against account
    // fit in dollars — so a run that quietly chose would produce a file whose
    // numbers do not mean what was asked for.
    expect(() =>
      parseArgs("run", [...MINIMAL, "--risk-usd", "225", "--contracts", "2"]),
    ).toThrow(/mutually exclusive/);
  });

  it("refuses --max-contracts without --risk-usd", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--max-contracts", "3"])).toThrow(
      /only applies with --risk-usd/,
    );
  });

  it("refuses --risk-usd together with --fees off", () => {
    // The sizer's denominator carries the round-trip fee, so a fee-free run
    // reports a contract count the engine would not place — and --risk-usd is
    // a preview of the engine rather than an approximation of it.
    expect(() =>
      parseArgs("run", [...MINIMAL, "--risk-usd", "225", "--fees", "off"]),
    ).toThrow(/--fees off/);
    expect(parseArgs("run", [...MINIMAL, "--risk-usd", "225", "--fees", "on"]).fees).toBe(true);
    // The fixed-count mode is unaffected: it divides no budget by anything.
    expect(parseArgs("run", [...MINIMAL, "--contracts", "2", "--fees", "off"]).fees).toBe(false);
  });

  it("reads --regime as a cell list and refuses a cell that is not one of the four", () => {
    const args = parseArgs("run", [
      ...MINIMAL,
      "--regime",
      "quiet.compressed,active.expanded",
    ]);
    expect(args.regimes).toEqual(["quiet.compressed", "active.expanded"]);
    expect(() => parseArgs("run", [...MINIMAL, "--regime", "unknown"])).toThrow(/unknown cell/);
  });

  it("treats --regime all as no gate at all, and runs no classifier for it", () => {
    const args = parseArgs("run", [...MINIMAL, "--regime", "all"]);
    expect(args.regimes).toBeNull();
    expect(args.usesClassifier).toBe(false);
    expect(args.warmupDays).toBe(30);
  });

  it("floors warmup at the classifier baseline whenever a label is computed", () => {
    expect(parseArgs("run", [...MINIMAL, "--regime", "active.expanded"]).warmupDays).toBe(275);
    expect(parseArgs("lift", MINIMAL).warmupDays).toBe(275);
    expect(parseArgs("labels", MINIMAL).warmupDays).toBe(275);
    // An explicit request above the floor still wins.
    expect(
      parseArgs("labels", [...MINIMAL, "--warmup-days", "400"]).warmupDays,
    ).toBe(400);
  });

  it("warms up for the widest perturbation variant when --perturb is asked for", () => {
    // Each variant moves one window, so the widest is the 300-day baseline
    // with v1's other two: 300 + 20 + 5. Without this the longest-baseline
    // variant scores its disagreement on sessions it could not classify.
    expect(parseArgs("labels", [...MINIMAL, "--perturb"]).warmupDays).toBe(325);
  });

  it("refuses a classifier version it cannot run", () => {
    expect(parseArgs("labels", [...MINIMAL, "--classifier-version", "1"]).classifierVersion).toBe(
      "1",
    );
    expect(() =>
      parseArgs("labels", [...MINIMAL, "--classifier-version", "2"]),
    ).toThrow(/--classifier-version must be "1"/);
  });

  it("requires a playbook everywhere except labels, which runs no hooks", () => {
    const withoutPlaybook = MINIMAL.slice(0, MINIMAL.indexOf("--playbook"));
    expect(parseArgs("labels", withoutPlaybook).playbook).toBeNull();
    expect(() => parseArgs("run", withoutPlaybook)).toThrow(/--playbook/);
  });

  it("takes --perturb as a bare flag and the study thresholds as values", () => {
    const args = parseArgs("labels", [
      ...MINIMAL,
      "--perturb",
      "--permutations",
      "200",
      "--seed",
      "7",
      "--min-cell-trades",
      "50",
      "--min-lift-r",
      "0.2",
      "--fold-consistency",
      "0.5",
    ]);
    expect(args.perturb).toBe(true);
    expect([args.permutations, args.seed, args.minCellTrades]).toEqual([200, 7, 50]);
    expect([args.minLiftR, args.foldConsistency]).toEqual([0.2, 0.5]);
    expect(() => parseArgs("lift", [...MINIMAL, "--fold-consistency", "1.5"])).toThrow(
      /fraction of 1/,
    );
  });

  it("defaults the study thresholds to the registered numbers", () => {
    const args = parseArgs("lift", MINIMAL);
    expect(args.perturb).toBe(false);
    expect([args.permutations, args.minCellTrades, args.minLiftR, args.foldConsistency]).toEqual([
      1000, 100, 0.1, 0.67,
    ]);
  });

  it("takes --cross-instrument as a bare flag, defaulting off", () => {
    expect(parseArgs("run", MINIMAL).crossInstrument).toBe(false);
    expect(parseArgs("run", [...MINIMAL, "--cross-instrument"]).crossInstrument).toBe(true);
    expect(() => parseArgs("run", [...MINIMAL, "--cross-instrument=MES"])).toThrow(
      /takes no value/,
    );
  });

  it("refuses an unknown flag instead of running an adjacent command", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--playbok", "orb"])).toThrow(/Unknown flag/);
  });

  it("defaults --bar-symbol to null and leaves --ticker's own resolution alone", () => {
    expect(parseArgs("run", MINIMAL).barSymbol).toBeNull();
  });

  it("reads --bar-symbol when it names a cache symbol another ticker maps to", () => {
    const args = parseArgs("run", [...MINIMAL, "--bar-symbol", "NQ.c.0"]);
    expect(args.barSymbol).toBe("NQ.c.0");
    // --ticker is untouched — tick value, fees and calibratedFor still
    // resolve off MNQ, only the bars read from NQ's cache symbol.
    expect(args.ticker).toBe("MNQ");
  });

  it("refuses a --bar-symbol that names no cache symbol", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--bar-symbol", "NQ"])).toThrow(
      /--bar-symbol must be one of/,
    );
    expect(() => parseArgs("run", [...MINIMAL, "--bar-symbol", "BTC.c.0"])).toThrow(
      /--bar-symbol/,
    );
  });

  it("refuses another index's bars priced on this ticker", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--bar-symbol", "YM.c.0"])).toThrow(
      /YM\.c\.0 is not MNQ's index; it prices as MYM/,
    );
    expect(() => parseArgs("run", [...MINIMAL, "--bar-symbol", "ES.c.0"])).toThrow(/not MNQ's index/);
  });

  it("runs MYM on its own bars or on YM's, and names the accepted tickers on a refusal", () => {
    const tickerAt = MINIMAL.indexOf("--ticker") + 1;
    const mym = MINIMAL.map((v, i) => (i === tickerAt ? "MYM" : v));
    expect(parseArgs("run", mym).ticker).toBe("MYM");
    expect(parseArgs("run", [...mym, "--bar-symbol", "YM.c.0"]).barSymbol).toBe("YM.c.0");
    const ym = MINIMAL.map((v, i) => (i === tickerAt ? "YM" : v));
    expect(() => parseArgs("run", ym)).toThrow(/--ticker must be one of MNQ, MES, MGC, MYM/);
  });

  it("keeps DEFAULT_BAR_SYMBOLS in exact agreement with TICKER_TO_CACHE_SYMBOL's values", () => {
    // args.ts copies this set rather than importing the map (see its
    // comment) — pin it here so the copy cannot drift from the source.
    expect([...DEFAULT_BAR_SYMBOLS].sort()).toEqual(
      Object.values(TICKER_TO_CACHE_SYMBOL).sort(),
    );
  });

  it("accepts an index micro's pre-repoint calendar-rolled series on its own ticker only", () => {
    // The series the ticker table mapped to before 2026-10-25 (A61): reachable
    // through --bar-symbol alone, so an older run can be reproduced on its
    // own bars, never through the ticker table, and priced as its own micro.
    expect(BAR_SYMBOLS).toEqual(expect.arrayContaining(["MNQ.c.0", "MES.c.0", "MYM.c.0"]));
    expect(Object.values(TICKER_TO_CACHE_SYMBOL)).not.toContain("MNQ.c.0");
    expect(parseArgs("run", [...MINIMAL, "--bar-symbol", "MNQ.c.0"]).barSymbol).toBe("MNQ.c.0");
    expect(() => parseArgs("run", [...MINIMAL, "--bar-symbol", "MES.c.0"])).toThrow(
      /MES\.c\.0 is not MNQ's index; it prices as MES/,
    );
  });

  it("requires a range whose ends are in order", () => {
    const reversed = [...MINIMAL];
    reversed[reversed.indexOf("2025-06-02")] = "2025-07-02";
    expect(() => parseArgs("run", reversed)).toThrow(/is after --to/);
  });

  it("takes --set more than once and keeps both", () => {
    const args = parseArgs("run", [...MINIMAL, "--set", "atrPeriod=20", "--set", "adxMinimum=25"]);
    expect(args.sets).toEqual([
      { key: "atrPeriod", value: "20" },
      { key: "adxMinimum", value: "25" },
    ]);
  });

  it("reads a month count off the fold flags and refuses a bare number", () => {
    expect(parseArgs("walk-forward", [...MINIMAL, "--train", "24m"]).train).toBe(24);
    expect(() => parseArgs("walk-forward", [...MINIMAL, "--train", "24"])).toThrow(/month count/);
  });

  it("refuses a step shorter than the test window, which would pool a trade twice", () => {
    expect(() =>
      parseArgs("walk-forward", [...MINIMAL, "--test", "6m", "--step", "3m"]),
    ).toThrow(/overlap/);
  });

  it("accepts a step equal to the test window, which is the registered geometry", () => {
    const args = parseArgs("walk-forward", [...MINIMAL, "--test", "6m", "--step", "6m"]);
    expect([args.test, args.step]).toEqual([6, 6]);
  });
});

describe("sweep grid", () => {
  it("walks lo to hi inclusive without accumulating float drift", () => {
    expect(sweepAxisPoints(parseSweepAxis("x=0.1:0.5:0.1"))).toEqual([
      0.1,
      0.2,
      0.30000000000000004,
      0.4,
      0.5,
    ]);
    expect(sweepAxisPoints(parseSweepAxis("n=10:14:2"))).toEqual([10, 12, 14]);
  });

  it("multiplies across axes", () => {
    expect(sweepGridSize([parseSweepAxis("a=1:5:1"), parseSweepAxis("b=1:5:1")])).toBe(25);
  });

  it("accepts a grid of exactly 25 points and refuses 30", () => {
    expect(() =>
      assertSweepBudget([parseSweepAxis("a=1:5:1"), parseSweepAxis("b=1:5:1")]),
    ).not.toThrow();
    expect(() =>
      assertSweepBudget([parseSweepAxis("a=1:6:1"), parseSweepAxis("b=1:5:1")]),
    ).toThrow(/grid is 30 points/);
  });

  it("refuses a third axis", () => {
    expect(() =>
      assertSweepBudget([
        parseSweepAxis("a=1:2:1"),
        parseSweepAxis("b=1:2:1"),
        parseSweepAxis("c=1:2:1"),
      ]),
    ).toThrow(/at most 2 keys/);
  });

  it("refuses a malformed axis rather than guessing a step", () => {
    expect(() => parseSweepAxis("a=1:5")).toThrow(/key=lo:hi:step/);
    expect(() => parseSweepAxis("a=1:5:0")).toThrow(/step must be positive/);
    expect(() => parseSweepAxis("a=5:1:1")).toThrow(/hi must not be below lo/);
  });
});

describe("workerCount", () => {
  const CORES = 8;

  it("is 1 when neither the flag nor BACKTEST_WORKERS is set, or the variable is empty", () => {
    expect(workerCount(null, undefined, CORES)).toBe(1);
    expect(workerCount(null, "", CORES)).toBe(1);
  });

  it("reads BACKTEST_WORKERS, up to and including the machine's core count", () => {
    expect(workerCount(null, "6", CORES)).toBe(6);
    expect(workerCount(null, "8", CORES)).toBe(8);
  });

  it("refuses a variable that is not a whole number from 1 to the cores, naming it and the count", () => {
    for (const bad of ["abc", "2.5", "0", "-1", "9"]) {
      expect(() => workerCount(null, bad, CORES)).toThrow(CliError);
      expect(() => workerCount(null, bad, CORES)).toThrow(
        new RegExp(`^BACKTEST_WORKERS must be a whole number from 1 to 8 \\(this machine's core count\\), got "${bad}"`),
      );
    }
  });

  it("lets --workers override the variable, on the same range", () => {
    expect(workerCount("2", "6", CORES)).toBe(2);
    expect(workerCount("3", "nonsense", CORES)).toBe(3);
    expect(() => workerCount("9", "6", CORES)).toThrow(/^--workers must be a whole number from 1 to 8/);
    expect(() => workerCount("0", undefined, CORES)).toThrow(/^--workers .* got "0"/);
  });

  it("refuses spellings Number() reads as a whole number — hex, a trailing .0, an exponent", () => {
    for (const bad of ["0x4", "4.0", "1e0"]) {
      expect(() => workerCount(null, bad, CORES)).toThrow(new RegExp(`^BACKTEST_WORKERS .* got "${bad}"`));
      expect(() => workerCount(bad, undefined, CORES)).toThrow(new RegExp(`^--workers .* got "${bad}"`));
    }
  });
});

describe("parseArgs --workers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("resolves BACKTEST_WORKERS on walk-forward and lift, against os.availableParallelism", () => {
    vi.spyOn(os, "availableParallelism").mockReturnValue(4);
    vi.stubEnv("BACKTEST_WORKERS", "3");
    expect(parseArgs("walk-forward", MINIMAL).workers).toBe(3);
    expect(parseArgs("lift", MINIMAL).workers).toBe(3);
    expect(parseArgs("walk-forward", [...MINIMAL, "--workers", "4"]).workers).toBe(4);
    vi.stubEnv("BACKTEST_WORKERS", "5");
    expect(() => parseArgs("walk-forward", MINIMAL)).toThrow(/BACKTEST_WORKERS .* from 1 to 4/);
  });

  it("is 1 when BACKTEST_WORKERS is unset", () => {
    vi.stubEnv("BACKTEST_WORKERS", undefined);
    expect(parseArgs("walk-forward", MINIMAL).workers).toBe(1);
  });

  it("refuses --workers on run and labels, which have nothing to fan out", () => {
    expect(() => parseArgs("run", [...MINIMAL, "--workers", "2"])).toThrow(
      /--workers applies to walk-forward and lift only/,
    );
    expect(() => parseArgs("labels", [...MINIMAL, "--workers", "2"])).toThrow(
      /--workers applies to walk-forward and lift only/,
    );
  });

  it("refuses --workers on book and parity-day, whose own parsers know no such flag", () => {
    expect(() =>
      parseBookArgs(["--account", "1", "--from", "2025-06-02", "--to", "2025-06-06", "--workers", "2"]),
    ).toThrow(/Unknown flag "--workers"/);
    expect(() => parseParityArgs(["--workers", "2"], new Date("2026-10-12T20:30:00.000Z"))).toThrow(
      /Unknown flag "--workers"/,
    );
  });

  it("leaves run and labels at one worker whatever BACKTEST_WORKERS says", () => {
    vi.stubEnv("BACKTEST_WORKERS", "not a number");
    expect(parseArgs("run", MINIMAL).workers).toBe(1);
  });
});
