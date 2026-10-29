/**
 * The first run's three rules, as pure functions.
 *
 * Each of them is a sentence from the design that compiles and renders
 * perfectly well when it is wrong: hiding nothing, showing Market Data over
 * unverified credentials, or letting the confirm through with no broker are
 * all valid-looking pages. They are here rather than in a component test
 * because none of them is about the DOM.
 */
import { describe, it, expect } from "vitest";
import {
  PASSWORDS_DIFFER_PROBLEM,
  PASSWORD_TOO_SHORT_PROBLEM,
  USERNAME_LENGTH_PROBLEM,
} from "@/lib/auth/web-account-rules";
import {
  EMPTY_ACCOUNT_INPUT,
  NO_BROKER_REFUSAL,
  SETTINGS_LANDING_HREF,
  SETTINGS_PAGES,
  accountRefusal,
  confirmRefusal,
  settingsPagesFor,
  resolveSettingsMode,
  showsDangerZone,
  showsMarketData,
  untestedRefusal,
  type BrokerProgress,
} from "./settings-model";

function broker(over: Partial<BrokerProgress> = {}): BrokerProgress {
  return { id: "topstep", displayName: "Topstep", inUse: false, verified: false, ...over };
}

describe("what a first run is", () => {
  it("is an unconfirmed install, not an install with no credentials", () => {
    // The common first run has working credentials the whole time — they come
    // from the environment on an empty database. `setup_confirmed_at` is what
    // `<SetupGuard>` reads and therefore the only thing that decides this.
    expect(resolveSettingsMode(null)).toBe("first-run");
    expect(resolveSettingsMode("2026-09-03T12:00:00.000Z")).toBe("configured");
  });
});

describe("what a first run hides", () => {
  it("hides the Danger Zone and nothing else", () => {
    expect(showsDangerZone("first-run")).toBe(false);
    expect(showsDangerZone("configured")).toBe(true);
  });

  it("holds Market Data back until a broker has actually answered", () => {
    const typed = [broker({ inUse: true, verified: false })];
    expect(showsMarketData("first-run", typed)).toBe(false);
    expect(showsMarketData("first-run", [broker({ inUse: true, verified: true })])).toBe(true);
  });

  it("never gates Market Data on a configured install", () => {
    // The gate sequences a first run; it is not a rule about the surface. An
    // operator whose stored credentials have since gone stale must still be
    // able to reach the provider picker.
    expect(showsMarketData("configured", [broker()])).toBe(true);
    expect(showsMarketData("configured", [])).toBe(true);
  });
});

describe("the Settings menu", () => {
  it("drops Risk, Sign-in and Danger Zone on a first run, and keeps the pages setup needs", () => {
    expect(settingsPagesFor("first-run").map((p) => p.id)).toEqual([
      "connections",
      "notifications",
    ]);
  });

  it("lists all five pages, in order, once setup is confirmed", () => {
    expect(settingsPagesFor("configured").map((p) => p.label)).toEqual([
      "Connections",
      "Risk",
      "Notifications",
      "Sign-in",
      "Danger Zone",
    ]);
  });

  it("lands /settings on a page the menu lists in both modes", () => {
    // The guard redirects to `/settings`; landing on a page a first run hides
    // would put the operator somewhere the menu does not mark.
    for (const mode of ["first-run", "configured"] as const) {
      expect(settingsPagesFor(mode).map((p) => p.href)).toContain(SETTINGS_LANDING_HREF);
    }
  });

  it("routes every entry to its own segment under /settings", () => {
    for (const page of SETTINGS_PAGES) expect(page.href).toBe(`/settings/${page.id}`);
  });
});

describe("what the confirm refuses", () => {
  it("refuses an install with no broker at all", () => {
    expect(confirmRefusal([broker(), broker({ id: "tradovate" })])?.message).toBe(
      NO_BROKER_REFUSAL,
    );
  });

  it("takes either broker alone — neither is mandatory on its own", () => {
    const topstepOnly = [
      broker({ inUse: true, verified: true }),
      broker({ id: "tradovate", displayName: "Tradovate" }),
    ];
    const tradovateOnly = [
      broker(),
      broker({ id: "tradovate", displayName: "Tradovate", inUse: true, verified: true }),
    ];
    expect(confirmRefusal(topstepOnly)).toBeNull();
    expect(confirmRefusal(tradovateOnly)).toBeNull();
  });

  it("names the broker that has not been tested", () => {
    const refusal = confirmRefusal([
      broker({ inUse: true, verified: true }),
      broker({ id: "tradovate", displayName: "Tradovate", inUse: true, verified: false }),
    ]);
    expect(refusal?.kind).toBe("untested");
    expect(refusal?.message).toBe(untestedRefusal("Tradovate"));
  });

  it("carries no gate for a broker the operator left alone", () => {
    // A blank block is not-supplied. Gating on it is what kept a
    // Tradovate-only install from being created at all.
    expect(
      confirmRefusal([
        broker({ inUse: true, verified: true }),
        broker({ id: "tradovate", displayName: "Tradovate", inUse: false, verified: false }),
      ]),
    ).toBeNull();
  });
});

describe("what the sign-in step refuses", () => {
  const good = { username: "operator", password: "correct horse battery", confirm: "correct horse battery" };

  it("passes a 3+ character name and a matching 12+ character password", () => {
    expect(accountRefusal(good)).toBeNull();
  });

  it("refuses an empty step, a short password, and a confirm that differs", () => {
    expect(accountRefusal(EMPTY_ACCOUNT_INPUT)).toBe(USERNAME_LENGTH_PROBLEM);
    expect(accountRefusal({ ...good, password: "short", confirm: "short" })).toBe(
      PASSWORD_TOO_SHORT_PROBLEM,
    );
    expect(accountRefusal({ ...good, confirm: "correct horse batterY" })).toBe(PASSWORDS_DIFFER_PROBLEM);
  });
});
