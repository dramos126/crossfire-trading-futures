"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountRiskWireRow } from "@/components/account/account-risk-view";
import type { AccountStatusWire } from "@/app/api/accounts/status/route";
import {
  buildBoard,
  type BoardAccount,
  type BoardBook,
  type BoardDeployment,
} from "@/components/board/board-model";
import {
  boardAccountStatus,
  boardRegime,
  boardRisk,
  boardSessionPnl,
  toAccountStatusRows,
  toBoardBooks,
  type RegimeReading,
} from "@/components/board/board-view";
import {
  useDeployments,
  useDeploymentsLoadState,
  type DeploymentsLoadState,
} from "@/lib/hooks/use-strategies";
import { useLivePnL } from "@/lib/hooks/use-live-pnl";
import { useSetupReadings } from "@/lib/hooks/use-setup-readings";
import { useTrades } from "@/lib/hooks/use-trades";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";
import type { DeploymentGroup } from "@/lib/trading/domain";
import { currentCmeSessionStart } from "@/lib/trading/session/session";
import { getStrategy } from "@/lib/trading/strategies";

/**
 * `buildBoard`'s inputs, assembled once.
 *
 * **This is the file the Hard rule in
 * [design-language.md](../../docs/modules/ui/design-language.md) carves out**,
 * and it is a hook rather than a component because the adapter now has two
 * consumers: the board at `/` and the drill-in at `/deployments/[id]`. The
 * rule is that nothing renders a field off a `Deployment` or a
 * `DeploymentGroup` — which means every surface that shows one has to reach
 * `BoardDeployment`, which means the inputs get assembled somewhere. Doing it
 * twice would put `GET /api/groups` and the `boardSessionPnl` wrapper in two
 * files, and the wrapper is the whole em-dash guarantee.
 *
 * It was extracted verbatim from `board.tsx`, which held it while the board
 * was the only consumer. Nothing about the assembly changed in the move.
 *
 * **Its three consumers do not want the same grouping, and that is the one
 * thing they may ask for.** `groupByBook` is the Dashboard's — a book is one
 * card and its rows are playbooks — while `/deployments/[id]` and the editor
 * address one deployment and take the default. Everything else here is
 * identical for all three: one group fetch, one risk read, one live-P&L
 * subscription.
 *
 * **`livePnl` is returned rather than re-derived by the caller.** The board's
 * session strip needs `allAccounts()` and `openPositionCount()` off the same
 * hook instance this uses for `sessionPnl`; a second `useLivePnL` call would
 * mount a second 30s session-anchor interval and a second subscription for
 * the same answer.
 */
/** How often the board re-asks which session a recorded close belongs to.
 *  The Risk block's own budget line runs on the same minute. */
const RISK_CLOCK_TICK_MS = 60_000;

/** When the board re-reads the account status after a close: once the
 *  engine's ~10s after-close check has usually landed, and once more for a
 *  slow broker. */
const STATUS_REREAD_AFTER_CLOSE_MS = [20_000, 60_000] as const;

export interface BoardModel {
  /** Every live deployment, one row shape. Sorted by name. */
  board: BoardDeployment[];
  /**
   * The raw parent rows, for the one consumer that edits rather than
   * renders: `/deployments/[id]/edit` needs `paramValues`, which
   * `BoardDeployment` deliberately does not carry because the board has no
   * business showing it.
   *
   * **Exposed rather than re-fetched, and that is the carve-out working as
   * written.** The rule this file is carved out of is about rendering a
   * field off a raw row; the reason it is *one* file is that a second
   * `GET /api/groups` would be a second fetch and a second cache. Handing
   * back the array already in hand adds neither. A surface that renders a
   * board field still has to reach `BoardDeployment` — see the editor's own
   * docblock for why editing is not that.
   */
  groups: DeploymentGroup[];
  /** Re-read `GET /api/groups`. Group mutations do not pass through the
   *  deployment store, so a card that writes one calls this. */
  refreshGroups: () => Promise<void>;
  deploymentsLoadState: DeploymentsLoadState;
  livePnl: ReturnType<typeof useLivePnL>;
}

/**
 * What a consumer asks this hook for beyond the rows themselves.
 *
 * **One option, and it is a shape rather than a preference.** The Dashboard
 * groups a book's derived rows into one card per `(account, ticker)`; the
 * drill-in and the editor address *one deployment* and ask for one card per
 * deployment, which is the default. See `BoardInput.groupByBook` for what
 * breaks if the wrong one is passed — a page that answers *what has this
 * playbook done here* with two playbooks' trades.
 */
export interface BoardModelOptions {
  groupByBook?: boolean;
}

