/**
 * The day-ahead regime label, engine-side: the nightly job that fills
 * `regime_days` during the CME maintenance break, and the lazy fill for a
 * session day the nightly run did not reach.
 *
 * **Nothing here gates anything.** The label is observed and not obeyed — it
 * lands on `regime_days`, on the trade row at entry, on a Discord line and on
 * a board chip — and no entry is refused because of it. `withRegimeGate`
 * exists in [regime/gate.ts](../regime/gate.ts) and stays unlifted until the
 * validation study says the gate ships.
 *
 * **The warmup comes off the Parquet archive and only the archive, and this
 * is the one engine path that reads it.** The classifier needs 275 completed
 * session days; no broker on this platform holds a year of 1m bars, and the
 * one that was asked for it served about a month and truncated silently
 * ([bugs.md](../../../../docs/bugs.md) A81). So the read is `fetchArchiveBars`
 * — the same cache, over the same coverage predicate, that the backtest CLI's
 * `loadCacheBars` builds its session days from. **No broker fallback and no
 * chained tail belongs here:** two readers splicing different vendors onto the
 * same span build the same session day from different bars, which is parity
 * case 5 in [backtest.md](../../../../docs/modules/trading/backtest.md).
 *
 * The rule the engine keeps is the one that matters: **no decision-time path
 * touches the cache.** This job runs on a clock, off the tick, and the tick
 * never awaits it. See `docs/modules/market-data/providers.md`.
 *
 * A stateful controller for the same reason `engine-watchdog.ts` is one: the
 * per-ticker attempt memory and the two report throttles below are written
 * here and read nowhere else.
 */
import type { ArchiveBarsOutcome, ArchiveBound } from "@/lib/data/cached-bars";
import type { TickerSymbol } from "@/lib/trading/domain";
import type { LogCategory, Severity } from "@/lib/logging/vocabulary";
import { contractSpecForTicker } from "@/lib/trading/contracts/contract-specs";
import {
  CLASSIFIER_MIN_SESSION_DAYS,
  CLASSIFIER_VERSION,
  CLASSIFIER_WARMUP_SESSION_DAYS,
  UNKNOWN_LABEL,
  classifyRegime,
  unknownRegime,
  type RegimeResult,
} from "@/lib/trading/regime/classify-regime";
import { etDateKey } from "@/lib/trading/session/session-utils";
import { buildSessionDays } from "@/lib/trading/regime/session-days";
import {
  addCalendarDays,
  etParts,
  sessionDateOf,
  sessionEndUtc,
  sessionStartUtc,
  shiftSessionDatesBack,
} from "@/lib/trading/regime/session-dates";
import {
  getRegimeDay,
  upsertRegimeDay,
  type RegimeDay,
  type RegimeDaySource,
} from "@/lib/db/regime-days";

/**
 * How often the nightly job checks whether it is inside its window. It does
 * nothing at all outside it — one `Intl` read and a map lookup — so the
 * cadence only bounds how late the labels land, and five minutes is well
 * inside the hour-long break.
 */
export const REGIME_NIGHTLY_INTERVAL_MS = 300_000;

/**
 * The CME maintenance break is 17:00–18:00 ET; the job runs from five past.
 * The five minutes are not decoration — the last completed day session ended
 * at 16:00 ET and the provider's tail has to have published it, and starting
 * on the hour would race the session boundary `sessionDateOf` draws at 17:00.
 */
export const NIGHTLY_WINDOW_START_MINUTES_ET = 17 * 60 + 5;
export const NIGHTLY_WINDOW_END_MINUTES_ET = 18 * 60;

/**
 * Weekdays walked back beyond the classifier's need, because
 * `shiftSessionDatesBack` skips weekends and not holidays — so N weekdays
 * back spans *fewer* than N completed sessions, and the shortfall is silent:
 * the classifier answers `unknown` and nothing says why.
 *
 * **It is the whole margin now, since the count-based extension is gone**
 * (A81), so it is sized against every reason a weekday produces no row over
 * the thirteen months this spans: ~11 full CME closures, plus the ~5
 * quarterly expiries where `.c.0` drops the day session entirely
 * ([bugs.md](../../../../docs/bugs.md) A61), plus the session or two the
 * archive is behind under Databento's embargo. Thirty leaves about a
 * fortnight of slack on that, and the shortfall is reported with its counts
 * when it binds anyway.
 */
