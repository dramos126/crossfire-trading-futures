import type { BarData } from "@/lib/brokers/types";
import type { CommonParams, MainSession, PauseWindow, SessionWindow } from "../strategy-types";
import { TRADING_TIMEZONE } from "../strategy-types";
import { etDateKey, minutesInTradingTz } from "./session-utils";

// Formatter used to extract full wall-clock parts in trading tz for CME
// session-boundary math. Separate from the hour+minute formatter behind
// `minutesInTradingTz` (now in `session-utils.ts`) so the hot-path
// `isInSessionWindow` call does not pay the full parts cost.
const cmePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TRADING_TIMEZONE,
  hour12: false,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
});

/** Parse "HH:MM" → minutes since midnight. Returns null if invalid. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

// Defined in `session-utils.ts` beside the day-session predicate that also
// needs it; re-exported here because every existing caller imports it from
// this module.
export { minutesInTradingTz };

interface TradingTzParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  /** 0=Sun, 1=Mon, ... 6=Sat */
  weekday: number;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function tradingTzParts(date: Date): TradingTzParts {
  const parts = cmePartsFormatter.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of parts) lookup[p.type] = p.value;
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    hour: Number(lookup.hour === "24" ? "0" : lookup.hour),
    minute: Number(lookup.minute),
    weekday: WEEKDAY_MAP[lookup.weekday] ?? 0,
  };
}

/**
 * Build a UTC Date that represents a specific wall-clock moment in
 * TRADING_TIMEZONE. Used to project session boundaries ("yesterday at
 * 18:00 ET") into absolute UTC timestamps we can compare against Date.now().
 *
 * Algorithm: construct a naive UTC date at the requested wall-clock, then
 * compute the trading-tz offset for that moment by diffing what Intl says
 * the wall-clock *is*, and shift. Handles DST because the offset is
 * recomputed against the candidate wall-clock, not a fixed value.
 */
function utcForTradingTzWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // First approximation: treat the wall-clock as UTC.
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Ask Intl what trading-tz wall-clock `naive` actually lands on.
  const p = tradingTzParts(new Date(naive));
  const naiveAsTradingTz = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
  // Offset between the two tells us how far off our first approximation was.
  const offsetMs = naive - naiveAsTradingTz;
  return new Date(naive + offsetMs);
}

/**
 * Start of the current CME session (Topstep equity/index-futures convention)
 * for the given instant, returned as an ISO string.
 *
 * CME session rules used here:
 * - Sunday 18:00 ET opens the week.
 * - Mon–Thu: session runs yesterday 18:00 ET → today 17:00 ET, then 60-min
 *   maintenance break, then today 18:00 ET opens the next session.
 * - Fri 17:00 ET closes the week; Sat + Sun-before-18:00 ET have no live
 *   session.
 *
 * Session-PnL semantics: during any "no live session" gap (the 17:00→18:00
 * weekday break, or Fri 17:00 → Sun 18:00 weekend), this returns the
 * **next** session's open instead of the just-closed session's start. That
 * way any caller filtering trades by `exitFilledAt >= sessionStart` returns
 * zero rows during the break — Session PnL resets to $0 the moment the
 * current session ends, instead of lingering until the next open.
 *
 * DST: handled transparently via `utcForTradingTzWallClock`, which recomputes
 * the tz offset against the specific candidate wall-clock.
 */
