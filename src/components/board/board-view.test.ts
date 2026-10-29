/**
 * The board's four decisions.
 *
 * Every one of them is a thing that compiles, renders and lies if it is
 * written the obvious way, so each test states the obvious way and asserts
 * against it: the selector's empty breakdown passed straight through, an
 * `[]` rendered as "nothing is deployed", a ▶ drawn from `switchOn` alone,
 * and a `$0.00` where there is no reading.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { MASKED_USD } from "@/components/privacy/privacy-model";
import {
  describeHiddenPlaybooks,
  HIDDEN_PLAYBOOKS_DETAIL,
  toBoardBooks,
  BOARD_LIST_STALE_WARNING,
  BOARD_STALE_WARNING,
  BOARD_UNAVAILABLE_WARNING,
  boardRegime,
  boardRisk,
  boardSessionPnl,
  boardVisibility,
  describeHiddenBooks,
  HIDDEN_BOOKS_DETAIL,
  HIDDEN_BOOKS_LINK_LABEL,
  cardToggleIntent,
  RISK_IS_THE_ACCOUNTS,
  RISK_NOT_SET_DETAIL,
  RISK_UNREADABLE_DETACHED,
  RISK_UNREADABLE_READ_FAILED,
  DETACHED_MONEY_UNAVAILABLE,
  cardEditIntent,
  describeMissingLegMoney,
  describeMissingMoney,
  describeOrphanReason,
  DETACHED_RECOVER_LABEL,
  DETACHED_RECOVER_NOTE,
  DETACHED_RESUME_REFUSAL,
  detachedRestoreRefusal,
  formatUsd,
  collectUnmanagedProbes,
  engineSyncIntent,
  legPulse,
  legToggleIntent,
  maskRiskBalance,
  mergeUnmanagedClaims,
  minutesUntilNy,
  nowNyMinutes,
  pnlToneClass,
  PRACTICE_FILTER_MONEY_UNAVAILABLE,
  preferUnmanagedClaim,
  presentBoard,
  toForceFlatResult,
  unmanagedBackoffMs,
  UNMANAGED_PROBE_MAX_BACKOFF_MS,
  BALANCE_NEVER_READ,
  BALANCE_NOT_CARRIED,
  BALANCE_NOT_CATALOGUED,
  BALANCE_NOT_READ,
  BALANCE_READ_FAILED,
  BALANCE_SOURCE_NOTE,
  boardAccountStatus,
  toAccountStatusRows,
} from "./board-view";
import type { AccountStatusWire } from "@/app/api/accounts/status/route";
import {
  RISK_NOT_SET_STAMP,
  type AccountRiskWireRow,
} from "@/components/account/account-risk-view";
import { BOOK_CARD_EDIT_REASON, BROKEN_ROW_EDIT_REASON } from "./board-model";
import type { BoardDeployment, BoardInput, BoardLeg } from "./board-model";
import {
  ACCOUNT_RISK_PHASE_LABELS_COMPACT,
  NON_TOPSTEP_PHASE_REFUSAL,
  type AccountRiskPhase,
} from "@/lib/trading/orders/account-phase-sizer";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import type { ManualPositionPreview } from "@/lib/trading/activation-prompts";
import type { PnLBreakdown } from "@/lib/hooks/use-live-pnl";
import {
  BOOK_DERIVED_ROW_REFUSAL,
  RESTORE_NEEDS_PLAYBOOK_ON,
  RESTORE_WOULD_RETRACT_A_CLOSE,
  RESUME_WOULD_RETRACT_A_CLOSE,
} from "@/lib/trading/domain";
import type { Deployment, DeploymentStatus } from "@/lib/trading/domain";

/** What `useLivePnL(...).deployment` hands back for a row it cannot see. It
 *  is not a special value — it is the same object a genuinely flat, visible,
 *  no-trades-today deployment gets, which is the whole problem. */
function emptyBreakdown(): PnLBreakdown {
  return {
    realized: 0,
    unrealized: 0,
    fees: 0,
    total: 0,
    closedCount: 0,
    hasOpenPosition: false,
  };
}

function reading(overrides: Partial<PnLBreakdown> = {}): PnLBreakdown {
  return { ...emptyBreakdown(), ...overrides };
}

describe("boardSessionPnl — the em-dash guarantee", () => {
  const VISIBLE = 5001;
  const HIDDEN = 9001;

  /** A stand-in for the real selector: it answers for the visible account and
   *  hands back an *empty breakdown* for everything else, which is exactly
   *  what `buildSelectors`' `deployment()` does when `deploymentsById` — built
   *  from the visible-account filter — has no entry. */
  function selector(id: string): PnLBreakdown {
    return id === "visible-dep" ? reading({ realized: 120, total: 120 }) : emptyBreakdown();
  }

  const rows = [
    { id: "visible-dep", accountId: VISIBLE },
    { id: "hidden-dep", accountId: HIDDEN },
  ];

  it("answers null for a deployment whose account is outside the visible set", () => {
    // The defect this exists to prevent: the selector's answer for
    // `hidden-dep` is structurally identical to a flat zero, so a wrapper
    // that just forwards it renders `$0.00` and `0 open` on an account that
    // may be holding contracts.
    const sessionPnl = boardSessionPnl({
      deployments: rows,
      visibleAccountIds: new Set([VISIBLE]),
      deployment: selector,
    });

    expect(sessionPnl("hidden-dep")).toBeNull();
    expect(selector("hidden-dep")).toEqual(emptyBreakdown());
  });

  it("is the only thing that can be wired in — the brand, not the docstring", () => {
    // The whole guarantee used to be one untyped wiring line. `selector`
    // below has the exact shape of `useLivePnL(...).deployment`, and
    // `(id) => PnLBreakdown` is assignable to `(id) => PnLBreakdown | null`,
    // so `sessionPnl: livePnl.deployment` compiled, type-checked, passed
    // every test in this file, and reported every detached and
    // practice-filtered account as flat. `tsc` fails this line if the brand
    // is ever removed, which is the point of asserting it here.
    // @ts-expect-error the raw selector is not a `BoardSessionPnl`
    const wired: BoardInput["sessionPnl"] = selector;
    expect(wired).toBeTypeOf("function");

    // And the wrapper's own output is.
    const built: BoardInput["sessionPnl"] = boardSessionPnl({
      deployments: rows,
      visibleAccountIds: new Set([VISIBLE]),
      deployment: selector,
    });
    expect(built("hidden-dep")).toBeNull();
  });

  it("passes a visible deployment's reading through untouched", () => {
    const sessionPnl = boardSessionPnl({
      deployments: rows,
      visibleAccountIds: new Set([VISIBLE]),
      deployment: selector,
    });

    expect(sessionPnl("visible-dep")).toEqual(reading({ realized: 120, total: 120 }));
  });

  it("answers null for a genuinely flat visible row only when it is hidden, never because it is flat", () => {
    // The other half of the same guarantee: `null` must mean *no reading*,
    // not *no money*. A visible deployment with nothing to show is a zero.
    const sessionPnl = boardSessionPnl({
      deployments: [{ id: "quiet", accountId: VISIBLE }],
      visibleAccountIds: new Set([VISIBLE]),
      deployment: () => emptyBreakdown(),
    });

    expect(sessionPnl("quiet")).toEqual(emptyBreakdown());
  });

  it("answers null for an id the deployment list does not name, without asking the selector", () => {
    // A row deleted out from under a render. Asking would answer zero.
    const deployment = vi.fn(selector);
    const sessionPnl = boardSessionPnl({
      deployments: rows,
      visibleAccountIds: new Set([VISIBLE]),
      deployment,
    });

    expect(sessionPnl("gone")).toBeNull();
    expect(deployment).not.toHaveBeenCalled();
  });

  it("blinds every row when practice-only hides the whole catalogue", () => {
    // Practice-only on with no PRAC accounts: `visibleAccounts` is empty, so
    // the selector answers zero for everything and the board must show
    // em-dashes rather than a page of flat zeros.
    const sessionPnl = boardSessionPnl({
      deployments: rows,
      visibleAccountIds: new Set<number>(),
      deployment: selector,
    });

    expect(rows.map((r) => sessionPnl(r.id))).toEqual([null, null]);
  });
});

