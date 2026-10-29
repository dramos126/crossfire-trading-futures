/**
 * `parity-day --mode book`'s rules, kept pure: one account's live trades,
 * all legs together, against the book backtest of the same session.
 *
 * The join is `compare`'s, run per deployment — so the key is
 * `(deploymentId, ticker, signalBarTs)` — and then read against the book's
 * `blocked` rows, which is what a per-playbook run cannot do:
 *
 * - a live entry on a bar the book refused that cell (another cell held the
 *   contract, a stale latch, the daily gate) is an **order difference**, not
 *   an extra entry: the book gave the bar to someone else;
 * - a book refusal on a bar live did not enter either is **blocked in the
 *   book**, reported with its holder — the per-playbook run's "missed entry"
 *   on that bar, explained.
 */
import type { BookBlockedRecord } from "@/lib/trading/backtest-book";
import type { AccountGateRefusal } from "@/lib/trading/backtest";
import type { BookActiveSource, BookPhaseSeedSource } from "@/lib/trading/backtest-book-snapshot";
import { contractSpecForTicker } from "@/lib/trading/contracts/contract-specs";
import { etParts } from "@/lib/trading/regime/session-dates";
import type { BarTailRecord } from "../bars";
import {
  compareTrades,
  type BacktestTradeRow,
  type CompareResult,
  type LiveOnlyTrade,
  type LiveTrade,
} from "../commands/compare-command";
import { attachLiveSkipReasons, missedEntries, toLiveTrade, type LiveLeg } from "./parity-day";
import { evidenceMarkdown, settingsChangeNote, type ParityLogsFile } from "./parity-logs";
import { playbookLabel, type PlaybookNames } from "../playbook-label";

export interface BookCellIdentity {
  deploymentId: string;
  strategyKey: string;
  /** As the database spells it, `/MNQ`. */
  ticker: string;
}

export type BookTradeRow = BacktestTradeRow & {
  deploymentId: string;
  contested: boolean;
  releaseSensitive: boolean;
  endOfData: boolean;
};

export interface OrderDifference {
  live: LiveOnlyTrade;
  block: BookBlockedRecord;
}

type BacktestOnlyRow = CompareResult["backtestOnly"][number];

export interface ExcusedEntry {
  row: BacktestOnlyRow;
  contested: boolean;
  releaseSensitive: boolean;
}

/**
 * A closed live trade left out of the join: its playbook was not in the book,
 * or the book's trade on its bar was closed by the bars running out — joined,
 * either would read as an extra entry the book never had the chance to take.
 */
export interface NotComparedLive {
  live: LiveTrade;
  reason: "not_in_book" | "book_end_of_data";
}

export interface BookCellCompare extends BookCellIdentity {
  /** False for a live leg the book did not hold. */
  inBook: boolean;
  compare: CompareResult;
  notCompared: NotComparedLive[];
  /** Book entries with no live row of any status on their bar, that neither
   *  evaluation order nor release timing could have moved. */
  missed: CompareResult["backtestOnly"];
  /** Book entries live did not take that were contested or release-sensitive:
   *  the other order or timing gives the bar away, so they are not a miss. */
  excused: ExcusedEntry[];
  /** Book trades closed by the run running out of bars, left out of the join. */
  endOfData: number;
  /** Live entries the book did not take and did not refuse. */
  extra: LiveOnlyTrade[];
  orderDifferences: OrderDifference[];
  /** Book refusals on bars where live did not enter either. */
  blockedInBook: BookBlockedRecord[];
}

const NOT_JOINED_TICK_SIZE = 1;

