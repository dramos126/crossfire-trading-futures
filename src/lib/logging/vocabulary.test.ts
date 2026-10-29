import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENTS,
  LEGACY_LEVEL_LADDER,
  SEVERITY_RANK,
  SUBJECT_LESS_TEMPLATES,
  categoryForTag,
  describeEntryGate,
  deriveLegacyLevel,
  eventSpec,
  resolveLadder,
  type LegacyLevel,
  type LogCategory,
  type LogEnvelope,
  type Severity,
} from "./vocabulary";

/**
 * A59: `EVENTS` is keyed on `string` and the engine's `logEvent` deps take
 * `event: string`, so a misspelled name compiles and falls to `info`/`system`.
 * This reads the call sites the table cannot see: an event name written as a
 * literal as the first argument of an emitting call, an `event:` field, or a
 * `…_EVENT` / `…_EVENTS` constant's value.
 */
const SRC_ROOT = join(__dirname, "..", "..");
const EVENT_LITERAL_PATTERNS = [
  /\b(?:logEvent|log\.event|taggedEvent|announce)\(\s*"([a-z][a-z0-9_]*)"/g,
  // An object field, not a parameter or a string-union type annotation.
  /(?<!\()\bevent:\s*"([a-z][a-z0-9_]*)"(?=\s*[,}\n])/g,
];
const EVENT_CONSTANT_PATTERN = /\b[A-Z][A-Z0-9_]*_EVENTS?\b[^=;]*=\s*(\{[^}]*\}|"[^"]*")/g;
const QUOTED_NAME = /"([a-z][a-z0-9_]*)"/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function undeclaredEventLiterals(): string[] {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const source = readFileSync(file, "utf8");
    const rel = file.slice(SRC_ROOT.length + 1);
    for (const pattern of EVENT_LITERAL_PATTERNS) {
      for (const m of source.matchAll(pattern)) {
        if (!(m[1] in EVENTS)) found.add(`${rel}: ${m[1]}`);
      }
    }
    for (const m of source.matchAll(EVENT_CONSTANT_PATTERN)) {
      for (const q of m[1].matchAll(QUOTED_NAME)) {
        if (!(q[1] in EVENTS)) found.add(`${rel}: ${q[1]}`);
      }
    }
  }
  return [...found].sort();
}

const ALL_LEGACY_LEVELS: LegacyLevel[] = [
  "info",
  "warn",
  "error",
  "trade",
  "connection",
  "heartbeat",
  "trade-skip",
];

const ALL_CATEGORIES: LogCategory[] = [
  "trade",
  "order",
  "connection",
  "lifecycle",
  "safety",
  "broker",
  "system",
  "heartbeat",
];

const ALL_SEVERITIES: Severity[] = ["debug", "info", "warn", "error"];

/**
 * The envelope a migrated call site builds for a line that has to land on
 * `level` — the ladder's pair, plus the event for the one chip the pair
 * cannot express. There is no carried level any more: `emit` takes the
 * whole shape, and the chip is derived from it.
 */
function envelopeFor(level: LegacyLevel): LogEnvelope {
  const ladder = LEGACY_LEVEL_LADDER[level];
  if (level === "trade-skip") {
    return { event: "entry_skipped", deploymentId: "d1", message: "m" };
  }
  return {
    event: null,
    severity: ladder.severity,
    category: ladder.category,
    deploymentId: "d1",
    message: "m",
  };
}

describe("the severity ladder", () => {
  it("ranks debug below info below warn below error", () => {
    expect(SEVERITY_RANK.debug).toBeLessThan(SEVERITY_RANK.info);
    expect(SEVERITY_RANK.info).toBeLessThan(SEVERITY_RANK.warn);
    expect(SEVERITY_RANK.warn).toBeLessThan(SEVERITY_RANK.error);
  });
});