describe("boardRegime — a reading, never an arming state", () => {
  const ACTIVE = {
    ticker: "MNQ",
    label: "active.compressed",
    features: { vol5: 412.4, vol5Pct: 78, rthRange: 380, rangeRatio: 0.82 },
  };

  it("matches a card's /MNQ against the contract table's MNQ", () => {
    // The board names an instrument `/MNQ` and `regime_days` names it `MNQ`.
    // Without the strip every card in the install renders no chip, silently.
    expect(boardRegime([ACTIVE])("/MNQ")?.label).toBe("active.compressed");
    expect(boardRegime([ACTIVE])("MNQ")?.label).toBe("active.compressed");
  });

  it("answers null for a ticker this session has no reading for", () => {
    expect(boardRegime([ACTIVE])("/MES")).toBeNull();
    expect(boardRegime([])("/MNQ")).toBeNull();
  });

  it("says the label arms nothing, in the tooltip, on every reading", () => {
    const known = boardRegime([ACTIVE])("/MNQ");
    expect(known?.detail).toContain("no strategy is armed or stood down");
    expect(known?.detail).toContain("78th percentile");
    expect(known?.detail).toContain("0.82×");

    const unknown = boardRegime([{ ticker: "MNQ", label: "unknown", features: null }])("/MNQ");
    expect(unknown?.label).toBe("unknown");
    expect(unknown?.detail).toContain("not enough completed history");
    expect(unknown?.detail).toContain("no strategy is armed or stood down");
  });
});

/**
 * *What one entry on an account may lose, and the four ways there is no
 * number to state.*
 *
 * Nothing here restates the sizer. The budgets are `resolveSessionBudget`'s,
 * pinned to the cent in its own suite, and the refusals are its constants —
 * what these assert is the part that is this surface's: which ending a row is
 * in, which glyph a blank gets, and that a rule is carried through in the
 * engine's own words rather than reworded on the board.
 */
describe("boardAccountStatus — the balance is a stored read with its time, and the stamp is the gate's", () => {
  /** 2026-10-21 18:30 ET. */
  const NOW = new Date("2026-10-21T22:30:00.000Z");
  const row = (over: Partial<AccountStatusWire> = {}): AccountStatusWire => ({
    accountId: 7,
    broker: "topstep",
    balanceUsd: 50_123.5,
    balanceAt: "2026-10-21T21:55:01.000Z",
    checkedAt: "2026-10-21T21:55:03.000Z",
    refusal: null,
    ...over,
  });
  const read = (rows: AccountStatusWire[] | null, failed = false) =>
    boardAccountStatus({ rows, failed, now: NOW })(7);

  it("states the balance unsigned, as of its New York time, with where it came from", () => {
    expect(read([row()])).toEqual({
      balance: {
        kind: "amount",
        amount: "$50,123.50",
        detail: `Balance as of 17:55 ET\n\n${BALANCE_SOURCE_NOTE}`,
      },
      stamp: null,
    });
  });

  it("names the day of a balance read on an earlier New York day", () => {
    const out = read([row({ balanceAt: "2026-10-19T21:55:01.000Z" })]);
    expect(out.balance.kind === "amount" && out.balance.detail).toContain("Balance as of Oct 19, 17:55 ET");
  });

  it("is `…` while the first read is out and `—` with its reason once it settled with nothing", () => {
    expect(read(null)).toEqual({ balance: { kind: "pending" }, stamp: null });
    expect(read(null, true)).toEqual({ balance: { kind: "unknown", detail: BALANCE_READ_FAILED }, stamp: null });
  });

  it("never states a balance nobody read — each unknown says why", () => {
    expect(read([row({ balanceUsd: null, balanceAt: null })]).balance).toEqual({
      kind: "unknown",
      detail: BALANCE_NEVER_READ,
    });
    expect(read([row({ broker: "tradovate", balanceUsd: null, balanceAt: null })]).balance).toEqual({
      kind: "unknown",
      detail: BALANCE_NOT_CARRIED,
    });
    expect(read([row({ accountId: 8 })]).balance).toEqual({ kind: "unknown", detail: BALANCE_NOT_CATALOGUED });
    // A broker value neither broker writes promises no Topstep read.
    expect(read([row({ broker: "unknown", balanceUsd: null, balanceAt: null })]).balance).toEqual({
      kind: "unknown",
      detail: BALANCE_NOT_READ,
    });
  });

  it("carries the gate's stamp and reason verbatim, with when the check ran", () => {
    const refusal = { kind: "locked" as const, stamp: "Locked", reason: "Locked by Topstep until 09:30 ET." };
    expect(read([row({ refusal })]).stamp).toEqual({
      text: "Locked",
      detail: "Locked by Topstep until 09:30 ET.\n\nAs of the account check at 17:55 ET.",
    });
  });

  it("narrows the route's body, dropping a row of the wrong shape", () => {
    expect(toAccountStatusRows({ accounts: [row(), { accountId: "7" }, row({ balanceUsd: Number.NaN })] })).toEqual([
      row(),
    ]);
    expect(toAccountStatusRows({ error: "x" })).toBeNull();
    expect(toAccountStatusRows(null)).toBeNull();
  });
});

