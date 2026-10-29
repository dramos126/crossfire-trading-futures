/**
 * The playbook page's Deploy control — the four things it must get right.
 *
 * `autoTradeVerdict` is not mocked: the refusal a funded row carries is the
 * shipped constant, and a stubbed predicate would assert the stub. Book
 * payloads are the route's own `BookPayload` shape, written with every field,
 * because the precedence notice is a join across it and a fixture that omitted
 * `groupId` would omit the branch that tells a book's copy from a hand-made one.
 */
import { describe, expect, it, vi } from "vitest";

// Every contract row is deployable today (A112), so MYM stands in for the next
// research row: the one collaborator that would answer differently.
vi.mock("@/lib/trading/contracts/contract-specs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/trading/contracts/contract-specs")>()),
  DEPLOYABLE_SPEC_TICKERS: ["MNQ", "MES", "MGC"],
}));

import type { BookPayload } from "@/app/api/books/route";
import type { AccountRow } from "@/lib/hooks/use-trading/account-row";
import {
  autoTradeVerdict,
  LIVE_ACCOUNT_REFUSAL,
  UNVERIFIED_ACCOUNT_REFUSAL,
} from "@/lib/trading/broker-access/account-trading-policy";
import {
  ACCOUNT_DEAD_REFUSAL,
  autoBracketWarning,
} from "@/lib/trading/broker-access/account-state-gate";
import {
  undeployableInstrumentRefusal,
  type ParamSchema,
  type StrategyConfig,
} from "@/lib/trading/strategy-types";
import {
  buildDeployAccountRows,
  buildDeployRequest,
  deployIntent,
  deployNotice,
  deployErrorLead,
  heldBackSentences,
  pickDeployAccount,
  playbookDeployTarget,
  sameContractWarning,
  withRollback,
  BOOKS_UNREAD_NOTE,
  DEPLOY_CHECKING_ACCOUNTS,
  DEPLOY_INTERRUPTED,
  NO_AUTO_TRADE_STAMP,
  DEPLOY_LIST_LOADING,
  DEPLOY_LIST_UNREAD,
  DEPLOY_ROLLBACK_FAILED,
  DEPLOY_ROLLED_BACK,
  DEPLOY_UNREACHABLE,
  NO_CALIBRATED_INSTRUMENT_REASON,
} from "./playbook-deploy-model";

const PARAMS: Record<string, ParamSchema> = {
  rangeMinutes: { type: "integer", label: "Range (minutes)", default: 15 },
  allowShorts: { type: "boolean", label: "Allow shorts", default: true },
};

function module(config: Partial<StrategyConfig> = {}, isTest = false) {
  return {
    config: { name: "Opening Range Breakout", calibratedFor: "MNQ", ...config } as StrategyConfig,
    params: PARAMS,
    isTest,
  };
}

/** An `/api/accounts` row as the route answers it: the verdict is the
 *  server's, from the shipped predicate (bugs.md A38). */
function account(id: number, name: string, practice: boolean): AccountRow {
  return {
    id,
    name,
    balance: 50_000,
    canTrade: true,
    isVisible: true,
    broker: "topstep",
    practice,
    autoTrade: autoTradeVerdict({ name, broker: "topstep", practice }),
  };
}

const PRAC = account(1, "PRAC-V2-100200-90012114", true);
/** Classifies LIVE — the policy test's own fixture shape. */
const FUNDED = account(2, "TSTX-441122", false);

function book(over: Partial<BookPayload> = {}): BookPayload {
  return {
    id: "book-1",
    accountId: PRAC.id,
    enabled: true,
    closingOnSwitchOn: [],
    account: { name: PRAC.name, broker: "topstep", autoTrade: { permitted: true } },
    playbooks: [
      { ticker: "/MNQ", strategyKey: "orb", armed: true, groupId: null, conflict: null, running: false, parentEnabled: false, detached: null, closing: false, closingOnArm: false },
    ],
    ...over,
  };
}