export const WARMUP_WEEKDAY_SLACK = 30;

/**
 * How long a failed lazy fill waits before trying again. A failure here is a
 * read of thirteen months of Parquet, so retrying every bar would put that
 * read on the box once a minute for the rest of the session.
 */
export const LAZY_RETRY_MS = 900_000;

/**
 * Lazy fills a session day gets before the controller stops asking, **for a
 * miss that could come out differently next time.**
 *
 * A bound the archive itself named — no cache mounted, nothing cached for the
 * symbol, coverage that starts after the window — is settled on the first
 * attempt instead and never spends this, because asking a fixed archive the
 * same question is the retry A81 was made of. What is left for the budget is
 * the genuinely transient miss: a read that threw, or a window the archive
 * covers and could not fill. Three is enough to ride those out; past that the
 * session is left `unknown` with one line saying so. The budget is per session
 * day — the attempt slot is replaced whole when the date rolls — and the
 * nightly pass labels the *next* session, so nothing retries the abandoned
 * one. That is the honest outcome: nothing is gated on the label, and a trade
 * in that session is stamped `unknown`.
 */
export const MAX_LAZY_FILL_ATTEMPTS = 3;

const MINUTES_PER_HOUR = 60;

/** One archive read: a cache symbol and the window the warmup needs. */
export interface ArchiveRead {
  cacheSymbol: string;
  from: Date;
  to: Date;
}

export interface RegimeLabelDeps {
  /** Tickers the engine is managing right now, in the app's `/MNQ` spelling.
   *  Read at call time — the deployment set changes under a running job. */
  tickers: () => TickerSymbol[];
  /** `fetchArchiveBars` — the Parquet cache, and only the cache. Bound rather
   *  than imported so a test can answer without a filesystem, and so the one
   *  archive read in the engine is visible at the wiring. It answers with the
   *  bound it hit rather than a short array, which is the whole fix for
   *  A81. */
  readArchiveBars: (read: ArchiveRead) => Promise<ArchiveBarsOutcome>;
  /** Under the engine sentinel: the job names no deployment and no contract. */
  logEvent: (event: string, message: string) => void;
  log: (severity: Severity, category: LogCategory, message: string) => void;
  /** Posts the nightly line. Best-effort: a Discord failure must not stop the
   *  labels being written. */
  announce: (sessionDate: string, labels: readonly LabelledTicker[]) => Promise<void>;
  now?: () => Date;
}

export interface LabelledTicker {
  ticker: string;
  result: RegimeResult;
}

interface TickerAttempt {
  sessionDate: string;
  /** Stop asking: a real label is in hand, the archive named a bound that
   *  cannot move under this process, or the attempt budget is spent. */
  settled: boolean;
  attemptedAt: number;
  attempts: number;
  inFlight: boolean;
}

/** What the fill settled on, for the lazy path's budget. `settled` is true
 *  when asking again cannot produce a different answer. */
interface FillOutcome {
  result: RegimeResult;
  settled: boolean;
}

export class RegimeLabelController {
  private readonly deps: RegimeLabelDeps;

  /**
   * One slot per ticker, replaced whole when the session date rolls. A map
   * keyed on `(ticker, sessionDate)` would grow one entry a day forever on a
   * process that runs 24/7; keying on the ticker alone bounds it at the
   * instrument count, and the only question ever asked of it is about the
   * session day currently in play.
   */
  private readonly attempts = new Map<string, TickerAttempt>();

  /**
   * The archive bound last announced per ticker, with the ET date it was
   * announced on — an unmounted cache, an unbackfilled symbol, coverage that
   * starts after the warmup. Each stands until an operator changes
   * something, so a line per session is the alarm nobody reads on the day it
   * matters; **a line a day is the floor, not silence.** A process with
   * `--restart unless-stopped` runs for weeks, and a bound announced once for
   * the life of it is a condition an operator can only find by scrolling back
   * to the restart. `engine-session-guard.ts`'s `calendarReportedOn` is the
   * same shape — keyed on `etDateKey(now)`, so it is once per ET day in
   * memory and a restart re-says today's line.
   *
   * The entry is dropped on a successful *read* — a read that got bars, label
   * or not — so a healed archive announces the next bound it hits rather than
   * staying silent under the old one.
   */
  private readonly reportedBound = new Map<string, { bound: ArchiveBound; on: string }>();

