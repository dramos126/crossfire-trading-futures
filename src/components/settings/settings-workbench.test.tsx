// @vitest-environment jsdom
/**
 * What a first run shows, what its confirm writes, and the menu that splits
 * Settings into four pages.
 *
 * The confirm is the whole reason `/setup` could be deleted rather than
 * merely reskinned: `setup_confirmed_at` is what `<SetupGuard>` reads, and a
 * Settings page that saves credentials without writing it leaves the guard
 * redirecting forever with every credential already in place. **Nothing else
 * fails when that request goes out with the wrong body** — the page renders,
 * type-checks and passes every other test.
 *
 * Pages are mounted the way `app/settings/layout.tsx` mounts them — the
 * route's own default export inside one `SettingsWorkbench` — and a menu
 * click is a re-render of the same root with the next route, which is what
 * the App Router does to a layout's children.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  FIRST_RUN_PAGE_UNAVAILABLE,
  SETTINGS_LANDING_HREF,
  SETTINGS_PAGES,
  untestedRefusal,
  type SettingsPageId,
} from "@/components/settings/settings-model";
import type { SettingsBundle } from "@/lib/settings/parse-bundle";
import { CHANGE_PASSWORD_LEAD, PASSWORD_RULE_HINT } from "@/components/settings/settings-sign-in-blocks";
import {
  ACCOUNT_ONLY_LEAD,
  CREATE_SIGN_IN_LABEL,
  FIRST_RUN_LINE,
  FIRST_RUN_TITLE,
} from "@/components/settings/settings-workbench";
import { PASSWORD_TOO_SHORT_PROBLEM, USERNAME_LENGTH_PROBLEM } from "@/lib/auth/web-account-rules";
import { SETUP_CODE_HINT, SETUP_CODE_MISSING_MESSAGE } from "@/lib/auth/sign-in-wire";
import { NO_BROKER_COPY } from "@/lib/hooks/use-trading/auth-answer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  replaced: [] as string[],
  redirected: [] as string[],
  pathname: "/settings/connections",
  trading: {
    token: "test-token" as string | null,
    status: "connected" as "connected" | "needsSetup",
    noBroker: false,
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (href: string) => state.replaced.push(href),
    push: (href: string) => state.replaced.push(href),
  }),
  usePathname: () => state.pathname,
  redirect: (href: string) => {
    state.redirected.push(href);
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      createElement("a", { href, ...rest }, children as never),
  };
});

const signIns = vi.hoisted(() => [] as Array<{ username: string; password: string }>);
const connects = vi.hoisted(() => ({ count: 0, navigationsBefore: [] as number[] }));

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({
    ...state.trading,
    connect: async () => {
      connects.count += 1;
      connects.navigationsBefore.push(state.replaced.length);
    },
    signIn: async (username: string, password: string) => {
      signIns.push({ username, password });
      return null;
    },
    signOut: async () => {},
  }),
}));

const { SettingsWorkbench } = await import("./settings-workbench");

/** Exhaustive over the page ids, so a menu entry without a route fails to compile here. */
const ROUTES: Record<SettingsPageId, ComponentType> = {
  connections: (await import("@/app/settings/connections/page")).default,
  risk: (await import("@/app/settings/risk/page")).default,
  notifications: (await import("@/app/settings/notifications/page")).default,
  "sign-in": (await import("@/app/settings/sign-in/page")).default,
  "danger-zone": (await import("@/app/settings/danger-zone/page")).default,
};

// ── Fixtures ────────────────────────────────────────────────────────────

/**
 * **Both brokers, deliberately.** A one-broker fixture is why the `brokerInUse`
 * defect shipped green: the three Tradovate fields the server always pre-fills
 * are the input that made the predicate wrong, and a schema list without
 * Tradovate in it never seeds them. Mirrors what the registry actually serves,
 * including `tradovateDeviceId` being the one optional field.
 */