export function currentCmeSessionStart(now: Date = new Date()): string {
  const p = tradingTzParts(now);
  const minutesNow = p.hour * 60 + p.minute;
  const BREAK_MIN = 17 * 60; // 17:00 ET
  const OPEN_MIN = 18 * 60;  // 18:00 ET

  // Helper: 18:00 ET on the calendar day `daysOffset` away from today
  // (negative = past, positive = future). Anchors on noon ET before shifting
  // days so the UTC arithmetic can't flip to the wrong calendar day in NY.
  const sessionOpenDaysAway = (daysOffset: number): Date => {
    const anchorNoon = utcForTradingTzWallClock(p.year, p.month, p.day, 12, 0);
    const shifted = new Date(anchorNoon.getTime() + daysOffset * 86_400_000);
    const c = tradingTzParts(shifted);
    return utcForTradingTzWallClock(c.year, c.month, c.day, 18, 0);
  };

  // Weekday cases. During gaps with no live session, return the *next*
  // session's open so PnL filters return empty.
  switch (p.weekday) {
    case 0: // Sunday
      // Before 18:00 ET: weekend gap — next session opens today 18:00 ET.
      // After 18:00 ET: Sunday 18:00 ET opens Monday's session.
      return sessionOpenDaysAway(0).toISOString();
    case 1: // Monday
      if (minutesNow < BREAK_MIN) return sessionOpenDaysAway(-1).toISOString(); // inside Mon session, opened Sun 18:00
      if (minutesNow < OPEN_MIN) return sessionOpenDaysAway(0).toISOString(); // 17:00–18:00 break: next session opens today 18:00
      return sessionOpenDaysAway(0).toISOString(); // Tue session opens at Mon 18:00
    case 2: // Tuesday
    case 3: // Wednesday
    case 4: // Thursday
      if (minutesNow < BREAK_MIN) return sessionOpenDaysAway(-1).toISOString(); // inside today's session
      if (minutesNow < OPEN_MIN) return sessionOpenDaysAway(0).toISOString(); // break
      return sessionOpenDaysAway(0).toISOString(); // post-18:00: next session
    case 5: // Friday
      // Before 17:00 ET: inside Friday's session (opened Thu 18:00 ET).
      // After 17:00 ET: weekend gap — next session opens Sunday 18:00 ET.
      return minutesNow < BREAK_MIN
        ? sessionOpenDaysAway(-1).toISOString() // Thu 18:00 ET
        : sessionOpenDaysAway(2).toISOString(); // Sun 18:00 ET
    case 6: // Saturday
      // Weekend gap — next session opens Sunday 18:00 ET.
      return sessionOpenDaysAway(1).toISOString();
    default:
      return sessionOpenDaysAway(0).toISOString();
  }
}

/**
 * Next instant after `now` at which `currentCmeSessionStart` flips to a
 * new key — i.e. the moment a fresh CME session begins and any
 * session-scoped counter resets. Walks forward in 5-minute steps from
 * `now`, looking for the first instant whose session key differs from
 * the current one. Bounded to ~3 days for safety (the longest possible
 * gap is the Fri 17:00 → Sun 18:00 weekend, ~49h).
 *
 * Used by the daily-PnL gate to expose `sessionRolloverEpochMs` on the
 * deployment status row so a tripped badge knows when to auto-clear.
 */