  /**
   * The last shortfall *answer* announced per ticker: the `(completed,
   * newest-row)` pair.
   *
   * The transient lane assumes tomorrow's read can come out differently, and
   * for a thin stretch or a mid-refresh read it can. It cannot for the
   * archive this box actually has: the coverage predicate is min-side only
   * and `BarSourceCoverage` is an extent rather than a density, so a symbol
   * with an interior hole — the normal state of a cache being rebuilt after
   * a storage loss — passes `coverage-short` and lands here every
   * session forever. Throttling on the answer keeps the lane honest both
   * ways: a read that came out the same says nothing, and a refresh that
   * added rows moves the pair and says it again.
   */
  private readonly reportedShortfall = new Map<string, string>();

  /** The session date the nightly pass last completed, so it fires once per
   *  break rather than once per interval inside it. */
  private lastNightlyFor: string | null = null;

  /**
   * One fill at a time across the whole controller, both paths.
   *
   * The nightly pass serialises its tickers for a stated reason — three
   * concurrent multi-hundred-megabyte reads on a shared VM is the shape that
   * has hung this box before — and the lazy path would otherwise defeat it:
   * an engine restarted mid-session evaluates every managed instrument's first
   * bar in the same second, and each unlabelled ticker would start its own
   * fill. A fill in progress **defers** the next rather than joining it; the
   * deferred one comes back on the next bar or the next interval, and nothing
   * here is on a deadline.
   */
  private fillInFlight = false;

