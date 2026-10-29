/**
 * `parity-day`'s rules, kept pure so each one is pinned by a test: which
 * legs were live, how a leg is sized, which bars count as a finished session,
 * how a live skip attaches to a backtest-only entry, how the running log is
 * rewritten, and the plain-sentence summary. The command that does the I/O is
 * `parity-day-command.ts`.
 */
import type { StrategyTrade } from "@/lib/db/trade-types";
import type { SkippedSignalRow } from "@/lib/db/skipped-signals";
import type { BarData } from "@/lib/brokers/types";
import type { BacktestSizing } from "@/lib/trading/backtest";
import type { AccountRiskBasis } from "@/lib/trading/orders/account-phase-sizer";
import {
  FULL_RISK_PERCENT,
  NO_PLAYBOOK_CONTRACT_CAP,
  PLAYBOOK_MAX_CONTRACTS_PARAM,
  PLAYBOOK_RISK_PERCENT_PARAM,
} from "@/lib/trading/orders/risk-sizer";
import { CONTRACT_SPECS, type ContractSpec } from "@/lib/trading/contracts/contract-specs";
import { exitReasonCodeOf } from "@/lib/logging/exit-reasons";
import { earlyCloseFor } from "@/lib/trading/session/exchange-calendar";
import {
  addCalendarDays,
  etParts,
  etWallClockToUtc,
  sessionDateOf,
  sessionStartUtc,
  shiftSessionDatesBack,
  splitSessionDate,
} from "@/lib/trading/regime/session-dates";
import { DEFAULT_CPU_TARGET_PCT, cpuTarget } from "../args";
import { CliError, DayRefusal } from "../cli-error";
import type { CompareResult, LiveTrade } from "../commands/compare-command";
import type { BarTailRecord } from "../bars";
import { parseSessionDate } from "../session-dates";
import { parseDbInstant } from "@/lib/trading/backtest-book-snapshot";
import { evidenceMarkdown, type ParityLogsFile } from "./parity-logs";
import { playbookLabel, type PlaybookNames } from "../playbook-label";

/**
 * `playbook` runs each live leg alone; `book` runs each account's legs
 * together (docs/proposals/book-backtest.md). With no `--mode` both run, so
 * the daily task is one command. Every log line carries its `mode`.
 */
export const PARITY_MODES = ["playbook", "book"] as const;
export type ParityMode = (typeof PARITY_MODES)[number];

export interface ParityArgs {
  date: string;
  /** True when `date` is the session that just closed — the only session the
   *  snapshot's pre-scrub deployment status describes. */
  isLatestSession: boolean;
  /** In run order; never empty. */
  modes: ParityMode[];
  cpuTarget: number;
}

export function parseParityArgs(argv: string[], now: Date): ParityArgs {
  let date: string | null = null;
  let mode: string | null = null;
  let cpu: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
    if (value == null || value.startsWith("--")) throw new CliError(`Flag "${flag}" needs a value`);
    if (flag === "--date") date = value;
    else if (flag === "--mode") mode = value;
    else if (flag === "--cpu-target") cpu = value;
    else throw new CliError(`Unknown flag "${flag}". parity-day takes --date, --mode and --cpu-target`);
  }
  const parsedMode = mode == null ? null : PARITY_MODES.find((m) => m === mode);
  if (mode != null && parsedMode == null) {
    throw new CliError(`--mode must be one of ${PARITY_MODES.join(", ")}, got "${mode}"`);
  }
  const latest = defaultParityDate(now);
  const resolved = date == null ? latest : parseSessionDate(date, "--date");
  return {
    date: resolved,
    isLatestSession: resolved === latest,
    modes: parsedMode == null ? [...PARITY_MODES] : [parsedMode],
    cpuTarget: cpu == null ? DEFAULT_CPU_TARGET_PCT : cpuTarget(cpu),
  };
}

/** The latest day-session close on the contract table, in ET — after it, the
 *  day's trading is over for every instrument the CLI runs. */
const LATEST_DAY_SESSION_END_ET = Object.values(CONTRACT_SPECS)
  .map((spec) => spec.daySession.end)
  .sort()
  .at(-1) as string;

const SATURDAY = 6;
const SUNDAY = 0;