describe("the legacy seven-level mapping", () => {
  it("maps every legacy level to a declared severity and category", () => {
    for (const level of ALL_LEGACY_LEVELS) {
      const ladder = LEGACY_LEVEL_LADDER[level];
      expect(ALL_SEVERITIES).toContain(ladder.severity);
      expect(ALL_CATEGORIES).toContain(ladder.category);
    }
  });

  it("maps the four named levels exactly as the model specifies", () => {
    expect(LEGACY_LEVEL_LADDER.trade).toEqual({ severity: "info", category: "trade" });
    expect(LEGACY_LEVEL_LADDER["trade-skip"]).toEqual({ severity: "info", category: "trade" });
    expect(LEGACY_LEVEL_LADDER.connection).toEqual({ severity: "info", category: "connection" });
    expect(LEGACY_LEVEL_LADDER.heartbeat).toEqual({ severity: "info", category: "heartbeat" });
  });

  it("maps the three severities to themselves with category system", () => {
    expect(LEGACY_LEVEL_LADDER.info).toEqual({ severity: "info", category: "system" });
    expect(LEGACY_LEVEL_LADDER.warn).toEqual({ severity: "warn", category: "system" });
    expect(LEGACY_LEVEL_LADDER.error).toEqual({ severity: "error", category: "system" });
  });

  it("round-trips all seven levels through the envelope without losing information", () => {
    for (const level of ALL_LEGACY_LEVELS) {
      const env = envelopeFor(level);
      const { severity, category } = resolveLadder(env);
      expect(deriveLegacyLevel(severity, category, env.event), level).toBe(level);
    }
  });

  it("cannot re-derive trade-skip from the pair alone, which is why the event names it", () => {
    // The collision the model has: `trade` and `trade-skip` share
    // `info/trade`, so a derivation that consults only the pair answers
    // `trade` for both. `entry_skipped` is the discriminator — and it is
    // what let shim A's carried `legacyLevel` retire.
    expect(deriveLegacyLevel("info", "trade", null)).toBe("trade");
    expect(deriveLegacyLevel("info", "trade", "entry_filled")).toBe("trade");
    expect(deriveLegacyLevel("info", "trade", "entry_skipped")).toBe("trade-skip");
  });
});

describe("deriveLegacyLevel", () => {
  it("keeps warn and error out of the routine chips, whatever the category", () => {
    // No legacy level maps to `warn`/`trade` or `error`/`connection`, so a
    // category-first rule would invent a chip the old enum could not
    // produce — and invent in the direction that files a failure under a
    // chip nobody scans for problems.
    expect(deriveLegacyLevel("warn", "trade", null)).toBe("warn");
    expect(deriveLegacyLevel("error", "connection", null)).toBe("error");
    expect(deriveLegacyLevel("error", "trade", null)).toBe("error");
    expect(deriveLegacyLevel("warn", "heartbeat", null)).toBe("warn");
  });

  it("lets a chip-bearing category win at info, where the ladder put it", () => {
    expect(deriveLegacyLevel("info", "trade", null)).toBe("trade");
    expect(deriveLegacyLevel("info", "connection", null)).toBe("connection");
    expect(deriveLegacyLevel("info", "heartbeat", null)).toBe("heartbeat");
  });

  it("falls back to the severity for every category without a chip", () => {
    for (const category of ["order", "lifecycle", "safety", "broker", "system"] as LogCategory[]) {
      expect(deriveLegacyLevel("warn", category, null)).toBe("warn");
      expect(deriveLegacyLevel("error", category, null)).toBe("error");
      expect(deriveLegacyLevel("info", category, null)).toBe("info");
    }
  });

  it("renders debug as info because the legacy enum has no debug chip", () => {
    expect(deriveLegacyLevel("debug", "broker", null)).toBe("info");
    expect(deriveLegacyLevel("debug", "system", null)).toBe("info");
  });

  it("still lets a chip-bearing category name a debug row's chip", () => {
    expect(deriveLegacyLevel("debug", "connection", null)).toBe("connection");
  });

  it("is the inverse of the legacy ladder for all seven levels", () => {
    for (const level of ALL_LEGACY_LEVELS) {
      const { severity, category } = LEGACY_LEVEL_LADDER[level];
      const event = level === "trade-skip" ? "entry_skipped" : null;
      expect(deriveLegacyLevel(severity, category, event), level).toBe(level);
    }
  });
});

/**
 * The chip is derived from the pair, so choosing a category is an
 * operator-visible decision rather than a filing detail: `safety` and
 * `order` carry no chip, so an `info` line filed under either lands on
 * INFO. These are the events whose chip moved during L3, pinned with the
 * disposition the review settled on — see
 * docs/proposals/logging-rework.md § L3 status.
 */
