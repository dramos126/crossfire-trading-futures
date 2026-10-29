"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { FieldBadge } from "@/components/field-badge";
import {
  MoveToReplacement,
  useBooks,
  useStatusCheckOnOpen,
} from "@/components/playbook/playbook-account-gates";
import { AUTO_BRACKET_STAMP } from "@/lib/trading/broker-access/account-state-gate";
import { TEST_STRATEGY_REASON } from "@/components/playbook/playbook-detail-model";
import { PlaybookSection } from "@/components/playbook/playbook-section";
import { TestFixtureStamp } from "@/components/playbook/playbook-stamp";
import {
  deployErrorLead,
  deployIntent,
  deployNotice,
  describeNoAccounts,
  heldBackSentences,
  pickDeployAccount,
  buildDeployAccountRows,
  sameContractWarning,
  withRollback,
  DEPLOY_HELP,
  NO_AUTO_TRADE_STAMP,
  type BlockingDeployment,
  type DeployAccountRow,
  type DeployIntent,
  type PlaybookDeployTarget,
  type SameContractDeployment,
} from "@/components/playbook/playbook-deploy-model";
import {
  loadDeployments,
  syncEngine,
  useDeployments,
  useDeploymentsLoadState,
} from "@/lib/hooks/use-strategies";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import { confirmActivationUnderD2 } from "@/lib/trading/activation-prompts";
import { isEngineManagedStatus, type TickerSymbol } from "@/lib/trading/domain";
import type { StrategyModule } from "@/lib/trading/strategy-types";

/**
 * Deploy one playbook on one account, from its own page.
 *
 * **The create route's checks, not a copy of them.** The create is
 * `POST /api/deployments` through the store's `addDeployment`, followed by
 * `syncEngine` and a soft-delete rollback — so the live-account block, the
 * instrument and day-session refusals and the session-overlap 409 are the ones
 * that route enforces, and every refusal it answers renders here verbatim.
 * What this surface owns is the pre-press half: an account list that states
 * each refusal instead of hiding it, a notice about the book on the chosen
 * account, and a warning when another playbook already runs on that contract.
 *
 * **Inline, not a modal.** The frame opens under the header and the confirm is
 * the activation prompts `confirmActivationUnderD2` already shows on every
 * other arming control — no second confirm idiom stacked on them.
 *
 * Every decision is in [`playbook-deploy-model.ts`](./playbook-deploy-model.ts).
 */

/** The header's primary action. Inert with the reason when the playbook names
 *  no instrument — the operator is never asked for one. */
export function PlaybookDeployButton({
  target,
  open,
  onOpen,
}: {
  target: PlaybookDeployTarget;
  open: boolean;
  onOpen: () => void;
}) {
  const inert = target.kind === "inert";
  return (
    <button
      type="button"
      onClick={() => {
        if (target.kind === "inert") return;
        onOpen();
      }}
      disabled={inert || open}
      title={target.kind === "inert" ? target.reason : undefined}
      className="btn-emerald rounded-md px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      Deploy
    </button>
  );
}

type Outcome =
  | { kind: "done"; deploymentId: string; accountName: string; held: string[] }
  | { kind: "failed"; message: string };