/**
 * The session that just closed: today's once its day session is over, the
 * previous weekday's before then. A weekend resolves to Friday. The 17:15 ET
 * task (inside the CME halt, for the reason topstep.md's *Sessions and
 * `gatewaylogout`* gives) therefore compares the session whose trading ended
 * an hour ago, not the Globex date that rolls over at 18:00.
 */
export function defaultParityDate(now: Date): string {
  const current = sessionDateOf(now);
  const [y, m, d] = splitSessionDate(current);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const [hh, mm] = LATEST_DAY_SESSION_END_ET.split(":").map(Number);
  const closed = now.getTime() >= etWallClockToUtc(y, m, d, hh, mm).getTime();
  if (weekday === SATURDAY || weekday === SUNDAY || !closed) {
    return shiftSessionDatesBack(current, 1);
  }
  return current;
}

/** Why a leg is on the list. */
export type LiveEvidence = "prior_status" | "trade" | "skip";

export interface LiveLeg {
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  /** As the database spells it, `/MNQ`. */
  ticker: string;
  evidence: LiveEvidence[];
  /** Closed trades whose signal bar (or, before that column, whose submit)
   *  falls in the session — the rows the join compares. */
  trades: StrategyTrade[];
  /** The session's rows in any other status (`entry_failed`, `exit_failed`,
   *  `open`, …): reported with their status, never joined, so a failed entry
   *  never reads as a missed one. */
  unclosed: StrategyTrade[];
  skips: SkippedSignalRow[];
}

const CLOSED_STATUS = "closed";

/** A deployment the snapshot recorded as Active before the scrub paused it. */
export interface PriorActiveRow {
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  ticker: string;
}

/**
 * Every leg that was live in the session, read off what the rows say and never
 * off the snapshot's current status — the scrub pauses every deployment, so
 * current status says nothing about the day.
 *
 * Three sources, unioned: the snapshot's pre-scrub status table (`null` when
 * the snapshot predates it, or when it was not taken between this session's
 * close and the next one's open — see `judgeSnapshot`), a trade row of any
 * status in the session, and a `skipped_signals` row for it. A leg the first
 * source names and the other two do not is a quiet leg, which is exactly the
 * one a missed entry hides in.
 */
export function findLiveLegs(input: {
  sessionDate: string;
  trades: readonly StrategyTrade[];
  skips: readonly SkippedSignalRow[];
  priorActive: readonly PriorActiveRow[] | null;
}): LiveLeg[] {
  const legs = new Map<string, LiveLeg>();
  const legFor = (row: PriorActiveRow, evidence: LiveEvidence): LiveLeg => {
    let leg = legs.get(row.deploymentId);
    if (leg == null) {
      leg = { ...row, evidence: [], trades: [], unclosed: [], skips: [] };
      legs.set(row.deploymentId, leg);
    }
    if (!leg.evidence.includes(evidence)) leg.evidence.push(evidence);
    return leg;
  };

  for (const row of input.priorActive ?? []) legFor(identityOf(row), "prior_status");
  for (const trade of input.trades) {
    if (tradeSessionDate(trade) !== input.sessionDate) continue;
    const leg = legFor(identityOf(trade), "trade");
    (trade.status === CLOSED_STATUS ? leg.trades : leg.unclosed).push(trade);
  }
  for (const skip of input.skips) {
    if (skip.sessionDate !== input.sessionDate) continue;
    legFor(identityOf(skip), "skip").skips.push(skip);
  }
  return [...legs.values()].sort(
    (a, b) =>
      a.strategyKey.localeCompare(b.strategyKey) ||
      a.ticker.localeCompare(b.ticker) ||
      a.deploymentId.localeCompare(b.deploymentId),
  );
}

function identityOf(row: PriorActiveRow): PriorActiveRow {
  return {
    deploymentId: row.deploymentId,
    accountId: row.accountId,
    strategyKey: row.strategyKey,
    ticker: row.ticker,
  };
}

function tradeSessionDate(trade: StrategyTrade): string {
  return sessionDateOf(parseDbInstant(trade.signalBarTs ?? trade.entrySubmittedAt));
}

/** The `compare` join's live row, built from the trade as the export route
 *  builds it: the fill price and the exit-reason *code*. */