describe("the chips L3 moved", () => {
  function chipOf(event: string): LegacyLevel {
    const spec = eventSpec(event);
    if (!spec) throw new Error(`no spec for ${event}`);
    return deriveLegacyLevel(spec.severity, spec.category, event);
  }

  it("keeps a position-close announcement on TRADE, whichever actor closed it", () => {
    expect(chipOf("session_end_flatten")).toBe("trade");
    expect(chipOf("deployment_close_flatten")).toBe("trade");
    expect(chipOf("downtime_flatten")).toBe("trade");
  });

  it("puts the two endorsed escalations on WARN, where the operator scans", () => {
    // D-2's force-close and the abandoned user-hub reconnect: `trade` and
    // `connection` before L3, and both are conditions the operator has to
    // act on rather than routine traffic.
    expect(chipOf("unmanaged_position_closed")).toBe("warn");
    expect(chipOf("hub_reconnect_abandoned")).toBe("warn");
  });

  it("tells a displaced session from a transient close, which is why they are two events", () => {
    expect(chipOf("ws_session_displaced")).toBe("warn");
    expect(chipOf("ws_disconnected")).toBe("connection");
  });

  it("pins the one chip that moved down — defensible, and reported late", () => {
    // A bracket retry is order plumbing, not a trade episode, so `order`
    // is right and INFO is what `order` derives. Recorded because L3
    // claimed chips moved in one direction and this one did not.
    expect(chipOf("bracket_retry_submitted")).toBe("info");
  });
});

/**
 * The escalation list, enumerated. `emit` reads `escalates` and nothing
 * else does, so the registry *is* the decision about what rings a phone at
 * 3am — and a flag added or dropped in passing is invisible in a diff of a
 * 1,000-line table. Listing them here makes either one a deliberate edit.
 */
describe("the events flagged for Discord", () => {
  const FLAGGED = [
    "session_exit_stranded",
    "manual_position_close_failed",
    "exit_verification_residual",
    "deployment_close_stranded",
    "downtime_flatten_failed",
    "naked_position_flatten_rejected",
    "downtime_obligation_write_failed",
    "downtime_obligation_unreadable",
    "downtime_obligation_resumed_without_verdict",
    // The operator's per-deployment flatten, failed. Flagged 2026-09-01: it
    // was left off on the reasoning that its caller is a request somebody is
    // watching, and phase 0 of the UI rework ships no surface to watch it —
    // so the result is returned to a method with no reader.
    "deployment_flatten_failed",
    // The exchange early-close calendar running out. Flagged because past its
    // horizon the session-end flatten silently assumes every session closes
    // at its normal time, which is bugs.md A63 wearing a fresh date — and
    // because it fires a month ahead, so the ping has somewhere to go.
    "session_calendar_stale",
    // A row whose playbook this build does not register, holding a position
    // nothing manages; re-said by the session guard while it stands.
    "deployment_playbook_unavailable_in_position",
    // A leg the broker cannot resolve a contract for gets no bars, so no
    // entries and no bar-close exits, and nothing else says so.
    "deployment_contract_unresolved",
    // The build's registry is not prod-playbooks.ts's list.
    "boot_playbooks_mismatch",
    // Two engines on one database: an entry point refused for want of the
    // lease, or a running engine found it taken and stopped.
    "engine_lease_refused",
    "engine_lease_lost",
    // A standby gave up on the hand-off: the deploy failed and the active
    // engine is still trading on the build it started with.
    "handoff_refused",
    // The liveness gate's row read failing for longer than the ratchet's
    // threshold: the frozen stamp already guarantees the next boot flattens.
    "liveness_gate_unreadable_persistent",
  ].sort();

  it("is exactly this list", () => {
    const found = Object.entries(EVENTS)
      .filter(([, spec]) => spec.escalates === true)
      .map(([name]) => name)
      .sort();
    expect(found).toEqual(FLAGGED);
  });

  // The gate is `severity === "error" && escalates`, so a flagged event at
  // any other severity is a flag that can never fire — dead configuration
  // reading as a live alarm.
  it("carries error severity on every one, or the flag cannot fire", () => {
    for (const name of FLAGGED) {
      expect(eventSpec(name)?.severity, name).toBe("error");
    }
  });

  // The dedupe rule's other half is a grep pin in `log-escalation.test.ts`:
  // a site with a hand-placed rich embed is never also flagged.
  it("names a safety condition on every one", () => {
    for (const name of FLAGGED) {
      expect(eventSpec(name)?.category, name).toBe("safety");
    }
  });

  // The three engine-scoped ones. An Activity template must carry a subject
  // discriminator and these have none — no deployment, a count rather than
  // one ticker — so a template here would be a slot that never fills, which
  // `hub_reconnected` already is. Their alert titles itself with the
  // message; see `log-escalation.test.ts`.
  it("leaves the engine-scoped ones diagnostics-only rather than forcing a slot", () => {
    for (const name of [
      "downtime_obligation_write_failed",
      "downtime_obligation_unreadable",
      "downtime_obligation_resumed_without_verdict",
    ]) {
      expect(eventSpec(name)?.template, name).toBeNull();
    }
  });
});

