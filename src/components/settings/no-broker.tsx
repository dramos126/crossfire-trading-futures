"use client";

import Link from "next/link";
import { NO_BROKER_COPY } from "@/lib/hooks/use-trading/auth-answer";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * An install signed in with no broker: browsed, and nothing can trade. One
 * sentence says so everywhere — the banner under the nav, the Dashboard in
 * place of its accounts, beside every inert Deploy — and it is
 * `NO_BROKER_COPY`, never restated. Owned by docs/modules/ui/ui-settings.md.
 */

/** The menu entry the sentence names; it is the link, and the nav's own label. */
export const SETTINGS_LINK_LABEL = "Settings";
const SETTINGS_HREF = "/settings";

/** True only once the server has answered that this session has no broker. */
export function useNoBroker(): boolean {
  const { token, noBroker } = useTrading();
  return token != null && noBroker === true;
}

/** `NO_BROKER_COPY` with its last *Settings* as the link to Settings. */
export function NoBrokerSentence() {
  const at = NO_BROKER_COPY.lastIndexOf(SETTINGS_LINK_LABEL);
  return (
    <>
      {NO_BROKER_COPY.slice(0, at)}
      <Link href={SETTINGS_HREF} className="text-[var(--accent)] hover:underline">
        {SETTINGS_LINK_LABEL}
      </Link>
      {NO_BROKER_COPY.slice(at + SETTINGS_LINK_LABEL.length)}
    </>
  );
}

/** The thin line under the nav on every page, Settings included. Muted, not
 *  the amber warning bar: nothing is broken, the install is not set up to
 *  trade yet. */
export function NoBrokerBanner() {
  if (!useNoBroker()) return null;
  return (
    <div role="status" className="border-b border-[var(--card-border)] bg-[var(--card)]">
      <p className="max-w-[1200px] mx-auto px-4 sm:px-6 py-1.5 text-[11px] text-[var(--muted)]">
        <NoBrokerSentence />
      </p>
    </div>
  );
}
