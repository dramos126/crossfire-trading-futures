"use client";

import { useEffect, useMemo, useState } from "react";
import type { BoardDeployment } from "@/components/board/board-model";
import {
  collectUnmanagedProbes,
  mergeUnmanagedClaims,
  nowNyMinutes,
  unmanagedBackoffMs,
  UNMANAGED_PROBE_MS,
  type UnmanagedPosition,
} from "@/components/board/board-view";
import {
  fetchManualPositionPreview,
  type ManualPositionPreview,
} from "@/lib/trading/activation-prompts";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";

/**
 * Positions the engine does not manage, per account, rendered only when
 * there is something to act on — the same behaviour `SystemWarningBar` has.
 *
 * **It reads `ManualPositionGuard.previewClaim` through
 * `POST /api/deployments/manual-position-preflight`, and never diffs broker
 * positions against deployments client-side.** That shortcut is named in
 * [deployments.md](../../docs/modules/trading/deployments.md) with the
 * failure it produces: *"A preview computed from a parallel reading of the
 * rule can be wrong in the one way that matters: telling the operator
 * nothing will be closed and then closing something."* The preview runs the
 * same root extraction and the same expected-flat operand as one pass of the
 * sweep, because it is the sweep's own object answering.
 *
 * **It probes armed legs only, and that is a scope decision rather than an
 * optimisation.** `previewClaim` answers a hypothetical — *what would be
 * closed if this deployment were Active* — so probing a paused leg would
 * list a hand position under a heading that says the engine is about to take
 * it, which is exactly the false promise this section exists to avoid.
 * `armed` is the engine's own entry gate, so for an armed leg the preview is
 * not a hypothetical: it is the next sweep. **The residual is stated rather
 * than papered over**: a hand position on an account whose deployments are
 * all paused does not appear here, which is the same carve-out the rule itself
 * makes.
 *
 * **`armed` alone is not the scope, though, and the gap is the same one the
 * leg's dot has.** It mirrors `isLegEngineEnabled`, which does not consult
 * the live-account block — that narrowing happens in
 * `listManagedDeployments()`, one layer out — and the preflight route does
 * not screen accounts either. So an armed leg on a live funded account
 * rendered **"Closes 09:30"** over a hand position the engine is never going
 * to be handed, which is a promise on a safety strip. `autoTradeRefused` is
 * the same field `legPulse` reads and for the same reason.
 *
 * **A probe costs the broker nothing while the engine's account view is
 * fresh** — `previewClaim` reads it, and a stale view is one live search per
 * account shared by every probe (A115). **The sweep is still rate-limited
 * four ways**, for the server work and that fallback read: it was written
 * when every probe was a live search, twelve every 15s from one tab across
 * three grouped deployments on four accounts. A hidden tab
 * does not probe at all; a sweep in which every probe failed backs the next
 * one off (`unmanagedBackoffMs`); no sweep starts while one is still out;
 * and no sweep starts inside one cadence window of the last one. The last
 * two are what make the fourth gate safe — a tab coming back to the
 * foreground sweeps immediately rather than waiting out an interval it slept
 * through, so what the operator looks at is current, and without a floor
 * that is ten alt-tabs in five seconds becoming 120 concurrent probes.
 */

