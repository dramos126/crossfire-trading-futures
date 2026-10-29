/**
 * The Activity lane's model — `WireLogRecord[]` in, a feed of day dividers,
 * episode cards and standalone lines out.
 *
 * This is the lane a non-technical reader gets, and the rule it answers to is
 * the proposal's **phone test**: a line must survive being read aloud by
 * someone who does not understand it and still tell the operator which
 * deployment, which action, what state it left and what happens next. So the
 * one thing this module may never do is render a sentence that claims
 * something the record does not carry.
 *
 * **No React here on purpose.** The component below it wires `title=`,
 * classes and keys; every decision worth a test — which sentence, which
 * severity words, which card a record joins — is a pure function in this
 * file. See [testing/patterns.md](../../docs/modules/testing/patterns.md).
 *
 * Owned by docs/modules/ui/design-language.md.
 */

import { ENGINE_SCOPE, eventSpec, type Severity } from "@/lib/logging/vocabulary";
import { formatGapDuration } from "@/lib/logging/duration";
import { tickerOf } from "@/lib/logging/scrub";
import type { WireLogRecord } from "@/lib/logging/pipe";
import type { DeploymentStatusTone } from "./deployment/deployment-status";

// ── The payload, back into one stream ──────────────────────────────────

/**
 * Merge `/api/engine`'s per-level buckets into one chronological stream.
 *
 * The payload is bucketed because the *server* caps per legacy level, which
 * is what keeps a rare error visible at a small limit. Both lanes face
 * severity and category, so the buckets are merged straight back — and the
 * merge is here rather than in the `.tsx` because the comparator is a
 * decision worth a test, which is the split this pair of modules exists for.
 *
 * **The comparator has to break ties, and `timestamp` alone cannot.** Every
 * line of one trade's entry — the order, its fill, its brackets — can land in
 * the same millisecond, and they land in *different* buckets, so a sort on
 * the ISO string leaves them in whatever order `Object.values` enumerated.
 * That is how an episode card came to read exit-before-entry. `seq` is the
 * ring index the accessor stamped on the way out, and it is the only record
 * of the emission order that survives the bucketing.
 */
export function mergeLogBuckets(
  byLevel: Readonly<Record<string, readonly WireLogRecord[]>>,
): WireLogRecord[] {
  const merged = Object.values(byLevel).flat().map(withDefaults);
  merged.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.seq - b.seq;
  });
  return merged;
}

/**
 * The two numeric fields the lanes render arithmetic or a count from, floored
 * at the shape the projection guarantees.
 *
 * **This is a boundary check, not defensiveness.** The records arrive as
 * `res.json()` — a `WireLogRecord` by declaration and `unknown` in fact —
 * and a server one deploy behind sends rows with no `seq` and no
 * `burstCount`. The visible cost of not doing it is `× undefined` in the
 * burst badge and a comparator returning `NaN`, which sorts nothing and
 * reports no error. Nothing else here is guarded, because nothing else here
 * is read as a number.
 */
function withDefaults(record: WireLogRecord): WireLogRecord {
  const seq = Number.isFinite(record.seq) ? record.seq : 0;
  const burstCount = Number.isFinite(record.burstCount) ? record.burstCount : 1;
  return seq === record.seq && burstCount === record.burstCount
    ? record
    : { ...record, seq, burstCount };
}

/** One emission, whatever its count: a folded repeat re-sends its first
 *  line's timestamp, subject, level and text with a climbed count. */
function sameEmission(a: WireLogRecord, b: WireLogRecord): boolean {
  return (
    a.timestamp === b.timestamp
    && a.deploymentId === b.deploymentId
    && a.level === b.level
    && a.message === b.message
  );
}

/**
 * Fold one pushed `logLine` into the merged stream.
 *
 * **A line already held is replaced where it stands**, keeping its `seq`:
 * that is a burst's count climbing, and moving it would reorder it against
 * the lines it shared a millisecond with. **A new line goes after every line
 * not newer than it** — pushes arrive in emission order, so a same-millisecond
 * sibling that came first stays first. **Each legacy level keeps at most
 * `perLevelCap` lines**, the oldest going first, which is the cap the fetched
 * payload was cut to; without it a page left open grows without bound.
 */
