import { describe, it, expect } from "vitest";

import type { StrategyTrade } from "@/lib/db/trade-types";
import type { SkippedSignalRow } from "@/lib/db/skipped-signals";
import type { BarData } from "@/lib/brokers/types";
import { CONTRACT_SPECS } from "@/lib/trading/contracts/contract-specs";
import { compareTrades } from "../commands/compare-command";
import type { BarTailRecord } from "../bars";
import { CliError, DayRefusal } from "../cli-error";
import {
  SEAM_GAP_FLAG_TICKS,
  assertSessionHasBars,
  attachLiveSkipReasons,
  defaultParityDate,
  findLiveLegs,
  judgeSnapshot,
  mergeParityLog,
  missedEntries,
  parseParityArgs,
  renderSummary,
  playbookSizingSettingsFromTrades,
  riskSizingFromTrades,
  seamWarning,
  setAsideBeforeCreation,
  toLiveTrade,
  type ParityLogLine,
} from "./parity-day";
import { parseDbInstant } from "@/lib/trading/backtest-book-snapshot";

const SESSION = "2026-10-09"; // a Friday
const MNQ = CONTRACT_SPECS.MNQ;

function trade(fields: Partial<StrategyTrade>): StrategyTrade {
  return {
    id: 1,
    deploymentId: "dep-a",
    accountId: 7,
    strategyKey: "orb",
    ticker: "/MNQ",
    side: 0,
    signalBarTs: "2026-10-09T13:45:00.000Z",
    entrySubmittedAt: "2026-10-09T13:45:02.000Z",
    entryPrice: 25000,
    exitReasonCode: "take_profit",
    paramSnapshot: null,
    status: "closed",
    ...fields,
  } as StrategyTrade;
}

function skip(fields: Partial<SkippedSignalRow>): SkippedSignalRow {
  return {
    id: 1,
    recordedAt: "2026-10-09T14:00:01.000Z",
    signalBarTs: "2026-10-09T14:00:00.000Z",
    sessionDate: SESSION,
    deploymentId: "dep-b",
    groupId: "g",
    accountId: 7,
    strategyKey: "tom-hold",
    ticker: "/MNQ",
    source: "strategy",
    gate: "vwap",
    reason: "price under session VWAP",
    detail: null,
    ...fields,
  };
}

describe("findLiveLegs — 'was live' comes from the rows, never from current status", () => {
  it("lists a leg for a session trade and one for a session skip, and nothing else", () => {
    const legs = findLiveLegs({
      sessionDate: SESSION,
      trades: [
        trade({}),
        // The prior session's trade on another leg: not live in this one.
        trade({ id: 2, deploymentId: "dep-c", signalBarTs: "2026-10-08T14:00:00.000Z" }),
      ],
      skips: [skip({}), skip({ deploymentId: "dep-d", sessionDate: "2026-10-08" })],
      priorActive: null,
    });
    expect(legs.map((l) => [l.deploymentId, l.evidence])).toEqual([
      ["dep-a", ["trade"]],
      ["dep-b", ["skip"]],
    ]);
  });

  it("puts a trade whose signal bar is after 18:00 ET in the next session", () => {
    // 22:30Z on Oct 8 is 18:30 ET — session Oct 9.
    const legs = findLiveLegs({
      sessionDate: SESSION,
      trades: [trade({ signalBarTs: "2026-10-08T22:30:00.000Z" })],
      skips: [],
      priorActive: null,
    });
    expect(legs).toHaveLength(1);
  });

  it("falls back to the submit time, read as UTC, on a row with no signal bar", () => {
    expect(parseDbInstant("2026-10-09 13:45:02").toISOString()).toBe("2026-10-09T13:45:02.000Z");
    const legs = findLiveLegs({
      sessionDate: SESSION,
      trades: [trade({ signalBarTs: null, entrySubmittedAt: "2026-10-09 13:45:02" })],
      skips: [],
      priorActive: null,
    });
    expect(legs).toHaveLength(1);
  });

  it("adds a quiet leg the pre-scrub status names, and unions the evidence", () => {
    const legs = findLiveLegs({
      sessionDate: SESSION,
      trades: [trade({})],
      skips: [],
      priorActive: [
        { deploymentId: "dep-a", accountId: 7, strategyKey: "orb", ticker: "/MNQ" },
        { deploymentId: "dep-q", accountId: 7, strategyKey: "structure-break", ticker: "/MNQ" },
      ],
    });
    expect(legs.map((l) => [l.deploymentId, l.evidence])).toEqual([
      ["dep-a", ["prior_status", "trade"]],
      ["dep-q", ["prior_status"]],
    ]);
    expect(legs[1].trades).toEqual([]);
  });
});