const SCHEMAS = [
  {
    id: "topstep",
    displayName: "Topstep",
    isConfigured: true,
    fields: [
      { key: "topstepUsername", label: "Username", secret: false, required: true },
      { key: "topstepApiKey", label: "API Key", secret: true, required: true },
    ],
  },
  {
    id: "tradovate",
    displayName: "Tradovate",
    isConfigured: false,
    fields: [
      { key: "tradovateUsername", label: "Username", secret: false, required: true },
      { key: "tradovatePassword", label: "Password", secret: true, required: true },
      { key: "tradovateAppId", label: "App ID", secret: false, required: true },
      { key: "tradovateAppVersion", label: "App Version", secret: false, required: true },
      { key: "tradovateDeviceId", label: "Device ID", secret: false, required: false },
      { key: "tradovateApiCid", label: "API Client ID", secret: false, required: true },
      { key: "tradovateApiSecret", label: "API Secret", secret: true, required: true },
    ],
  },
];

const CONFIRMED = "2026-09-03T10:00:00.000Z";

function bundle(over: Partial<SettingsBundle> = {}): SettingsBundle {
  return {
    topstepUsername: "trader",
    topstepUsernameSource: "env",
    hasApiKey: true,
    apiKeySource: "env",
    hasWebhookUrl: false,
    topstepWebhookUrlPreview: null,
    webhookUrlSource: "unset",
    notificationsEnabled: false,
    needsSetup: false,
    setupConfirmedAt: null,
    tradovate: {
      username: null,
      apiCid: null,
      appId: "app",
      appVersion: "1.0",
      deviceId: "device",
      hasPassword: false,
      hasApiSecret: false,
      isComplete: false,
      appIdAuto: true,
      appVersionAuto: true,
      deviceIdAuto: true,
    },
    topstepCredsValidated: true,
    topstepCredsValidatedAt: CONFIRMED,
    tradovateCredsValidated: false,
    tradovateCredsValidatedAt: null,
    marketData: {
      historicalProviderId: "topstep",
      realtimeProviderId: "topstep",
      providers: [
        {
          id: "topstep",
          displayName: "Topstep",
          isConfigured: true,
          capabilities: { historicalBars: true, liveBars: true, liveQuotes: true },
          fields: [],
        },
      ],
      databento: {
        hasApiKey: false,
        apiKeySource: "unset",
        credsValidated: false,
        credsValidatedAt: null,
        coverage: null,
      },
    },
    ...over,
  };
}

/** No broker configured anywhere — a fresh install, or one set up with the
 *  sign-in alone. */
const SCHEMAS_NO_BROKER = SCHEMAS.map((s) => ({ ...s, isConfigured: false }));
let schemasServed: unknown = SCHEMAS;

/** The unauthenticated first-run answer: nothing stored, the schema list, and
 *  Tradovate's server-filled identity. On a fresh install no broker resolves. */
const PREFILL = {
  hasAccount: false,
  needsSetupCode: false,
  topstepUsername: null,
  tradovate: {
    appId: "app",
    appVersion: "1.0",
    deviceId: "device",
    appIdAuto: true,
    appVersionAuto: true,
    deviceIdAuto: true,
  },
  brokers: SCHEMAS_NO_BROKER,
};

/** An install that stored its broker before sign-in existed. */
const PREFILL_BROKER_RESOLVES = { ...PREFILL, brokers: SCHEMAS };
let prefill: unknown = PREFILL;

// ── Harness ─────────────────────────────────────────────────────────────

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const requests: { url: string; method: string; body: unknown }[] = [];

function respond(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function stubFetch(settings: SettingsBundle) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      requests.push({
        url: input,
        method: init?.method ?? "GET",
        body: init?.body != null ? JSON.parse(init.body) : null,
      });
      if (input === "/api/settings/schemas") return respond(schemasServed);
      if (input === "/api/settings/setup-prefill") return respond(prefill);
      if (input === "/api/settings/test-connection") return respond({ ok: true });
      if (input === "/api/accounts/status") {
        return respond({ checkedAt: CONFIRMED, answered: ["topstep"], failed: [], newlyDead: [] });
      }
      if (input === "/api/accounts/risk") return respond({ accounts: [] });
      return respond(settings);
    }),
  );
}

/** Render a route the way the layout does, and keep the root for the next one. */
async function show(page: SettingsPageId) {
  state.pathname = `/settings/${page}`;
  const Route = ROUTES[page];
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      <SettingsWorkbench>
        <Route />
      </SettingsWorkbench>,
    );
  });
  // One more flush: the load effect resolves two fetches before it paints.
  await act(async () => {});
}

function textOf(): string {
  return container?.textContent ?? "";
}