export function appendLogLine(
  records: readonly WireLogRecord[],
  line: WireLogRecord,
  perLevelCap: number,
): WireLogRecord[] {
  const incoming = withDefaults(line);
  const held = records.findLastIndex((r) => sameEmission(r, incoming));
  if (held !== -1) {
    const next = records.slice();
    next[held] = { ...incoming, seq: records[held].seq };
    return next;
  }
  const after = records.findLastIndex((r) => r.timestamp <= incoming.timestamp);
  const next = [...records.slice(0, after + 1), incoming, ...records.slice(after + 1)];
  const sameLevel = next.filter((r) => r.level === incoming.level).length;
  if (sameLevel <= perLevelCap) return next;
  const oldest = next.findIndex((r) => r.level === incoming.level);
  next.splice(oldest, 1);
  return next;
}

// ── Severity, in plain language ────────────────────────────────────────

export type AttentionLevel = "attention" | "fyi";

export interface SeverityPresentation {
  level: AttentionLevel;
  /** What the pill says. Two strings, deliberately — see below. */
  label: string;
  /** The existing status tone. No new colours; no fifth tone. */
  tone: DeploymentStatusTone;
}

/**
 * `error` and `warn` both read **Needs attention**; `info` and `debug` read
 * **FYI**.
 *
 * Two words, not four, because the Activity lane's reader is being asked one
 * question — *do I have to do something about this?* — and a four-rung ladder
 * makes them rank severities instead of answering it. The distinction between
 * the two that need attention survives in the **tone**: `error` takes
 * `danger`, `warn` takes the softer `warn`, which is the same pair the
 * deployment ladder already uses for "look at this" versus "watch this".
 *
 * Diagnostics keeps the technical names, which is where a reader who wants
 * the rung goes.
 */
export function presentSeverity(severity: Severity): SeverityPresentation {
  switch (severity) {
    case "error":
      return { level: "attention", label: "Needs attention", tone: "danger" };
    case "warn":
      return { level: "attention", label: "Needs attention", tone: "warn" };
    default:
      return { level: "fyi", label: "FYI", tone: "muted" };
  }
}

const SEVERITY_WEIGHT: Record<Severity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** The loudest severity in a group — an episode card is as urgent as its
 *  worst line, because that is the line the reader has to find. */
export function worstSeverity(severities: readonly Severity[]): Severity {
  let worst: Severity = "debug";
  for (const s of severities) if (SEVERITY_WEIGHT[s] > SEVERITY_WEIGHT[worst]) worst = s;
  return worst;
}

// ── The subject ────────────────────────────────────────────────────────

export interface SubjectPresentation {
  /** What renders. Never a bare uuid when `display` exists. */
  label: string;
  /** The `title=` tooltip — where the uuid is allowed to live. */
  title: string;
}

/**
 * `display` is the subject everywhere it exists (`…4469-ema-x.MNQ`), and the
 * uuid is demoted to the tooltip. That is gate decision 1, and the complaint
 * it answers is the operator's: *"sometimes I have no clue what log belongs
 * to what."*
 *
 * Two fallbacks, both real states rather than defaults. A line under the
 * engine sentinel is about the engine and says so — **"Engine"**. That is
 * this file's answer to what `{display}` renders for the sentinel, and it
 * is the only one: the sentinel has no deployment row to read a display
 * off, so nothing upstream can supply it. And a row hydrated from before
 * the `display`
 * column existed has nothing but its uuid, so the uuid renders, shortened,
 * with the whole of it in the tooltip.
 */
export function presentSubject(record: WireLogRecord): SubjectPresentation {
  if (record.display != null && record.display.length > 0) {
    return { label: record.display, title: record.deploymentId };
  }
  if (record.deploymentId === ENGINE_SCOPE) {
    return { label: "Engine", title: "Engine-wide — this line is not about one deployment" };
  }
  const id = record.deploymentId;
  return { label: id.length > 12 ? `${id.slice(0, 8)}…` : id, title: id };
}

/**
 * The ticker leg of a display name.
 *
 * **Moved to `logging/scrub.ts` on 2026-08-27, re-exported here so this
 * lane's callers and its tests are unchanged** — the same shape and the same
 * reason as `formatGapDuration`'s move: `notify/log-escalation.ts` fills the
 * identical `{ticker}` slot for a Discord title, and it may not import a
 * component. One implementation, and it is that one.
 */
export { tickerOf };

// ── The sentence ───────────────────────────────────────────────────────

export type SentenceSource = "template" | "message";

export interface ActivitySentence {
  text: string;
  source: SentenceSource;
  /**
   * The template slots the wire could not fill, in template order. Empty when
   * `source` is `"template"`. This is the reason the message was used, made
   * inspectable rather than left as a shrug.
   */
  withheld: readonly string[];
}

const SLOT_PATTERN = /\{(\w+)\}/g;

