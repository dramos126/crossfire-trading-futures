import { ORDER_TYPE_LABELS } from "@/lib/brokers/types";
import { CODE_BOOKS, type CodeBook } from "@/lib/trading/books/code-books";
import { FULL_RISK_PERCENT } from "@/lib/trading/orders/risk-sizer";
import { INDICATOR_LABELS, TIMEFRAME_LABELS } from "@/lib/trading/domain";
import type {
  CalibrationConstant,
  CalibrationRange,
  MainSession,
  PlaybookAdmission,
  StrategyIntent,
  StrategyModule,
} from "@/lib/trading/strategy-types";
import {
  minimumRiskNotice,
  minimumRiskOf,
  minimumRiskStamp,
} from "@/components/playbook/playbook-minimum-risk";

/**
 * What `/playbooks` and `/playbooks/[key]` render — the pure half.
 *
 * Same split as `board-model.ts` and `book-grid-model.ts`. The screen it
 * serves answers one question — *what is this playbook and why is it shaped
 * this way* — so nothing here knows about deployments, accounts, money or the
 * engine. It reads three declarations off a module (`intent`, `calibration`,
 * `admission`) and turns them into rows.
 *
 * **Display only, and that is a pinned guarantee rather than a convention.**
 * Nothing in this file branches on a declaration to decide what may run, what
 * may be armed or what may be deployed; `strategy-types.test.ts` scans source
 * for every reader of the three fields and fails on one that is not a display
 * surface.
 *
 * **One module for both surfaces, because the list row *is* the detail's
 * header.** `buildPlaybookHeader` produces the same shape a row draws and the
 * detail page titles itself with, so the two cannot disagree about a
 * playbook's name, instrument or session.
 */

// ── The header, shared by the row and the detail ────────────────────

/** Timezones spelled the way a trader says them. An IANA name a trader would
 *  not say out loud falls through verbatim rather than being abbreviated on a
 *  guess. */
const TIMEZONE_LABELS: Record<string, string> = {
  "America/New_York": "ET",
};

/** What a playbook *is*, before any measurement. Every field is off
 *  `config`, so a module declaring neither calibration nor admission still
 *  fills this whole shape. */
export interface PlaybookHeader {
  key: string;
  name: string;
  version: string;
  description: string | null;
  /** `config.calibratedFor`, or null for a module that declares no
   *  instrument — unrestricted, not unknown. */
  instrument: string | null;
  timeframeLabel: string;
  /** `09:30–15:55 ET`. */
  sessionLabel: string;
  entryTypeLabel: string;
  /** Deduped, period-bearing — see `indicatorChips`. */
  indicatorChips: string[];
  /** `config.intent`, verbatim, for `IntentBadges`. Guidance only — see
   *  `StrategyConfig.intent`'s doc comment. */
  intent: ReadonlyArray<StrategyIntent>;
  /** Stamped by the loader, never derived from the key. */
  isTest: boolean;
  /** The admission stamp, or null when the module declares no admission. */
  stamp: AdmissionStamp | null;
  /**
   * The smallest risk per trade that takes one contract, for a playbook that
   * declares a fixed stop — its stamp and the callout's informational reading.
   * This page holds no account, so it never takes the warn reading
   * (`playbook-minimum-risk.ts`). Null when nothing is declared.
   */
  minimumRisk: { stamp: string; text: string } | null;
  /** True when no cell of any book in code carries this key — see `inNoBook`. */
  inNoBook: boolean;
}

/**
 * Whether no book this build defines carries the playbook, on any contract.
 *
 * Keyed on the playbook alone: a cell on a contract other than `calibratedFor`
 * still puts it in a book. A test fixture follows the same rule — it is in no
 * book, and saying so beside its own stamp is true rather than redundant.
 */
export function inNoBook(key: string, books: readonly CodeBook[] = CODE_BOOKS): boolean {
  return !books.some((book) => book.cells.some((cell) => cell.strategyKey === key));
}

