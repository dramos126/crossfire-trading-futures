import type { Contract as TopstepContract } from "@/lib/brokers/types";
import type { TradovateActiveContract } from "@/lib/brokers/tradovate/types";

/**
 * Cross-broker contract-pair assertion.
 *
 * Lives in `src/lib/trading/` (not in either broker module) because it's
 * the bridge between the two — neither side should own it. Phase 4 will
 * call this from the engine's pre-place path whenever a deployment uses
 * Topstep for market data and Tradovate for execution; in Phase 2B it's
 * just a callable utility, not yet wired.
 *
 * Why it exists: see the proposal §"Symbology mismatch on the data/exec
 * split" — if Topstep streams bars for `MNQM26` and the strategy fires,
 * the order MUST go to Tradovate's `MNQM26`, not its `MNQH26`. If one
 * broker has rolled to the next month and the other hasn't, indicators
 * built on month N would place orders on month N+1.
 */

const MONTH_CODES = "FGHJKMNQUVXZ";

interface ParsedContractKey {
  /** Physical contract root extracted from the name (e.g. `MNQ`, `ES`). */
  root: string;
  /** Single-letter futures month code (F=Jan, G=Feb, ... Z=Dec). */
  monthCode: string;
  /** Four-digit year (2-digit names like `MNQM6` are decade-anchored
   *  to the current decade). */
  year: number;
}

/**
 * Parse a futures contract name into `(root, monthCode, year)`. Accepts
 * 1- or 2-digit year suffixes (`MNQM6` and `MNQM26`) plus 4-digit
 * suffixes (`MESU2025`, the Tradovate format). Returns null if the
 * suffix doesn't match a futures-style month/year tail — caller must
 * treat that as a parse failure.
 *
 * **The 1-digit arm anchors to the current decade and will be wrong across
 * the boundary**: in Dec 2029 an `MNQH0` naming March 2030 reads as 2020 and
 * refuses against `H30`. It degrades safe — a refusal, so no mark and no
 * order rather than the wrong one — and it is three years out, but a refusal
 * now costs a visible number on the operator's screen.
 */
function parseContractName(name: string): ParsedContractKey | null {
  const upper = String(name ?? "").trim().toUpperCase();
  if (!upper) return null;
  // Try 4-digit year first (e.g. MESU2025), then 2-digit (MNQM26),
  // then 1-digit (MNQM6). Anchored to end-of-string so leading root
  // characters fall out as the prefix.
  let m = upper.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{4})$/);
  if (m) {
    const [, root, monthCode, yearStr] = m;
    return { root, monthCode, year: parseInt(yearStr, 10) };
  }
  m = upper.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{2})$/);
  if (m) {
    const [, root, monthCode, yearStr] = m;
    return { root, monthCode, year: 2000 + parseInt(yearStr, 10) };
  }
  m = upper.match(/^([A-Z0-9]+?)([FGHJKMNQUVXZ])(\d{1})$/);
  if (m) {
    const [, root, monthCode, yearStr] = m;
    const decade = Math.floor(new Date().getFullYear() / 10) * 10;
    return { root, monthCode, year: decade + parseInt(yearStr, 10) };
  }
  return null;
}

/**
 * The product root behind a broker contract *identifier*, or `null` when the
 * identifier cannot be read as a futures contract.
 *
 * D-2 of docs/proposals/position-lifecycle.md settled "instrument" as the
 * product root rather than the contract: an MGC deployment claims an MGC hand
 * position **in any month**, because different months of one product are the
 * same economic exposure and prop-firm drawdown aggregates per account. This
 * is the equality that rule is expressed as.
 *
 * Two identifier shapes reach it and one parser serves both. Topstep's is
 * dotted — `CON.F.US.MGC.Z26` — so the last two segments are joined back into
 * the plain futures symbol `parseContractName` already reads; Tradovate's is
 * that symbol already (`MESU2025`).
 *
 * **`null` is "cannot tell", and callers must never read it as "no match".**
 * `assertContractsPair` throws on a parse failure because it is about to
 * place an order; a caller asking "is this the same product" is not, and
 * force-closing a position it cannot identify is worse than leaving one it
 * could have. Tradovate's position translator falls back to the stringified
 * numeric contract id when its symbol lookup has not warmed, so this arrives
 * in normal operation and is not a corrupt-data signal.
 *
 * **Roots are per broker namespace, so only compare two that came from the
 * same broker.** `TICKER_CONTRACT_MAP` maps `/GC` to the Topstep root `GCE`
 * and `/MCL` to `MCLE`, where Tradovate names the same products `GC` and
 * `MCL`. Comparing across brokers reads two live products as different ones.
 */
export function productRootFromContractId(contractId: string): string | null {
  return parseContractId(contractId)?.root ?? null;
}