export function toLiveTrade(trade: StrategyTrade): LiveTrade {
  return {
    tradeId: trade.id,
    strategyKey: trade.strategyKey,
    ticker: trade.ticker.replace(/^\//, ""),
    side: trade.side,
    signalBarTs: trade.signalBarTs,
    entryPrice: trade.entryPrice,
    exitReason: exitReasonCodeOf(trade.exitReasonCode),
  };
}

export type SizingBasis = "trade_snapshot" | "account_posture";

/**
 * The budget a live entry in this session was sized from, off the trade
 * row's own snapshot — the session budget is fixed at the open, so every
 * entry of the session carries the same pair. Null when no trade in the
 * session recorded one; the caller then reads the account's posture.
 */
export function riskSizingFromTrades(trades: readonly StrategyTrade[]): BacktestSizing | null {
  const sized = sizedSnapshotOf(trades);
  return sized == null ? null : { mode: "risk", maxRiskPerTradeUsd: sized.budget, maxContracts: sized.ceiling };
}

/**
 * The playbook's two sizing settings off the same trade's snapshot, so a
 * `trade_snapshot` run sizes with what the live entry did rather than the
 * deployment row's settings today. A snapshot without them predates the
 * settings, and a `null` cap is the first cut's applied "none" written over
 * the setting; both read as the off values. Null when no trade recorded a
 * budget.
 */
export function playbookSizingSettingsFromTrades(
  trades: readonly StrategyTrade[],
): Record<typeof PLAYBOOK_MAX_CONTRACTS_PARAM | typeof PLAYBOOK_RISK_PERCENT_PARAM, number> | null {
  const sized = sizedSnapshotOf(trades);
  if (sized == null) return null;
  const cap = sized.snapshot[PLAYBOOK_MAX_CONTRACTS_PARAM];
  const share = sized.snapshot[PLAYBOOK_RISK_PERCENT_PARAM];
  return {
    [PLAYBOOK_MAX_CONTRACTS_PARAM]: typeof cap === "number" ? cap : NO_PLAYBOOK_CONTRACT_CAP,
    [PLAYBOOK_RISK_PERCENT_PARAM]: typeof share === "number" ? share : FULL_RISK_PERCENT,
  };
}

function sizedSnapshotOf(
  trades: readonly StrategyTrade[],
): { snapshot: Record<string, unknown>; budget: number; ceiling: number } | null {
  for (const trade of trades) {
    const snapshot = trade.paramSnapshot;
    const budget = snapshot?.maxRiskPerTradeUsd;
    const ceiling = snapshot?.maxContracts;
    if (
      snapshot != null &&
      typeof budget === "number" &&
      budget > 0 &&
      typeof ceiling === "number" &&
      Number.isInteger(ceiling) &&
      ceiling >= 1
    ) {
      return { snapshot, budget, ceiling };
    }
  }
  return null;
}

/** The instant the session's trading ended for `spec` — its day-session end,
 *  or the exchange's early close when that is earlier. */
export function dayCloseUtc(sessionDate: string, spec: ContractSpec): Date {
  const early = earlyCloseFor(sessionDate);
  const end = early != null && early < spec.daySession.end ? early : spec.daySession.end;
  const [y, m, d] = splitSessionDate(sessionDate);
  const [hh, mm] = end.split(":").map(Number);
  return etWallClockToUtc(y, m, d, hh, mm);
}

/** When the session's trading ended for every instrument on the table. */
export function sessionCloseUtc(sessionDate: string): Date {
  const closes = Object.values(CONTRACT_SPECS).map((spec) => dayCloseUtc(sessionDate, spec).getTime());
  return new Date(Math.max(...closes));
}

/** The next weekday session's 18:00 ET open — Sunday evening after a Friday. */
export function nextSessionOpenUtc(sessionDate: string): Date {
  let next = addCalendarDays(sessionDate, 1);
  for (;;) {
    const [y, m, d] = splitSessionDate(next);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (weekday !== SATURDAY && weekday !== SUNDAY) return sessionStartUtc(next);
    next = addCalendarDays(next, 1);
  }
}

/** What the snapshot can be trusted for, from `snapshot_meta.taken_at`. */
export type SnapshotVerdict =
  | { kind: "refuse"; message: string }
  | {
      kind: "measured";
      /** Null on a copy older than `snapshot_meta`. */
      takenAt: string | null;
      /** Whether `snapshot_prior_deployments` describes this session. */
      trustPriorStatus: boolean;
    };

/**
 * A copy taken before the session closed holds a partial day — its trades
 * stop at the copy, and a leg that traded after it reads as a missed entry —
 * so it is refused whole. The pre-scrub status describes the moment of the
 * copy, so it is evidence about this session only when the copy was taken
 * after this session's close and before the next one's open. A copy with no
 * `snapshot_meta` cannot be checked at all; then the status is trusted only
 * for the session that just closed, and the caller says the check was not made.
 */
export function judgeSnapshot(input: {
  takenAt: string | null;
  sessionDate: string;
  isLatestSession: boolean;
}): SnapshotVerdict {
  if (input.takenAt == null) {
    return { kind: "measured", takenAt: null, trustPriorStatus: input.isLatestSession };
  }
  const taken = Date.parse(input.takenAt);
  if (!Number.isFinite(taken)) {
    return {
      kind: "refuse",
      message:
        `The snapshot's snapshot_meta.taken_at reads "${input.takenAt}", which is not an instant, ` +
        `so it cannot be shown to postdate session ${input.sessionDate}. Nothing was recorded.`,
    };
  }
  const close = sessionCloseUtc(input.sessionDate).getTime();
  if (taken < close) {
    return {
      kind: "refuse",
      message:
        `The snapshot was taken at ${new Date(taken).toISOString()}, before session ` +
        `${input.sessionDate} closed at ${new Date(close).toISOString()}, so it holds part of ` +
        `the day. Take a fresh snapshot after the close. Nothing was recorded.`,
    };
  }
  return {
    kind: "measured",
    takenAt: new Date(taken).toISOString(),
    trustPriorStatus: taken < nextSessionOpenUtc(input.sessionDate).getTime(),
  };
}

const MS_PER_MINUTE = 60_000;

/**
 * Refuse a session whose bars do not reach its close. A run over a session
 * with no bars, or one that stops at noon because the tail had not caught up,
 * produces no entries — and recorded, that reads as "live and backtest
 * agreed", which is the one answer this command must never give falsely.
 */
export function assertSessionHasBars(
  bars: readonly BarData[],
  sessionDate: string,
  spec: ContractSpec,
  timeframeMinutes: number,
): void {
  const inSession = bars.filter((bar) => sessionDateOf(new Date(bar.timestamp)) === sessionDate);
  if (inSession.length === 0) {
    throw new DayRefusal(
      `No ${spec.ticker} bars for session ${sessionDate} — a holiday, or the bars are not ` +
        `published yet. Nothing was recorded.`,
    );
  }
  const close = dayCloseUtc(sessionDate, spec).getTime();
  const last = new Date(inSession[inSession.length - 1].timestamp).getTime();
  if (last + timeframeMinutes * MS_PER_MINUTE < close) {
    throw new DayRefusal(
      `${spec.ticker} bars for session ${sessionDate} stop at ` +
        `${new Date(last).toISOString()}, before the ${new Date(close).toISOString()} close — ` +
        `the session is not complete yet. Nothing was recorded.`,
    );
  }
}

/**
 * Give each backtest-only entry the reason the live leg recorded for not
 * taking the same signal bar, joined on the instant (two spellings of one
 * timestamp are one bar). Every gate that refused it is kept.
 */
export function attachLiveSkipReasons(
  result: CompareResult,
  skips: readonly SkippedSignalRow[],
): CompareResult {
  const byInstant = new Map<number, string[]>();
  for (const skip of skips) {
    const at = Date.parse(skip.signalBarTs);
    if (!Number.isFinite(at)) continue;
    const reasons = byInstant.get(at) ?? [];
    reasons.push(`${skip.gate}: ${skip.reason}`);
    byInstant.set(at, reasons);
  }
  return {
    ...result,
    backtestOnly: result.backtestOnly.map((row) => ({
      ...row,
      liveSkipReason: byInstant.get(Date.parse(row.signalBarTs))?.join("; ") ?? null,
    })),
  };
}

export interface ParityLogLine {
  mode: "playbook";
  sessionDate: string;
  deploymentId: string;
  accountId: number;
  strategyKey: string;
  ticker: string;
  status: "compared" | "refused";
  /** Why the leg was not compared; null when it was. */
  refusal: string | null;
  liveEvidence: LiveEvidence[];
  sizing: BacktestSizing | null;
  sizingBasis: SizingBasis | null;
  /** Under `account_posture`, the account-phase sizer's basis for the budget
   *  (`flat`, a bucket, `stale_floor`, …) at the session open, read off the
   *  snapshot's sample — which may be for a later session than this one. */
  postureBasis: AccountRiskBasis | null;
  runDir: string | null;
  matched: number;
  liveOnly: number;
  /** Backtest entries with no live row of any status on their bar. */
  backtestOnly: number;
  liveUnjoinable: number;
  /** Live rows of the session that are not `closed`, not compared. */
  liveNotClosed: number;
  exitReasonDisagreements: number;
  avgFillSlippageTicks: number | null;
  worstFillSlippageTicks: number | null;
  barTail: BarTailRecord | null;
  /** Set when the tail's contract is not the archive's at the seam, or the
   *  price jumps across it by more than `SEAM_GAP_FLAG_TICKS`. */
  seamWarning: string | null;
  /** `snapshot_meta.taken_at`; null when the copy predates that table. */
  snapshotTakenAt: string | null;
  gitSha: string | null;
  /** Tracked files differed from `gitSha` when the run was made. */
  gitDirty: boolean | null;
  generatedAt: string;
}

/**
 * The running log with the `(sessionDate, mode)` lines replaced by `lines`.
 * Re-running a date replaces it rather than appending a second copy, so the
 * monthly review can count lines; a book-mode run of the same date leaves the
 * playbook lines alone. A line that does not parse is not ours to judge and is
 * kept as it was.
 */
export function mergeParityLog(
  existing: string,
  key: { sessionDate: string; mode: ParityMode },
  lines: readonly { sessionDate: string; mode: ParityMode }[],
): string {
  const kept = existing
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => {
      const parsed = logLineKey(line);
      return parsed == null || parsed.sessionDate !== key.sessionDate || parsed.mode !== key.mode;
    });
  return [...kept, ...lines.map((line) => JSON.stringify(line))].map((l) => `${l}\n`).join("");
}