/** Every cell the book ran and every live leg, compared deployment by deployment. */
export function compareBook(input: {
  cells: readonly BookCellIdentity[];
  trades: readonly BookTradeRow[];
  blocked: readonly BookBlockedRecord[];
  legs: readonly LiveLeg[];
}): BookCellCompare[] {
  const identities = new Map<string, BookCellIdentity>();
  for (const cell of input.cells) identities.set(cell.deploymentId, cell);
  const bookIds = new Set(identities.keys());
  for (const leg of input.legs) {
    if (!identities.has(leg.deploymentId)) identities.set(leg.deploymentId, leg);
  }
  const legById = new Map(input.legs.map((leg) => [leg.deploymentId, leg]));

  return [...identities.values()].map((cell) => {
    const leg = legById.get(cell.deploymentId) ?? emptyLeg(cell);
    const inBook = bookIds.has(cell.deploymentId);
    // A leg outside the book joins nothing, so no row reaches the tick math.
    const tickSize = inBook ? contractSpecForTicker(cell.ticker)?.tickSize : NOT_JOINED_TICK_SIZE;
    if (tickSize == null) {
      throw new Error(`${cell.ticker} has no contract spec; the book could not have run deployment ${cell.deploymentId}.`);
    }
    const own = input.trades.filter((t) => t.deploymentId === cell.deploymentId);
    // An end-of-data close is no exit live would take; joined, it is an exit
    // disagreement the simulation made up — and the live entry on its bar,
    // joined against nothing, an extra entry it made up.
    const joinable = own.filter((t) => !t.endOfData);
    const endOfDataBars = new Set(own.filter((t) => t.endOfData).map((t) => Date.parse(t.signalBarTs)));
    const notCompared: NotComparedLive[] = [];
    const liveJoined: LiveTrade[] = [];
    for (const live of leg.trades.map(toLiveTrade)) {
      if (!inBook) notCompared.push({ live, reason: "not_in_book" });
      else if (live.signalBarTs != null && endOfDataBars.has(Date.parse(live.signalBarTs))) {
        notCompared.push({ live, reason: "book_end_of_data" });
      } else liveJoined.push(live);
    }
    const byTradeId = new Map(joinable.map((t) => [t.tradeId, t]));
    const compare = attachLiveSkipReasons(
      compareTrades({ records: joinable, live: liveJoined, tickSize }),
      leg.skips,
    );

    const blocks = input.blocked.filter((b) => b.deploymentId === cell.deploymentId);
    const blockAt = new Map<number, BookBlockedRecord>();
    for (const b of blocks) blockAt.set(Date.parse(b.signalBarTs), b);

    const orderDifferences: OrderDifference[] = [];
    const extra: LiveOnlyTrade[] = [];
    for (const live of compare.liveOnly) {
      const block = live.signalBarTs == null ? undefined : blockAt.get(Date.parse(live.signalBarTs));
      if (block != null && live.reason === "no_backtest_entry") orderDifferences.push({ live, block });
      else extra.push(live);
    }

    const liveBars = new Set(
      [...leg.trades, ...leg.unclosed]
        .map((t) => (t.signalBarTs == null ? NaN : Date.parse(t.signalBarTs)))
        .filter(Number.isFinite),
    );
    const missed: BacktestOnlyRow[] = [];
    const excused: ExcusedEntry[] = [];
    for (const row of missedEntries(compare, leg)) {
      const trade = byTradeId.get(row.tradeId);
      if (trade != null && (trade.contested || trade.releaseSensitive)) {
        excused.push({ row, contested: trade.contested, releaseSensitive: trade.releaseSensitive });
      } else {
        missed.push(row);
      }
    }
    return {
      ...identityOf(cell),
      inBook,
      compare,
      notCompared,
      missed,
      excused,
      endOfData: own.length - joinable.length,
      extra,
      orderDifferences,
      blockedInBook: blocks.filter((b) => !liveBars.has(Date.parse(b.signalBarTs))),
    };
  });
}

function identityOf(cell: BookCellIdentity): BookCellIdentity {
  return { deploymentId: cell.deploymentId, strategyKey: cell.strategyKey, ticker: cell.ticker };
}

function emptyLeg(cell: BookCellIdentity): LiveLeg {
  return { ...identityOf(cell), accountId: 0, evidence: [], trades: [], unclosed: [], skips: [] };
}

