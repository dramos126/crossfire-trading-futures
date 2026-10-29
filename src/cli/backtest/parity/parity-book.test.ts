import { describe, expect, it } from "vitest";

import type { StrategyTrade } from "@/lib/db/trade-types";
import type { BookBlockedRecord } from "@/lib/trading/backtest-book";
import {
  bookCounts,
  compareBook,
  renderBookSummary,
  type BookCellCompare,
  type BookParityLogLine,
  type BookTradeRow,
} from "./parity-book";
import { findLiveLegs } from "./parity-day";
import type { PlaybookNames } from "../playbook-label";

const SESSION = "2026-10-09";
const BAR_1000 = "2026-10-09T14:00:00.000Z";
const BAR_1100 = "2026-10-09T15:00:00.000Z";
const CELLS = [
  { deploymentId: "dep-a", strategyKey: "orb", ticker: "/MNQ" },
  { deploymentId: "dep-b", strategyKey: "ema", ticker: "/MNQ" },
];

function live(fields: Partial<StrategyTrade>): StrategyTrade {
  return {
    id: 1,
    deploymentId: "dep-a",
    accountId: 7,
    strategyKey: "orb",
    ticker: "/MNQ",
    side: 0,
    status: "closed",
    signalBarTs: BAR_1000,
    entrySubmittedAt: BAR_1000,
    entryPrice: 25000,
    exitReasonCode: "take_profit",
    paramSnapshot: null,
    ...fields,
  } as StrategyTrade;
}

function book(fields: Partial<BookTradeRow>): BookTradeRow {
  return {
    tradeId: 1,
    deploymentId: "dep-a",
    signalBarTs: BAR_1000,
    sessionDate: SESSION,
    side: 0,
    entryPrice: 25000,
    exitReason: "take_profit",
    contested: false,
    releaseSensitive: false,
    endOfData: false,
    ...fields,
  };
}

function legsOf(trades: StrategyTrade[]) {
  return findLiveLegs({ sessionDate: SESSION, trades, skips: [], priorActive: null });
}

/** The book section for account 7, as a compared account renders. */
function summaryOf(cells: BookCellCompare[]): string {
  const line: BookParityLogLine = {
    mode: "book",
    sessionDate: SESSION,
    accountId: 7,
    status: "compared",
    refusal: null,
    cells: CELLS.map((c) => c.deploymentId),
    liveLegs: [],
    runDir: null,
    activeSource: "prior_state",
    phaseSeedSource: "first_live_trade",
    ...bookCounts(cells),
    liveNotClosed: 0,
    barTail: null,
    seamWarnings: [],
    snapshotTakenAt: null,
    gitSha: null,
    gitDirty: null,
    generatedAt: "2026-10-09T21:15:00.000Z",
  };
  return renderBookSummary({ sessionDate: SESSION, outcomes: [{ accountId: 7, line, cells }], names: NAMES });
}

/** `ema` and `vwap` are left out: a key with no loaded module reads as itself. */
const NAMES: PlaybookNames = new Map([["orb", "Opening Range Breakout — MNQ"]]);

describe("compareBook", () => {
  it("reads a live entry the book gave to another cell as an order difference, naming the block", () => {
    const block: BookBlockedRecord = {
      deploymentId: "dep-b",
      strategyKey: "ema",
      ticker: "/MNQ",
      signalBarTs: BAR_1000,
      sessionDate: SESSION,
      gate: "contract_held",
      holderDeploymentId: "dep-a",
      contested: true,
      releaseSensitive: false,
    };
    // Live: ema took the bar. Book: orb took it and ema was refused.
    const cells = compareBook({
      cells: CELLS,
      trades: [book({})],
      blocked: [block],
      legs: legsOf([live({ id: 9, deploymentId: "dep-b", strategyKey: "ema" })]),
    });

    const ema = cells.find((c) => c.deploymentId === "dep-b");
    expect(ema?.orderDifferences.map((d) => [d.live.tradeId, d.block.holderDeploymentId])).toEqual([[9, "dep-a"]]);
    expect(ema?.extra).toEqual([]);
    expect(bookCounts(cells)).toMatchObject({ orderDifferences: 1, extra: 0, contestedDifferences: 1 });
    // Both cells by the app's name — the holder too — never by key.
    expect(summaryOf(cells)).toContain(
      "Order difference: live went long on ema — MNQ (deployment …ep-b) on the 10:00 ET bar (trade 9), where the " +
        "book did not: blocked by Opening Range Breakout — MNQ (deployment …ep-a), which held the contract (contract_held)",
    );
    expect(summaryOf(cells)).not.toContain("orb.MNQ");
  });

  it("excuses a release-sensitive book entry live did not take, and leaves end-of-data closes out of the join", () => {
    const cells = compareBook({
      cells: CELLS,
      trades: [
        book({ tradeId: 1, releaseSensitive: true }),
        book({ tradeId: 2, signalBarTs: BAR_1100, endOfData: true, exitReason: "end_of_data" }),
      ],
      blocked: [],
      legs: legsOf([]),
    });

    expect(bookCounts(cells)).toMatchObject({ missed: 0, excused: 1, endOfData: 1, matched: 0 });
    const orb = cells.find((c) => c.deploymentId === "dep-a");
    expect(orb?.compare.backtestOnly.map((r) => r.tradeId)).toEqual([1]);
  });

  it("leaves a live entry on a bar whose book trade ran out of data out of the join, said plainly", () => {
    const cells = compareBook({
      cells: CELLS,
      trades: [book({ tradeId: 2, signalBarTs: BAR_1100, endOfData: true, exitReason: "end_of_data" })],
      blocked: [],
      legs: legsOf([live({ id: 9, signalBarTs: BAR_1100 })]),
    });

    expect(bookCounts(cells)).toMatchObject({ extra: 0, endOfData: 1, liveNotCompared: 1 });
    const orb = cells.find((c) => c.deploymentId === "dep-a");
    expect(orb?.notCompared.map((n) => [n.live.tradeId, n.reason])).toEqual([[9, "book_end_of_data"]]);
    expect(summaryOf(cells)).toContain(
      "1 of Opening Range Breakout — MNQ (deployment …ep-a)'s book trade was still open when the bars ran out, so not compared. " +
        "Live trade 9 on the same bar was not compared either.",
    );
    expect(summaryOf(cells)).not.toMatch(/Extra entry/);
  });

  it("says a live leg the book did not hold was not in the book, not that it entered extra", () => {
    const cells = compareBook({
      cells: CELLS,
      trades: [],
      blocked: [],
      legs: legsOf([live({ id: 9, deploymentId: "dep-x", strategyKey: "vwap" })]),
    });

    const vwap = cells.find((c) => c.deploymentId === "dep-x");
    expect(vwap).toMatchObject({ inBook: false, extra: [] });
    expect(bookCounts(cells)).toMatchObject({ extra: 0, liveNotCompared: 1 });
    expect(summaryOf(cells)).toContain(
      "vwap — MNQ (deployment …ep-x) was live in the session, but this playbook was not in the book, so its " +
        "live trade 9 was not compared.",
    );
    expect(summaryOf(cells)).not.toMatch(/Extra entry/);
  });

  it("still calls a book entry neither order nor timing could move a missed entry", () => {
    const cells = compareBook({ cells: CELLS, trades: [book({})], blocked: [], legs: legsOf([]) });
    expect(bookCounts(cells)).toMatchObject({ missed: 1, excused: 0 });
  });
});