const NOTICE_BASE = {
  playbookName: "Opening Range Breakout",
  strategyKey: "orb",
  ticker: "/MNQ" as const,
  accountId: PRAC.id,
};

describe("a playbook with no calibrated instrument", () => {
  it("is inert with the reason stated, and never offers a ticker", () => {
    const target = playbookDeployTarget(module({ calibratedFor: undefined }));
    expect(target).toEqual({ kind: "inert", reason: NO_CALIBRATED_INSTRUMENT_REASON });
  });

  it("stays inert at the press with an account picked, so the handler cannot write", () => {
    const m = module({ calibratedFor: undefined });
    const intent = deployIntent({
      strategyKey: "orb",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([PRAC]),
      accountId: PRAC.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: true,
    });
    expect(intent).toEqual({ kind: "inert", reason: NO_CALIBRATED_INSTRUMENT_REASON });
  });

  it("deploys on the slash-spelled instrument when it declares one", () => {
    expect(playbookDeployTarget(module())).toEqual({ kind: "ready", ticker: "/MNQ" });
  });
});

describe("a playbook calibrated for a research-only instrument", () => {
  it("is inert with the shared refusal, and offers no instrument", () => {
    const target = playbookDeployTarget(module({ calibratedFor: "MYM" }));
    expect(target).toEqual({ kind: "inert", reason: undeployableInstrumentRefusal("/MYM") });
    expect(undeployableInstrumentRefusal("/MYM")).toBe(
      "/MYM is on file for research only: the platform has not checked live trading on it, so nothing " +
        "is deployed there. Deploy on an instrument that is open for live trading — /MNQ, /MES, /MGC.",
    );
  });

  it("refuses nothing on a deployable row or a ticker with no row", () => {
    expect(undeployableInstrumentRefusal("/MNQ")).toBeNull();
    expect(undeployableInstrumentRefusal("/NQ")).toBeNull();
  });
});

describe("a funded account", () => {
  it("is offered, refused with the block's own sentence, and not dropped", () => {
    const rows = buildDeployAccountRows([PRAC, FUNDED]);
    expect(rows.map((r) => r.id)).toEqual([PRAC.id, FUNDED.id]);
    expect(rows[1].refusal).toBe(LIVE_ACCOUNT_REFUSAL);
  });

  it("A38 — refuses a practice-named row the server says is unverified, reading the field rather than the name", () => {
    // The unseeded `account_brokers` row: the name alone would permit it.
    const unseeded: AccountRow = {
      ...PRAC,
      id: 3,
      autoTrade: { permitted: false, reason: UNVERIFIED_ACCOUNT_REFUSAL },
    };
    const rows = buildDeployAccountRows([PRAC, unseeded]);
    expect(rows[0].refusal).toBeNull();
    expect(rows[1].refusal).toBe(UNVERIFIED_ACCOUNT_REFUSAL);
    expect(rows[1].stamp).toBe(NO_AUTO_TRADE_STAMP);
  });

  it("cannot be picked through the handler, whatever the DOM allowed", () => {
    const rows = buildDeployAccountRows([PRAC, FUNDED]);
    expect(pickDeployAccount(rows, FUNDED.id)).toBeNull();
    expect(pickDeployAccount(rows, PRAC.id)).toBe(PRAC.id);
  });

  it("cannot be deployed on even if the selection reached it", () => {
    const m = module();
    const intent = deployIntent({
      strategyKey: "orb",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([FUNDED]),
      accountId: FUNDED.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: true,
    });
    expect(intent).toEqual({ kind: "inert", reason: LIVE_ACCOUNT_REFUSAL });
  });
});

