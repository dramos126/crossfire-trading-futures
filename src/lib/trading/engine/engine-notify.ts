// Discord notification cluster extracted from engine.ts. Every function
// here renders an embed and hands it to `sendDiscordAlert`; none of them
// touches broker state, order flow or the tick loop. The only engine
// state read is the account-name cache, reached through `NotifyDeps`.

import { getDeployment } from "@/lib/db/deployments";
import { getGroup, getGroupLegTotal } from "@/lib/db/deployment-groups";
import type { StrategyTrade } from "@/lib/db/trade-types";
import {
  sendDiscordAlert,
  formatNyTime,
  formatAccountLabel,
  COLOR_ENTRY_LONG,
  COLOR_ENTRY_SHORT,
  COLOR_EXIT_WIN,
  COLOR_EXIT_LOSS,
  COLOR_EXIT_FLAT,
  COLOR_EXIT_BE,
  COLOR_EXIT_TRAIL,
  COLOR_EXIT_STRATEGY,
  COLOR_EXIT_MANUAL,
  COLOR_BRACKET_FAILURE,
  COLOR_REGIME,
  ansiGreen,
  ansiRed,
  ansiBlue,
  ansiGray,
  ANSI_LINE_WIDTH,
  padAnsiLine,
} from "@/lib/notify/discord";
import type { LogSubject } from "./engine";
import {
  ENGINE_SCOPE,
  type LogCategory,
  type Severity,
} from "@/lib/logging/vocabulary";
import { bracketPricesFromFill, fmtPrice, fmtSignedDollars } from "./engine-fill-format";
import {
  bracketExitReason,
  exitReasonLabel,
  resolveExitReason as resolveSubmittedExitReason,
  type ExitReasonCode,
  type ResolvedExitReason,
} from "@/lib/logging/exit-reasons";
import { getStrategy } from "../strategies";
import { resolveTimeframe } from "../strategy-types";
import type { RegimeResult } from "../regime/classify-regime";

/** Blank spacer row inside an ANSI codeblock. Padded to the same width as
 *  the content rows because an unpadded blank row narrows the block in
 *  Discord and breaks the rectangle. */
const ANSI_GAP_ROW = " ".repeat(ANSI_LINE_WIDTH);

/** Truncation cap for broker rejection text quoted into an embed field.
 *  Discord refuses the whole embed when a single field value runs past its
 *  limit, and a rejection string is the one field here whose length we do
 *  not control — so the alert that says the position is unprotected must
 *  not be the one Discord drops. */
const EMBED_FIELD_VALUE_MAX = 1000;

/** Drift-detector threshold in {@link resolveExitReason}: an SL resting
 *  further than this beyond entry reads as a trail ratchet rather than a
 *  breakeven move. Geometry only ever warns against the flags; it classifies
 *  no row, legacy or new. */
const LEGACY_TRAIL_OFFSET_TICKS = 10;

/**
 * Embed stripe colour per exit-reason **code**.
 *
 * A `Record<ExitReasonCode, …>` and not a chain of string tests: adding a
 * code to the table without deciding its colour now fails to compile, which
 * is the compile-time link the three homes never had.
 *
 * **`engine_downtime` is deliberately not coloured like an operator
 * flatten.** It is the one exit reason nobody asked for — the position went
 * unmanaged past D-13's duration rule and the next boot closed it — and the
 * operator-flatten colour tells someone scanning Discord that a human
 * flattened this, which is the opposite of what happened and the wrong thing
 * to stop investigating. It takes the loss colour the boot alert already uses
 * for the same event. `time_window_close` and the residual `bracket_manual`
 * both render gray: an exit happened, with no trade thesis to colour.
 */
