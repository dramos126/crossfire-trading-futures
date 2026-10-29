"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isProductionEnv } from "@/lib/env";

type ButtonState = "idle" | "holding" | "flattening" | "done" | "error";

const HOLD_MS = 1500;
const FLASH_MS = 2000;
/** Longer when the label says something may still be open or resting — that is the part to read. */
const RESULT_FLASH_MS = 4000;
const RING_SIZE = 16;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Inlined at build time from NEXT_PUBLIC_APP_ENV. Production targets live +
// eval accounts; staging targets PRAC- and Tradovate demo accounts only.
export const SCOPE_LABEL = isProductionEnv()
  ? "live + eval accounts only"
  : "practice + sim accounts only";

export const FLATTEN_ALL_TITLE = `Press and hold to close every open position at market — ${SCOPE_LABEL}.`;
export const FLATTEN_ALL_LABEL = "FLATTEN ALL";
export const FLATTEN_ERROR_LABEL = "Error";
/** The scope is visible only here: `title` never shows on touch, and the stamp under the button is gone. */
const HOLDING_LABEL = `Holding... ${SCOPE_LABEL}`;
const FLATTENING_LABEL = "Flattening...";
const RECONNECTING_TITLE = "Reconnecting...";
const CLOSED_SUFFIX = "closed";
const STILL_OPEN_SUFFIX = "may still be open";
/** Accounts outside the route's scope — on prod, a `PRAC-` account on the board. */
const ACCOUNT_SKIPPED_SUFFIX = "account skipped";
const ACCOUNTS_SKIPPED_SUFFIX = "accounts skipped";
export const ORDERS_MAY_REMAIN_LABEL = "orders may remain";
const ACCOUNT_NOT_REACHED_SUFFIX = "account not reached — positions may be open";
const ACCOUNTS_NOT_REACHED_SUFFIX = "accounts not reached — positions may be open";
const RESULT_SEPARATOR = " · ";

/** What the operator holds after the route ran, counted by position. */
export interface FlattenAllSummary {
  closed: number;
  /** Positions the route skipped or failed to close, on any account whatever its status. */
  stillOpen: number;
  /** An account errored after its positions were read, or a cancel failed. */
  ordersMayRemain: boolean;
  /** Accounts whose positions were never read — a broker that could not be reached, a position
   *  search that failed. Anything there may be open. A rejected flatten is not one: the route
   *  writes the positions it read as `error`, so they count under `stillOpen`. */
  unreached: number;
  /** Accounts the route left alone for scope; their positions were never read. */
  skippedAccounts: number;
  /** Accounts the route worked on. */
  attempted: number;
}

const STATUSES = new Set(["ok", "skipped", "error"]);

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/**
 * `POST /api/deployments/flatten-all`'s body, narrowed at the boundary. A body
 * that does not parse is null, which the button shows as `Error`: nobody can
 * say what was closed.
 *
 * Positions, not accounts: the route marks an account `ok` unless something
 * errored, so a Tradovate position skipped for an unwarmed contract sits on an
 * `ok` account and is still open.
 */
export function toFlattenAllSummary(raw: unknown): FlattenAllSummary | null {
  const body = record(raw);
  if (body == null || !Array.isArray(body.results) || typeof body.attempted !== "number") return null;
  const summary: FlattenAllSummary = {
    closed: 0,
    stillOpen: 0,
    ordersMayRemain: false,
    unreached: 0,
    skippedAccounts: 0,
    attempted: body.attempted,
  };
  for (const r of body.results) {
    const account = record(r);
    if (account == null || typeof account.status !== "string" || !STATUSES.has(account.status)) return null;
    if (!Array.isArray(account.positions)) return null;
    if (account.status === "skipped") summary.skippedAccounts++;
    let positionErrored = false;
    for (const p of account.positions) {
      const status = record(p)?.status;
      if (typeof status !== "string" || !STATUSES.has(status)) return null;
      if (status === "ok") summary.closed++;
      else summary.stillOpen++;
      if (status === "error") positionErrored = true;
    }
    const cancels = Array.isArray(account.cancelledOrders) ? account.cancelledOrders : [];
    // An error row with no positions and no cancel sweep never read its
    // positions (the route writes `positions: []` on an unreachable broker and
    // a failed position search; a rejected flatten writes its read positions
    // as `error`), so "orders may remain" would read as the positions having
    // been handled.
    if (account.status === "error" && account.positions.length === 0 && cancels.length === 0) {
      summary.unreached++;
    } else if (
      (account.status === "error" && !positionErrored) ||
      cancels.some((c) => record(c)?.status === "error")
    ) {
      summary.ordersMayRemain = true;
    }
  }
  return summary;
}

/** Whether the label carries something the operator has to act on. */
export function flattenAllNeedsAttention(s: FlattenAllSummary): boolean {
  return s.stillOpen > 0 || s.ordersMayRemain || s.unreached > 0 || s.skippedAccounts > 0;
}

/**
 * The result label: what the operator now holds, not that the press landed. A
 * skipped position is never counted as closed (docs/modules/ui/copy.md, *An
 * emergency action reports what it did*).
 */