/**
 * Chip labels for a playbook's indicators.
 *
 * **The Strategies list used to read `EMA EMA`.** The chip row mapped
 * `INDICATOR_LABELS[ind.type]` over each *instance*, so EMA Crossover's fast
 * and slow EMA both rendered as the bare type. Two fixes were on the table —
 * dedupe by type, or show the period — and this does both, in that order of
 * preference: a period is strictly more informative than a deduped chip, and
 * dedupe is what catches the case where two instances of a type genuinely
 * carry no distinguishing param.
 *
 * The period key is read as `period` and falls back to the sole numeric
 * param when there is exactly one, because not every indicator spells its
 * window the same way. Two params and no `period` means no number is
 * unambiguously *the* window, so the chip stays bare rather than guessing.
 */
export function indicatorChips(
  indicators: readonly { type: string; params: Record<string, number> }[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ind of indicators) {
    const label = INDICATOR_LABELS[ind.type as keyof typeof INDICATOR_LABELS] ?? ind.type;
    const period = periodOf(ind.params);
    const chip = period != null ? `${label} ${period}` : label;
    if (seen.has(chip)) continue;
    seen.add(chip);
    out.push(chip);
  }
  return out;
}

function periodOf(params: Record<string, number>): number | null {
  if (typeof params.period === "number") return params.period;
  const numbers = Object.values(params).filter((v) => typeof v === "number");
  return numbers.length === 1 ? numbers[0] : null;
}

export function sessionLabel(session: MainSession): string {
  const zone = TIMEZONE_LABELS[session.timezone] ?? session.timezone;
  return `${session.start}–${session.end} ${zone}`;
}

export function buildPlaybookHeader(
  key: string,
  module: StrategyModule,
  books: readonly CodeBook[] = CODE_BOOKS,
): PlaybookHeader {
  const config = module.config;
  return {
    key,
    name: config.name,
    version: module.version,
    description: config.description?.trim() || null,
    instrument: config.calibratedFor ?? null,
    timeframeLabel: TIMEFRAME_LABELS[config.timeframe],
    sessionLabel: sessionLabel(config.session),
    entryTypeLabel: ORDER_TYPE_LABELS[config.entryType],
    indicatorChips: indicatorChips(config.indicators),
    intent: config.intent ?? [],
    isTest: module.isTest === true,
    stamp: config.admission ? admissionStamp(config.admission) : null,
    minimumRisk: minimumRiskHeader(config),
    inNoBook: inNoBook(key, books),
  };
}

function minimumRiskHeader(config: StrategyModule["config"]): PlaybookHeader["minimumRisk"] {
  const min = minimumRiskOf(config);
  // No account, so no budget and no share to scale it by.
  return min ? { stamp: minimumRiskStamp(min), text: minimumRiskNotice(min, null, FULL_RISK_PERCENT).text } : null;
}

export function buildPlaybookHeaders(
  playbooks: readonly { key: string; module: StrategyModule }[],
  books: readonly CodeBook[] = CODE_BOOKS,
): PlaybookHeader[] {
  return playbooks.map(({ key, module }) => buildPlaybookHeader(key, module, books));
}

// ── The list's filter ───────────────────────────────────────────────

/**
 * Which rows the filter row is showing.
 *
 * Admitted / not admitted rather than the strategies list's deployed /
 * not-deployed: this screen is not about what is running — arming a playbook
 * on an account happens on the Books screen — and *has this cleared a bar* is
 * the question a reading page is actually asked. `not-admitted` holds every
 * other state, including a playbook that declares no admission at all and one
 * whose admission was withdrawn, because both are true answers to it.
 *
 * **It is a view filter and never a gate.** Nothing downstream of this
 * decides what may trade; a retired playbook still runs where it is armed.
 */
export type AdmittedFilter = "all" | "admitted" | "not-admitted";

export function filterPlaybooks(
  rows: readonly PlaybookHeader[],
  opts: { query: string; admitted: AdmittedFilter },
): PlaybookHeader[] {
  const q = opts.query.trim().toLowerCase();
  return rows.filter((r) => {
    const isAdmitted = r.stamp?.status === "admitted";
    if (opts.admitted === "admitted" && !isAdmitted) return false;
    if (opts.admitted === "not-admitted" && isAdmitted) return false;
    if (q === "") return true;
    return (
      r.name.toLowerCase().includes(q) ||
      r.key.toLowerCase().includes(q) ||
      (r.description?.toLowerCase().includes(q) ?? false)
    );
  });
}

