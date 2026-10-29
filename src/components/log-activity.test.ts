import { describe, it, expect } from "vitest";
import type { WireLogRecord } from "@/lib/logging/pipe";
import { EVENTS, SUBJECT_LESS_TEMPLATES } from "@/lib/logging/vocabulary";
import {
  activityTime,
  appendLogLine,
  buildActivityFeed,
  dayKeyOf,
  mergeLogBuckets,
  dayLabel,
  presentSeverity,
  presentSubject,
  presentTime,
  renderSentence,
  tickerOf,
  worstSeverity,
} from "./log-activity";

/**
 * The Activity lane's model, tested where the decisions are — which sentence
 * renders, which card a record joins, what a reader is told about severity.
 *
 * Nothing here asserts a class name. That is a rendering assertion and
 * [design-language.md](../../docs/modules/ui/design-language.md) owns it.
 */

const DISPLAY = "…4469-ema-crossover.MNQ";
const DEPLOYMENT = "758d19dd-f18d-42b0-a15b-9b6dffd896d5";
const NOW = Date.parse("2026-08-27T14:00:00.000Z");

function record(over: Partial<WireLogRecord> = {}): WireLogRecord {
  return {
    timestamp: "2026-08-27T13:58:00.000Z",
    deploymentId: DEPLOYMENT,
    level: "info",
    message: "a line",
    severity: "info",
    category: "system",
    event: null,
    display: DISPLAY,
    ticker: null,
    tradeId: null,
    values: null,
    burstCount: 1,
    seq: 0,
    ...over,
  };
}

/**
 * The staging shape this lane was built against: one trade, entry through
 * reconcile, every line carrying the same `trade_id`. Messages are the prose
 * the migrated call sites actually write — not idealised copies of the
 * templates — because what the lane can render from them is the whole
 * question.
 */
const TRADE_EPISODE: WireLogRecord[] = [
  record({
    timestamp: "2026-08-27T13:31:12.000Z",
    event: "entry_submitted",
    category: "trade",
    level: "trade",
    tradeId: 4471,
    message: "Trade #4471 entry submitted — 1 MNQ long @ market",
  }),
  record({
    timestamp: "2026-08-27T13:31:13.000Z",
    event: "entry_filled",
    category: "trade",
    level: "trade",
    tradeId: 4471,
    message: "Trade #4471 entry confirmed via user hub @ 29246.25",
    values: { side: "Bought", size: 1, price: "29246.25", sl: "29196.25", tp: "29346.25" },
  }),
  record({
    timestamp: "2026-08-27T13:31:14.000Z",
    event: "bracket_ids_attributed",
    category: "order",
    tradeId: 4471,
    message: "Trade #4471 bracket ids attributed from the place response",
  }),
  record({
    timestamp: "2026-08-27T13:41:02.000Z",
    event: "exit_submitted",
    category: "trade",
    level: "trade",
    tradeId: 4471,
    message: "Trade #4471 exit submitted — time window close",
    values: { reason: "the trading window closed" },
  }),
  record({
    timestamp: "2026-08-27T13:41:04.000Z",
    event: "exit_filled",
    category: "trade",
    level: "trade",
    tradeId: 4471,
    message: "Trade #4471 closed (engine exit) @ 29278.50 | PnL: 32.25 (6.5 ticks)",
    values: { pnl: "+$32.25", reason: "the trading window closed" },
  }),
  record({
    timestamp: "2026-08-27T13:41:20.000Z",
    event: "exit_reconciled",
    category: "trade",
    level: "trade",
    tradeId: 4471,
    message: "Trade #4471 reconciled from broker fills",
  }),
];

describe("severity in plain language", () => {
  it("says Needs attention for error and for warn, and separates them by tone", () => {
    expect(presentSeverity("error")).toEqual({
      level: "attention",
      label: "Needs attention",
      tone: "danger",
    });
    expect(presentSeverity("warn")).toEqual({
      level: "attention",
      label: "Needs attention",
      tone: "warn",
    });
  });

  it("says FYI for info and for debug", () => {
    expect(presentSeverity("info").label).toBe("FYI");
    expect(presentSeverity("debug").label).toBe("FYI");
    expect(presentSeverity("info").tone).toBe("muted");
  });

  it("uses only tones the deployment ladder already has", () => {
    const tones = (["debug", "info", "warn", "error"] as const).map((s) => presentSeverity(s).tone);
    for (const tone of tones) expect(["active", "warn", "danger", "muted"]).toContain(tone);
  });

  it("takes a group's worst severity, which is the line the reader has to find", () => {
    expect(worstSeverity(["info", "error", "warn"])).toBe("error");
    expect(worstSeverity(["info", "debug"])).toBe("info");
    expect(worstSeverity([])).toBe("debug");
  });
});