/**
 * What the projected record can put in a slot.
 *
 * Two sources, and the split is where each one is decided. **The subject
 * slots come off the record's own columns** — `{display}` is `display`, and
 * `{ticker}` is the ticker leg of it *or* the record's own `ticker` column,
 * which is what an engine-scoped line naming one contract carries instead of
 * a deployment. **Every other slot comes from `values`**, which the call site
 * handed the pipe alongside the prose it had already interpolated them into.
 *
 * **`values` cannot reach `display` or `ticker`, and the two keys are skipped
 * rather than merely lost to precedence.** The subject slots come off the
 * subject columns and only off them. `display` is scrubbed positionally by
 * `scrubDisplay` on the way into the pipe — unconditionally, because its
 * shape guarantees a leading account number — while a value keyed `display`
 * gets only `scrubMessage`, whose account rule is conditional on the catalog
 * carrying the row. Letting a value win would therefore be a route around
 * the one truncation rule that has no timing hole in it, on the surface
 * where a leak arrives already dressed as English. No call site does this
 * today; the skip is what keeps it that way.
 *
 * A number is stringified here and nowhere else: the conventions that matter
 * (price to two places, P&L signed with its currency) are applied at the
 * call site, from the same formatters its Discord embed uses, so this lane
 * and that alert cannot disagree about what a fill was worth.
 */
function slotValues(record: WireLogRecord): Record<string, string> {
  const values: Record<string, string> = {};
  if (record.display != null && record.display.length > 0) {
    values.display = record.display;
    const ticker = tickerOf(record.display);
    if (ticker != null) values.ticker = ticker;
  }
  if (record.ticker != null && record.ticker.length > 0) values.ticker = record.ticker;
  if (record.values != null) {
    for (const [slot, value] of Object.entries(record.values)) {
      if (slot === "display" || slot === "ticker") continue;
      values[slot] = typeof value === "string" ? value : String(value);
    }
  }
  return values;
}

/**
 * The line's sentence: the event's Activity template when every slot in it
 * resolves, and the record's own scrubbed message otherwise.
 *
 * **A partly-filled template does not render, and that is the whole design
 * decision in this file.** *"Bought {size} MNQ @ {price}"* is a broken
 * sentence and *"Bought MNQ"* is a truthful one that has dropped exactly the
 * discriminators the phone test says may never be dropped — how many, at what
 * price, with which protection. The message the call site wrote carries them,
 * so the message is what renders.
 *
 * **Censused 2026-08-27, after both halves landed: of 173 events, 50 carry
 * an Activity template and every one of them renders.** Two columns closed
 * the gap this file used to describe. `values` carries what a call site
 * interpolated into its prose — size, price, stop, target, P&L, reason,
 * gate, time — so the five trade-spine sentences render from data instead
 * of falling back to the diagnostics line beside them. `ticker` carries the
 * rendered symbol for the ten engine-scoped safety lines that name a
 * contract and no deployment, which had no `display` for `tickerOf` to read
 * and whose `contractId` is deliberately not on the wire.
 *
 * **The fallback is not a leftover, and three shapes still take it.** A
 * value the call site did not have — a trade with no tick distances, so no
 * `{sl}` and no `{tp}`. A contract this install does not map, so no
 * `{ticker}`. And an event whose template is deliberately `null`, which is
 * the answer for a line that is *about* an account or an unreadable
 * contract it cannot name: its own prose says more than a subject-less
 * rewrite could.
 *
 * **A row with no event renders its message too, plainly rather than
 * hidden.** An unclassified line is the one most likely to be the thing that
 * went wrong; a lane that shows only what it has prose for is a lane that
 * hides its own blind spot.
 */
export function renderSentence(record: WireLogRecord): ActivitySentence {
  const spec = record.event == null ? undefined : eventSpec(record.event);
  const template = spec?.template ?? null;
  if (template == null) return { text: record.message, source: "message", withheld: [] };

  const values = slotValues(record);
  const withheld: string[] = [];
  for (const match of template.matchAll(SLOT_PATTERN)) {
    if (!(match[1] in values) && !withheld.includes(match[1])) withheld.push(match[1]);
  }
  if (withheld.length > 0) return { text: record.message, source: "message", withheld };

  return {
    text: template.replace(SLOT_PATTERN, (_whole, slot: string) => values[slot]),
    source: "template",
    withheld: [],
  };
}

// ── Time ───────────────────────────────────────────────────────────────