describe("defaultParityDate", () => {
  it("is today's session once its day session has closed", () => {
    // 16:30 EDT Monday Oct 12.
    expect(defaultParityDate(new Date("2026-10-12T20:30:00.000Z"))).toBe("2026-10-12");
  });

  it("is the previous weekday's session before the close, and Friday over a weekend", () => {
    expect(defaultParityDate(new Date("2026-10-12T19:00:00.000Z"))).toBe("2026-10-09");
    expect(defaultParityDate(new Date("2026-10-10T15:00:00.000Z"))).toBe("2026-10-09");
    // Sunday 19:00 EDT is Monday's session, still open.
    expect(defaultParityDate(new Date("2026-10-11T23:00:00.000Z"))).toBe("2026-10-09");
  });
});

describe("parseParityArgs", () => {
  const now = new Date("2026-10-12T20:30:00.000Z");

  it("defaults to the session that just closed and marks it as the latest", () => {
    expect(parseParityArgs([], now)).toMatchObject({
      date: "2026-10-12",
      isLatestSession: true,
      modes: ["playbook", "book"],
      cpuTarget: 100,
    });
    expect(parseParityArgs(["--date", "2026-10-09"], now).isLatestSession).toBe(false);
  });

  it("runs one mode when --mode names it, and refuses any other", () => {
    expect(parseParityArgs(["--mode", "book"], now).modes).toEqual(["book"]);
    expect(parseParityArgs(["--mode=playbook"], now).modes).toEqual(["playbook"]);
    expect(() => parseParityArgs(["--mode", "both"], now)).toThrow(/--mode must be one of playbook, book/);
  });
});

describe("assertSessionHasBars — an empty or unfinished session is a refusal", () => {
  const bar = (iso: string): BarData => ({
    timestamp: iso,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  });

  it("refuses a session with no bars", () => {
    expect(() =>
      assertSessionHasBars([bar("2026-10-08T19:55:00.000Z")], SESSION, MNQ, 5),
    ).toThrow(CliError);
  });

  it("refuses a session whose bars stop before the close, as the whole day's refusal", () => {
    expect(() =>
      assertSessionHasBars([bar("2026-10-09T16:00:00.000Z")], SESSION, MNQ, 5),
    ).toThrow(/not complete/);
    expect(() =>
      assertSessionHasBars([bar("2026-10-09T16:00:00.000Z")], SESSION, MNQ, 5),
    ).toThrow(DayRefusal);
  });

  it("accepts a session whose last bar closes at the day-session end", () => {
    // 15:55 EDT is the last 5m bar of a 16:00 close.
    expect(() =>
      assertSessionHasBars([bar("2026-10-09T19:55:00.000Z")], SESSION, MNQ, 5),
    ).not.toThrow();
  });

  it("measures an early-close session against the exchange's halt", () => {
    // Thanksgiving 2026-11-26 halts at 13:00 ET; 12:55 EST is 17:55Z.
    expect(() =>
      assertSessionHasBars([bar("2026-11-26T17:55:00.000Z")], "2026-11-26", MNQ, 5),
    ).not.toThrow();
  });
});

describe("attachLiveSkipReasons", () => {
  it("gives a backtest-only entry the live skip on the same signal bar, and null without one", () => {
    const result = compareTrades({
      records: [
        {
          tradeId: 1,
          signalBarTs: "2026-10-09T14:00:00.000Z",
          sessionDate: SESSION,
          side: 0,
          entryPrice: 25000,
          exitReason: "stop_loss",
        },
        {
          tradeId: 2,
          signalBarTs: "2026-10-09T15:00:00.000Z",
          sessionDate: SESSION,
          side: 1,
          entryPrice: 25010,
          exitReason: "take_profit",
        },
      ],
      live: [],
      tickSize: MNQ.tickSize,
    });
    const attached = attachLiveSkipReasons(result, [
      // Another spelling of the same instant.
      skip({ signalBarTs: "2026-10-09T14:00:00+00:00" }),
      skip({ id: 2, signalBarTs: "2026-10-09T14:00:00.000Z", gate: "risk_budget", reason: "stop too wide" }),
    ]);
    expect(attached.backtestOnly.map((r) => r.liveSkipReason)).toEqual([
      "vwap: price under session VWAP; risk_budget: stop too wide",
      null,
    ]);
  });
});