/**
 * The five `error` lines L3 left carrying `event: null`. A nameless `error`
 * can carry no flag, so it cannot reach Discord however loud it is — and it
 * reads as a considered non-escalation when it is the absence of a
 * decision. Naming them is what made the decision expressible; the three
 * restart-obligation arms took it and the other two did not.
 */
describe("the five error sites named on 2026-08-27", () => {
  it("declares each one at error, where the call site already had it", () => {
    for (const name of [
      "downtime_obligation_write_failed",
      "downtime_obligation_unreadable",
      "downtime_obligation_resumed_without_verdict",
      "stop_move_ambiguous_sl",
      "bracket_recovery_metadata_missing",
    ]) {
      expect(eventSpec(name)?.severity, name).toBe("error");
    }
  });

  // The chip is derived from the pair, so the category is what decides
  // whether `/logs` still files these where the operator has been reading
  // them. `error` outranks any category in `deriveLegacyLevel`, so all five
  // stay on ERROR — asserted rather than reasoned, because L3 moved four
  // chips without anyone deciding to.
  it("moves no chip: all five derived ERROR before and still do", () => {
    for (const name of [
      "downtime_obligation_write_failed",
      "downtime_obligation_unreadable",
      "downtime_obligation_resumed_without_verdict",
      "stop_move_ambiguous_sl",
      "bracket_recovery_metadata_missing",
    ]) {
      const spec = eventSpec(name)!;
      expect(deriveLegacyLevel(spec.severity, spec.category, name), name).toBe("error");
    }
  });

  it("keeps the restart arms under safety and the other two under order", () => {
    expect(eventSpec("downtime_obligation_write_failed")?.category).toBe("safety");
    expect(eventSpec("downtime_obligation_unreadable")?.category).toBe("safety");
    expect(eventSpec("downtime_obligation_resumed_without_verdict")?.category).toBe("safety");
    expect(eventSpec("stop_move_ambiguous_sl")?.category).toBe("order");
    expect(eventSpec("bracket_recovery_metadata_missing")?.category).toBe("order");
  });

  // Deployment-scoped, so `{display}` and `{ticker}` both resolve off the
  // wire's `display` and these two earn Activity prose. Not flagged: the
  // stop stays where the strategy put it and the next bar retries, and the
  // force-close the other one triggers already builds its own rich embed.
  it("gives the two deployment-scoped ones a template and no flag", () => {
    for (const name of ["stop_move_ambiguous_sl", "bracket_recovery_metadata_missing"]) {
      expect(eventSpec(name)?.template, name).not.toBeNull();
      expect(eventSpec(name)?.escalates, name).toBeUndefined();
    }
  });
});

/**
 * The stop-move refusals the no-loosen guard emits. The not-tighter line is
 * compared against the broker's resting stop or, when the broker's order
 * carries no price, the stop the engine last set — so the fixed words may
 * claim neither, and `{reason}` says which.
 */
describe("the stop-move refusals", () => {
  it("names the compared stop through {reason} and says the engine retries", () => {
    const template = eventSpec("stop_move_not_tighter")?.template ?? "";
    expect(template).toContain("{reason}");
    expect(template).not.toMatch(/broker/);
    expect(template).toMatch(/next bar/);
  });

  it("keeps the unknown-stop line at warn: break-even and trail are off meanwhile", () => {
    expect(eventSpec("stop_move_unknown_stop")).toMatchObject({ severity: "warn", category: "order" });
    expect(eventSpec("stop_move_unknown_stop")?.template).toMatch(/next bar/);
  });
});

