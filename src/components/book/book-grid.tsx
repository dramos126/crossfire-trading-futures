"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { readAccountRisk, type AccountRiskWireRow } from "@/components/account/account-risk-view";
import { minimumRiskOf } from "@/components/playbook/playbook-minimum-risk";
import type { BoardLegRisk } from "@/components/board/board-model";
import { boardRisk } from "@/components/board/board-view";
import {
  buildBookCards,
  moveTargets,
  BOOKS_EMPTY,
  BOOKS_UNREADABLE,
  BOOK_DEPLOYED_HINT,
  BOOK_RESTORED_HINT,
  DEPLOY_BOOK_LABEL,
  type BookGridRow,
} from "@/components/book/book-grid-model";
import { BookSection } from "@/components/book/book-section";
import type { CellPatch } from "@/components/book/book-account-card";
import { DeployDialog } from "@/components/book/book-deploy-dialog";
import { MoveDialog } from "@/components/book/book-move-dialog";
import { ViewControls } from "@/components/privacy/view-controls";
import type { BookPayload, CodeBookPayload } from "@/app/api/books/route";
import type { MovePreview } from "@/app/api/books/[id]/move/route";
import { readBooksBody, useStatusCheckOnOpen } from "@/components/playbook/playbook-account-gates";
import { buildDeployAccountRows } from "@/components/playbook/playbook-deploy-model";
import type { AccountGateWire } from "@/lib/trading/books/account-gates";
import { useDeployments } from "@/lib/hooks/use-strategies";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import { getStrategy } from "@/lib/trading/strategies";

/**
 * `/books` — the configuration surface. *Which accounts run each book, and
 * which of its playbooks each one has on.*
 *
 * **One section per book, one card per account running it**, then a section
 * of the accounts not on a book. A book is defined in code, so the page only
 * deploys it — one *Deploy a book* control, opening the Deploy dialog — and
 * each account's card holds that account's own switch, risk, stamps and
 * on/off per playbook, and its ⋯ (*Move to <book>*, opening the Move dialog,
 * and *Remove from account*).
 *
 * **Every refusal on this screen is rendered, never derived.** The
 * live-account verdict, the account-state gate, the conflict and the close in
 * flight all arrive on the payload, and the one predicate stays where
 * [brokers/README.md](../../../docs/modules/brokers/README.md) put it. The
 * single exception is the Deploy dialog's accounts, which include accounts no
 * book runs and so have no payload line to read — they go through the
 * Playbook Deploy picker's rows, which read the server's verdict off each
 * `/api/accounts` row (`autoTrade`, A38), so the operator is not offered an
 * account the route will refuse.
 *
 * Every decision this file could have taken in JSX lives in
 * [`book-grid-model.ts`](./book-grid-model.ts).
 */

/** How often the grid re-asks which session a recorded close belongs to —
 *  the minute the board and the Risk block both run on. */
const RISK_CLOCK_TICK_MS = 60_000;

/** The one sentence this screen owns about a failed write: the request never landed. */
const REQUEST_NEVER_LANDED = "The request never reached the server.";

function accountBookPath(row: BookGridRow): string {
  return `/api/books/${encodeURIComponent(row.id)}`;
}

/** `GET /api/books`' code books, narrowed at the boundary. */
function readCodeBooks(body: unknown): CodeBookPayload[] | null {
  if (typeof body !== "object" || body == null) return null;
  const books = (body as { codeBooks?: unknown }).codeBooks;
  return Array.isArray(books) ? (books as CodeBookPayload[]) : null;
}

function playbookName(strategyKey: string): string {
  return getStrategy(strategyKey)?.config.name ?? strategyKey;
}

/** The screen. `title` and `subtitle` are the page's title block, split so the
 *  phone can set the view cluster on the title's line and the subtitle under both. */