describe("riskSizingFromTrades", () => {
  it("reads the budget the live entry was sized from, and null when no row carries one", () => {
    expect(
      riskSizingFromTrades([
        trade({ paramSnapshot: null }),
        trade({ paramSnapshot: { maxRiskPerTradeUsd: 350, maxContracts: 3 } }),
      ]),
    ).toEqual({ mode: "risk", maxRiskPerTradeUsd: 350, maxContracts: 3 });
    expect(riskSizingFromTrades([trade({ paramSnapshot: { size: 2 } })])).toBeNull();
  });
});

describe("playbookSizingSettingsFromTrades", () => {
  const sized = { maxRiskPerTradeUsd: 350, maxContracts: 3 };

  it("reads the cap and share the live entry was sized with, off the same snapshot as the budget", () => {
    expect(
      playbookSizingSettingsFromTrades([
        trade({ paramSnapshot: { playbookMaxContracts: 2, playbookRiskPercent: 80 } }),
        trade({
          paramSnapshot: {
            ...sized,
            playbookMaxContracts: 1,
            playbookRiskPercent: 50,
            appliedPlaybookMaxContracts: 1,
            appliedPlaybookRiskPercent: 50,
          },
        }),
      ]),
    ).toEqual({ playbookMaxContracts: 1, playbookRiskPercent: 50 });
  });

  it("reads a snapshot from before the settings, or the first cut's null cap, as no playbook limit", () => {
    expect(playbookSizingSettingsFromTrades([trade({ paramSnapshot: sized })])).toEqual({
      playbookMaxContracts: 0,
      playbookRiskPercent: 100,
    });
    expect(
      playbookSizingSettingsFromTrades([trade({ paramSnapshot: { ...sized, playbookMaxContracts: null } })]),
    ).toEqual({ playbookMaxContracts: 0, playbookRiskPercent: 100 });
  });

  it("is null when no trade recorded a budget", () => {
    expect(playbookSizingSettingsFromTrades([trade({ paramSnapshot: { playbookMaxContracts: 1 } })])).toBeNull();
  });
});

describe("mergeParityLog — a re-run replaces the date's lines", () => {
  const line = (sessionDate: string, deploymentId: string): ParityLogLine => ({
    mode: "playbook",
    sessionDate,
    deploymentId,
    accountId: 7,
    strategyKey: "orb",
    ticker: "/MNQ",
    status: "compared",
    refusal: null,
    liveEvidence: ["trade"],
    sizing: null,
    sizingBasis: null,
    postureBasis: null,
    runDir: null,
    matched: 1,
    liveOnly: 0,
    backtestOnly: 0,
    liveUnjoinable: 0,
    liveNotClosed: 0,
    exitReasonDisagreements: 0,
    avgFillSlippageTicks: 0,
    worstFillSlippageTicks: 0,
    barTail: null,
    seamWarning: null,
    snapshotTakenAt: null,
    gitSha: null,
    gitDirty: null,
    generatedAt: "2026-10-09T20:30:00.000Z",
  });
  const playbook = (sessionDate: string) => ({ sessionDate, mode: "playbook" as const });

  it("drops the date's old lines, keeps every other date and any line it cannot read", () => {
    const first = mergeParityLog("", playbook(SESSION), [line(SESSION, "a"), line(SESSION, "b")]);
    const withOther = mergeParityLog(first, playbook("2026-10-08"), [line("2026-10-08", "a")]);
    const rerun = mergeParityLog(`${withOther}not json\n`, playbook(SESSION), [line(SESSION, "a")]);

    const rows = rerun.trim().split("\n");
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.includes(`"sessionDate":"${SESSION}"`))).toHaveLength(1);
    expect(rows).toContain("not json");
  });

  it("keeps the same date's lines of another mode", () => {
    const bookLine = JSON.stringify({ ...line(SESSION, "book-1"), mode: "book" });
    const rerun = mergeParityLog(`${bookLine}\n`, playbook(SESSION), [line(SESSION, "a")]);
    expect(rerun.trim().split("\n")).toEqual([bookLine, JSON.stringify(line(SESSION, "a"))]);
  });
});