describe("boardRisk — the budget is the account's, and the blanks are two different facts", () => {
  const NOW = new Date("2026-09-11T14:00:00.000Z");

  function row(overrides: Partial<AccountRiskWireRow> = {}): AccountRiskWireRow {
    return {
      accountId: 5001,
      broker: "topstep",
      posture: { maxRiskPerTradeUsd: 500, maxContracts: 3 },
      riskPhase: { phase: "off", mllUsd: null, startBalanceUsd: null, payoutTakenAt: null },
      eodSample: { balanceUsd: null, peakUsd: null, sizesSessionStart: null, recordedAt: null },
      ...overrides,
    };
  }

  /** Peak 51,000 → floor 49,000; close 50,750 → headroom 1,750 → the top
   *  bucket, stamped for the session `NOW` falls in. */
  function combine(overrides: Partial<AccountRiskWireRow> = {}): AccountRiskWireRow {
    return row({
      riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
      eodSample: {
        balanceUsd: 50750,
        peakUsd: 51000,
        sizesSessionStart: currentCmeSessionStart(NOW),
        recordedAt: NOW.toISOString(),
      },
      ...overrides,
    });
  }

  it("renders `…` while the first read is out and `—` once it has settled with nothing", () => {
    // The distinction is the whole point of the `failed` flag. A surface that
    // infers "no rows yet" from the absence of rows can never stop loading,
    // which spends the glyph that says a number is unavailable.
    expect(boardRisk({ rows: null, failed: false, now: NOW })(5001)).toEqual({ kind: "pending" });
    const settled = boardRisk({ rows: null, failed: true, now: NOW })(5001);
    expect(settled.kind).toBe("unreadable");
    expect(settled.kind === "unreadable" && settled.detail).toBe(RISK_UNREADABLE_READ_FAILED);
  });

  it("gives an account the catalogue does not name the recoverable sentence, not a zero", () => {
    const answer = boardRisk({ rows: [row()], failed: false, now: NOW })(9999);
    expect(answer.kind).toBe("unreadable");
    expect(answer.kind === "unreadable" && answer.detail).toBe(RISK_UNREADABLE_DETACHED);
  });

  it("says `not set` rather than $0 when no posture is stored", () => {
    // A budget nobody set is not a budget of zero: the engine takes no entry
    // at all, which is a state to fix rather than a number to read.
    const answer = boardRisk({ rows: [row({ posture: null })], failed: false, now: NOW })(5001);
    expect(answer).toEqual({
      kind: "blocked",
      note: RISK_NOT_SET_STAMP,
      tone: "warning",
      detail: RISK_NOT_SET_DETAIL,
    });
  });

  it("states the typed number with no phase word when no phase is set", () => {
    const answer = boardRisk({ rows: [row()], failed: false, now: NOW })(5001);
    expect(answer.kind).toBe("budget");
    if (answer.kind !== "budget") return;
    expect(answer.amount).toBe("$500");
    // `Off` beside a live budget reads as the budget being off.
    expect(answer.note).toBeNull();
    expect(answer.tone).toBe("muted");
    expect(answer.detail).toContain(RISK_IS_THE_ACCOUNTS);
  });

  it("names the phase beside a budget the phase sized", () => {
    const answer = boardRisk({ rows: [combine()], failed: false, now: NOW })(5001);
    expect(answer.kind).toBe("budget");
    if (answer.kind !== "budget") return;
    expect(answer.amount).toBe("$500");
    expect(answer.note).toBe(ACCOUNT_RISK_PHASE_LABELS_COMPACT.combine);
    expect(answer.detail).toContain("headroom $1,750");
    expect(answer.detail).toContain("$49,000 floor");
  });

  it("masks the headroom and floor with balances hidden — the balance by addition — and keeps the budget", () => {
    const answer = boardRisk({ rows: [combine()], failed: false, now: NOW })(5001);
    const masked = maskRiskBalance(answer, true);
    expect(masked.kind === "budget" && masked.amount).toBe("$500");
    expect(masked.kind === "budget" && masked.detail).toContain(`headroom ${MASKED_USD} over a ${MASKED_USD} floor`);
    expect(masked.kind === "budget" && masked.detail).toMatch(/^\$500 today/);
    expect(masked.kind === "budget" && masked.detail).not.toContain("$1,750");
    expect(maskRiskBalance(answer, false)).toBe(answer);
  });

  it("masks every figure in a refused cell's sentence — the close against the floor is the balance", () => {
    const atFloor = combine({
      eodSample: {
        balanceUsd: 48500,
        peakUsd: 51000,
        sizesSessionStart: currentCmeSessionStart(NOW),
        recordedAt: NOW.toISOString(),
      },
    });
    const answer = boardRisk({ rows: [atFloor], failed: false, now: NOW })(5001);
    expect(answer.kind).toBe("blocked");
    expect(answer.kind === "blocked" && answer.detail).toContain("$48,500");
    const masked = maskRiskBalance(answer, true);
    expect(masked.kind === "blocked" && masked.detail).toContain(`last closed at ${MASKED_USD}, at or below its ${MASKED_USD}`);
    expect(masked.kind === "blocked" && masked.detail).not.toMatch(/\$\d/);
  });

  it("warns when the account is on its phase's lowest budget for want of a close", () => {
    const answer = boardRisk({
      rows: [
        combine({
          eodSample: { balanceUsd: null, peakUsd: null, sizesSessionStart: null, recordedAt: null },
        }),
      ],
      failed: false,
      now: NOW,
    })(5001);
    expect(answer.kind).toBe("budget");
    if (answer.kind !== "budget") return;
    expect(answer.amount).toBe("$225");
    expect(answer.note).toBe(`${ACCOUNT_RISK_PHASE_LABELS_COMPACT.combine} · lowest`);
    expect(answer.tone).toBe("warning");
    // An account the sampler has never reached has no close at all.
    expect(answer.detail).toContain("no close on record yet");
  });

  it("does not say `yet` about a close the app took and cannot use", () => {
    // The other stale case: a stamp a session old — a holiday, a missed
    // fan-out. Wording it as *not yet* names a cause nobody checked, so the
    // two arms stay two sentences and both are pinned.
    const answer = boardRisk({
      rows: [
        combine({
          eodSample: {
            balanceUsd: 50750,
            peakUsd: 51000,
            sizesSessionStart: "2026-09-01T22:00:00.000Z",
            recordedAt: "2026-09-01T22:00:00.000Z",
          },
        }),
      ],
      failed: false,
      now: NOW,
    })(5001);
    expect(answer.kind === "budget" && answer.detail).toContain(
      "no close on record for this session yet",
    );
  });

  it("reads a phase it does not recognise as Off rather than through the buckets", () => {
    // The wire element is asserted, not validated. An unknown phase used to
    // reach the compact label map and render the literal `undefined` beside a
    // dollar figure, and reach the resolver, which would have sized a row
    // written by a future version through today's combine bands.
    const answer = boardRisk({
      rows: [
        combine({
          riskPhase: {
            phase: "funded_scaled" as unknown as AccountRiskPhase,
            mllUsd: 2000,
            startBalanceUsd: 50000,
            payoutTakenAt: null,
          },
        }),
      ],
      failed: false,
      now: NOW,
    })(5001);
    expect(answer.kind).toBe("budget");
    if (answer.kind !== "budget") return;
    expect(answer.amount).toBe("$500");
    expect(answer.note).toBeNull();
  });

  it("carries the resolver's refusal verbatim on a row it cannot price", () => {
    // A phase on a non-Topstep row. The sentence is the engine's own constant
    // — the same one the route answers and `/logs` prints — and this surface
    // does not reword it.
    const answer = boardRisk({
      rows: [
        combine({
          broker: "tradovate",
          riskPhase: { phase: "combine", mllUsd: 2000, startBalanceUsd: 50000, payoutTakenAt: null },
        }),
      ],
      failed: false,
      now: NOW,
    })(5001);
    expect(answer.kind).toBe("blocked");
    if (answer.kind !== "blocked") return;
    expect(answer.tone).toBe("danger");
    expect(answer.detail).toContain(NON_TOPSTEP_PHASE_REFUSAL);
  });

  it("answers per account, so one selector serves every card on the board", () => {
    // Two rows printing one budget is the misreading the field's own sentence
    // exists to close — it is per entry and it is the account's — and the
    // other half of that is that two *different* accounts do not share one.
    const select = boardRisk({
      rows: [combine(), row({ accountId: 5002, posture: { maxRiskPerTradeUsd: 225, maxContracts: 2 } })],
      failed: false,
      now: NOW,
    });
    const first = select(5001);
    const second = select(5002);
    expect(first.kind === "budget" && first.amount).toBe("$500");
    expect(second.kind === "budget" && second.amount).toBe("$225");
    expect(select(5001)).toEqual(first);
  });
});

