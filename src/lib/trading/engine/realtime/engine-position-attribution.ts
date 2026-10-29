// D-6's attribution rule from docs/proposals/position-lifecycle.md:
// `manual = actualSigned − expectedSigned`. Pure and separately exported so
// a test drives the shipped rule without an engine — the same shape, and for
// the same reason, as `bracketRecoveryEligibility` in engine-exit.ts.
//
// **P2 is read-only. Nothing here or downstream of it may place, cancel or
// flatten.** Acting on this is P4, and the gate is the `shortfall` arm
// below: the arithmetic has to be watched against real netting first.

import { POSITION_TYPE_LABELS, positionTypeFromSigned } from "@/lib/brokers/types";

export type PositionAttributionKind = "aligned" | "excess" | "shortfall";

export interface PositionAttribution {
  expectedSigned: number;
  actualSigned: number;
  /** `actualSigned − expectedSigned`. **Its sign does not classify** — a
   *  negative value is row two (excess, opposite direction) or row four
   *  (shortfall) depending on where `actualSigned` sits. Read `kind`. */
  manualSigned: number;
  kind: PositionAttributionKind;
}

/**
 * Attribute the difference between what the engine believes it holds and
 * what the broker reports, per D-6's four-row table.
 *
 * | expected | actual | manual | kind |
 * |---|---|---|---|
 * | `+1` | `+2` | `+1` | `excess` — operator bought alongside |
 * | `+1` | `−1` | `−2` | `excess` — operator sold through the position |
 * | `0` | `+3` | `+3` | `excess` — wholly manual |
 * | `+2` | `+1` | `−1` | `shortfall` — **not manual** |
 *
 * **What classifies is where `actualSigned` sits relative to `0` and
 * `expectedSigned`, never the sign of `manualSigned`.** Rows two and four
 * both produce a negative `manual` and want opposite responses. The
 * discriminator is that an unfilled remainder can only leave `actual`
 * *between* zero and `expected` — a partial fill cannot overshoot the
 * order, and it cannot cross the position through flat into the other
 * side. So anything that crosses zero, or that exceeds `expected` in
 * `expected`'s own direction, is unambiguously excess; anything short of
 * `expected` without crossing zero is not attributable from arithmetic
 * alone.
 *
 * **`shortfall` therefore means "unattributable", not "the operator
 * reduced".** `−1` against an expected `+2` is either the operator selling
 * one or the engine's own entry filling one of two, and the numbers are
 * identical. The tiebreaker is the fills and their `customTag`s (`e_` /
 * `x_` / `s_`, stamped by `buildCustomTag`), which is why D-6 calls the
 * reference chain required rather than redundant. Never treat a shortfall
 * as something to flatten.
 *
 * Both arguments are signed contract counts — integers on both brokers, so
 * the subtraction is exact and this is not price math. Take them from
 * `signedSize` (a broker `Position`) or `signedSizeForEntrySide` (a trade
 * row's `OrderSide`); never re-derive either, and never cast between
 * `OrderSide` and `PositionType`, which collide at `1`.
 *
 * Named fields rather than positional arguments: swapping the two negates
 * `manualSigned` and inverts every classification, and nothing about
 * `attributePosition(a, b)` would show it.
 */
export function attributePosition(input: {
  expectedSigned: number;
  actualSigned: number;
}): PositionAttribution {
  const { expectedSigned, actualSigned } = input;
  return {
    expectedSigned,
    actualSigned,
    manualSigned: actualSigned - expectedSigned,
    kind: classifyAttribution(expectedSigned, actualSigned),
  };
}

function classifyAttribution(expected: number, actual: number): PositionAttributionKind {
  if (actual === expected) return "aligned";
  // No engine position to be short of, so every contract is the operator's.
  if (expected === 0) return "excess";
  // Broker flat against a live engine position: the engine's own exit
  // filling and an operator flatten are the same number.
  if (actual === 0) return "shortfall";
  if (actual > 0 !== expected > 0) return "excess";
  return Math.abs(actual) > Math.abs(expected) ? "excess" : "shortfall";
}

/**
 * The log sentence for an attribution. Lives here so the copy is covered by
 * the same test as the arithmetic it describes — the whole point of P2 is
 * that an operator reads these lines and decides whether the rule is right
 * before P4 acts on it.
 */
export function describePositionAttribution(a: PositionAttribution): string {
  const head = `engine expects ${renderSigned(a.expectedSigned)}, broker reports ${renderSigned(a.actualSigned)}`;
  if (a.kind === "aligned") return `${head} — aligned`;

  const manual = `manual ${withSign(a.manualSigned)}`;
  if (a.kind === "shortfall") {
    return `${head} — ${manual} (shortfall: a partial entry fill and an operator reduction are arithmetically identical here, so this is not attributable without the fills' customTags)`;
  }
  if (a.expectedSigned === 0) return `${head} — ${manual} (excess, wholly manual)`;
  if (a.actualSigned > 0 !== a.expectedSigned > 0) {
    return `${head} — ${manual} (excess, opposite direction: the engine's protective stop is now on the wrong side of the position)`;
  }
  return `${head} — ${manual} (excess)`;
}

function renderSigned(n: number): string {
  const type = positionTypeFromSigned(n);
  return type === null ? "flat" : `${POSITION_TYPE_LABELS[type]} ${Math.abs(n)}`;
}

function withSign(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}
