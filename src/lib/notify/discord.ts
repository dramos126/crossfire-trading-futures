import { getNotificationsEnabled } from "@/lib/db/settings";
import { resolveTopstepWebhookUrl } from "@/lib/db/settings-cache";
import { log } from "@/lib/logger";

interface DiscordField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordAuthor {
  name: string;
  icon_url?: string;
}

interface DiscordFooter {
  text: string;
  icon_url?: string;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordField[];
  author?: DiscordAuthor;
  footer?: DiscordFooter;
  timestamp?: string;
}

// ANSI escape sequences for Discord codeblocks. Discord supports a 4-color
// SGR palette inside ```ansi blocks. Wrap raw text with these AFTER any
// padding math — escape bytes count toward string length and will misalign
// any column padded post-wrap.
const ESC = "";
const ansi = (code: string, s: string): string => `${ESC}[${code}m${s}${ESC}[0m`;
export const ansiGreen = (s: string): string => ansi("1;32", s);
export const ansiRed = (s: string): string => ansi("1;31", s);
export const ansiBlue = (s: string): string => ansi("1;34", s);
export const ansiGray = (s: string): string => ansi("0;37", s);

// Fixed visible-width for every line inside the trade-alert ANSI codeblock.
// Padding to a constant width makes the codeblock render as a clean rectangle
// in Discord regardless of trade data (ticker, price digits, PnL magnitude).
// 40 covers realistic worst-case exit lines: 5-digit price (ES 5318.50, 7
// chars), PnL up to ~$9999.99 (9 chars), tick diffs to ~999.9 (6 chars) —
// the longest row "= PnL        +$9999.99  (+999.9 ticks)" lands at 39.
export const ANSI_LINE_WIDTH = 40;
export const padAnsiLine = (raw: string): string =>
  raw.length >= ANSI_LINE_WIDTH ? raw : raw + " ".repeat(ANSI_LINE_WIDTH - raw.length);

const NY_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Condense an account name into `FIRST-LAST4`. Takes the leading
 * alphanumeric segment before the first hyphen as the prefix, and the last
 * four digits of the full name as the suffix. Falls back to the raw name if
 * no trailing digits are found. Example: `PRAC-V2-100200-90041393` → `PRAC-1393`. */
export function formatAccountLabel(name: string | null | undefined): string {
  if (!name) return "—";
  const prefix = name.split("-")[0] ?? name;
  const digitMatches = name.match(/\d+/g);
  const lastDigits = digitMatches?.[digitMatches.length - 1] ?? "";
  const suffix = lastDigits.slice(-4);
  return suffix ? `${prefix}-${suffix}` : name;
}

export function formatNyTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return `${NY_TIME.format(new Date(iso))} NY`;
  } catch {
    return iso;
  }
}

/**
 * What became of one alert. `silenced` is the operator's own configuration —
 * notifications switched off, or no webhook set — and is not a failure;
 * `failed` is an alert that should have arrived and did not, including a
 * kill-switch read that threw, which fails closed but was nobody's choice.
 */
export type AlertDelivery = "sent" | "silenced" | "failed";