  constructor(deps: RegimeLabelDeps) {
    this.deps = deps;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * The label for a session day as it stands on disk, or null when nothing
   * has been written for it. **A synchronous read on purpose** — the entry
   * path stamps this on the trade row and may not await a bar fetch there.
   * Null means unlabelled, and the trade row records that as unlabelled
   * rather than as `unknown`, which is a label the classifier emits.
   */
  labelFor(ticker: string, sessionDate: string): RegimeDay | null {
    const spec = contractSpecForTicker(ticker);
    if (spec == null) return null;
    return getRegimeDay(spec.ticker, sessionDate, CLASSIFIER_VERSION);
  }

  /**
   * The lazy path: called from the tick with the bar it just evaluated.
   *
   * **It never awaits and never throws into its caller.** A fill is a bar
   * read of a year of history; parking the tick loop behind one is exactly
   * what the "no decision-time path touches the cache" rule exists to
   * prevent. In practice the first evaluation of a session day is the 18:00
   * ET bar, hours before any day-session playbook can take an entry, so the
   * row is there by the time anything wants to stamp it — and when it is not,
   * the trade is stamped unlabelled and nothing is gated.
   *
   * The whole body is guarded for the reason the skipped-signal writers are:
   * `sessionDateOf` reaches `Intl.formatToParts`, which throws on a bar
   * timestamp it cannot parse, and a label nobody is gated on must not turn a
   * healthy tick into a `deployment_tick_failed` over a live position.
   */
  noteBar(ticker: TickerSymbol, barTimestamp: string): void {
    try {
      this.noteBarInner(ticker, barTimestamp);
    } catch (err) {
      this.deps.log(
        "debug",
        "system",
        `Regime lazy fill could not be scheduled for ${ticker} at ${barTimestamp}: ${messageOf(err)}`,
      );
    }
  }

  private noteBarInner(ticker: TickerSymbol, barTimestamp: string): void {
    const spec = contractSpecForTicker(ticker);
    if (spec == null) return;

    const sessionDate = sessionDateOf(new Date(barTimestamp));
    const nowMs = this.now().getTime();
    const prior = this.attempts.get(spec.ticker);
    const attempt =
      prior != null && prior.sessionDate === sessionDate
        ? prior
        : { sessionDate, settled: false, attemptedAt: 0, attempts: 0, inFlight: false };
    this.attempts.set(spec.ticker, attempt);

    if (attempt.settled || attempt.inFlight) return;
    if (attempt.attemptedAt > 0 && nowMs - attempt.attemptedAt < LAZY_RETRY_MS) return;

    const existing = getRegimeDay(spec.ticker, sessionDate, CLASSIFIER_VERSION);
    if (existing != null && existing.label !== UNKNOWN_LABEL) {
      attempt.settled = true;
      return;
    }

    // Deferred, not queued, and deliberately without stamping the backoff:
    // this ticker gets its turn on the next bar it evaluates.
    if (this.fillInFlight) return;

    attempt.attemptedAt = nowMs;
    attempt.attempts += 1;
    attempt.inFlight = true;
    this.fillInFlight = true;
    void this.fill(ticker, sessionDate, "lazy")
      .then((outcome) => {
        attempt.settled = outcome.settled;
      })
      .catch((err) => {
        // `fill` names the bounds it was *given*; a read that **threw** — a
        // torn Parquet during the 17:30 refresh, an ENOENT on a remounted
        // NAS — reaches no line of its own, and a throw is one of only two
        // paths that can now reach the retry budget. Without this, the cause
        // surfaces as "gave up after 3 attempts": a count with no cause,
        // which is what A81 was filed as.
        //
        // Nothing is written for it, unlike the nightly pass, which writes
        // an `unknown` row on the same failure so its announce line can name
        // every instrument. Here the session stays *unlabelled*, which is
        // what a trade row in it records — a distinct and more honest answer
        // from `unknown`, and one a later fill heals just as readily.
        this.deps.logEvent(
          "regime_label_failed",
          `Regime label for ${spec.ticker} ${sessionDate} — the archive read threw on attempt ` +
            `${attempt.attempts} of ${MAX_LAZY_FILL_ATTEMPTS}: ${messageOf(err)}. The session stays ` +
            `unlabelled until a later fill; nothing is gated on the label.`,
        );
      })
      .finally(() => {
        attempt.inFlight = false;
        this.fillInFlight = false;
        if (!attempt.settled && attempt.attempts >= MAX_LAZY_FILL_ATTEMPTS) {
          attempt.settled = true;
          this.deps.logEvent(
            "regime_label_failed",
            `Regime label for ${spec.ticker} ${sessionDate} gave up after ${attempt.attempts} attempts — ` +
              `this session stays unknown; the next one gets a fresh budget. Nothing is gated on the label.`,
          );
        }
      });
  }

  /**
   * The nightly pass. Fires once inside the CME maintenance break, labels the
   * next session for every ticker the engine is managing, and posts the line.
   *
   * **Cost, because this is the expensive thing the engine does:** one
   * archive read of up to fourteen months of 1m bars per ticker, serially,
   * once a day, inside the hour the market is closed. That is the one or two
   * Parquet year files the span touches, parsed twice — once for the coverage
   * extent and once for the bars — so a few seconds of CPU and a few hundred
   * MB transient per instrument. Tickers are labelled one at a time
   * deliberately — three
   * concurrent multi-hundred-megabyte reads on a shared VM is the shape that
   * has hung this box before — and `fillInFlight` extends that bound over the
   * lazy path, which would otherwise start one fill per ticker in the same
   * second on a mid-session restart.
   */
  async runNightlyPass(): Promise<void> {
    const now = this.now();
    if (!isInsideNightlyWindow(now)) return;

    const sessionDate = nextSessionDate(now);
    if (this.lastNightlyFor === sessionDate) return;

    // Nothing to label is not the same as having laboured: an engine with no
    // managed deployments at 17:05 must still label the ones activated at
    // 17:40. The stamp goes down only once there is work, and it goes down
    // before the first `await` — which is also what keeps a pass slower than
    // the interval from being re-entered into a second concurrent history
    // read.
    const tickers = uniqueSpecTickers(this.deps.tickers());
    if (tickers.length === 0) return;
    // A lazy fill holds the box. Nothing is stamped, so the next interval
    // inside the break runs the pass in full.
    if (this.fillInFlight) return;
    this.lastNightlyFor = sessionDate;

    const labels: LabelledTicker[] = [];
    this.fillInFlight = true;
    try {
      for (const { ticker, specTicker } of tickers) {
        try {
          const { result } = await this.fill(ticker, sessionDate, "nightly");
          labels.push({ ticker, result });
        } catch (err) {
          // One instrument's failure must not cost the others their labels,
          // and it must not drop the instrument out of the line either — an
          // instrument silently absent is the one an operator reads as fine.
          // The `unknown` is written rather than left unwritten so it says the
          // label is unavailable and so a lazy fill can heal it.
          const result = unknownRegime();
          upsertRegimeDay({ ticker: specTicker, sessionDate, result, source: "nightly" });
          labels.push({ ticker, result });
          this.deps.logEvent(
            "regime_label_failed",
            `Regime label for ${specTicker} ${sessionDate} failed: ${messageOf(err)} — written as unknown`,
          );
        }
      }
    } finally {
      this.fillInFlight = false;
    }

    if (labels.length === 0) return;
    this.deps.logEvent(
      "regime_labelled",
      `Regime labels for ${sessionDate}: ${labels.map((l) => `${l.ticker} ${l.result.label}`).join(", ")}`,
    );
    try {
      await this.deps.announce(sessionDate, labels);
    } catch (err) {
      this.deps.log(
        "warn",
        "system",
        `Regime label announcement failed: ${messageOf(err)} — the labels are written`,
      );
    }
  }

  /**
   * Read, classify, persist. The one implementation both paths run through,
   * which is the only reason a nightly label and a lazy one are the same
   * claim — and the same claim the CLI computes off the same archive.
   *
   * **One read, decided once.** The archive's extent is knowable, so it is
   * asked inside the read and answered as a named bound rather than as a
   * short array; there is nothing left for a second, wider request to
   * discover. The count-based extension that used to sit here is deleted
   * with A81 rather than re-pointed at the cache: it was gated on *our*
   * request limit, which a truncating provider never reached, so it asked
   * again for the set it already had, three times a session, forever.
   */
  private async fill(
    ticker: TickerSymbol,
    sessionDate: string,
    source: RegimeDaySource,
  ): Promise<FillOutcome> {
    const spec = contractSpecForTicker(ticker);
    if (spec == null) {
      throw new Error(`no contract spec for ${ticker}; the classifier has no day session to measure`);
    }

    const warmupFrom = shiftSessionDatesBack(
      sessionDate,
      CLASSIFIER_WARMUP_SESSION_DAYS + WARMUP_WEEKDAY_SLACK,
    );
    const outcome = await this.deps.readArchiveBars({
      cacheSymbol: spec.cacheSymbol,
      from: sessionStartUtc(warmupFrom),
      to: sessionEndUtc(sessionDate),
    });

    if (outcome.kind === "unavailable") {
      const result = unknownRegime();
      upsertRegimeDay({ ticker: spec.ticker, sessionDate, result, source });
      this.reportBound(spec.ticker, sessionDate, outcome.bound, outcome.detail);
      return { result, settled: true };
    }
    // Cleared on a read that returned bars, which is not the same as a label
    // landing: the archive answered, so whatever bound it hit before is over.
    this.reportedBound.delete(spec.ticker);

    const days = buildSessionDays({
      bars: outcome.bars,
      daySession: spec.daySession,
      tickSize: spec.tickSize,
    });
    // `days` is ascending, so the count of rows strictly before `sessionDate`
    // *is* that session's index — whether or not the day itself has produced
    // a partial row yet. The classifier reads `days[targetIndex − 1]` and
    // earlier, so a partial row for the session being labelled is never read
    // and the label is the same one computed the evening before.
    const completed = days.filter((d) => d.sessionDate < sessionDate).length;
    const result = classifyRegime(days, completed);
    upsertRegimeDay({ ticker: spec.ticker, sessionDate, result, source });

    if (result.label === UNKNOWN_LABEL) {
      // The transient lane: the archive covers the window, so this is a
      // session-level miss — a stretch thinned by holidays and the quarterly
      // expiries `.c.0` drops, a read taken mid-refresh, or a hole the
      // min-side coverage predicate cannot see — and each of those can come
      // out differently tomorrow. The pair it is throttled on is what says
      // whether it did: the completed count and the newest row read are also
      // what separate a thin archive from a stale one.
      //
      // The count is reported against the classifier's cliff, not against the
      // window the fetch is sized with: 262 of 275 reads as short when 262
      // would have labelled.
      const newest = completed > 0 ? days[completed - 1].sessionDate : "none";
      this.reportShortfall(
        spec.ticker,
        `${completed}:${newest}`,
        `Regime label for ${spec.ticker} ${sessionDate} is unknown — ${spec.cacheSymbol} covers the warmup ` +
          `window from ${warmupFrom} but produced ${completed} completed session days before it, ` +
          `${CLASSIFIER_MIN_SESSION_DAYS} needed for a label (newest is ${newest}). Nothing is gated on the ` +
          `label; a later fill replaces it.`,
      );
      return { result, settled: false };
    }
    this.reportedShortfall.delete(spec.ticker);
    return { result, settled: true };
  }

  /**
   * A bound the archive named, said once per ticker per ET day.
   *
   * Every one of these stands until an operator mounts a cache, backfills a
   * symbol or widens the archive, so a line a session is three a day that
   * nothing can act on differently the second time — and a line once per
   * process is weeks of silence on a box that restarts rarely. A day is the
   * interval the condition can actually change on.
   */
  private reportBound(
    specTicker: string,
    sessionDate: string,
    bound: ArchiveBound,
    detail: string,
  ): void {
    const today = etDateKey(this.now());
    const reported = this.reportedBound.get(specTicker);
    if (reported != null && reported.bound === bound && reported.on === today) return;
    this.reportedBound.set(specTicker, { bound, on: today });
    this.deps.logEvent(
      "regime_label_failed",
      `Regime label for ${specTicker} ${sessionDate} is unknown — the bar archive cannot serve the ` +
        `classifier's ${CLASSIFIER_WARMUP_SESSION_DAYS}-session warmup: ${bound}, ${detail}. Every session ` +
        `stays unknown until that changes and this is said once a day, not per session. Nothing is gated on the label.`,
    );
  }

  /**
   * A shortfall the archive could not be blamed for, said once per distinct
   * answer.
   *
   * `answer` is the `(completed, newest-row)` pair the read came back with.
   * Two sessions that produce the same pair are the same fact said twice —
   * the archive did not move — and on a partially-backfilled symbol that is
   * every session from here on. A refresh that adds rows changes the pair,
   * and the line comes back with it.
   */
  private reportShortfall(specTicker: string, answer: string, message: string): void {
    if (this.reportedShortfall.get(specTicker) === answer) return;
    this.reportedShortfall.set(specTicker, answer);
    this.deps.logEvent("regime_label_failed", message);
  }
}

/** ET minutes since midnight, for the break-window test. */
function etMinutesOf(at: Date): number {
  const p = etParts(at);
  return p.hour * MINUTES_PER_HOUR + p.minute;
}

export function isInsideNightlyWindow(at: Date): boolean {
  const minutes = etMinutesOf(at);
  return minutes >= NIGHTLY_WINDOW_START_MINUTES_ET && minutes < NIGHTLY_WINDOW_END_MINUTES_ET;
}

/**
 * The session the break is about to open. Inside 17:00–18:00 ET,
 * `sessionDateOf` still answers the session that just closed, so the next one
 * is the following calendar day — walked forward over the weekend, because
 * Friday's break opens Monday's session.
 */
export function nextSessionDate(at: Date): string {
  let cursor = addCalendarDays(sessionDateOf(at), 1);
  while (isWeekendSessionDate(cursor)) cursor = addCalendarDays(cursor, 1);
  return cursor;
}

const SATURDAY = 6;
const SUNDAY = 0;

function isWeekendSessionDate(sessionDate: string): boolean {
  const [y, m, d] = sessionDate.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === SATURDAY || dow === SUNDAY;
}

/** Managed tickers deduped on the spec spelling the table is keyed on, with
 *  anything the contract table has no row for dropped — there is no day
 *  session to measure it over. Both spellings are carried because the pass
 *  needs each: the app's `/MNQ` to resolve a contract and to name the
 *  instrument on the line, the spec's `MNQ` to key `regime_days`. */
function uniqueSpecTickers(
  tickers: readonly TickerSymbol[],
): Array<{ ticker: TickerSymbol; specTicker: string }> {
  const seen = new Set<string>();
  const out: Array<{ ticker: TickerSymbol; specTicker: string }> = [];
  for (const ticker of tickers) {
    const spec = contractSpecForTicker(ticker);
    if (spec == null || seen.has(spec.ticker)) continue;
    seen.add(spec.ticker);
    out.push({ ticker, specTicker: spec.ticker });
  }
  return out;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