describe("the precedence notice", () => {
  it("says the book's copy runs nothing when the book covers this playbook and it is armed", () => {
    const notice = deployNotice({ ...NOTICE_BASE, books: [book()], blocking: [] });
    expect(notice?.kind).toBe("notice");
    expect(notice?.text).toContain("book has Opening Range Breakout armed on /MNQ");
    expect(notice?.text).toContain("does not restart the book's copy by itself");
  });

  it("refuses rather than claiming a stand-down when the book's copy is already running", () => {
    // The route 409s this create: the derived row's leg is Active on the same
    // (account, ticker, playbook), and nothing makes it stand down.
    const notice = deployNotice({
      ...NOTICE_BASE,
      books: [
        book({
          playbooks: [
            {
              ticker: "/MNQ",
              strategyKey: "orb",
              armed: true,
              groupId: "g-book",
              conflict: null,
              running: true,
              parentEnabled: true,
              detached: null,
              closing: false, closingOnArm: false,
            },
          ],
        }),
      ],
      blocking: [{ id: "leg-book", groupId: "g-book", name: null, accountId: PRAC.id }],
    });
    expect(notice).toEqual({
      kind: "refused",
      text: expect.stringContaining("already runs Opening Range Breakout on /MNQ, and a second copy"),
    });
    expect(notice?.text).toContain("Turn Opening Range Breakout off for this account on the Books screen first");
  });

  it("names a hand-made holder and asks for its delete instead", () => {
    const notice = deployNotice({
      ...NOTICE_BASE,
      books: [],
      blocking: [{ id: "leg-1", groupId: "g-hand", name: "ORB morning", accountId: PRAC.id }],
    });
    expect(notice?.kind).toBe("refused");
    expect(notice?.text).toContain("ORB morning already runs");
    expect(notice?.text).toContain("Delete that deployment");
  });

  it("says nothing when the book does not arm this playbook, or arms it on another instrument", () => {
    const disarmed = book({
      playbooks: [
        { ticker: "/MNQ", strategyKey: "orb", armed: false, groupId: null, conflict: null, running: false, parentEnabled: false, detached: null, closing: false, closingOnArm: false },
      ],
    });
    expect(deployNotice({ ...NOTICE_BASE, books: [disarmed], blocking: [] })).toBeNull();
    expect(
      deployNotice({
        ...NOTICE_BASE,
        books: [book({ playbooks: book().playbooks.map((p) => ({ ...p, ticker: "/MES" })) })],
        blocking: [],
      }),
    ).toBeNull();
    expect(
      deployNotice({ ...NOTICE_BASE, books: [book({ accountId: 99 })], blocking: [] }),
    ).toBeNull();
  });

  it("does not ask for a delete when the books read failed, since the holder may be the book's own copy", () => {
    // With no books there is no cell to match the holder's groupId against,
    // and a derived row refuses a delete — so the move must work either way.
    const notice = deployNotice({
      ...NOTICE_BASE,
      books: null,
      blocking: [{ id: "leg-book", groupId: "g-book", name: "orb", accountId: PRAC.id }],
    });
    expect(notice?.kind).toBe("refused");
    expect(notice?.text).toContain("orb already runs Opening Range Breakout");
    expect(notice?.text).not.toContain("Delete that deployment");
    expect(notice?.text).toContain(BOOKS_UNREAD_NOTE);
    expect(notice?.text).toContain("Pick another account.");
  });

  it("says the question could not be asked when the books read failed", () => {
    expect(deployNotice({ ...NOTICE_BASE, books: null, blocking: [] })).toEqual({
      kind: "notice",
      text: BOOKS_UNREAD_NOTE,
    });
  });

  it("disables Deploy on a refusal and leaves it live on a notice", () => {
    const m = module();
    const base = {
      strategyKey: "orb",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([PRAC]),
      accountId: PRAC.id,
      checking: false,
      loadState: "ready" as const,
      accountsChecked: true,
    };
    expect(deployIntent({ ...base, notice: { kind: "refused", text: "held" } })).toEqual({
      kind: "inert",
      reason: "held",
    });
    expect(deployIntent({ ...base, notice: { kind: "notice", text: "n" } }).kind).toBe("write");
  });
});

