"use client";

import { AccountRiskBlock } from "@/components/account/account-risk-block";
import { DangerZone } from "@/components/danger-zone";
import { MarketDataBlock } from "@/components/market-data-block";
import { SettingsCredentialBlock } from "@/components/settings/settings-credential-block";
import { SettingsGeneralBlock } from "@/components/settings/settings-general-block";
import {
  FIRST_RUN_PAGE_UNAVAILABLE,
  showsDangerZone,
  showsMarketData,
  showsRisk,
  showsSignIn,
} from "@/components/settings/settings-model";
import { ChangePasswordBlock, SignOutBlock } from "@/components/settings/settings-sign-in-blocks";
import { useSettingsWorkbench } from "@/components/settings/settings-workbench";
import { NoBrokerSentence, useNoBroker } from "@/components/settings/no-broker";
import { useTrading } from "@/lib/hooks/use-trading/use-trading-state";

/**
 * The four Settings pages' bodies. Each route under `app/settings/` renders
 * one, inside the workbench its layout mounts; none of them loads anything of
 * its own.
 */

export function SettingsConnectionsPage() {
  const {
    bundle,
    schemas,
    token,
    mode,
    progress,
    forms,
    setField,
    setTest,
    resetBroker,
    adoptBundle,
    refreshBundle,
  } = useSettingsWorkbench();
  const { connect } = useTrading();
  // The first broker saved on an install set up without one: resume, so the
  // session learns there is a broker and the account list is read.
  const noBroker = useNoBroker();

  return (
    <SettingsSection
      title="Connections"
      blurb="Every external service, its credentials, and what it serves."
    >
      {schemas.map((schema) => (
        <SettingsCredentialBlock
          key={schema.id}
          schema={schema}
          bundle={bundle}
          token={token}
          state={forms[schema.id] ?? { values: {}, auto: {}, test: { kind: "idle" } }}
          onField={(key, value) => setField(schema.id, key, value)}
          onReset={() => resetBroker(schema.id)}
          onTest={(next) => setTest(schema.id, next)}
          onSaved={async (updated) => {
            adoptBundle(updated);
            await refreshBundle();
            if (schema.id === "tradovate" || noBroker) void connect();
          }}
          onTestPassed={refreshBundle}
        />
      ))}

      {/* Market Data is not a broker: its controls carry a *selection* —
          which provider serves historical, which serves realtime — that a
          credential block has no equivalent of. Two block shapes under one
          page, which is coherent under the page's own framing. */}
      {token !== null && showsMarketData(mode, progress) && (
        <MarketDataBlock
          bundle={bundle}
          token={token}
          onSaved={async (updated) => {
            adoptBundle(updated);
            await refreshBundle();
          }}
          onTestPassed={refreshBundle}
        />
      )}
    </SettingsSection>
  );
}

/**
 * Its own page rather than a block under Connections: risk is the operator's
 * own setting, not a property of a service. It needs a session (the route is
 * authenticated) and the account catalogue, so a first run and an install
 * with no broker do not list it, and reaching it by URL says so.
 */
export function SettingsRiskPage() {
  const { token, mode, accountStatusCheck } = useSettingsWorkbench();
  return (
    <SettingsSection
      title="Risk"
      blurb="How much each account may lose on one trade. Nothing trades without it."
    >
      {token !== null && showsRisk(mode) ? (
        <AccountRiskBlock token={token} statusCheck={accountStatusCheck} />
      ) : (
        <PageUnavailable />
      )}
    </SettingsSection>
  );
}

export function SettingsNotificationsPage() {
  const { bundle, token, adoptBundle } = useSettingsWorkbench();
  return (
    <SettingsSection title="Notifications" blurb="How the platform talks to you.">
      {token !== null && <SettingsGeneralBlock bundle={bundle} token={token} onSaved={adoptBundle} />}
    </SettingsSection>
  );
}

/** The web sign-in: changing its password and signing this browser out.
 *  Needs a session, so a first run does not list it. */
export function SettingsSignInPage() {
  const { mode } = useSettingsWorkbench();
  return (
    <SettingsSection title="Sign-in" blurb="The username and password this install asks for.">
      {showsSignIn(mode) ? (
        <>
          <ChangePasswordBlock />
          <SignOutBlock />
        </>
      ) : (
        <PageUnavailable />
      )}
    </SettingsSection>
  );
}

/** The card titles itself, so the page carries no section header over it. */
export function SettingsDangerZonePage() {
  const { mode } = useSettingsWorkbench();
  return showsDangerZone(mode) ? <DangerZone /> : <PageUnavailable />;
}

function SettingsSection({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-[var(--card-border)] pb-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[var(--foreground)]">
          {title}
        </h2>
        <p className="text-[11px] text-[var(--muted)]">{blurb}</p>
      </div>
      {/* One block per full-width row. Each block keeps its fields to a
          readable measure, left-aligned, because a field the width of the
          page outruns the eye. */}
      <div className="grid gap-4 grid-cols-1">{children}</div>
    </section>
  );
}

/** A page this mode does not list, reached by URL: a line, not a redirect. */
function PageUnavailable() {
  const { mode } = useSettingsWorkbench();
  return (
    <p className="text-[11px] leading-relaxed text-[var(--muted)]">
      {mode === "no-broker" ? <NoBrokerSentence /> : FIRST_RUN_PAGE_UNAVAILABLE}
    </p>
  );
}

