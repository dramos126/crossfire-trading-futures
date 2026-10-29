import { sendDiscordAlert, sendUnsilenceableAlert, COLOR_BRACKET_FAILURE } from "@/lib/notify/discord";
import { setEscalationSink, type LogRecord } from "@/lib/logging/pipe";
import { tickerOf, truncatedAccount } from "@/lib/logging/scrub";
import { ENGINE_SCOPE, eventSpec } from "@/lib/logging/vocabulary";

/**
 * The ladder's Discord consumer.
 *
 * An `error` line whose event the vocabulary flagged `escalates` becomes one
 * compact message. **This covers lines that today reach nobody**; every
 * hand-placed rich embed (the boot verdict, the trade embeds, the connection
 * alerts) is untouched, and a site with one of those is never also flagged,
 * so nothing double-alerts.
 *
 * **Registered at import time, not at engine construction** — same pattern
 * and same reason as the store's sink in `db/engine-logs.ts`, and the import
 * direction is the same one-way edge: this module reaches into `logging/`,
 * never the reverse.
 *
 * Owned by docs/modules/logging/README.md.
 */

/**
 * One message per `(event, deployment, account, contract, trade)` per five
 * minutes.
 *
 * The pipe's burst collapser is a 30s window on identical *text*, which is
 * the wrong bound for a webhook: these alarms retry on a 15s or 30s sweep and
 * say how long the condition has stood, so each repeat renders differently
 * and none of them folds. Without this, one stranded position posts four
 * messages a minute for as long as it stays stranded.
 *
 * Same shape as the engine's own report anchors, and the same reason for the
 * period: a standing condition's cadence is the market's, not the engine's.
 */
const ESCALATION_THROTTLE_MS = 300_000;

/**
 * **The sweep trigger, not a cap.** Crossing it sweeps every anchor older
 * than the throttle window; anchors *inside* the window are what the map is
 * for, so none of them is evicted and the size can exceed this. What
 * actually bounds it is the domain: at most one anchor per live
 * `(flagged event, deployment, contract, trade)` tuple, over the handful of
 * flagged events. The threshold is far above that, so in practice the sweep
 * is the thing that keeps it small and this number never binds.
 *
 * The sweep is on insert so this module owns no timer anyone has to
 * remember to clear — the process runs 24/7.
 */
const MAX_ANCHORS = 500;

const lastSentAt = new Map<string, number>();

/** Exported for tests; a fresh process starts with none. */
export function resetLogEscalation(): void {
  lastSentAt.clear();
}

/**
 * The composition contract the pipe's burst key already answers to, applied
 * on this side of it: **a throttle may not erase a discriminator its records
 * carry on purpose.** `tradeId` is on the record, and leaving it
 * out of the key means the second of two trades on one deployment and one
 * contract inside five minutes is silently not alerted — which is the whole
 * failure mode, because a stranded position on one trade tells the operator
 * nothing about the next. Latent rather than live only because none of the
 * first three flagged events populated `tradeId`; the ones flagged since do
 * not either, so keep this axis rather than pruning it as unused.
 *
 * **The account axis is the one that is live today.**
 * `naked_position_flatten_rejected` is emitted under the engine sentinel and
 * carries `accountId`, so without it two accounts refused a close on the same
 * contract share one bucket — and that sweep retries on every watchdog tick,
 * so the second account's alarm would be starved for as long as the condition
 * stands rather than merely delayed.
 */
function anchorKey(record: LogRecord): string {
  return [
    record.event ?? "",
    record.deploymentId,
    record.accountId ?? "",
    record.contractId ?? "",
    record.tradeId ?? "",
  ].join("|");
}

function shouldSend(record: LogRecord, nowMs: number): boolean {
  const key = anchorKey(record);
  const last = lastSentAt.get(key);
  if (last != null && nowMs - last < ESCALATION_THROTTLE_MS) return false;
  lastSentAt.set(key, nowMs);
  if (lastSentAt.size > MAX_ANCHORS) {
    for (const [k, at] of lastSentAt) {
      if (nowMs - at >= ESCALATION_THROTTLE_MS) lastSentAt.delete(k);
    }
  }
  return true;
}

/**
 * The account number, truncated the way the pipe truncates one in rendered
 * text. The structural column carries the full id and this is a rendering of
 * it — the same rule, applied at the one surface that reads the column, and
 * through `scrub.ts`'s own `truncatedAccount` rather than a second copy of
 * the `…last4` form that can drift from it.
 */
function accountField(accountId: number | null): string {
  return accountId == null ? "—" : truncatedAccount(accountId);
}

/** Discord rejects the whole embed when the title exceeds this, so a title
 *  taken from an unbounded message is capped rather than silently 400'd. */
const TITLE_MAX = 256;

/** The same rejection, on the field that carries the raw line. The message a
 *  flagged event hands over embeds a broker or SQLite error body with no
 *  bound on it, and an over-long *description* loses the whole embed exactly
 *  as an over-long title does — so the alert that says a position is
 *  unprotected would be the one alert a verbose broker suppresses. */
const DESCRIPTION_MAX = 4096;

/** Sliced by **code point** rather than by UTF-16 unit, and the unit the
 *  limit is counted in is an assumption worth naming: Discord's docs say
 *  "characters" without saying which, its API counts code points, and
 *  discord.js counts UTF-16 units. This reads them as code points — the
 *  looser of the two, so a title full of astral characters could still be
 *  rejected — because slicing that way is the only one of the two that can
 *  never emit a lone surrogate, which is a replacement character on the
 *  phone at best and a rejected payload at worst. If a real rejection ever
 *  proves the other reading, halve the bound rather than change the slice. */
