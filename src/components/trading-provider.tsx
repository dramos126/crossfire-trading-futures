"use client";

import { useEffect } from "react";
import { TradingContext, useTradingState } from "@/lib/hooks/use-trading/use-trading-state";

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const state = useTradingState();

  // Auto-connect whenever status returns to `disconnected`. The provider
  // lives at the root layout and never remounts across client-side
  // navigation, so a once-only ref latch (the previous shape) made the
  // dashboard land with a stale "Auth failed" after a fresh-install wizard
  // submit — the cold-load 503 set ERROR, the latch fired, and nothing
  // re-triggered connect when the wizard fixed the auth situation.
  //
  // Status terminals + transition rules:
  //   - "disconnected"  → fire connect()
  //   - "connecting"    → in-flight, don't re-fire
  //   - "connected"     → done, until a route 401s the held token: the
  //                       reducer's SESSION_REFUSED returns it here as
  //                       "disconnected", so connect() re-mints after an
  //                       expiry or answers needsSetup after a reset. Not
  //                       the Bug C loop — a failed re-mint lands in "error".
  //   - "error"         → STAY HERE. Operator must manually retry via the
  //                       SystemWarning "Reconnect" button. Auto-firing on
  //                       error against bad creds was the post-wizard 401
  //                       loop in Bug C.
  //   - "needsSetup"    → STAY HERE. Cleared only by the first run's confirm
  //                       on /settings calling trading.connect() after
  //                       activation.
  //
  // Dep array is intentionally narrow: the previous shape (`[state]`)
  // re-ran the effect on every render because `state` is a fresh object
  // each time. The bail check still prevented duplicate connects, but
  // any path that briefly flipped status back to `disconnected` would
  // re-fire instantly with no settle. Pinning to `state.status` makes
  // the effect re-run only on actual status transitions; `state.connect`
  // is a stable useCallback so listing it is for lint, not correctness.
  useEffect(() => {
    if (state.status !== "disconnected") return;
    state.connect();
  }, [state.status, state.connect]);

  return (
    <TradingContext value={state}>
      {children}
    </TradingContext>
  );
}