/**
 * The line saying what the filter is hiding.
 *
 * An empty list with no explanation reads as *there are no playbooks*, which
 * is the same class of lie as a plausible `$0.00` on the board. It names the
 * count so "filtered everything out" and "nothing is installed" are told
 * apart.
 */
export function describeFiltering(total: number, shown: number): string | null {
  if (total === 0) return null;
  if (shown === total) return null;
  if (shown === 0) return `No playbooks match. ${total} hidden by the filter.`;
  return `${shown} of ${total}`;
}

// ── The admission stamp ─────────────────────────────────────────────

/**
 * The stamp's tone. **There is no `success` arm, deliberately** — on this
 * page green is the board's vocabulary and would claim the engine is doing
 * something, where an admitted playbook may be running on four books or on
 * none.
 */
export type AdmissionTone = "strong" | "warn" | "muted";

export interface AdmissionStamp {
  status: PlaybookAdmission["status"];
  label: string;
  tone: AdmissionTone;
  /** The sentence the stamp carries, decided date interpolated. */
  title: string;
}

const ADMISSION_STAMP_TITLES: Record<PlaybookAdmission["status"], (decidedOn: string) => string> = {
  admitted: (d) => `Cleared its admission gate on ${d}.`,
  candidate: () =>
    "Measured but not yet admitted. It can be armed on a book; its numbers are not final.",
  retired: () => "No longer admitted. It still runs where it is armed.",
};

const ADMISSION_STAMP_TONES: Record<PlaybookAdmission["status"], AdmissionTone> = {
  admitted: "strong",
  candidate: "warn",
  retired: "muted",
};

export function admissionStamp(admission: PlaybookAdmission): AdmissionStamp {
  return {
    status: admission.status,
    label: admission.status.toUpperCase(),
    tone: ADMISSION_STAMP_TONES[admission.status],
    title: ADMISSION_STAMP_TITLES[admission.status](admission.decidedOn),
  };
}

// ── The admission reading ───────────────────────────────────────────

export interface CriterionRow {
  name: string;
  bar: string;
  measured: string;
  verdict: "pass" | "fail" | "open";
  /** `PASS` / `FAIL` / `OPEN`. */
  verdictLabel: string;
}

export interface FoldRow {
  label: string;
  n: number;
  /** `+0.19R`. */
  expectancy: string;
  /** `t 2.14`, or null when the fold publishes no t. */
  t: string | null;
}

export interface AdmissionView {
  stamp: AdmissionStamp;
  decidedOn: string;
  basis: string;
  window: string;
  criteria: CriterionRow[];
  /**
   * `null` is *no per-fold table was published on this basis* and renders as
   * a sentence, never as an empty table: an absent measurement is not a
   * reading that failed to resolve, which is the call the regime chip makes
   * for a session with no label.
   */
  folds: FoldRow[] | null;
  cells: readonly { cell: string; n: number }[] | null;
  runs: readonly { id: string; what: string; verdict: string }[];
  /** True when any criterion was missed. The stamp does not move on it — see
   *  `FAILED_CRITERION_NOTE`. */
  hasMissedCriterion: boolean;
}

export function buildAdmissionView(admission: PlaybookAdmission): AdmissionView {
  return {
    stamp: admissionStamp(admission),
    decidedOn: admission.decidedOn,
    basis: admission.basis,
    window: admission.window,
    criteria: admission.criteria.map((c) => ({
      name: c.name,
      bar: c.bar,
      measured: c.measured,
      verdict: c.verdict,
      verdictLabel: c.verdict.toUpperCase(),
    })),
    folds:
      admission.folds == null
        ? null
        : admission.folds.map((f) => ({
            label: f.label,
            n: f.n,
            expectancy: formatExpectancyR(f.expectancyR),
            t: f.t == null ? null : `t ${f.t.toFixed(2)}`,
          })),
    cells: admission.cells == null || admission.cells.length === 0 ? null : admission.cells,
    runs: admission.runs,
    hasMissedCriterion: admission.criteria.some((c) => c.verdict === "fail"),
  };
}