export function nextCmeSessionRollover(now: Date = new Date()): Date {
  const STEP_MS = 5 * 60 * 1000;
  const HORIZON_MS = 3 * 24 * 60 * 60 * 1000;
  const currentKey = currentCmeSessionStart(now);
  for (let elapsed = STEP_MS; elapsed <= HORIZON_MS; elapsed += STEP_MS) {
    const probe = new Date(now.getTime() + elapsed);
    if (currentCmeSessionStart(probe) !== currentKey) return probe;
  }
  // Should never hit (a 49h weekend < 72h horizon). Fall back to +24h
  // rather than throw — badge auto-clear is best-effort UX, not safety
  // critical.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * Is `instant` inside the session window [activeStart, activeEnd)?
 * Supports overnight windows where end < start (e.g. 22:00–04:00).
 * Returns false if either string is unparseable.
 *
 * **DST caveat (known, not handled):** on spring-forward in America/New_York,
 * 02:00–03:00 local time does not exist — clocks jump straight from 01:59:59
 * to 03:00:00. An `activeStart` or `activeEnd` that lands in that hour (e.g.
 * `02:30`) is silently treated as if the wall-clock skipped it. Windows that
 * start/end at 09:30 or later are unaffected. Fall-back doubles the 01:00
 * hour; `minutesInTradingTz` returns 60 twice but the gate still opens at
 * the first `>= start` crossing, so the session just starts 60 min earlier
 * in absolute time on that date. Document this if anyone ever configures a
 * 2–3am window in NY time.
 */
export function isInSessionWindow(
  instant: Date,
  activeStart: string,
  activeEnd: string,
): boolean {
  const start = parseHHMM(activeStart);
  const end = parseHHMM(activeEnd);
  if (start == null || end == null) return true; // fail open: don't block trades on malformed input
  const now = minutesInTradingTz(instant);
  if (start === end) return false; // zero-length window = always closed
  if (start < end) return now >= start && now < end;
  // Overnight: e.g. 22:00–04:00 → active if now >= 22:00 or now < 04:00
  return now >= start || now < end;
}

// ── The playbook's session + the deployment's pause windows ──────────
//
// Active intervals = `config.session` − `params.pauseWindows`.
//
// Time math is wraparound-aware: a main session 18:00–04:00 is treated as
// a single contiguous interval that crosses midnight. Pauses are
// subtracted from the active set.
//
// Boundary semantics: start <= now < end (left-closed, right-open).
// Abutting pauses (12:30–13:00 + 13:00–13:30) merge cleanly because the
// boundary tick belongs to the later window's start.

const DAY_MIN = 24 * 60;

/** Length of the main interval in minutes, treating end<=start as
 *  wraparound (24h - start + end). 0 when start === end. */
function mainLength(startMin: number, endMin: number): number {
  if (startMin === endMin) return 0;
  if (startMin < endMin) return endMin - startMin;
  return DAY_MIN - startMin + endMin;
}

/** Project a wall-clock minute onto a normalized timeline anchored at
 *  the main session's start (so the interval becomes [0, length)).
 *  Returns null when the input is outside the main interval. */
function projectIntoMain(
  minute: number,
  mainStart: number,
  mainEnd: number,
): number | null {
  if (mainStart === mainEnd) return null;
  // Wraparound case: shift by -mainStart modulo 24h, then check < length.
  const offset = (minute - mainStart + DAY_MIN) % DAY_MIN;
  const length = mainLength(mainStart, mainEnd);
  if (offset >= length) return null;
  return offset;
}

/**
 * Strict containment: is the half-open pause `[pStart, pEnd)` strictly
 * inside the half-open main `[mStart, mEnd)` on the wraparound-aware
 * timeline? Adjacent boundaries (`pStart === mStart` or `pEnd === mEnd`)
 * are rejected — the user should shorten the main session instead.
 *
 * Returns false when either window is degenerate (zero length) or
 * malformed.
 */
export function pauseStrictlyInsideMain(
  pause: PauseWindow,
  main: { start: string; end: string },
): boolean {
  const mStart = parseHHMM(main.start);
  const mEnd = parseHHMM(main.end);
  const pStart = parseHHMM(pause.start);
  const pEnd = parseHHMM(pause.end);
  if (mStart == null || mEnd == null || pStart == null || pEnd == null) return false;
  if (mStart === mEnd) return false;
  if (pStart === pEnd) return false;
  if (pStart === mStart || pEnd === mEnd) return false;
  const pStartProj = projectIntoMain(pStart, mStart, mEnd);
  if (pStartProj == null || pStartProj === 0) return false;
  // Project end-1 minute (right-open boundary) — equivalently, require
  // length-from-pStartProj of pause to land inside main with at least 1
  // minute of remaining main. Simpler: project pEnd, ensuring it falls
  // inside [1, length) i.e. doesn't equal main end and isn't before
  // pStart (wraparound check).
  const length = mainLength(mStart, mEnd);
  const pauseLen = mainLength(pStart, pEnd);
  if (pStartProj + pauseLen >= length) return false;
  return true;
}

/** True if two pause windows overlap (wraparound-aware). Abutting
 *  windows (pause A end === pause B start) are NOT overlapping —
 *  boundary tick belongs to the later window's start. */
export function pausesOverlap(a: PauseWindow, b: PauseWindow): boolean {
  const aStart = parseHHMM(a.start);
  const aEnd = parseHHMM(a.end);
  const bStart = parseHHMM(b.start);
  const bEnd = parseHHMM(b.end);
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  if (aStart === aEnd || bStart === bEnd) return false;
  // Walk minute-by-minute using normalized intervals on a 1440-slot
  // timeline. Cheap (≤2 windows × 1440 = 2880 ops) and avoids the bug
  // class around comparing two wraparound segments without anchoring.
  const aLen = mainLength(aStart, aEnd);
  const bLen = mainLength(bStart, bEnd);
  for (let i = 0; i < aLen; i++) {
    const m = (aStart + i) % DAY_MIN;
    const off = (m - bStart + DAY_MIN) % DAY_MIN;
    if (off < bLen) return true;
  }
  return false;
}

/**
 * Server-side validation for pause-window configuration. Used by
 * deployment + group POST/PATCH paths to hard-reject malformed inputs
 * before they hit the DB. Wraparound-aware via `pauseStrictlyInsideMain`
 * and `pausesOverlap`.
 *
 * Rules:
 *   - Each pause is `pauseStrictlyInsideMain` (rejects adjacent
 *     boundaries — `pause.end == main.end` etc).
 *   - No two pauses overlap (`pausesOverlap`).
 *   - Each pause is well-formed (parseable HH:MM, non-degenerate).
 */
export function validatePauseWindows(
  main: MainSession,
  pauses: ReadonlyArray<PauseWindow>,
): { valid: true } | { valid: false; error: string } {
  for (let i = 0; i < pauses.length; i++) {
    const p = pauses[i];
    if (typeof p.start !== "string" || typeof p.end !== "string") {
      return { valid: false, error: `Pause window ${i + 1}: start/end must be HH:MM strings.` };
    }
    if (parseHHMM(p.start) == null || parseHHMM(p.end) == null) {
      return { valid: false, error: `Pause window ${i + 1}: invalid HH:MM (${p.start}–${p.end}).` };
    }
    if (parseHHMM(p.start) === parseHHMM(p.end)) {
      return { valid: false, error: `Pause window ${i + 1}: start equals end (${p.start}).` };
    }
    if (!pauseStrictlyInsideMain(p, main)) {
      return {
        valid: false,
        error:
          `Pause window ${i + 1} (${p.start}–${p.end}) is not strictly inside the main session ` +
          `(${main.start}–${main.end}). ` +
          `Adjacent boundaries are not allowed — shorten the main window instead.`,
      };
    }
  }
  for (let i = 0; i < pauses.length; i++) {
    for (let j = i + 1; j < pauses.length; j++) {
      if (pausesOverlap(pauses[i], pauses[j])) {
        return {
          valid: false,
          error: `Pause windows ${i + 1} (${pauses[i].start}–${pauses[i].end}) and ${j + 1} (${pauses[j].start}–${pauses[j].end}) overlap.`,
        };
      }
    }
  }
  return { valid: true };
}

/**
 * True if two main sessions overlap (wraparound-aware). Abutting windows
 * do NOT overlap.
 */
export function mainSessionsOverlap(a: MainSession, b: MainSession): boolean {
  const aStart = parseHHMM(a.start);
  const aEnd = parseHHMM(a.end);
  const bStart = parseHHMM(b.start);
  const bEnd = parseHHMM(b.end);
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) return false;
  if (aStart === aEnd || bStart === bEnd) return false;
  const aLen = mainLength(aStart, aEnd);
  const bLen = mainLength(bStart, bEnd);
  for (let i = 0; i < aLen; i++) {
    const m = (aStart + i) % DAY_MIN;
    const off = (m - bStart + DAY_MIN) % DAY_MIN;
    if (off < bLen) return true;
  }
  return false;
}