export function PlaybookDeployPanel({
  playbookKey,
  playbookName,
  module,
  target,
  sessionLabel,
  isTest,
  onClose,
}: {
  playbookKey: string;
  playbookName: string;
  module: Pick<StrategyModule, "config" | "params" | "isTest">;
  target: Extract<PlaybookDeployTarget, { kind: "ready" }>;
  sessionLabel: string;
  isTest: boolean;
  onClose: () => void;
}) {
  const { accounts, visibleAccounts, practiceOnly, token, reloadAccounts } = useTrading();
  const { accountLabel, text } = useDisplayPrivacy();
  const { addDeployment, deleteDeployment } = useDeployments();
  const loadState = useDeploymentsLoadState();
  const ticker = target.ticker;

  // One account-status check per open; once it settles, the account list and
  // the books (which carry each account's gate) are read again.
  const [round, setRound] = useState(0);
  const reread = () => {
    void reloadAccounts();
    setRound((n) => n + 1);
  };
  const statusSettled = useStatusCheckOnOpen(token, reread);
  const books = useBooks(token, round);

  // The visible accounts, as every deploy picker offers them.
  const rows = useMemo(
    () => buildDeployAccountRows(visibleAccounts, books.gates),
    [visibleAccounts, books.gates],
  );
  const [accountId, setAccountId] = useState<number | null>(null);
  const conflict = useConflictCheck(token, accountId, ticker, playbookKey);
  const [busy, setBusy] = useState(false);
  // Latched before the activation prompts, which `busy` cannot cover: it is state, so
  // a second click in the same frame still reads it false.
  const pressing = useRef(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const notice =
    accountId != null && books.settled && conflict?.accountId === accountId
      ? deployNotice({
          playbookName,
          strategyKey: playbookKey,
          ticker,
          accountId,
          books: books.list,
          blocking: conflict.blocking,
        })
      : null;
  // Beside the notice, never inside `deployIntent`: nothing about it blocks.
  const sameContract =
    accountId != null && conflict?.accountId === accountId
      ? sameContractWarning({ ticker, accountId, others: conflict.nonBlocking })
      : null;
  const checking =
    accountId != null && (!books.settled || conflict?.accountId !== accountId);
  const intentInput = {
    strategyKey: playbookKey,
    module,
    target,
    rows,
    accountId,
    notice,
    checking,
    loadState,
    accountsChecked: statusSettled && books.settledRound === round,
  };
  const intent = deployIntent(intentInput);
  const autoBracket = rows.find((r) => r.id === accountId)?.warning ?? null;
  const pickedName = rows.find((r) => r.id === accountId)?.name;

  // Soft, never `?hard`: `?hard` 409s on a row not already in
  // Trash. `deleteDeployment` answers false on a refusal rather than throwing,
  // so both are read as *did not land*.
  async function rollBack(id: string): Promise<boolean> {
    return deleteDeployment(id).catch(() => false);
  }

  async function press() {
    // The handler asks the model again, with the operands the render used.
    const current: DeployIntent = deployIntent(intentInput);
    if (current.kind === "inert" || busy || pressing.current) return;
    pressing.current = true;
    try {
      await deploy(current.request);
    } finally {
      pressing.current = false;
    }
  }

  async function deploy(request: Extract<DeployIntent, { kind: "write" }>["request"]) {
    // An activation like any other: the create is `Active`, so the activation
    // prompts run first and declining either one creates nothing.
    const confirmed = await confirmActivationUnderD2({
      accountId: request.accountId,
      ticker: request.ticker,
      strategyKey: request.strategyKey,
      paramValues: request.paramValues,
    });
    if (!confirmed) return;

    setBusy(true);
    setOutcome(null);
    // Read off a list the server answered with — `deployIntent` is inert until
    // it has — because `start` on an engine already running does nothing.
    const wasRunningBefore = loadDeployments().some((d) => isEngineManagedStatus(d.status));
    let createdId: string | null = null;
    try {
      const created = await addDeployment(request);
      createdId = created.id;
      const result = await syncEngine(wasRunningBefore ? "update" : "start", {
        token,
        practiceOnly,
        deployments: loadDeployments(),
      });
      if (!result.ok) {
        const rolledBack = await rollBack(created.id);
        setOutcome({
          kind: "failed",
          message: withRollback(`Engine start failed: ${result.error}`, rolledBack),
        });
        return;
      }
      // The full catalogue for the name, not the visible list — the account
      // a hold-back names may be exactly the one a practice-only view hides.
      const accountName =
        accounts.find((a) => a.id === request.accountId)?.name ?? `account ${request.accountId}`;
      setOutcome({
        kind: "done",
        deploymentId: created.id,
        accountName,
        held: heldBackSentences(result, created.id),
      });
    } catch (err) {
      const lead = deployErrorLead(err, createdId != null);
      setOutcome({
        kind: "failed",
        message: createdId == null ? lead : withRollback(lead, await rollBack(createdId)),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PlaybookSection title="Deploy" help={DEPLOY_HELP} right={`${ticker} · ${sessionLabel}`}>
      {outcome?.kind === "done" ? (
        <DeployDone outcome={outcome} onClose={onClose} />
      ) : (
        <div className="space-y-3">
          {/* The header's stamp, carried into the confirmation with its own
              sentence spelled out rather than left in a tooltip: this is the
              moment it applies. */}
          {isTest && (
            <p className="flex items-center gap-2 text-[11px] text-[var(--muted)]">
              <TestFixtureStamp />
              <span>{TEST_STRATEGY_REASON}</span>
            </p>
          )}

          <PlaybookDeployAccounts
            rows={rows}
            selected={accountId}
            onSelect={setAccountId}
            empty={describeNoAccounts(practiceOnly)}
            move={{ token, onMoved: reread }}
          />

          {/* Beside Deploy, never inside `deployIntent`: it blocks nothing. */}
          {autoBracket && (
            <p className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
              {autoBracket}
            </p>
          )}
          {notice && (
            <p className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
              {text(notice.text)}
            </p>
          )}
          {sameContract && (
            <p className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
              {text(sameContract)}
            </p>
          )}
          {outcome?.kind === "failed" && (
            <p className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]">
              {text(outcome.message)}
            </p>
          )}

          <div className="flex items-center gap-2">
            <span className="truncate font-mono tabular text-[11px] text-[var(--muted)]">
              {[playbookKey, ticker, pickedName == null ? null : accountLabel(pickedName)]
                .filter((part): part is string => part != null)
                .join(" · ")}
            </span>
            {/* Primary execution action, anchored far right. */}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void press()}
              disabled={intent.kind === "inert" || busy}
              title={intent.kind === "inert" ? intent.reason : undefined}
              className="btn-emerald rounded-md px-3 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Deploying…" : "Deploy"}
            </button>
          </div>
        </div>
      )}
    </PlaybookSection>
  );
}

function DeployDone({
  outcome,
  onClose,
}: {
  outcome: Extract<Outcome, { kind: "done" }>;
  onClose: () => void;
}) {
  const { accountLabel, text } = useDisplayPrivacy();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs">
        <span className="text-[var(--foreground)]">
          Deployed on <span className="font-mono tabular">{accountLabel(outcome.accountName)}</span>.
        </span>
        <Link
          href={`/deployments/${encodeURIComponent(outcome.deploymentId)}`}
          className="text-[var(--accent)] hover:underline"
        >
          Open deployment
        </Link>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md border border-[var(--card-border)] px-2 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
        >
          Close
        </button>
      </div>
      {outcome.held.map((sentence) => (
        <p
          key={sentence}
          className="border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-[var(--warning)]"
        >
          {text(sentence)}
        </p>
      ))}
    </div>
  );
}

