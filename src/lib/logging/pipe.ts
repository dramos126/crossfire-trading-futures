import { isStagingEnv } from "@/lib/env";
import { burstKeyFor, observeBurst, resetBursts } from "./burst";
import { scrubDisplay, scrubMessage, scrubMeta, scrubValues } from "./scrub";
import {
  ENGINE_SCOPE,
  EVENTS,
  LEGACY_LEVEL_LADDER,
  SEVERITY_RANK,
  categoryForTag,
  deriveLegacyLevel,
  resolveLadder,
  type LegacyLevel,
  type LogCategory,
  type LogEnvelope,
  type LogValues,
  type Severity,
} from "./vocabulary";

/**
 * The one entry point every log line goes through.
 *
 * It ends the two-worlds split: `log.*` was console-only and died with the
 * terminal, `this.log` was persisted and survived, and which of the two a
 * line got was an accident of which helper its author reached for. The
 * broker-registry incident had no evidence for exactly that reason.
 *
 * Owned by docs/modules/logging/README.md. **This module is a leaf** — it
 * imports `@/lib/env` and its own siblings and nothing else. Persistence
 * arrives through `setLogSink`, which the store installs; a static import
 * of `db/` from here would close a cycle through `db/connection.ts`, which
 * imports the logger.
 */

// ── The record ─────────────────────────────────────────────────────────

/** The four fields the `/logs` viewer and the engine's rings read. */
export interface LegacyLogEntry {
  timestamp: string;
  deploymentId: string;
  level: LegacyLevel;
  message: string;
}

/** A line after the pipe is done with it. The message is scrubbed. */
export interface LogRecord extends LegacyLogEntry {
  severity: Severity;
  category: LogCategory;
  event: string | null;
  display: string | null;
  accountId: number | null;
  contractId: string | null;
  /** The rendered symbol (`MNQ`), for a line that names a contract but no
   *  deployment. Never the contract id. */
  ticker: string | null;
  tradeId: number | null;
  /**
   * The Activity template's value slots, scrubbed. Null on a line that
   * named none — which is most of them, and a legible state rather than an
   * empty object nobody wrote.
   */
  values: LogValues | null;
  /**
   * The **resolved** cause key the collapser used — not the caller's hint
   * of the same name on the envelope, which is one input to it. Null on an
   * uncollapsed category (`heartbeat`, `trade`).
   */
  burstKey: string | null;
  burstCount: number;
  lastSeenAt: string;
}

/**
 * What a ring holds. Two shapes share it: a line the pipe just emitted is a
 * full `LogRecord`, and a line `hydrateRings()` read back off disk is the
 * four legacy columns and nothing else. The optional half is that split,
 * stated rather than asserted — a hydrated row genuinely has no envelope.
 */
export type RingLogEntry = LegacyLogEntry & Partial<Omit<LogRecord, keyof LegacyLogEntry>>;

/**
 * What a ring record looks like on the wire.
 *
 * **`accountId` and `contractId` are absent by construction, not by being
 * null.** They are full-fidelity identifiers that exist so the durable row
 * can be queried; they are server-side columns, and the only account-shaped
 * thing a client may see is `display`'s truncated form. The ring once
 * shipped whole to `/api/engine` and leaked nothing only because those
 * columns were all still null — the projection is what makes that safe by
 * construction rather than by luck, so a second consumer of the ring
 * inherits the narrowing instead of re-deciding it.
 *
 * **`tradeId` is the one structural id that crosses, and deliberately
 * so.** It is an internal `strategy_trades` row id — an autoincrement
 * integer this app assigned itself, carrying no account, no contract and
 * nothing a broker or a third party would recognise — and it is what makes
 * an Activity episode card a group rather than a guess: entry, brackets,
 * exit and reconcile share it. The privacy rule it is measured against is
 * the audience requirement's, which is about *the operator's identifiers*,
 * and this is not one. **The exclusion of the other two is untouched**, and
 * this list stays a positive whitelist so a column added later still has to
 * be named here to travel.
 *
 * **`values` is the third widening, and it is rendering data.** It carries
 * the size, price, stop, target, P&L, reason, gate and time an Activity
 * template names — the numbers and fragments the call site already put in
 * its message, in slots the viewer can compose. It names nothing outside
 * this database because a size and a price name nothing at all; the test to
 * apply is the same one `seq` passed. The construction rule that keeps it
 * that way — no account number, no contract id, ever — is on `LogValues`.
 */
