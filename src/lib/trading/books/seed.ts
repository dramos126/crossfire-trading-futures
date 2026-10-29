import {
  daySessionRefusalForStrategyKey,
  instrumentRefusalForStrategyKey,
  listStrategies,
} from "@/lib/trading/strategies";
import { DEPLOYABLE_SPEC_TICKERS } from "@/lib/trading/contracts/contract-specs";
import type { TickerSymbol } from "@/lib/trading/domain";

/**
 * The shelf: which cells a book offers, on which contracts.
 *
 * A book is picked, not seeded (2026-10-19, book types step 2): a new book
 * starts empty or as a copy of another, so nothing in the books path reads a
 * playbook's shelf label or an account's class any more — the seed that did,
 * once at creation, retired with the one-book-per-account model.
 */

/**
 * Every playbook the shelf carries for one instrument, in the order the
 * registry lists them.
 *
 * A cell exists for a playbook that could run on this ticker: registered, not
 * hidden, not a test fixture, and refused by neither the instrument nor the
 * day-session declaration — the same two sentences the deploy routes answer
 * 400 with.
 */
export function playbookShelfForTicker(ticker: TickerSymbol): string[] {
  return listStrategies()
    .filter(
      ({ key, module }) =>
        !module.isTest &&
        instrumentRefusalForStrategyKey(key, ticker) == null &&
        daySessionRefusalForStrategyKey(key, ticker) == null,
    )
    .map(({ key }) => key);
}

/**
 * Every instrument the platform trades — the contract table's deployable rows,
 * in the app's `/MNQ` spelling. A book's shelf is the union of their shelves.
 */
export const PLATFORM_TICKERS: readonly TickerSymbol[] = DEPLOYABLE_SPEC_TICKERS.map((t) => `/${t}` as const);

/** One cell of a book's shelf: a playbook on one instrument. */
export interface ShelfCell {
  ticker: TickerSymbol;
  strategyKey: string;
}

/**
 * A book's shelf: `playbookShelfForTicker` over every platform ticker, then
 * over any other ticker the book already holds a cell on — a book migrated off
 * a `/ES` book keeps its cells visible, because a cell the grid cannot draw is
 * a cell the operator cannot turn off.
 */
export function bookShelf(heldTickers: Iterable<TickerSymbol> = []): ShelfCell[] {
  const tickers = [...PLATFORM_TICKERS];
  for (const t of heldTickers) if (!tickers.includes(t)) tickers.push(t);
  return tickers.flatMap((ticker) =>
    playbookShelfForTicker(ticker).map((strategyKey) => ({ ticker, strategyKey })),
  );
}

/**
 * The playbook `PATCH`'s 400 for an arm on a cell `bookShelf` does not carry —
 * the grid draws no such cell, so a press cannot reach it; a hand-written body
 * can, and would materialise a row on a contract the platform does not trade.
 */
export function offShelfRefusal(ticker: TickerSymbol): string {
  return (
    `This book does not offer this playbook on ${ticker}, so it cannot be turned on there. ` +
    `Turn on one of the playbooks Books shows for that contract.`
  );
}