function logLineKey(line: string): { sessionDate: string; mode: string } | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" &&
      parsed !== null &&
      "sessionDate" in parsed &&
      typeof parsed.sessionDate === "string" &&
      "mode" in parsed &&
      typeof parsed.mode === "string"
      ? { sessionDate: parsed.sessionDate, mode: parsed.mode }
      : null;
  } catch {
    return null;
  }
}

/**
 * Ticks of jump across the archive/tail seam above which the line is flagged.
 * Adjacent 1m bars of one contract rarely move this far; a quarterly roll
 * spread on the index micros is several times it.
 */
export const SEAM_GAP_FLAG_TICKS = 80;

export function seamWarning(barTail: BarTailRecord | null): string | null {
  if (barTail == null || barTail.barCount === 0) return null;
  const { cacheMonth, tailMonth, gapTicks } = barTail.seam;
  const problems: string[] = [];
  if (cacheMonth == null || tailMonth == null) {
    problems.push(
      `the contract on one side of the seam cannot be told (archive ${cacheMonth ?? "unknown"}, ` +
        `tail ${tailMonth ?? barTail.contractId})`,
    );
  } else if (cacheMonth !== tailMonth) {
    problems.push(`the archive holds ${cacheMonth} at the seam and the tail reads ${tailMonth}`);
  }
  if (gapTicks != null && gapTicks > SEAM_GAP_FLAG_TICKS) {
    problems.push(`the price jumps ${gapTicks} ticks across it`);
  }
  if (problems.length === 0) return null;
  return `Seam at ${barTail.cacheMaxUtc}: ${problems.join(", and ")}.`;
}