/** How many headings on the page read exactly `label`. */
function headingsSaying(label: string): number {
  return Array.from(container?.querySelectorAll("h1, h2, h3, h4") ?? []).filter(
    (h) => h.textContent?.trim() === label,
  ).length;
}

function buttonSaying(label: string): HTMLButtonElement | null {
  const buttons = Array.from(container?.querySelectorAll("button") ?? []);
  return (buttons.find((b) => b.textContent?.includes(label)) as HTMLButtonElement) ?? null;
}

function menuLinks(): HTMLAnchorElement[] {
  return Array.from(
    container?.querySelectorAll<HTMLAnchorElement>('nav[aria-label="Settings"] a') ?? [],
  );
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

// A browser writes an input's value through the prototype setter. React
// installs a per-node override to detect changes, so assigning `el.value`
// directly keeps its tracker in sync and `onChange` never fires.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  "value",
)!.set!;

async function typeInto(el: HTMLInputElement | null | undefined, value: string) {
  if (!el) throw new Error("missing input");
  await act(async () => {
    nativeValueSetter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const ACCOUNT = { username: "operator", password: "correct horse battery" };

async function fillAccount() {
  await typeInto(container?.querySelector<HTMLInputElement>("#account-username"), ACCOUNT.username);
  await typeInto(container?.querySelector<HTMLInputElement>("#account-password"), ACCOUNT.password);
  await typeInto(container?.querySelector<HTMLInputElement>("#account-confirm"), ACCOUNT.password);
}

async function type(ariaLabel: string, value: string) {
  await typeInto(container?.querySelector<HTMLInputElement>(`input[aria-label="${ariaLabel}"]`), value);
}

/** Leaving a field: React's `onBlur` listens for `focusout`. */
async function leave(el: HTMLInputElement | null | undefined) {
  if (!el) throw new Error("missing input");
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

/** A browser with no session on an install with no sign-in account. */
function coldFirstRun() {
  state.trading.token = null;
  state.trading.status = "needsSetup";
}

beforeEach(() => {
  requests.length = 0;
  signIns.length = 0;
  connects.count = 0;
  connects.navigationsBefore.length = 0;
  prefill = PREFILL;
  schemasServed = SCHEMAS;
  state.replaced.length = 0;
  state.redirected.length = 0;
  state.trading.token = "test-token";
  state.trading.status = "connected";
  state.trading.noBroker = false;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

// ── The menu ────────────────────────────────────────────────────────────

describe("the Settings menu", () => {
  /** What only that page renders. */
  const MARKER: Record<SettingsPageId, string> = {
    connections: "Every external service, its credentials, and what it serves.",
    risk: "How much each account may lose on one trade.",
    notifications: "Enable notifications",
    "sign-in": CHANGE_PASSWORD_LEAD,
    // Not "Reset configuration": the credential block names that action too.
    "danger-zone": "Wipes Topstep credentials",
  };

  for (const page of SETTINGS_PAGES) {
    it(`routes ${page.label} to its own page and marks only that entry current`, async () => {
      stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
      await show(page.id);

      const links = menuLinks();
      expect(links.map((a) => a.getAttribute("href"))).toEqual(SETTINGS_PAGES.map((p) => p.href));
      const current = links.filter((a) => a.getAttribute("aria-current") === "page");
      expect(current.map((a) => a.textContent)).toEqual([page.label]);

      expect(textOf()).toContain(MARKER[page.id]);
      for (const other of SETTINGS_PAGES) {
        if (other.id !== page.id) expect(textOf()).not.toContain(MARKER[other.id]);
      }
    });
  }

  it("lands /settings on Connections", async () => {
    const SettingsIndex = (await import("@/app/settings/page")).default;
    expect(() => SettingsIndex()).toThrow("NEXT_REDIRECT");
    expect(state.redirected).toEqual([SETTINGS_LANDING_HREF]);
    expect(SETTINGS_LANDING_HREF).toBe("/settings/connections");
  });

  it("keeps every Settings route out of the setup guard", () => {
    // The guard redirects here; a Settings route under `AppShell` redirects to
    // itself forever. Scan every file under the route, so a page added later
    // that reaches for `AppShell` fails here rather than in a browser.
    const dir = join(process.cwd(), "src/app/settings");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".tsx")) files.push(p);
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThanOrEqual(SETTINGS_PAGES.length + 2);
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(/from\s+["'][^"']*(app-shell|setup-guard)["']/);
    }
    // One workbench, in the layout: the cross-page test below holds only
    // while no page mounts its own.
    const layout = readFileSync(join(dir, "layout.tsx"), "utf8");
    expect(layout).toContain("<AppChrome>");
    expect(layout).toContain("<SettingsWorkbench>");
    for (const file of files.filter((f) => !f.endsWith("layout.tsx"))) {
      expect(readFileSync(file, "utf8"), file).not.toContain("SettingsWorkbench");
    }
  });
});

// ── First run ───────────────────────────────────────────────────────────

describe("a first run", () => {
  it("writes setupConfirmedAt, which is the only thing that clears the guard", async () => {
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("connections");

    const confirm = buttonSaying("Finish setup");
    expect(confirm).not.toBeNull();
    expect(confirm!.disabled).toBe(false);

    await click(confirm!);

    const write = requests.find((r) => r.url === "/api/settings" && r.body !== null);
    expect(write?.body).toEqual({ confirmSetup: true });
    expect(state.replaced).toContain("/");
  });

  it("does not read the server's own Tradovate defaults as an operator supplying Tradovate", async () => {
    // App ID / App Version / Device ID arrive pre-filled from the server on
    // every install. Counting them as operator input made Tradovate in-use and
    // unverified, so the confirm refused — and `buildCanTest` disables the Test
    // button that would clear the refusal while the username is empty. The
    // confirm was the only available write on this arm, and it was refused
    // forever: exactly the loop `confirmSetup` was added to break.
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("connections");

    expect(textOf()).not.toContain(untestedRefusal("Tradovate"));
    expect(buttonSaying("Finish setup")!.disabled).toBe(false);
  });

  it("refuses the moment a credential of the operator's own is typed into Tradovate", async () => {
    // The other half of the same predicate: excluding the auto fields must not
    // amount to never gating on Tradovate at all.
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("connections");
    await type("Tradovate Username", "tv-trader");

    expect(textOf()).toContain(untestedRefusal("Tradovate"));
    expect(buttonSaying("Finish setup")!.disabled).toBe(true);
  });

  it("lists Connections and Notifications only, and renders without redirecting", async () => {
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("connections");
    expect(menuLinks().map((a) => a.textContent)).toEqual(["Connections", "Notifications"]);
    expect(textOf()).toContain("Topstep");

    await show("notifications");
    expect(textOf()).toContain("Discord Webhook URL");
    expect(headingsSaying("Notifications")).toBe(1);
    expect(state.replaced).toEqual([]);
  });

  it("answers Risk and Danger Zone reached by URL with a line, not the page or a redirect", async () => {
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("risk");
    expect(textOf()).toContain(FIRST_RUN_PAGE_UNAVAILABLE);
    expect(requests.some((r) => r.url === "/api/accounts/risk")).toBe(false);

    await show("danger-zone");
    expect(textOf()).toContain(FIRST_RUN_PAGE_UNAVAILABLE);
    expect(textOf()).not.toContain("Reset configuration");
    expect(state.replaced).toEqual([]);
  });

  it("on a never-confirmed install with no account, shows the sign-in card alone — no broker block, no menu", async () => {
    coldFirstRun();
    stubFetch(bundle());
    await show("connections");

    expect(headingsSaying(FIRST_RUN_TITLE)).toBe(1);
    expect(textOf()).toContain(FIRST_RUN_LINE);
    expect(textOf()).toContain("Password again");
    expect(menuLinks()).toHaveLength(0);
    for (const schema of SCHEMAS) expect(textOf()).not.toContain(schema.displayName);
    expect(container?.querySelector('input[aria-label="Topstep Username"]')).toBeNull();
    expect(buttonSaying("Finish setup")).toBeNull();
    // Whichever Settings URL the guard landed on, the same screen.
    await show("notifications");
    expect(headingsSaying(FIRST_RUN_TITLE)).toBe(1);
    expect(textOf()).not.toContain("Discord Webhook URL");
  });

  it("says what is wrong with a field only once it has been left, and holds the button until all are right", async () => {
    coldFirstRun();
    stubFetch(bundle());
    await show("connections");
    const button = buttonSaying(CREATE_SIGN_IN_LABEL)!;
    expect(button.disabled).toBe(true);
    // The length rule is help text before anything is typed, not a refusal.
    expect(textOf()).toContain(PASSWORD_RULE_HINT);
    expect(textOf()).not.toContain(USERNAME_LENGTH_PROBLEM);

    const password = container?.querySelector<HTMLInputElement>("#account-password");
    await typeInto(password, "short");
    expect(textOf()).not.toContain(PASSWORD_TOO_SHORT_PROBLEM);
    await leave(password);
    expect(textOf()).toContain(PASSWORD_TOO_SHORT_PROBLEM);
    expect(password?.getAttribute("aria-invalid")).toBe("true");

    await leave(container?.querySelector<HTMLInputElement>("#account-username"));
    expect(textOf()).toContain(USERNAME_LENGTH_PROBLEM);

    await fillAccount();
    expect(textOf()).not.toContain(PASSWORD_TOO_SHORT_PROBLEM);
    expect(button.disabled).toBe(false);
  });

  it("Create sign-in sends the account alone, signs in with it and lands on /", async () => {
    coldFirstRun();
    stubFetch(bundle());
    await show("connections");
    await fillAccount();
    await click(buttonSaying(CREATE_SIGN_IN_LABEL)!);

    const setup = requests.filter((r) => r.url === "/api/settings/setup");
    expect(setup.map((r) => r.body)).toEqual([{ account: ACCOUNT }]);
    expect(signIns).toEqual([ACCOUNT]);
    expect(state.replaced).toEqual(["/"]);
  });

  it("when another browser made the account first (409), re-reads the status before it leaves for /", async () => {
    coldFirstRun();
    stubFetch(bundle());
    const served = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
        if (input !== "/api/settings/setup") return served(input, init as RequestInit);
        requests.push({ url: input, method: init?.method ?? "GET", body: null });
        return { ok: false, status: 409, json: async () => ({ error: "Already configured" }) } as unknown as Response;
      }),
    );
    await show("connections");
    await fillAccount();
    await click(buttonSaying(CREATE_SIGN_IN_LABEL)!);

    expect(signIns).toEqual([]);
    expect(connects.navigationsBefore).toEqual([0]);
    expect(state.replaced).toEqual(["/"]);
  });

  it("on an install whose broker already resolves, still asks for the sign-in alone, says the broker is set, and signs in", async () => {
    coldFirstRun();
    prefill = PREFILL_BROKER_RESOLVES;
    stubFetch(bundle());
    await show("connections");

    expect(textOf()).toContain(ACCOUNT_ONLY_LEAD);
    expect(textOf()).not.toContain(FIRST_RUN_LINE);
    expect(menuLinks()).toHaveLength(0);
    expect(container?.querySelector('input[aria-label="Topstep Username"]')).toBeNull();

    await fillAccount();
    await click(buttonSaying(CREATE_SIGN_IN_LABEL)!);

    const setup = requests.filter((r) => r.url === "/api/settings/setup");
    expect(setup.map((r) => r.body)).toEqual([{ account: ACCOUNT }]);
    expect(signIns).toEqual([ACCOUNT]);
    // The guard brings a never-confirmed install back with a session, where
    // "a first run … writes setupConfirmedAt" above takes over.
    expect(state.replaced).toEqual(["/"]);
  });

  it("asks an upgraded install for the setup code, says where it is, and sends it with the account", async () => {
    coldFirstRun();
    prefill = { ...PREFILL_BROKER_RESOLVES, needsSetupCode: true };
    stubFetch(bundle());
    await show("connections");

    expect(textOf()).toContain(SETUP_CODE_HINT);
    await fillAccount();
    const button = buttonSaying(CREATE_SIGN_IN_LABEL)!;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(SETUP_CODE_MISSING_MESSAGE);

    await typeInto(container?.querySelector<HTMLInputElement>("#account-setup-code"), "c0de");
    expect(button.disabled).toBe(false);
    await click(button);
    const setup = requests.filter((r) => r.url === "/api/settings/setup");
    expect(setup.map((r) => r.body)).toEqual([{ account: ACCOUNT, setupCode: "c0de" }]);
  });

  it("holds Market Data back until a broker has passed a test, not merely saved one", async () => {
    // `isConfigured` is true and the credentials are stored; the only thing
    // missing is a passing probe. A provider picker on screen here could
    // probe nothing.
    stubFetch(bundle({ setupConfirmedAt: null, topstepCredsValidated: false }));
    await show("connections");
    expect(textOf()).not.toContain("Market Data");
    expect(buttonSaying("Finish setup")).not.toBeNull();
  });

  it("shows Market Data once one has", async () => {
    stubFetch(bundle({ setupConfirmedAt: null, topstepCredsValidated: true }));
    await show("connections");
    expect(textOf()).toContain("Market Data");
  });
});

