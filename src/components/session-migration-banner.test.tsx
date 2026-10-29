// @vitest-environment jsdom
/**
 * Display privacy on the session-migration banner: a pending row names its
 * account by numeric id, which reads as its alias while IDs are hidden.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HIDE_ACCOUNT_IDS_KEY } from "@/components/privacy/privacy-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A real Topstep practice name, per the prefix table in docs/modules/brokers/topstep.md. */
const ACCOUNT = { id: 21345, name: "PRAC-V2-100200-90012114" };

vi.mock("@/lib/hooks/use-trading/use-trading-state", () => ({
  useTrading: () => ({ token: "t", accounts: [{ id: 9001, name: "50KTC-V2-100200-90020038" }, ACCOUNT] }),
}));

const { SessionMigrationBanner } = await import("./session-migration-banner");
const { PrivacyProvider } = await import("@/components/privacy/privacy-provider");

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      json: async () => ({
        blocked: [],
        pendingReconciliation: [
          { id: "dep-1", name: null, strategyKey: "orb", accountId: ACCOUNT.id, ticker: "/MNQ", reason: null },
        ],
      }),
    })),
  );
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function mountExpanded(hideIds: boolean): Promise<string> {
  if (hideIds) localStorage.setItem(HIDE_ACCOUNT_IDS_KEY, "true");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider>
        <SessionMigrationBanner />
      </PrivacyProvider>,
    );
  });
  await act(async () => {});
  const view = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "View");
  await act(async () => {
    view!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  return container.querySelector("li")?.textContent ?? "";
}

describe("SessionMigrationBanner — display privacy", () => {
  it("reads the account's alias after acct while IDs are hidden", async () => {
    // 9001 sorts first, so 21345 is Account 2.
    const row = await mountExpanded(true);
    expect(row).toContain("/MNQ · acct Account 2");
    expect(row).not.toContain(String(ACCOUNT.id));
  });

  it("reads the numeric id with the switch off", async () => {
    expect(await mountExpanded(false)).toContain(`/MNQ · acct ${ACCOUNT.id}`);
  });
});