const EXIT_REASON_COLOR: Readonly<Record<ExitReasonCode, number>> = {
  take_profit: COLOR_EXIT_WIN,
  stop_loss: COLOR_EXIT_LOSS,
  breakeven_stop: COLOR_EXIT_BE,
  trail_stop: COLOR_EXIT_TRAIL,
  strategy_signal: COLOR_EXIT_STRATEGY,
  realtime_exit: COLOR_EXIT_STRATEGY,
  time_stop: COLOR_EXIT_STRATEGY,
  ema_exit: COLOR_EXIT_STRATEGY,
  time_window_close: COLOR_EXIT_FLAT,
  deployment_close: COLOR_EXIT_MANUAL,
  bracket_failure_force_close: COLOR_EXIT_MANUAL,
  engine_downtime: COLOR_EXIT_LOSS,
  manual_position_close: COLOR_EXIT_MANUAL,
  flatten_all: COLOR_EXIT_MANUAL,
  flatten_deployment: COLOR_EXIT_MANUAL,
  manual: COLOR_EXIT_MANUAL,
  bracket_manual: COLOR_EXIT_FLAT,
};

/**
 * Emoji prefix per code. `bracket_manual` gets none so the title still parses
 * cleanly. BE/Trail share 🛡 with the plain stop; the colour stripe
 * (steel-blue / amber / red) is what distinguishes them.
 */
const EXIT_REASON_EMOJI: Readonly<Record<ExitReasonCode, string>> = {
  take_profit: "🎯",
  stop_loss: "🛡",
  breakeven_stop: "🛡",
  trail_stop: "🛡",
  strategy_signal: "⚡",
  realtime_exit: "⚡",
  time_stop: "⚡",
  ema_exit: "⚡",
  time_window_close: "⏱",
  deployment_close: "✋",
  bracket_failure_force_close: "✋",
  engine_downtime: "🚨",
  manual_position_close: "✋",
  flatten_all: "✋",
  flatten_deployment: "✋",
  manual: "✋",
  bracket_manual: "",
};

/** Exported for the test that pins the `engine_downtime` split above. */
export function exitReasonColor(code: ExitReasonCode): number {
  return EXIT_REASON_COLOR[code];
}

export function exitReasonEmoji(code: ExitReasonCode): string {
  return EXIT_REASON_EMOJI[code];
}

/**
 * Engine-internal surface used by the notification helpers. Mirrors the
 * {@link import("./engine-exit").ExitOrderDeps} pattern: the new module
 * calls private engine methods through bound callbacks rather than
 * flipping access modifiers.
 */
export interface NotifyDeps {
  /** Live handle to the engine's account-name cache — read-only here, and
   *  refreshed on the engine's own TTL. */
  accountNames: ReadonlyMap<number, string>;
  log: (
    deploymentId: string,
    severity: Severity,
    category: LogCategory,
    message: string,
    subject?: LogSubject,
  ) => void;
}

/**
 * Discord embed footer. Renders `Group: "name" · {account_name} of {total}`
 * so the trader sees which leg fired in a multi-account fan-out. `total`
 * queries the live leg count at embed time so soft-deletes shrink the
 * denominator naturally — no stored ordinal that would go stale.
 *
 * **A one-leg deployment falls back to the bare account label**, which is
 * what a standalone rendered before every deployment had a parent: *"of 1"*
 * is noise on a line whose whole job is disambiguating a fan-out.
 */
export function buildEmbedFooter(deploymentId: string, accountLabel: string): string {
  const dep = getDeployment(deploymentId);
  if (!dep) return accountLabel;
  const group = getGroup(dep.groupId);
  if (!group) return accountLabel;
  const total = getGroupLegTotal(dep.groupId);
  if (total <= 1) return accountLabel;
  const groupLabel = group.name ?? group.strategyKey;
  return `Group: "${groupLabel}" · ${accountLabel} of ${total}`;
}

/** Render the deployment's bar timeframe for the Discord author line.
 *  Strategies declare timeframe in `config.timeframe` and some allow a
 *  per-deployment override via `paramValues.timeframe`. Returns null
 *  when neither resolves to a known short form so the author line drops
 *  the segment instead of showing an empty middle. */