describe("the same-contract warning", () => {
  const capped = {
    id: "leg-capped",
    name: null,
    strategyKey: "orb-sample-capped",
    accountId: PRAC.id,
  };

  it("names the playbook already on this account and contract, and says what the race costs", () => {
    const text = sameContractWarning({ ticker: "/MNQ", accountId: PRAC.id, others: [capped] });
    expect(text).toContain("orb-sample-capped already runs on /MNQ on this account");
    expect(text).toContain("dropped, not queued");
  });

  it("prefers the deployment's own name, and lists each neighbour once", () => {
    const text = sameContractWarning({
      ticker: "/MNQ",
      accountId: PRAC.id,
      others: [
        { ...capped, name: "Capped — NY" },
        { ...capped, id: "leg-2", name: "Capped — NY" },
        { ...capped, id: "leg-3", strategyKey: "ema-bounce" },
      ],
    });
    expect(text).toMatch(/^Capped — NY, ema-bounce already run on \/MNQ/);
  });

  it("says nothing when no other playbook shares the contract, or the answer is still out", () => {
    expect(sameContractWarning({ ticker: "/MNQ", accountId: PRAC.id, others: [] })).toBeNull();
    expect(sameContractWarning({ ticker: "/MNQ", accountId: PRAC.id, others: null })).toBeNull();
  });

  it("ignores a neighbour on another account", () => {
    expect(
      sameContractWarning({ ticker: "/MNQ", accountId: PRAC.id, others: [{ ...capped, accountId: 99 }] }),
    ).toBeNull();
  });

  it("does not block the deploy: Deploy writes with the warning showing", () => {
    // The warning is not an input to `deployIntent` at all; this pins that a
    // press on an account with a neighbour still produces the write.
    const m = module();
    expect(sameContractWarning({ ticker: "/MNQ", accountId: PRAC.id, others: [capped] })).not.toBeNull();
    const intent = deployIntent({
      strategyKey: "orb-sample",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([PRAC]),
      accountId: PRAC.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: true,
    });
    expect(intent.kind).toBe("write");
  });
});

describe("a press before the deployment list has loaded", () => {
  // Whether the press is an engine `start` or an `update` is read off this
  // list, and `start` is a no-op on a running engine — so a press on an
  // unanswered list can create an Active row the engine never runs.
  const m = module();
  const base = {
    strategyKey: "orb",
    module: m,
    target: playbookDeployTarget(m),
    rows: buildDeployAccountRows([PRAC]),
    accountId: PRAC.id,
    notice: null,
    checking: false,
    accountsChecked: true,
  };

  it("is inert while the list has not answered", () => {
    expect(deployIntent({ ...base, loadState: "idle" })).toEqual({
      kind: "inert",
      reason: DEPLOY_LIST_LOADING,
    });
    expect(deployIntent({ ...base, loadState: "loading" })).toEqual({
      kind: "inert",
      reason: DEPLOY_LIST_LOADING,
    });
  });

  it("is inert with its own sentence when the list read failed", () => {
    expect(deployIntent({ ...base, loadState: "failed" })).toEqual({
      kind: "inert",
      reason: DEPLOY_LIST_UNREAD,
    });
  });

  it("writes once the list is one the server answered with", () => {
    expect(deployIntent({ ...base, loadState: "ready" }).kind).toBe("write");
  });
});

describe("a failed deploy's message", () => {
  it("says nothing was created only when nothing was", () => {
    expect(deployErrorLead(new TypeError("Failed to fetch"), false)).toBe(DEPLOY_UNREACHABLE);
    expect(deployErrorLead(new Error("route said no"), false)).toBe("route said no");
  });

  it("does not claim nothing was created once a row was", () => {
    const lead = deployErrorLead(new TypeError("Failed to fetch"), true);
    expect(lead).toBe(DEPLOY_INTERRUPTED);
    expect(lead).not.toContain("Nothing was created");
  });

  it("states whether the rollback landed, and says the row is still Active when it did not", () => {
    expect(withRollback("Engine start failed: x", true)).toBe(
      `Engine start failed: x ${DEPLOY_ROLLED_BACK}`,
    );
    const failed = withRollback("Engine start failed: x", false);
    expect(failed).toBe(`Engine start failed: x ${DEPLOY_ROLLBACK_FAILED}`);
    expect(DEPLOY_ROLLBACK_FAILED).toContain("still Active");
    expect(DEPLOY_ROLLBACK_FAILED).toContain("Dashboard");
  });
});

