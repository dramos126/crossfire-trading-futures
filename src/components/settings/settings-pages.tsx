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
            if (schema.id === "tradovate") void connect();
          }}
          onTestPassed={bundle === null ? async () => {} : refreshBundle}
        />
      ))}

      {/* Market Data is not a broker: its controls carry a *selection* —
          which provider serves historical, which serves realtime — that a
          credential block has no equivalent of. Two block shapes under one
          page, which is coherent under the page's own framing. */}
      {bundle !== null && token !== null && showsMarketData(mode, progress) && (
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

      {bundle === null && (
        <p className="text-[11px] leading-relaxed text-[var(--muted)]">
          Data sources appear here once the engine is running. Nothing can probe a provider until
          a broker connection works.
        </p>
      )}
    </SettingsSection>
  );
}

/**
 * Its own page rather than a block under Connections: risk is the operator's
 * own setting, not a property of a service. It needs a session (the route is
 * authenticated) and the account catalogue, so a first run — which has
 * neither — does not list it, and reaching it by URL says so.
 */
export function SettingsRiskPage() {
  const { bundle, token, mode, accountStatusCheck } = useSettingsWorkbench();
  return (
    <SettingsSection
      title="Risk"
      blurb="How much each account may lose on one trade. Nothing trades without it."
    >
      {bundle !== null && token !== null && showsRisk(mode) ? (
        <AccountRiskBlock token={token} statusCheck={accountStatusCheck} />
      ) : (
        <FirstRunUnavailable />
      )}
    </SettingsSection>
  );
}

export function SettingsNotificationsPage() {
  const { bundle, token, adoptBundle, webhookInput, setWebhookInput } = useSettingsWorkbench();
  return (
    <SettingsSection title="Notifications" blurb="How the platform talks to you.">
      {bundle !== null && token ? (
        <SettingsGeneralBlock bundle={bundle} token={token} onSaved={adoptBundle} />
      ) : (
        <FirstRunWebhookBlock value={webhookInput} onChange={setWebhookInput} />
      )}
    </SettingsSection>
  );
}

/** The web sign-in: changing its password and signing this browser out.
 *  Needs a session, so a first run does not list it. */
export function SettingsSignInPage() {
  const { bundle, mode } = useSettingsWorkbench();
  return (
    <SettingsSection title="Sign-in" blurb="The username and password this install asks for.">
      {bundle !== null && showsSignIn(mode) ? (
        <>
          <ChangePasswordBlock />
          <SignOutBlock />
        </>
      ) : (
        <FirstRunUnavailable />
      )}
    </SettingsSection>
  );
}

/** The card titles itself, so the page carries no section header over it. */
export function SettingsDangerZonePage() {
  const { mode } = useSettingsWorkbench();
  return showsDangerZone(mode) ? <DangerZone /> : <FirstRunUnavailable />;
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

function FirstRunUnavailable() {
  return (
    <p className="text-[11px] leading-relaxed text-[var(--muted)]">{FIRST_RUN_PAGE_UNAVAILABLE}</p>
  );
}

/**
 * The webhook, on a first run with no session.
 *
 * `POST /api/settings/setup` takes it alongside the credentials, so it is the
 * one Notifications control that exists before the engine does. The
 * notifications switch is not: it writes through the authenticated route, and
 * there is no session to write with yet. The value lives in the workbench, so
 * it survives a trip to Connections to finish setup.
 */
function FirstRunWebhookBlock({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    // Untitled, like the block it stands in for: the section header names it.
    <section className="border border-[var(--card-border)] bg-[var(--card)] p-4 space-y-4">
      <div className="space-y-1.5">
        <label
          htmlFor="first-run-webhook"
          className="flex items-center gap-1.5 text-xs font-medium text-[var(--muted)] uppercase tracking-wider"
        >
          Discord Webhook URL
          <span className="text-[10px] font-mono text-[var(--muted-secondary)] normal-case tracking-normal">
            optional
          </span>
        </label>
        <input
          id="first-run-webhook"
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://discord.com/api/webhooks/…"
          className="w-full min-h-11 sm:min-h-0 border border-[var(--card-border)] bg-[var(--bg)] px-3 py-2 text-sm font-mono text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-[var(--accent)] rounded-md transition-colors"
        />
        <p className="text-[11px] text-[var(--muted)] leading-relaxed">
          Alerts stay off until you switch them on, so a fresh install is quiet by default. The
          switch appears here once the engine is running.
        </p>
      </div>
    </section>
  );
}