/**
 * Compute the active intervals for a deployment: main session minus any
 * pause windows. Returns one or more `{start,end}` HH:MM pairs that
 * `isInAnySessionWindow` can iterate. Each interval is well-formed for
 * `isInSessionWindow` (overnight ranges allowed).
 *
 * Implementation walks a 1440-slot bitmap: 1 = active. Pauses zero out
 * their slots. Then we scan for runs of 1s and emit them as windows.
 * Cost is O(1440) per call — fine for the per-tick path because results
 * are cached by the `collectSessionWindows` wrapper below.
 */
function computeActiveIntervals(
  main: MainSession,
  pauses: ReadonlyArray<PauseWindow>,
): SessionWindow[] {
  const slots = new Uint8Array(DAY_MIN);
  const mStart = parseHHMM(main.start);
  const mEnd = parseHHMM(main.end);
  if (mStart == null || mEnd == null) {
    // Malformed main → fail open: behave as the legacy default of
    // `isInSessionWindow` returning true. Empty window list will make
    // `isInAnySessionWindow` return false; emit a 24h-equivalent so the
    // engine doesn't lock the deployment out.
    return [{ start: main.start, end: main.end }];
  }
  if (mStart === mEnd) return []; // zero-length window = always closed
  const mLen = mainLength(mStart, mEnd);
  for (let i = 0; i < mLen; i++) slots[(mStart + i) % DAY_MIN] = 1;
  for (const p of pauses) {
    const pStart = parseHHMM(p.start);
    const pEnd = parseHHMM(p.end);
    if (pStart == null || pEnd == null) continue;
    if (pStart === pEnd) continue;
    const pLen = mainLength(pStart, pEnd);
    for (let i = 0; i < pLen; i++) slots[(pStart + i) % DAY_MIN] = 0;
  }
  return scanSlotsToWindows(slots);
}

