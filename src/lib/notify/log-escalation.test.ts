import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The ladder's Discord sender, and the pin that says it did not disturb
 * anything already reaching the operator.
 *
 * `discord.ts` reaches `db/settings` for the webhook and the notification
 * kill-switch, so the transport is mocked at its own seam and the assertions
 * are about the embed handed to it.
 */

const { sendDiscordAlert, sendUnsilenceableAlert } = vi.hoisted(() => ({
  sendDiscordAlert: vi.fn(async (_embed: Record<string, unknown>) => {}),
  sendUnsilenceableAlert: vi.fn(async (_embed: Record<string, unknown>) => {}),
}));

vi.mock("@/lib/notify/discord", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discord")>()),
  sendDiscordAlert,
  sendUnsilenceableAlert,
}));

// Importing the module is what registers `escalate` as the pipe's escalation
// sink, so `emit` below reaches the mocked transport through the real gate.
import { escalate, escalationTitle, resetLogEscalation } from "./log-escalation";
import { emit, resetLogBursts, type LogRecord } from "@/lib/logging/pipe";
import { EVENTS } from "@/lib/logging/vocabulary";

const T0 = Date.parse("2026-08-26T14:22:53.959Z");

function record(over: Partial<LogRecord> = {}): LogRecord {
  return {
    timestamp: "2026-08-26T14:22:53.959Z",
    deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
    level: "error",
    message: "[SESSION] Clock guard could not force-flat past session close — exit dispatch failed.",
    severity: "error",
    category: "safety",
    event: "session_exit_stranded",
    display: null,
    accountId: 23464469,
    contractId: "CON.F.US.MNQ.U26",
    ticker: null,
    tradeId: null,
    values: null,
    burstKey: null,
    burstCount: 1,
    lastSeenAt: "2026-08-26T14:22:53.959Z",
    ...over,
  };
}

function lastEmbed(): Record<string, unknown> {
  const calls = sendDiscordAlert.mock.calls;
  expect(calls.length, "no alert was sent").toBeGreaterThan(0);
  return calls[calls.length - 1]![0];
}

function fieldValue(name: string): string {
  const fields = lastEmbed().fields as Array<{ name: string; value: string }>;
  const hit = fields.find((f) => f.name === name);
  expect(hit, `no ${name} field`).toBeDefined();
  return hit!.value;
}

const THREE = [
  "deployment_close_stranded",
  "downtime_flatten_failed",
  "naked_position_flatten_rejected",
];

beforeEach(() => {
  sendDiscordAlert.mockClear();
  sendUnsilenceableAlert.mockClear();
  resetLogEscalation();
  // The tests below that go through `emit` share the pipe's process-wide
  // burst window, and a folded repeat never reaches the sink.
  resetLogBursts();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the alert an escalating line becomes", () => {
  it("titles it with the Activity phrasing, not the diagnostics line", () => {
    // The operator reads this one on a phone. The message goes in the
    // description, where the detail belongs.
    escalate(record({ display: "…4469-ema-crossover.MNQ" }), T0);
    expect(lastEmbed().title).toBe(
      "Couldn't close …4469-ema-crossover.MNQ after its trading window ended — the position is still open, and the engine keeps retrying",
    );
    expect(lastEmbed().description).toContain("could not force-flat past session close");
  });

  it("falls back to the deployment id when the engine could not name a subject", () => {
    // `TradingEngine.logEvent` populates `display` off the deployment row, so
    // null here means the row is gone — the alert still goes out, naming what
    // it has. The uuid on a phone is the shape this fallback is a last resort
    // for; `engine.test.ts` pins that the populated path is the usual one.
    escalate(record(), T0);
    expect(escalationTitle(record())).toContain("758d19dd");
  });

  // `$&`, `$'` and `$1` are substitution patterns in a *string* replacement,
  // and the subject is a value this module does not control. The replacement
  // is a function, so they arrive on the phone as themselves.
  it("puts a subject carrying a dollar sequence on the phone verbatim", () => {
    expect(escalationTitle(record({ display: "…4469-a$&b.MNQ" }))).toContain("…4469-a$&b.MNQ");
  });

  it("truncates the account number, because the alert is rendered text", () => {
    escalate(record(), T0);
    expect(fieldValue("Account")).toBe("…4469");
    expect(JSON.stringify(lastEmbed())).not.toContain("23464469");
  });

  it("names the contract, so the operator knows what to look at", () => {
    escalate(record(), T0);
    expect(fieldValue("Contract")).toBe("CON.F.US.MNQ.U26");
  });

  it("says em-dash when a subject column is empty rather than printing null", () => {
    escalate(record({ accountId: null, contractId: null }), T0);
    expect(fieldValue("Account")).toBe("—");
    expect(fieldValue("Contract")).toBe("—");
  });
});

