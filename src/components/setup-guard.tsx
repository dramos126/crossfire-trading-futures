"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * First-run gate. Wraps every dashboard page through `<AppShell>`.
 *
 * **It redirects to `/settings`, and `/settings` composes `AppChrome`
 * directly rather than `AppShell`** — so the guard can never wrap the page it
 * would redirect to, which is the only reason the redirect terminates. That
 * pairing is the invariant, and it is deliberately *not* expressed as a path
 * allowlist in here: a rule that reads "this one route is exempt" rots the
 * first time a route is renamed, and this guard is what stands between a
 * half-configured install and a dashboard. If a second page ever needs the
 * chrome without the gate, it composes `AppChrome` too — nothing is added
 * here.
 *
 * Two-step check, both steps reading from the provider rather than running
 * their own auth:
 *  1. `status === "needsSetup"` — the provider's `connect()` already
 *     POSTs /api/auth and maps the 503 `{ needsSetup }` / `{ needsAccount }`
 *     sentinels to that status. Means no sign-in account exists; redirect.
 *  2. GET /api/settings with the provider's token — if setupConfirmedAt
 *     is null, setup has never been confirmed even though creds resolve.
 *     Redirect so the operator confirms; the page prefills from the bundle
 *     and its confirm is what writes the missing stamp.
 *
 * A session with no broker is neither: setup was confirmed with the sign-in
 * alone, and every page renders under the chrome's no-broker line.
 *
 * **The guard does not mint a session.** It used to POST /api/auth
 * itself, on every AppShell mount, and throw the token away after one
 * GET — so a page load cost two `app_session` rows, one of which no
 * request ever used again. Nothing reuses a row and the table's cap
 * evicts by mint order, so those wasted rows were spending a live
 * operator's eviction budget. The provider is the one minter; it owns
 * the auth lifecycle already (it re-fires `connect()` on a return to
 * `disconnected`, which this guard never did).
 *
 * Signature-mismatch (states D/G) is detected server-side: the next PUT
 * touching creds recomputes + persists. Until then the bundle's
 * setupConfirmedAt is stale-but-present; we don't redirect on a mere
 * mismatch because a stale row still represents a previous confirm. The
 * signature is the gate that the destructive reset (Phase 2.5) clears
 * to force a re-prompt.
 */
export function SetupGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { status, token } = useTrading();
  const [settingsChecked, setSettingsChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  useEffect(() => {
    if (status !== "needsSetup") return;
    setNeedsSetup(true);
    router.replace("/settings");
  }, [status, router]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const settingsRes = await fetch("/api/settings");
        if (cancelled) return;
        if (settingsRes.ok) {
          const settings = (await settingsRes.json().catch(() => ({}))) as {
            setupConfirmedAt?: unknown;
          };
          if (settings.setupConfirmedAt == null) {
            setNeedsSetup(true);
            router.replace("/settings");
            return;
          }
        }
      } catch {
        // Network failure isn't a setup problem — let the rest of the
        // dashboard render and surface the connection error normally.
      } finally {
        if (!cancelled) setSettingsChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  // Hold the render until we know whether we're redirecting. Without
  // this, the dashboard flashes for ~200ms before the redirect fires —
  // which on a fresh install means the user sees an "Authenticating…"
  // empty state before Settings appears.
  //
  // `error` resolves the guard rather than holding forever: an auth
  // failure is not a setup problem, and the dashboard's own warning bar
  // is where the operator acts on it. `signedOut` resolves it for the same
  // reason — the chrome puts the sign-in form where the page would be.
  const resolved = status === "error" || status === "signedOut" || settingsChecked;
  if (needsSetup || !resolved) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-[var(--muted)]">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