export function resolveTimeframeLabel(strategyKey: string, deploymentId: string): string | null {
  const strategy = getStrategy(strategyKey);
  if (!strategy) return null;
  const deployment = getDeployment(deploymentId);
  const tf = resolveTimeframe(strategy.config, deployment?.paramValues);
  if (typeof tf !== "string" || tf.length === 0) return null;
  return tf;
}

export async function notifyEntry(
  deps: NotifyDeps,
  // The row's own fields, so a renamed or retyped column fails here instead
  // of drifting into a second shape (A26).
  trade: Pick<
    StrategyTrade,
    | "id" | "deploymentId" | "strategyKey" | "accountId" | "ticker" | "side" | "size"
    | "tickSize" | "tickValue" | "desiredTpTicks" | "desiredSlTicks" | "desiredEntryPrice"
  >,
  fillPrice: number,
  filledAt: string,
  // What the broker filled, not what the row submitted. Same argument and
  // same default as `entryFillValues` — the embed's headline and the
  // Activity sentence quote one fill, so a partial that over-states in one
  // place must not under-state in the other.
  filledSize: number = trade.size,
): Promise<void> {
  // Use the actual broker-side bracket prices (fillPrice ± resolvedTicks)
  // and the resolved tick distances directly. Earlier code derived prices
  // from the *desired* entry but recomputed ticks against the *actual*
  // fill, producing inconsistent pairs (e.g. "TP 27368 (16 ticks)" when
  // the order on the broker was actually 60 ticks at 27357). The desired
  // prices are still useful for slippage tracking (separate column),
  // but the entry alert should describe what's resting on Topstep right
  // now — that's what will actually fire.
  const tickSize = trade.tickSize ?? 0;
  const tickValue = trade.tickValue ?? 0;
  const isLong = trade.side === 0;
  const tpTicks = trade.desiredTpTicks;
  const slTicks = trade.desiredSlTicks;
  const { tpPrice, slPrice } = bracketPricesFromFill(trade, fillPrice);
  const sideLabel = isLong ? "LONG" : "SHORT";
  const accountLabel = formatAccountLabel(deps.accountNames.get(trade.accountId) ?? String(trade.accountId));
  // Display name of the strategy that fired the signal — pulled from
  // the registry so the alert reads "Bar Close Pulse" instead of the
  // slug. Falls back to the slug when the strategy isn't registered
  // (e.g. removed module + orphaned trade).
  const strategyName = getStrategy(trade.strategyKey)?.config.name ?? trade.strategyKey;

  // Single ANSI codeblock body. Pad price / tick columns on RAW strings
  // before wrapping with ANSI — escape bytes count toward padStart length
  // and will misalign columns if applied after the wrap.
  const entryPriceStr = fmtPrice(fillPrice);
  const tpPriceStr = tpPrice != null ? fmtPrice(tpPrice) : null;
  const slPriceStr = slPrice != null ? fmtPrice(slPrice) : null;
  const priceWidth = Math.max(
    entryPriceStr.length,
    tpPriceStr?.length ?? 0,
    slPriceStr?.length ?? 0,
  );
  const tpTickStr = tpTicks != null ? `+${tpTicks}` : null;
  const slTickStr = slTicks != null ? `−${slTicks}` : null;
  const tickColWidth = Math.max(tpTickStr?.length ?? 0, slTickStr?.length ?? 0);

  const lines: string[] = [];
  lines.push(ansiBlue(padAnsiLine(`> Entry    ${entryPriceStr.padStart(priceWidth, " ")}`)));
  if (tpPriceStr != null && tpTickStr != null) {
    lines.push(
      ansiGreen(
        padAnsiLine(
          `+ TP       ${tpPriceStr.padStart(priceWidth, " ")}  ${tpTickStr.padStart(tickColWidth, " ")} ticks`,
        ),
      ),
    );
  }
  if (slPriceStr != null && slTickStr != null) {
    lines.push(
      ansiRed(
        padAnsiLine(
          `- SL       ${slPriceStr.padStart(priceWidth, " ")}  ${slTickStr.padStart(tickColWidth, " ")} ticks`,
        ),
      ),
    );
  }

  // Inline-computed entry slippage. The reconcile path persists the
  // canonical value to entry_slippage_ticks later, but the entry embed
  // fires from the user-hub size>0 event BEFORE reconcile runs — so
  // recompute from desiredEntryPrice + the actual fill we already have
  // in hand. Sign convention matches the persisted column: positive =
  // worse than the strategy's desired entry, negative = price improvement.
  const fmtSignedTicks = (v: number): string => {
    if (v >= 0) return `+${v.toFixed(1)}`;
    return `−${Math.abs(v).toFixed(1)}`;
  };
  const slipTicks = trade.desiredEntryPrice != null && tickSize > 0
    ? ((fillPrice - trade.desiredEntryPrice) * (isLong ? 1 : -1)) / tickSize
    : null;
  const slipStr = slipTicks != null ? fmtSignedTicks(slipTicks) : null;

  const riskDollars = slTicks != null && tickSize > 0 && tickValue > 0
    ? slTicks * tickValue * filledSize
    : null;

  if (slipStr != null || riskDollars != null) {
    lines.push(ANSI_GAP_ROW);
    if (slipStr != null) {
      lines.push(ansiGray(padAnsiLine(`  Slippage ${slipStr} ticks`)));
    }
    if (riskDollars != null) {
      lines.push(ansiGray(padAnsiLine(`  Risk     $${riskDollars.toFixed(2)}`)));
    }
  }

  const description = `\`\`\`ansi\n${lines.join("\n")}\n\`\`\``;

  const timeframeLabel = resolveTimeframeLabel(trade.strategyKey, trade.deploymentId);
  const authorName = timeframeLabel != null
    ? `${strategyName} · ${timeframeLabel}`
    : strategyName;

  await sendDiscordAlert({
    title: `${sideLabel} ${trade.ticker} · ${filledSize} contract${filledSize === 1 ? "" : "s"}`,
    author: { name: authorName },
    description,
    color: isLong ? COLOR_ENTRY_LONG : COLOR_ENTRY_SHORT,
    footer: { text: buildEmbedFooter(trade.deploymentId, accountLabel) },
    timestamp: filledAt,
  });
}