function capped(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join("")}…`;
}

/**
 * The alert's title: the event's Activity template with the subject filled
 * in. It is the phrasing the operator gets on their phone, so it is the one
 * written to survive being read aloud — the diagnostics line goes in the
 * description.
 *
 * **A slot renders only when the record carries something to fill it with,
 * and otherwise the message is the title** — the same rule `renderSentence`
 * applies in the Activity lane, for the same reason: a half-filled sentence
 * drops exactly the discriminators the phone test forbids dropping.
 *
 * **The two slots resolve from different fields.** `{display}` comes from
 * the display or the deployment id; `{ticker}` comes from the rendered
 * `ticker` column first and the **ticker leg** of the display after that.
 * The first source is what took `naked_position_flatten_rejected` off the
 * fallback: the naked-position sweep is account-scoped under D-16, so it has
 * no `display` and never will, and substituting the sentinel would have put
 * *"the unprotected engine position"* on a phone. It titles with the symbol.
 *
 * **The second source is the leg, never the whole display**, which is the
 * Activity lane's rule read off the same helper. A deployment-scoped line
 * leaves `ticker` null because its display already carries one, so
 * `downtime_flatten_failed` read *"close the …4469-ema-crossover.MNQ
 * position on …4469-ema-crossover.MNQ"* — a sentence that says the subject
 * twice and the symbol never.
 *
 * **The fallback is still live and still load-bearing**: a flagged event
 * with `template: null` — the three restart-obligation arms, which name a
 * *count* of deployments — and any line whose slots the record cannot fill.
 * The event name would be snake_case shorthand; the message is prose the
 * call site already wrote.
 *
 * **The deployment-id fallback stays for a deployment-scoped line.** A uuid
 * is a poor subject but it is a real one; the row being gone is a state, and
 * the title still names which deployment.
 */
export function escalationTitle(record: LogRecord): string {
  const template = record.event == null ? null : eventSpec(record.event)?.template;
  const display =
    record.display ?? (record.deploymentId === ENGINE_SCOPE ? null : record.deploymentId);
  // The rendered symbol first and the display's ticker leg second: an
  // account-scoped line carries a ticker and no display, and a
  // deployment-scoped one carries a display whose last segment is the symbol.
  const ticker = record.ticker ?? tickerOf(display);
  const unfillable =
    template != null &&
    ((display == null && template.includes("{display}")) ||
      (ticker == null && template.includes("{ticker}")));
  if (template == null || unfillable) {
    return capped(
      record.message.length > 0 ? record.message : (record.event ?? "Engine alarm"),
      TITLE_MAX,
    );
  }
  // One pass, and the replacement is a **function**. Two chained global
  // replaces with a *string* replacement had two ways to go wrong on a value
  // this module does not control: `$&`, `$'` and `$1` are substitution
  // patterns inside a string replacement, and a subject containing the
  // literal `{ticker}` would have been re-substituted by the second pass.
  // Neither is reachable from today's displays; both are free to close.
  //
  // The two `!` are sound only through `unfillable` above: it returns early
  // for exactly the slot the template names and the record cannot fill, so
  // reaching here means every slot present in `template` has a value.
  // Simplifying that predicate — dropping either `includes` check, or
  // testing both fields unconditionally — breaks these assertions.
  return capped(
    template.replace(/\{display\}|\{ticker\}/g, (slot) =>
      slot === "{display}" ? display! : ticker!,
    ),
    TITLE_MAX,
  );
}

/**
 * The events the notifications kill-switch may not silence.
 *
 * **One member, and the list is the enforcement.** A failed emergency close
 * is the operator asking for a position to be closed and the order never
 * reaching the broker — the toggle turns off routine alerts, and this is not
 * one. Everything else on the flagged list respects the switch, including
 * its unattended siblings: they are conditions the engine keeps retrying on
 * an interval, so silence delays the news rather than losing it.
 *
 * Adding a member is a decision for logging/README.md's escalation section,
 * where the rule is written. Do not generalise this into an `urgent` flag on
 * `EventSpec` — every site can talk itself into one.
 */
const KILL_SWITCH_EXEMPT: ReadonlySet<string> = new Set(["deployment_flatten_failed"]);

export function escalate(record: LogRecord, nowMs: number = Date.now()): void {
  if (!shouldSend(record, nowMs)) return;
  const embed = {
    title: escalationTitle(record),
    // The message is already scrubbed — the pipe does that once, on the way
    // in, and this reads the same field the row and the ring read. Capped
    // for the same reason the title is: the durable row keeps the full line.
    description: capped(record.message, DESCRIPTION_MAX),
    // Hard red, the tone reserved for the engine failing to complete a
    // protective action. Every event flagged today is one of those.
    color: COLOR_BRACKET_FAILURE,
    fields: [
      { name: "Deployment", value: record.display ?? record.deploymentId, inline: true },
      { name: "Account", value: accountField(record.accountId), inline: true },
      { name: "Contract", value: record.contractId ?? "—", inline: true },
    ],
    timestamp: record.timestamp,
  };
  // Two named senders rather than one taking a flag, and the branch is
  // written out rather than selecting a function into a variable: the
  // caller-count pins in `log-escalation.test.ts` are greps, so a call
  // through an alias would leave both of them reading zero.
  if (record.event != null && KILL_SWITCH_EXEMPT.has(record.event)) {
    void sendUnsilenceableAlert(embed);
    return;
  }
  void sendDiscordAlert(embed);
}

setEscalationSink(escalate);
