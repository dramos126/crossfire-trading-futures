"use client";

import { useEffect, useRef, useState } from "react";
import type { BookPayload } from "@/app/api/books/route";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import { useDisplayPrivacy } from "@/components/privacy/privacy-provider";
import {
  MOVE_TO_REPLACEMENT_LABEL,
  moveToReplacementTitle,
} from "@/lib/trading/broker-access/account-state-gate";

/**
 * What the Playbook Deploy picker, the deployment editor's leg picker and the
 * book grid share about an account's state: the one status check each runs
 * when it opens, the `GET /api/books` read and the narrowing of its body, and
 * the *Move to replacement* control.
 *
 * Neither surface derives a refusal: the gates are the server's
 * (`readAccountGates`), read off the books payload after the check settles.
 */

/**
 * `POST /api/accounts/status` once per open — the Settings Risk page's check,
 * so a setting flipped in Topstep, a lockout, a death or a reset account's new
 * number shows here. Settles on any answer, a failure included: the route
 * re-screens at the press, so a check that failed blocks nothing it would not.
 * The ref holds the one-per-open rule across a dev double-mount; `onSettled`
 * is read at settle time, not captured.
 */
export function useStatusCheckOnOpen(
  token: string | null,
  onSettled: () => void,
): boolean {
  const fired = useRef(false);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!token || fired.current) return;
    fired.current = true;
    void (async () => {
      try {
        await fetch("/api/accounts/status", { method: "POST" });
      } catch {
        // Settles regardless; see above.
      }
      setSettled(true);
      settledRef.current();
    })();
  }, [token]);
  return settled;
}

/** `GET /api/books`' body, narrowed at the boundary. `accounts` is null when
 *  the body predates it or did not carry a list. */
export function readBooksBody(
  body: unknown,
): { books: BookPayload[]; accounts: AccountGateWire[] | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const books = (body as { books?: unknown }).books;
  if (!Array.isArray(books)) return null;
  const accounts = (body as { accounts?: unknown }).accounts;
  return {
    books: books as BookPayload[],
    accounts: Array.isArray(accounts) ? (accounts as AccountGateWire[]) : null,
  };
}

/**
 * `GET /api/books`, read when the frame opens and again on each `round` — the
 * status check settling, a move landing. `list` null with `settled` true is
 * *the read did not answer*, which the notice states rather than reading as
 * *no book*. `gates` is every account's state gate off the same body;
 * `settledRound` is the round whose read last settled, on any answer.
 */
export function useBooks(
  token: string | null,
  round: number,
): {
  list: BookPayload[] | null;
  gates: AccountGateWire[] | null;
  settled: boolean;
  settledRound: number | null;
} {
  const [list, setList] = useState<BookPayload[] | null>(null);
  const [gates, setGates] = useState<AccountGateWire[] | null>(null);
  const [settledRound, setSettledRound] = useState<number | null>(null);
  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/books");
        if (!res.ok) return;
        const body = readBooksBody(await res.json());
        if (live && body) {
          setList(body.books);
          setGates(body.accounts);
        }
      } catch {
        // Settled without an answer; the last answer stands.
      } finally {
        if (live) setSettledRound(round);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, round]);
  return { list, gates, settled: settledRound != null, settledRound };
}

/**
 * One press re-points everything on a dead account to its replacement —
 * `POST /api/deployments/move-account`. With one candidate it names it; with
 * several the operator picks first, and nothing is chosen for them. The
 * route's refusal renders verbatim beside it.
 */
export function MoveToReplacement({
  token,
  fromAccountId,
  replacements,
  onMoved,
}: {
  token: string | null;
  fromAccountId: number;
  replacements: AccountGateWire["replacements"];
  onMoved: () => void;
}) {
  const { accountLabel } = useDisplayPrivacy();
  const nameOf = (r: { accountId: number; name: string | null }) => accountLabel(r.name ?? String(r.accountId));
  const single = replacements.length === 1 ? replacements[0] : null;
  const [picked, setPicked] = useState<number | "">(single ? single.accountId : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (replacements.length === 0) return null;

  const target = replacements.find((r) => r.accountId === picked) ?? null;

  async function move() {
    if (!token || target == null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/deployments/move-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromAccountId, toAccountId: target.accountId }),
      });
      if (!res.ok) {
        const data: unknown = await res.json().catch(() => null);
        const message =
          typeof data === "object" && data !== null ? (data as { error?: unknown }).error : null;
        setError(typeof message === "string" ? message : `The move was refused (${res.status}).`);
        return;
      }
      onMoved();
    } catch {
      setError("The request never reached the server. Nothing was moved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {single == null && (
        <select
          value={picked}
          onChange={(e) => setPicked(e.target.value === "" ? "" : Number(e.target.value))}
          aria-label="Replacement account"
          className="rounded-md border border-[var(--card-border)] bg-[var(--background)] px-1 py-0.5 font-mono text-[11px] text-[var(--foreground)]"
        >
          <option value="">Replacement…</option>
          {replacements.map((r) => (
            <option key={r.accountId} value={r.accountId}>
              {nameOf(r)}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        onClick={() => void move()}
        disabled={target == null || busy}
        title={target ? moveToReplacementTitle(nameOf(target)) : undefined}
        className="rounded-md border border-[var(--card-border)] px-2 py-0.5 text-[11px] text-[var(--foreground)] hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? "Moving…" : MOVE_TO_REPLACEMENT_LABEL}
        {single && (
          <span className="ml-1 font-mono tabular text-[var(--muted)]">
            → {nameOf(single)}
          </span>
        )}
      </button>
      {error && <span className="text-[11px] text-[var(--warning)]">{error}</span>}
    </span>
  );
}