/**
 * The `{gate}` slot's rendering. A gate is a *stable identifier* the
 * strategy author invents, so there is no table to look one up in and the
 * derivation has to be honest about what it can do: unpick casing, and stop.
 */
describe("describeEntryGate", () => {
  it("splits an identifier into words and names it a gate", () => {
    expect(describeEntryGate("rangeTier")).toBe("the range tier gate");
    expect(describeEntryGate("vwap")).toBe("the vwap gate");
    expect(describeEntryGate("stopGeometry")).toBe("the stop geometry gate");
    expect(describeEntryGate("bodyClose")).toBe("the body close gate");
  });

  it("names a filter a filter, and drops the prefix from the words", () => {
    expect(describeEntryGate("filter:adx")).toBe("the adx filter");
    expect(describeEntryGate("filter:time_window")).toBe("the time window filter");
  });

  // `slGate` already ends in the noun, and "the sl gate gate" is how a
  // mechanical suffix reads when nobody checks it against real values.
  it("does not repeat a noun the identifier already ends in", () => {
    expect(describeEntryGate("slGate")).toBe("the sl gate");
  });

  it("answers null for a gate it cannot make words out of, which withholds the slot", () => {
    expect(describeEntryGate("")).toBeNull();
    expect(describeEntryGate("   ")).toBeNull();
    expect(describeEntryGate("filter:")).toBeNull();
  });
});

describe("categoryForTag", () => {
  it("maps the broker worlds to broker", () => {
    expect(categoryForTag("tradovate.realtime")).toBe("broker");
    expect(categoryForTag("tradovate.client")).toBe("broker");
    expect(categoryForTag("topstep.realtime")).toBe("broker");
    expect(categoryForTag("broker-registry")).toBe("broker");
  });

  it("maps engine and db to system", () => {
    expect(categoryForTag("engine")).toBe("system");
    expect(categoryForTag("db")).toBe("system");
  });

  it("maps the transport tags to connection", () => {
    expect(categoryForTag("signalr")).toBe("connection");
    expect(categoryForTag("broadcaster")).toBe("connection");
  });

  // Both of these were writing durable rows under `system` while L4 was
  // being built to read the column back.
  it("maps flatten-all to safety and bar-aggregator to system", () => {
    expect(categoryForTag("flatten-all")).toBe("safety");
    expect(categoryForTag("bar-aggregator")).toBe("system");
  });

  it("falls to system for a tag nobody has mapped", () => {
    expect(categoryForTag("something-new")).toBe("system");
    expect(categoryForTag("")).toBe("system");
  });
});

describe("resolveLadder", () => {
  it("takes severity and category from the registry when the event names one", () => {
    expect(
      resolveLadder({ event: "bracket_place_failed", deploymentId: "d1", message: "m" }),
    ).toEqual({ severity: "error", category: "safety" });
  });

  // The escalation gate reads the resolved severity, so a caller that could
  // outrank the registry could talk a flagged event out of ringing a phone
  // by passing a quieter level beside it. `hub_reconnected` is `info` in
  // the registry and stays `info` however loudly the call site asks.
  it("the registry outranks a caller's quieter level", () => {
    expect(
      resolveLadder({
        event: "hub_reconnected",
        severity: "warn",
        deploymentId: "d1",
        message: "m",
      }),
    ).toEqual({ severity: "info", category: "connection" });
  });

  it("falls back to the caller's pair for an event the registry does not carry", () => {
    expect(
      resolveLadder({
        event: "not_yet_enumerated",
        severity: "warn",
        category: "safety",
        deploymentId: "d1",
        message: "m",
      }),
    ).toEqual({ severity: "warn", category: "safety" });
  });

  it("falls to info/system for an event the registry does not carry", () => {
    expect(resolveLadder({ event: "not_yet_enumerated", deploymentId: "d1", message: "m" })).toEqual(
      { severity: "info", category: "system" },
    );
  });
});