/** Shared by both identifier readers: Topstep's dotted form is joined back
 *  into the plain futures symbol `parseContractName` reads, Tradovate's is
 *  that symbol already. */
function parseContractId(contractId: string): ParsedContractKey | null {
  const raw = String(contractId ?? "").trim();
  if (!raw) return null;
  const segments = raw.split(".");
  const symbol = segments.length > 1 ? segments.slice(-2).join("") : raw;
  return parseContractName(symbol);
}

/**
 * True when two contract *identifiers* name the same expiry — same month
 * code, same year. Reads both shapes, like `productRootFromContractId`.
 *
 * **Month and year only, never the root**, and that is the whole point of
 * having it separate from `assertContractsPair`: the roots are in different
 * broker namespaces (`CON.F.US.GCE.Z26` against Tradovate's `GCZ6`), so
 * comparing them reads one product as two. The caller is responsible for
 * having established that the two identifiers are the same product — via
 * `TICKER_CONTRACT_MAP`, which is the one table that owns that
 * correspondence.
 *
 * **False is "cannot tell" as well as "different"**, so a caller must treat
 * it as a refusal rather than a mismatch. Neither side parsing (a numeric
 * Tradovate id whose symbol cache has not warmed) lands here.
 */
export function sameContractMonth(a: string, b: string): boolean {
  const left = parseContractId(a);
  const right = parseContractId(b);
  if (!left || !right) return false;
  return left.monthCode === right.monthCode && left.year === right.year;
}

/**
 * The expiry a contract *identifier* names, rendered as `U2026` — the same
 * reading `sameContractMonth` compares, exposed so a caller can name the month
 * it anchored on in an error or a cache key. `null` when the identifier cannot
 * be read, which every caller must treat as a refusal rather than a default.
 *
 * One parser, two renderings, exactly like `tickerForContractId` beside
 * `tickerSymbolForContractId`. Do not add a second reader of a month code.
 */
export function contractMonthKey(contractId: string): string | null {
  const parsed = parseContractId(contractId);
  return parsed ? `${parsed.monthCode}${parsed.year}` : null;
}

function formatExpiry(iso: string | null): string {
  return iso ?? "(no expiry)";
}

function describeTopstep(contract: TopstepContract): string {
  return `${contract.name} (${contract.id})`;
}

function describeTradovate(contract: TradovateActiveContract): string {
  return `${contract.symbol} (id ${contract.contractId}, expires ${formatExpiry(contract.maturityIso)})`;
}

/**
 * Throw a deployment-actionable error if the Topstep market-data contract
 * and the Tradovate execution contract don't reference the same physical
 * root + same expiry month. Returns void on success.
 *
 * Both sides are named explicitly in the error message so the operator
 * can see at a glance which broker has rolled and which hasn't.
 *
 * Note on month codes: this is a STRICT month equality check. Two
 * contracts that share root + year but differ in month code (e.g. `H`
 * vs `M`) are a mismatch even if they're "close enough" — there is no
 * valid scenario where execution and market data should be on different
 * physical contracts.
 */
export function assertContractsPair(
  topstep: TopstepContract,
  tradovate: TradovateActiveContract,
): void {
  const tsKey = parseContractName(topstep.name);
  const tvKey = parseContractName(tradovate.symbol);

  if (!tsKey) {
    throw new Error(
      `Cannot parse Topstep contract name "${topstep.name}" — expected futures` +
        ` month/year suffix (e.g. MNQM26 or MESU2025). Pairing aborted to avoid` +
        ` placing orders on the wrong contract.`,
    );
  }
  if (!tvKey) {
    throw new Error(
      `Cannot parse Tradovate contract name "${tradovate.symbol}" — expected` +
        ` futures month/year suffix. Pairing aborted to avoid placing orders` +
        ` on the wrong contract.`,
    );
  }

  if (tsKey.root !== tvKey.root) {
    throw new Error(
      `Contract root mismatch: Topstep ${describeTopstep(topstep)} root "${tsKey.root}"` +
        ` does not pair with Tradovate ${describeTradovate(tradovate)} root "${tvKey.root}".` +
        ` This usually means the deployment's Topstep ticker maps to a different` +
        ` physical product than the Tradovate resolver picked — check TICKER_CONTRACT_MAP.`,
    );
  }

  if (tsKey.monthCode !== tvKey.monthCode || tsKey.year !== tvKey.year) {
    throw new Error(
      `Contract expiry mismatch: Topstep ${describeTopstep(topstep)}` +
        ` (month ${tsKey.monthCode}${tsKey.year}) does not pair with Tradovate` +
        ` ${describeTradovate(tradovate)} (month ${tvKey.monthCode}${tvKey.year}) —` +
        ` one broker has rolled, the other has not. Refusing to place an order` +
        ` against an indicator built on the other contract.`,
    );
  }
}