async function postEmbed(
  url: string | undefined,
  embed: DiscordEmbed,
  opts: { exemptFromKillSwitch?: boolean } = {},
): Promise<AlertDelivery> {
  if (!url) return "silenced";
  // Master kill-switch persisted in the DB and toggled from the TopNav.
  // Off by default so a fresh deploy stays quiet until the operator opts in.
  // The one exemption is below, and it is the only caller that may pass it.
  if (!opts.exemptFromKillSwitch) {
    try {
      if (!getNotificationsEnabled()) return "silenced";
    } catch {
      // If the DB read fails for any reason, fail closed (no notification)
      // rather than spamming Discord.
      return "failed";
    }
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      log.event(
        "alert_send_failed",
        "discord",
        `webhook returned ${res.status}: ${await res.text()}`,
      );
      return "failed";
    }
    return "sent";
  } catch (err) {
    log.event(
      "alert_send_failed",
      "discord",
      `webhook failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return "failed";
  }
}

/** Resolves with what became of the alert; most callers ignore it. One that
 *  throttles on "already announced" must not count a `failed` one. */
export async function sendDiscordAlert(embed: DiscordEmbed): Promise<AlertDelivery> {
  return postEmbed(resolveTopstepWebhookUrl() ?? undefined, embed);
}

/**
 * **The one alert the notifications toggle does not silence.**
 *
 * The kill-switch exists so a fresh deploy stays quiet and so routine
 * traffic can be turned off; an emergency close that never reached the
 * broker is neither. Silencing it means a position the operator believes
 * they closed stays open and says so nowhere but `/logs`.
 *
 * **The carve-out is a named function rather than a flag on
 * `sendDiscordAlert`**, deliberately: an `urgent: true` option is something
 * every future call site can talk itself into, and the exemption would
 * spread until the toggle silenced nothing. Its only permitted caller is the
 * escalation sink's exempt-event set — one event, `deployment_flatten_failed`
 * — and `log-escalation.test.ts` pins the caller count repo-wide so a second
 * one fails the suite. Widening it is a decision for
 * [logging](../../../docs/modules/logging/README.md), not a patch.
 */
export async function sendUnsilenceableAlert(embed: DiscordEmbed): Promise<void> {
  await postEmbed(resolveTopstepWebhookUrl() ?? undefined, embed, { exemptFromKillSwitch: true });
}

/**
 * Connection-event alerts (engine-passive, gatewaylogout, manual reconnect
 * results). Shares the trade-notifier webhook — one channel for everything
 * the engine wants the user to know about.
 */
export async function sendConnectionAlert(embed: DiscordEmbed): Promise<void> {
  await postEmbed(resolveTopstepWebhookUrl() ?? undefined, embed);
}

/**
 * Orphan-account alert. Fires when the engine detects that an account is
 * no longer accessible (combine→XFA upgrade, expired sim, etc) and
 * auto-pauses every deployment on it. One alert per orphan event with the
 * full list of paused deployments — see markOrphanedByAccount in
 * src/lib/db/deployments.ts for the dedupe logic that prevents spam when
 * multiple detection sites fire close together.
 */
export async function sendOrphanAlert(opts: {
  accountLabel: string;
  reason: string;
  deployments: Array<{ strategyName: string; ticker: string }>;
}): Promise<void> {
  const list = opts.deployments.length === 0
    ? "—"
    : opts.deployments.map((d) => `• ${d.strategyName} — ${d.ticker}`).join("\n");
  await postEmbed(resolveTopstepWebhookUrl() ?? undefined, {
    title: "Deployments paused — account unavailable",
    color: COLOR_ORPHAN,
    fields: [
      { name: "Account", value: opts.accountLabel, inline: true },
      { name: "Reason", value: opts.reason, inline: true },
      { name: "Paused deployments", value: list },
    ],
  });
}

export const COLOR_CONNECTION_LOST = 0xe67e22;
export const COLOR_CONNECTION_RESTORED = 0x2ecc71;
export const COLOR_ORPHAN = 0xe67e22;

export const COLOR_ENTRY_LONG = 0x2ecc71;
export const COLOR_ENTRY_SHORT = 0xe74c3c;
export const COLOR_EXIT_WIN = 0x27ae60;
export const COLOR_EXIT_LOSS = 0xc0392b;
export const COLOR_EXIT_FLAT = 0x95a5a6;
// Breakeven stop: steel blue. Distinct from amber trail stops (which keep
// the "engine moved the bracket along the run" signal) and from Discord
// blurple used for strategy exits, so all three managed-exit categories
// read as different colors at a glance.
export const COLOR_EXIT_BE = 0x4a90e2;
// Trail stop amber: engine ratcheted the SL further past entry than a BE
// cushion. Warm enough to read distinctly from win green and loss red on
// both light and dark Discord themes.
export const COLOR_EXIT_TRAIL = 0xf5a524;
// Strategy-driven discretionary exits (shouldExit + realtime exits).
// Discord blurple — neutral, signals "engine made a call".
export const COLOR_EXIT_STRATEGY = 0x5865f2;
// Manual / force-close exits (operator action, bracket-failure recovery).
// Orange shares hue with the connection-lost alert intentionally — both
// surface "an operator should know" events.
export const COLOR_EXIT_MANUAL = 0xe67e22;
// Hard red — distinct from regular SL exit (COLOR_EXIT_LOSS). Reserved for
// safety-net actions where the engine had to intervene to avoid unprotected
// exposure (e.g. bracket placement rejected by the broker).
export const COLOR_BRACKET_FAILURE = 0xff0000;
// The nightly regime line. Slate — nothing has happened and nothing is
// gated on it; the embed is a reading, and a colour any of the trade or
// safety families use would put it in one of their conversations.
export const COLOR_REGIME = 0x64748b;
