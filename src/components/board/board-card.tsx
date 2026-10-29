"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Chevron, DrillInArrow } from "@/components/chevron";
import { IntentBadges } from "@/components/intent-badges";
import { PulseDot } from "@/components/pulse-dot";
import {
  DEPLOYMENT_STATUS_LABELS_COMPACT,
  statusToneClass,
} from "@/components/deployment/deployment-status";
import {
  cardEditIntent,
  cardToggleIntent,
  describeMissingLegMoney,
  describeMissingMoney,
  describeMissingUnrealized,
  formatUsd,
  legPulse,
  legToggleIntent,
  maskRiskBalance,
  pnlToneClass,
  toForceFlatResult,
  TOTAL_UNPRICED,
  type ToggleIntent,
} from "@/components/board/board-view";
import { maskUsdFigures } from "@/components/privacy/privacy-model";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import type {
  BoardAccountStatus,
  BoardDeployment,
  BoardLeg,
  BoardLegRisk,
} from "@/components/board/board-model";
import { ACCOUNT_STATE_DANGER_STAMP } from "@/components/book/book-controls";
import { DetachedRecovery, resyncEngine } from "@/components/board/detached-recovery";
import { confirmActivationUnderD2 } from "@/lib/trading/activation-prompts";
import { loadDeployments, refreshDeployments, useDeployments } from "@/lib/hooks/use-strategies";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { BOOK_DERIVED_ROW_REFUSAL, TIMEFRAME_LABELS } from "@/lib/trading/domain";
import type { ForceFlatResult } from "@/lib/trading/engine/flatten/engine-force-flat";

/**
 * One card on the Dashboard board: a **book** with one row per armed
 * playbook, or a hand-made deployment with one row per leg.
 *
 * **Which one it is comes off `bookId` and nothing else.** A book card's
 * header is its identity — the account — so it carries no stamp, it is
 * the surface that names the account and therefore the surface that states the
 * budget, and its rows name playbooks rather than accounts. A hand-made card
 * is unchanged in every one of those: `GRP` when its legs fan across accounts,
 * the risk cell on the row that names each account, no header figure.
 *
 * **It renders `BoardDeployment` and reads no `Deployment` or
 * `DeploymentGroup`.** Everything the three header controls act on — which
 * lifecycle surface, which direction the switch is in, where the ✎ points —
 * is a field, because the alternatives are `legs.length > 1` (wrong for a
 * one-leg group) and reaching past the adapter to a raw row.
 *
 * **The row leads with arming, not with P&L.** On a quiet morning every leg
 * has zero trades and that empty card is the correct state: the chip and the
 * pulse are the primary tier, and the money is a column to their right. A
 * card that led with a number would make a healthy board look broken every
 * morning before the first entry.
 *
 * **The controls the routes refuse are inert rather than live, on a book card
 * and on a derived row alike.** The `✕` and **both** `⏸` carry
 * `BOOK_DERIVED_ROW_REFUSAL` in their `title`, disabled — the two toggles
 * through `cardToggleIntent` / `legToggleIntent` and the `✎` through
 * `cardEditIntent`, so nothing here composes a refusal in JSX.
 *
 * **A detached row states why in words and carries the way back.** It is the
 * one row state with no other exit — a plain resume does not clear the
 * markers — so the row grows a band under it with the reason and a labelled
 * `Restore and arm`, which is this codebase's only caller of
 * `POST /api/deployments/[id]/clear-orphan` — **inert while the row is still
 * closing**, through `detachedRestoreRefusal`, for the reason the two toggles
 * are. See `DetachedRecovery`, which the drill-in renders too.
 */

const ARM_MS = 4000;

/** The em-dash, with its reason. Never `$0.00` — a plausible zero on the
 *  field that says how much you are up or down is the same defect as a
 *  plausible `1` on the field that says how much is at risk. */
function NoReading({ reason }: { reason: string }) {
  return (
    <span className="text-[var(--muted)] cursor-help" title={reason}>
      —
    </span>
  );
}

// ── The action glyphs ───────────────────────────────────────────────────

const GLYPH_BUTTON =
  "w-7 h-7 flex items-center justify-center rounded-md text-sm opacity-50 hover:opacity-100 transition shrink-0 disabled:opacity-30 disabled:cursor-not-allowed";

/**
 * The ⏸/▶, over whichever surface its caller's `intent` was built from.
 *
 * **The glyph states the switch's position, and an inert control still has
 * one.** `intent.kind === "pause"` is false on every inert arm, so reading the
 * glyph off it alone renders ▶ over a *running* deployment whose controls are
 * refused — a greyed play button that says paused about a row taking entries.
 * `switchOn` is the position and the intent is what may be done about it; the
 * two are separate for the same reason `switchOn` and `armed` are.
 */
function ToggleGlyph({
  intent,
  switchOn,
  busy,
  onPress,
  what,
}: {
  intent: ToggleIntent;
  /** The switch position of the surface this toggle addresses — the card's
   *  `switchOn`, or a leg's `status === "Active"`. */
  switchOn: boolean;
  busy: boolean;
  onPress: () => void;
  /** "this deployment" / "this leg" — the tooltip's object. */
  what: string;
}) {
  const inert = intent.kind === "inert";
  const on = inert ? switchOn : intent.kind === "pause";
  const label = inert ? `Cannot switch ${what}` : on ? `Pause ${what}` : `Resume ${what}`;
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={busy || inert}
      title={inert ? intent.reason : label}
      aria-label={label}
      className={`${GLYPH_BUTTON} hover:bg-[var(--hover)] ${
        inert
          ? "text-[var(--muted)]"
          : on
            ? "text-[var(--warning)]"
            : "text-[var(--success)]"
      }`}
    >
      <span aria-hidden>{on ? "⏸" : "▶"}</span>
    </button>
  );
}