// ── A configured install ────────────────────────────────────────────────

describe("a configured install", () => {
  it("offers no confirm", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("connections");
    expect(buttonSaying("Finish setup")).toBeNull();
  });

  it("generates one block per broker schema, plus Market Data, on Connections", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("connections");
    const headings = Array.from(container?.querySelectorAll("h3") ?? []).map((h) =>
      h.textContent?.trim(),
    );
    expect(headings).toEqual([...SCHEMAS.map((s) => s.displayName), "Market Data"]);
  });

  it("never gates Market Data on a stale credential", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED, topstepCredsValidated: false }));
    await show("connections");
    expect(textOf()).toContain("Market Data");
  });

  it("mounts the risk block on Risk", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("risk");
    expect(requests.some((r) => r.url === "/api/accounts/risk")).toBe(true);
    expect(textOf()).not.toContain(FIRST_RUN_PAGE_UNAVAILABLE);
  });

  it("asks the brokers which accounts are open exactly once per visit, however many pages are opened", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("connections");
    await show("risk");
    await show("notifications");
    await show("risk");
    const checks = requests.filter((r) => r.url === "/api/accounts/status");
    expect(checks).toHaveLength(1);
    expect(checks[0]?.method).toBe("POST");
  });

  it("saves Notifications through the same request General did", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED, notificationsEnabled: false }));
    await show("notifications");

    await click(container!.querySelector('button[aria-label="Enable notifications"]')!);
    await click(buttonSaying("Save")!);

    const write = requests.find((r) => r.url === "/api/settings" && r.method === "PUT");
    expect(write?.body).toEqual({ notificationsEnabled: true });
  });

  it("changes the password on Sign-in with the current one, and says so", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("sign-in");

    const button = buttonSaying("Change password")!;
    expect(button.disabled).toBe(true);
    await typeInto(container?.querySelector<HTMLInputElement>("#password-current"), ACCOUNT.password);
    await typeInto(container?.querySelector<HTMLInputElement>("#password-new"), "a different passphrase");
    await typeInto(container?.querySelector<HTMLInputElement>("#password-again"), "a different passphrase");
    expect(button.disabled).toBe(false);
    await click(button);

    const change = requests.find((r) => r.url === "/api/auth/password");
    expect(change).toMatchObject({
      method: "POST",
      body: { currentPassword: ACCOUNT.password, newPassword: "a different passphrase" },
    });
    expect(textOf()).toContain("CHANGED");
  });

  it("titles Notifications once, in the page header", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("notifications");
    expect(headingsSaying("Notifications")).toBe(1);
  });

  it("re-reads the Risk list once that check has answered", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("risk");
    await act(async () => {});
    const order = requests
      .map((r) => r.url)
      .filter((u) => u === "/api/accounts/risk" || u === "/api/accounts/status");
    // Rendered from the stored answer at once, then again after the check.
    expect(order).toEqual(["/api/accounts/risk", "/api/accounts/status", "/api/accounts/risk"]);
  });
});

