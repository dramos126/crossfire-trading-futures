"use client";

import { useEffect, useState } from "react";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

interface PendingRow {
  id: string;
  name: string | null;
  strategyKey: string;
  accountId: number;
  ticker: string;
  reason: string | null;
}

interface MigrationStatus {
  blocked: string[];
  pendingReconciliation: PendingRow[];
}

/**
 * Boot's session-migration results, on the Dashboard board. Clean rows that
 * were disabled and flagged, plus position-holding rows that could not be
 * migrated. One click target collapses the noise.
 *
 * **It is the only surface for this data.** It moved here on 2026-09-03 when
 * the Deployments page came down — it was not on that phase's deletion list,
 * and deleting it would have meant the operator never learns boot turned
 * something off. The docstring used to promise "per-row badges rendered
 * separately by the row component"; **no such badge has ever existed**
 * (`pendingReconciliation` appears in no other component), and the board has
 * no migration marker either, so anything this banner does not name is
 * unfindable in the UI. That is why the blocked list is enumerated rather
 * than only counted.
 */
export function SessionMigrationBanner() {
  const { token } = useTrading();
  const { accountLabel, text } = useDisplayPrivacy();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!token) return;
    void fetch("/api/deployments/migration-status")
      .then((r) => r.json())
      .then((j: MigrationStatus | null) => {
        if (!j) return;
        setStatus({
          blocked: Array.isArray(j.blocked) ? j.blocked : [],
          pendingReconciliation: Array.isArray(j.pendingReconciliation) ? j.pendingReconciliation : [],
        });
      })
      .catch(() => { /* network drop — leave hidden */ });
  }, [token]);

  if (!status) return null;
  const total = status.blocked.length + status.pendingReconciliation.length;
  if (total === 0) return null;

  return (
    <div
      role="alert"
      // Row-level amber throughout. `--amber-*` is the page-level env chrome
      // and is not interchangeable with `--warning`; mixing them painted a
      // deployment-scoped message in the staging banner's palette a few
      // pixels below the staging banner. No `mb-4` — the board's container
      // supplies the gap.
      className="rounded-md border-l-[3px] border-[var(--warning)] bg-[var(--warning)]/10 text-[var(--warning)] px-3 py-2"
    >
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold uppercase tracking-wider">
          Session migration
        </span>
        <p className="flex-1 text-xs leading-snug">
          {total} deployment{total === 1 ? "" : "s"} need session config review after the migration.
          {/* **Not "hold an open position" — a blocked leg may be flat.**
              The session config lives on the parent and is shared, so one leg
              holding a position blocks every leg of that deployment. Saying
              otherwise sends the operator to an account that is flat with
              nothing to reconcile. Same sentence as the boot log line. */}
          {status.blocked.length > 0 && (
            <>
              {" "}
              {status.blocked.length} can&apos;t be migrated yet — an open position on the
              deployment, on this account or another.
            </>
          )}
        </p>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs underline"
        >
          {expanded ? "Hide" : "View"}
        </button>
      </div>
      {expanded && (
        <ul className="mt-2 space-y-1 text-xs font-mono">
          {status.pendingReconciliation.map((p) => (
            <li key={p.id} className="flex justify-between gap-3">
              <span className="truncate">{text(p.name ?? p.strategyKey)}</span>
              <span className="text-[var(--warning)]/70">
                {p.ticker} · acct {accountLabel(p.accountId)}
              </span>
            </li>
          ))}
          {/* Counted in the sentence above and, until 2026-09-03, listed
              nowhere — the operator could scan the old Active tab for them
              and the board has no migration marker. An id is thin, but it is
              what the route returns and it beats an unidentifiable count. */}
          {status.blocked.map((id) => (
            <li key={id} className="flex justify-between gap-3">
              <span className="truncate">{id}</span>
              <span className="text-[var(--warning)]/70">position open on this deployment</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
