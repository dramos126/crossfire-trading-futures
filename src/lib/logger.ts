import { consoleLog, taggedEvent, type TaggedSubject } from "@/lib/logging/pipe";
import { scrubMessage } from "@/lib/logging/scrub";

/**
 * Process-wide structured logger — `log.debug/info/warn/error(tag, msg,
 * meta?)`. Use this instead of raw `console.*` for any non-engine code
 * path.
 *
 * **It is a shim over `@/lib/logging/pipe`, not a logger.** Everything it
 * used to own — the level filter, the per-tag `debug` gate, secret
 * redaction, and the console format — lives in the pipe now, and so does
 * the decision every line here used to get wrong by omission: **these
 * lines persist.** `log.*` was console-only and died with the terminal,
 * which is why the broker-registry incident had no evidence. The rules,
 * the ladder and the scrubber are documented in
 * docs/modules/logging/README.md; the env contract (`LOG_LEVEL`,
 * `DEBUG_TAGS`, `LOG_REDACT`) is in docs/modules/infra/README.md.
 *
 * **`log.event(event, tag, msg, subject?)` is the migrated form.** It names
 * a vocabulary event, which decides the severity and the category, and it
 * carries a subject — the account, contract or trade the line is about.
 * The four severity helpers remain for a line that is genuinely one of a
 * kind; `event: null` is a legible state rather than a gap.
 *
 * The tag survives on both. It has stopped being how a migrated line gets
 * its category, and it no longer selects a console format either — the pipe
 * renders one shape for every line regardless of which world emitted it.
 * All that still rides on the tag is the `DEBUG_TAGS` gate.
 *
 * `burstKey` is the fourth argument and almost always absent. It is the
 * call site declaring "my repeats differ in ids alone", which is the only
 * thing that lets the collapser normalise digit runs out of the key — a
 * bare line keys on its exact text, so two ids stay two rows. Passing
 * `undefined` for `meta` to reach it is deliberate: `meta` is the common
 * argument and reordering would touch every call site.
 */
export const log = {
  debug: (tag: string, msg: string, meta?: unknown, burstKey?: string) =>
    consoleLog("debug", tag, msg, meta, burstKey),
  info: (tag: string, msg: string, meta?: unknown, burstKey?: string) =>
    consoleLog("info", tag, msg, meta, burstKey),
  warn: (tag: string, msg: string, meta?: unknown, burstKey?: string) =>
    consoleLog("warn", tag, msg, meta, burstKey),
  error: (tag: string, msg: string, meta?: unknown, burstKey?: string) =>
    consoleLog("error", tag, msg, meta, burstKey),
  event: (event: string, tag: string, msg: string, subject?: TaggedSubject) =>
    taggedEvent(event, tag, msg, subject),
};

/** Scrub a string that is going somewhere the pipe does not reach. */
export function redactForLog(s: string): string {
  return scrubMessage(s);
}