describe("judgeSnapshot — a copy taken before the close is refused whole", () => {
  // Session 2026-10-09 (Friday) closes 16:00 EDT = 20:00Z; the next session
  // opens Sunday 2026-10-11 18:00 EDT = 22:00Z.
  const judge = (takenAt: string | null, isLatestSession = true) =>
    judgeSnapshot({ takenAt, sessionDate: SESSION, isLatestSession });

  it("refuses a copy taken before the session closed", () => {
    expect(judge("2026-10-09T19:59:00Z")).toMatchObject({ kind: "refuse" });
    expect(judge("not a time")).toMatchObject({ kind: "refuse" });
  });

  it("trusts the pre-scrub status only between this close and the next open", () => {
    expect(judge("2026-10-09T21:15:00Z")).toEqual({
      kind: "measured",
      takenAt: "2026-10-09T21:15:00.000Z",
      trustPriorStatus: true,
    });
    expect(judge("2026-10-11T21:59:00Z")).toMatchObject({ trustPriorStatus: true });
    expect(judge("2026-10-11T22:00:00Z")).toMatchObject({ kind: "measured", trustPriorStatus: false });
    // The flag about the default date does not override the instant.
    expect(judge("2026-10-12T21:15:00Z", true)).toMatchObject({ trustPriorStatus: false });
  });

  it("falls back to the latest-session rule on a copy with no snapshot_meta", () => {
    expect(judge(null, true)).toEqual({ kind: "measured", takenAt: null, trustPriorStatus: true });
    expect(judge(null, false)).toEqual({ kind: "measured", takenAt: null, trustPriorStatus: false });
  });
});

describe("unclosed live rows are reported by status, never as a missed entry", () => {
  it("keeps a non-closed row out of the join and out of the missed-entry count", () => {
    const [leg] = findLiveLegs({
      sessionDate: SESSION,
      trades: [trade({ id: 9, status: "entry_failed", signalBarTs: "2026-10-09T14:00:00.000Z" })],
      skips: [],
      priorActive: null,
    });
    expect(leg.evidence).toEqual(["trade"]);
    expect(leg.trades).toEqual([]);
    expect(leg.unclosed.map((t) => t.id)).toEqual([9]);

    const compare = compareTrades({
      records: [
        {
          tradeId: 1,
          signalBarTs: "2026-10-09T14:00:00.000Z",
          sessionDate: SESSION,
          side: 0,
          entryPrice: 25000,
          exitReason: "stop_loss",
        },
      ],
      live: leg.trades.map(toLiveTrade),
      tickSize: MNQ.tickSize,
    });
    expect(missedEntries(compare, leg)).toEqual([]);

    const text = renderSummary({
      sessionDate: SESSION,
      usedPriorStatus: false,
      snapshotTakenAt: "2026-10-09T21:15:00.000Z",
      outcomes: [{ leg, compare, line: { refusal: null, seamWarning: null } as ParityLogLine }],
      names: new Map(),
    });
    expect(text).toContain("Live trade 9 on the 10:00 ET bar is entry_failed, not closed, so it is not compared.");
    expect(text).not.toContain("Missed entry");
  });
});

describe("seamWarning", () => {
  const tail = (seam: BarTailRecord["seam"], barCount = 10): BarTailRecord => ({
    source: "topstep",
    contractId: "CON.F.US.MNQ.Z26",
    cacheMaxUtc: "2026-10-08T20:59:00.000Z",
    fromUtc: "2026-10-08T21:00:00.000Z",
    toUtc: "2026-10-09T19:59:00.000Z",
    barCount,
    seam,
  });

  it("flags a contract that differs from the archive's at the seam", () => {
    expect(seamWarning(tail({ cacheMonth: "Z2026", tailMonth: "H2027", gapTicks: 1 }))).toMatch(
      /archive holds Z2026 at the seam and the tail reads H2027/,
    );
  });

  it("flags a jump above the named threshold and not one at it", () => {
    const at = tail({ cacheMonth: "Z2026", tailMonth: "Z2026", gapTicks: SEAM_GAP_FLAG_TICKS });
    const over = tail({ cacheMonth: "Z2026", tailMonth: "Z2026", gapTicks: SEAM_GAP_FLAG_TICKS + 1 });
    expect(seamWarning(at)).toBeNull();
    expect(seamWarning(over)).toMatch(new RegExp(`jumps ${SEAM_GAP_FLAG_TICKS + 1} ticks`));
  });

  it("flags a contract it cannot tell, and says nothing when the tail served no bar", () => {
    expect(seamWarning(tail({ cacheMonth: null, tailMonth: "Z2026", gapTicks: 0 }))).toMatch(/cannot be told/);
    expect(seamWarning(tail({ cacheMonth: "Z2026", tailMonth: "H2027", gapTicks: null }, 0))).toBeNull();
  });
});

