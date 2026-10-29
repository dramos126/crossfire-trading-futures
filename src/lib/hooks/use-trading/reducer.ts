import { initialState, type Action, type QuoteSnapshot, type TradingState } from "./types";

/** The instant a quote stamp names, or `NaN` when it does not name one
 *  unambiguously. `Date.parse` reads a zoneless `2026-08-22T13:31:00` as
 *  *local*, which is a silent offset against a UTC stamp on the other side of
 *  the comparison and reorders outright across a DST transition — so a
 *  missing zone is refused the same way an unparseable stamp is.
 *
 *  Takes `unknown` for the same reason `QUOTES_LOADED` screens `mark`: the
 *  route body is an `as`-cast, and `/api/quotes` writes `lastUpdated` from
 *  `BarData.timestamp`, which the Topstep provider maps straight off `b.t`
 *  with no validation. `stamp.trim()` on a missing `t` throws inside the
 *  polling `.then` and loses the whole update, where the `Date.parse` this
 *  replaced merely answered `NaN`. */
function instantOf(stamp: unknown): number {
  if (typeof stamp !== "string") return NaN;
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(stamp.trim()) ? Date.parse(stamp) : NaN;
}

/** True when `incoming` is older than the mark already held. Parsed rather
 *  than string-compared: the two sources render ISO differently enough that
 *  `"…:03Z" > "…:03.500Z"` lexicographically, which is backwards. An
 *  unusable stamp on either side is not evidence of staleness. */
function isStale(held: QuoteSnapshot | undefined, incoming: QuoteSnapshot): boolean {
  if (!held) return false;
  const heldAt = instantOf(held.lastUpdated);
  const incomingAt = instantOf(incoming.lastUpdated);
  if (Number.isNaN(heldAt) || Number.isNaN(incomingAt)) return false;
  return incomingAt < heldAt;
}

export function reducer(state: TradingState, action: Action): TradingState {
  switch (action.type) {
    case "CONNECTING":
      return { ...state, status: "connecting", error: null };
    case "AUTHENTICATED":
      return { ...state, token: action.token, errorKind: null, noBroker: action.noBroker };
    case "ACCOUNTS_LOADED": {
      // No selection is derived here any more. The board is all-accounts, so
      // "which account am I looking at" is a filter on a surface rather than
      // container state, and the seed walks every account carrying an Active
      // deployment instead of a chosen one.
      return {
        ...state,
        accounts: action.accounts,
        accountCatalogWarning: action.catalogWarning,
        status: "connected",
      };
    }
    case "POSITIONS_LOADED": {
      // Merge by account: replace positions for `action.accountId` while
      // leaving other accounts' entries intact. The /deployments page
      // renders rows for every subscribed account, so wiping non-target
      // entries on each poll would flash UI for adjacent accounts.
      const others = state.positions.filter((p) => p.accountId !== action.accountId);
      return { ...state, positions: [...others, ...action.positions] };
    }
    case "QUOTES_LOADED": {
      // Merge: REST returns only contracts we asked about, so don't wipe
      // others' marks (e.g. a contract whose quote fetch failed in this
      // round will keep the previous tick instead of dropping to "—").
      //
      // Never merge backwards. The REST mark is the close of the current
      // partial 1m bar, so it lags the SSE tick stream by up to a bar; now
      // that the poll runs while the stream is up, taking it unconditionally
      // would walk a live mark back several seconds on every reconcile.
      const quotes = { ...state.quotes };
      for (const [contractId, snapshot] of Object.entries(action.quotes)) {
        // The route body is an `as`-cast, where the SSE side validates before
        // dispatching. A non-finite mark reaches the P&L arithmetic.
        if (!Number.isFinite(snapshot?.mark)) continue;
        if (isStale(quotes[contractId], snapshot)) continue;
        quotes[contractId] = snapshot;
      }
      return { ...state, quotes };
    }
    case "CONTRACT_META":
      if (state.contractMeta[action.contractId]) return state;
      return {
        ...state,
        contractMeta: { ...state.contractMeta, [action.contractId]: action.meta },
      };
    case "ERROR":
      return { ...state, status: "error", error: action.error, errorKind: action.kind };
    case "NEEDS_SETUP":
      // Pre-setup is a routing concern, not an auth failure. Surfacing it
      // as `error` would paint a misleading "Auth failed" banner; <SetupGuard>
      // is what handles this state by redirecting to /settings.
      return { ...state, status: "needsSetup", error: null, errorKind: null, token: null };
    case "SIGNED_OUT":
      // Sticky like `needsSetup`: the provider does not re-run `connect()`
      // from here, because nothing but a sign-in can change the answer.
      return { ...state, status: "signedOut", error: null, errorKind: null, token: null, live: false };
    case "DISCONNECTED":
      return { ...initialState };
    case "SESSION_REFUSED":
      // Back to `disconnected`, the one status the provider re-runs `connect()`
      // from: a re-mint on an expired session, `needsSetup` after a reset.
      // Only from `connected` — `error` and `needsSetup` stay sticky, and an
      // in-flight connect would land `connected` on top with no token. The
      // view is kept, not blanked: an expiry must not read as an empty board.
      if (state.status !== "connected" || state.token !== action.token) return state;
      return { ...state, status: "disconnected", token: null, live: false };
    case "LIVE_STATUS":
      return { ...state, live: action.live };
    case "LIVE_POSITION": {
      // Upsert by (accountId, contractId). A size-zero position means
      // the broker flattened — drop it from the list instead of keeping a
      // zero row that would confuse rollups. This mirrors the broker's
      // own behavior; flat contracts don't appear in searchOpenPositions.
      const incoming = action.position;
      const others = state.positions.filter(
        (p) => !(p.accountId === incoming.accountId && p.contractId === incoming.contractId),
      );
      if (incoming.size === 0) {
        return { ...state, positions: others };
      }
      return { ...state, positions: [...others, incoming] };
    }
    case "LIVE_QUOTE":
      // Same no-backwards rule as QUOTES_LOADED. The invariant is a property
      // of the map, not of one writer, and guarding only the REST side left a
      // late-arriving tick able to walk a newer mark back.
      if (isStale(state.quotes[action.contractId], action.snapshot)) return state;
      return {
        ...state,
        quotes: { ...state.quotes, [action.contractId]: action.snapshot },
      };
    default:
      return state;
  }
}