export interface TimePresentation {
  iso: string;
  /** `2m ago` — through the shared humaniser, not a local seconds count. */
  relative: string;
  /** The full local timestamp, for the component's `title=`. */
  absolute: string;
  /** `09:31:12`, 24-hour so the column cannot jitter on an AM/PM swap. */
  clock: string;
  /** `Oct 27 09:31:12` — the Diagnostics time cell, local. */
  stamp: string;
  /** `Oct 27 09:31` — the Activity time track once a line is an hour old. */
  stampShort: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function presentTime(iso: string, nowMs: number): TimePresentation {
  const at = new Date(iso);
  const ms = at.getTime();
  const valid = Number.isFinite(ms);
  // Clamp: a record stamped a second into the future by clock skew reads
  // "0s ago", never "-1s ago".
  const elapsed = valid ? Math.max(0, nowMs - ms) : 0;
  const clock = valid ? at.toLocaleTimeString(undefined, { hour12: false }) : iso;
  // `en-US` pins the month to three letters in month-day order; the browser's
  // locale would make it `Sept` or `27 Oct` and the column would jitter.
  const monthDay = valid ? `${at.toLocaleString("en-US", { month: "short" })} ${at.getDate()}` : "";
  return {
    iso,
    relative: valid ? `${formatGapDuration(elapsed)} ago` : iso,
    absolute: valid ? at.toLocaleString() : iso,
    clock,
    stamp: valid ? `${monthDay} ${clock}` : iso,
    stampShort: valid ? `${monthDay} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : iso,
  };
}

const HOUR_MS = 3_600_000;

/** The Activity time track: relative while a line is under an hour old,
 *  dated from the hour on, so an older row says which day it is from. */
export function activityTime(time: TimePresentation, nowMs: number): string {
  const ms = Date.parse(time.iso);
  if (!Number.isFinite(ms)) return time.iso;
  return nowMs - ms < HOUR_MS ? time.relative : time.stampShort;
}

const DAY_MS = 86_400_000;

function dayKeyOfDate(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The **local** calendar day, as `YYYY-MM-DD`. Local rather than UTC
 *  because the divider answers "which of my days was this", and a US
 *  evening session sits on the next UTC date. */
export function dayKeyOf(iso: string): string {
  const at = new Date(iso);
  return Number.isFinite(at.getTime()) ? dayKeyOfDate(at) : iso;
}

/** `TODAY` / `YESTERDAY` / `WED 26 AUG 2026` — an uppercase structural
 *  stamp, which is the one place the design language allows 10px. */
export function dayLabel(dayKey: string, nowMs: number): string {
  if (dayKey === dayKeyOfDate(new Date(nowMs))) return "TODAY";
  if (dayKey === dayKeyOfDate(new Date(nowMs - DAY_MS))) return "YESTERDAY";
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!Number.isFinite(y)) return dayKey.toUpperCase();
  const at = new Date(y, (m ?? 1) - 1, d ?? 1);
  return at
    .toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    .toUpperCase();
}

// ── The feed ───────────────────────────────────────────────────────────

export interface ActivityLine {
  key: string;
  /** The subject's id, so a consumer can ask *which* deployment a line is
   *  about without reading what `presentSubject` rendered for it. */
  deploymentId: string;
  event: string | null;
  severity: Severity;
  attention: SeverityPresentation;
  subject: SubjectPresentation;
  sentence: ActivitySentence;
  time: TimePresentation;
  /** `> 1` when the pipe folded repeats onto this row. Renders as `× N`. */
  burstCount: number;
  tradeId: number | null;
  /** The wire's ordinal, carried so a card's lines can break a millisecond
   *  tie the same way the stream did. */
  seq: number;
}

export interface ActivityEpisode {
  tradeId: number;
  subject: SubjectPresentation;
  /** As urgent as the worst line on the card. */
  attention: SeverityPresentation;
  /** The rung behind that pill, for the tooltip — the plain words say
   *  *Needs attention* for both `warn` and `error`, and someone hovering is
   *  asking which. */
  worst: Severity;
  opened: TimePresentation;
  latest: TimePresentation;
  /** How long the episode has run so far, humanised. Null under a second. */
  span: string | null;
  /** Oldest first — an episode reads forward: entry, brackets, exit. */
  lines: ActivityLine[];
}

export type ActivityItem =
  | { kind: "day"; key: string; label: string }
  | { kind: "line"; key: string; line: ActivityLine }
  | { kind: "episode"; key: string; episode: ActivityEpisode };

export interface ActivityFeedOptions {
  nowMs: number;
  /** Free-text filter, matched against the rendered sentence and subject. */
  query?: string;
}

/** A card needs two lines. One line about a trade is not an episode, and
 *  wrapping it in card chrome implies a story that is not there — it also
 *  lies about completeness when the per-level cap clipped its siblings. */
const MIN_EPISODE_LINES = 2;

/**
 * Build the feed. `records` arrive oldest-first, as both ring accessors
 * return them; the feed comes back **newest first**, with day dividers, so a
 * reader starts at what just happened.
 *
 * Episodes group on `tradeId`, which is a `strategy_trades` row id and
 * therefore unique per trade across every deployment — so grouping on it
 * cannot merge two trades, and the "consecutive in time" the spec asks for
 * falls out rather than needing a window. A card sorts by its **latest**
 * line, so an episode that is still running stays at the top where the
 * reader is looking.
 */
export function buildActivityFeed(
  records: readonly WireLogRecord[],
  options: ActivityFeedOptions,
): ActivityItem[] {
  const { nowMs } = options;
  const query = (options.query ?? "").trim().toLowerCase();

  const lines: ActivityLine[] = [];
  records.forEach((record, index) => {
    const sentence = renderSentence(record);
    const subject = presentSubject(record);
    if (query.length > 0) {
      const haystack = `${sentence.text} ${subject.label} ${record.event ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return;
    }
    lines.push({
      key: `${record.timestamp}-${index}`,
      deploymentId: record.deploymentId,
      event: record.event,
      severity: record.severity,
      attention: presentSeverity(record.severity),
      subject,
      sentence,
      time: presentTime(record.timestamp, nowMs),
      burstCount: record.burstCount,
      tradeId: record.tradeId,
      seq: record.seq,
    });
  });