export interface BookParityLogLine {
  mode: "book";
  sessionDate: string;
  accountId: number;
  status: "compared" | "refused";
  refusal: string | null;
  /** The deployments the book simulated, in evaluation order. */
  cells: string[];
  /** The deployments with live evidence in the session. */
  liveLegs: string[];
  runDir: string | null;
  activeSource: BookActiveSource | null;
  phaseSeedSource: BookPhaseSeedSource | null;
  matched: number;
  missed: number;
  /** Book entries live did not take that order or release timing could move. */
  excused: number;
  extra: number;
  orderDifferences: number;
  blockedInBook: number;
  /** Rows, not contests: the blocked-in-book, order-difference and excused
   *  rows that evaluation order on a shared bar decided. One contest whose
   *  winner and loser both differ from live counts twice. */
  contestedDifferences: number;
  /** Book trades closed by the run running out of bars, not joined. */
  endOfData: number;
  /** Closed live trades left out of the join: on a bar whose book trade ran
   *  out of data, or of a playbook the book did not hold. */
  liveNotCompared: number;
  liveUnjoinable: number;
  liveNotClosed: number;
  exitReasonDisagreements: number;
  avgFillSlippageTicks: number | null;
  worstFillSlippageTicks: number | null;
  /** Per bar series, keyed `ticker|timeframe`. */
  barTail: Record<string, BarTailRecord | null> | null;
  seamWarnings: string[];
  snapshotTakenAt: string | null;
  gitSha: string | null;
  gitDirty: boolean | null;
  generatedAt: string;
}

/** The counts of a compared account's line. */
export function bookCounts(
  compares: readonly BookCellCompare[],
): Pick<
  BookParityLogLine,
  | "matched"
  | "missed"
  | "excused"
  | "extra"
  | "orderDifferences"
  | "blockedInBook"
  | "contestedDifferences"
  | "endOfData"
  | "liveNotCompared"
  | "liveUnjoinable"
  | "exitReasonDisagreements"
  | "avgFillSlippageTicks"
  | "worstFillSlippageTicks"
> {
  const matched = compares.flatMap((c) => c.compare.matched);
  const slippages = matched.map((m) => m.fillSlippageTicks).filter((t): t is number => t != null);
  const sum = (pick: (c: BookCellCompare) => number) => compares.reduce((n, c) => n + pick(c), 0);
  return {
    matched: matched.length,
    missed: sum((c) => c.missed.length),
    excused: sum((c) => c.excused.length),
    extra: sum((c) => c.extra.length),
    orderDifferences: sum((c) => c.orderDifferences.length),
    blockedInBook: sum((c) => c.blockedInBook.length),
    contestedDifferences: sum(
      (c) =>
        c.blockedInBook.filter((b) => b.contested).length +
        c.orderDifferences.filter((d) => d.block.contested).length +
        c.excused.filter((e) => e.contested).length,
    ),
    endOfData: sum((c) => c.endOfData),
    liveNotCompared: sum((c) => c.notCompared.length),
    liveUnjoinable: sum((c) => c.compare.liveUnjoinable.length),
    exitReasonDisagreements: matched.filter((m) => !m.exitReasonAgreement).length,
    avgFillSlippageTicks:
      slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : null,
    worstFillSlippageTicks: slippages.length > 0 ? Math.max(...slippages) : null,
  };
}

export interface BookAccountOutcome {
  accountId: number;
  line: BookParityLogLine;
  /** Null when the account was refused. */
  cells: BookCellCompare[] | null;
}

const SIDE_WORD: Readonly<Record<number, string>> = { 0: "long", 1: "short" };