export function BookGrid({ title, subtitle }: { title?: ReactNode; subtitle?: ReactNode }) {
  const trading = useTrading();
  const token = trading.token;
  // A broker whose live fetch failed contributes no accounts to the picker,
  // so a dropped broker looks like the account not existing. The Dashboard
  // names it; this page reads the same hook and says the same sentence.
  const catalogWarning = trading.accountCatalogWarning;

  const [books, setBooks] = useState<BookPayload[] | null>(null);
  const [codeBooks, setCodeBooks] = useState<CodeBookPayload[] | null>(null);
  const [gates, setGates] = useState<AccountGateWire[] | null>(null);
  const [settled, setSettled] = useState(false);
  // The route's own sentence, verbatim. Every refusal these writes can answer
  // with is operator-actionable and is reworded nowhere.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Raised by a deploy and cleared by the operator. */
  const [hint, setHint] = useState<string | null>(null);
  /** The Deploy dialog, open on a picked book or none. */
  const [deploying, setDeploying] = useState<{ book: string | null } | null>(null);
  /** The Move dialog, open on one account's book and the book its ⋯ item named. */
  const [moving, setMoving] = useState<{ bookId: string; target: string } | null>(null);
  /** The account cards drawn open. Every card starts folded onto its header; nothing is persisted. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const { risk, budgetUsd } = useAccountRisk(token);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/books");
      if (!res.ok) return;
      const raw: unknown = await res.json();
      const body = readBooksBody(raw);
      const code = readCodeBooks(raw);
      if (body && code) {
        setBooks(body.books);
        setCodeBooks(code);
        setGates(body.accounts);
      }
    } catch {
      // A dropped read leaves the previous list rather than emptying it: an
      // empty grid claims the operator has no books, which is the same class
      // of lie as a plausible zero.
    } finally {
      setSettled(true);
    }
  }, [token]);

  // Keyed off the deployment snapshot that `deploymentsChanged` replaces, as
  // `use-board.ts` does for groups: a leg settling Pausing → Paused must
  // un-grey the on-direction controls a close in flight made inert.
  const { deployments } = useDeployments();
  useEffect(() => {
    void refresh();
  }, [refresh, deployments]);

  // One account-status check per open, then the account list and the books
  // again: a lockout, a death, OCO switched in Topstep or a reset account's
  // new number shows without a reload.
  const { reloadAccounts } = trading;
  const reread = useCallback(() => {
    void reloadAccounts();
    void refresh();
  }, [reloadAccounts, refresh]);
  useStatusCheckOnOpen(token, reread);

  /** One write, one refetch. The route has already synced the engine and
   *  emitted, so the board hears about it on its own channel. */
  const write = useCallback(
    /** The response body on success, null on any refusal or failure. */
    async (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<unknown> => {
      if (busy || !token) return null;
      setBusy(true);
      setRefusal(null);
      try {
        const res = await fetch(path, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setRefusal(data.error ?? `The platform did not accept this change (${res.status}).`);
          return null;
        }
        try {
          return ((await res.json()) as unknown) ?? {};
        } catch {
          // The write landed; a body that does not parse only loses the detail.
          return {};
        }
      } catch {
        setRefusal(REQUEST_NEVER_LANDED);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [busy, token],
  );

  const writeThenRefresh = useCallback(
    async (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<unknown> => {
      const done = await write(path, method, body);
      if (done != null) await refresh();
      return done;
    },
    [write, refresh],
  );

  const toggleBook = useCallback(
    (row: BookGridRow, next: { enabled: boolean }) => void writeThenRefresh(accountBookPath(row), "PATCH", next),
    [writeThenRefresh],
  );
  const toggleCell = useCallback(
    (row: BookGridRow, next: CellPatch) => void writeThenRefresh(`${accountBookPath(row)}/playbooks`, "PATCH", next),
    [writeThenRefresh],
  );
  const removeBook = useCallback(
    (row: BookGridRow) => void writeThenRefresh(accountBookPath(row), "DELETE"),
    [writeThenRefresh],
  );
  const moveBook = useCallback(
    async (row: BookGridRow, to: string): Promise<boolean> =>
      (await writeThenRefresh(`${accountBookPath(row)}/move`, "POST", { to })) != null,
    [writeThenRefresh],
  );
  /** The Move dialog's read. A read that fails answers as a refusal, so the move stays blocked and says why. */
  const previewMove = useCallback(
    async (bookId: string, to: string): Promise<MovePreview> => {
      try {
        const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/move?to=${encodeURIComponent(to)}`);
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          return { lines: [], refusal: data.error ?? `The platform did not answer (${res.status}).` };
        }
        return (await res.json()) as MovePreview;
      } catch {
        return { lines: [], refusal: REQUEST_NEVER_LANDED };
      }
    },
    [],
  );
  const deployBook = useCallback(
    async (book: string, accountId: number): Promise<boolean> => {
      const done = await writeThenRefresh("/api/books/deploy", "POST", { book, accountId });
      if (done == null) return false;
      setHint((done as { restored?: unknown }).restored === true ? BOOK_RESTORED_HINT : BOOK_DEPLOYED_HINT);
      return true;
    },
    [writeThenRefresh],
  );
  const openDeploy = useCallback((book: string | null) => {
    setRefusal(null);
    setDeploying({ book });
  }, []);
  const closeDeploy = useCallback(() => setDeploying(null), []);
  const openMove = useCallback((row: BookGridRow, target: string) => {
    setRefusal(null);
    setMoving({ bookId: row.id, target });
  }, []);
  const closeMove = useCallback(() => setMoving(null), []);

  const cards = useMemo(
    () =>
      buildBookCards({
        codeBooks: codeBooks ?? [],
        books: books ?? [],
        // The payload carries no display name and no shelf label; the registry
        // is read here the way `playbook-detail-model.ts` reads it.
        playbook: (key) => {
          const mod = getStrategy(key);
          return mod
            ? {
                name: mod.config.name,
                calibratedFor: mod.config.calibratedFor ?? null,
                intent: mod.config.intent ?? [],
                minimumRisk: minimumRiskOf(mod.config),
              }
            : null;
        },
        risk,
        budgetUsd,
      }),
    [codeBooks, books, risk, budgetUsd],
  );

  // Three states: `…` while the first read is out, the unreadable sentence
  // once it has settled with nothing, and the sections when there are some.
  const unreadable = settled && codeBooks == null;
  const moveRow = moving == null ? null : (cards.flatMap((c) => c.accounts).find((r) => r.id === moving.bookId) ?? null);
  const bookCards = cards.filter((c) => c.key != null);
  // A card the live-account block refuses has no columns to fold.
  const foldable = cards.flatMap((c) => c.accounts).filter((r) => r.refusal == null).map((r) => r.id);
  const allOpen = foldable.length > 0 && foldable.every((id) => expanded.has(id));
  const toggleExpanded = (row: BookGridRow) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(row.id)) next.add(row.id);
      return next;
    });
  const viewControls = (
    <ViewControls
      fold={
        foldable.length > 0
          ? { allOpen, onToggle: () => setExpanded(allOpen ? new Set() : new Set(foldable)) }
          : undefined
      }
    />
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          {/* Below sm the view cluster rides the title's line and the subtitle takes the full width under it. */}
          <div className="flex items-center justify-between gap-4 sm:block">
            {title}
            <div className="shrink-0 sm:hidden">{viewControls}</div>
          </div>
          {subtitle}
        </div>
        <div className="flex shrink-0 basis-full items-center gap-4 sm:basis-auto">
          <div className="hidden sm:contents">{viewControls}</div>
          <button
            type="button"
            disabled={busy || bookCards.length === 0}
            onClick={() => openDeploy(null)}
            className="btn-emerald min-h-9 w-full rounded-md px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 sm:w-auto"
          >
            {DEPLOY_BOOK_LABEL}
          </button>
        </div>
      </div>

      {catalogWarning && (
        <div
          role="alert"
          className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-4 py-2 text-[11px] leading-snug text-[var(--warning)]"
        >
          {catalogWarning}
        </div>
      )}

      {refusal && deploying == null && moving == null && (
        <p className="rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-4 py-2 text-xs text-[var(--warning)]">
          {refusal}
        </p>
      )}

      {hint && (
        <p className="flex items-start gap-3 rounded-md border border-[var(--card-border)] bg-[var(--card)] px-4 py-2 text-[11px] text-[var(--muted)]">
          <span className="flex-1">{hint}</span>
          <button
            type="button"
            onClick={() => setHint(null)}
            className="shrink-0 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </p>
      )}

      {cards.length === 0 ? (
        <p className="rounded-lg border border-[var(--card-border)] bg-[var(--card)] px-4 py-8 text-center text-xs text-[var(--muted)]">
          {codeBooks == null ? (unreadable ? BOOKS_UNREADABLE : "…") : BOOKS_EMPTY}
        </p>
      ) : (
        cards.map((card) => (
          <BookSection
            key={card.key ?? "unbooked"}
            card={card}
            busy={busy}
            onDeploy={openDeploy}
            expanded={expanded}
            account={{
              onToggleExpanded: toggleExpanded,
              busy,
              onToggleBook: toggleBook,
              onToggleCell: toggleCell,
              move: { token, onMoved: reread },
              onRemove: removeBook,
              moveTo: {
                targets: moveTargets(cards, { bookKey: card.key }),
                onOpen: openMove,
              },
            }}
          />
        ))
      )}

      {deploying != null && (
        <DeployDialog
          cards={bookCards}
          accounts={buildDeployAccountRows(trading.accounts, gates)}
          books={books}
          codeBooks={codeBooks ?? []}
          budgetUsd={budgetUsd}
          initialBook={deploying.book}
          busy={busy}
          catalogWarning={catalogWarning}
          refusal={refusal}
          onDeploy={deployBook}
          onClose={closeDeploy}
        />
      )}

      {moving != null && moveRow != null && (
        <MoveDialog
          row={moveRow}
          targets={moveTargets(cards, moveRow)}
          initialTarget={moving.target}
          preview={previewMove}
          nameOf={playbookName}
          busy={busy}
          refusal={refusal}
          onMove={moveBook}
          onClose={closeMove}
        />
      )}
    </div>
  );
}

/**
 * The catalogue's risk rows, resolved against a clock that ticks.
 *
 * **The shared thing is the reader, not the fetch** — `boardRisk` over
 * `account-risk-view.ts`, which the board and Settings' Risk block both go
 * through, so the three surfaces cannot disagree about which ending an account
 * is in.
 *
 * **The refetch is keyed on the session anchor rather than on the minute.**
 * The budget is resolved against `now`, so at the 18:00 ET roll a recorded
 * close goes stale under rows nobody re-read. The anchor string is identical on
 * every tick inside a session and changes exactly once, at the roll.
 *
 * `read` flips on any **settled** attempt, which is what keeps the `—` arm
 * reachable: a flag that only clears on success tells the operator to keep
 * waiting forever.
 */
function useAccountRisk(token: string | null): {
  risk: (accountId: number) => BoardLegRisk;
  budgetUsd: (accountId: number) => number | null;
} {
  const [rows, setRows] = useState<AccountRiskWireRow[] | null>(null);
  const [read, setRead] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const sessionAnchor = currentCmeSessionStart(now);

  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/accounts/risk");
        if (!res.ok) return;
        const body = (await res.json()) as { accounts?: AccountRiskWireRow[] };
        if (live && Array.isArray(body.accounts)) setRows(body.accounts);
      } catch {
        // Settled without an answer. Leaving `rows` null is the honest state;
        // an empty list would read as "no account has a budget".
      } finally {
        if (live) setRead(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, sessionAnchor]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), RISK_CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return useMemo(
    () => ({
      risk: boardRisk({ rows, failed: read && rows == null, now }),
      budgetUsd: accountBudgetUsd(rows, now),
    }),
    [rows, read, now],
  );
}

/**
 * The resolved budget as a number, through the same reader `boardRisk` uses,
 * for the minimum-risk comparison. Null for every arm with no budget —
 * unread, unset, refused — so the callout stays informational there.
 */
function accountBudgetUsd(
  rows: readonly AccountRiskWireRow[] | null,
  now: Date,
): (accountId: number) => number | null {
  const byAccount = new Map((rows ?? []).map((r) => [r.accountId, r]));
  return (accountId) => {
    const row = byAccount.get(accountId);
    if (row == null) return null;
    const reading = readAccountRisk(row, now);
    return "budgetUsd" in reading ? reading.budgetUsd : null;
  };
}