export function useBoardModel(options: BoardModelOptions = {}): BoardModel {
  const groupByBook = options.groupByBook === true;
  const trading = useTrading();
  const { deployments } = useDeployments();
  const deploymentsLoadState = useDeploymentsLoadState();
  const { trades, tradesRead } = useTrades({});
  const livePnl = useLivePnL(null, "session");
  const [groups, setGroups] = useState<DeploymentGroup[]>([]);
  const [books, setBooks] = useState<BoardBook[]>([]);
  const [regimeDays, setRegimeDays] = useState<RegimeReading[]>([]);
  // Two states rather than one nullable array, because *no answer yet* and
  // *asked and got nothing* are the `…` and the `—` and a surface that cannot
  // tell them apart has spent the glyph that says a number is unavailable.
  // `riskRead` flips on any **settled** attempt, which is the fix `use-trades`
  // already carries: a read that only clears on success leaves the em-dash arm
  // unreachable and tells the operator to keep waiting forever.
  const [riskRows, setRiskRows] = useState<AccountRiskWireRow[] | null>(null);
  const [riskRead, setRiskRead] = useState(false);
  // The same `…` / `—` pair, for the account-status read.
  const [statusRows, setStatusRows] = useState<AccountStatusWire[] | null>(null);
  const [statusRead, setStatusRead] = useState(false);
  // The clock the budget is resolved against. A phase's close goes stale at
  // the 18:00 ET roll and the budget drops to its floor with it, so a board
  // left open must re-evaluate which session a recorded close belongs to
  // rather than freezing at the instant it mounted — the same one-minute tick
  // the Risk block's own line runs on.
  const [riskNow, setRiskNow] = useState(() => new Date());
  // The session the tick currently falls in, as a string, so the fetch effect
  // below can depend on *the roll* rather than on the minute. Recomputed every
  // tick and equal to itself ~1,400 times a session.
  const riskSessionAnchor = currentCmeSessionStart(riskNow);

  const token = trading.token;

  // Groups are not in the deployment store, and `deploymentsChanged` only
  // refetches that store — so the group list rides the same signal by keying
  // off the snapshot that event replaces. Every group mutation emits it, so
  // one invalidation reaches both halves of the card.
  const refreshGroups = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/groups");
      if (!res.ok) return;
      const body = (await res.json()) as { groups?: DeploymentGroup[]; books?: unknown };
      if (body.groups) setGroups(body.groups);
      // Each book's own switch and its cells' arming ride the same response,
      // so they can never be newer or older than the rows they are read against.
      // An unreadable books payload counts as unread — no book, so nothing
      // hides — rather than keeping a stale arming that could hide a row.
      setBooks(toBoardBooks(body.books) ?? []);
    } catch {
      // A dropped read leaves the previous list rather than emptying it: a
      // group that vanished from the board would adopt its legs onto N
      // one-leg cards and read as a shape change that did not happen.
    }
  }, [token]);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups, deployments]);

  /**
   * The session's regime labels. **Read once per mount and on no interval**:
   * the label is a day-ahead reading that changes at the 18:00 ET session
   * roll, so polling it would be a request a minute for a value that moves
   * once a day. A dashboard left open across the roll shows the previous
   * session's chip until it is reloaded, which is the accepted cost — nothing
   * is gated on the label, and the tooltip says so.
   */
  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/regime");
        if (!res.ok) return;
        const body = (await res.json()) as { days?: RegimeReading[] };
        if (live && body.days) setRegimeDays(body.days);
      } catch {
        // A dropped read leaves the previous list. An absent chip is a
        // legitimate state, so there is nothing to report here.
      }
    })();
    return () => {
      live = false;
    };
  }, [token]);

  /**
   * The catalogue's risk rows. **Read on mount and again whenever the session
   * anchor moves**, and on no interval otherwise.
   *
   * **The refetch at the roll is not an optimisation; the version without it
   * printed a cause nobody had checked.** The budget is resolved against
   * `riskNow`, which ticks, over rows fetched once — so at the 18:00 ET roll
   * the recorded close goes stale under a row nobody had re-read and the cell
   * flipped to *"$225 · lowest — no close on record for this session yet"*,
   * while the engine, reading the sample the EOD writer had since laid down,
   * sized the new session at its real bucket. It errs low, which is the right
   * direction to err, and it is still a sentence naming a cause the surface
   * had not looked at. Keying the effect on `currentCmeSessionStart(riskNow)`
   * makes the clock and the data move together: the string is identical on
   * every one of the ~1,400 ticks inside a session and changes exactly once,
   * at the roll, which is also the only moment a fresh close can exist.
   *
   * The other two ways a budget moves — the operator saving one in Settings,
   * the sampler writing a close mid-session — are not things a dashboard poll
   * catches any sooner than a reload, and neither is worth a request a minute.
   *
   * **It reads the catalogue route rather than `/api/accounts`**, which is a
   * broker fan-out: a broker being down must not blank the figure that says
   * how much an entry may lose. Same rule the Risk block itself follows.
   *
   * **With no session nothing is attempted and `riskRead` stays false**, so
   * the cell renders `…` rather than `—`. That is the honest pair: a board
   * with no token has not asked, and the page above it is already carrying
   * the connection banner that says why.
   *
   * The drill-in shares this hook and renders no risk cell, so it pays one
   * catalogue read it does not use — one indexed `SELECT` on mount, against
   * the alternative of a second assembly path, which is the trade the
   * one-file carve-out already made for the group fetch.
   */
  useEffect(() => {
    if (!token) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/accounts/risk");
        if (!res.ok) return;
        const body = (await res.json()) as { accounts?: AccountRiskWireRow[] };
        if (live && Array.isArray(body.accounts)) setRiskRows(body.accounts);
      } catch {
        // Settled without an answer. The flag below is what turns the `…` into
        // a `—`; leaving `riskRows` null is the honest state, not an empty
        // list, which would read as "no account has a budget". A *refetch*
        // that fails leaves the rows it already has, for the reason the group
        // read does: a dropped read must not delete what the last one said.
      } finally {
        if (live) setRiskRead(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [token, riskSessionAnchor]);

  useEffect(() => {
    const id = setInterval(() => setRiskNow(new Date()), RISK_CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  /**
   * The book cards' balance and state stamp, from `GET /api/accounts/status`
   * — storage only, never a broker. **The Dashboard's alone**: the drill-in
   * and the editor take the default grouping and read nothing here.
   *
   * Read when the board opens — the stored values only; **opening the
   * Dashboard runs no status check** (operator, 2026-10-21), the engine's
   * clock and after-close triggers keep the store current. And re-read
   * `STATUS_REREAD_AFTER_CLOSE_MS` after the board's open trade rows drop —
   * a close — because the engine checks ~10s after booking one and the board
   * has no event for when that check lands.
   */
  const readStatus = useCallback(async () => {
    if (!token || !groupByBook) return;
    try {
      const res = await fetch("/api/accounts/status");
      if (!res.ok) return;
      const rows = toAccountStatusRows(await res.json());
      if (rows) setStatusRows(rows);
    } catch {
      // A dropped read leaves the last rows: their stamps say how old they are.
    } finally {
      setStatusRead(true);
    }
  }, [token, groupByBook]);

  useEffect(() => {
    void readStatus();
  }, [readStatus]);

  const openTradeRows = useMemo(
    () => trades.filter((t) => t.status === "open" || t.status === "pending_exit").length,
    [trades],
  );
  const lastOpenTradeRows = useRef<number | null>(null);
  const rereadTimers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => {
    const previous = lastOpenTradeRows.current;
    lastOpenTradeRows.current = openTradeRows;
    if (!groupByBook || previous == null || openTradeRows >= previous) return;
    rereadTimers.current.forEach(clearTimeout);
    rereadTimers.current = STATUS_REREAD_AFTER_CLOSE_MS.map((ms) =>
      setTimeout(() => void readStatus(), ms),
    );
  }, [openTradeRows, groupByBook, readStatus]);
  useEffect(() => () => rereadTimers.current.forEach(clearTimeout), []);

  const accounts: BoardAccount[] = trading.accounts;

  /**
   * The wrapper that wins the em-dash guarantee. `livePnl.deployment` answers
   * an *empty breakdown* — indistinguishable from a flat zero — for anything
   * outside `visibleAccounts`, so the set membership is tested explicitly
   * rather than trusted to the selector. See `board-view.ts`.
   */
  const sessionPnl = useMemo(
    () =>
      boardSessionPnl({
        deployments,
        visibleAccountIds: new Set(trading.visibleAccounts.map((a) => a.id)),
        deployment: livePnl.deployment,
      }),
    [deployments, trading.visibleAccounts, livePnl],
  );

  const regime = useMemo(() => boardRegime(regimeDays), [regimeDays]);

  const risk = useMemo(
    () => boardRisk({ rows: riskRows, failed: riskRead && riskRows == null, now: riskNow }),
    [riskRows, riskRead, riskNow],
  );

  const accountStatus = useMemo(
    () =>
      groupByBook
        ? boardAccountStatus({ rows: statusRows, failed: statusRead && statusRows == null, now: riskNow })
        : undefined,
    [groupByBook, statusRows, statusRead, riskNow],
  );

  // Null while unread — no live stream — which the adapter takes as absent.
  const setupReadings = useSetupReadings();
  const setup = useMemo(
    () =>
      setupReadings
        ? (deploymentId: string) => setupReadings.get(deploymentId) ?? null
        : undefined,
    [setupReadings],
  );

  const board: BoardDeployment[] = useMemo(
    () =>
      buildBoard({
        deployments,
        groups,
        accounts,
        trades,
        tradesRead,
        strategy: (key) => {
          const mod = getStrategy(key);
          return mod
            ? {
                name: mod.config.name,
                timeframe: mod.config.timeframe,
                session: mod.config.session,
                intent: mod.config.intent,
              }
            : null;
        },
        sessionPnl,
        regime,
        risk,
        accountStatus,
        groupByBook,
        books,
        setup,
      }),
    [
      deployments,
      groups,
      accounts,
      trades,
      tradesRead,
      sessionPnl,
      regime,
      risk,
      accountStatus,
      groupByBook,
      books,
      setup,
    ],
  );

  return { board, groups, refreshGroups, deploymentsLoadState, livePnl };
}