describe("the request", () => {
  it("carries the module's defaults and nothing else", () => {
    const request = buildDeployRequest("orb", module(), "/MNQ", PRAC.id);
    expect(request.paramValues).toEqual({ rangeMinutes: 15, allowShorts: true });
    expect(Object.keys(request).sort()).toEqual(
      ["accountId", "contractId", "name", "paramValues", "status", "strategyKey", "ticker"].sort(),
    );
    expect(request).toMatchObject({
      strategyKey: "orb",
      accountId: PRAC.id,
      ticker: "/MNQ",
      contractId: null,
      status: "Active",
      name: null,
    });
  });

  it("is the request the press sends, not a second build of it", () => {
    const m = module({}, true);
    const intent = deployIntent({
      strategyKey: "orb.test",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([PRAC]),
      accountId: PRAC.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: true,
    });
    expect(intent).toEqual({
      kind: "write",
      request: buildDeployRequest("orb.test", m, "/MNQ", PRAC.id),
    });
  });
});

describe("the account-state gate on the rows", () => {
  const deadGate = {
    accountId: PRAC.id,
    name: PRAC.name,
    refusal: { kind: "dead" as const, stamp: "Dead", reason: ACCOUNT_DEAD_REFUSAL },
    warning: null,
    replacements: [{ accountId: 9, name: "PRAC-NEW" }],
  };

  it("reads the server's refusal and stamp onto a row the live-account block permits", () => {
    const [row] = buildDeployAccountRows([PRAC], [deadGate]);
    expect(row).toMatchObject({
      refusal: ACCOUNT_DEAD_REFUSAL,
      stamp: "Dead",
      replacements: [{ accountId: 9, name: "PRAC-NEW" }],
    });
    expect(pickDeployAccount([row!], PRAC.id)).toBeNull();
  });

  it("answers the live-account block first, with its own stamp", () => {
    const [row] = buildDeployAccountRows([FUNDED], [{ ...deadGate, accountId: FUNDED.id }]);
    expect(row).toMatchObject({ refusal: LIVE_ACCOUNT_REFUSAL, stamp: NO_AUTO_TRADE_STAMP });
  });

  it("refuses nothing on that ground while the gates are unread", () => {
    expect(buildDeployAccountRows([PRAC], null)[0]).toMatchObject({ refusal: null, stamp: null });
  });

  it("carries the auto-bracket warning without refusing, so Deploy stays a write", () => {
    const warning = autoBracketWarning(300, 600);
    const rows = buildDeployAccountRows([PRAC], [{ ...deadGate, refusal: null, warning, replacements: [] }]);
    expect(rows[0]).toMatchObject({ refusal: null, warning });
    const m = module();
    const intent = deployIntent({
      strategyKey: "orb",
      module: m,
      target: playbookDeployTarget(m),
      rows,
      accountId: PRAC.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: true,
    });
    expect(intent.kind).toBe("write");
  });

  it("is inert until the open's account check has answered", () => {
    const m = module();
    const intent = deployIntent({
      strategyKey: "orb",
      module: m,
      target: playbookDeployTarget(m),
      rows: buildDeployAccountRows([PRAC]),
      accountId: PRAC.id,
      notice: null,
      checking: false,
      loadState: "ready",
      accountsChecked: false,
    });
    expect(intent).toEqual({ kind: "inert", reason: DEPLOY_CHECKING_ACCOUNTS });
  });
});

describe("held-back sentences", () => {
  it("reports only the row this press created, one sentence per reason", () => {
    const sentences = heldBackSentences(
      {
        skippedLiveAccounts: [
          { id: "mine", reason: LIVE_ACCOUNT_REFUSAL },
          { id: "other", reason: "some other reason" },
        ],
      },
      "mine",
    );
    expect(sentences).toEqual([LIVE_ACCOUNT_REFUSAL]);
  });
});