/**
 * Signed, with trailing zeros trimmed — `+0.19R`, `-0.028R`.
 *
 * Three places is the precision the trader writes these to; trimming keeps a
 * fold table that was recorded to two places from gaining a digit it never
 * measured.
 */
export function formatExpectancyR(r: number): string {
  const body = r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${r >= 0 ? "+" : ""}${body}R`;
}

// ── The calibration constants ───────────────────────────────────────

export interface PlaybookConstantRow {
  name: string;
  /** The landed value, formatted — or `null` when the value *is* the off
   *  state, which the stamp says in words instead. */
  value: string | null;
  /** The range the declaration allows it to move in. */
  rangeLabel: string;
  atOffValue: boolean;
  /** The rationale with its emphasis markers removed — the collapsed row's
   *  line and the row's `title`. */
  rationale: string;
  /** The same rationale as runs of plain and emphasised text. */
  segments: RationaleSegment[];
}

/**
 * Whether a constant sits at its **declared** off value.
 *
 * Read off the range, never off the shape of the value: `rangeOrOff` says
 * null is off, a `choice` carrying null says the same for a constant whose
 * off value is not a number, and a two-cell boolean choice's `false` is the
 * off cell. A plain `range` whose `min` happens to be 0 declares nothing of
 * the kind — `breakBufferTicks` at 0 is a zero-width buffer, not a gate that
 * failed — and stamping it would put *"this gate was measured and did not
 * earn its place"* on a constant that was never a gate.
 */
function isAtOffValue(constant: CalibrationConstant<unknown>): boolean {
  if (constant.value === null) return rangeAdmitsOff(constant.range);
  if (constant.value === false) return isBooleanChoice(constant.range);
  return false;
}

function rangeAdmitsOff(range: CalibrationRange): boolean {
  if (range.kind === "rangeOrOff") return true;
  return range.kind === "choice" && range.options.includes(null);
}

function isBooleanChoice(range: CalibrationRange): boolean {
  return range.kind === "choice" && range.options.every((o) => typeof o === "boolean");
}

function formatCell(option: string | number | boolean | null): string {
  if (option === null) return "off";
  if (typeof option === "boolean") return option ? "on" : "off";
  return String(option);
}

export function formatCalibrationRange(range: CalibrationRange): string {
  switch (range.kind) {
    case "choice":
      return range.options.map(formatCell).join(" | ");
    case "range":
      return `${range.min}–${range.max}`;
    case "rangeOrOff":
      return `${range.min}–${range.max} | off`;
    case "clockRange":
      return `${range.earliestEt}–${range.latestEt} ET`;
  }
}

export function buildConstantRows(
  calibration: Record<string, CalibrationConstant<unknown>> | undefined,
): PlaybookConstantRow[] {
  if (!calibration) return [];
  return Object.entries(calibration).map(([name, constant]) => {
    const atOffValue = isAtOffValue(constant);
    return {
      name,
      value: atOffValue ? null : formatCell(constant.value as string | number | boolean | null),
      rangeLabel: formatCalibrationRange(constant.range),
      atOffValue,
      rationale: stripEmphasis(constant.rationale),
      segments: rationaleSegments(constant.rationale),
    };
  });
}

/**
 * The Constants header's right-hand summary.
 *
 * Both numbers come off the declarations. It deliberately does not count
 * *gates*: which constants are gates is written in the rationales and nowhere
 * in the types, and reading it out of prose would make a reword a data
 * migration — the same reason the admission entry is a typed export rather
 * than the README.
 */
export function describeConstants(rows: readonly PlaybookConstantRow[]): string {
  const off = rows.filter((r) => r.atOffValue).length;
  const head = `${rows.length} constant${rows.length === 1 ? "" : "s"}`;
  return off === 0 ? head : `${head} · ${off} at their off value`;
}

// ── Rationale emphasis ──────────────────────────────────────────────

export interface RationaleSegment {
  text: string;
  emphasis: boolean;
}

/**
 * A rationale split into plain and emphasised runs on its `**` pairs.
 *
 * The trader writes the verdict of each constant in emphasis — *"**tested and
 * rejected, run 2 of 2026-09-07**"* — and that clause is the whole reason a
 * reader opens the row. Rendering the markers literally puts asterisks in the
 * middle of a sentence on a terminal; stripping them silently flattens the
 * one distinction the author made.
 *
 * **An unclosed marker renders plain.** Emphasis nobody closed is a typo, not
 * a claim, and the alternative is a stray tail of a rationale rendered bold
 * because of one stray pair of asterisks.
 */
export function rationaleSegments(rationale: string): RationaleSegment[] {
  const parts = rationale.split("**");
  const unpairedTail = parts.length % 2 === 0;
  return parts
    .map((text, i) => ({
      text,
      emphasis: i % 2 === 1 && !(unpairedTail && i === parts.length - 1),
    }))
    .filter((s) => s.text !== "");
}

export function stripEmphasis(rationale: string): string {
  return rationale.split("**").join("");
}

// ── Copy this surface owns ──────────────────────────────────────────

/** The whole page for a module that has measured nothing. One muted line, no
 *  frame: absence of a measurement is not a reading that failed to resolve. */
export const NO_CALIBRATION_NOTE = "No calibration recorded for this playbook.";

/** Shown in place of the fold strip when the admission entry publishes no
 *  per-fold table. It names the criterion rather than a position or a file. */
export const FOLDS_NOT_PUBLISHED =
  "No per-fold table for this trade set. Where a fold count was measured, it is stated with the criterion it belongs to.";

/** The `off` stamp on a constant sitting at its declared off value. */
export const OFF_STAMP_REASON =
  "This gate was measured and did not earn its place. The reason is in the row.";

/** Beside a missed criterion. The playbook's status is the operator's
 *  decision and this page reports it; it does not re-decide it. */
export const FAILED_CRITERION_NOTE =
  "A bar that was missed is shown as missed. The status beside the name is the decision that was recorded over it.";

export const ADMISSION_HELP =
  "The bar this playbook had to clear before it was allowed on a shelf, written before the measurement ran.\n\n" +
  "Every number is held out — measured on windows the calibration never saw — and net of fees.\n\n" +
  "A bar that was missed is shown as missed. Nothing here is adjusted after the fact.";

export const CONSTANTS_HELP =
  "The values this playbook runs at. They are fixed in code and there is nothing to set — a value that wants to change is a new measurement first.\n\n" +
  "Each one shows the range it is allowed to move in and why it sits where it does.";

export const RUNS_HELP =
  "Every measurement run on this playbook, including the ones that failed. A gate that was rejected is listed so it is not proposed again.";

/**
 * The second block is the board regime chip's sentence **verbatim**, down to
 * saying *strategy* where this page says *playbook*: one claim has one
 * wording, and a third variant of it is the drift the one-constant rule
 * exists to prevent. (Two copies already exist — here and the nightly embed —
 * and they differ by a word; do not add a fourth spelling.)
 */
export const CELLS_HELP =
  "The held-out trade count in each regime cell this playbook claims — what the trade-count bar was measured against.\n\n" +
  "Observed only — no strategy is armed or stood down by the regime yet.";

/**
 * The stamp on a playbook no book carries. It states a fact and asks for
 * nothing: a playbook outside every book is ordinary (a book takes only prod
 * playbooks), so the title says what was checked and names no move.
 */
export const NO_BOOK_STAMP = "in no book";

export const NO_BOOK_TITLE =
  "No book this platform defines includes this playbook, on any contract, so no account runs it as part of a book.";

export const PLAYBOOKS_SUBTITLE =
  "What the platform knows how to trade. Each one is calibrated for one instrument and its numbers are fixed in code — turn it on for an account on the Books screen.";

/**
 * Why a test fixture is stamped.
 *
 * Prose in a description is not a guard — on staging these sit in the same
 * list as deployable playbooks, and the moment that matters is the one where
 * somebody is choosing which to run. Moved verbatim from the retired
 * Strategies list's model; one rule, one wording.
 */
export const TEST_STRATEGY_REASON =
  "Verification fixture — it exists to prove the engine ticks, not to trade. Never deploy it on an account you care about.";