describe("formatUsd / pnlToneClass — one pair for the whole board", () => {
  it("renders sign-first so a column of them scans", () => {
    expect(formatUsd(120.5)).toBe("+$120.50");
    expect(formatUsd(-40.25)).toBe("-$40.25");
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("gives zero no colour claim rather than dimming it", () => {
    // The two copies this replaces disagreed here — `--muted` on the card,
    // `--foreground` on the strip. The function answers the *sign*, and a
    // muted zero would also dim data on a row, which the board forbids: a
    // `$0.00` a leg genuinely earned is a reading, and the em-dash is what
    // says there is none.
    expect(pnlToneClass(0)).toBe("text-[var(--foreground)]");
    expect(pnlToneClass(1)).toBe("text-[var(--success)]");
    expect(pnlToneClass(-1)).toBe("text-[var(--danger)]");
  });
});

describe("describeMissingMoney — the em-dash carries a why", () => {
  it("says nothing when there is a reading", () => {
    expect(describeMissingMoney({ sessionPnl: reading(), legs: [{ detached: false }] })).toBeNull();
  });

  it("names the practice filter when no leg is detached", () => {
    expect(describeMissingMoney({ sessionPnl: null, legs: [{ detached: false }] })).toBe(
      PRACTICE_FILTER_MONEY_UNAVAILABLE,
    );
  });

  it("names the detached account when one leg is, even in a mixed card", () => {
    // Detached wins: an account that is gone is gone in either mode, and
    // pointing at the practice toggle sends the operator to a control that
    // will not bring it back.
    expect(
      describeMissingMoney({ sessionPnl: null, legs: [{ detached: false }, { detached: true }] }),
    ).toBe(DETACHED_MONEY_UNAVAILABLE);
  });

  it("applies the same rule one level down, per leg", () => {
    expect(describeMissingLegMoney({ sessionPnl: null, detached: true })).toBe(
      DETACHED_MONEY_UNAVAILABLE,
    );
    expect(describeMissingLegMoney({ sessionPnl: null, detached: false })).toBe(
      PRACTICE_FILTER_MONEY_UNAVAILABLE,
    );
    expect(describeMissingLegMoney({ sessionPnl: reading(), detached: false })).toBeNull();
  });
});

describe("cardToggleIntent — the direction that retracts a close", () => {
  type ToggleCard = Pick<BoardDeployment, "switchOn" | "legs" | "bookId" | "target">;

  function card(
    switchOn: boolean,
    statuses: DeploymentStatus[],
    bookId: string | null = null,
    target: BoardDeployment["target"] = { kind: "group", id: "grp-1" },
  ): ToggleCard {
    return {
      switchOn,
      bookId,
      target,
      legs: statuses.map((status) => ({ status, detached: false }) as BoardLeg),
    };
  }

  /** The same card with every leg detached, which is the only shape the
   *  detached arm refuses. */
  function detachedCard(statuses: DeploymentStatus[], detached: boolean[]): ToggleCard {
    return {
      switchOn: false,
      bookId: null,
      target: { kind: "group", id: "grp-1" },
      legs: statuses.map((status, i) => ({ status, detached: detached[i] }) as BoardLeg),
    };
  }

  it("is a pause when the switch is on", () => {
    expect(cardToggleIntent(card(true, ["Active"]))).toEqual({ kind: "pause" });
  });

  it("is a resume when the switch is off and nothing is closing", () => {
    expect(cardToggleIntent(card(false, ["Paused"]))).toEqual({ kind: "resume" });
  });

  it("goes inert rather than resuming over a leg that is pausing", () => {
    // `switchOn` is correctly false here — that *is* the switch position —
    // so a naive ▶ submits a live transition and cancels the close.
    expect(cardToggleIntent(card(false, ["Paused", "Pausing"]))).toEqual({
      kind: "inert",
      reason: RESUME_WOULD_RETRACT_A_CLOSE,
    });
  });

  it("resumes a group over a leg being destroyed, which the enable skips", () => {
    // `enableGroupAndRestore` leaves a `Destroying` leg alone, so the delete
    // still lands and the group route takes the enable (operator choice 3A).
    expect(cardToggleIntent(card(false, ["Paused", "Destroying"]))).toEqual({ kind: "resume" });
  });

  it("goes inert over a destroy when the card's ▶ writes the leg itself", () => {
    // A `deployment` target resumes through the leg route, and `Active` on a
    // `Destroying` row retracts the delete.
    const legTarget = { kind: "deployment", id: "leg-1" } as const;
    expect(cardToggleIntent(card(false, ["Destroying"], null, legTarget))).toEqual({
      kind: "inert",
      reason: RESUME_WOULD_RETRACT_A_CLOSE,
    });
  });

  it("still pauses a card whose legs are closing, because that is an escalation", () => {
    // A per-leg pause inside an enabled group leaves exactly this state, and
    // refusing the group's own pause would strand it.
    expect(cardToggleIntent(card(true, ["Active", "Pausing"]))).toEqual({ kind: "pause" });
  });

  it("is inert in the pause direction too on a row a book materialised", () => {
    // The group `PATCH`'s enable arm 409s on a derived row, so the escalation
    // the arm above allows is not available here: the switch is not the
    // operator's to throw at all, and the sentence says which control is.
    expect(cardToggleIntent(card(true, ["Active"], "book-1"))).toEqual({
      kind: "inert",
      reason: BOOK_DERIVED_ROW_REFUSAL,
    });
  });

  it("outranks the closing arm, because a close is transient and this is not", () => {
    expect(cardToggleIntent(card(false, ["Pausing"], "book-1"))).toEqual({
      kind: "inert",
      reason: BOOK_DERIVED_ROW_REFUSAL,
    });
  });

  it("refuses the resume when every leg is detached, and names the control that works", () => {
    // The resume writes `Active` and clears no marker, so the card comes back
    // reading `Detached` — the leg glyph's defect at card scale.
    expect(cardToggleIntent(detachedCard(["Paused"], [true]))).toEqual({
      kind: "inert",
      reason: DETACHED_RESUME_REFUSAL,
    });
  });

  it("still resumes a card with one detached leg among live ones", () => {
    // `every`, not `some`: the two healthy legs are a resume this genuinely
    // starts, and refusing the card would strand them behind a row they have
    // nothing to do with.
    expect(cardToggleIntent(detachedCard(["Paused", "Paused"], [true, false]))).toEqual({
      kind: "resume",
    });
  });
});

describe("legToggleIntent — a leg's own switch", () => {
  const leg = (status: DeploymentStatus, detached = false) => ({ status, detached });

  it("reads the leg's status, not the card's switch", () => {
    expect(legToggleIntent(leg("Active"), null)).toEqual({ kind: "pause" });
    expect(legToggleIntent(leg("Paused"), null)).toEqual({ kind: "resume" });
  });

  it("is inert while the leg is closing, with the sentence the route refuses the resume with", () => {
    // Stricter than the card's, because `toggleDeployment` refuses a closing
    // row outright — a live glyph over one is a control that does nothing.
    // One refused press, one sentence: the leg route's 409 (operator choice B).
    for (const status of ["Pausing", "Destroying"] as const) {
      expect(legToggleIntent(leg(status), null)).toEqual({
        kind: "inert",
        reason: RESUME_WOULD_RETRACT_A_CLOSE,
      });
    }
  });

  it("answers the card's refusal on a leg of a derived row, with the same constant", () => {
    // `PATCH /api/deployments/[id]` 409s on a status write to any leg of one,
    // so a live ⏸ here is the card's defect one row down. Same sentence and
    // same precedence, decided by the same pair of functions.
    expect(legToggleIntent(leg("Active"), "book-1")).toEqual({
      kind: "inert",
      reason: BOOK_DERIVED_ROW_REFUSAL,
    });
    expect(legToggleIntent(leg("Pausing"), "book-1")).toEqual({
      kind: "inert",
      reason: BOOK_DERIVED_ROW_REFUSAL,
    });
  });

  it("refuses a detached leg's resume and names the control that does clear it", () => {
    // `PATCH /api/deployments/[id]` clears the orphan markers only when
    // `accountId` changes, so a plain resume writes `Active` and leaves the
    // row reading `Detached` — a control that looks like it worked.
    const intent = legToggleIntent(leg("Paused", true), null);

    expect(intent).toEqual({ kind: "inert", reason: DETACHED_RESUME_REFUSAL });
    // The sentence names the target's own label verbatim, which is the whole
    // reason that label is a constant.
    expect(DETACHED_RESUME_REFUSAL).toContain(DETACHED_RECOVER_LABEL);
  });

  it("keeps the pause direction live on a detached leg that is somehow Active", () => {
    // One-directional, the shape the card's closing arm already has: switching
    // a detached row *off* is the operator's own stand-down and always works.
    expect(legToggleIntent(leg("Active", true), null)).toEqual({ kind: "pause" });
  });

  it("puts a close in flight above the detached arm", () => {
    // `markOrphaned` preserves a closing status on purpose — the close
    // obligation outlives the account's reachability — so the sentence the
    // operator needs there is the closing one.
    expect(legToggleIntent(leg("Pausing", true), null)).toEqual({
      kind: "inert",
      reason: RESUME_WOULD_RETRACT_A_CLOSE,
    });
  });
});

describe("detachedRestoreRefusal — a detached row that still owes a close", () => {
  it("refuses Restore and arm on a closing row, with the route's own sentence", () => {
    // `markOrphaned` preserves `Pausing` / `Destroying`, and
    // `clearOrphanedAndReEnable` writes `Active, enabled=1` regardless — so a
    // live control here retracts the operator's Destroy and re-arms entries
    // over an open position (bugs.md A74).
    const on = { parentEnabled: true };
    expect(detachedRestoreRefusal({ status: "Pausing", ...on }, null)).toBe(RESTORE_WOULD_RETRACT_A_CLOSE);
    expect(detachedRestoreRefusal({ status: "Destroying", ...on }, null)).toBe(RESTORE_WOULD_RETRACT_A_CLOSE);
  });

  it("leaves the control live on the state the route accepts", () => {
    expect(detachedRestoreRefusal({ status: "Paused", parentEnabled: true }, null)).toBeNull();
    expect(detachedRestoreRefusal({ status: "Active", parentEnabled: true }, null)).toBeNull();
    expect(detachedRestoreRefusal({ status: "Paused", parentEnabled: true }, "book-1")).toBeNull();
  });
});

describe("detachedRestoreRefusal — a book's row under a switched-off playbook (bugs.md A85)", () => {
  it("refuses with the route's sentence, which names the book's off-and-on first", () => {
    // `clearOrphanedAndReEnable` leaves the parent off, so a press here would
    // write a leg that does not trade and holds its own slot. The route 409s.
    expect(detachedRestoreRefusal({ status: "Paused", parentEnabled: false }, "book-1")).toBe(
      RESTORE_NEEDS_PLAYBOOK_ON,
    );
  });

  it("keys on the book, so a hand-made row whose parent is off stays live", () => {
    // The route asks `listDerivedRows()`; a hand-made parent is not one.
    expect(detachedRestoreRefusal({ status: "Paused", parentEnabled: false }, null)).toBeNull();
  });

  it("puts the close in flight first, in the route's order", () => {
    expect(detachedRestoreRefusal({ status: "Pausing", parentEnabled: false }, "book-1")).toBe(
      RESTORE_WOULD_RETRACT_A_CLOSE,
    );
  });

  it("names the recovery control by its own label", () => {
    // The constant lives in `domain.ts`, which may not import the component
    // that owns the label, so it spells it — and this pins the spelling.
    expect(RESTORE_NEEDS_PLAYBOOK_ON).toContain(`use ${DETACHED_RECOVER_LABEL}.`);
  });
});

describe("describeOrphanReason — what was recorded, never why", () => {
  it("renders a known code as a sentence about what the platform observed", () => {
    // The stored codes are frozen and persisted; this is a rendering of them
    // and not a second vocabulary.
    expect(describeOrphanReason("account_unavailable_at_boot")).toContain(
      "on a start-up account check",
    );
    expect(describeOrphanReason("account_unavailable_at_boot")).toContain(
      "the broker's account list did not name this account",
    );
  });

  it("does not claim the boot check was the engine's most recent start", () => {
    // It read "when it last started", which the next restart makes false — the
    // marker outlives the engine and nothing on `BoardLeg` dates it.
    expect(describeOrphanReason("account_unavailable_at_boot")).not.toContain("last");
  });

  it("tells the three list checks apart by which check ran", () => {
    // A boot inside the maintenance window and a check on a running engine are
    // different events, and which one it was is what the operator opens this
    // strip to learn (bugs.md A74).
    const seen = new Set([
      describeOrphanReason("account_unavailable_at_boot"),
      describeOrphanReason("periodic_account_check"),
      describeOrphanReason("page_render_account_check"),
    ]);

    expect(seen.size).toBe(3);
  });

  it("quotes a code it does not know rather than inventing prose for it", () => {
    // A new detection site can add a reason without passing through here, and
    // a guessed sentence would state a cause nobody checked.
    expect(describeOrphanReason("some_future_reason")).toContain("some_future_reason");
  });

  it("never says the account is gone, and never sends the operator to the broker", () => {
    // The whole bug: the account was live at the broker the entire time, and a
    // sentence sending the operator to the prop firm over a rule this app made
    // is the one copy.md forbids outright.
    const everything = [
      DETACHED_RECOVER_NOTE,
      ...[
        "account_unavailable_at_boot",
        "periodic_account_check",
        "page_render_account_check",
        "place_order_account_not_found",
        "tradovate_account_not_active",
        "tradovate_captcha_lockout",
        "tradovate_unauthorized",
        "unrecognised_code",
      ].map(describeOrphanReason),
    ].join(" ");

    for (const forbidden of ["closed", "contact", "support", "gone for good", "no longer exists"]) {
      expect(everything.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("says what the platform does if the restore was the wrong guess", () => {
    // The note ends in the operator's move and in what happens when the row
    // really has lost its account — so pressing it is never a dead end.
    expect(DETACHED_RECOVER_NOTE).toContain(DETACHED_RECOVER_LABEL);
    expect(DETACHED_RECOVER_NOTE).toContain("stands it down again");
  });
});

describe("cardEditIntent — which sentence an inert ✎ carries", () => {
  it("links when there is a deployment to edit", () => {
    expect(cardEditIntent({ editHref: "/deployments/grp-1/edit", bookId: null })).toEqual({
      kind: "link",
      href: "/deployments/grp-1/edit",
    });
  });

  it("still links on a derived row, whose configuration is the operator's", () => {
    // A book owns a row's *lifecycle*, not its settings — and this shape is
    // what the drill-in and the editor see, where one card is one deployment.
    expect(cardEditIntent({ editHref: "/deployments/grp-1/edit", bookId: "book-1" })).toEqual({
      kind: "link",
      href: "/deployments/grp-1/edit",
    });
  });

  it("says the configuration is gone on a row whose parent went", () => {
    expect(cardEditIntent({ editHref: null, bookId: null })).toEqual({
      kind: "inert",
      reason: BROKEN_ROW_EDIT_REASON,
    });
  });

  it("says the configuration is each playbook's own on a book card", () => {
    // Two different facts and two different sentences: a book card has plenty
    // to edit and no single subject, and the broken-row sentence would tell
    // the operator their settings are gone.
    expect(cardEditIntent({ editHref: null, bookId: "book-1" })).toEqual({
      kind: "inert",
      reason: BOOK_CARD_EDIT_REASON,
    });
    expect(BOOK_CARD_EDIT_REASON).not.toBe(BROKEN_ROW_EDIT_REASON);
  });
});

describe("legPulse — a green fill claims the engine will take an entry", () => {
  const leg = (over: Partial<Pick<BoardLeg, "armed" | "status" | "autoTradeRefused">> = {}) => ({
    armed: true,
    status: "Active" as DeploymentStatus,
    autoTradeRefused: false,
    ...over,
  });

  it("pulses green for an armed leg the engine will run", () => {
    expect(legPulse(leg())).toBe("running");
  });

  it("refuses green to a leg the live-account block holds back", () => {
    // The defect: `armed` mirrors `isLegEngineEnabled`, which does not
    // consult the block — that narrowing is in `listManagedDeployments()` —
    // so a live-funded leg pulsed green beside its own red `No Auto-Trade`
    // chip. The fill is semantic; green claims running.
    //
    // This module only ever sees the boolean, so the case where reading
    // `chip.kind` instead would have missed the refusal — a detached leg,
    // whose account is absent from the catalogue and therefore UNVERIFIED,
    // while the chip reports the higher `detached` rung — is pinned where the
    // field is derived: `board-model.test.ts`, "marks a leg the block refuses
    // even when a higher rung owns the chip".
    expect(legPulse(leg({ autoTradeRefused: true }))).toBe("idle");
  });

  it("keeps a closing leg pulsing, in the warn tone", () => {
    // Motion carries the transient state. The row is never greyed and its
    // numbers never fade — grey is what settled looks like.
    expect(legPulse(leg({ armed: false, status: "Pausing" }))).toBe("closing");
    expect(legPulse(leg({ armed: false, status: "Destroying" }))).toBe("closing");
  });

  it("is static for a paused leg", () => {
    expect(legPulse(leg({ armed: false, status: "Paused" }))).toBe("idle");
  });
});

describe("what a deployment write tells the engine", () => {
  const row = (status: DeploymentStatus) => ({ status }) as unknown as Deployment;

  it("keeps the engine running while any row is still its business", () => {
    expect(engineSyncIntent([row("Active")])).toBe("update");
    expect(engineSyncIntent([row("Paused"), row("Active")])).toBe("update");
  });

  it("counts a closing row as running, because the engine owes it a flatten", () => {
    // `isEngineManagedStatus`, not `=== "Active"`. Stopping the engine out
    // from under a `Pausing` row abandons the close it is mid-way through.
    expect(engineSyncIntent([row("Pausing")])).toBe("update");
    expect(engineSyncIntent([row("Destroying")])).toBe("update");
  });

  it("stops on an all-settled list, which is why the caller owes a fresh one", () => {
    // This is the answer that makes the freshness obligation real: a list one
    // write stale, or one that came back empty from a failed read, folds to
    // `"stop"` and stands the engine down over rows that are still Active.
    expect(engineSyncIntent([row("Paused")])).toBe("stop");
    expect(engineSyncIntent([])).toBe("stop");
  });
});

describe("which legs the unmanaged strip may probe", () => {
  const boardWith = (over: Partial<Pick<BoardLeg, "armed" | "autoTradeRefused">>) =>
    [
      {
        legs: [
          {
            id: "leg-a",
            accountId: 9001,
            accountName: "PRAC-1",
            claim: { accountId: 9001, ticker: "/MNQ", strategyKey: "ema", paramValues: {} },
            armed: true,
            autoTradeRefused: false,
            ...over,
          },
        ],
      },
    ] as unknown as BoardDeployment[];

  it("skips an armed leg the live-account block refuses", () => {
    // The defect: `armed` mirrors `isLegEngineEnabled`, which does not consult
    // the block — that narrowing is in `listManagedDeployments()` — so a
    // live-funded leg rendered "Closes 09:30" over a hand position the engine
    // is never handed. A promise on the strip whose only job is that promise.
    expect(collectUnmanagedProbes(boardWith({ autoTradeRefused: true }))).toEqual([]);
    expect(collectUnmanagedProbes(boardWith({ armed: false }))).toEqual([]);
    expect(collectUnmanagedProbes(boardWith({}))).toHaveLength(1);
  });

  it("keys on the leg rather than the account", () => {
    // Two strategies armed on one account each claim their own product root,
    // so collapsing them would ask about one instrument and report the answer
    // for both.
    const board = [
      {
        legs: [
          {
            id: "leg-a",
            accountId: 9001,
            accountName: "PRAC-1",
            claim: { accountId: 9001, ticker: "/MNQ", strategyKey: "ema", paramValues: {} },
            armed: true,
            autoTradeRefused: false,
          },
          {
            id: "leg-b",
            accountId: 9001,
            accountName: "PRAC-1",
            claim: { accountId: 9001, ticker: "/MES", strategyKey: "orb", paramValues: {} },
            armed: true,
            autoTradeRefused: false,
          },
        ],
      },
    ] as unknown as BoardDeployment[];

    expect(collectUnmanagedProbes(board).map((p) => p.target.ticker)).toEqual(["/MNQ", "/MES"]);
  });
});

describe("the unmanaged strip's cadence and dedupe", () => {
  const probe = (legId: string, accountId: number, accountName: string) => ({
    legId,
    accountId,
    accountName,
  });

  const preview = (
    over: { contractId?: string; whenNy?: string | null; inWindow?: boolean } = {},
  ): ManualPositionPreview => ({
    root: "MNQ",
    inWindow: over.inWindow ?? false,
    whenNy: over.whenNy === undefined ? "09:30" : over.whenNy,
    positions: [{ contractId: over.contractId ?? "CON.F.US.MNQ.Z26", side: "LONG", size: 1 }],
  });

  it("does not back off while sweeps are landing", () => {
    // The ordinary interval is the cadence. Backoff is a response to
    // failure, not a second schedule running beside it.
    expect(unmanagedBackoffMs(0)).toBe(0);
    expect(unmanagedBackoffMs(-1)).toBe(0);
  });

  it("backs off further each time every probe in a sweep fails, and caps", () => {
    // `.catch(() => null)` swallows a 429, so without this the interval
    // re-fires at full width against a broker already refusing — and the
    // engine shares that session.
    expect(unmanagedBackoffMs(1)).toBe(30_000);
    expect(unmanagedBackoffMs(2)).toBe(60_000);
    expect(unmanagedBackoffMs(4)).toBe(UNMANAGED_PROBE_MAX_BACKOFF_MS);
    expect(unmanagedBackoffMs(50)).toBe(UNMANAGED_PROBE_MAX_BACKOFF_MS);
  });

  it("wraps midnight when working out how far off a claim is", () => {
    const tenAm = 10 * 60;

    expect(minutesUntilNy("17:00", tenAm)).toBe(7 * 60);
    expect(minutesUntilNy("09:30", tenAm)).toBe(23 * 60 + 30);
    expect(minutesUntilNy(null, tenAm)).toBeNull();
    expect(minutesUntilNy("not a time", tenAm)).toBeNull();
  });

  it("lets an in-window claimer win the timing outright", () => {
    const now = 10 * 60;
    const later = { inWindow: false, whenNy: "17:00" };
    const nowClaim = { inWindow: true, whenNy: null };

    expect(preferUnmanagedClaim(later, nowClaim, now)).toBe(true);
    expect(preferUnmanagedClaim(nowClaim, later, now)).toBe(false);
  });

  it("prefers the sooner of two out-of-window claimers, not the earlier clock time", () => {
    // At 10:00 New York a 09:30 claim is 23½ hours away and a 17:00 claim is
    // seven. The shipped version kept whichever came first in board order;
    // comparing the `HH:MM` strings would pick 09:30 and tell the operator
    // their hand position survives most of a day that it does not.
    const now = 10 * 60;
    const nineThirty = { inWindow: false, whenNy: "09:30" };
    const fivePm = { inWindow: false, whenNy: "17:00" };

    expect(preferUnmanagedClaim(nineThirty, fivePm, now)).toBe(true);
    expect(preferUnmanagedClaim(fivePm, nineThirty, now)).toBe(false);
  });

  it("keeps a stated time over an unstated one, and holds on a tie", () => {
    const now = 10 * 60;
    const unknown = { inWindow: false, whenNy: null };
    const stated = { inWindow: false, whenNy: "17:00" };

    expect(preferUnmanagedClaim(unknown, stated, now)).toBe(true);
    expect(preferUnmanagedClaim(stated, unknown, now)).toBe(false);
    expect(preferUnmanagedClaim(stated, { ...stated }, now)).toBe(false);
  });

  it("reads the clock in New York, wherever the browser is", () => {
    // 14:30 UTC on a summer date is 10:30 in New York.
    expect(nowNyMinutes(new Date("2026-07-15T14:30:00.000Z"))).toBe(10 * 60 + 30);
    // …and 15:30 in New York on a winter one.
    expect(nowNyMinutes(new Date("2026-01-15T14:30:00.000Z"))).toBe(9 * 60 + 30);
  });

  // The unreadable-format branch is deliberately unpinned. Reaching it means
  // substituting the `Intl.DateTimeFormat` constructor, and a spy that does
  // not construct correctly leaks past a throw and fails the *next* test that
  // reads a real clock — which is what it did on the first two attempts here.
  // The branch is a property of the browser's ICU build rather than of any
  // input, so it is either never taken or always taken, and its whole
  // behaviour is one `console.warn` behind a latch. Cost of a harness for it
  // exceeds what it protects. The `24:00` path beside it *is* pinned below,
  // and that is the one a real build actually reaches.

  it("keeps a row whose own probe could not answer this sweep", () => {
    // The defect this replaces: the sweep's guard was
    // `answers.every(preview == null)`, which catches total failure only.
    // With 11 of 12 probes failing, the row set was replaced by what the one
    // survivor found — silently deleting rows the other eleven reported last
    // sweep. A per-account 401 or one stale contract id fails one probe, not
    // twelve, so partial is the likelier shape of the two.
    const lastAnswer = new Map([["leg-a", preview({ contractId: "CON.F.US.MNQ.Z26" })]]);
    const rows = mergeUnmanagedClaims({
      answers: [
        { probe: probe("leg-a", 5001, "PRAC-A"), preview: null },
        { probe: probe("leg-b", 5002, "PRAC-B"), preview: preview({ contractId: "CON.F.US.MES.Z26" }) },
      ],
      lastAnswer,
      now: 10 * 60,
    });

    expect(rows.map((r) => r.contractId)).toEqual(["CON.F.US.MNQ.Z26", "CON.F.US.MES.Z26"]);
  });

  it("clears a row when the probe answers and holds nothing", () => {
    // The other direction, and it must stay: an empty `positions` on a fresh
    // preview is a probe saying "nothing to close", which is the answer the
    // strip exists to render. Only a null preview falls back.
    const lastAnswer = new Map([["leg-a", preview({ contractId: "CON.F.US.MNQ.Z26" })]]);
    const rows = mergeUnmanagedClaims({
      answers: [{ probe: probe("leg-a", 5001, "PRAC-A"), preview: { ...preview(), positions: [] } }],
      lastAnswer,
      now: 10 * 60,
    });

    expect(rows).toEqual([]);
  });

  it("dedupes one position two armed legs claim, keeping the sooner timing", () => {
    // Two strategies armed on one account and one product claim the same hand
    // position, and it is one position. At 10:00 New York the 17:00 claim is
    // the one that happens first.
    const rows = mergeUnmanagedClaims({
      answers: [
        {
          probe: probe("leg-a", 5001, "PRAC-A"),
          preview: preview({ contractId: "CON.F.US.MNQ.Z26", whenNy: "09:30" }),
        },
        {
          probe: probe("leg-b", 5001, "PRAC-A"),
          preview: preview({ contractId: "CON.F.US.MNQ.Z26", whenNy: "17:00" }),
        },
      ],
      lastAnswer: new Map(),
      now: 10 * 60,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].whenNy).toBe("17:00");
  });

  it("answers 0 at New York midnight on either ICU build", () => {
    // `hour12: false` renders midnight as `24:00` on some builds and `00:00`
    // on others, and `nyMinutes` refuses an hour above 23 — so on the first
    // kind this used to land on the same silent `?? 0` a garbage format does.
    // The answer is right either way; what changed is that only one of the
    // two paths is silent now.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(nowNyMinutes(new Date("2026-07-15T04:00:00.000Z"))).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("toForceFlatResult — a panic press always gets an answer", () => {
  const ok = {
    result: {
      deploymentId: "dep-1",
      accountId: 5001,
      contractId: "CON.F.US.MNQ.Z26",
      status: "deferred",
      reason: "another flatten on this contract may still be unbooked",
      positionMayStillBeOpen: true,
      deferredTo: "force_flat",
      retryAfterMs: 12_000,
    },
  };

  it("passes a well-formed result through, typed facts intact", () => {
    expect(toForceFlatResult(ok)).toEqual(ok.result);
  });

  it("answers null for a body with no result, rather than an undefined outcome", () => {
    // The defect: `(await res.json()) as { result: ForceFlatResult }` left
    // `outcome` undefined, and by then the two-step arm had cleared and the
    // error had been reset — so the operator pressed flatten on an open
    // position and got a blank row.
    for (const raw of [null, undefined, {}, { result: null }, "nope", 7, []]) {
      expect(toForceFlatResult(raw)).toBeNull();
    }
  });

  it("refuses a status it does not know, because status selects every sentence", () => {
    expect(toForceFlatResult({ result: { deploymentId: "d", status: "maybe" } })).toBeNull();
    expect(toForceFlatResult({ result: { status: "closed" } })).toBeNull();
  });

  it("drops optional facts of the wrong type instead of rendering them", () => {
    // A server one deploy behind, or a field that changed shape. The
    // rendered clauses are typed facts, so a string `true` must not become
    // "the position may still be open".
    const narrowed = toForceFlatResult({
      result: {
        deploymentId: "dep-1",
        status: "error",
        accountId: "5001",
        positionMayStillBeOpen: "true",
        workingOrdersMayRemain: 1,
        deferredTo: "nobody",
        retryAfterMs: "12000",
      },
    });

    expect(narrowed).toEqual({
      deploymentId: "dep-1",
      status: "error",
      accountId: null,
      contractId: null,
    });
  });
});

describe("presentBoard — empty is not error is not loading", () => {
  it("says nothing is deployed only when both channels answered", () => {
    expect(
      presentBoard({ connection: "connected", deployments: "ready", cardCount: 0 }),
    ).toEqual({ body: { kind: "empty" }, warning: null, totalsReadable: true });
  });

  it("does not call an unhydrated store empty", () => {
    // The window between the session connecting and the first list read
    // landing. `[]` here means "not yet", and saying "nothing is deployed"
    // is the same lie as saying it after a 401.
    for (const deployments of ["idle", "loading"] as const) {
      expect(
        presentBoard({ connection: "connected", deployments, cardCount: 0 }).body.kind,
      ).toBe("loading");
    }
  });

  it("does not call a failed deployment read empty", () => {
    const shown = presentBoard({ connection: "connected", deployments: "failed", cardCount: 0 });

    expect(shown.body.kind).toBe("unavailable");
    expect(shown.warning).toBe(BOARD_UNAVAILABLE_WARNING);
  });

  it("does not call a failed session empty, even with the list store idle", () => {
    // The two channels fail independently: a 401 on `/api/accounts` leaves
    // the deployment store never asked rather than failed.
    const shown = presentBoard({ connection: "error", deployments: "idle", cardCount: 0 });

    expect(shown.body.kind).toBe("unavailable");
  });

  it("keeps the rows it has and warns, rather than replacing them with an error", () => {
    // Rows that loaded are still true of the moment they loaded. Hiding a
    // running deployment because the *next* read failed is the failure the
    // board exists to prevent, one turn later.
    const shown = presentBoard({ connection: "error", deployments: "ready", cardCount: 3 });

    expect(shown.body.kind).toBe("cards");
    expect(shown.warning).toBe(BOARD_STALE_WARNING);
  });

  it("warns over cards in the list's own words when the session is fine", () => {
    // Two channels, two sentences. Naming the connection over a healthy
    // connection sends the operator to reconnect something that is not
    // broken.
    const shown = presentBoard({ connection: "connected", deployments: "failed", cardCount: 2 });

    expect(shown.warning).toBe(BOARD_LIST_STALE_WARNING);
    expect(shown.warning).not.toBe(BOARD_STALE_WARNING);
  });

  it("renders healthy cards with no banner at all", () => {
    expect(
      presentBoard({ connection: "connected", deployments: "ready", cardCount: 2 }),
    ).toEqual({ body: { kind: "cards" }, warning: null, totalsReadable: true });
  });
});

describe("presentBoard — the session strip's figures", () => {
  it("blinds both figures whenever either channel could not answer", () => {
    // The strip reduces over `visibleAccounts`, and every one of these
    // states leaves that set empty or unvouched-for. An empty reduction is a
    // structurally valid `$0.00` and `0 Open` — the exact zero
    // `boardSessionPnl` exists to stop one component lower, rendered above a
    // red banner with positions open.
    const blind = [
      { connection: "error", deployments: "ready" },
      { connection: "connected", deployments: "failed" },
      { connection: "connecting", deployments: "loading" },
      { connection: "connected", deployments: "idle" },
      { connection: "needsSetup", deployments: "ready" },
    ] as const;

    for (const input of blind) {
      expect(presentBoard({ ...input, cardCount: 3 }).totalsReadable).toBe(false);
    }
  });

  it("reads the figures only when both channels answered", () => {
    expect(
      presentBoard({ connection: "connected", deployments: "ready", cardCount: 3 }).totalsReadable,
    ).toBe(true);
  });
});

describe("boardVisibility — a switched-off book's card leaves the board and is counted", () => {
  function card(id: string, dormant: boolean): BoardDeployment {
    return { id, dormant, legs: [] as BoardLeg[] } as BoardDeployment;
  }

  it("drops the dormant cards and keeps the order of the rest", () => {
    const shown = boardVisibility([
      card("a", false),
      card("b", true),
      card("c", false),
      card("d", true),
    ]);

    expect(shown.cards.map((c) => c.id)).toEqual(["a", "c"]);
    expect(shown.hiddenBookCount).toBe(2);
  });

  it("hides nothing on a board with no dormant card", () => {
    const board = [card("a", false), card("b", false)];

    expect(boardVisibility(board)).toEqual({
      cards: board,
      hiddenBookCount: 0,
      hiddenPlaybookCount: new Map(),
    });
  });
});

describe("boardVisibility — a playbook off and at rest leaves its card and is counted", () => {
  function leg(id: string, dormant: boolean): BoardLeg {
    return { id, dormant } as BoardLeg;
  }
  function card(id: string, legs: BoardLeg[], dormant = false): BoardDeployment {
    return { id, dormant, legs } as BoardDeployment;
  }

  it("drops the dormant rows from a card that stays and counts them by card", () => {
    const shown = boardVisibility([
      card("book-a", [leg("orb", false), leg("ema", true), leg("orb-c", true)]),
      card("book-b", [leg("x", false)]),
    ]);

    expect(shown.cards.map((c) => c.legs.map((l) => l.id))).toEqual([["orb"], ["x"]]);
    expect(shown.hiddenPlaybookCount).toEqual(new Map([["book-a", 2]]));
    expect(shown.hiddenBookCount).toBe(0);
  });

  it("keeps a card whose every row is hidden: its book is on, so the account stays", () => {
    const shown = boardVisibility([card("book-a", [leg("ema", true)])]);

    expect(shown.cards).toHaveLength(1);
    expect(shown.cards[0].legs).toEqual([]);
    expect(shown.hiddenPlaybookCount.get("book-a")).toBe(1);
  });

  it("counts a dormant card as a book and not again as its playbooks", () => {
    const shown = boardVisibility([card("book-a", [leg("ema", true)], true)]);

    expect(shown.cards).toEqual([]);
    expect(shown.hiddenBookCount).toBe(1);
    expect(shown.hiddenPlaybookCount.size).toBe(0);
  });

  it("leaves the board it was given whole — the strips and Flatten all read that one", () => {
    const board = [card("book-a", [leg("orb", false), leg("ema", true)])];

    boardVisibility(board);

    expect(board[0].legs.map((l) => l.id)).toEqual(["orb", "ema"]);
  });
});

describe("the Dashboard's strips and Flatten all read the whole board", () => {
  // `boardVisibility`'s `cards` may feed the card list and nothing else. The
  // unmanaged strip takes the adapter's full output; the session strip and
  // Flatten all read the live-P&L hook and the engine, never a card.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "board.tsx"),
    "utf8",
  );

  it("hands the unmanaged strip the full board", () => {
    expect(source).toMatch(/<BoardUnmanagedPositions board=\{board\} \/>/);
  });

  it("gives Flatten all no card list, and the session strip reads the hook", () => {
    expect(source).toMatch(/<FlattenAllButton token=\{token\} \/>/);
    expect(source).toMatch(/livePnl\.allAccounts\(\)/);
    expect(source).toMatch(/livePnl\.openPositionCount\(\)/);
  });
});

describe("useBoardModel feeds the hide only what it has read", () => {
  // The hook has no harness of its own; these pin the two wires the
  // fail-toward-showing rule depends on.
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "use-board.ts"),
    "utf8",
  );

  it("passes useTrades' tradesRead, not !loading, into buildBoard", () => {
    expect(source).toMatch(/const \{ trades, tradesRead \} = useTrades\(/);
    expect(source).toMatch(/\btradesRead,\n/);
    expect(source).not.toMatch(/tradesRead: !loading/);
  });

  it("narrows the books payload through toBoardBooks before it reaches state", () => {
    expect(source).toMatch(/toBoardBooks\(body\.books\)/);
  });
});

describe("toBoardBooks — a malformed books payload hides nothing and throws nothing", () => {
  it("passes a well-formed payload through", () => {
    const books = [
      { id: "book-1", enabled: true, playbooks: [{ ticker: "/MNQ", strategyKey: "orb", armed: false }] },
      { id: "book-2", enabled: false },
    ];

    expect(toBoardBooks(books)).toEqual(books);
  });

  it("answers null for a payload that is not a list, which the caller reads as no books", () => {
    expect(toBoardBooks(undefined)).toBeNull();
    expect(toBoardBooks({ id: "book-1" })).toBeNull();
  });

  it("reads non-array playbooks as unread rather than iterating them", () => {
    // `for...of` over an object throws inside the board's `useMemo`.
    expect(toBoardBooks([{ id: "book-1", enabled: true, playbooks: { length: 1 } }])).toEqual([
      { id: "book-1", enabled: true },
    ]);
    expect(toBoardBooks([{ id: "book-1", enabled: true, playbooks: null }])).toEqual([
      { id: "book-1", enabled: true },
    ]);
  });

  it("drops a book or a cell it cannot read — an unread switch or cell keeps its card and row", () => {
    expect(
      toBoardBooks([
        { id: "book-1", enabled: "no" },
        null,
        {
          id: "book-2",
          enabled: true,
          playbooks: [{ ticker: "/MNQ", strategyKey: "orb", armed: "false" }, 7],
        },
      ]),
    ).toEqual([{ id: "book-2", enabled: true, playbooks: [] }]);
  });
});

describe("describeHiddenPlaybooks — a hidden row is not a lost one", () => {
  it("says nothing when the card hides none", () => {
    expect(describeHiddenPlaybooks(0)).toBeNull();
  });

  it("counts what is hidden, in the singular and the plural", () => {
    expect(describeHiddenPlaybooks(1)).toBe("1 playbook off · not shown");
    expect(describeHiddenPlaybooks(4)).toBe("4 playbooks off · not shown");
  });

  it("names Books by its own label and no path, says nothing is deleted, and promises no switch to a playbook the build lacks", () => {
    for (const text of [describeHiddenPlaybooks(4), HIDDEN_PLAYBOOKS_DETAIL]) {
      expect(text).not.toMatch(/\/books/);
      expect(text).not.toMatch(/below|above/i);
    }
    expect(HIDDEN_PLAYBOOKS_DETAIL).toMatch(/Nothing is deleted/);
    expect(HIDDEN_PLAYBOOKS_DETAIL).toMatch(/this build does not include/);
  });
});

describe("describeHiddenBooks — a hidden card is not a lost one", () => {
  it("says nothing when nothing is hidden", () => {
    expect(describeHiddenBooks(0)).toBeNull();
  });

  it("counts what is hidden, in the singular and the plural", () => {
    expect(describeHiddenBooks(1)).toBe("1 book switched off · not shown");
    expect(describeHiddenBooks(2)).toBe("2 books switched off · not shown");
  });

  it("names the screen that holds them by its own label, and no path", () => {
    expect(HIDDEN_BOOKS_LINK_LABEL).toBe("Books");
    for (const text of [describeHiddenBooks(2), HIDDEN_BOOKS_DETAIL]) {
      expect(text).not.toMatch(/\/books/);
      expect(text).not.toMatch(/below|above/i);
    }
  });

  it("says nothing was deleted", () => {
    expect(HIDDEN_BOOKS_DETAIL).toMatch(/Nothing is deleted/);
  });
});

describe("presentBoard — every card hidden is not nothing deployed", () => {
  it("says nothing is switched on rather than that nothing is deployed", () => {
    expect(
      presentBoard({
        connection: "connected",
        deployments: "ready",
        cardCount: 0,
        hiddenBookCount: 2,
      }).body.kind,
    ).toBe("all-off");
  });

  it("still says unavailable and loading over hidden cards — the count is not a reading", () => {
    expect(
      presentBoard({ connection: "error", deployments: "ready", cardCount: 0, hiddenBookCount: 2 })
        .body.kind,
    ).toBe("unavailable");
    expect(
      presentBoard({
        connection: "connected",
        deployments: "loading",
        cardCount: 0,
        hiddenBookCount: 2,
      }).body.kind,
    ).toBe("loading");
  });

  it("changes nothing while a card is on screen", () => {
    expect(
      presentBoard({
        connection: "connected",
        deployments: "ready",
        cardCount: 1,
        hiddenBookCount: 2,
      }),
    ).toEqual({ body: { kind: "cards" }, warning: null, totalsReadable: true });
  });
});

describe("presentBoard — signed in with no broker", () => {
  it("says no broker in place of the accounts, not nothing deployed, and the strip reads blind rather than $0.00", () => {
    for (const deployments of ["idle", "loading", "ready"] as const) {
      expect(
        presentBoard({ connection: "connected", deployments, cardCount: 0, noBroker: true }),
      ).toEqual({ body: { kind: "no-broker" }, warning: null, totalsReadable: false });
    }
  });
});