export interface WireLogRecord extends LegacyLogEntry {
  severity: Severity;
  category: LogCategory;
  event: string | null;
  display: string | null;
  /** The rendered symbol, for an engine-scoped line that names a contract.
   *  Public market vocabulary; the contract id it was derived from stays
   *  server-side. */
  ticker: string | null;
  /** The episode link. Null on every line that is not about one trade. */
  tradeId: number | null;
  /** The template's value slots. Null on a line that named none. */
  values: LogValues | null;
  burstCount: number;
  /**
   * The record's position in the ring it came from — an **ordinal**, and the
   * tiebreak the client sorts on when two lines share a millisecond.
   *
   * It carries no privacy weight of any kind: it names nothing, it is not
   * stable across polls, and it is not stored anywhere. It is on the wire
   * because the server is the only side that still knows the emission order
   * — the payload is bucketed by legacy level, and a merge that sorts on
   * `timestamp` alone scrambles same-millisecond lines across buckets,
   * which is how an episode card came to read exit-before-entry.
   */
  seq: number;
}

/**
 * Narrow a ring entry to what may cross to a browser.
 *
 * A hydrated legacy row has no envelope to project, so its pair is derived
 * from the `level` column it does carry — the same mapping shim A applies on
 * the way in, run backwards. That keeps one wire shape for both ring
 * populations instead of making every consumer branch on which it got.
 */
export function projectLogRecord(entry: RingLogEntry, seq: number): WireLogRecord {
  // A hydrated row's `level` is an `as`-cast off a freeform TEXT column, so
  // the seven-value type is a claim about the database rather than a fact
  // about this value — the same reason a broker response is validated at
  // the boundary, applied to a durable table this process wrote months of
  // rows into. An unrecognised level would otherwise destructure off
  // `undefined` and throw out of whichever accessor projected it. The one
  // on the live poll is `getLogsByLevel`; `getLogsBuffer` has no caller
  // outside its own test, so the defence is against the poll path and
  // against the next caller, not against a second live one today.
  const ladder = LEGACY_LEVEL_LADDER[entry.level] ?? LEGACY_LEVEL_LADDER.info;
  return {
    timestamp: entry.timestamp,
    deploymentId: entry.deploymentId,
    level: entry.level,
    message: entry.message,
    severity: entry.severity ?? ladder.severity,
    category: entry.category ?? ladder.category,
    event: entry.event ?? null,
    display: entry.display ?? null,
    ticker: entry.ticker ?? null,
    tradeId: entry.tradeId ?? null,
    values: entry.values ?? null,
    burstCount: entry.burstCount ?? 1,
    seq,
  };
}

/** A repeat folded onto a row that is already written or already queued. */
export interface BurstUpdate {
  burstKey: string;
  /** The first emission's timestamp — with the key, it locates the row. */
  timestamp: string;
  count: number;
  lastSeenAt: string;
}

// ── The sink ───────────────────────────────────────────────────────────

export interface LogSink {
  write(record: LogRecord): void;
  bump(update: BurstUpdate): void;
}

let sink: LogSink | null = null;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/**
 * The live rings the `/logs` page polls, reached the same way the store is
 * — registered by the module that owns them, never imported from here.
 *
 * **The two members have different populations, and that asymmetry is the
 * point.** `push` carries the lines the engine's own log handler will never
 * see: a tagged line reaches `emit` directly, so before this existed it was
 * durable immediately and invisible in `/logs` until the *next* boot's
 * hydration read it back. An engine line still arrives at the ring through
 * `TradingEngine.onLog`, and pushing it from here as well would give every
 * one of them two ring entries. `bump` has no such split — a folded repeat
 * belongs to whichever entry the window's first line left, whatever seam
 * wrote it.
 *
 * **A folded repeat has to reach the ring, not only the column.** The count
 * lived in `engine_logs.burst_count` alone, the UI polls the rings, and
 * there is no SSE for logs — so a fold was *invisible* rather than compact,
 * and an `error` line whose repeats climbed was silent escalation until the
 * next restart hydrated the row back with its count.
 */
export interface LogRingSink {
  /** A tagged line. Engine lines arrive through the engine's log handler. */
  push(record: LogRecord): void;
  /** A folded repeat, onto the entry the window's first emission left. */
  bump(update: BurstUpdate): void;
}

let ringSink: LogRingSink | null = null;

export function setLogRingSink(next: LogRingSink | null): void {
  ringSink = next;
}

