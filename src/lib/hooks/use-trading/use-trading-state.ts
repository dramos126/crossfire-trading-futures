"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Dispatch,
} from "react";
import { signedSize, type Position } from "@/lib/brokers/types";
import { toAccountRows } from "./account-row";
import { useDeployments } from "@/lib/hooks/use-strategies";
import {
  isPracticeAccount,
  migrateLegacyStorageKeys,
  PRACTICE_ONLY_KEY,
  readStoredPracticeOnly,
} from "./account-selection";
import { reducer } from "./reducer";
import { connectFailureKind, postAuth, type AuthFailure } from "./auth-answer";
import { initialState, SESSION_REFUSED_STATUS, type Action } from "./types";
import { useSseStream } from "./use-sse-stream";
import { useRestPolling } from "./use-rest-polling";
import { useEngineStatusFeed } from "@/lib/hooks/use-engine-status";
import { isStagingEnv } from "@/lib/env";
import { isEngineManagedStatus } from "@/lib/trading/domain";
import { pnlDollarsFromTicks, pnlTicksFromPrices } from "@/lib/trading/orders/pnl-math";

// SignalR has been removed from the dashboard — Topstep enforces a single
// live session per user across CME-licensed feeds, so when the engine and
// the browser both opened hubs they kicked each other ("Multiple sessions
// detected"). The engine retains all hubs and relays what the dashboard shows
// over one SSE stream; a REST poll runs only where that stream cannot vouch
// for the data — see `use-rest-polling.ts` for each one.

// Build-time signal. `isStagingEnv()` reads NEXT_PUBLIC_APP_ENV which is
// inlined into the client bundle by `next build` from the Dockerfile's
// ARG APP_ENV. Anything other than "prod" (staging, undefined, typo)
// forces practiceOnly on — PRAC-only accounts, deploy disabled on
// non-PRAC. On prod the legacy localStorage-backed toggle behavior is
// preserved (the visible <PracticeToggle> is gone — see top-nav.tsx —
// but the persistence + setter still work for any future caller that
// wants to flip it programmatically).
const STAGING_PRACTICE_LOCK = isStagingEnv();

let sessionMarkerSeq = 0;
/** A new value per sign-in and resume, unique within the tab — all
 *  `SESSION_REFUSED` needs to tell a replaced session from the current one.
 *  It is not secret and never sent anywhere. */
function nextSessionMarker(): string {
  sessionMarkerSeq += 1;
  return `session-${sessionMarkerSeq}`;
}

interface AccountsResponse {
  topstepError?: string | null;
  tradovateError?: string | null;
}

/**
 * `/api/accounts` fans out to every configured broker under
 * `Promise.allSettled` and answers 200 with whatever loaded, reserving
 * 500 for "every broker attempted failed" — a partial picker beats an
 * empty one. The cost is that a single broker's outage is a *successful*
 * response carrying a soft error field, and until something rendered
 * that field the failure was invisible: on a mixed install a Topstep
 * outage dropped the Topstep accounts out of the picker with no
 * indication they had ever existed.
 *
 * Both fields set is unreachable here — that is the 500 case — but the
 * message is written to survive it anyway rather than assume.
 */
function partialCatalogWarning(data: AccountsResponse): string | null {
  const down: string[] = [];
  if (data.topstepError) down.push("Topstep");
  if (data.tradovateError) down.push("Tradovate");
  if (down.length === 0) return null;
  const detail = data.topstepError || data.tradovateError;
  return `${down.join(" and ")} accounts could not be loaded — ${detail}`;
}

/** Snapshot one account's positions into the reducer. */
export async function refreshAccountSnapshot(
  token: string,
  accountId: number,
  dispatch: Dispatch<Action>,
): Promise<void> {
  try {
    const posRes = await fetch(`/api/positions?accountId=${accountId}`);
    // A dead session is the one failure the next tick cannot retry past. The
    // refusal takes the token away, which stops this poller; a re-mint starts
    // a new one on a session the server has just vouched for.
    if (posRes.status === SESSION_REFUSED_STATUS) {
      dispatch({ type: "SESSION_REFUSED", token });
      return;
    }
    if (!posRes.ok) return;
    const posData = await posRes.json();
    dispatch({ type: "POSITIONS_LOADED", accountId, positions: posData.positions ?? [] });
  } catch {
    // Polling failure is transient — keep prior state, next tick retries.
  }
}