function scanSlotsToWindows(slots: Uint8Array): SessionWindow[] {
  const out: SessionWindow[] = [];
  const wraps = slots[0] === 1 && slots[DAY_MIN - 1] === 1;
  let runStart = -1;
  for (let i = 0; i < DAY_MIN; i++) {
    if (slots[i] === 1 && runStart === -1) runStart = i;
    if ((slots[i] === 0 || i === DAY_MIN - 1) && runStart !== -1) {
      const runEnd = slots[i] === 1 ? (i + 1) % DAY_MIN : i;
      out.push({ start: minToHHMM(runStart), end: minToHHMM(runEnd) });
      runStart = -1;
    }
  }
  if (wraps && out.length >= 2) {
    const head = out[0];
    const tail = out[out.length - 1];
    if (head.start === "00:00" && (tail.end === "00:00" || tail.end === "24:00")) {
      const merged: SessionWindow = { start: tail.start, end: head.end };
      return [merged, ...out.slice(1, out.length - 1)];
    }
  }
  return out;
}

function minToHHMM(min: number): string {
  const m = ((min % DAY_MIN) + DAY_MIN) % DAY_MIN;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Per-params cache of computed active intervals. Keyed on the params
 * object identity AND a content hash so two distinct param objects with
 * identical session config share results. Hot path: per-tick per-deployment;
 * recomputing 1440-slot bitmaps per tick adds up across 100+ deployments.
 */
const activeIntervalCache = new WeakMap<object, { hash: string; windows: SessionWindow[] }>();

function sessionHash(main: MainSession, pauses: ReadonlyArray<PauseWindow>): string {
  let h = `${main.start}-${main.end}@${main.timezone}`;
  for (const p of pauses) h += `|${p.start}-${p.end}`;
  return h;
}

/**
 * Active session intervals for a leg — the **playbook's** `config.session`
 * minus the **deployment's** pause windows. Caches per-params object so the
 * per-tick path doesn't recompute.
 *
 * The session arrives as an argument rather than off `params` because it is no
 * longer a param: a playbook declares the window it trades and the deployment
 * carries none. Every caller already has the module in hand — the engine, the
 * backtest, replay and the CLI all resolve it before they can evaluate a hook
 * at all — so passing it is not a lookup, it is the caller stating which of the
 * two owners each half came from. The hash covers both, so a module whose
 * session moves invalidates a cache entry keyed on an unchanged params object.
 */
export function collectSessionWindows(
  session: MainSession | undefined,
  params: Pick<CommonParams, "pauseWindows"> | { pauseWindows?: PauseWindow[] },
): SessionWindow[] {
  const pauses = (params as { pauseWindows?: PauseWindow[] }).pauseWindows ?? [];
  if (!session) return [];

  const hash = sessionHash(session, pauses);
  const cached = activeIntervalCache.get(params as object);
  if (cached && cached.hash === hash) return cached.windows;
  const windows = computeActiveIntervals(session, pauses);
  activeIntervalCache.set(params as object, { hash, windows });
  return windows;
}

/**
 * True when every window's bounds actually parse — i.e. when a caller may
 * *trust* the answer `isInAnySessionWindow` gives.
 *
 * Exists because `isInSessionWindow` **fails open** on an unparseable `HH:MM`
 * (see its comment): "don't block trades on malformed input" is right for the
 * trading path, where a wrong `true` costs an entry that should not have
 * fired. It is inverted for any caller where `true` means *act on the
 * operator's property* — D-2 enforcement reads in-window as authority to
 * force-close a hand position, so a malformed window there makes the claim
 * permanently live and flattens at any hour.
 *
 * **Call this first if a `true` from the window check causes an order.** Do not
 * "fix" `isInSessionWindow` to fail closed instead: the trading path's
 * calibration is deliberate and changing it would silently stop entries on a
 * config typo rather than logging one.
 */
export function claimableWindows(windows: ReadonlyArray<SessionWindow>): boolean {
  return windows.every((w) => parseHHMM(w.start) !== null && parseHHMM(w.end) !== null);
}

/** True if `instant` falls inside ANY of the given windows. */
export function isInAnySessionWindow(
  instant: Date,
  windows: ReadonlyArray<SessionWindow>,
): boolean {
  for (const w of windows) {
    if (isInSessionWindow(instant, w.start, w.end)) return true;
  }
  return false;
}

/**
 * Is this the first bar of its ET date the engine would have *evaluated* — and,
 * with `fromMinuteEt` set, the first it would have evaluated *past that
 * minute*? The once-per-session slot for a config-permanent gate that would
 * otherwise repeat to the close.
 *
 * **A gate behind another gate takes its slot from the first bar the earlier
 * gate lets through**, which is what `fromMinuteEt` expresses. ORB v2's
 * `rangeAtr` skip sits behind the range-close gate, so at the shipped defaults
 * (session 09:30, range 15m) the session's first evaluable bar is the 09:30
 * one, which returns null at the range gate — and by 09:45 there are in-window
 * predecessors, so the unbounded predicate answers false on every bar that can
 * reach the skip and the gate never fires. Bars before the bound are therefore
 * skipped in the walk back on the same reasoning window-outside bars are: they
 * were never candidates for this slot.
 *
 * The predecessor bar is the wrong question, and asking it made the range
 * guard silent for exactly the deployments it was written for: the engine
 * calls `shouldEnter` only inside the deployment's session windows, so a leg
 * whose window opens after the range closes has a predecessor that is already
 * past it on every bar. Bars outside every window are therefore skipped in the
 * walk back — they were never candidates for the slot. No window at all (an
 * unmigrated params object) degrades to the plain predecessor check rather
 * than emitting on every bar.
 *
 * **The latching bar has to be in-window itself**, not merely the first with no
 * in-window predecessor. The engine gates on the wall clock at bar close while
 * this reads bar opens, so the bar closing *at* the window's start opens before
 * it: it reaches the hook, answers "no in-window predecessor", and then so does
 * the next bar, which is the first whose own open is inside. That is two lines
 * per session live against the backtest's one, on a gate whose whole point is
 * one.
 *
 * Pure, and identical in engine and backtest: the answer comes from the bar
 * series and the params, never from module state — two deployments of one
 * strategy would share module state, and a sweep would share it across every
 * param combination in the run.
 *
 * What it does not cover, three residuals of the same shape: an engine that
 * boots mid-session past the slot has no bar left to emit on and stays silent
 * until the next session; a backtest whose warmup ends mid-session spends the
 * slot on a warmup bar whose skip the run then drops; and a window holding no
 * bar *open* while holding a bar close — a timeframe coarser than the offset
 * between the two, 1h against 09:30–10:30 — has no bar that can take the slot
 * at all, so the gate is silent live for the life of that deployment. The
 * misconfiguration is config-permanent in every case, so the next session says
 * it wherever a bar can.
 *
 * `fromMinuteEt` is an ET minute of day and is not range-checked here: a
 * value at or past 1440 would make both guards permanently true and silence
 * the gate for the deployment's life — the failure ORB v2 3.0.5 fixed, in the
 * other direction. Every caller passing one must have pinned it inside a cash
 * session already, as both range-end callers have.
 *
 * Shared rather than copied: two strategies latch this way, the predicate has
 * been corrected twice, and a third copy is a fix that reaches one of them
 * ([strategies.md](../../../../docs/modules/trading/strategies.md), the
 * session-permanent Hard rule).
 */
export function isFirstEvaluableBarOfSession(
  bars: BarData[],
  barIndex: number,
  windows: SessionWindow[],
  fromMinuteEt?: number,
): boolean {
  const cur = bars[barIndex];
  if (!cur?.timestamp) return true;
  const curTs = new Date(cur.timestamp);
  if (isNaN(curTs.getTime())) return true;
  if (windows.length > 0 && !isInAnySessionWindow(curTs, windows)) return false;
  if (fromMinuteEt != null && minutesInTradingTz(curTs) < fromMinuteEt) return false;
  const curDate = etDateKey(curTs);
  for (let i = barIndex - 1; i >= 0; i--) {
    const b = bars[i];
    if (!b?.timestamp) continue;
    const t = new Date(b.timestamp);
    if (isNaN(t.getTime())) continue;
    if (etDateKey(t) !== curDate) break;
    if (fromMinuteEt != null && minutesInTradingTz(t) < fromMinuteEt) continue;
    if (windows.length === 0 || isInAnySessionWindow(t, windows)) return false;
  }
  return true;
}

/**
 * The `HH:MM` end of the window that most recently closed, relative to
 * `instant` — read-only, and used for one thing: the session guard's
 * Activity sentence, *"Session ended at 16:00 NY — closed the MNQ
 * position."*
 *
 * **The most recently closed end, not the last window in the list.** A
 * deployment with two windows (09:30–11:30, 13:00–16:00) sitting flat at
 * 12:00 is outside both, and naming 16:00 there would tell the operator the
 * session ended at a time that has not happened yet. Distance is measured
 * backwards on the 24-hour clock, so an overnight gap answers correctly and
 * a window that closed yesterday still answers with its own end.
 *
 * `null` when no window's bounds parse, which is a real state: the caller
 * withholds the slot and its line falls back to prose rather than naming a
 * time nothing measured.
 */
export function mostRecentWindowEnd(
  instant: Date,
  windows: ReadonlyArray<SessionWindow>,
): string | null {
  const now = minutesInTradingTz(instant);
  let best: { end: string; since: number } | null = null;
  for (const w of windows) {
    const end = parseHHMM(w.end);
    if (end == null) continue;
    const since = (now - end + DAY_MIN) % DAY_MIN;
    if (best === null || since < best.since) best = { end: w.end, since };
  }
  return best?.end ?? null;
}

/**
 * Time-of-day windows ("HH:MM"–"HH:MM" half-open) where strategy time
 * parameters must NOT land. Surfaced to the user in the picker rather than
 * silently corrected in the engine — backtest and live agree on the literal
 * value, and a user staring at `activeEnd: 16:00` no longer wonders why the
 * engine flattened at 15:55.
 *
 * The 15:56–18:05 ET range covers the equity-index futures session boundary
 * where Topstep system-cancels brackets:
 *   - 16:00 ET cash close: brackets get torn down by the system.
 *   - 17:00 ET maintenance break begins.
 *   - 18:00 ET globex reopens; orders submitted exactly at the open
 *     have a small race window before market data is flowing cleanly.
 * 15:55 itself is a valid `activeEnd`: the session-window check is
 * `[activeStart, activeEnd)`, so `activeEnd: 15:55` means "exit by 15:55:00
 * sharp" — the engine flattens just before Topstep starts tearing down
 * brackets at 16:00, with the natural 5-min cushion. The blackout starts
 * one minute later (15:56) so the picker accepts 15:55 as the inclusive
 * lower edge rather than rejecting it.
 */
export const SESSION_BLACKOUT_RANGES: ReadonlyArray<{ start: string; end: string }> = [
  { start: "15:56", end: "18:05" },
];

/** True if the "HH:MM" wall-clock falls inside any blackout range. Returns
 *  false for malformed input (validation should reject those upstream). */
export function isInBlackoutRange(time: string): boolean {
  const t = parseHHMM(time);
  if (t == null) return false;
  for (const range of SESSION_BLACKOUT_RANGES) {
    const start = parseHHMM(range.start);
    const end = parseHHMM(range.end);
    if (start == null || end == null) continue;
    if (start < end) {
      if (t >= start && t < end) return true;
    } else {
      // Overnight blackout (start > end): e.g. 22:00–02:00.
      if (t >= start || t < end) return true;
    }
  }
  return false;
}

/**
 * True if `instant` falls inside the daily CME maintenance break (17:00–18:00
 * ET on weekdays Mon–Thu, plus the Fri-17:00 → Sun-18:00 weekend gap). During
 * this window the gateway is known down — inline reconnect attempts are
 * guaranteed to fail, so callers should skip the retry and fall straight
 * through to passive mode.
 */
export function isInMaintenanceWindow(instant: Date = new Date()): boolean {
  const p = tradingTzParts(instant);
  const minutesNow = p.hour * 60 + p.minute;
  const BREAK_MIN = 17 * 60;
  const OPEN_MIN = 18 * 60;
  switch (p.weekday) {
    case 0: // Sunday — closed until 18:00 ET
      return minutesNow < OPEN_MIN;
    case 5: // Friday — closed from 17:00 ET onward
      return minutesNow >= BREAK_MIN;
    case 6: // Saturday — closed all day
      return true;
    case 1: case 2: case 3: case 4: // Mon–Thu — daily 17:00–18:00 ET break
      return minutesNow >= BREAK_MIN && minutesNow < OPEN_MIN;
    default:
      return false;
  }
}

/**
 * Returns the next instant the CME globex session opens after `now` (or
 * `now` itself if already in session). Used by the auto-heal scheduler to
 * fire a one-shot reconnect at the next maintenance-end so a passive engine
 * comes back online automatically when the gateway returns. Returns null if
 * we're currently in session (no upcoming maintenance-end to schedule against).
 */
export function nextMaintenanceEnd(now: Date = new Date()): Date | null {
  if (!isInMaintenanceWindow(now)) return null;
  const p = tradingTzParts(now);
  const anchorNoon = utcForTradingTzWallClock(p.year, p.month, p.day, 12, 0);
  // Walk forward day-by-day (max 3 hops covers Sat→Sun→Mon path) until we
  // land on a calendar day where 18:00 ET is outside the maintenance window.
  for (let offset = 0; offset <= 3; offset++) {
    const shifted = new Date(anchorNoon.getTime() + offset * 86_400_000);
    const c = tradingTzParts(shifted);
    const candidate = utcForTradingTzWallClock(c.year, c.month, c.day, 18, 0);
    if (candidate.getTime() > now.getTime() && !isInMaintenanceWindow(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Snap a time inside a blackout range to the nearest valid edge.
 *  Used by the deployment migration to rewrite stored HH:MM values that
 *  predate this constraint. Returns the original string if it's already
 *  outside every blackout, or unparseable. */
export function snapOutOfBlackout(time: string): string {
  const t = parseHHMM(time);
  if (t == null) return time;
  for (const range of SESSION_BLACKOUT_RANGES) {
    const start = parseHHMM(range.start);
    const end = parseHHMM(range.end);
    if (start == null || end == null) continue;
    const inside = start < end
      ? t >= start && t < end
      : t >= start || t < end;
    if (!inside) continue;
    // Distance to each edge, with overnight wrap. Snap to the closer edge.
    const dayMin = 24 * 60;
    const distToStart = Math.min((t - start + dayMin) % dayMin, (start - t + dayMin) % dayMin);
    const distToEnd = Math.min((t - end + dayMin) % dayMin, (end - t + dayMin) % dayMin);
    return distToStart <= distToEnd ? range.start : range.end;
  }
  return time;
}