// ── The phone layout ────────────────────────────────────────────────────
//
// jsdom applies no media query: what is pinned is the markup that makes the
// layout below `sm`, and that each phone class has its `sm:` undo beside it.

function classesOf(el: Element | null | undefined): string[] {
  return el?.className.split(/\s+/) ?? [];
}

describe("the phone layout", () => {
  it("makes the menu one sideways-scrolling row below sm and the column from sm", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("risk");
    const nav = container!.querySelector('nav[aria-label="Settings"]');
    expect(classesOf(nav)).toEqual(
      expect.arrayContaining(["flex-nowrap", "overflow-x-auto", "min-w-0", "sm:flex-col", "sm:flex-wrap", "sm:overflow-x-visible"]),
    );
    expect(classesOf(nav)).not.toContain("flex-wrap");
    for (const link of menuLinks()) expect(classesOf(link)).toEqual(expect.arrayContaining(["shrink-0", "sm:shrink"]));
    expect(menuLinks().filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent)).toEqual([
      "Risk",
    ]);
  });

  it("wraps a Connections block's test row and stretches its Save across the block below sm", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("connections");
    const test = container!.querySelector<HTMLButtonElement>('button[title="Authenticate against Topstep"]')!;
    const testRow = test.parentElement!.parentElement!;
    expect(classesOf(testRow)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));

    const block = test.closest("section")!;
    const save = Array.from(block.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    expect(classesOf(save)).toEqual(expect.arrayContaining(["w-full", "sm:w-auto"]));
    expect(classesOf(save.parentElement)).toEqual(expect.arrayContaining(["flex-wrap", "sm:flex-nowrap"]));
  });

  for (const page of ["connections", "notifications", "sign-in"] as const) {
    it(`gives every ${page} input a 44px height below sm and its desk height from sm`, async () => {
      stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
      await show(page);
      const inputs = Array.from(container!.querySelectorAll("section input")).filter(
        (el) => (el as HTMLInputElement).type !== "radio",
      );
      expect(inputs.length).toBeGreaterThan(0);
      // Market Data's own block is not on this pass; its key field keeps its height.
      const owned = inputs.filter((el) => !el.closest("section")?.textContent?.includes("Market Data"));
      expect(owned.length).toBeGreaterThan(0);
      for (const el of owned) expect(classesOf(el)).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0"]));
    });
  }

  it("gives the first run's sign-in fields the same height below sm", async () => {
    coldFirstRun();
    stubFetch(bundle());
    await show("connections");
    for (const id of ["#account-username", "#account-password", "#account-confirm"]) {
      expect(classesOf(container!.querySelector(id))).toEqual(expect.arrayContaining(["min-h-11", "sm:min-h-0"]));
    }
  });
});

