import {
  autoTradeVerdictsForAccountIds,
  listAccountDeployRecords,
} from "@/lib/db/account-brokers";
import { listBooks, listDerivedRows } from "@/lib/db/books";
import { listDeployments } from "@/lib/db/deployments";
import type { AutoTradeVerdict } from "@/lib/trading/broker-access/account-trading-policy";
import {
  accountStateVerdict,
  replacementCandidates,
  type AccountDeployState,
  type AccountStateRefusalKind,
  type ReplacementPoolEntry,
} from "@/lib/trading/broker-access/account-state-gate";

/**
 * Each catalogued account's account-state gate, as the deploy picker and the
 * book grid render it — computed here, on the server, so neither surface
 * derives a refusal. `GET /api/books` carries it; `POST
 * /api/deployments/move-account` re-asks it before writing.
 *
 * The live-account verdict is **not** folded in: both surfaces already render
 * it on its own stamp, and the replacement match reads it as one of its
 * conditions rather than as a sentence.
 */
export interface AccountGateWire {
  accountId: number;
  name: string | null;
  /** The account-state refusal, or null when that gate permits. */
  refusal: { kind: AccountStateRefusalKind; stamp: string; reason: string } | null;
  /** Said beside a deploy, blocking nothing — Topstep's auto bracket is on. */
  warning: string | null;
  /**
   * Set only on a **dead** account that a book or a live deployment uses: the
   * `ok`, same-program, unused accounts it may move to. Empty otherwise.
   */
  replacements: Array<{ accountId: number; name: string | null }>;
}

export interface AccountGateRecord {
  accountId: number;
  name: string | null;
  state: AccountDeployState;
  templateId: number | null;
  startingBalanceUsd: number | null;
}

export function buildAccountGates(input: {
  records: readonly AccountGateRecord[];
  /** `autoTradeVerdictsForAccountIds` over the records' ids. A missing entry
   *  reads as refused, the block's own answer for an unknown account. */
  autoTrade: ReadonlyMap<number, AutoTradeVerdict>;
  /** Account ids a book or a live (not deleted) deployment leg uses. */
  inUse: ReadonlySet<number>;
  now: Date;
}): AccountGateWire[] {
  const judged = input.records.map((r) => ({ r, v: accountStateVerdict(r.state, input.now) }));
  const pool: ReplacementPoolEntry[] = judged.map(({ r, v }) => ({
    accountId: r.accountId,
    name: r.name,
    status: r.state.status,
    templateId: r.templateId,
    startingBalanceUsd: r.startingBalanceUsd,
    deployable: input.autoTrade.get(r.accountId)?.permitted === true && v.permitted,
  }));
  return judged.map(({ r, v }) => {
    if (v.permitted) {
      return { accountId: r.accountId, name: r.name, refusal: null, warning: v.warning, replacements: [] };
    }
    return {
      accountId: r.accountId,
      name: r.name,
      refusal: { kind: v.kind, stamp: v.stamp, reason: v.reason },
      warning: null,
      replacements:
        v.kind === "dead" && input.inUse.has(r.accountId)
          ? replacementCandidates(r, pool, input.inUse)
          : [],
    };
  });
}

/**
 * "In use" is a live book on the account or any leg not soft-deleted — a
 * paused leg still names the account it would trade on, so its account is not
 * free to be someone's replacement. **A removed book's rows are not use**: the
 * account is free once its book is removed, and its paused rows stay only to
 * hold their trade history.
 */
export function accountsInUse(input: {
  books: ReadonlyArray<{ id: string; accountId: number; retiredAt: number | null }>;
  derived: ReadonlyArray<{ groupId: string; bookId: string }>;
  legs: ReadonlyArray<{ accountId: number; groupId: string }>;
}): Set<number> {
  const retired = new Set(input.books.filter((b) => b.retiredAt != null).map((b) => b.id));
  const retiredGroups = new Set(
    input.derived.filter((r) => retired.has(r.bookId)).map((r) => r.groupId),
  );
  return new Set<number>([
    ...input.books.filter((b) => b.retiredAt == null).map((b) => b.accountId),
    ...input.legs.filter((d) => !retiredGroups.has(d.groupId)).map((d) => d.accountId),
  ]);
}

/** The gates over the whole catalogue, read now. */
export function readAccountGates(now: Date = new Date()): AccountGateWire[] {
  const records = listAccountDeployRecords();
  const inUse = accountsInUse({
    books: listBooks(),
    derived: listDerivedRows(),
    legs: listDeployments(),
  });
  return buildAccountGates({
    records,
    autoTrade: autoTradeVerdictsForAccountIds(records.map((r) => r.accountId)),
    inUse,
    now,
  });
}