export function useTradingState() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [practiceOnly, setPracticeOnlyState] = useState<boolean>(STAGING_PRACTICE_LOCK);
  // The deployments cache drives which accounts need live hub feeds. We
  // subscribe to every account that has an enabled deployment, not just
  // the currently-selected one, so the /deployments page and any future
  // cross-account PnL rollup can render live state without a refresh.
  const { deployments } = useDeployments();

  // Load persisted toggle on mount. Skipped on staging — the env-derived
  // value is authoritative and we never want a stale localStorage flag
  // letting a non-PRAC account show up in the picker.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (STAGING_PRACTICE_LOCK) return;
    const stored = readStoredPracticeOnly();
    if (stored != null) setPracticeOnlyState(stored);
  }, []);

  const setPracticeOnly = useCallback((value: boolean) => {
    // No-op on staging — the env-derived lock is the source of truth.
    if (STAGING_PRACTICE_LOCK) return;
    setPracticeOnlyState(value);
    if (typeof window !== "undefined") {
      // A container-key write outside the read helpers migrates first,
      // rather than relying on the mount effect having already converged
      // them.
      migrateLegacyStorageKeys();
      localStorage.setItem(PRACTICE_ONLY_KEY, String(value));
    }
  }, []);

  // Practice toggle is symmetric: ON = PRAC-only, OFF = live-only. The
  // operator never wants both kinds mixed together — manual practice
  // trades next to real ones gives a misleading PnL, and seeing live
  // accounts while in practice mode invites accidental deploys.
  const visibleAccounts = practiceOnly
    ? state.accounts.filter(isPracticeAccount)
    : state.accounts.filter((a) => !isPracticeAccount(a));

  /** After the server has vouched for the cookie: a fresh marker, then the
   *  account list on it. With no broker there is no list to ask for —
   *  `/api/accounts` would 503, and that is not an error on this install. */
  const adoptSession = useCallback(async (brokerConfigured: boolean) => {
    dispatch({ type: "AUTHENTICATED", token: nextSessionMarker(), noBroker: !brokerConfigured });
    if (!brokerConfigured) {
      dispatch({ type: "ACCOUNTS_LOADED", accounts: [], catalogWarning: null });
      return;
    }
    try {
      const acctRes = await fetch("/api/accounts");
      const acctData = await acctRes.json();
      if (!acctRes.ok) throw new Error(acctData.error ?? "Failed to load accounts");
      dispatch({
        type: "ACCOUNTS_LOADED",
        accounts: toAccountRows(Array.isArray(acctData.accounts) ? acctData.accounts : []),
        catalogWarning: partialCatalogWarning(acctData),
      });
    } catch (err) {
      dispatch({
        type: "ERROR",
        error: err instanceof Error ? err.message : "Failed to load accounts",
        kind: "unknown",
      });
    }
  }, []);

  /**
   * Resume: ask whether the browser's cookie is still a session. It never
   * mints one — that takes the password, through `signIn`.
   *
   * `needs-setup` is a routing transition, not an error. Without it a fresh
   * install's first cold load latched an "Auth failed" banner that survived
   * the first run (the provider lives at the root layout and does not remount
   * across the client-side redirect).
   */
  const connect = useCallback(async () => {
    dispatch({ type: "CONNECTING" });
    const answer = await postAuth();
    switch (answer.kind) {
      case "needs-setup":
        dispatch({ type: "NEEDS_SETUP" });
        return;
      case "sign-in-required":
        dispatch({ type: "SIGNED_OUT" });
        return;
      case "failed":
        dispatch({ type: "ERROR", error: answer.detail, kind: connectFailureKind(answer.failure) });
        return;
      case "signed-in":
        await adoptSession(answer.brokerConfigured);
    }
  }, [adoptSession]);

  /**
   * The sign-in form's submit. Answers the failure for the form to word, or
   * `null` once signed in. A wrong pair or a lockout leaves the provider
   * where it was — `signedOut` — rather than in `error`: the banner is for
   * the install, the form is for what was typed.
   */
  const signIn = useCallback(
    async (username: string, password: string): Promise<AuthFailure | null> => {
      const answer = await postAuth({ username, password });
      switch (answer.kind) {
        case "signed-in":
          await adoptSession(answer.brokerConfigured);
          return null;
        case "needs-setup":
          dispatch({ type: "NEEDS_SETUP" });
          return null;
        case "sign-in-required":
          return { kind: "unknown" };
        case "failed":
          return answer.failure;
      }
    },
    [adoptSession],
  );

  /** Signs this browser out. The local state goes either way: a sign-out
   *  that failed on the wire leaves a cookie the server will refuse anyway. */
  const signOut = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      dispatch({ type: "SIGNED_OUT" });
    }
  }, []);

  /**
   * Re-read the account list, for a surface that just ran the account-status
   * check — which refreshes the server's catalogue — so a new or reset account
   * appears without a reload. A failed read keeps the list it had: an emptied
   * picker would claim no account is connected.
   */
  const reloadAccounts = useCallback(async () => {
    const token = state.token;
    if (!token) return;
    try {
      const res = await fetch("/api/accounts");
      if (!res.ok) return;
      const data: unknown = await res.json();
      if (typeof data !== "object" || data === null) return;
      const accounts = (data as { accounts?: unknown }).accounts;
      if (!Array.isArray(accounts)) return;
      dispatch({
        type: "ACCOUNTS_LOADED",
        accounts: toAccountRows(accounts),
        catalogWarning: partialCatalogWarning(data as AccountsResponse),
      });
    } catch {
      // Keeps the list it had.
    }
  }, [state.token]);

  // Every account the engine still owes something on — `isEngineManagedStatus`
  // rather than `=== "Active"`, so a leg mid-close keeps its feed until it
  // settles. `selectedAccountId` used to be the reason this could never be
  // empty (`ACCOUNTS_LOADED` defaulted it to the first account), and removing
  // it made "pause the last Active deployment" empty the set — which tore the
  // SSE stream down mid-close, so the `Paused` the engine settled to never
  // arrived and the row read `Pausing` for the life of the tab.
  const targetAccountIds = useMemo(() => {
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const d of deployments) {
      if (isEngineManagedStatus(d.status) && !seen.has(d.accountId)) {
        ids.push(d.accountId);
        seen.add(d.accountId);
      }
    }
    return ids;
  }, [deployments]);

  const refreshAccount = useCallback(
    (token: string, accountId: number) => refreshAccountSnapshot(token, accountId, dispatch),
    [],
  );

  // ── One-shot REST seed per account ───────────────────────────────────
  //
  // The SSE stream only delivers *changes* — nothing happens until
  // Topstep pushes a position/order/trade event. On a fresh page load we
  // need to fetch current state once so the dashboard isn't blank while
  // waiting for something to happen. Tracks seeded-accounts in a ref so
  // we don't re-fetch on every render; gated on `live` being false wouldn't
  // work here because SSE typically connects before this runs.
  //
  // **The gate is "is there anything to seed", not "has an account been
  // selected".** It used to read `selectedAccountId`, which was a proxy for
  // *the account catalogue has loaded* — and that proxy died with the account
  // picker. Reading the target set directly says what the effect actually
  // needs, and it is the set the seed then walks.
  const seededAccountsRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!state.token || targetAccountIds.length === 0) return;
    // Seed every target account that hasn't been seeded yet. Typically
    // this fires once on mount and again if the deployment set gains a
    // new account at runtime.
    const toSeed = targetAccountIds.filter((id) => !seededAccountsRef.current.has(id));
    if (toSeed.length === 0) return;
    for (const id of toSeed) seededAccountsRef.current.add(id);
    const token = state.token;
    void Promise.all(toSeed.map((id) => refreshAccount(token, id)));
  }, [state.token, targetAccountIds, refreshAccount]);

  // ── Refs for SSE + polling hooks ─────────────────────────────────────
  //
  // Refs so the SSE/polling effects read current values without re-triggering
  // on every change. Position/contract churn was previously tearing down the
  // SSE stream every 2.5s (Topstep rate-limited us), so ALL mutable inputs
  // live behind refs and the stream effect re-runs on `token` alone — **the
  // account set is deliberately not a dependency of it**, because its identity
  // changes on every deployment refetch and an empty set is a valid one. The
  // rule and its reason are in `brokers/README.md`.
  const openContractIds = useMemo(
    () => Array.from(new Set(state.positions.map((p) => p.contractId).filter(Boolean))),
    [state.positions],
  );

  const tokenRef = useRef<string | null>(null);
  tokenRef.current = state.token;
  const targetAccountIdsRef = useRef<number[]>([]);
  targetAccountIdsRef.current = targetAccountIds;
  const openContractIdsRef = useRef<string[]>([]);
  openContractIdsRef.current = openContractIds;
  const contractMetaRef = useRef(state.contractMeta);
  contractMetaRef.current = state.contractMeta;
  // Ref the live flag so the polling ticks below can gate themselves on
  // it without re-running the polling effect every time `live` flips.
  const liveRef = useRef(state.live);
  liveRef.current = state.live;
  // When the stream last marked each contract, by this tab's clock — what
  // tells the quote fallback which contracts the stream is not carrying.
  const streamMarksRef = useRef<Map<string, number>>(new Map());

  useSseStream({
    token: state.token,
    targetAccountIds,
    openContractIds,
    targetAccountIdsRef,
    openContractIdsRef,
    streamMarksRef,
    dispatch,
  });

  useRestPolling({
    token: state.token,
    refreshAccount,
    dispatch,
    tokenRef,
    targetAccountIdsRef,
    openContractIdsRef,
    contractMetaRef,
    liveRef,
    streamMarksRef,
  });

  useEngineStatusFeed(state.token, state.live);

  // ── Derived PnL ────────────────────────────────────────────────────
  //
  // Unrealized per position = (mark - avg) * size * (tickValue/tickSize) * sideSign.
  // Returns null when mark or contract meta is missing so the UI can render
  // a "—". Aggregation across positions happens in use-live-pnl.ts so it
  // can scope to deployment-owned positions only.
  //
  // Through the same primitive the reconciler's closes go through, so a
  // position's unrealized figure and its realized figure a second later are
  // the same arithmetic in the same unit. Direction is already carried by
  // `signedSize`, so the tick distance is taken unsigned and the sign comes
  // from the multiplier — the shape this replaced, unchanged.
  const unrealizedForPosition = useCallback(
    (p: Position): number | null => {
      const meta = state.contractMeta[p.contractId];
      const q = state.quotes[p.contractId];
      if (!meta || !q) return null;
      const ticks = pnlTicksFromPrices(p.averagePrice, q.mark, 1, meta.tickSize);
      return pnlDollarsFromTicks(ticks, meta.tickValue, signedSize(p));
    },
    [state.contractMeta, state.quotes],
  );

  return {
    ...state,
    accounts: state.accounts,
    visibleAccounts,
    practiceOnly,
    setPracticeOnly,
    connect,
    signIn,
    signOut,
    reloadAccounts,
    unrealizedForPosition,
  };
}

// ── Context ──────────────────────────────────────────────────────────

type TradingContextValue = ReturnType<typeof useTradingState>;

export const TradingContext = createContext<TradingContextValue | null>(null);

export function useTrading() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTrading must be used within TradingProvider");
  return ctx;
}
