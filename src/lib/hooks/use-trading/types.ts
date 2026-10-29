import type { Position } from "@/lib/brokers/types";
import type { AccountRow } from "./account-row";
import type { ConnectFailureKind } from "./auth-answer";

export interface ContractMeta {
  tickSize: number;
  tickValue: number;
  name: string;
}

export interface QuoteSnapshot {
  /** Best price to mark a position at. Prefer lastPrice, fall back to mid. */
  mark: number;
  lastUpdated: string;
}

export interface TradingState {
  /**
   * **Not the session.** The session is an `HttpOnly` cookie script cannot
   * read; this is an opaque marker the provider mints on every sign-in and
   * resume, `null` when there is no session. Effects key on it to start and
   * stop on a session's life, and `SESSION_REFUSED` carries it so a 401 about
   * a session the tab has already replaced is ignored. Kept under its old
   * name so the consumers that gate on it did not all change in one pass.
   */
  token: string | null;
  accounts: AccountRow[];
  positions: Position[];
  /** Per-contract meta needed to price positions (tick size/value). */
  contractMeta: Record<string, ContractMeta>;
  /** Latest mark per contractId. Populated from the SSE marketTrade stream
   * (live) and the /api/quotes REST poll (fallback / bootstrap). */
  quotes: Record<string, QuoteSnapshot>;
  /** `signedOut`: the install has an account and this browser holds no
   *  session — the sign-in form is what clears it. */
  status: "disconnected" | "connecting" | "connected" | "error" | "needsSetup" | "signedOut";
  /** The server's own text, for the status rail's detail line. */
  error: string | null;
  /** What `error` means to the operator; the banner words this, never the
   *  raw text. Survives `CONNECTING` so a retry in flight still says what it
   *  is retrying. */
  errorKind: ConnectFailureKind | null;
  /** Set when `/api/accounts` answered 200 with a *partial* catalog — one
   * broker's fan-out failed while another succeeded. That route reserves
   * 500 for "every broker attempted failed", so without this the outage
   * renders as an account picker quietly missing rows and the operator
   * concludes the accounts were closed. Null when every attempted broker
   * answered. */
  accountCatalogWarning: string | null;
  /** True when the SSE live stream is healthy — **a realtime adapter is
   * streaming account events into the relay**, which is the honest
   * reading of this flag. It is not "the Topstep hub is up": which
   * adapter feeds the browser relay is a wiring decision the engine
   * makes, and a second one being wired in must not need a rename here.
   * When false, the UI falls back to REST polling. Operators see this as
   * an indicator instead of wondering why numbers feel sluggish. */
  live: boolean;
  /** Signed in on an install with no broker configured: the app is browsed,
   *  nothing can trade, and there is no account list to read. Set with each
   *  session; `useNoBroker` is how a surface asks. */
  noBroker: boolean;
}

/** What `requireSession` answers for a missing, expired or wiped session —
 *  the one status that means the held token is dead, as opposed to a route
 *  or broker that failed. */
export const SESSION_REFUSED_STATUS = 401;

export const initialState: TradingState = {
  token: null,
  accounts: [],
  positions: [],
  contractMeta: {},
  quotes: {},
  status: "disconnected",
  error: null,
  errorKind: null,
  accountCatalogWarning: null,
  live: false,
  noBroker: false,
};

export type Action =
  | { type: "CONNECTING" }
  | { type: "AUTHENTICATED"; token: string; noBroker: boolean }
  | { type: "ACCOUNTS_LOADED"; accounts: AccountRow[]; catalogWarning: string | null }
  | { type: "POSITIONS_LOADED"; accountId: number; positions: Position[] }
  | { type: "QUOTES_LOADED"; quotes: Record<string, QuoteSnapshot> }
  | { type: "CONTRACT_META"; contractId: string; meta: ContractMeta }
  | { type: "ERROR"; error: string; kind: ConnectFailureKind }
  | { type: "NEEDS_SETUP" }
  | { type: "SIGNED_OUT" }
  | { type: "DISCONNECTED" }
  /** A route 401'd `token`. Carries the token so an answer about a session
   *  the tab has already replaced is ignored. */
  | { type: "SESSION_REFUSED"; token: string }
  // Live-stream events from the engine's SignalR session, fanned out via
  // the /api/engine/stream SSE endpoint. Each of these applies the same
  // kind of state mutation as the REST polls above, just from a push
  // source so updates arrive in milliseconds instead of 2.5s ticks.
  | { type: "LIVE_STATUS"; live: boolean }
  | { type: "LIVE_POSITION"; position: Position }
  | { type: "LIVE_QUOTE"; contractId: string; snapshot: QuoteSnapshot };