describe("the subject", () => {
  it("renders display and demotes the uuid to the tooltip", () => {
    const subject = presentSubject(record());
    expect(subject.label).toBe(DISPLAY);
    expect(subject.title).toBe(DEPLOYMENT);
  });

  /** The acceptance line: the uuid appears nowhere a reader looks. */
  it("never puts the uuid in the label when display exists", () => {
    for (const line of TRADE_EPISODE) {
      expect(presentSubject(line).label).not.toContain(DEPLOYMENT);
    }
  });

  it("says Engine for the engine sentinel rather than the word 'engine' or a uuid", () => {
    const subject = presentSubject(record({ deploymentId: "engine", display: null }));
    expect(subject.label).toBe("Engine");
  });

  it("shortens a legacy row's uuid and keeps the whole of it in the tooltip", () => {
    const subject = presentSubject(record({ display: null }));
    expect(subject.label).toBe("758d19dd…");
    expect(subject.title).toBe(DEPLOYMENT);
  });

  it("reads the ticker off the display's last segment", () => {
    expect(tickerOf(DISPLAY)).toBe("MNQ");
    expect(tickerOf("…4469-ema-crossover")).toBeNull();
    expect(tickerOf(null)).toBeNull();
  });
});

describe("the sentence", () => {
  it("renders a subject-only template as its phone-test prose", () => {
    const sentence = renderSentence(
      record({ event: "bracket_place_failed", severity: "error", category: "safety" }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe(
      `Couldn't place the protective stop for ${DISPLAY} — the position is open without it, retrying`,
    );
  });

  it("fills {ticker} from the display's last segment", () => {
    const sentence = renderSentence(
      record({ event: "entry_order_rejected", severity: "error", category: "order" }),
    );
    expect(sentence.text).toBe(
      `The broker refused ${DISPLAY}'s entry order for MNQ — nothing was bought or sold`,
    );
  });

  /**
   * The phone test's mechanical half, over every template the wire can fill:
   * no unfilled slot, no snake_case identifier, and the subject named.
   */
  it("leaves no slot unfilled and no identifier leaked in any rendered template", () => {
    let rendered = 0;
    for (const [event, spec] of Object.entries(EVENTS)) {
      if (spec.template == null) continue;
      const sentence = renderSentence(record({ event, severity: spec.severity, category: spec.category }));
      if (sentence.source !== "template") continue;
      rendered += 1;
      expect(sentence.text).not.toMatch(/[{}]/);
      expect(sentence.text).not.toContain(event);
      expect(sentence.text).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
      // The templates with no subject slot — engine-scoped lines whose
      // sentence is complete without one. Every other rendered template names
      // its subject. `SUBJECT_LESS_TEMPLATES` is read rather than restated:
      // it was one name when this was written and naming it inline is what
      // made the second one fail here instead of in the pin that owns it.
      if (SUBJECT_LESS_TEMPLATES.includes(event)) {
        expect(sentence.text, event).toBe(spec.template);
        continue;
      }
      expect(sentence.text.includes(DISPLAY) || sentence.text.includes("MNQ")).toBe(true);
    }
    // The scan is worth nothing if it matched nothing — the vocabulary is
    // read by name here, so a renamed export would silently pass everything.
    expect(rendered).toBeGreaterThan(30);
  });

  /**
   * The five that cannot render, and why the fallback is the message rather
   * than a shortened sentence: dropping `{price}` or `{pnl}` drops exactly
   * the discriminator the phone test forbids dropping.
   */
  it("falls back to the message when a template names a value the wire does not carry", () => {
    const sentence = renderSentence(
      record({ event: "entry_filled", category: "trade", message: "Trade #4471 filled @ 29246.25" }),
    );
    expect(sentence.source).toBe("message");
    expect(sentence.text).toBe("Trade #4471 filled @ 29246.25");
    expect(sentence.withheld).toEqual(["side", "size", "price", "sl", "tp"]);
  });

  /**
   * The other side of that fallback: the same event, with the values its
   * call site now hands the pipe, renders the whole sentence.
   */
  it("renders a value-slot template from the values the wire carries", () => {
    const sentence = renderSentence(
      record({
        event: "entry_filled",
        category: "trade",
        message: "Trade #4471 entry confirmed via user hub @ 29246.25",
        values: { side: "Bought", size: 1, price: "29246.25", sl: "29196.25", tp: "29346.25" },
      }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe("Bought 1 MNQ @ 29246.25 — stop 29196.25, target 29346.25");
    expect(sentence.withheld).toEqual([]);
  });

  /**
   * A value may not shadow a subject slot. `display` is truncated
   * positionally on the way into the pipe, unconditionally; a value keyed
   * `display` gets only the catalog-conditional message rule, so letting one
   * win would be a route around the truncation that has no timing hole — on
   * the surface where a leak arrives already dressed as English. No call site
   * does this; the skip is what keeps it that way.
   *
   * `LogValues` refuses both keys outright as of 2026-08-27, so the fixture
   * is cast past the compiler on purpose — the values a wire record carries
   * are parsed JSON off a durable column, which no type can vouch for, and
   * this asserts the runtime half that has to hold for one anyway.
   */
  it("renders the subject column's display, never a value that names itself display", () => {
    const sentence = renderSentence(
      record({
        event: "entry_skipped",
        category: "trade",
        level: "trade-skip",
        message: "Skipped entry: the range tier gate said no",
        values: {
          display: "11224469-ema-crossover.ES",
          ticker: "ES",
          gate: "the range tier gate",
        } as unknown as WireLogRecord["values"],
      }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe(
      "Didn't enter MNQ on …4469-ema-crossover.MNQ — the range tier gate said no; the next bar is checked again",
    );
    expect(sentence.text).not.toContain("11224469");
  });

  it("still withholds when the values carry only some of the slots", () => {
    const sentence = renderSentence(
      record({
        event: "entry_filled",
        category: "trade",
        message: "Trade #4471 entry filled @ 29246.25",
        values: { side: "Bought", size: 1, price: "29246.25" },
      }),
    );
    expect(sentence.source).toBe("message");
    expect(sentence.withheld).toEqual(["sl", "tp"]);
  });

  it("shows an unclassified line's message plainly rather than hiding it", () => {
    const sentence = renderSentence(record({ event: null, message: "boot: engine idle" }));
    expect(sentence.source).toBe("message");
    expect(sentence.text).toBe("boot: engine idle");
    expect(sentence.withheld).toEqual([]);
  });

  it("falls back for an event the registry does not carry, rather than throwing", () => {
    const sentence = renderSentence(record({ event: "not_a_real_event", message: "verbatim" }));
    expect(sentence.text).toBe("verbatim");
  });

  it("falls back when the template needs a subject the record has none of", () => {
    // A deployment-scoped template on a row hydrated from before the
    // `display` column existed. `hub_reconnected` used to stand here and no
    // longer can: its template carries no subject slot at all, which is the
    // point of the 2026-08-27 relaxation.
    const sentence = renderSentence(
      record({
        event: "deployment_settled",
        display: null,
        message: "deployment finished closing",
      }),
    );
    expect(sentence.source).toBe("message");
    expect(sentence.withheld).toEqual(["display"]);
  });

  /** The trap, from the other side: the line that could never fill a slot
   *  now renders L0's seed instead of falling back forever. */
  it("renders the subject-less template on an engine-scoped line", () => {
    const sentence = renderSentence(
      record({
        event: "hub_reconnected",
        deploymentId: "engine",
        display: null,
        category: "connection",
        message: "SIGNALR RECONNECTED — market hub online",
      }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe("Reconnected to market data");
    expect(sentence.withheld).toEqual([]);
  });
});

/**
 * The ten engine-scoped safety lines. Each names `{ticker}` and no
 * deployment, so before the rendered-ticker column every one of them fell
 * back to `[SAFETY]`-prefixed diagnostics prose in the lane a non-technical
 * reader gets.
 */
/**
 * **The census, mechanised.** Every templated event, rendered from a record
 * carrying the whole slot vocabulary — the subject columns plus the values
 * the five trade-spine sites supply. Nothing here may fall back.
 *
 * What it pins is that **the slot vocabulary is closed**: a template naming
 * a slot no call site fills and no column supplies would fail here on the
 * day it was written, rather than rendering its diagnostics prose quietly
 * for a phase. That is the failure this whole workstream was filed for.
 */
describe("the template census", () => {
  /** Every slot any shipped template names. Widening this list is the
   *  moment to ask which call site fills the new one. */
  const EVERY_SLOT = {
    side: "Bought",
    size: 1,
    price: "29246.25",
    sl: "29196.25",
    tp: "29346.25",
    pnl: "+$32.25",
    reason: "the trading window closed",
    gate: "the range tier gate",
    time: "at 16:00 NY",
  };

  it("renders every templated event with no slot left over", () => {
    const withheld: string[] = [];
    let templated = 0;
    for (const [event, spec] of Object.entries(EVENTS)) {
      if (spec.template == null) continue;
      templated += 1;
      const sentence = renderSentence(
        record({
          event,
          severity: spec.severity,
          category: spec.category,
          ticker: "MNQ",
          values: EVERY_SLOT,
        }),
      );
      if (sentence.source !== "template") withheld.push(`${event}: ${sentence.withheld.join(",")}`);
      expect(sentence.text, event).not.toMatch(/[{}]/);
    }
    // Empty, and the failure message names the event and the slot it wanted
    // — the census is only useful if a regression says what broke.
    expect(withheld).toEqual([]);
    expect(templated).toBeGreaterThan(45);
  });

  /** The other half of the same claim: a diagnostics-only event renders its
   *  message, and that is a decision rather than a gap. */
  it("renders a diagnostics-only event's own prose", () => {
    const sentence = renderSentence(
      record({
        event: "manual_position_lookup_failed",
        deploymentId: "engine",
        display: null,
        severity: "warn",
        category: "safety",
        message: "Manual-position sweep: position lookup failed for account …4469",
      }),
    );
    expect(sentence.source).toBe("message");
    expect(sentence.withheld).toEqual([]);
  });
});

describe("the engine-scoped safety sentences", () => {
  const TICKER_ONLY = [
    "naked_position_observed",
    "naked_position_flatten",
    "naked_position_flatten_submitted",
    "naked_position_flatten_rejected",
    "orphan_bracket_cancelled",
    "orphan_bracket_unresolved",
    "orphan_bracket_lookup_failed",
    "orphan_bracket_already_terminal",
    "orphan_bracket_cancel_failed",
    "flatten_all_close_failed",
  ];

  function engineLine(event: string): WireLogRecord {
    const spec = EVENTS[event];
    return record({
      event,
      deploymentId: "engine",
      display: null,
      ticker: "MNQ",
      severity: spec.severity,
      category: spec.category,
      message: `[SAFETY] ${event} diagnostics prose (account 11444469, CON.F.US.MNQ.U26)`,
    });
  }

  it("renders all ten from the ticker column, with no [SAFETY] prose left in the lane", () => {
    for (const event of TICKER_ONLY) {
      const sentence = renderSentence(engineLine(event));
      expect(sentence.source, event).toBe("template");
      expect(sentence.withheld, event).toEqual([]);
      expect(sentence.text, event).toContain("MNQ");
      expect(sentence.text, event).not.toContain("[SAFETY]");
      expect(sentence.text, event).not.toContain("CON.F.US.MNQ.U26");
    }
  });

  it("still falls back to the diagnostics line when no ticker resolved", () => {
    const sentence = renderSentence({ ...engineLine("naked_position_flatten"), ticker: null });
    expect(sentence.source).toBe("message");
    expect(sentence.withheld).toEqual(["ticker"]);
  });

  // The subject stays "Engine" — the ticker fills a slot in the sentence and
  // is not a claim about which deployment the line belongs to.
  it("does not turn the ticker into a subject", () => {
    expect(presentSubject(engineLine("naked_position_flatten")).label).toBe("Engine");
  });
});

/**
 * The trade spine, one test per event, with the values its call site now
 * hands the pipe. These are the sentences an operator reads, asserted
 * verbatim rather than by shape — nothing else fails when one of them drifts
 * into prose that no longer answers the phone test, which is the rule
 * [copy.md](../../docs/modules/ui/copy.md) states for a pinned string.
 */
describe("the five trade-spine sentences", () => {
  const SKIP_DISPLAY = "…4469-opening-range-breakout-v2.MNQ";

  it("renders entry_filled, with the direction the fill actually had", () => {
    const long = renderSentence(
      record({
        event: "entry_filled",
        category: "trade",
        message: "Trade #4471 entry filled @ 29246.25",
        values: { side: "Bought", size: 1, price: "29246.25", sl: "29196.25", tp: "29346.25" },
      }),
    );
    expect(long.text).toBe("Bought 1 MNQ @ 29246.25 — stop 29196.25, target 29346.25");

    // The reason `{side}` is a slot: the seed template said "Bought" as a
    // fixed string, which is a false claim on every short.
    const short = renderSentence(
      record({
        event: "entry_filled",
        category: "trade",
        message: "Trade #4472 entry filled @ 29246.25",
        values: { side: "Sold", size: 2, price: "29246.25", sl: "29296.25", tp: "29146.25" },
      }),
    );
    expect(short.text).toBe("Sold 2 MNQ @ 29246.25 — stop 29296.25, target 29146.25");
  });

  it("renders exit_filled with a signed P&L and the reason in plain language", () => {
    const sentence = renderSentence(
      record({
        event: "exit_filled",
        category: "trade",
        message: "Trade #4471 closed (engine exit) @ 29278.50 | PnL: 32.25 (6.5 ticks)",
        values: { pnl: "+$32.25", reason: "the trading window closed" },
      }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe("Closed MNQ +$32.25 — the trading window closed");
  });

  it("renders exit_submitted", () => {
    const sentence = renderSentence(
      record({
        event: "exit_submitted",
        category: "trade",
        message: "EXIT SELL 1 /MNQ (time_window_close)",
        values: { reason: "the trading window closed" },
      }),
    );
    expect(sentence.text).toBe(
      `Closing ${DISPLAY}'s MNQ position — the trading window closed`,
    );
  });

  it("renders entry_skipped with the gate as words rather than as its identifier", () => {
    const sentence = renderSentence(
      record({
        event: "entry_skipped",
        category: "trade",
        level: "trade-skip",
        display: SKIP_DISPLAY,
        message: "[opening-range-breakout-v2] range too wide — gate:rangeTier atr=41.2",
        values: { gate: "the range tier gate" },
      }),
    );
    expect(sentence.source).toBe("template");
    expect(sentence.text).toBe(
      `Didn't enter MNQ on ${SKIP_DISPLAY} — the range tier gate said no; the next bar is checked again`,
    );
  });

  it("renders session_end_flatten with the window that closed", () => {
    const sentence = renderSentence(
      record({
        event: "session_end_flatten",
        category: "trade",
        message: "Outside all session windows (09:30–16:00 NY) — force-exiting",
        values: { time: "at 16:00 NY" },
      }),
    );
    expect(sentence.text).toBe("Session ended at 16:00 NY — closed the MNQ position");
  });

  /** The whole point of the values column, at the surface it was built for:
   *  the episode card's spine reads as sentences rather than as diagnostics. */
  it("renders the episode card's spine from templates", () => {
    const feed = buildActivityFeed(TRADE_EPISODE, { nowMs: NOW });
    const episode = feed.find((i) => i.kind === "episode");
    const lines = episode?.kind === "episode" ? episode.episode.lines : [];
    const byEvent = new Map(lines.map((l) => [l.event, l.sentence]));

    for (const event of ["entry_submitted", "entry_filled", "exit_submitted", "exit_filled"]) {
      expect(byEvent.get(event)?.source, event).toBe("template");
    }
    expect(byEvent.get("entry_filled")?.text).toBe(
      "Bought 1 MNQ @ 29246.25 — stop 29196.25, target 29346.25",
    );
    expect(byEvent.get("exit_filled")?.text).toBe(
      "Closed MNQ +$32.25 — the trading window closed",
    );
    // The two lines with no Activity template still show their own prose —
    // the card does not hide what it has no sentence for.
    expect(byEvent.get("bracket_ids_attributed")?.source).toBe("message");
    expect(byEvent.get("exit_reconciled")?.source).toBe("message");
  });
});

/**
 * The payload is bucketed per legacy level, and the buckets are what a
 * millisecond tie falls through: the three lines of one entry land in
 * `trade` and in `order`, and a merge that sorts on the ISO timestamp alone
 * leaves them in `Object.values` order — which is how a card came to read
 * exit-before-entry.
 */
describe("merging the per-level buckets", () => {
  const AT = "2026-08-27T13:31:12.000Z";

  /** One trade's three lines, emitted in this order, split across the two
   *  buckets the levels put them in, and all in the same millisecond. */
  const BUCKETS: Record<string, WireLogRecord[]> = {
    // Deliberately enumerated with the exit first: this is the order
    // `Object.values` walks, and the ordinal is what has to beat it.
    trade: [
      record({ timestamp: AT, seq: 2, event: "exit_filled", level: "trade", category: "trade", tradeId: 4471, message: "Trade #4471 closed" }),
      record({ timestamp: AT, seq: 0, event: "entry_filled", level: "trade", category: "trade", tradeId: 4471, message: "Trade #4471 entry confirmed" }),
    ],
    info: [
      record({ timestamp: AT, seq: 1, event: "bracket_ids_attributed", level: "info", category: "order", tradeId: 4471, message: "Trade #4471 bracket ids attributed" }),
    ],
  };

  it("orders same-millisecond lines from two buckets by the ring ordinal", () => {
    expect(mergeLogBuckets(BUCKETS).map((r) => r.event)).toEqual([
      "entry_filled",
      "bracket_ids_attributed",
      "exit_filled",
    ]);
  });

  it("renders the episode card entry → brackets → exit", () => {
    const feed = buildActivityFeed(mergeLogBuckets(BUCKETS), { nowMs: NOW });
    const episode = feed.find((item) => item.kind === "episode");
    expect(episode?.kind).toBe("episode");
    if (episode?.kind !== "episode") throw new Error("no episode card");
    expect(episode.episode.lines.map((l) => l.event)).toEqual([
      "entry_filled",
      "bracket_ids_attributed",
      "exit_filled",
    ]);
  });

  // The payload is `res.json()` — declared `WireLogRecord`, `unknown` in
  // fact — and a server one deploy behind sends neither field. `× undefined`
  // in the burst badge and a `NaN` comparator are the visible costs.
  it("floors seq and burstCount for a payload that carries neither", () => {
    const partial = { ...record({ message: "from an older server" }) } as Partial<WireLogRecord>;
    delete partial.seq;
    delete partial.burstCount;
    const [out] = mergeLogBuckets({ info: [partial as WireLogRecord] });
    expect(out.seq).toBe(0);
    expect(out.burstCount).toBe(1);
  });

  it("still orders across milliseconds by timestamp, whatever the ordinals say", () => {
    const later = record({ timestamp: "2026-08-27T13:31:13.000Z", seq: 0, message: "later" });
    const earlier = record({ timestamp: AT, seq: 99, message: "earlier" });
    expect(mergeLogBuckets({ a: [later], b: [earlier] }).map((r) => r.message)).toEqual([
      "earlier",
      "later",
    ]);
  });
});

/**
 * The card's subject is picked by asking which line is about a deployment,
 * and that question has an id to answer it. It used to be answered by
 * matching the rendered word "Engine", which made a label the copy doc
 * treats as rewordable into a selector.
 */
describe("the episode card's subject", () => {
  const AT = "2026-08-27T13:31:12.000Z";

  function pair(displayOfSecond: string | null): WireLogRecord[] {
    return [
      record({
        timestamp: AT,
        seq: 0,
        deploymentId: "engine",
        display: null,
        event: "exit_reconciled",
        category: "trade",
        level: "trade",
        tradeId: 4471,
        message: "Trade #4471 reconciled from broker fills",
      }),
      record({
        timestamp: "2026-08-27T13:31:13.000Z",
        seq: 1,
        display: displayOfSecond,
        event: "entry_filled",
        category: "trade",
        level: "trade",
        tradeId: 4471,
        message: "Trade #4471 entry confirmed",
      }),
    ];
  }

  /** The card's chosen subject, compared against `presentSubject`'s answer
   *  for a named line rather than against a literal — the expectation is
   *  *which line was chosen*, and a reworded label must not decide it. */
  function cardSubject(records: WireLogRecord[]) {
    const feed = buildActivityFeed(records, { nowMs: NOW });
    const episode = feed.find((item) => item.kind === "episode");
    if (episode?.kind !== "episode") throw new Error("no episode card");
    return episode.episode.subject;
  }

  it("takes the subject from the line that is about a deployment", () => {
    const records = pair(DISPLAY);
    expect(cardSubject(records)).toEqual(presentSubject(records[1]));
  });

  // The pin, and it needs the `title` to bite: a deployment whose display
  // renders the same word the sentinel does produces the same *label* either
  // way, and only the uuid behind it says which line was picked. Under the
  // string match both lines read "Engine", the find matched neither, and the
  // card fell back to the engine-scoped line.
  it("is not decided by the rendered word — a display of \"Engine\" still wins", () => {
    const records = pair("Engine");
    expect(cardSubject(records)).toEqual(presentSubject(records[1]));
    expect(cardSubject(records).title).toBe(DEPLOYMENT);
  });

  it("falls back to the first line when every line is engine-scoped", () => {
    const both = pair(null).map((r) => ({ ...r, deploymentId: "engine", display: null }));
    expect(cardSubject(both)).toEqual(presentSubject(both[0]));
  });
});

describe("time", () => {
  it("renders relative through the shared humaniser and keeps the absolute", () => {
    const time = presentTime("2026-08-27T13:58:00.000Z", NOW);
    expect(time.relative).toBe("2m ago");
    expect(time.iso).toBe("2026-08-27T13:58:00.000Z");
    expect(time.absolute).not.toBe(time.relative);
  });

  it("reads under two minutes in seconds", () => {
    expect(presentTime("2026-08-27T13:59:15.000Z", NOW).relative).toBe("45s ago");
  });

  it("clamps a future timestamp instead of counting backwards", () => {
    expect(presentTime("2026-08-27T14:00:05.000Z", NOW).relative).toBe("0s ago");
  });

  // Built from local parts, so the expected strings hold in any TZ the
  // suite runs under.
  const AT = new Date(2026, 9, 27, 9, 31, 12).toISOString();
  const AT_MS = Date.parse(AT);
  const HOUR = 3_600_000;

  it("dates a known timestamp: month day and a 24-hour clock, seconds only on the long form", () => {
    const time = presentTime(AT, AT_MS + 5_000);
    expect(time.stamp).toBe("Oct 27 09:31:12");
    expect(time.stampShort).toBe("Oct 27 09:31");
    const afternoon = presentTime(new Date(2026, 9, 7, 21, 5, 0).toISOString(), AT_MS);
    expect(afternoon.stamp).toBe("Oct 7 21:05:00");
    expect(afternoon.stampShort).toBe("Oct 7 21:05");
  });

  it("Activity reads relative under an hour and flips to the dated form at exactly one hour", () => {
    expect(activityTime(presentTime(AT, AT_MS + HOUR - 1_000), AT_MS + HOUR - 1_000)).toBe("59m ago");
    // A millisecond short is still the relative form. The humaniser rounds to
    // the second, so that last half-second reads "1h ago" rather than "59m ago".
    const justUnder = presentTime(AT, AT_MS + HOUR - 1);
    expect(activityTime(justUnder, AT_MS + HOUR - 1)).toBe(justUnder.relative);
    expect(activityTime(presentTime(AT, AT_MS + HOUR), AT_MS + HOUR)).toBe("Oct 27 09:31");
  });

  it("passes an invalid timestamp through raw in every form", () => {
    const time = presentTime("not-a-time", NOW);
    expect([time.relative, time.absolute, time.clock, time.stamp, time.stampShort]).toEqual(
      Array(5).fill("not-a-time"),
    );
    expect(activityTime(time, NOW)).toBe("not-a-time");
  });

  it("labels today and yesterday, and dates anything older", () => {
    const today = dayKeyOf(new Date(NOW).toISOString());
    expect(dayLabel(today, NOW)).toBe("TODAY");
    expect(dayLabel(dayKeyOf(new Date(NOW - 86_400_000).toISOString()), NOW)).toBe("YESTERDAY");
    const older = dayLabel(dayKeyOf(new Date(NOW - 5 * 86_400_000).toISOString()), NOW);
    expect(older).not.toBe("TODAY");
    expect(older).toBe(older.toUpperCase());
  });
});

describe("the feed", () => {
  it("follows one trade from entry to close as a single card", () => {
    const feed = buildActivityFeed(TRADE_EPISODE, { nowMs: NOW });
    const episodes = feed.filter((item) => item.kind === "episode");
    expect(episodes).toHaveLength(1);
    const episode = episodes[0].kind === "episode" ? episodes[0].episode : null;
    expect(episode?.tradeId).toBe(4471);
    expect(episode?.lines).toHaveLength(6);
    // Oldest first inside the card: an episode reads forward.
    expect(episode?.lines.map((l) => l.event)).toEqual([
      "entry_submitted",
      "entry_filled",
      "bracket_ids_attributed",
      "exit_submitted",
      "exit_filled",
      "exit_reconciled",
    ]);
    expect(episode?.subject.label).toBe(DISPLAY);
    expect(episode?.span).toBe("10m");
  });

  it("takes the card's severity from its worst line", () => {
    const feed = buildActivityFeed(
      [
        ...TRADE_EPISODE.slice(0, 2),
        record({
          timestamp: "2026-08-27T13:31:20.000Z",
          event: "bracket_place_failed",
          severity: "error",
          category: "safety",
          level: "error",
          tradeId: 4471,
          message: "bracket place failed",
        }),
      ],
      { nowMs: NOW },
    );
    const episode = feed.find((i) => i.kind === "episode");
    expect(episode?.kind === "episode" && episode.episode.attention.label).toBe("Needs attention");
    expect(episode?.kind === "episode" && episode.episode.attention.tone).toBe("danger");
  });

  it("keeps a record with no trade id as its own item", () => {
    const feed = buildActivityFeed(
      [record({ event: "hub_reconnected", category: "connection", message: "reconnected" })],
      { nowMs: NOW },
    );
    expect(feed.filter((i) => i.kind === "line")).toHaveLength(1);
    expect(feed.filter((i) => i.kind === "episode")).toHaveLength(0);
  });

  it("does not wrap a lone trade line in card chrome", () => {
    const feed = buildActivityFeed([TRADE_EPISODE[1]], { nowMs: NOW });
    expect(feed.filter((i) => i.kind === "episode")).toHaveLength(0);
    expect(feed.filter((i) => i.kind === "line")).toHaveLength(1);
  });

  it("does not merge two trades that share a deployment", () => {
    const second = TRADE_EPISODE.slice(0, 2).map((r, i) => ({
      ...r,
      tradeId: 4472,
      timestamp: `2026-08-27T13:50:0${i}.000Z`,
    }));
    const feed = buildActivityFeed([...TRADE_EPISODE, ...second], { nowMs: NOW });
    const ids = feed.flatMap((i) => (i.kind === "episode" ? [i.episode.tradeId] : []));
    expect(ids.sort()).toEqual([4471, 4472]);
  });

  it("orders newest first and opens each day with a divider", () => {
    const feed = buildActivityFeed(
      [
        record({ timestamp: "2026-08-26T13:00:00.000Z", message: "older" }),
        record({ timestamp: "2026-08-27T13:00:00.000Z", message: "newer" }),
      ],
      { nowMs: NOW },
    );
    expect(feed.map((i) => i.kind)).toEqual(["day", "line", "day", "line"]);
    expect(feed[0].kind === "day" && feed[0].label).toBe("TODAY");
    expect(feed[1].kind === "line" && feed[1].line.sentence.text).toBe("newer");
    expect(feed[2].kind === "day" && feed[2].label).toBe("YESTERDAY");
  });

  it("sorts a still-running episode by its latest line", () => {
    const feed = buildActivityFeed(
      [
        ...TRADE_EPISODE.slice(0, 2),
        record({ timestamp: "2026-08-27T13:35:00.000Z", message: "a standalone in between" }),
      ],
      { nowMs: NOW },
    );
    const content = feed.filter((i) => i.kind !== "day");
    expect(content[0].kind).toBe("line");
    expect(content[1].kind).toBe("episode");
  });

  it("carries the burst count so a fold can render as × N", () => {
    const feed = buildActivityFeed(
      [record({ burstCount: 23, message: "fill not in tradovate_order_map — dropping" })],
      { nowMs: NOW },
    );
    expect(feed.find((i) => i.kind === "line")?.kind === "line").toBe(true);
    const line = feed.find((i) => i.kind === "line");
    expect(line?.kind === "line" && line.line.burstCount).toBe(23);
  });

  it("filters on the rendered sentence, not only on the stored message", () => {
    const rows = [
      record({ event: "bracket_place_failed", severity: "error", category: "safety", message: "bpf" }),
      record({ message: "something else" }),
    ];
    const feed = buildActivityFeed(rows, { nowMs: NOW, query: "protective stop" });
    const lines = feed.filter((i) => i.kind === "line");
    expect(lines).toHaveLength(1);
    expect(lines[0].kind === "line" && lines[0].line.event).toBe("bracket_place_failed");
  });

  it("renders nothing but model fields, and none of them is an account or contract id", () => {
    const feed = buildActivityFeed(TRADE_EPISODE, { nowMs: NOW });
    const json = JSON.stringify(feed);
    expect(json).not.toContain("12344469");
    expect(json).not.toContain("CON.F.US.MNQ");
    // The uuid survives only in the tooltip field, which is where it is
    // allowed to be — and nowhere in a label or a sentence.
    for (const item of feed) {
      if (item.kind === "day") continue;
      const lines = item.kind === "episode" ? item.episode.lines : [item.line];
      for (const line of lines) {
        expect(line.subject.label).not.toContain(DEPLOYMENT);
        expect(line.sentence.text).not.toContain(DEPLOYMENT);
      }
    }
  });
});

describe("appendLogLine — a pushed line folded into the merged stream", () => {
  const at = (s: number) => `2026-08-27T13:58:${String(s).padStart(2, "0")}.000Z`;

  it("goes after every line not newer than it, so a same-millisecond sibling that came first stays first", () => {
    const held = [record({ timestamp: at(1), message: "entry" }), record({ timestamp: at(3), message: "later" })];
    const next = appendLogLine(held, record({ timestamp: at(1), message: "bracket", seq: 0 }), 100);
    expect(next.map((r) => r.message)).toEqual(["entry", "bracket", "later"]);
  });

  it("replaces a folded repeat where it stands, keeping its seq, rather than adding a second line", () => {
    const held = [record({ timestamp: at(1), message: "cancel failed", seq: 4 }), record({ timestamp: at(2) })];
    const next = appendLogLine(held, record({ timestamp: at(1), message: "cancel failed", burstCount: 3, seq: 9 }), 100);
    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({ message: "cancel failed", burstCount: 3, seq: 4 });
  });

  it("keeps each level to the cap the read was cut to, dropping that level's oldest", () => {
    const held = [
      record({ timestamp: at(1), level: "error", message: "old error" }),
      record({ timestamp: at(2), level: "info", message: "info" }),
      record({ timestamp: at(3), level: "error", message: "newer error" }),
    ];
    const next = appendLogLine(held, record({ timestamp: at(4), level: "error", message: "newest error" }), 2);
    expect(next.map((r) => r.message)).toEqual(["info", "newer error", "newest error"]);
  });

  it("defaults the numbers the lanes read, as the fetched payload is", () => {
    const line = { ...record(), seq: undefined, burstCount: undefined } as unknown as WireLogRecord;
    expect(appendLogLine([], line, 100)[0]).toMatchObject({ seq: 0, burstCount: 1 });
  });
});