// ── Signed in with no broker ────────────────────────────────────────────

describe("an install signed in with no broker", () => {
  beforeEach(() => {
    schemasServed = SCHEMAS_NO_BROKER;
    state.trading.noBroker = true;
  });

  it("renders Settings with no redirect: Connections as today, and Sign-in listed; Risk and Danger Zone wait", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED, hasApiKey: false, topstepUsername: null }));
    await show("connections");
    expect(menuLinks().map((a) => a.textContent)).toEqual(["Connections", "Notifications", "Sign-in"]);
    expect(container?.querySelector('input[aria-label="Topstep Username"]')).not.toBeNull();
    expect(buttonSaying("Finish setup")).toBeNull();
    expect(state.replaced).toEqual([]);
  });

  it("answers Risk and Danger Zone reached by URL with the no-broker sentence, and checks no broker", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED }));
    await show("risk");
    expect(textOf()).toContain(NO_BROKER_COPY);
    await show("danger-zone");
    expect(textOf()).toContain(NO_BROKER_COPY);
    expect(requests.some((r) => r.url === "/api/accounts/status" || r.url === "/api/accounts/risk")).toBe(false);
  });

  it("resumes the session after the first broker is saved, so the app learns it has one", async () => {
    stubFetch(bundle({ setupConfirmedAt: CONFIRMED, hasApiKey: false, topstepUsername: null, topstepCredsValidated: false }));
    await show("connections");
    await type("Topstep Username", "trader");
    const block = container!.querySelector('input[aria-label="Topstep Username"]')!.closest("section")!;
    const save = Array.from(block.querySelectorAll("button")).find((b) => b.textContent === "Save")!;
    await click(save);
    expect(requests.some((r) => r.url === "/api/settings" && r.method === "PUT")).toBe(true);
    expect(connects.count).toBe(1);
  });
});

describe("the account status check on a first run", () => {
  it("is not fired — there is no Risk page and no catalogue to check", async () => {
    stubFetch(bundle({ setupConfirmedAt: null }));
    await show("connections");
    await show("notifications");
    expect(requests.some((r) => r.url === "/api/accounts/status")).toBe(false);
  });
});