  const byTrade = new Map<number, ActivityLine[]>();
  for (const line of lines) {
    if (line.tradeId == null) continue;
    const bucket = byTrade.get(line.tradeId);
    if (bucket) bucket.push(line);
    else byTrade.set(line.tradeId, [line]);
  }

  // Dividers are inserted after the sort, so the sortable set is the two
  // content kinds only — which is also what lets the day lookup below read
  // an episode's `latest` without a third branch.
  type Sortable = { at: number; item: Exclude<ActivityItem, { kind: "day" }> };
  const sortable: Sortable[] = [];

  for (const line of lines) {
    if (line.tradeId != null && (byTrade.get(line.tradeId)?.length ?? 0) >= MIN_EPISODE_LINES) {
      continue;
    }
    sortable.push({ at: msOf(line.time.iso), item: { kind: "line", key: line.key, line } });
  }

  for (const [tradeId, group] of byTrade) {
    if (group.length < MIN_EPISODE_LINES) continue;
    // Same tie, one level down: a card reads forward, and entry, brackets
    // and exit inside one millisecond must still read in that order.
    const ordered = group
      .slice()
      .sort((a, b) => msOf(a.time.iso) - msOf(b.time.iso) || a.seq - b.seq);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const spanMs = msOf(last.time.iso) - msOf(first.time.iso);
    const worst = worstSeverity(ordered.map((l) => l.severity));
    sortable.push({
      at: msOf(last.time.iso),
      item: {
        kind: "episode",
        key: `trade-${tradeId}`,
        episode: {
          tradeId,
          // The subject is the card's, so take it from the first line that
          // is about a deployment — a reconcile line under the engine
          // sentinel must not rename the card to "Engine".
          //
          // **Matched on the sentinel, not on the rendered word.** This read
          // `l.subject.label !== "Engine"` and so picked the card's subject
          // out of prose: rewording that label — [copy.md](../../docs/modules/ui/copy.md)
          // permits it, it is a rendering — silently re-picked the subject of
          // every episode card, and a deployment whose `display` happened to
          // render as "Engine" was excluded from being one.
          subject:
            ordered.find((l) => l.deploymentId !== ENGINE_SCOPE)?.subject ?? first.subject,
          attention: presentSeverity(worst),
          worst,
          opened: first.time,
          latest: last.time,
          span: spanMs >= 1000 ? formatGapDuration(spanMs) : null,
          lines: ordered,
        },
      },
    });
  }

  sortable.sort((a, b) => b.at - a.at);

  const out: ActivityItem[] = [];
  let openDay: string | null = null;
  for (const entry of sortable) {
    const iso = entry.item.kind === "episode" ? entry.item.episode.latest.iso : entry.item.line.time.iso;
    const day = dayKeyOf(iso);
    if (day !== openDay) {
      out.push({ kind: "day", key: `day-${day}`, label: dayLabel(day, nowMs) });
      openDay = day;
    }
    out.push(entry.item);
  }
  return out;
}

function msOf(iso: string): number {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}