describe("the rate limit", () => {
  it("sends one message per event and subject inside the window", () => {
    // These alarms retry on a 15s or 30s sweep and each repeat renders
    // differently (it says how long the condition has stood), so nothing
    // folds at the pipe. Without this the webhook takes four a minute for as
    // long as the position stays stranded.
    for (let i = 0; i < 8; i++) {
      escalate(record({ message: `stranded for ${i * 30}s` }), T0 + i * 30_000);
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("sends again once the window has elapsed, because the condition still stands", () => {
    escalate(record(), T0);
    escalate(record(), T0 + 300_001);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  it("does not let one subject's alarm mute another's", () => {
    escalate(record(), T0);
    escalate(record({ deploymentId: "other-deployment" }), T0 + 1000);
    escalate(record({ contractId: "CON.F.US.MES.U26" }), T0 + 2000);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(3);
  });

  // The trade axis. Two trades on one deployment and one contract inside the
  // window are two incidents, and the first must not mute the second — the
  // same rule the pipe's burst key states from the other side.
  it("does not let one trade's alarm mute the next trade's", () => {
    escalate(record({ tradeId: 4471 }), T0);
    escalate(record({ tradeId: 4472 }), T0 + 1000);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  it("still folds repeats within one trade", () => {
    escalate(record({ tradeId: 4471, message: "stranded for 30s" }), T0);
    escalate(record({ tradeId: 4471, message: "stranded for 60s" }), T0 + 30_000);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });

  it("does not let one event's alarm mute another's on the same subject", () => {
    escalate(record(), T0);
    escalate(record({ event: "exit_verification_residual" }), T0 + 1000);
    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  // The account axis, and the one that is live rather than latent.
  // `naked_position_flatten_rejected` is emitted under the engine sentinel
  // with an `accountId` and no deployment, so two accounts refused on one
  // contract would share a bucket — and the sweep retries every watchdog
  // tick, so the second account's alarm is starved rather than delayed.
  it("does not let one account's alarm mute another's on the same contract", () => {
    escalate(
      record({
        event: "naked_position_flatten_rejected",
        deploymentId: "engine",
        accountId: 23464469,
      }),
      T0,
    );
    escalate(
      record({
        event: "naked_position_flatten_rejected",
        deploymentId: "engine",
        accountId: 23471234,
      }),
      T0 + 30_000,
    );
    expect(sendDiscordAlert).toHaveBeenCalledTimes(2);
  });

  it("still folds one account's repeats across the window", () => {
    for (let i = 0; i < 8; i++) {
      escalate(
        record({
          event: "naked_position_flatten_rejected",
          deploymentId: "engine",
          accountId: 23464469,
          message: `unprotected for ${i * 30}s`,
        }),
        T0 + i * 30_000,
      );
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
  });
});

/**
 * The three the operator flagged on 2026-08-27, driven through the **real
 * gate** rather than by calling `escalate` directly.
 *
 * That is the point of this describe. `emit` escalates on
 * `severity === "error"` **and** the registry's `escalates`, and a test that
 * calls the sender by hand asserts nothing about either half — removing the
 * flag from `vocabulary.ts` would leave it green. Each already had a
 * phone-test template and each was reaching `/logs` and nowhere else; what
 * is asserted is the shape of what now reaches a phone, per event, because
 * the title is the half that differs between them.
 */
describe("the three flagged on 2026-08-27", () => {
  it("titles a stranded close with the deployment's own sentence", () => {
    emit({
      event: "deployment_close_stranded",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      display: "23464469-ema-crossover.MNQ",
      accountId: 23464469,
      message: "Deployment has been Pausing for 90s and is not flat — exit dispatch failed.",
    });
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
    expect(lastEmbed().title).toBe(
      "…4469-ema-crossover.MNQ was asked to close and its position is still open — the engine keeps retrying, and nothing new will be entered",
    );
    expect(lastEmbed().description).toContain("Pausing for 90s");
  });

  it("titles a failed downtime flatten with the deployment's own sentence", () => {
    emit({
      event: "downtime_flatten_failed",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      display: "23464469-ema-crossover.MNQ",
      accountId: 23464469,
      message: "[RESTART] Could not force-flat a position that went unmanaged for 12h 40m.",
    });
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
    // The two slots resolve from different fields, and a deployment-scoped
    // line leaves `ticker` null because its display already carries one. The
    // ticker slot therefore takes the display's *leg* — filling it with the
    // whole display read "close the …4469-ema-crossover.MNQ position on
    // …4469-ema-crossover.MNQ", which names the subject twice and the symbol
    // never. Asserted whole, because that is the sentence on the phone.
    expect(lastEmbed().title).toBe(
      "Couldn't close the MNQ position on …4469-ema-crossover.MNQ that went unmanaged while the engine was away — it is still open, and the engine keeps retrying",
    );
  });

  // No display and no ticker column: the deployment row is gone, so the uuid
  // is the only subject and it has no ticker leg. A half-filled sentence is
  // exactly what the fallback exists to refuse.
  it("titles a failed downtime flatten with the message when the display is gone", () => {
    const title = escalationTitle(
      record({
        event: "downtime_flatten_failed",
        message: "[RESTART] Could not force-flat a position that went unmanaged for 12h 40m.",
      }),
    );
    expect(title).toBe("[RESTART] Could not force-flat a position that went unmanaged for 12h 40m.");
  });

  // The engine-scoped one. The naked-position sweep is account-scoped by
  // D-16, so there is no deployment and no `display` — and substituting the
  // sentinel would put "the unprotected engine position" on a phone. The
  // rendered ticker is what it fills its one slot from instead.
  it("titles a rejected naked-position flatten with the symbol, never the sentinel", () => {
    emit({
      event: "naked_position_flatten_rejected",
      deploymentId: "engine",
      accountId: 23464469,
      contractId: "CON.F.US.MNQ.U26",
      ticker: "MNQ",
      message:
        "[SAFETY] Naked-position flatten REJECTED: CON.F.US.MNQ.U26, LONG 2 — POSITION REMAINS UNPROTECTED.",
    });
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
    expect(lastEmbed().title).toBe(
      "The broker refused the order to close the unprotected MNQ position — it is still open with no stop, and the engine retries shortly",
    );
    expect(lastEmbed().title).not.toContain("engine position");
    expect(lastEmbed().title).not.toContain("{ticker}");
    // The identifier it was derived from is still server-side, and the
    // description is where the diagnostics line goes.
    expect(lastEmbed().title).not.toContain("CON.F.US.MNQ.U26");
  });

  // The same event with no symbol resolved — a contract this install does
  // not map. The alert must still go out, titled with the message rather
  // than with a half-filled sentence.
  it("falls back to the message when the one slot has nothing to fill it", () => {
    emit({
      event: "naked_position_flatten_rejected",
      deploymentId: "engine",
      accountId: 23464469,
      contractId: "4799969",
      message:
        "[SAFETY] Naked-position flatten REJECTED: 4799969, LONG 2 — POSITION REMAINS UNPROTECTED.",
    });
    expect(sendDiscordAlert).toHaveBeenCalledTimes(1);
    expect(lastEmbed().title).toContain("POSITION REMAINS UNPROTECTED");
    expect(lastEmbed().title).not.toContain("{ticker}");
  });

  it("sends exactly one compact alert each, and nothing for the unflagged neighbours", () => {
    for (const event of THREE) {
      emit({ event, deploymentId: `d-${event}`, message: `${event} happened` });
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(3);
    // Same severity, same category, same family — and not flagged, because
    // each already reaches the operator or is a state the guard refuses to
    // act on rather than one it failed at.
    emit({ event: "bracket_place_failed", deploymentId: "d1", message: "bracket rejected" });
    emit({ event: "downtime_flatten_not_needed", deploymentId: "d1", message: "already flat" });
    emit({ event: "naked_position_observed", deploymentId: "engine", message: "first strike" });
    expect(sendDiscordAlert).toHaveBeenCalledTimes(3);
  });

  it("throttles each of the three on its own subject tuple", () => {
    // Direct, because the throttle is a clock and `emit` takes no instant.
    for (const event of THREE) {
      // Same tuple, four passes of a 30s retry sweep: one alert.
      for (let i = 0; i < 4; i++) {
        escalate(record({ event, message: `${event} standing for ${i * 30}s` }), T0 + i * 30_000);
      }
      // A different contract under the same event is a different incident.
      escalate(record({ event, contractId: "CON.F.US.MES.U26" }), T0 + 1000);
      // And so is a different trade on the same deployment and contract.
      escalate(record({ event, tradeId: 4471 }), T0 + 2000);
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(9);
  });
});

/**
 * The three restart-obligation arms, flagged when they were named. Each is
 * emitted under the engine sentinel and names a *count* of deployments, so
 * none has a subject a template could render — they take `template: null`
 * and the alert titles itself with the message the site already wrote.
 */
describe("the three restart-obligation arms", () => {
  const ARMS: ReadonlyArray<[string, string]> = [
    [
      "downtime_obligation_write_failed",
      "[RESTART] Could not persist the downtime-flatten obligation for 2 deployment(s) — a restart before the sweep drains would drop it. Database said: SQLITE_BUSY",
    ],
    [
      "downtime_obligation_unreadable",
      "[RESTART] Could not read the outstanding downtime-flatten obligation on start — a position owed a flatten may be left open. Database said: SQLITE_BUSY",
    ],
    [
      "downtime_obligation_resumed_without_verdict",
      "[RESTART] Started with 2 deployment(s) still owed a downtime flatten after 12h 40m unmanaged, and no boot verdict was applied this process",
    ],
  ];

  it("sends one alert each, titled with the message rather than the event name", () => {
    for (const [event, message] of ARMS) {
      emit({ event, deploymentId: "engine", message });
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(3);
    const titles = sendDiscordAlert.mock.calls.map((c) => String(c[0].title));
    expect(titles).toEqual(ARMS.map(([, message]) => message));
    // The event name is snake_case shorthand and would be the worst thing
    // on the phone — it is the last resort, below the message.
    for (const title of titles) expect(title).not.toMatch(/^[a-z]+(_[a-z0-9]+)+$/);
  });

  it("does not fold three different arms of one restart into one alert", () => {
    // Same sentinel, same absent contract and trade: the event is the only
    // axis keeping them apart, on both the burst key and the anchor.
    for (const [event] of ARMS) {
      escalate(record({ event, deploymentId: "engine", accountId: null, contractId: null }), T0);
    }
    expect(sendDiscordAlert).toHaveBeenCalledTimes(3);
  });

  // The sentinel is legible in a *field* — "Deployment: engine" reads as
  // engine-wide. It is only in prose that substituting it lies.
  it("puts the sentinel in the deployment field, where it reads correctly", () => {
    emit({
      event: "downtime_obligation_unreadable",
      deploymentId: "engine",
      message: "[RESTART] Could not read the outstanding downtime-flatten obligation on start.",
    });
    expect(fieldValue("Deployment")).toBe("engine");
  });
});

/**
 * The one event the notifications kill-switch may not silence.
 *
 * The switch is read inside `discord.ts`, so the assertion here is about
 * *which sender* the sink reaches for — `sendUnsilenceableAlert` is the
 * function that skips the read, and choosing it per event is the carve-out.
 * Driven through `emit` rather than by calling `escalate`, so the flag in
 * `vocabulary.ts` is part of what is being asserted.
 */
describe("a failed emergency close is not silenced by the notifications toggle", () => {
  function exemptEmbed(): Record<string, unknown> {
    const calls = sendUnsilenceableAlert.mock.calls;
    expect(calls.length, "no unsilenceable alert was sent").toBeGreaterThan(0);
    return calls[calls.length - 1]![0];
  }

  it("sends it through the sender that bypasses the kill-switch", () => {
    emit({
      event: "deployment_flatten_failed",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      display: "23464469-ema-crossover.MNQ",
      accountId: 23464469,
      contractId: "CON.F.US.MNQ.U26",
      message:
        "[FLATTEN] Force flatten returned status=error and did not reach the broker — the position may still be open. broker refused the closing order: Account is not active",
    });
    expect(sendUnsilenceableAlert).toHaveBeenCalledTimes(1);
    // And not also through the gated one: a double alert is the dedupe rule
    // this list sits under.
    expect(sendDiscordAlert).not.toHaveBeenCalled();
    expect(exemptEmbed().title).toBe(
      "Couldn't close the MNQ position on …4469-ema-crossover.MNQ — it may still be open",
    );
  });

  it("carries the diagnostic detail, with the account truncated", () => {
    // Deployment, account, contract and the broker's own words, so the
    // failure can be understood later without a log dive — and the account
    // number is rendered text, so the scrub rule applies to it here exactly
    // as it does in the lane.
    emit({
      event: "deployment_flatten_failed",
      deploymentId: "758d19dd-f18d-42b0-a15b-9b6dffd896d5",
      display: "23464469-ema-crossover.MNQ",
      accountId: 23464469,
      contractId: "CON.F.US.MNQ.U26",
      message:
        "[FLATTEN] Force flatten returned status=error and did not reach the broker — the position may still be open. broker refused the closing order: Account is not active",
    });
    const embed = exemptEmbed();
    const fields = embed.fields as Array<{ name: string; value: string }>;
    expect(fields.find((f) => f.name === "Deployment")?.value).toBe("…4469-ema-crossover.MNQ");
    expect(fields.find((f) => f.name === "Account")?.value).toBe("…4469");
    expect(fields.find((f) => f.name === "Contract")?.value).toBe("CON.F.US.MNQ.U26");
    expect(String(embed.description)).toContain("status=error");
    expect(String(embed.description)).toContain("Account is not active");
    expect(JSON.stringify(embed)).not.toContain("23464469");
  });

  /**
   * **The list is derived from `EVENTS`, not written down here, because the
   * axis that moves is the exempt set and not the caller count.** Adding a
   * member to `KILL_SWITCH_EXEMPT` adds zero call sites, so the repo-wide
   * grep pin below stays green while the carve-out silently widens. This
   * drives every flagged event through the real sink and asserts which side
   * each came out of — so a second member fails here, named.
   *
   * It replaces a version that iterated three of the ten by hand.
   */
  it("routes exactly one of the flagged events to the unsilenceable sender", () => {
    const flagged = Object.entries(EVENTS)
      .filter(([, spec]) => spec.escalates === true)
      .map(([name]) => name);
    // Guards against the derivation silently finding nothing.
    expect(flagged.length).toBeGreaterThan(1);

    const exempt: string[] = [];
    const gated: string[] = [];
    for (const event of flagged) {
      sendDiscordAlert.mockClear();
      sendUnsilenceableAlert.mockClear();
      // A distinct subject and a distinct message per event, so neither the
      // sender's throttle nor the pipe's burst collapser can swallow one and
      // leave it looking un-escalated.
      emit({ event, deploymentId: `d-${event}`, message: `${event} happened` });
      if (sendUnsilenceableAlert.mock.calls.length > 0) exempt.push(event);
      if (sendDiscordAlert.mock.calls.length > 0) gated.push(event);
    }

    expect(exempt).toEqual(["deployment_flatten_failed"]);
    // And the other side: every flagged event reached exactly one sender.
    expect(gated.sort()).toEqual(flagged.filter((e) => e !== "deployment_flatten_failed").sort());
  });
});

/**
 * A title Discord will refuse takes the whole embed with it, and a message
 * carries an unbounded broker error string. The cap is on the title only —
 * the description keeps the full line.
 */
describe("the title's bound", () => {
  it("caps a long message-titled alert at Discord's limit", () => {
    const long = `[SAFETY] Naked-position flatten REJECTED: ${"x".repeat(500)}`;
    const title = escalationTitle(
      record({ event: "naked_position_flatten_rejected", deploymentId: "engine", message: long }),
    );
    expect(title.length).toBe(256);
    expect(title.endsWith("…")).toBe(true);
  });

  it("leaves a rendered template untouched, because an authored one fits", () => {
    const title = escalationTitle(record({ display: "…4469-ema-crossover.MNQ" }));
    expect(title.length).toBeLessThan(256);
    expect(title.endsWith("…")).toBe(false);
  });

  // The cap cuts by code point. A `.slice` on UTF-16 units lands inside a
  // surrogate pair and emits a lone half — a replacement glyph on the phone
  // at best, a rejected payload at worst.
  it("never cuts a surrogate pair in half", () => {
    const title = escalationTitle(
      record({ event: "naked_position_flatten_rejected", deploymentId: "engine", message: "🚨".repeat(400) }),
    );
    expect([...title]).toHaveLength(256);
    expect(title).not.toContain("�");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title)).toBe(false);
  });

  // Discord rejects an over-long *description* exactly as it rejects an
  // over-long title, and the message carries an unbounded broker body — so
  // the alert saying a position is unprotected is the one a verbose broker
  // would suppress. The durable row still keeps the whole line.
  it("caps the description at Discord's limit rather than losing the embed", () => {
    escalate(record({ message: `stranded: ${"x".repeat(6000)}` }), T0);
    const description = String(lastEmbed().description);
    expect(description.length).toBe(4096);
    expect(description.endsWith("…")).toBe(true);
  });

  it("leaves an ordinary description whole", () => {
    escalate(record(), T0);
    expect(lastEmbed().description).toBe(record().message);
  });

  /**
   * The ordering rule at the emit sites, stated where the cap is. These two
   * mirror the shipped wording — `engine-watchdog.ts`'s rejected flatten and
   * `engine.ts`'s obligation-write catch — and the property is that the
   * clause the operator has to act on survives an error body of any length.
   * Written the other way round, the cap ate exactly "POSITION REMAINS
   * UNPROTECTED" and left 256 characters of broker prose.
   */
  it("keeps the consequence clause inside the cap however long the error runs", () => {
    const err = "x".repeat(2000);
    const rejected = escalationTitle(
      record({
        event: "naked_position_flatten_rejected",
        deploymentId: "engine",
        message:
          "[SAFETY] Naked-position flatten REJECTED — POSITION REMAINS UNPROTECTED, will retry next watchdog tick: " +
          `account 23464469, CON.F.US.MNQ.U26, LONG 2. Broker said: ${err}`,
      }),
    );
    expect(rejected).toContain("POSITION REMAINS UNPROTECTED, will retry next watchdog tick");
    expect(rejected).toContain("CON.F.US.MNQ.U26");

    const unwritable = escalationTitle(
      record({
        event: "downtime_obligation_write_failed",
        deploymentId: "engine",
        message:
          "[RESTART] Could not persist the downtime-flatten obligation for 2 deployment(s) — " +
          `a restart before the sweep drains would drop it. Database said: ${err}`,
      }),
    );
    expect(unwritable).toContain("a restart before the sweep drains would drop it");
  });
});

/**
 * L2's acceptance criterion: *"no existing Discord embed changes
 * byte-for-byte."* The ladder covers lines that today reach nobody; it does
 * not re-plumb lines that already reach the operator, and a site with a
 * hand-placed embed is never also flagged `escalates`.
 *
 * A grep-based pin, which is what the criterion can be held by: the count
 * per file is fixed here, so adding a caller — or deleting one — fails until
 * this list is updated deliberately.
 */
describe("every existing sendDiscordAlert site is untouched", () => {
  const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

  const EXPECTED_CALLERS: Readonly<Record<string, number>> = {
    "src/lib/brokers/tradovate/index.ts": 1,
    "src/lib/brokers/tradovate/penalty.ts": 2,
    "src/lib/brokers/tradovate/realtime.ts": 1,
    "src/lib/trading/broker-access/broker-registry.ts": 1,
    "src/lib/trading/engine/boot/boot-engine.ts": 1,
    // Entry, exit, force-close — plus the nightly regime line, which is a
    // reading rather than an incident and carries no flagged event.
    "src/lib/trading/engine/engine-notify.ts": 4,
    // The fatal-auth stop alert, which has its own embed.
    "src/lib/trading/engine/engine.ts": 1,
    // The ladder's own, and the only one L2 adds.
    "src/lib/notify/log-escalation.ts": 1,
  };

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        sourceFiles(full, out);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
    return out;
  }

  it("has exactly the callers this phase inherited, plus the ladder's one", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      // The definition lives in `discord.ts` and is not a call site.
      if (file.endsWith(path.join("notify", "discord.ts"))) continue;
      const count = (text.match(/sendDiscordAlert\(/g) ?? []).length;
      if (count > 0) found[path.relative(REPO_ROOT, file).replace(/\\/g, "/")] = count;
    }
    expect(found).toEqual(EXPECTED_CALLERS);
  });

  /**
   * The dedupe rule, stated positively for the events that carry the flag.
   * `toEqual` above already fails if any of these files grows a caller, but
   * it fails as *"an unexpected key appeared"* — which does not say that the
   * file hosts a flagged event's emit site and that the two would now
   * double-alert. Naming them is the difference between a test that catches
   * it and a test that explains it.
   */
  it("has no hand-placed embed in any file that emits a flagged event", () => {
    const EMIT_SITES = [
      // deployment_close_stranded
      "src/lib/trading/engine/session-close/engine-closing.ts",
      // downtime_flatten_failed, and the three restart-obligation arms live
      // in engine.ts beside the fatal-auth stop alert, which is why that one
      // is counted rather than forbidden.
      "src/lib/trading/engine/boot/engine-restart.ts",
      // naked_position_flatten_rejected
      "src/lib/trading/engine/flatten/engine-watchdog.ts",
      // manual_position_close_failed
      "src/lib/trading/engine/flatten/engine-manual-position.ts",
      // session_exit_stranded
      "src/lib/trading/engine/session-close/engine-session-guard.ts",
      // exit_verification_residual
      "src/lib/trading/engine/engine-exit.ts",
      // deployment_flatten_failed
      "src/lib/trading/engine/flatten/engine-force-flat.ts",
      // deployment_flatten_failed again — the route's engine-down arm is the
      // one condition that never enters the primitive, so it is the second
      // emit site for a flagged event and the only one outside `src/lib`. It
      // reports `deployment_flatten_no_row` instead when the id names no row,
      // which is why the file is listed once rather than twice: the pin is
      // about hand-placed embeds in a file that can escalate, and this file
      // can.
      "src/app/api/deployments/[id]/flatten/route.ts",
      // deployment_contract_unresolved. Its connection alerts go through
      // `sendConnectionAlert`, never a bare `sendDiscordAlert(`.
      "src/lib/trading/engine/engine-market-hub.ts",
      // engine_lease_refused, the one reporter every engine door calls.
      // engine_lease_lost is emitted from boot/engine-restart.ts, above.
      "src/lib/db/lease.ts",
    ];
    for (const rel of EMIT_SITES) {
      const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
      expect((text.match(/sendDiscordAlert\(/g) ?? []).length, rel).toBe(0);
    }
  });

  /**
   * The kill-switch exemption, pinned the same way and for a sharper
   * reason. It is a named function rather than an option on
   * `sendDiscordAlert` precisely so it cannot be opted into in passing —
   * and a pin at 1 is what makes "cannot" true rather than merely
   * documented. A second caller is a decision for logging/README.md.
   */
  it("has exactly one caller of the kill-switch exemption, and it is the sink", () => {
    const found: Record<string, number> = {};
    for (const file of sourceFiles(path.join(REPO_ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      // The definition lives in `discord.ts` and is not a call site.
      if (file.endsWith(path.join("notify", "discord.ts"))) continue;
      const count = (text.match(/sendUnsilenceableAlert\(/g) ?? []).length;
      if (count > 0) found[path.relative(REPO_ROOT, file).replace(/\\/g, "/")] = count;
    }
    expect(found).toEqual({ "src/lib/notify/log-escalation.ts": 1 });
  });

  it("keeps the three trade-embed constructions in engine-notify, plus the regime line", () => {
    // The three trade embeds are the loudest thing the operator already
    // gets. The ladder must not have edited one on its way past. The fourth
    // is phase 2's nightly regime line — a reading on its own cadence, with
    // no flagged event behind it and nothing in common with the three.
    const text = readFileSync(
      path.join(REPO_ROOT, "src/lib/trading/engine/engine-notify.ts"),
      "utf8",
    );
    expect((text.match(/await sendDiscordAlert\(\{/g) ?? []).length).toBe(4);
  });
});
