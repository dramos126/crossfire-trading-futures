// The renderings a fill has to look identical in on two surfaces: the
// Activity lane's `entry_filled` slots and the Discord entry embed. This
// module is a leaf and must stay one — it imports nothing at runtime, so a
// satellite that wants a fill formatter does not drag `engine-notify.ts`'s
// graph (`db/deployments`, `db/deployment-groups`, `notify/discord`, the
// strategy loader's `require.context`) in behind it.

import type { LogValues } from "@/lib/logging/vocabulary";

/**
 * A price, as every entry/exit embed renders one. Shared because the
 * Activity lane's `{price}`, `{sl}` and `{tp}` slots are the same number on
 * a different surface, and two conventions for one price is how a log line
 * and the alert about it come to disagree.
 */
export function fmtPrice(v: number): string {
  return v.toFixed(2);
}

/**
 * A signed dollar amount — `+$32.25`, `−$18.00`, `$0.00` for flat, with a
 * real minus sign. Hoisted out of `notifyExit`, which is still its first
 * caller, so the Activity lane's `{pnl}` reads exactly as the exit embed's
 * headline does.
 *
 * **Not to be merged with `fmtSigned` or `fmtSignedTicks`**, which disagree
 * about zero and live in different embeds — that is a copy decision filed in
 * `punchlist.md`, and unifying them here would change what a flat trade's
 * entry embed says.
 */
export function fmtSignedDollars(v: number): string {
  if (v > 0) return `+$${v.toFixed(2)}`;
  if (v < 0) return `−$${Math.abs(v).toFixed(2)}`;
  return `$0.00`;
}

/**
 * The stop and target actually resting at the broker after a fill:
 * `fillPrice ± resolvedTicks × tickSize`, per side.
 *
 * **Anchored to the fill and never to `desiredSlPrice` / `desiredTpPrice`,**
 * which are submit-time numbers kept for slippage. Deriving the price from
 * the desired entry while quoting ticks against the actual fill is what
 * produced *"TP 27368 (16 ticks)"* against a broker order that was 60 ticks
 * away at 27357. Both the entry embed and the Activity lane's `{sl}`/`{tp}`
 * read through here so they cannot drift apart.
 *
 * `null` for either leg the trade has no tick distance or no tick size for —
 * a real state, and one the Activity lane answers by withholding its
 * sentence rather than by printing half of it.
 */
export function bracketPricesFromFill(
  trade: {
    side: 0 | 1;
    tickSize: number | null;
    desiredTpTicks: number | null;
    desiredSlTicks: number | null;
  },
  fillPrice: number,
): { tpPrice: number | null; slPrice: number | null } {
  const tickSize = trade.tickSize ?? 0;
  const isLong = trade.side === 0;
  const tpTicks = trade.desiredTpTicks;
  const slTicks = trade.desiredSlTicks;
  return {
    tpPrice:
      tpTicks != null && tickSize > 0
        ? fillPrice + (isLong ? tpTicks : -tpTicks) * tickSize
        : null,
    slPrice:
      slTicks != null && tickSize > 0
        ? fillPrice + (isLong ? -slTicks : slTicks) * tickSize
        : null,
  };
}

/**
 * The Activity lane's `entry_filled` slots, built once for the three sites
 * that observe a fill — the user-hub fast path and the reconciler's two
 * arms. One builder rather than three copies, for the reason the formatters
 * above are shared: three call sites rendering one sentence is three ways
 * for it to disagree with the embed beside it.
 *
 * **`sl` and `tp` are omitted rather than faked when the trade carries no
 * tick distances.** A missing slot is what makes the lane fall back to the
 * call site's own prose, which is the honest answer; a `—` in the slot would
 * be a sentence claiming a stop was placed at nothing.
 *
 * **`filledSize` is what the broker filled, not what the row submitted.**
 * `{size}` is the quantity the sentence says changed hands — *"Bought 2
 * MNQ"* against a 1-lot partial fill is a false claim — and all three
 * sites hold the broker's number. The two that observe a live position
 * were already writing it onto `state.position.size` beside this call;
 * `handleEntryClosedNoPosition` has no position to read but sums the entry
 * fills to weight the price it reports, so the total is in hand there too.
 * **The default is for a caller with neither a position nor fills, and no
 * live caller is one** — it is a fallback, not the answer for the
 * already-closed path, which is what it was taken for until 2026-08-27.
 */
export function entryFillValues(
  trade: {
    side: 0 | 1;
    size: number;
    tickSize: number | null;
    desiredTpTicks: number | null;
    desiredSlTicks: number | null;
  },
  fillPrice: number,
  filledSize: number = trade.size,
): LogValues {
  const { tpPrice, slPrice } = bracketPricesFromFill(trade, fillPrice);
  return {
    side: trade.side === 0 ? "Bought" : "Sold",
    size: filledSize,
    price: fmtPrice(fillPrice),
    ...(slPrice != null ? { sl: fmtPrice(slPrice) } : {}),
    ...(tpPrice != null ? { tp: fmtPrice(tpPrice) } : {}),
  };
}