/**
 * Where an escalating line goes. Registered rather than imported, for the
 * same reason the store's sink is: the sender reaches `db/settings` for the
 * webhook and the notification kill-switch, and a static import from here
 * into `db/` closes a cycle through `connection.ts`.
 */
export type EscalationSink = (record: LogRecord) => void;

let escalationSink: EscalationSink | null = null;

export function setEscalationSink(next: EscalationSink | null): void {
  escalationSink = next;
}

/**
 * Drop every open burst window. **The store must call this when it wipes
 * the table**, or the first line of the next burst is folded onto a row
 * that no longer exists and never reappears in `/logs`.
 */
export function resetLogBursts(): void {
  resetBursts();
}

// ── Console gates ──────────────────────────────────────────────────────

/**
 * Minimum console severity. `debug` in development, `info` in production,
 * overridable with `LOG_LEVEL`. This gates the console mirror only —
 * persistence is decided by the ladder, not by what the terminal shows.
 */
function minConsoleSeverity(): Severity {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") return raw;
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

let debugGateRaw: string | null = null;
let debugGate: { all: boolean; tags: Set<string> } = { all: false, tags: new Set() };

/**
 * `DEBUG_TAGS=auth,signalr,eval` enables those tags; `*` enables all;
 * unset enables none. Memoised on the raw string so a per-line call costs
 * a compare rather than a split.
 */
function debugTagEnabled(tag: string | null): boolean {
  const raw = (process.env.DEBUG_TAGS ?? "").trim();
  if (raw !== debugGateRaw) {
    debugGateRaw = raw;
    debugGate =
      raw === "*"
        ? { all: true, tags: new Set() }
        : { all: false, tags: new Set(raw.split(",").map((t) => t.trim()).filter(Boolean)) };
  }
  // An untagged `emit()` has nothing to gate on; the tag gate is shim B's.
  if (tag === null) return true;
  return debugGate.all || debugGate.tags.has(tag);
}

/**
 * Whether a `debug` line exists at all — and therefore whether it
 * persists, because everything the pipe does not drop here is written.
 *
 * Prod never keeps one — gate decision 2, so a screenshot of the prod log
 * is the four CONNECTION lines rather than dozens of raw WS frames. Below
 * prod it exists when its tag was asked for, because a `debug` line nobody
 * opted into is not diagnosis detail, it is the firehose the gate decision
 * was written to prevent: `eval` alone is seventeen call sites on a
 * per-bar path.
 */
function debugLineExists(tag: string | null): boolean {
  return isStagingEnv() && debugTagEnabled(tag);
}

function consoleFor(severity: Severity): (...args: unknown[]) => void {
  if (severity === "error") return console.error;
  if (severity === "warn") return console.warn;
  // eslint-disable-next-line no-console -- the process log is the product here
  return console.log;
}

/**
 * One format, because every record carries the four fields regardless of
 * which world emitted it: `[ts] [severity] [category] [scope]`.
 *
 * It used to branch on `tag` — a `logger.ts` line rendered `[ts] [sev]
 * [tag]` and an engine line rendered `[Engine] ts [level] [deploymentId]`
 * — and both shapes shipped to prod in the same boot stream, where the
 * second bracket meant severity in one and a legacy level in the other.
 * An operator scanning `docker logs` for urgency was reading a column
 * that changed meaning line to line, which is the attribution complaint
 * the whole rework exists to answer.
 *
 * Two deliberate choices in the merge. **`severity`, not `level`** — the
 * legacy value conflates urgency with kind, and splitting those is what
 * the severity/category pair is for. **`category` keeps the kind visible**
 * rather than dropping it: a console reader loses the old `[trade]` /
 * `[connection]` hint otherwise, and that hint is half of knowing which
 * line belongs to what. `tag` still gates `DEBUG_TAGS` — it just no
 * longer decides how a line looks.
 */
function renderConsoleLine(record: LogRecord): string {
  return `[${record.timestamp}] [${record.severity}] [${record.category}] [${record.deploymentId}] ${record.message}`;
}

function mirrorToConsole(record: LogRecord, meta: unknown): void {
  if (SEVERITY_RANK[record.severity] < SEVERITY_RANK[minConsoleSeverity()]) return;
  const line = renderConsoleLine(record);
  const write = consoleFor(record.severity);
  if (meta === undefined) write(line);
  else write(line, scrubMeta(meta));
}

// ── emit ───────────────────────────────────────────────────────────────

/**
 * Every reach into the sink goes through here. A log line must never
 * throw into its caller — this one is reached from inside the engine's
 * tick — and there is nowhere to report the failure that is not this same
 * function.
 */
function dispatch(fn: () => void): void {
  try {
    fn();
  } catch {
    // Deliberately silent. See above.
  }
}

/**
 * Render, scrub, mirror, persist. Returns the record so the caller can
 * hand it onward — the engine's ring is fed this way — or `null` when the
 * line was dropped at the pipe.
 *
 * **There is one writer of the `level` column and it is a derivation.**
 * Shim A used to carry the chip its call site named on a field `emit`
 * could not accept, because the pair alone could not tell `trade` from
 * `trade-skip`. `entry_skipped` tells them apart now, so the carried value
 * and the type that hid it are both gone and nothing can disagree with the
 * derivation.
 */
export function emit(env: LogEnvelope): LogRecord | null {
  return emitEnvelope(env);
}

/**
 * Categories a burst never collapses. `heartbeat` is a cadence, not a
 * cause: folding it would fold the whole ring into one row and take the
 * "is the engine alive" signal with it. `trade` is the opposite argument
 * arriving at the same answer — a trade is an *episode*, one line per
 * entry, exit or skip, and two of them inside thirty seconds is two
 * trades. Note that `categoryForTag` also lands the `eval` and `trading`
 * tag heads here, so their (opt-in, non-prod) `debug` lines are uncollapsed
 * too; that is the firehose `DEBUG_TAGS` already gates.
 */
const UNCOLLAPSED_CATEGORIES: ReadonlySet<LogCategory> = new Set<LogCategory>([
  "heartbeat",
  "trade",
]);

function emitEnvelope(env: LogEnvelope): LogRecord | null {
  const { severity, category } = resolveLadder(env);
  const tag = env.tag ?? null;
  if (severity === "debug" && !debugLineExists(tag)) return null;

  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  // Everything that reaches a durable column is scrubbed here, once. The
  // truncation rule belongs to the pipe and not to the 71 call sites that
  // would each have to remember it — `display` is `account-strategy.ticker`
  // and carries an account number by construction. That construction is also
  // why it takes `scrubDisplay` rather than `scrubMessage`: the leading
  // digit run is an account whether or not `account_brokers` has caught up
  // with it, so its truncation must not be conditional on the catalog the
  // way free text's is.
  const message = scrubMessage(env.message);
  const display = env.display == null ? null : scrubDisplay(env.display);
  const burstHint = env.burstKey == null ? null : scrubMessage(env.burstKey);
  // Values reach a durable column too, so they are scrubbed on the same
  // pass. They are deliberately **not** an input to the cause key below:
  // they are rendering data, and the composition contract says the pipe
  // folds on the text the call site handed it — two lines whose values
  // differ differ in their message as well, because the site interpolated
  // them there first.
  const values = env.values == null ? null : scrubValues(env.values);
  // A ticker is public market vocabulary and cannot carry a secret, but it
  // reaches a durable column, and every field that does is scrubbed on this
  // one pass — the rule is about where scrubbing happens, not about which
  // fields are suspected.
  const ticker = env.ticker == null ? null : scrubMessage(env.ticker);

  const causeKey = UNCOLLAPSED_CATEGORIES.has(category)
    ? null
    : burstKeyFor(env.event, env.deploymentId, burstHint, message);
  if (causeKey !== null) {
    const outcome = observeBurst(causeKey, timestamp, now);
    if (!outcome.first) {
      const update: BurstUpdate = {
        burstKey: causeKey,
        timestamp: outcome.firstTimestamp,
        count: outcome.count,
        lastSeenAt: timestamp,
      };
      // Both surfaces, and separately dispatched so a throwing ring cannot
      // cost the durable row its count. The ring is the one the `/logs`
      // poll reads: while the count landed only in the column, a folded
      // repeat was invisible rather than compact, and an `error` row whose
      // repeats climbed was silent escalation until the next restart.
      dispatch(() => sink?.bump(update));
      dispatch(() => ringSink?.bump(update));
      return null;
    }
  }

  const record: LogRecord = {
    timestamp,
    deploymentId: env.deploymentId,
    level: deriveLegacyLevel(severity, category, env.event),
    // Scrubbed here and nowhere else. The ring, the row and the wire all
    // read this field, so there is no copy of the raw text downstream.
    message,
    severity,
    category,
    event: env.event,
    display,
    accountId: env.accountId ?? null,
    contractId: env.contractId ?? null,
    ticker,
    tradeId: env.tradeId ?? null,
    values,
    burstKey: causeKey,
    burstCount: 1,
    lastSeenAt: timestamp,
  };

  mirrorToConsole(record, env.meta);
  // Everything that reaches here persists. `info` and above always do;
  // `debug` reaches here only when `debugLineExists` said it does, which
  // is the whole of the non-prod rule.
  dispatch(() => sink?.write(record));
  // Escalation is a property of the ladder, not of the call site — but a
  // narrow one: `error` **and** an event the vocabulary flagged. Reached
  // only past the burst check, so a folded repeat cannot re-alert; the
  // sender's own throttle is the longer bound on top of that.
  if (severity === "error" && env.event !== null && EVENTS[env.event]?.escalates) {
    dispatch(() => escalationSink?.(record));
  }
  return record;
}

// ── Compat shim B: logger.ts's `log.*` ─────────────────────────────────

/**
 * Emit a tagged line, and put it on the live rings the `/logs` page polls.
 *
 * **Both shim-B entry points go through here and `emit` does not**, because
 * the engine pushes its own: `TradingEngine.log`/`logEvent` forward the
 * record they get back to `onLog`, so a push from inside `emit` would put
 * every engine line in the ring twice. A tagged line has no such handler —
 * it reached the store and the console and then waited for the next boot's
 * `hydrateRings()` to become visible. Observed on the first staging boot:
 * four `[info]` lines persisted while the UI's INFO chip read 1.
 *
 * A dropped line pushes nothing, and `debug` needs no special case for it:
 * `emitEnvelope` has already decided whether the line *exists* — prod drops
 * every `debug`, below prod `DEBUG_TAGS` decides — and a `null` return
 * covers a burst-folded repeat on the same branch.
 */
function emitTagged(env: LogEnvelope): void {
  const record = emitEnvelope(env);
  if (record) dispatch(() => ringSink?.push(record));
}

/**
 * `log.debug/info/warn/error` delegate here.
 *
 * **This is where console-only lines start persisting** — the fix for the
 * evidence gap, and a deliberate behaviour change.
 *
 * These land under the engine-wide sentinel and stay there: a tag names a
 * module, not a deployment, so there is no subject to derive one from. That
 * is the standing difference between a `log.*` line and an engine line —
 * the engine's own seams read `display` off the deployment row, and nothing
 * here can. A line that needs deployment attribution belongs on the engine
 * seam, not on this one.
 */
export function consoleLog(
  severity: Severity,
  tag: string,
  message: string,
  meta?: unknown,
  burstKey?: string,
): void {
  emitTagged({
    event: null,
    severity,
    category: categoryForTag(tag),
    deploymentId: ENGINE_SCOPE,
    message,
    tag,
    meta,
    burstKey: burstKey ?? null,
  });
}

/** What a tagged call site knows about what its line is *about*. */
export interface TaggedSubject {
  /** Defaults to the engine sentinel — most tagged sites are not per-leg. */
  deploymentId?: string;
  accountId?: number | null;
  contractId?: string | null;
  /** The rendered symbol, for a line that names a contract and no leg. */
  ticker?: string | null;
  tradeId?: number | null;
  burstKey?: string | null;
  /** Console-only structured detail, as on `log.*`. */
  meta?: unknown;
}

/**
 * `log.event` — a tagged line that also names a vocabulary event and a
 * subject. The migration target for shim B's call sites.
 *
 * **Severity and category come from the registry, and the tag stays.** The
 * tag has stopped being how the line gets a category and is now only what
 * selects the `DEBUG_TAGS` gate — which is why it survives here rather than
 * being dropped at migration. It no longer selects a console format: the two
 * shapes were merged once `renderConsoleLine` was made unconditional, so the
 * only thing still riding on `tag` is which `debug` lines exist below prod.
 * Retiring it entirely means replacing that gate with one keyed on
 * `category`, which is a decision about observability and not a cleanup.
 */
export function taggedEvent(
  event: string,
  tag: string,
  message: string,
  subject: TaggedSubject = {},
): void {
  emitTagged({
    event,
    deploymentId: subject.deploymentId ?? ENGINE_SCOPE,
    message,
    accountId: subject.accountId ?? null,
    contractId: subject.contractId ?? null,
    ticker: subject.ticker ?? null,
    tradeId: subject.tradeId ?? null,
    burstKey: subject.burstKey ?? null,
    tag,
    meta: subject.meta,
  });
}
