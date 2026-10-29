/**
 * What the Settings page shows, and what it refuses to finish without.
 *
 * `/setup` is deleted: first run is a **state of this page**, not a separate
 * wizard, and the three things the wizard did that a flat page of blocks does
 * not are the three things in this file — it states the requirement, it
 * sequences, and it ends in the confirm that writes `setupConfirmedAt`.
 *
 * No React. The page renders these answers and hands the state back.
 *
 * Owned by docs/modules/ui/design-language.md; the strings by copy.md.
 */

import {
  PASSWORDS_DIFFER_PROBLEM,
  passwordProblem,
  usernameProblem,
} from "@/lib/auth/web-account-rules";

/**
 * First run is *not* an install with no credentials — it is an install that
 * has never been confirmed. Credentials resolving from the environment on a
 * fresh database is still a first run, because `setup_confirmed_at` is what
 * `<SetupGuard>` reads.
 *
 * `no-broker` is a confirmed install with no broker yet: first run asked only
 * for the sign-in (2026-10-29). Connections and Sign-in work; Risk and Danger
 * Zone wait for a broker.
 */
export type SettingsMode = "first-run" | "no-broker" | "configured";

export function resolveSettingsMode(
  setupConfirmedAt: string | null,
  brokerConfigured: boolean,
): SettingsMode {
  if (setupConfirmedAt == null) return "first-run";
  return brokerConfigured ? "configured" : "no-broker";
}

/** One credential block, as far as the page's gates are concerned. */
export interface BrokerProgress {
  id: string;
  displayName: string;
  /**
   * This broker is part of the setup being confirmed — the operator typed
   * into its fields, or it already holds stored credentials. A block left
   * untouched is not-supplied and carries no gate.
   */
  inUse: boolean;
  /**
   * A Test Connection **passed** — in this session, or recorded against the
   * stored credentials by a previous one. Never "a field has a value in it":
   * a saved-but-wrong credential is exactly the case this distinction exists
   * to keep out.
   */
  verified: boolean;
}

/**
 * The one block a first run hides, and an install with no broker too.
 *
 * Factory reset on an install with nothing to reset is the only block with no
 * meaning before the confirm. Everything else renders — hiding blocks is how
 * a wizard teaches an operator that the page they will use afterwards is a
 * different page.
 */
export function showsDangerZone(mode: SettingsMode): boolean {
  return mode === "configured";
}

/**
 * Risk needs the account catalogue, and neither a first run nor an install
 * with no broker has one to set it against — the page would be an empty list
 * under a blurb saying nothing trades without it.
 */
export function showsRisk(mode: SettingsMode): boolean {
  return mode === "configured";
}

/**
 * Changing the password needs a session, and a first run's session (when it
 * has one) is about to finish setup, not maintain it. An install with no
 * broker has its sign-in already.
 */
export function showsSignIn(mode: SettingsMode): boolean {
  return mode !== "first-run";
}

export type SettingsPageId = "connections" | "risk" | "notifications" | "sign-in" | "danger-zone";

export interface SettingsPageEntry {
  id: SettingsPageId;
  href: string;
  label: string;
}

/** The left menu, in order. Each `href` is a route under `src/app/settings/`. */
export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  { id: "connections", href: "/settings/connections", label: "Connections" },
  { id: "risk", href: "/settings/risk", label: "Risk" },
  { id: "notifications", href: "/settings/notifications", label: "Notifications" },
  { id: "sign-in", href: "/settings/sign-in", label: "Sign-in" },
  { id: "danger-zone", href: "/settings/danger-zone", label: "Danger Zone" },
];

/** Where `/settings` itself lands. */
export const SETTINGS_LANDING_HREF = "/settings/connections";

/**
 * The menu a mode shows. A mode drops the pages that cannot render in it,
 * rather than listing entries that lead to a page saying "not yet".
 */
export function settingsPagesFor(mode: SettingsMode): readonly SettingsPageEntry[] {
  return SETTINGS_PAGES.filter((page) => {
    if (page.id === "risk") return showsRisk(mode);
    if (page.id === "sign-in") return showsSignIn(mode);
    if (page.id === "danger-zone") return showsDangerZone(mode);
    return true;
  });
}

/** What a first-run page that cannot render yet says, if reached by URL. */
export const FIRST_RUN_PAGE_UNAVAILABLE =
  "This page opens once setup is finished. Start on Connections.";

/**
 * Market Data is sequenced behind a **verified** broker, and only on a first
 * run.
 *
 * The provider probe needs working credentials to say anything useful, so a
 * saved-but-wrong credential would put a picker on screen that can probe
 * nothing. On a configured install every block shows unconditionally — the
 * gate is about ordering a first run, not about hiding a surface.
 *
 * The accepted cost is named rather than hidden: Databento's key is
 * independent of any broker, so it cannot be configured first on a fresh
 * install.
 */
export function showsMarketData(
  mode: SettingsMode,
  brokers: readonly BrokerProgress[],
): boolean {
  return mode !== "first-run" || brokers.some((b) => b.verified);
}

/** The first run's sign-in, as typed. */
export interface AccountInput {
  username: string;
  password: string;
  confirm: string;
}

export const EMPTY_ACCOUNT_INPUT: AccountInput = { username: "", password: "", confirm: "" };

/**
 * Why the sign-in step refuses the confirm, or null. The same rules the
 * setup route holds, checked here so the refusal is a line beside the button
 * rather than an error after it.
 */
export function accountRefusal(account: AccountInput): string | null {
  const problem = usernameProblem(account.username) ?? passwordProblem(account.password);
  if (problem !== null) return problem;
  return account.password === account.confirm ? null : PASSWORDS_DIFFER_PROBLEM;
}

/** Why the confirm is refused, or null when it is not. */
export type ConfirmRefusal =
  | { kind: "no-broker"; message: string }
  | { kind: "untested"; broker: string; message: string };

export const NO_BROKER_REFUSAL =
  "Add credentials for at least one broker — Topstep, Tradovate, or both.";

export function untestedRefusal(displayName: string): string {
  return `Test the ${displayName} connection before finishing setup.`;
}

/**
 * The requirement the wizard stated and a page of equal-weight blocks does
 * not: **at least one broker, and every broker in use has to have answered.**
 * Neither broker is mandatory on its own — requiring Topstep is what kept a
 * Tradovate-only install from being created at all.
 *
 * The untested arm names the broker, because "test the connection" over three
 * blocks does not say which one.
 */
export function confirmRefusal(brokers: readonly BrokerProgress[]): ConfirmRefusal | null {
  const inUse = brokers.filter((b) => b.inUse);
  if (inUse.length === 0) {
    return { kind: "no-broker", message: NO_BROKER_REFUSAL };
  }
  const untested = inUse.find((b) => !b.verified);
  if (untested) {
    return {
      kind: "untested",
      broker: untested.id,
      message: untestedRefusal(untested.displayName),
    };
  }
  return null;
}