/** The live rows that are not `closed`, by signal-bar instant. */
function unclosedByInstant(leg: LiveLeg): Map<number, StrategyTrade[]> {
  const out = new Map<number, StrategyTrade[]>();
  for (const trade of leg.unclosed) {
    if (trade.signalBarTs == null) continue;
    const at = parseDbInstant(trade.signalBarTs).getTime();
    if (!Number.isFinite(at)) continue;
    out.set(at, [...(out.get(at) ?? []), trade]);
  }
  return out;
}

/** Backtest-only entries with no live row of any status on their bar — the
 *  only ones that are a missed entry. */
export function missedEntries(
  compare: CompareResult,
  leg: LiveLeg,
): CompareResult["backtestOnly"] {
  const unclosed = unclosedByInstant(leg);
  return compare.backtestOnly.filter((row) => !unclosed.has(Date.parse(row.signalBarTs)));
}

/**
 * Backtest-only entries whose signal bar closed before the deployment was
 * created, moved out of `backtestOnly`: live evaluated nothing before then, so
 * they are not a missed entry. The book mode refuses them in the run itself
 * (`BookCellInput.entriesFrom`); a single run has no such hook, so the
 * playbook mode sets them aside here.
 */
export function setAsideBeforeCreation(
  compare: CompareResult,
  createdAt: string | null,
  barMs: number,
): CompareResult {
  const createdMs = createdAt == null ? NaN : Date.parse(createdAt);
  if (createdAt == null || !Number.isFinite(createdMs)) return compare;
  const before = compare.backtestOnly.filter((row) => Date.parse(row.signalBarTs) + barMs < createdMs);
  if (before.length === 0) return compare;
  const backtestOnly = compare.backtestOnly.filter((row) => !before.includes(row));
  return {
    ...compare,
    backtestOnly,
    beforeCreation: { createdAt, entries: before },
    summary: { ...compare.summary, backtestOnly: backtestOnly.length },
  };
}