function etClock(iso: string): string {
  const p = etParts(new Date(iso));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET`;
}

const SEED_WORDS: Readonly<Record<BookPhaseSeedSource, string | null>> = {
  first_live_trade: null,
  account_row:
    "No live trade of the session recorded a current balance, so the phase budget started from the " +
    "snapshot's balance sample, which may be for a later session.",
  none: "No balance was on record, so a phase budget, if the account has one, started from its lowest step.",
};

function blockedReason(
  block: BookBlockedRecord,
  cellsById: ReadonlyMap<string, BookCellIdentity>,
  names: PlaybookNames,
): string {
  const holder = block.holderDeploymentId == null ? null : cellsById.get(block.holderDeploymentId);
  const holderName =
    holder == null ? `deployment …${(block.holderDeploymentId ?? "").slice(-4)}` : playbookLabel(names, holder);
  const words: Readonly<Record<AccountGateRefusal, string>> = {
    contract_held: `blocked by ${holderName}, which held the contract (contract_held)`,
    stale_latch: `blocked by a stale signal left from when ${holderName} held the contract (stale_latch)`,
    daily_pnl: "blocked by the account's daily P&L limit (daily_pnl)",
  };
  const flags: string[] = [];
  if (block.contested) flags.push("contested: both signalled on that bar, so evaluation order decided it");
  if (block.releaseSensitive) flags.push("the holder's exit timing could have freed the contract in time");
  return flags.length === 0 ? words[block.gate] : `${words[block.gate]}; ${flags.join("; ")}`;
}

/** The book section of `summary.md`: every difference, one plain sentence
 *  each, with what live logged around its signal bar under it. */
export function renderBookSummary(input: {
  sessionDate: string;
  outcomes: readonly BookAccountOutcome[];
  logs?: ParityLogsFile | null;
  names: PlaybookNames;
}): string {
  const logs = input.logs ?? null;
  const cellName = (cell: BookCellIdentity): string => playbookLabel(input.names, cell);
  const out: string[] = [`# The book against live, session ${input.sessionDate}`, ""];
  out.push(
    "Each account's playbooks were backtested together, sharing one position per contract and the " +
      "account's daily limit, and compared with all of that account's live trades.",
    "",
  );
  if (logs?.unavailable != null) out.push(logs.unavailable, "");
  for (const { accountId, line, cells } of input.outcomes) {
    out.push(`## Account …${String(accountId).slice(-4)}`, "");
    if (cells == null) {
      out.push(`Not compared: ${line.refusal ?? "no reason recorded"}`, "");
      continue;
    }
    const cellsById = new Map(cells.map((c) => [c.deploymentId, c as BookCellIdentity]));
    out.push(`The book ran ${line.cells.length} playbook${line.cells.length === 1 ? "" : "s"}: ${cells
      .filter((c) => line.cells.includes(c.deploymentId))
      .map(cellName)
      .join(", ")}.`);
    const sentences: string[] = [...line.seamWarnings];
    if (line.activeSource === "session_activity") {
      sentences.push(
        "The book holds only playbooks that traded or skipped in the session: the snapshot's " +
          "record of which were Active does not describe this session. A playbook that ran and did nothing is missing.",
      );
    }
    const seed = line.phaseSeedSource == null ? null : SEED_WORDS[line.phaseSeedSource];
    if (seed != null) sentences.push(seed);
    for (const cell of cells) {
      const name = cellName(cell);
      const evidence = (signalBarTs: string | null) =>
        evidenceMarkdown(logs, { deploymentId: cell.deploymentId, accountId }, signalBarTs);
      const settings = (signalBarTs: string | null, gate: string | null): string[] => {
        const note = settingsChangeNote(logs, accountId, signalBarTs, gate);
        return note == null ? [] : [note];
      };
      if (!cell.inBook) {
        const ids = cell.notCompared.map((n) => n.live.tradeId);
        sentences.push(
          `${name} was live in the session, but this playbook was not in the book, so ` +
            (ids.length === 0
              ? "it was not compared."
              : `its live trade${ids.length === 1 ? "" : "s"} ${ids.join(", ")} ${ids.length === 1 ? "was" : "were"} not compared.`),
        );
        continue;
      }
      for (const row of cell.missed) {
        const skip =
          row.liveSkipReason == null
            ? "and live recorded no skip on that bar."
            : `and live skipped that bar: ${row.liveSkipReason}.`;
        sentences.push(
          `Missed entry: the book went ${SIDE_WORD[row.side] ?? row.side} on ${name} on the ` +
            `${etClock(row.signalBarTs)} bar and live did not, ${skip}`,
          ...settings(row.signalBarTs, null),
          ...evidence(row.signalBarTs),
        );
      }
      for (const { row, contested, releaseSensitive } of cell.excused) {
        const why = [
          contested ? "another playbook signalled on the same contract on that bar, so evaluation order decided it" : null,
          releaseSensitive
            ? "a fill late in that bar may not have reached live by its close, or a fill inside a longer bar may have closed the account's daily limit first"
            : null,
        ].filter((w): w is string => w != null);
        sentences.push(
          `Not a miss: the book went ${SIDE_WORD[row.side] ?? row.side} on ${name} on the ` +
            `${etClock(row.signalBarTs)} bar and live did not, but ${why.join(", and ")}.`,
          ...evidence(row.signalBarTs),
        );
      }
      if (cell.endOfData > 0) {
        const ids = cell.notCompared.filter((n) => n.reason === "book_end_of_data").map((n) => n.live.tradeId);
        sentences.push(
          `${cell.endOfData} of ${name}'s book trade${cell.endOfData === 1 ? " was" : "s were"} still open when ` +
            "the bars ran out, so not compared." +
            (ids.length === 0
              ? ""
              : ` Live trade${ids.length === 1 ? "" : "s"} ${ids.join(", ")} on the same ` +
                `bar${ids.length === 1 ? " was" : "s were"} not compared either.`),
        );
      }
      for (const { live, block } of cell.orderDifferences) {
        sentences.push(
          `Order difference: live went ${SIDE_WORD[live.side] ?? live.side} on ${name} on the ` +
            `${etClock(live.signalBarTs ?? "")} bar (trade ${live.tradeId}), where the book did not: ` +
            `${blockedReason(block, cellsById, input.names)}.`,
          ...settings(live.signalBarTs, block.gate),
          ...evidence(live.signalBarTs),
        );
      }
      for (const row of cell.extra) {
        const at = row.signalBarTs == null ? "an unknown bar" : `the ${etClock(row.signalBarTs)} bar`;
        sentences.push(
          `Extra entry: live went ${SIDE_WORD[row.side] ?? row.side} on ${name} on ${at} ` +
            `(trade ${row.tradeId}) ` +
            (row.reason === "duplicate_signal_bar"
              ? "a second time on a bar the book entered once."
              : "and the book did not."),
          ...settings(row.signalBarTs, null),
          ...evidence(row.signalBarTs),
        );
      }
      for (const block of cell.blockedInBook) {
        sentences.push(
          `Neither entered ${name} on the ${etClock(block.signalBarTs)} bar: in the book it was ` +
            `${blockedReason(block, cellsById, input.names)}.`,
          ...settings(block.signalBarTs, block.gate),
          ...evidence(block.signalBarTs),
        );
      }
      for (const row of cell.compare.liveUnjoinable) {
        sentences.push(`Live trade ${row.tradeId} has no signal bar recorded, so it could not be matched.`);
      }
      for (const row of cell.compare.matched) {
        const before = sentences.length;
        if (!row.exitReasonAgreement) {
          sentences.push(
            `Exit disagreement on ${name}'s ${etClock(row.signalBarTs)} entry: live exited on ` +
              `${row.liveExitReason ?? "an unrecorded reason"}, the book on ${row.backtestExitReason}.`,
          );
        }
        if (row.fillSlippageTicks != null && row.fillSlippageTicks !== 0) {
          const ticks = Math.abs(row.fillSlippageTicks);
          sentences.push(
            `Slippage on ${name}'s ${etClock(row.signalBarTs)} entry: live filled ${ticks} ` +
              `tick${ticks === 1 ? "" : "s"} ${row.fillSlippageTicks > 0 ? "worse" : "better"} than the book's signal-bar close.`,
          );
        }
        if (sentences.length > before) sentences.push(...evidence(row.signalBarTs));
      }
    }
    if (line.liveNotClosed > 0) {
      sentences.push(
        `${line.liveNotClosed} live trade${line.liveNotClosed === 1 ? " is" : "s are"} not closed and ` +
          "not compared; the playbook section names them.",
      );
    }
    const matched = line.matched;
    out.push(
      sentences.length === 0
        ? matched === 0
          ? "No differences: neither live nor the book entered."
          : `No differences: ${matched} entr${matched === 1 ? "y" : "ies"} matched, with the same exit reasons and no slippage.`
        : `${matched} entr${matched === 1 ? "y" : "ies"} matched.`,
      ...sentences,
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}