export function BoardUnmanagedPositions({ board }: { board: readonly BoardDeployment[] }) {
  const { token } = useTrading();
  const { accountLabel } = useDisplayPrivacy();
  const [rows, setRows] = useState<UnmanagedPosition[]>([]);

  const probes = useMemo(() => collectUnmanagedProbes(board), [board]);
  // The effect re-arms on the *content* of the probe set rather than on the
  // array identity, so a P&L tick that rebuilds the board does not restart
  // the interval and re-fire every probe.
  //
  // **The whole claim is in the key, not just the leg id.** `paramValues`
  // carries the pause windows, so an edit that carves a pause out of the
  // playbook's session keeps the same ids — the effect held a stale closure
  // and went on reporting the old timing on the row that says when a hand
  // position gets closed.
  const probeKey = probes.map((p) => `${p.legId}:${JSON.stringify(p.target)}`).join("|");

  useEffect(() => {
    if (!token || probes.length === 0) {
      setRows([]);
      return;
    }
    let cancelled = false;
    let failedSweeps = 0;
    let nextAllowedAt = 0;
    let inFlight = false;
    // **What each probe last managed to say.** A probe that cannot answer
    // this sweep contributes what it found last time rather than deleting
    // rows nothing has contradicted — the rule is `mergeUnmanagedClaims`',
    // and this is where it is remembered. Scoped to the effect, and
    // `probeKey` remounts the effect whenever the probe set or any claim in
    // it changes, so there is nothing here to prune. **The carry-forward has
    // no expiry, deliberately**: a probe that never answers again holds its
    // row until then, which is the same residual a sweep backed off to four
    // minutes already carries, and the safer of the two directions on a strip
    // whose subject is an unmanaged position.
    const lastAnswer = new Map<string, ManualPositionPreview>();

    async function sweep() {
      inFlight = true;
      // The cadence floor, taken at the *start* of the sweep: one probe per
      // armed leg is expensive enough that ten alt-tabs in five seconds must
      // not be ten sweeps. A total failure overwrites this with its longer
      // backoff below.
      // A hair under the interval, so the interval's own tick is never the
      // one this gate refuses. The floor exists for `visibilitychange`, which
      // has no cadence of its own; without the margin its correctness rests
      // on this stamp landing microseconds before `setInterval` registers,
      // and on `Date.now()` not being coarsened between the two readings.
      nextAllowedAt = Date.now() + UNMANAGED_PROBE_MS - 500;
      try {
        const answers = await Promise.all(
          probes.map(async (probe) => {
            const preview = await fetchManualPositionPreview(probe.target).catch(() => null);
            return { probe, preview };
          }),
        );
        if (cancelled) return;

        // **A sweep that learned nothing changes nothing**, and backs the
        // next one off. Writing `[]` from it would clear the strip on no
        // information, and re-firing at full width is what turns a 429 into a
        // stampede against the session the engine is also using. The rows
        // survive by the same carry-forward the partial case uses; this arm
        // exists for the backoff and for not recomputing a merge that cannot
        // have changed.
        if (answers.every((a) => a.preview == null)) {
          failedSweeps += 1;
          nextAllowedAt = Date.now() + unmanagedBackoffMs(failedSweeps);
          return;
        }
        failedSweeps = 0;

        for (const { probe, preview } of answers) {
          if (preview) lastAnswer.set(probe.legId, preview);
        }

        // The fold, the dedupe and the per-probe fallback are all in
        // `mergeUnmanagedClaims` — every one of them renders a sentence about
        // a position nobody is managing, which is why they are testable and
        // this effect is only a schedule. One clock reading for the whole
        // merge.
        setRows(mergeUnmanagedClaims({ answers, lastAnswer, now: nowNyMinutes() }));
      } finally {
        inFlight = false;
      }
    }

    /** One scheduled attempt. Every gate lives here so the interval, the
     *  first run and the focus run cannot disagree about them. */
    function tick() {
      if (cancelled) return;
      // A background tab is not being looked at, so its probes buy nothing
      // and are indistinguishable at the broker from the ones that do.
      if (document.visibilityState !== "visible") return;
      // `sweep()` is fire-and-forget, so nothing else stops two from
      // overlapping — and on a slow broker the interval alone is enough to
      // do it. Twelve probes still out is not a reason to send twelve more.
      if (inFlight) return;
      // The backoff after a failed sweep, and the cadence floor after any
      // sweep. Without the floor, `visibilitychange` had no minimum interval
      // at all: ten alt-tabs in five seconds was ten sweeps, because
      // `nextAllowedAt` is 0 on the happy path.
      if (Date.now() < nextAllowedAt) return;
      void sweep();
    }

    tick();
    const id = setInterval(tick, UNMANAGED_PROBE_MS);
    // Coming back to the tab sweeps now rather than up to 15s from now — a
    // strip the operator is reading should be current, and the backoff gate
    // inside `tick` still applies, because focus is not a reason for the
    // broker to accept a request it was refusing.
    const onVisibility = () => tick();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, probeKey]);

  if (rows.length === 0) return null;

  return (
    <section
      className="overflow-hidden rounded-lg border border-[var(--warning)]/40 bg-[var(--card)]"
      aria-label="Unmanaged positions"
    >
      <header className="flex items-center gap-2 px-4 py-2 border-b border-[var(--card-border)] border-l-[3px] border-l-[var(--warning)]">
        <h2 className="text-[10px] uppercase tracking-wider text-[var(--warning)] font-medium">
          Unmanaged positions
        </h2>
        <span className="text-[11px] text-[var(--muted)]">
          Open on an instrument a running deployment claims, and not opened by the engine. It
          closes these when it sweeps.
        </span>
      </header>

      {/* Striped over the flat row list. The rows are already sorted by
          account, so grouping bought nothing but a zebra that restarted at
          every account boundary — two adjacent rows in the same band, which
          is the banding rule failing at exactly the place it is read. The
          account is the row's first column and the key. */}
      {rows.map((pos, i) => (
        <div
          key={`${pos.accountId}:${pos.contractId}`}
          className={`flex items-center gap-3 px-4 py-1.5 ${
            i % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]"
          }`}
        >
          <span
            className="font-mono text-xs text-[var(--foreground)] w-40 shrink-0 truncate"
            title={accountLabel(pos.accountName)}
          >
            {accountLabel(pos.accountName)}
          </span>
          <span className="font-mono text-xs text-[var(--muted)] shrink-0">{pos.contractId}</span>
          <span
            className={`tabular font-mono text-xs shrink-0 ${
              pos.side === "LONG" ? "text-[var(--success)]" : "text-[var(--danger)]"
            }`}
          >
            {pos.side} {pos.size}
          </span>
          <span
            className="text-[10px] uppercase tracking-wider text-[var(--warning)] ml-auto shrink-0"
            title={
              pos.inWindow
                ? "A deployment on this instrument is inside its session window, so the engine closes this on its next sweep and cancels its working orders."
                : pos.whenNy
                  ? `The engine closes this at ${pos.whenNy} New York time, when a deployment on this instrument opens its session window, and cancels its working orders.`
                  : "The engine closes this when a deployment on this instrument opens its session window."
            }
          >
            {pos.inWindow
              ? "Closes next sweep"
              : pos.whenNy
                ? `Closes ${pos.whenNy}`
                : "Closes at session open"}
          </span>
        </div>
      ))}
    </section>
  );
}