describe("renderSummary", () => {
  it("names a missed entry with its live skip, and a refused leg with its reason", () => {
    const [leg, quiet] = findLiveLegs({
      sessionDate: SESSION,
      trades: [],
      skips: [skip({ deploymentId: "dep-a", strategyKey: "orb" }), skip({ deploymentId: "dep-z" })],
      priorActive: null,
    });
    const compare = attachLiveSkipReasons(
      compareTrades({
        records: [
          {
            tradeId: 1,
            signalBarTs: "2026-10-09T14:00:00.000Z",
            sessionDate: SESSION,
            side: 0,
            entryPrice: 25000,
            exitReason: "stop_loss",
          },
        ],
        live: [],
        tickSize: MNQ.tickSize,
      }),
      leg.skips,
    );
    const text = renderSummary({
      sessionDate: SESSION,
      usedPriorStatus: false,
      snapshotTakenAt: null,
      outcomes: [
        { leg, compare, line: { refusal: null, seamWarning: null } as ParityLogLine },
        { leg: quiet, compare: null, line: { refusal: "no risk posture." } as ParityLogLine },
      ],
      names: new Map([["orb", "Opening Range Breakout"]]),
    });
    // The app's name, the contract appended because the name carries none;
    // a key with no loaded module reads as itself.
    expect(text).toContain("## Opening Range Breakout — MNQ (deployment …ep-a)\n");
    expect(text).toContain("## tom-hold — MNQ (deployment …ep-z)\n");
    expect(text).not.toContain("orb.MNQ");
    expect(text).toContain(
      "Missed entry: the backtest went long on the 10:00 ET bar and live did not, and live " +
        "skipped that bar: vwap: price under session VWAP.",
    );
    expect(text).toContain("Not compared: no risk posture.");
    expect(text).toContain("could not be checked that the session had closed before the copy");
  });
});

describe("setAsideBeforeCreation — a playbook created mid-session missed nothing before it existed", () => {
  const BAR_MS = 5 * 60_000;
  const backtestOnly = (signalBarTs: string, tradeId: number) => ({
    tradeId,
    signalBarTs,
    sessionDate: SESSION,
    side: 0,
    entryPrice: 25000,
    exitReason: "stop_loss",
  });
  const compare = compareTrades({
    records: [
      backtestOnly("2026-10-09T14:00:00.000Z", 1),
      // Closes at 14:35, the instant the playbook was created.
      backtestOnly("2026-10-09T14:30:00.000Z", 2),
      backtestOnly("2026-10-09T15:00:00.000Z", 3),
    ],
    live: [],
    tickSize: MNQ.tickSize,
  });

  it("moves the entries on bars that closed before created_at out of backtestOnly", () => {
    const result = setAsideBeforeCreation(compare, "2026-10-09T14:35:00.000Z", BAR_MS);
    expect(result.backtestOnly.map((r) => r.tradeId)).toEqual([2, 3]);
    expect(result.summary.backtestOnly).toBe(2);
    expect(result.beforeCreation).toEqual({
      createdAt: "2026-10-09T14:35:00.000Z",
      entries: [expect.objectContaining({ tradeId: 1 })],
    });
  });

  it("leaves the result alone with no creation time, or one before every bar", () => {
    expect(setAsideBeforeCreation(compare, null, BAR_MS)).toBe(compare);
    expect(setAsideBeforeCreation(compare, "2026-10-08T00:00:00.000Z", BAR_MS)).toBe(compare);
  });

  it("says so in summary.md rather than calling it a missed entry", () => {
    const [leg] = findLiveLegs({
      sessionDate: SESSION,
      trades: [],
      skips: [skip({ deploymentId: "dep-a", strategyKey: "orb" })],
      priorActive: null,
    });
    const text = renderSummary({
      sessionDate: SESSION,
      usedPriorStatus: false,
      snapshotTakenAt: null,
      outcomes: [
        {
          leg,
          compare: setAsideBeforeCreation(compare, "2026-10-09T14:35:00.000Z", BAR_MS),
          line: { refusal: null, seamWarning: null } as ParityLogLine,
        },
      ],
      names: new Map(),
    });
    expect(text).toContain(
      "Not compared: the backtest went long on the 10:00 ET bar, before the playbook was created at " +
        "10:35 ET, so live could not have taken it.",
    );
    expect(text).not.toContain("Missed entry: the backtest went long on the 10:00 ET bar");
    expect(text).toContain("Missed entry: the backtest went long on the 10:30 ET bar");
  });
});