export function flattenAllResultLabel(s: FlattenAllSummary): string {
  return [
    `${s.closed} ${CLOSED_SUFFIX}`,
    ...(s.stillOpen > 0 ? [`${s.stillOpen} ${STILL_OPEN_SUFFIX}`] : []),
    ...(s.ordersMayRemain ? [ORDERS_MAY_REMAIN_LABEL] : []),
    ...(s.unreached > 0
      ? [`${s.unreached} ${s.unreached === 1 ? ACCOUNT_NOT_REACHED_SUFFIX : ACCOUNTS_NOT_REACHED_SUFFIX}`]
      : []),
    ...(s.skippedAccounts > 0
      ? [`${s.skippedAccounts} ${s.skippedAccounts === 1 ? ACCOUNT_SKIPPED_SUFFIX : ACCOUNTS_SKIPPED_SUFFIX}`]
      : []),
  ].join(RESULT_SEPARATOR);
}

export function FlattenAllButton({ token }: { token: string | null }) {
  const [state, setState] = useState<ButtonState>("idle");
  const [result, setResult] = useState<string | null>(null);
  const [holdProgress, setHoldProgress] = useState(0);
  const holdTimerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const holdStartRef = useRef<number>(0);
  const mountedRef = useRef(false);

  const clearAllTimers = useCallback(() => {
    if (holdTimerRef.current != null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (flashTimerRef.current != null) {
      window.clearTimeout(flashTimerRef.current);
      flashTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearAllTimers();
    };
  }, [clearAllTimers]);

  const flashThenReset = useCallback((ms: number) => {
    flashTimerRef.current = window.setTimeout(() => {
      setState("idle");
      setResult(null);
      setHoldProgress(0);
    }, ms);
  }, []);

  const fire = useCallback(async () => {
    if (!token) {
      setState("error");
      flashThenReset(FLASH_MS);
      return;
    }
    setState("flattening");
    setHoldProgress(1);
    let summary: FlattenAllSummary | null = null;
    try {
      const res = await fetch("/api/deployments/flatten-all", {
        method: "POST",
      });
      if (res.ok) summary = toFlattenAllSummary(await res.json().catch(() => null));
    } catch {
      // A request that never landed reads `Error`, like a non-2xx or a body that does not parse.
    }
    // The unmount cleanup already ran; a flash timer armed now would outlive it.
    if (!mountedRef.current) return;
    if (summary == null) {
      setState("error");
      flashThenReset(FLASH_MS);
      return;
    }
    setResult(flattenAllResultLabel(summary));
    setState("done");
    flashThenReset(flattenAllNeedsAttention(summary) ? RESULT_FLASH_MS : FLASH_MS);
  }, [token, flashThenReset]);

  const tick = useCallback(() => {
    const elapsed = performance.now() - holdStartRef.current;
    const p = Math.min(1, elapsed / HOLD_MS);
    setHoldProgress(p);
    if (p < 1) {
      rafRef.current = window.requestAnimationFrame(tick);
    }
  }, []);

  const startHold = useCallback(() => {
    if (state !== "idle") return;
    if (!token) return;
    setState("holding");
    holdStartRef.current = performance.now();
    setHoldProgress(0);
    rafRef.current = window.requestAnimationFrame(tick);
    holdTimerRef.current = window.setTimeout(() => {
      if (rafRef.current != null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      void fire();
    }, HOLD_MS);
  }, [state, tick, fire, token]);

  const cancelHold = useCallback(() => {
    if (state !== "holding") return;
    clearAllTimers();
    setState("idle");
    setHoldProgress(0);
  }, [state, clearAllTimers]);

  const disabled = state === "flattening" || !token;
  // `result` is set only alongside `done` and cleared with it.
  const label =
    result ??
    (state === "holding"
      ? HOLDING_LABEL
      : state === "flattening"
        ? FLATTENING_LABEL
        : state === "error"
          ? FLATTEN_ERROR_LABEL
          : FLATTEN_ALL_LABEL);

  const dashOffset = RING_CIRCUMFERENCE * (1 - holdProgress);

  return (
    <button
      type="button"
      disabled={disabled}
      onMouseDown={startHold}
      onMouseUp={cancelHold}
      onMouseLeave={cancelHold}
      onTouchStart={(e) => {
        e.preventDefault();
        startHold();
      }}
      onTouchEnd={(e) => {
        e.preventDefault();
        cancelHold();
      }}
      onTouchCancel={cancelHold}
      // Below `sm` it fills the strip's second row at the view cluster's `h-7`
      // (44 and then 36 both read oversized to the operator, 2026-10-28), the
      // one big target on a phone; from `sm` the sm: pair restores `h-7`.
      className={`relative inline-flex flex-1 justify-center h-7 sm:flex-none sm:justify-start shrink-0 items-center gap-2 px-3 rounded-md border border-[var(--danger)]/40 text-[var(--danger)] uppercase font-mono tracking-widest text-[11px] select-none disabled:cursor-not-allowed disabled:opacity-50 transition-colors ${
        state === "holding" ? "bg-[var(--danger)]/15" : "bg-transparent hover:bg-[var(--danger)]/10"
      }`}
      // While a result shows, the live label is the accessible name.
      aria-label={result == null ? `Flatten all ${SCOPE_LABEL} (press and hold)` : undefined}
      title={token ? FLATTEN_ALL_TITLE : RECONNECTING_TITLE}
    >
      <span className="relative inline-flex items-center justify-center" style={{ width: RING_SIZE, height: RING_SIZE }}>
        <svg
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          className="absolute inset-0 -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.2}
            strokeWidth={RING_STROKE}
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={RING_CIRCUMFERENCE}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <span className="text-[10px] leading-none">▼</span>
      </span>
      <span aria-live="polite">{label}</span>
    </button>
  );
}