/**
 * The account list: one radio per row, in a real `<input>` so the table stays
 * a table ([design-language.md], *A control drawn as a table row*).
 *
 * **A refused account is shown, disabled and stamped** — `no auto-trade`, or
 * the account-state gate's `dead` / `locked` / `oco off` / `oco unknown`, in
 * the row, and the refusal verbatim in its title — never dropped, because a
 * missing row is a third state the operator has to explain. A dead account a
 * book or deployment uses carries *Move to replacement* when one exists.
 */
export function PlaybookDeployAccounts({
  rows,
  selected,
  onSelect,
  empty,
  move,
}: {
  rows: readonly DeployAccountRow[];
  selected: number | null;
  onSelect: (id: number) => void;
  empty: string;
  /** Absent renders no move control. */
  move?: { token: string | null; onMoved: () => void };
}) {
  const { accountLabel } = useDisplayPrivacy();
  if (rows.length === 0) {
    return <p className="text-[11px] text-[var(--muted)]">{empty}</p>;
  }
  return (
    <div className="max-h-64 overflow-auto border border-[var(--card-border)]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-[var(--card-border)] bg-[var(--card)]">
            <th scope="col" className="w-8 px-3 py-2" />
            <th
              scope="col"
              className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]"
            >
              ACCOUNT
            </th>
            <th
              scope="col"
              className="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-widest text-[var(--muted)]"
            >
              BROKER
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const refused = row.refusal != null;
            return (
              <tr
                key={row.id}
                title={row.refusal ?? undefined}
                aria-disabled={refused || undefined}
                className={`${idx % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"} ${
                  refused ? "cursor-not-allowed opacity-50" : ""
                }`}
              >
                <td className="px-3 py-2">
                  <input
                    type="radio"
                    name="playbook-deploy-account"
                    aria-label={accountLabel(row.name)}
                    checked={selected === row.id}
                    disabled={refused}
                    onChange={() => {
                      const picked = pickDeployAccount(rows, row.id);
                      if (picked != null) onSelect(picked);
                    }}
                  />
                </td>
                {/* A column value: monospace 12px at full contrast, the
                    documented density carve-out. */}
                <td className="px-3 py-2 font-mono tabular text-xs text-[var(--foreground)]">
                  <span className="flex items-center gap-2">
                    <span className="truncate">{accountLabel(row.name)}</span>
                    {refused && (
                      <span
                        className={`shrink-0 rounded-full border border-[var(--danger)]/30 bg-[var(--danger)]/15 px-1 py-0.5 text-[10px] ${row.stampFromStateGate ? "" : "uppercase "}tracking-wide text-[var(--danger)]`}
                      >
                        {row.stamp ?? NO_AUTO_TRADE_STAMP}
                      </span>
                    )}
                    {row.warning && (
                      <span
                        title={row.warning}
                        className="shrink-0 rounded-full border border-[var(--warning)]/30 bg-[var(--warning)]/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-[var(--warning)]"
                      >
                        {AUTO_BRACKET_STAMP}
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <FieldBadge label={row.broker === "tradovate" ? "TRADOVATE" : "TOPSTEP"} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* Under the table rather than in the row: the row is dimmed as refused,
          and a live control inside a dimmed row reads as disabled. */}
      {move &&
        rows
          .filter((row) => row.replacements.length > 0)
          .map((row) => (
            <p
              key={row.id}
              className="flex flex-wrap items-center gap-2 border-t border-[var(--card-border)] px-3 py-2 text-[11px] text-[var(--muted)]"
            >
              <span className="font-mono tabular text-[var(--foreground)]">{accountLabel(row.name)}</span>
              <MoveToReplacement
                token={move.token}
                fromAccountId={row.id}
                replacements={row.replacements}
                onMoved={move.onMoved}
              />
            </p>
          ))}
    </div>
  );
}

interface ConflictAnswer {
  accountId: number;
  blocking: BlockingDeployment[];
  nonBlocking: SameContractDeployment[];
}

/**
 * The server's own slot answer for the chosen account: `blocking` is this
 * playbook already holding the slot, `nonBlocking` another playbook on the
 * same contract over the same hours. Keyed on the account it answered for, so
 * a fast second pick cannot render the first pick's answer under it. A read
 * that fails settles as *no holder and no neighbour*: the route re-checks the
 * slot at the press and its 409 renders verbatim, so the advisory half never
 * blocks — and the same-contract warning was never a gate to begin with.
 */
function useConflictCheck(
  token: string | null,
  accountId: number | null,
  ticker: TickerSymbol,
  strategyKey: string,
): ConflictAnswer | null {
  const [answer, setAnswer] = useState<ConflictAnswer | null>(null);
  useEffect(() => {
    if (!token || accountId == null) return;
    let live = true;
    void (async () => {
      let blocking: BlockingDeployment[] = [];
      let nonBlocking: SameContractDeployment[] = [];
      try {
        const res = await fetch("/api/deployments/conflict-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountIds: [accountId], ticker, strategyKey }),
        });
        if (res.ok) {
          const body = (await res.json()) as {
            blocking?: BlockingDeployment[];
            nonBlocking?: SameContractDeployment[];
          };
          if (Array.isArray(body.blocking)) blocking = body.blocking;
          if (Array.isArray(body.nonBlocking)) nonBlocking = body.nonBlocking;
        }
      } catch {
        // Settles as no holder; see above.
      }
      if (live) setAnswer({ accountId, blocking, nonBlocking });
    })();
    return () => {
      live = false;
    };
  }, [token, accountId, ticker, strategyKey]);
  return answer;
}