/** Two-step armed confirm — the pattern the ✕ glyph already uses, and the
 *  one the design language prefers wherever it and hold-to-confirm both
 *  exist. The global FlattenAll keeps its hold gesture so the panic button
 *  stays visually distinct from the routine one.
 *
 *  **`inertReason` disables it with the refusal in the `title`**, the arm
 *  `ToggleGlyph` already had and this one did not. It stays visible rather
 *  than hidden, for the reason the inert ✎ does: a hidden control is a third
 *  state the operator has to explain. A refusal the operator only meets after
 *  pressing is worse than one they cannot press at all, and every route behind
 *  these glyphs that can refuse does so with a sentence. */
function ArmedGlyph({
  glyph,
  armed,
  busy,
  onPress,
  idleTitle,
  armedTitle,
  label,
  inertReason = null,
}: {
  glyph: string;
  armed: boolean;
  busy: boolean;
  onPress: () => void;
  idleTitle: string;
  armedTitle: string;
  label: string;
  inertReason?: string | null;
}) {
  const inert = inertReason != null;
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={busy || inert}
      title={inert ? inertReason : armed ? armedTitle : idleTitle}
      aria-label={inert ? `Cannot ${label.toLowerCase()}` : label}
      className={`${GLYPH_BUTTON} ${
        inert
          ? "text-[var(--muted)]"
          : armed
            ? "bg-[var(--danger)]/30 text-[var(--danger)] ring-1 ring-[var(--danger)] opacity-100"
            : "text-[var(--danger)] hover:bg-[var(--danger)]/15"
      }`}
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}

// ── What a flatten did ──────────────────────────────────────────────────

/** Terminate a fragment without double-punctuating one that already ends —
 *  a broker's own error body can arrive with its own full stop. */