export async function notifyExit(
  deps: NotifyDeps,
  trade: {
    id: number;
    deploymentId: string;
    strategyKey: string;
    accountId: number;
    ticker: string;
    side: 0 | 1;
    size: number;
    entryPrice: number | null;
    entryFilledAt: string | null;
  },
  exitPrice: number,
  exitFilledAt: string,
  pnlTicks: number,
  pnlDollars: number,
  exitReason: ResolvedExitReason,
): Promise<void> {
  const isLong = trade.side === 0;
  const sideLabel = isLong ? "LONG" : "SHORT";
  const accountLabel = formatAccountLabel(deps.accountNames.get(trade.accountId) ?? String(trade.accountId));
  const strategyName = getStrategy(trade.strategyKey)?.config.name ?? trade.strategyKey;

  // PnL formatting: real minus sign for negatives, "+" for positives,
  // bare "$0.00" for flat. Same convention applied to the tick / point
  // diffs in the body so signs read consistently.
  const fmtSigned = (v: number, digits: number): string => {
    if (v > 0) return `+${v.toFixed(digits)}`;
    if (v < 0) return `−${Math.abs(v).toFixed(digits)}`;
    return v.toFixed(digits);
  };

  // Compact duration: <60s → "12s", <60m → "4m 23s", <24h → "1h 14m",
  // ≥24h → "2d 3h". Falls back to "—" if entryFilledAt is missing
  // (entry-fill timestamp not yet healed from Trade/search).
  const formatDuration = (entryIso: string | null, exitIso: string): string => {
    if (entryIso == null) return "—";
    const ms = new Date(exitIso).getTime() - new Date(entryIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const totalSec = Math.floor(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60) return `${totalMin}m ${totalSec % 60}s`;
    const totalHr = Math.floor(totalMin / 60);
    if (totalHr < 24) return `${totalHr}h ${totalMin % 60}m`;
    const days = Math.floor(totalHr / 24);
    return `${days}d ${totalHr % 24}h`;
  };
  const duration = formatDuration(trade.entryFilledAt, exitFilledAt);

  // Single ANSI codeblock body — pad value columns on RAW strings before
  // ANSI wrapping. Entry / Exit / PnL form the top section; Duration /
  // Size form the gray metadata section below. Slippage lives on the
  // entry embed (it describes the entry fill, not the exit).
  const entryStr = trade.entryPrice != null ? trade.entryPrice.toFixed(2) : "—";
  const exitStr = exitPrice.toFixed(2);
  const pnlStr = fmtSignedDollars(pnlDollars);
  const ticksStr = fmtSigned(pnlTicks, 1);
  const valueWidth = Math.max(entryStr.length, exitStr.length, pnlStr.length);

  // The row's submitted size, not the filled one, and deliberately left that
  // way: `notifyEntry` quotes the fill, so a 1-of-2 partial disagrees with
  // this line by one. The number is not in scope to fix it with — the single
  // caller resolves the exit through three layers and none yields a filled
  // quantity (`PreResolvedExit` carries no size, `resolveExitFromFills` sums
  // one and does not return it, and the bar-close approximation has no fill
  // at all), and the position mirror is null on that branch by construction.
  // Guessing here would be the fallback rule the entry path just removed.
  const sizeStr = `${trade.size} contracts`;

  const topLines: string[] = [];
  topLines.push(ansiBlue(padAnsiLine(`> Entry      ${entryStr.padStart(valueWidth, " ")}`)));

  // Exit price color follows the reason category — TP green, SL red, BE
  // blue, everything else gray. PnL color is independent (sign-driven).
  const exitColorWrap = ((): (s: string) => string => {
    if (exitReason.code === "take_profit") return ansiGreen;
    if (exitReason.code === "stop_loss") return ansiRed;
    if (exitReason.code === "breakeven_stop") return ansiBlue;
    return ansiGray;
  })();
  topLines.push(exitColorWrap(padAnsiLine(`= Exit       ${exitStr.padStart(valueWidth, " ")}`)));

  const pnlColorWrap = pnlDollars > 0 ? ansiGreen : pnlDollars < 0 ? ansiRed : ansiGray;
  topLines.push(
    pnlColorWrap(
      padAnsiLine(`= PnL        ${pnlStr.padStart(valueWidth, " ")}  (${ticksStr} ticks)`),
    ),
  );

  const bottomLines: string[] = [
    ansiGray(padAnsiLine(`  Duration  ${duration}`)),
    ansiGray(padAnsiLine(`  Size      ${sizeStr}`)),
  ];

  const blockBody = `${topLines.join("\n")}\n${ANSI_GAP_ROW}\n${bottomLines.join("\n")}`;

  const description = `\`\`\`ansi\n${blockBody}\n\`\`\``;

  // The reason code is the single source of truth — the embed, the chip and
  // the persisted label all render from it, so they cannot disagree.
  const reasonColor = exitReasonColor(exitReason.code);
  const reasonEmoji = exitReasonEmoji(exitReason.code);

  const pnlSummary = fmtSignedDollars(pnlDollars);
  const titleBody = `${sideLabel} ${trade.ticker} · ${pnlSummary} · ${exitReason.label}`;
  const title = reasonEmoji.length > 0 ? `${reasonEmoji} ${titleBody}` : titleBody;

  const timeframeLabel = resolveTimeframeLabel(trade.strategyKey, trade.deploymentId);
  const authorName = timeframeLabel != null
    ? `${strategyName} · ${timeframeLabel}`
    : strategyName;

  await sendDiscordAlert({
    title,
    author: { name: authorName },
    description,
    color: reasonColor,
    footer: { text: buildEmbedFooter(trade.deploymentId, accountLabel) },
    timestamp: exitFilledAt,
  });
}

export async function notifyForceClose(
  deps: NotifyDeps,
  trade: StrategyTrade,
  entryPrice: number,
  tpError: string,
  slError: string,
  submitted: boolean,
): Promise<void> {
  const sideLabel = trade.side === 0 ? "LONG" : "SHORT";
  const accountLabel = formatAccountLabel(
    deps.accountNames.get(trade.accountId) ?? String(trade.accountId),
  );
  const strategyName = getStrategy(trade.strategyKey)?.config.name ?? trade.strategyKey;
  const status = submitted ? "force-close submitted" : "force-close FAILED — UNPROTECTED";

  await sendDiscordAlert({
    title: `⚠️ Trade #${trade.id} ${status} (bracket failure) · ${sideLabel} ${trade.ticker} · ${accountLabel}`,
    color: COLOR_BRACKET_FAILURE,
    fields: [
      { name: "Strategy", value: strategyName, inline: true },
      { name: "Contract", value: trade.contractId, inline: true },
      { name: "Size", value: String(trade.size), inline: true },
      { name: "Entry", value: entryPrice.toFixed(2), inline: true },
      {
        name: "Intended TP",
        value: trade.desiredTpTicks != null ? `${trade.desiredTpTicks} ticks` : "—",
        inline: true,
      },
      {
        name: "Intended SL",
        value: trade.desiredSlTicks != null ? `${trade.desiredSlTicks} ticks` : "—",
        inline: true,
      },
      { name: "TP rejection", value: tpError.slice(0, EMBED_FIELD_VALUE_MAX) || "—" },
      { name: "SL rejection", value: slError.slice(0, EMBED_FIELD_VALUE_MAX) || "—" },
      { name: "Time", value: formatNyTime(new Date().toISOString()), inline: true },
    ],
  });
}

/**
 * The nightly regime line: tomorrow's label per instrument, with the two
 * features behind each one.
 *
 * **It says what was measured and claims nothing about what will trade.**
 * Nothing is gated on the label in this phase, so a line reading "MNQ is
 * quiet, standing down" would be a promise the engine does not keep — the
 * footer says so in one sentence rather than leaving the reader to infer it.
 * An `unknown` instrument is named with its reason, because a label silently
 * missing from the list is the one an operator would assume was fine.
 */
export async function notifyRegimeLabels(
  sessionDate: string,
  labels: readonly { ticker: string; result: RegimeResult }[],
): Promise<void> {
  await sendDiscordAlert({
    title: `Regime labels for ${sessionDate}`,
    color: COLOR_REGIME,
    fields: labels.map((l) => ({
      name: l.ticker,
      value: l.result.features == null
        ? `${l.result.label} — not enough completed sessions to measure`
        : `${l.result.label}\n5-day range ${l.result.features.vol5.toFixed(1)} ticks ` +
          `(${l.result.features.vol5Pct.toFixed(0)}th percentile of the last year)\n` +
          `Yesterday's range ${l.result.features.rangeRatio.toFixed(2)}× its 20-day median`,
      inline: true,
    })),
    footer: {
      text: "Observed only — no strategy is armed or stood down by the label yet.",
    },
  });
}

/**
 * Decide the exit-reason **code** for a close, and render its label through
 * the one table that owns both ([exit-reasons.ts](../../logging/exit-reasons.ts)).
 * Feeds the Discord exit embed and the persisted `exit_reason_code` /
 * `exit_reason` pair. Priority:
 *   - SL bracket fill — flag-driven: the engine writes
 *     `sl_moved_to_be_flag` at the BE-move call site and
 *     `sl_trail_engaged` at any future trail-ratchet site. Trail >
 *     BE > plain. Flags are persisted on the trade row so they survive
 *     engine restart and feed the post-close relabel sweep. A row that
 *     predates the flags is a plain stop. Offset arithmetic against
 *     `slCurrentPrice` is retained only as a drift detector — a flag-says-BE but
 *     offset-says-Trail mismatch logs a warning so we can spot drift
 *     between the cause-site flag writes and the broker's actual
 *     resting SL.
 *   - TP bracket fill — `take_profit`.
 *   - Engine-issued reasons (set by attachPendingExit during
 *     placeExitOrder) cover strategy/session/realtime/force-close paths.
 *     `strategy_signal:<reason>` carries a strategy-supplied detail
 *     (e.g. "EMA close-through") and renders as "Strategy Exit · <reason>".
 *     Registry exit-filter keys (`time_stop`, `ema_exit`) flow through when
 *     a strategy returns `anyExitFilterTriggered(ctx)` directly.
 *   - Fallback `bracket_manual` for the residual case where the broker
 *     closed the position outside our control (Topstep UI flatten,
 *     external order manager, OCO bracket fill we couldn't attribute).
 *
 * **`engineExitReason` is the reason *code* — never a rendered label.** The
 * caller reads `exit_reason_code`, which the actor wrote at submission; the
 * label column is a rendering and feeding it back in here is what used to
 * downgrade a correct chip to the residual arm.
 */
export function resolveExitReason(
  deps: NotifyDeps,
  bracketExitKind: "tp" | "sl" | "other",
  engineExitReason: string | null,
  slContext: {
    side: 0 | 1;
    entryPrice: number | null;
    slMovedToBe: boolean;
    slTrailEngaged: boolean;
    slCurrentPrice: number | null;
    tickSize: number;
    tradeId?: number;
    deploymentId?: string;
  } | null = null,
): ResolvedExitReason {
  if (bracketExitKind === "tp") return bracketExitReason("take_profit");
  if (bracketExitKind === "sl") {
    if (!slContext) return bracketExitReason("stop_loss");
    // Flag-derived code is authoritative. Trail beats BE because a
    // trail-ratchet implies the SL was already moved through BE first.
    // A row predating the flags reads as a plain stop: the columns
    // defaulted to 0, so it is indistinguishable from one, and letting
    // geometry classify it is the stale-mirror bucketing the flags replaced.
    type SlCode = "trail_stop" | "breakeven_stop" | "stop_loss";
    let flagCode: SlCode;
    if (slContext.slTrailEngaged) flagCode = "trail_stop";
    else if (slContext.slMovedToBe) flagCode = "breakeven_stop";
    else flagCode = "stop_loss";

    let offsetCode: SlCode | null = null;
    if (
      slContext.entryPrice != null &&
      slContext.slCurrentPrice != null &&
      slContext.tickSize > 0
    ) {
      const isLong = slContext.side === 0;
      const direction = isLong ? 1 : -1;
      const offsetTicks = ((slContext.slCurrentPrice - slContext.entryPrice) * direction)
        / slContext.tickSize;
      if (offsetTicks < 0) offsetCode = "stop_loss";
      else if (offsetTicks <= LEGACY_TRAIL_OFFSET_TICKS) offsetCode = "breakeven_stop";
      else offsetCode = "trail_stop";
    }

    if (offsetCode != null && offsetCode !== flagCode) {
      deps.log(
        slContext.deploymentId ?? ENGINE_SCOPE,
        "warn",
        "trade",
        `Exit-reason flag/offset drift on trade #${slContext.tradeId ?? "?"}: flags say "${exitReasonLabel(flagCode)}", offset says "${exitReasonLabel(offsetCode)}" (slMovedToBe=${slContext.slMovedToBe} slTrailEngaged=${slContext.slTrailEngaged} slCurrentPrice=${slContext.slCurrentPrice} entryPrice=${slContext.entryPrice})`,
        { tradeId: slContext.tradeId ?? null },
      );
    }
    return bracketExitReason(flagCode);
  }
  // Every remaining arm is the table's: `deployment_close` renders one label
  // for both Pause and Destroy (which of the two asked is the deployment
  // row's business, and the status chip is where that lives), and
  // `engine_downtime` stays out of that grouping because nobody asked for
  // it — which is the whole distinction an operator reading the row needs.
  return resolveSubmittedExitReason(engineExitReason);
}
