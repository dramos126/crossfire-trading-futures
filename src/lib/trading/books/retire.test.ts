import { describe, it, expect, vi } from "vitest";

// `removeBookRefusal` reads three tables; this file tests the predicate under it.
vi.mock("@/lib/db/books", () => ({ listDerivedRows: vi.fn() }));
vi.mock("@/lib/db/deployments", () => ({ listGroupLegs: vi.fn() }));
vi.mock("@/lib/db/trades", () => ({ getOpenTradeForDeployment: vi.fn() }));

import { REMOVE_BOOK_REFUSAL, removeBookRefusalFor } from "./retire";

const flat = { status: "Paused" as const, openTrade: false };

describe("removeBookRefusalFor", () => {
  it("lets an off book whose every derived leg is settled Paused be removed", () => {
    expect(removeBookRefusalFor({ enabled: false, legs: [flat, flat] })).toBeNull();
    expect(removeBookRefusalFor({ enabled: false, legs: [] })).toBeNull();
  });

  it("refuses a book that is still on, whatever its legs say", () => {
    expect(removeBookRefusalFor({ enabled: true, legs: [flat] })).toBe(REMOVE_BOOK_REFUSAL);
  });

  it.each(["Pausing", "Destroying", "Active"] as const)(
    "refuses an off book with a %s leg — it has not settled",
    (status) => {
      expect(removeBookRefusalFor({ enabled: false, legs: [flat, { status, openTrade: false }] })).toBe(
        REMOVE_BOOK_REFUSAL,
      );
    },
  );

  it("refuses a Paused leg that still has an open trade row", () => {
    expect(removeBookRefusalFor({ enabled: false, legs: [{ status: "Paused", openTrade: true }] })).toBe(
      REMOVE_BOOK_REFUSAL,
    );
  });

  it("names the moves: turn the book off and wait for its playbooks to close", () => {
    expect(REMOVE_BOOK_REFUSAL).toContain("Turn the book off and wait for its playbooks to close");
  });
});