function sentenceEnd(s: string): string {
  const trimmed = s.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The result line under a leg row.
 *
 * **It renders from `positionMayStillBeOpen`, never from
 * `status === "error"`.** Two of the four statuses leave the position
 * possibly open, so a surface branching on the string shows a stood-down
 * flatten as a completed close.
 *
 * **A self-deferral says plainly that nothing retries it.** `force_flat` is
 * the one flatten actor with no interval behind it, so deferring to its own
 * stamp means the operator has to press again — the other four are finishing
 * the close on their own schedule and the sentence for them is different.
 */
function FlattenOutcome({ result, remainingMs }: { result: ForceFlatResult; remainingMs: number | null }) {
  const open = result.positionMayStillBeOpen === true;
  const seconds = remainingMs == null ? null : Math.max(0, Math.ceil(remainingMs / 1000));

  let sentence: string;
  if (result.status === "closed") {
    sentence = `Closing order sent${result.size != null ? ` for ${result.size}` : ""} — flat is confirmed when the fill lands.`;
  } else if (result.status === "already_flat") {
    sentence = "Nothing to close — the broker holds no position on this contract.";
  } else if (result.status === "deferred" && result.deferredTo === "force_flat") {
    sentence =
      seconds != null && seconds > 0
        ? `Stood down — your last flatten on this contract may not be booked yet. Nothing retries it; press again in ${seconds}s.`
        : "Stood down — your last flatten on this contract may not be booked yet. Nothing retries it; press again now.";
  } else if (result.status === "deferred") {
    sentence = "Stood down — the engine is already closing this contract.";
  } else {
    // The reason is a lowercase fragment — the primitive's are, and both of
    // the route's engine-down arms were written to match. It is punctuated
    // here because the clauses appended below need a sentence to follow.
    sentence = result.reason ? `Nothing was closed: ${sentenceEnd(result.reason)}` : "Nothing was closed.";
  }

  return (
    <div
      className={`px-4 py-1.5 text-[11px] leading-snug border-t border-[var(--card-border)] ${
        open
          ? "bg-[var(--danger)]/10 text-[var(--danger)]"
          : "bg-[var(--bg)] text-[var(--muted)]"
      }`}
      role="status"
    >
      {sentence}
      {open && " The position may still be open."}
      {result.workingOrdersMayRemain === true &&
        " A protective order may still be resting on this contract — check it at the broker."}
      {result.exitInFlight === true &&
        " The engine had an exit in flight on this leg, so expect a doubled fill count."}
    </div>
  );
}

// ── The leg row ─────────────────────────────────────────────────────────

// The phone row's second line starts under the name: the ▸ (1rem), the
// contract on a book card (2rem), the dot (0.375rem) and the gaps between them
// (0.5rem each). Literal so Tailwind generates them.
const PHONE_INDENT_BOOK = "ml-[4.875rem] sm:ml-0";
const PHONE_INDENT_HAND_MADE = "ml-[2.375rem] sm:ml-0";

/**
 * One row: a leg on a hand-made card, one armed playbook on a book card.
 *
 * **The two differ in what the row names and in nothing else.** A book card
 * spans one account and its header names it, so the row's first column is the
 * playbook and the risk cell is not on it — the model answers `leg.risk` null
 * there, so this renders the decision rather than making it. Everything else
 * is the same row: the chip, the dot through `legPulse`, session money, the
 * log link, the leg's own ⏸ and its flatten.
 */
function LegRow({
  leg,
  bookId,
  rowIndex,
  onMutated,
}: {
  leg: BoardLeg;
  /** The **card's** `bookId`, not the leg's — the pointer is the parent's, and
   *  `PATCH /api/deployments/[id]` refuses a status write on any leg of a
   *  derived row. `legToggleIntent` is what turns it into the glyph's state,
   *  and it is also what says this row names a playbook. */
  bookId: string | null;
  rowIndex: number;
  onMutated: () => void;
}) {
  const { token, practiceOnly } = useTrading();
  const { accountLabel, text, hideBalances } = useDisplayPrivacy();
  const { toggleDeployment } = useDeployments();
  const [pauseBusy, setPauseBusy] = useState(false);
  const [flattenBusy, setFlattenBusy] = useState(false);
  const [flattenArmed, setFlattenArmed] = useState(false);
  const [outcome, setOutcome] = useState<ForceFlatResult | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  // The deferral countdown. A `deferred` result carries `retryAfterMs` so the
  // surface renders a clock rather than parsing one back out of the reason.
  //
  // **The dependency is whether a countdown is running, not the value.**
  // Depending on `remainingMs` made the effect its own trigger: every tick
  // set the state the effect read, so React tore the interval down and built
  // a new one a thousand times a countdown, and each second was measured
  // from the moment of the previous render rather than from the deferral.
  const counting = remainingMs != null && remainingMs > 0;
  useEffect(() => {
    if (!counting) return;
    const id = setInterval(() => {
      setRemainingMs((prev) => (prev == null ? null : Math.max(0, prev - 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [counting]);

  const intent = legToggleIntent(leg, bookId);
  const pulse = legPulse(leg);
  const missingMoney = describeMissingLegMoney(leg);
  // What this row is about: the playbook on its contract on a book card, the
  // account on a hand-made one. One name, used by the tooltip and the link's
  // label together, so the row cannot announce one thing and show another —
  // and two rows of one playbook on two contracts do not announce alike.
  const book = bookId != null;
  const subject = book ? `${leg.playbookName} on ${leg.contract}` : accountLabel(leg.accountName);

  /** A flatten result describes one press against one position. Pausing,
   *  resuming or flattening again makes it a statement about a state that no
   *  longer exists — it used to sit under the row through both, so a
   *  "position may still be open" warning outlived the close that answered
   *  it. */
  function clearOutcome() {
    setOutcome(null);
    setRemainingMs(null);
  }

  async function handleToggle() {
    if (pauseBusy || intent.kind === "inert") return;
    setError(null);
    clearOutcome();
    // Resume is an activation and owes the two activation prompts. Declining either
    // means the leg does not activate.
    if (intent.kind === "resume") {
      const ok = await confirmActivationUnderD2(leg.claim);
      if (!ok) return;
    }
    setPauseBusy(true);
    try {
      await toggleDeployment(leg.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch this leg.");
      return;
    } finally {
      setPauseBusy(false);
    }
    // `toggleDeployment` writes the module snapshot with the server's row
    // before it resolves, so the cache is current here. Read it at the call
    // site rather than inside the resync, so that dependency is visible.
    await resyncEngine(token, practiceOnly, loadDeployments());
    onMutated();
  }

  async function handleFlatten() {
    if (flattenBusy) return;
    if (!flattenArmed) {
      setFlattenArmed(true);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setFlattenArmed(false), ARM_MS);
      return;
    }
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setFlattenArmed(false);
    setFlattenBusy(true);
    setError(null);
    clearOutcome();
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(leg.id)}/flatten`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(`The flatten request failed (${res.status}). The position may still be open.`);
        return;
      }
      // Narrowed, not asserted. An `as` evaporates at runtime, so a body
      // without `result` left `outcome` undefined, the arm state cleared and
      // the error reset: the operator pressed flatten on an open position
      // and got a blank row back. Every shape that does not parse is the
      // same fact as a failed request — nobody can say what happened, and
      // the position may still be open.
      const result = toForceFlatResult(await res.json().catch(() => null));
      if (!result) {
        setError(
          "The server's answer to the flatten could not be read. The position may still be open — check it at the broker.",
        );
        return;
      }
      setOutcome(result);
      setRemainingMs(result.retryAfterMs ?? null);
    } catch {
      setError("The flatten request never reached the server. The position may still be open.");
    } finally {
      setFlattenBusy(false);
    }
  }

  const zebra = rowIndex % 2 === 0 ? "bg-[var(--bg-row)]" : "bg-[var(--bg-row-alt)]";

  return (
    <div className="border-t border-[var(--card-border)] first:border-t-0">
      {/* Below `sm` the row is two lines — the name wraps on the first, the
          chip, money and ⏸ ▼ sit on the second — so `items-end` puts the glyphs
          on the second line; every phone class has an `sm:` partner restoring
          the single fixed-column line. */}
      <div className={`flex items-end sm:items-center gap-2 px-3 py-1.5 ${zebra}`}>
        {/* The ▸ is a link to the drill-in, not an expand. The route resolves
            a leg id to its deployment and preselects this account, so the row
            keeps meaning what it meant — one deployment's history is one URL
            rather than N expands, and browser-back works. */}
        <Link
          href={`/deployments/${encodeURIComponent(leg.id)}`}
          className="group flex flex-wrap sm:flex-nowrap items-center gap-x-2 gap-y-1 text-left flex-1 min-w-0"
          aria-label={`Open ${subject}'s history and stats`}
        >
          {/* Not a <Chevron>: this row navigates rather than expanding, and a
              collapsed disclosure chevron is the same shape as a static
              right-pointing one. */}
          <span className="text-[var(--muted)] group-hover:text-[var(--accent)] transition-colors inline-flex items-center shrink-0">
            <DrillInArrow />
          </span>

          {/* What the row is — the account on a hand-made card, the contract
              and the playbook on a book card. Monospace at a fixed width
              either way, so the column aligns across rows and across cards. */}
          {book && (
            <span className="font-mono tabular text-[11px] text-[var(--muted)] w-8 shrink-0">
              {leg.contract}
            </span>
          )}
          {/* The pulse sits before the name (2026-10-12, the operator's ask),
              so it reads down the left edge rather than floating after a chip.
              It keeps running while a row is closing: fill says what, pulse
              says in-flight. A closing row is never greyed — grey is what
              `paused` and `flat` render as, and it would assert settled over a
              position that may still be open. **Green is a claim that the
              engine will take an entry here**, which is why the tone comes
              from `legPulse` and not from `armed`: `armed` does not consult
              the live-account block, so a refused leg pulsed green beside its
              own red chip. */}
          <PulseDot
            active={pulse !== "idle"}
            color={pulse === "running" ? "bg-[var(--success)]" : "bg-[var(--warning)]"}
          />
          {/* On a phone the name takes the rest of the line and wraps rather
              than truncating — it is what the operator reads there. */}
          <span
            className="font-mono text-xs text-[var(--foreground)] flex-1 min-w-0 break-words sm:flex-none sm:w-40 md:w-72 sm:shrink-0 sm:truncate"
            title={subject}
          >
            {book ? leg.playbookName : subject}
          </span>
          <span aria-hidden className="basis-full h-0 sm:hidden" />

          {/* The arming tier. `title` carries the refusal verbatim on the
              `no-auto-trade` rung — same sentence the API, the engine log and
              the held-back notice use.

              **It no longer carries `orphanReason`.** That put a stored code
              (`account_unavailable_at_boot`) into a sentence slot, in a
              tooltip, as the only thing a detached row ever said about itself.
              The reason is rendered in words in the band below, on screen
              rather than behind a hover, and stating it twice on one row would
              be the repetition copy.md's per-set rule forbids. */}
          <span
            title={leg.chip.reason == null ? undefined : text(leg.chip.reason)}
            className={`text-xs sm:text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded-sm border shrink-0 sm:min-w-[4.5rem] text-center ${
              book ? PHONE_INDENT_BOOK : PHONE_INDENT_HAND_MADE
            } ${statusToneClass(leg.chip.tone)}`}
          >
            {DEPLOYMENT_STATUS_LABELS_COMPACT[leg.chip.kind]}
          </span>

          {/* Where the `×N` size cell and the `SL:…` cell were. Neither came
              back: a contract count is answered per entry, from the account's
              budget and this signal's stop, so an armed row that has not
              signalled has none to print. **What does print is the budget
              itself** — an account fact, on the one row that names an
              account, and the only figure here that is not this leg's own.
              See `BoardLeg.risk`: it is per entry, it is shared by every
              deployment on the account, and it is never folded onto the
              card. **Null on a book card's row**, whose header states it
              once for the one account the card spans — a playbook row does
              not name an account, and printing it here would say each
              playbook has a budget of its own. */}
          {leg.risk != null && <RiskCell risk={maskRiskBalance(leg.risk, hideBalances)} />}

          {/* Money last, right-aligned. The sub-meta R:/U: labels stay muted
              so the figures carry the tier. */}
          <span className="tabular font-mono text-xs ml-auto text-right shrink-0 inline-flex items-center gap-3">
            <LegMoney label="R" value={leg.sessionPnl?.realized ?? null} missing={missingMoney} />
            <LegMoney
              label="U"
              value={leg.sessionPnl?.unrealized ?? null}
              missing={describeMissingUnrealized(leg)}
            />
          </span>
        </Link>

        {/* Incidents start here, so this is the `/logs` entry point that will
            actually be taken — the rail's is the global fallback. The scope
            is the leg's own id because that is what the engine stamps on a
            line and what the viewer's `deployment` facet groups by. */}
        {/* Not on a phone: the row's log is a desk read. */}
        <span className="hidden sm:contents">
          <LegLogsLink legId={leg.id} subject={subject} />
        </span>
        {/* A leg's own switch, which is its status and not the card's — a leg
            inside a disabled group still has one to flip. */}
        <ToggleGlyph
          intent={intent}
          switchOn={leg.status === "Active"}
          busy={pauseBusy}
          onPress={handleToggle}
          what="this leg"
        />
        <ArmedGlyph
          glyph="▼"
          armed={flattenArmed}
          busy={flattenBusy}
          onPress={handleFlatten}
          label="Flatten this leg"
          idleTitle="Flatten this leg — closes its position at market"
          armedTitle="Click again to close this leg's position at market"
        />
      </div>

      {/* The recovery band, on the one row state that has no other way out.
          It is gated on `leg.detached` rather than on `chip.kind` — the field
          is the fact and the chip is a ladder over it, which is the reading
          `legPulse` and `cardToggleIntent` both make one rung up. */}
      {leg.detached && (
        <DetachedRecovery
          leg={leg}
          bookId={bookId}
          onPress={() => {
            setError(null);
            clearOutcome();
          }}
          onRestored={onMutated}
        />
      )}
      {error && (
        <div className="px-4 py-1.5 text-[11px] leading-snug border-t border-[var(--card-border)] bg-[var(--danger)]/10 text-[var(--danger)]">
          {text(error)}
        </div>
      )}
      {outcome && <FlattenOutcome result={outcome} remainingMs={remainingMs} />}
    </div>
  );
}

/** `?deployment=` — the row's log, not the whole stream. The label is the
 *  row's subject, so two rows of one book do not both announce as the log for
 *  the same account. */
function LegLogsLink({ legId, subject }: { legId: string; subject: string }) {
  return (
    <Link
      href={`/logs?deployment=${encodeURIComponent(legId)}`}
      title={`Engine log for ${subject}`}
      aria-label={`Engine log for ${subject}`}
      className={`${GLYPH_BUTTON} text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]`}
    >
      <span aria-hidden>☰</span>
    </Link>
  );
}

/**
 * What one entry on this account may lose today.
 *
 * **One component, two slots, because it is one figure.** It draws on the row
 * that names the account on a hand-made card, and in the header of a book
 * card, which *is* the row that names the account — one account, one number,
 * no arithmetic anywhere. It never draws in both places on one card, and there
 * is no card total, no strip total and no cell on a row that names a playbook.
 *
 * **Every arm of it is decided in `boardRisk`** — which word, which tone,
 * which blank — so this renders four branches and reasons about none of them.
 * The label is `Risk/trade`, Settings' *Risk per trade* in the space a
 * single-line row has for it, and it is on every arm including the blanks: a
 * bare `—` in a column nothing names is a bug report waiting to be filed.
 *
 * **The figure is monospace and tabular and the phase beside it is not.** The
 * budget is a changing number in a column that must not jitter; the phase is
 * a word, and at sub-meta weight so it cannot out-mass the figure it
 * qualifies.
 *
 * **Nothing in it hides below a breakpoint.** The chrome drops its env pill
 * and its notifications toggle on a phone because *what am I running* is a
 * desk question; *how much is at risk* is not one, and this is the monitoring
 * end of the split.
 */
function RiskCell({ risk, className = "" }: { risk: BoardLegRisk; className?: string }) {
  const label = <span className="text-[var(--muted)]">Risk/trade:</span>;
  const box = `text-[11px] shrink-0 inline-flex items-center gap-1.5 ${className}`;
  // The live-account block refuses this account, so nothing here will ever be
  // sized and the cell states nothing — the `No Auto-Trade` chip the row
  // already carries is where that is said. Decided in `buildBoard`; this
  // branch renders the decision and does not make it.
  if (risk.kind === "silent") return null;
  if (risk.kind === "pending") {
    return (
      <span className={box}>
        {label}
        <span className="font-mono tabular text-xs text-[var(--muted)]">…</span>
      </span>
    );
  }
  if (risk.kind === "unreadable") {
    return (
      <span className={`${box} cursor-help`} title={risk.detail}>
        {label}
        <span className="font-mono tabular text-xs text-[var(--muted)]">—</span>
      </span>
    );
  }
  if (risk.kind === "blocked") {
    return (
      <span className={`${box} cursor-help`} title={risk.detail}>
        {label}
        <span
          className={`text-[10px] uppercase tracking-wide px-1 py-0.5 rounded-sm border ${
            risk.tone === "danger"
              ? "bg-[var(--danger)]/15 text-[var(--danger)] border-[var(--danger)]/30"
              : "bg-[var(--warning)]/15 text-[var(--warning)] border-[var(--warning)]/30"
          }`}
        >
          {risk.note}
        </span>
      </span>
    );
  }
  return (
    <span className={`${box} cursor-help`} title={risk.detail}>
      {label}
      <span
        className={`font-mono tabular text-xs ${
          risk.tone === "warning" ? "text-[var(--warning)]" : "text-[var(--foreground)]"
        }`}
      >
        {risk.amount}
      </span>
      {risk.note != null && (
        <span
          className={
            risk.tone === "warning" ? "text-[var(--warning)]" : "text-[var(--muted-secondary)]"
          }
        >
          {risk.note}
        </span>
      )}
    </span>
  );
}

/**
 * The account's balance on a book card's meta line, under the account name, in
 * the budget's shape: a muted label, the figure monospace and tabular. `…` before the
 * first read lands and `—` with its sentence when there is none — never a
 * `$0.00` standing in for a figure nobody read. Every arm is decided in
 * `boardAccountStatus`.
 */
function BalanceCell({
  balance,
  className = "",
}: {
  balance: BoardAccountStatus["balance"];
  className?: string;
}) {
  const { usd, hideBalances } = useDisplayPrivacy();
  const box = `text-[11px] shrink-0 inline-flex items-center gap-1.5 ${className}`;
  const label = <span className="text-[var(--muted)]">Balance:</span>;
  if (balance.kind === "pending") {
    return (
      <span className={box}>
        {label}
        <span className="font-mono tabular text-xs text-[var(--muted)]">…</span>
      </span>
    );
  }
  // Titled, without the `cursor-help` `?` cursor (operator, 2026-10-21).
  if (balance.kind === "unknown") {
    return (
      <span className={box} title={balance.detail}>
        {label}
        <span className="font-mono tabular text-xs text-[var(--muted)]">—</span>
      </span>
    );
  }
  return (
    <span className={box} title={maskUsdFigures(balance.detail, hideBalances)}>
      {label}
      <span className="font-mono tabular text-xs text-[var(--foreground)]">{usd(balance.amount)}</span>
    </span>
  );
}

function LegMoney({
  label,
  value,
  missing,
}: {
  label: string;
  value: number | null;
  missing: string | null;
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[var(--muted)]">{label}:</span>
      {/* Fixed width, right-aligned, so R and U line up down the card
          whatever the figure's length. */}
      <span className="inline-block sm:w-[4.5rem] text-right">
        {value == null || missing != null ? (
          <NoReading reason={missing ?? "No reading for this leg."} />
        ) : (
          <span className={pnlToneClass(value)}>{formatUsd(value)}</span>
        )}
      </span>
    </span>
  );
}

// ── The phone's row list ────────────────────────────────────────────────

const HOLDING_CHIPS = new Set<BoardLeg["chip"]["kind"]>(["pending-entry", "in-position", "pending-exit"]);

/**
 * Whether a row leads the phone's list. The chip's holding rungs, plus a live
 * position under a rung that outranks `in-position` (a paused or detached row
 * still holding one) and a closing row, which `legPulse` reads as in flight.
 */
function holdsPosition(leg: BoardLeg): boolean {
  return HOLDING_CHIPS.has(leg.chip.kind) || leg.sessionPnl?.hasOpenPosition === true || legPulse(leg) === "closing";
}

/** The card's rows split for the phone, each half in the card's own order. A
 *  render-time partition: together the halves are exactly the desk's rows. */
export function partitionPhoneRows(legs: readonly BoardLeg[]): { open: BoardLeg[]; flat: BoardLeg[] } {
  const open: BoardLeg[] = [];
  const flat: BoardLeg[] = [];
  for (const leg of legs) (holdsPosition(leg) ? open : flat).push(leg);
  return { open, flat };
}

export const PHONE_FLAT_SHOW = "show";
export const PHONE_FLAT_HIDE = "hide";

/**
 * The phone's rows: the ones holding a position first and always shown, the
 * flat ones folded behind one line in the hidden-count idiom that opens them
 * in place. Below `sm` only; the desk list beside it keeps the card's order.
 */
function PhoneRows({
  legs,
  bookId,
  onMutated,
}: {
  legs: readonly BoardLeg[];
  bookId: string | null;
  onMutated: () => void;
}) {
  const [showFlat, setShowFlat] = useState(false);
  const { open, flat } = partitionPhoneRows(legs);
  return (
    <div data-board-rows="phone" className="sm:hidden overflow-hidden rounded-b-lg border-t border-[var(--card-border)]">
      {open.map((leg, i) => (
        <LegRow key={leg.id} leg={leg} bookId={bookId} rowIndex={i} onMutated={onMutated} />
      ))}
      {flat.length > 0 && (
        <button
          type="button"
          aria-expanded={showFlat}
          onClick={() => setShowFlat((v) => !v)}
          className="flex w-full items-center gap-1.5 px-3 py-2 border-t border-[var(--card-border)] first:border-t-0 font-mono tabular text-[11px] text-[var(--muted)] text-left"
        >
          <Chevron expanded={showFlat} className="shrink-0" />
          <span>
            {flat.length} flat · <span className="text-[var(--accent)]">{showFlat ? PHONE_FLAT_HIDE : PHONE_FLAT_SHOW}</span>
          </span>
        </button>
      )}
      {showFlat &&
        flat.map((leg, i) => (
          <LegRow key={leg.id} leg={leg} bookId={bookId} rowIndex={open.length + i} onMutated={onMutated} />
        ))}
    </div>
  );
}

/** The header's open count and session P&L, each with its em-dash. Rendered
 *  once per breakpoint slot; `display` is the slot's display class pair. */
function CardMoney({ card, display }: { card: BoardDeployment; display: string }) {
  const missingMoney = describeMissingMoney(card);
  return (
    <span className={`tabular font-mono text-xs ml-auto shrink-0 ${display} items-center gap-3`}>
      <span className="text-[10px] uppercase tracking-wider text-[var(--muted)]">
        {card.openPositionCount == null ? (
          <NoReading reason={missingMoney ?? "No reading for this deployment."} />
        ) : (
          `${card.openPositionCount} open`
        )}
      </span>
      {card.sessionPnl == null ? (
        <NoReading reason={missingMoney ?? "No reading for this deployment."} />
      ) : card.sessionPnl.total == null ? (
        <NoReading reason={TOTAL_UNPRICED} />
      ) : (
        <span className={pnlToneClass(card.sessionPnl.total)}>{formatUsd(card.sessionPnl.total)}</span>
      )}
    </span>
  );
}

// ── The card ────────────────────────────────────────────────────────────

/** A named interface rather than an inline literal, the shape `BookGridTable`
 *  and `MarketDataBlock` already take: `onMutated` is a client-to-client
 *  callback (`board.tsx` passes `refreshGroups`), never a server boundary. */
interface BoardCardProps {
  card: BoardDeployment;
  /** Re-read the group list — group writes bypass the deployment store. */
  onMutated: () => void;
  /** Whether the rows show. Absent draws them, with no chevron. */
  expanded?: boolean;
  onToggleExpanded?: (id: string) => void;
}

export function BoardCard({ card, onMutated, expanded, onToggleExpanded }: BoardCardProps) {
  const collapsible = expanded != null && onToggleExpanded != null;
  const open = !collapsible || expanded;
  const { token, practiceOnly } = useTrading();
  const { accountLabel, text, hideBalances } = useDisplayPrivacy();
  const { deleteDeployment, toggleDeployment } = useDeployments();
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
    };
  }, []);

  // A book's rows have their lifecycle written by the reconciler alone, and
  // all three of the routes behind these glyphs 409 with one sentence.
  // `cardToggleIntent` owns that arm for the ⏸ — both surfaces that render this
  // toggle read it from there — and the ✕ takes the same constant beside it,
  // because `ArmedGlyph` is a confirm rather than a switch and has no intent to
  // read. The ✎ is `cardEditIntent`'s, which carries the other sentence.
  const book = card.bookId != null;
  const intent = cardToggleIntent(card);
  const edit = cardEditIntent(card);
  // A book card's name is its account, so an account the catalogue no longer
  // holds reads `Account ?`; a hand-made card's name is the operator's own and
  // only an account named inside it is masked.
  const title = book ? accountLabel(card.name) : text(card.name);
  const timeframeLabel =
    card.timeframe != null
      ? TIMEFRAME_LABELS[card.timeframe as keyof typeof TIMEFRAME_LABELS] ?? card.timeframe
      : null;

  const toggle = useCallback(async () => {
    if (busy || intent.kind === "inert") return;
    setError(null);
    if (card.target.kind === "deployment") {
      // A `deployment` target is a leg whose parent row is gone, so it is one
      // leg and its resume is an activation — it owes the activation prompts
      // exactly as the leg's own ▶ does. Nothing else produces this target.
      if (intent.kind === "resume") {
        const ok = await confirmActivationUnderD2(card.legs[0].claim);
        if (!ok) return;
      }
      setBusy(true);
      try {
        await toggleDeployment(card.target.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not switch this deployment.");
        return;
      } finally {
        setBusy(false);
      }
      // Same as the leg toggle: the helper has already written the snapshot.
      await resyncEngine(token, practiceOnly, loadDeployments());
      onMutated();
      return;
    }

    // A group pauses through its own PATCH, which snapshots each leg's state
    // and restores it on resume. Fanning per-leg PATCHes across the legs
    // instead would drop the snapshot and desync `group.enabled`.
    //
    // Group enable is one of the three activation affordances the prompts
    // are documented as *not* covering: N legs across N instruments needs a
    // different prompt shape, and a loop over the one-deployment prompt is
    // named in deployments.md as the wrong fix. Enforcement is server-side
    // and unconditional either way.
    setBusy(true);
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(card.target.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !card.switchOn }),
      });
      if (!res.ok) {
        // Every refusal here is operator-actionable — a 403 carries the
        // auto-trade reason including the *recoverable* one, whose whole
        // value is the instruction it names.
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Could not update this deployment (${res.status}).`);
        return;
      }
    } catch {
      setError("The request never reached the server.");
      return;
    } finally {
      setBusy(false);
    }
    if (token) await refreshDeployments(token);
    onMutated();
  }, [busy, intent, card, token, practiceOnly, toggleDeployment, onMutated]);

  const destroy = useCallback(async () => {
    if (busy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      if (armTimerRef.current) clearTimeout(armTimerRef.current);
      armTimerRef.current = setTimeout(() => setDeleteArmed(false), ARM_MS);
      return;
    }
    if (armTimerRef.current) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setDeleteArmed(false);
    setBusy(true);
    setError(null);
    try {
      if (card.target.kind === "deployment") {
        const ok = await deleteDeployment(card.target.id);
        if (!ok) {
          setError("Delete failed.");
          return;
        }
      } else {
        const res = await fetch(`/api/groups/${encodeURIComponent(card.target.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error ?? `Delete failed (${res.status}).`);
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
      return;
    } finally {
      setBusy(false);
    }
    // Refresh first, and not because a delete is the only write that can flip
    // the fold to `"stop"` — pausing the last engine-managed row does that
    // too. The difference is what lands in the cache: `updateDeployment`
    // writes the server's own returned row before it resolves, while
    // `deleteDeployment` writes an *invented* one (`deletedAt` + `Paused`
    // stamped locally) and a group delete goes through raw `fetch` and writes
    // nothing at all. So this is the write whose snapshot cannot be trusted.
    if (token) await refreshDeployments(token);
    if (card.target.kind === "deployment") {
      await resyncEngine(token, practiceOnly, loadDeployments());
    }
    onMutated();
  }, [busy, deleteArmed, card, token, practiceOnly, deleteDeployment, onMutated]);

  return (
    // The rail is the arming signal, and `armed` is its input rather than
    // `switchOn`: a card whose switch is on but whose engine gate is shut is
    // not about to trade. Nothing else on the card dims — a closing row usually
    // holds an open position, which is the moment its numbers least want
    // fading, and a `no-auto-trade` card is armed on purpose, with its danger
    // chip carrying the refusal. It sits on the card, not the header, so it
    // follows the rounded corners whether the rows are folded or not.
    <article
      className={`rounded-lg border border-l-[3px] border-[var(--card-border)] bg-[var(--card)] ${
        card.armed ? "border-l-[var(--accent)]" : ""
      }`}
    >
      <header className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          {/* A book card's title is its identity — the account and the
              instrument — and that is why it carries no `BOOK` stamp: one
              beside it would be a second spelling of what the line already
              says. The account-state stamp below is a different fact. */}
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => onToggleExpanded(card.id)}
              className="-ml-1 flex min-w-0 items-center gap-1.5 rounded-sm px-1 hover:bg-[var(--hover)]"
            >
              <Chevron expanded={open} className="shrink-0 text-[var(--muted)]" />
              <h2 className="text-base font-semibold tracking-tight truncate" title={title}>
                {title}
              </h2>
            </button>
          ) : (
            <h2 className="text-base font-semibold tracking-tight truncate" title={title}>
              {title}
            </h2>
          )}
          {/* `GRP` still means *this deployment fans across accounts*, which a
              book never does: its rows are playbooks on one account. Same
              predicate as before on every hand-made card. */}
          {!book && card.legs.length > 1 && (
            <span
              className="text-[10px] font-mono uppercase tracking-wide px-1 py-0.5 rounded-sm border bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/30 shrink-0"
              title={`One deployment across ${card.legs.length} accounts`}
            >
              GRP
            </span>
          )}
          {/* The budget, on the one card header that names an account. Null on
              a hand-made card, whose legs each carry their own. */}
          {/* On a phone it moves to the header's third line, so the name has
              the width. */}
          {card.risk != null && (
            <span className="hidden sm:contents">
              <RiskCell risk={maskRiskBalance(card.risk, hideBalances)} className="ml-auto" />
            </span>
          )}
          <div className={`flex items-center gap-1 shrink-0 ml-auto ${card.risk == null ? "" : "sm:ml-0"}`}>
            {/* Inert, not hidden, and the sentence says which of the two it
                is: a card whose parent row is gone has no configuration left
                to edit, and a book card has one per row rather than one of its
                own. `cardEditIntent` picks; this renders.

                ✎ and ✕ are desk controls and do not render on a phone; the ⏸
                stays, because standing an account down is a safety action. */}
            <span className="hidden sm:contents">
            {edit.kind === "inert" ? (
              <span
                title={edit.reason}
                aria-label={edit.reason}
                aria-disabled
                className={`${GLYPH_BUTTON} text-[var(--muted)] opacity-30 cursor-not-allowed`}
              >
                <span aria-hidden>✎</span>
              </span>
            ) : (
              <Link
                href={edit.href}
                title="Edit deployment"
                aria-label="Edit deployment"
                className={`${GLYPH_BUTTON} text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--hover)]`}
              >
                <span aria-hidden>✎</span>
              </Link>
            )}
            </span>
            <ToggleGlyph
              intent={intent}
              switchOn={card.switchOn}
              busy={busy}
              onPress={toggle}
              what="this deployment"
            />
            <span className="hidden sm:contents">
              <ArmedGlyph
                glyph="✕"
                armed={deleteArmed}
                busy={busy}
                onPress={destroy}
                label="Delete deployment"
                idleTitle="Delete this deployment (goes to Trash)"
                armedTitle="Click again to send this deployment to Trash"
                inertReason={book ? BOOK_DERIVED_ROW_REFUSAL : null}
              />
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-0.5">
          {/* The playbook's line, and a book card has none: its playbooks are
              its rows, each with its own key, timeframe and window, and one of
              them printed here would be one row's identity over all of them.
              The title above already carries the account, and each row its contract.
              Its place on a book card is the account's balance, then the
              account-state stamp — the server's verdict — both outside the
              fold, so a folded card still says its account cannot trade. */}
          {card.account != null && (
            <>
              <BalanceCell balance={card.account.balance} />
              {card.account.stamp != null && (
                // A `Max Loss` reason states the balance against its floor.
                <span
                  title={text(maskUsdFigures(card.account.stamp.detail, hideBalances))}
                  className={`cursor-help shrink-0 ${ACCOUNT_STATE_DANGER_STAMP}`}
                >
                  {card.account.stamp.text}
                </span>
              )}
            </>
          )}
          {!book && (
            <span className="font-mono text-[11px] text-[var(--muted)] truncate">
              {card.strategyKey}
              {" · "}
              {card.ticker}
              {timeframeLabel && ` · ${timeframeLabel}`}
              {card.sessionWindow && (
                <span title={`Session window in ${card.sessionWindow.timezone}`}>
                  {` · ${card.sessionWindow.start}–${card.sessionWindow.end}`}
                </span>
              )}
            </span>
          )}
          <IntentBadges intent={card.intent} />
          {/* The regime chip. `--muted-secondary` and no tone map on purpose:
              a colour here would read as an arming state, and nothing is
              gated on the label in this phase. Absent when the session is
              unlabelled — a chip is a reading, and there is none. */}
          {card.regime && (
            <span
              className="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded-sm border border-[var(--card-border)] text-[var(--muted-secondary)]"
              title={card.regime.detail}
            >
              {card.regime.label}
            </span>
          )}
          {/* On a card with a header risk cell the phone moves this to the
              third line, beside it. */}
          <CardMoney card={card} display={card.risk != null ? "hidden sm:inline-flex" : "inline-flex"} />
        </div>

        {/* The phone's third line: the budget left, the open count and P&L
            right — the figures the desk shows on the title and meta lines. */}
        {card.risk != null && (
          <div className="sm:hidden flex items-center gap-2 mt-0.5">
            <RiskCell risk={maskRiskBalance(card.risk, hideBalances)} />
            <CardMoney card={card} display="inline-flex" />
          </div>
        )}
      </header>

      {error && (
        <div className="px-4 py-1.5 text-[11px] leading-snug border-t border-[var(--card-border)] bg-[var(--danger)]/10 text-[var(--danger)] whitespace-pre-wrap">
          {text(error)}
        </div>
      )}

      {open && (
        <>
          <div data-board-rows="desk" className="hidden sm:block overflow-hidden rounded-b-lg border-t border-[var(--card-border)]">
            {card.legs.map((leg, i) => (
              <LegRow key={leg.id} leg={leg} bookId={card.bookId} rowIndex={i} onMutated={onMutated} />
            ))}
          </div>
          <PhoneRows legs={card.legs} bookId={card.bookId} onMutated={onMutated} />
        </>
      )}
    </article>
  );
}