export interface LegOutcome {
  leg: LiveLeg;
  line: ParityLogLine;
  compare: CompareResult | null;
}

const SIDE_WORD: Readonly<Record<number, string>> = { 0: "long", 1: "short" };

function etClock(iso: string): string {
  const p = etParts(new Date(iso));
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")} ET`;
}

/** `etClock`, with the ET date added when it is not `besideIso`'s — a session
 *  spans two calendar days, so a bare time can read as the wrong one. */
function etClockOnDate(iso: string, besideIso: string): string {
  const p = etParts(new Date(iso));
  const q = etParts(new Date(besideIso));
  if (p.year === q.year && p.month === q.month && p.day === q.day) return etClock(iso);
  const date = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  return `${etClock(iso)} on ${date}`;
}

const EVIDENCE_WORDS:Readonly<Record<LiveEvidence, string>> = {
  prior_status: "it was Active before the snapshot was scrubbed",
  trade: "it has a trade in the session",
  skip: "it recorded a skipped signal in the session",
};

/** `summary.md`: every difference, one plain sentence each, with what live
 *  logged around its signal bar under it when `logs` holds the session. */
export function renderSummary(input: {
  sessionDate: string;
  usedPriorStatus: boolean;
  snapshotTakenAt: string | null;
  outcomes: readonly LegOutcome[];
  logs?: ParityLogsFile | null;
  names: PlaybookNames;
}): string {
  const logs = input.logs ?? null;
  const out: string[] = [`# Live against backtest, session ${input.sessionDate}`, ""];
  if (logs?.unavailable != null) out.push(logs.unavailable, "");
  out.push(
    input.snapshotTakenAt == null
      ? "The snapshot carries no snapshot_meta, so when it was taken is unknown: it could not " +
          "be checked that the session had closed before the copy."
      : `The snapshot was taken at ${input.snapshotTakenAt}, after the session closed.`,
    "",
  );
  out.push(
    input.usedPriorStatus
      ? "A playbook counts as live if it was Active in the snapshot before the scrub paused it, " +
          "or if it has a trade or a skipped signal in the session."
      : "A playbook counts as live if it has a trade or a skipped signal in the session. " +
          "The snapshot's deployment status was not used: the scrub pauses every deployment, " +
          "and this snapshot either carries no record of the status before it or was not taken " +
          "between this session's close and the next one's open. A playbook that ran and did " +
          "nothing is not listed.",
    "",
  );

  for (const { leg, line, compare } of input.outcomes) {
    out.push(`## ${playbookLabel(input.names, leg)}`, "");
    out.push(`Listed because ${leg.evidence.map((e) => EVIDENCE_WORDS[e]).join(", and ")}.`);
    const evidence = (signalBarTs: string | null) => evidenceMarkdown(logs, leg, signalBarTs);
    const unclosed = leg.unclosed.flatMap((trade) => {
      const bar = trade.signalBarTs == null ? null : parseDbInstant(trade.signalBarTs).toISOString();
      const at = bar == null ? "an unknown bar" : `the ${etClock(bar)} bar`;
      return [`Live trade ${trade.id} on ${at} is ${trade.status}, not closed, so it is not compared.`, ...evidence(bar)];
    });
    if (compare == null) {
      out.push(`Not compared: ${line.refusal ?? "no reason recorded"}`, ...unclosed, "");
      continue;
    }
    const sentences: string[] = [];
    if (line.seamWarning != null) sentences.push(line.seamWarning);
    if (line.sizingBasis === "account_posture") {
      sentences.push(
        `No live trade recorded its budget, so the backtest was sized from the account's ` +
          `posture at the session open (sizer basis ${line.postureBasis ?? "unknown"}), read off ` +
          `the snapshot's balance sample, which may be for a later session.`,
      );
    }
    sentences.push(...unclosed);
    const missed = new Set(missedEntries(compare, leg));
    for (const row of compare.backtestOnly) {
      if (!missed.has(row)) {
        sentences.push(
          `The backtest went ${SIDE_WORD[row.side] ?? row.side} on the ${etClock(row.signalBarTs)} ` +
            `bar, where live has a trade that is not closed.`,
        );
        continue;
      }
      const skip =
        row.liveSkipReason == null
          ? "and live recorded no skip on that bar."
          : `and live skipped that bar: ${row.liveSkipReason}.`;
      sentences.push(
        `Missed entry: the backtest went ${SIDE_WORD[row.side] ?? row.side} on the ` +
          `${etClock(row.signalBarTs)} bar and live did not, ${skip}`,
        ...evidence(row.signalBarTs),
      );
    }
    const created = compare.beforeCreation;
    if (created != null) {
      for (const row of created.entries) {
        sentences.push(
          `Not compared: the backtest went ${SIDE_WORD[row.side] ?? row.side} on the ` +
            `${etClock(row.signalBarTs)} bar, before the playbook was created at ` +
            `${etClockOnDate(created.createdAt, row.signalBarTs)}, so live could not have taken it.`,
        );
      }
    }
    for (const row of compare.liveOnly) {
      const at = row.signalBarTs == null ? "an unknown bar" : `the ${etClock(row.signalBarTs)} bar`;
      sentences.push(
        `Extra entry: live went ${SIDE_WORD[row.side] ?? row.side} on ${at} (trade ${row.tradeId}) ` +
          (row.reason === "duplicate_signal_bar"
            ? "a second time on a bar the backtest entered once."
            : "and the backtest did not."),
        ...evidence(row.signalBarTs),
      );
    }
    for (const row of compare.liveUnjoinable) {
      sentences.push(
        `Live trade ${row.tradeId} has no signal bar recorded, so it could not be matched.`,
      );
    }
    for (const row of compare.matched) {
      const before = sentences.length;
      if (!row.exitReasonAgreement) {
        sentences.push(
          `Exit disagreement on the ${etClock(row.signalBarTs)} entry: live exited on ` +
            `${row.liveExitReason ?? "an unrecorded reason"}, the backtest on ${row.backtestExitReason}.`,
        );
      }
      if (row.fillSlippageTicks != null && row.fillSlippageTicks !== 0) {
        const worse = row.fillSlippageTicks > 0;
        sentences.push(
          `Slippage on the ${etClock(row.signalBarTs)} entry: live filled ` +
            `${Math.abs(row.fillSlippageTicks)} tick${Math.abs(row.fillSlippageTicks) === 1 ? "" : "s"} ` +
            `${worse ? "worse" : "better"} than the backtest's signal-bar close.`,
        );
      }
      // Once per entry, under its last sentence: both are about one window.
      if (sentences.length > before) sentences.push(...evidence(row.signalBarTs));
    }
    const matched = compare.summary.matched;
    out.push(
      sentences.length === 0
        ? matched === 0
          ? "No differences: neither live nor the backtest entered."
          : `No differences: ${matched} entr${matched === 1 ? "y" : "ies"} matched, with the ` +
            "same exit reasons and no slippage."
        : `${matched} entr${matched === 1 ? "y" : "ies"} matched.`,
      ...sentences,
      "",
    );
  }
  return `${out.join("\n").trimEnd()}\n`;
}