describe("the seeded event vocabulary", () => {
  it("declares a severity and category the model recognises for every event", () => {
    for (const [name, spec] of Object.entries(EVENTS)) {
      expect(ALL_SEVERITIES, name).toContain(spec.severity);
      expect(ALL_CATEGORIES, name).toContain(spec.category);
    }
  });

  it("names every event in snake_case", () => {
    for (const name of Object.keys(EVENTS)) {
      expect(name, name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });

  it("gives a diagnostics-only event no Activity template", () => {
    expect(eventSpec("order_frame")?.template).toBeNull();
    expect(eventSpec("order_frame")?.severity).toBe("debug");
  });

  it("returns undefined for an event nobody has declared", () => {
    expect(eventSpec("not_yet_enumerated")).toBeUndefined();
  });

  it("A59: every event name a call site writes as a literal is in the table", () => {
    expect(undeclaredEventLiterals()).toEqual([]);
  });

  it("declares the detached entry refusal as its own warn/lifecycle event", () => {
    expect(eventSpec("deployment_detached")).toMatchObject({ severity: "warn", category: "lifecycle" });
    expect(eventSpec("deployment_detached")?.template).toMatch(/^\{display\} /);
  });

  // L0 acceptance criterion 1. The judgement half of the phone test is a
  // review bar; these are the parts a test can hold — a line read aloud is
  // worthless without its discriminators, and internal shorthand is the
  // operator's literal complaint ("3 months down the line I won't have any
  // idea what D-2 or A-## means").
  describe("the phone test", () => {
    const activityTemplates = Object.entries(EVENTS).filter(([, s]) => s.template !== null);

    it("has Activity-eligible seeds to check", () => {
      expect(activityTemplates.length).toBeGreaterThan(0);
    });

    /**
     * **An engine-scoped event may carry a subject-less template, and the
     * exceptions are named rather than inferred** — in
     * `SUBJECT_LESS_TEMPLATES`, beside the table, because
     * `acceptance.test.ts` reads the same list and a second copy is a second
     * thing to keep true. This describe is where the *pin* lives: the
     * equality below is what makes adding one a deliberate act.
     *
     * The rule used to be unconditional, and it manufactured the defect it
     * was meant to catch: `hub_reconnected` is emitted under the engine
     * sentinel and was given `{display}` to satisfy this assertion, so it
     * rendered its message every time — a guaranteed fallback wearing a
     * sentence. The relaxation is narrow: a template with no subject is
     * allowed only for a line whose sentence is *complete* without one, and
     * a line that is genuinely about a leg or an account it cannot name
     * takes `template: null` instead.
     */
    it("carries a subject discriminator in every Activity template but the named ones", () => {
      for (const [name, spec] of activityTemplates) {
        if (SUBJECT_LESS_TEMPLATES.includes(name)) continue;
        expect(spec.template, name).toMatch(/\{(display|ticker)\}/);
      }
    });

    it("names every subject-less template, and each one is a whole sentence", () => {
      const found = activityTemplates
        .filter(([, spec]) => !/\{(display|ticker)\}/.test(spec.template!))
        .map(([name]) => name);
      expect(found.sort()).toEqual([...SUBJECT_LESS_TEMPLATES].sort());
      // L0's seed, restored: it says what happened and needs no subject,
      // because the market feed is the engine's rather than a leg's.
      expect(eventSpec("hub_reconnected")?.template).toBe("Reconnected to market data");
    });

    /**
     * The other half of the same decision. These are emitted under the
     * engine sentinel and are *about* an account or an unreadable contract,
     * so a subject-less rewrite would drop the one discriminator that
     * matters; their call sites' prose names it, truncated by the scrubber.
     * Pinned because re-adding a `{display}` here reads like an improvement
     * and is the trap this whole rule exists for.
     */
    it("leaves the account-scoped manual-position arms diagnostics-only", () => {
      for (const name of [
        "manual_position_lookup_failed",
        "manual_position_unreadable_contract",
        "manual_position_rows_unreadable",
      ]) {
        expect(eventSpec(name)?.template, name).toBeNull();
      }
    });

    it("carries no internal shorthand in any Activity template", () => {
      for (const [name, spec] of activityTemplates) {
        expect(spec.template, name).not.toMatch(/\b[A-Z]{1,2}-\d+\b/);
      }
    });

    it("leaks no snake_case identifier into Activity prose", () => {
      for (const [name, spec] of activityTemplates) {
        const prose = spec.template!.replace(/\{[^}]*\}/g, "");
        expect(prose, name).not.toMatch(/\b[a-z]+(_[a-z0-9]+)+\b/);
      }
    });
  });
});
